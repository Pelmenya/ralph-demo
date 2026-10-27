#!/usr/bin/env node
/**
 * Ralph Loop — автономный цикл разработки поверх GitHub Issues. ТОНКИЙ ENTRY (#365).
 *
 * Вся логика раннера (цикл итераций, цикл сдачи, гейт, self-heal, breaker'ы,
 * API-лимит, монитор, main) живёт в orchestrator.ts: фабрика createOrchestrator
 * стыкует вынесенные модули (exec / config-profile / state-lock / worktree /
 * tunnel-check / review / gate / deploy-check / api-limit) — см. карту модулей в
 * .claude/ralph/CLAUDE.md. Здесь остаётся ровно три обязанности:
 *   1) проверка Node >= 24 ДО первого require('*.ts') — внятный отказ вместо
 *      криптичной ошибки в глубине зависимостей (инвариант №1 — fail-closed);
 *   2) парсинг CLI-флагов режима и передача argv фабрике;
 *   3) запуск main() под guard require.main === module и ре-экспорт API-поверхности
 *      (module.exports = runtime) — на ней сидят orchestrator.test.ts, сценарные тесты и
 *      monitor-panel.mts (тонкий entry monitor.js её больше не импортирует — #404),
 *      ровно как на прежнем монолите.
 *
 * Запуск:
 *   node .claude/ralph/ralph.js             AFK: до maxIterations итераций, авто-мердж фаз
 *   node .claude/ralph/ralph.js --once      HITL: одна итерация и стоп; авто-мердж НЕ выполняется
 *   node .claude/ralph/ralph.js --dry-run   показать, что будет сделано; строго read-only (C1)
 *   node .claude/ralph/ralph.js --reset     сбросить state на первую фазу конфига
 *   node .claude/ralph/ralph.js --resubmit  повторить полный цикл сдачи фазы (PR/ревью/правки)
 *   node .claude/ralph/ralph.js --deploy-resolved  снять барьер красного пост-мердж деплоя (#165) и продолжить
 *   touch <runtimeDir>/ralph.stop                 мягкая остановка: петля встанет на границе шага (#88)
 *   node .claude/ralph/ralph.js --migrate-runtime   перевезти состояние в runtimeDir и выйти
 *   node .claude/ralph/ralph.js --migrate-rollback  вернуть состояние в прежнюю раскладку
 *   node .claude/ralph/ralph.js --doctor           совместимость слоёв и сверка ядра с lock; только чтение
 *   node .claude/ralph/ralph.js --profile <name>   профиль конфига (по умолчанию defaultProfile)
 *
 * Требования: gh CLI авторизован, git-репозиторий, ralph.config.json настроен, active: true.
 * Конфиг профильный: общие поля в `common`, дельта режима — в `profiles.<name>`.
 * Монитор поднимается сам (кроме --dry-run) и глушится при выходе; панель — `tail -f`
 * файла `monitor.out` в каталоге состояния экземпляра (`runtimeDir` из конфига, а при
 * прежней раскладке — рядом с ядром).
 *
 * Архитектура петли, инварианты C1–C5/H2–H4/M1–M8, безопасность (C3), роутинг моделей,
 * breaker'ы и API-лимит документированы докблоками в orchestrator.ts и модулях —
 * entry их не дублирует, чтобы у каждого правила остался один источник правды.
 */

// #232: ядро — TS-модули без билд-шага, их исполняет нативный type stripping Node 24
// (проект стандартизует Node 24, engines в package.json это фиксирует). На Node <24
// первый же импорт '*.ts' упал бы криптичным ERR_UNKNOWN_FILE_EXTENSION в глубине
// зависимостей; отсекаем раньше внятным сообщением (fail-closed). fail() живёт в
// оркестраторе, который сюда ещё нельзя грузить, — пишем в stderr и выходим напрямую.
// Статический импорт здесь безопасен и намеренно единственный: node:url — встроенный
// модуль, его загрузка не зависит от type stripping и проверку версии ниже не обходит.
import { pathToFileURL } from 'node:url';

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 24) {
    console.error(
        `❌ Раннер требует Node >=24 (нативный type stripping для .ts-модулей ядра), запущен на ${process.versions.node}.`,
    );
    process.exit(1);
}

// Загрузка ядра — ДИНАМИЧЕСКИМ import, а не статическим: статический поднимается наверх
// и выполнился бы ДО проверки версии выше, вернув криптичный отказ вместо внятного
// (ровно то, ради чего проверка и стоит первой). `await` на верхнем уровне легален —
// модуль ESM.
const { createOrchestrator } = await import('./core/orchestrator.ts');
// Мост к соседям: их загрузка остаётся в entry, фабрика получает функции готовыми —
// orchestrator.ts при импорте не тянет env/сеть, а тесты передают фейки
// (см. orchestrator.test.ts). telegram-notifier.ts самостоятелен (не импортирует
// ralph.js — цикл), предохранитель #138 у него общий через side-effect-guard.ts.
const { sendTelegramMessage, telegramConfigFromEnv } =
    await import('./runtime/telegram-notifier.ts');
const { buildSanitizedGateEnv } = await import('./gate-env.mts');

// Флаги режима — прежние module-level ONCE/DRY/RESET/RESUBMIT/DEPLOY_RESOLVED монолита.
// --deploy-resolved (#165): снятие барьера красного пост-мердж деплоя — только человек,
// не раннер (тот же принцип владения, что у hold). --profile main() парсит сам из argv
// (#72, parseProfileFlag) — entry обязан лишь передать argv целиком.
const argv = process.argv.slice(2);
const flags = {
    once: argv.includes('--once'),
    dry: argv.includes('--dry-run'),
    reset: argv.includes('--reset'),
    resubmit: argv.includes('--resubmit'),
    deployResolved: argv.includes('--deploy-resolved'),
    // Канон, задача 25: переезд состояния в runtimeDir и откат к прежней раскладке. Оба —
    // отдельные РЕЖИМЫ, а не побочный шаг обычного прогона: переезд трогает то самое
    // состояние, по которому петля продолжает фазу, и совмещать его с работой значило бы
    // чинить и ехать одновременно.
    migrate: argv.includes('--migrate-runtime'),
    migrateRollback: argv.includes('--migrate-rollback'),
    // #37: отчёт о совместимости launcher / ядро / конфиг / state / адаптеры и сверке ядра
    // с lock — тем же кодом, что у старта; только чтение, код выхода — вердикт старта.
    doctor: argv.includes('--doctor'),
};

// Allowlist известных флагов — fail-closed против тихого сдвига режима (инвариант №1,
// в духе fail-closed parseProfileFlag). Неизвестный флаг иначе молча игнорируется:
// опечатка (`--dryrun`, `--onse`, кириллическая «у» в `--dry-run`) превратила бы
// намеренный read-only/HITL-запуск в живой AFK-прогон с bypassPermissions и авто-мерджем.
// Значение после `--profile <name>` — не флаг, его пропускаем; форму `--profile=<name>`
// ловит startsWith. Валидность самого имени профиля — уже за parseProfileFlag в main().
const KNOWN_FLAGS = new Set([
    '--once',
    '--dry-run',
    '--reset',
    '--resubmit',
    '--deploy-resolved',
    '--migrate-runtime',
    '--migrate-rollback',
    '--doctor',
    '--profile',
]);
function assertKnownFlags(args) {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--profile') {
            i++; // следующий токен — имя профиля, не флаг
            continue;
        }
        if (a.startsWith('--profile=')) continue;
        if (!KNOWN_FLAGS.has(a)) {
            console.error(
                `❌ Неизвестный флаг "${a}". Допустимы: ${[...KNOWN_FLAGS]
                    .filter((f) => f !== '--profile')
                    .join(', ')}, --profile <name> | --profile=<name>.`,
            );
            process.exit(1);
        }
    }
}

const runtime = createOrchestrator({
    argv,
    flags,
    external: { sendTelegramMessage, telegramConfigFromEnv, buildSanitizedGateEnv },
});

// Прежняя API-поверхность монолита (плюс main) — контракт закреплён orchestrator.test.ts
// (REQUIRED_API): пропавший ключ = молча сломанный тест или монитор. Панель монитора и
// сценарные тесты берут поверхность одним объектом.
export default runtime;

// Именованные экспорты — не украшение, а восстановление контракта, который в CommonJS
// давался даром: `module.exports = runtime` позволял делать
// `import { apiLimitMessage } from './ralph.js'` через interop. В ESM экспорты статичны,
// и такой импорт молча вернул бы undefined — «apiLimitMessage is not a function» уже в
// рантайме, а не на границе.
//
// Список ровно тот, что импортируется именованно (инвариант №10: формат строк лога —
// контракт между entry и deadman.ts, их синхронность закреплена тестом). Расширять по
// факту нового именованного импорта, а не про запас.
export const { apiLimitMessage, deployWaitMessage, pushEvent } = runtime;

// Сборка фабрики чистая (не запускает петлю и не трогает процесс) — импорт файла в
// юнит-тестах безопасен, как и раньше: петля стартует только под guard. Проверку флагов
// держим ПОД guard'ом: при импорте из теста process.argv — это argv раннера тестов, его
// валидировать нельзя (иначе тест-раннер упал бы на своих же флагах).
//
// ESM-эквивалент `require.main === module`: сравнение URL этого модуля с путём, которым
// запущен процесс. pathToFileURL обязателен — на Windows голый путь `C:\…` не совпал бы
// с `file:///C:/…` никогда, и петля не стартовала бы вовсе.
const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (import.meta.url === entryUrl) {
    assertKnownFlags(argv);
    runtime.main();
}
