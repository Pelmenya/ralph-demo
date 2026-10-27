// Модуль worktree-менеджмента раннера (#360, трек «Фреймворк ralph», фаза 2).
// Вынесен из ralph.js по тому же приёму, что ralph-util.ts / side-effect-guard.ts /
// state-lock.ts (#359): изоляция раннера в выделенный git worktree (#76) — резолв пути,
// парсинг `git worktree list`, DRY-читаемость (#SiaT3), обновление на свежий origin/main
// (#252) и идемпотентное создание/переиспользование дерева с `npm ci` — собраны здесь
// одним связным модулем, а ralph.js пользуется только его API. Поведение НЕ меняется:
// детач на origin/main, путь-сосед репозитория, синк зависимостей по lock-хешу.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
//
// Фабрика, а не standalone-экспорты (как в ralph-util.ts): ensureRunnerWorktree и
// refreshRunnerWorktree — НЕ чистые функции. Им нужен контекст ralph.js (sh/shArgv/shq,
// log/fail, санированный env для `npm ci`, маркер lock-хэша из state-lock.ts), который
// standalone-функция взять неоткуда. Фабрика захватывает этот контекст один раз, а
// возвращённые функции сохраняют ПОКАЗАТЕЛЬНУЮ DI: каждая по-прежнему принимает свои
// коллабораторы (shFn/existsFn/addFn/…) параметром — ровно так их зовут существующие
// тесты (worktree.test.ts, lock-scenarios.test.ts) через ре-экспорт из ralph.js.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { ensureWorkspaceTrusted } from './workspace-trust.ts';
import type { TrustOutcome } from './workspace-trust.ts';
import { gitNetworkOpts } from '../shared/ralph-util.ts';
import type { ShArgvFn } from '../shared/ralph-util.ts';

type ShFn = (cmd: string) => string;
type ShqFn = (s: string) => string;
type LogFn = (msg: string) => void;
type FailFn = (msg: string) => unknown;
type ExistsFn = typeof fs.existsSync;
type GuardFn = (what: string) => void;

// Контекст ralph.js, захватываемый фабрикой один раз. sh/shArgv/shq/log/fail — те же
// module-level коллабораторы, что использует остальной раннер; buildSanitizedGateEnv —
// санация env для `npm ci` (#189, дочерний процесс исполняет lifecycle-скрипты чужих
// зависимостей, секретам петли там не место); writeLockMarker — из createStateLock
// (#359): засевает маркер хэша lock сразу после `npm ci` нового worktree.
// guardSideEffect — общий предохранитель #138: его зовут ОПАСНЫЕ дефолты addFn/installFn
// (реальные git worktree add / npm ci), чтобы забытый в тесте override не ушёл в живой
// git/npm дерева, где идут тесты (как в state-lock.ts у installFn/writeLock).
export type WorktreeEnv = {
    sh: ShFn;
    shArgv: ShArgvFn;
    shq: ShqFn;
    log: LogFn;
    fail: FailFn;
    guardSideEffect: GuardFn;
    buildSanitizedGateEnv: () => NodeJS.ProcessEnv;
    writeLockMarker: (dir?: string) => void;
    // #204: команда установки зависимостей из конфига (дефолт `npm ci`) — лениво, config
    // присваивается в main() уже после сборки фабрики.
    getInstallCmd: () => string;
};

// #204: имя соседнего дерева раннера больше НЕ прибито к проекту (раньше здесь стоял
// литерал с именем репозитория первого потребителя).
// Дефолт выводится из имени репозитория: `<basename(repoRoot)>-ralph` (для `/path/to/app`
// — `/path/to/app-ralph`). Суффикс — общий, не проектный. Явный конфиг
// (cfg.runnerWorktreeDirname / cfg.runnerWorktreePath) важнее дефолта.
const RALPH_WORKTREE_SUFFIX = '-ralph';

function defaultWorktreeDirnameFor(repoRoot: string): string {
    return path.basename(repoRoot) + RALPH_WORKTREE_SUFFIX;
}

// #576: стоп на не сработавшем доверии. Подробную причину уже назвал workspace-trust
// (битый JSON / нет прав / диск только на чтение) — здесь фиксируется ПОСЛЕДСТВИЕ, чтобы
// оно было выражено в самом ensureRunnerWorktree, а не подразумевалось из того, что
// чей-то fail сделает process.exit.
function untrustedMessage(worktreePath: string): string {
    return (
        `Дерево раннера ${worktreePath} не внесено в доверенные Claude — кодер-сессия ` +
        `в нём молча потеряла бы все permissions.allow из .claude/settings.json ` +
        `(fail-closed; причина — строкой выше).`
    );
}

export function createWorktreeManager(env: WorktreeEnv) {
    const {
        sh,
        shArgv,
        shq,
        log,
        fail,
        guardSideEffect,
        buildSanitizedGateEnv,
        writeLockMarker,
        getInstallCmd,
    } = env;

    // ── Изоляция раннера в git worktree (#76) ────────────────────────────────
    // Раннер работает в ВЫДЕЛЕННОМ дереве, соседнем с рабочим деревом человека: без
    // этого git-хореография гейта (checkout ветки фазы/main) утаскивала бы за собой
    // и дерево человека — правки/коммиты вручную посреди AFK-прогона рвали ensureClean
    // (см. docs/ralph-prod-mode/prd.md, feedback-ralph-shared-worktree). Путь — СОСЕД
    // репозитория (`../<dirname>`), не поддиректория внутри него: иначе он либо
    // игнорится .gitignore-правилами родителя, либо норовит закоммититься как
    // вложенный git-репозиторий.

    // cfg.runnerWorktreePath (явный конфиг) важнее RALPH_WORKTREE_PATH (env) — молчаливая
    // перебивка явной настройки переменной окружения была бы тем же тихим сдвигом режима,
    // от которого fail-closed уже защищает профили (см. resolveProfile). Both отсутствуют →
    // дефолт-сосед. repoRoot — параметр (не process.cwd() внутри resolve), чтобы функция
    // оставалась чистой и тестируемой без реального cwd.
    function resolveWorktreePath(
        cfg: { runnerWorktreePath?: string; runnerWorktreeDirname?: string } = {},
        repoRoot: string = process.cwd(),
    ): string {
        const override = cfg.runnerWorktreePath || process.env.RALPH_WORKTREE_PATH;
        if (override) return path.resolve(repoRoot, override);
        // #204: имя дерева — из конфига или дефолт от имени репозитория, не строка проекта.
        const dirname = cfg.runnerWorktreeDirname || defaultWorktreeDirnameFor(repoRoot);
        return path.resolve(repoRoot, '..', dirname);
    }

    // `git worktree list --porcelain`: блоки разделены пустой строкой, первая строка
    // блока — "worktree <абсолютный путь>". Достаточно собрать все такие строки.
    function parseWorktreeList(raw: string): string[] {
        return raw
            .split('\n')
            .filter((l) => l.startsWith('worktree '))
            .map((l) => l.slice('worktree '.length).trim());
    }

    // Дерево раннера УЖЕ поднято (зарегистрировано И папка на месте)? Для DRY: только тогда
    // dry-run переезжает читать state/лог оттуда — ничего не создавая и не чиня (#SiaT3).
    function runnerWorktreeReady(
        worktreePath: string,
        {
            shFn = sh,
            existsFn = fs.existsSync as ExistsFn,
        }: { shFn?: ShFn; existsFn?: ExistsFn } = {},
    ): boolean {
        let list = '';
        try {
            list = shFn('git worktree list --porcelain');
        } catch {
            return false;
        }
        return parseWorktreeList(list).includes(worktreePath) && existsFn(worktreePath);
    }

    // Обновление УЖЕ существующего worktree на свежий origin/main.
    //
    // Без этого раннер подхватывал дерево в том состоянии, в каком его оставил прошлый
    // прогон, — на коммите, который мог устареть на несколько мерджей. Симптом
    // неочевидный: раннер работает и выглядит здоровым, но кодер-сессия внутри читает
    // СТАРЫЕ .claude/ralph/ralph.md и ralph.js, то есть работает по отменённым правилам.
    // Ручной шаг «обновить перед запуском» держать в голове нельзя — забудется молча.
    //
    // Грязное дерево не трогаем: там может лежать незакоммиченная работа прошлой
    // сессии, и checkout её снесёт. Молча пропустить тоже нельзя — пишем в лог, а
    // остановит цикл дальше ensureClean с внятным сообщением (fail-closed уже есть).
    // #252: сами мутации (fetch/checkout) — через argv (shArgv), не строкой через шелл;
    // чтение (git status --porcelain) остаётся на shFn — не мутация. worktreePath уходит
    // отдельным элементом argv в -C, а не в шелл-строку через shq.
    function refreshRunnerWorktree(
        worktreePath: string,
        {
            shFn = sh,
            runArgvFn = shArgv,
            logFn = log,
        }: { shFn?: ShFn; runArgvFn?: ShArgvFn; logFn?: LogFn } = {},
    ): boolean {
        let dirty = '';
        try {
            dirty = shFn(`git -C ${shq(worktreePath)} status --porcelain`);
        } catch (e: unknown) {
            logFn(
                `⚠ Не смог проверить чистоту worktree раннера: ${(e as Error).message} — обновление пропущено.`,
            );
            return false;
        }
        if (dirty) {
            logFn(
                `⚠ В worktree раннера есть незакоммиченные правки — на свежий origin/main НЕ перевожу ` +
                    `(снесло бы работу). Разбери руками: ${worktreePath}`,
            );
            return false;
        }
        try {
            runArgvFn(
                'git',
                ['-C', worktreePath, 'fetch', 'origin', 'main', '--quiet'],
                gitNetworkOpts(),
            );
            runArgvFn('git', [
                '-C',
                worktreePath,
                'checkout',
                '--detach',
                'origin/main',
                '--quiet',
            ]);
        } catch (e: unknown) {
            logFn(`⚠ Не смог обновить worktree раннера на origin/main: ${(e as Error).message}`);
            return false;
        }
        logFn('🌳 Worktree раннера переведён на свежий origin/main.');
        return true;
    }

    /**
     * Гарантирует существование выделенного worktree раннера. Идемпотентно: уже
     * зарегистрированный worktree переиспользуется без побочных эффектов (M2-стиль —
     * не пересоздаём то, что уже есть).
     *
     * Fail-closed (тот же принцип, что во всём файле — C1/M2): если путь ЗАНЯТ чем-то,
     * что не зарегистрировано как worktree этого репозитория (чужая папка, мусор от
     * ручного `rm -rf` вместо `git worktree remove`), НЕ трогаем и НЕ угадываем —
     * останавливаем раннер, разбор за человеком.
     *
     * Свежий worktree создаётся `--detach` (детач, не ветка): на этом шаге раннер ещё
     * не знает, какая ветка фазы понадобится, а `main` почти всегда уже занят деревом
     * человека — git не даёт одну и ту же ветку в двух worktree одновременно.
     * Ветку фазы дальше занимают кодер-сессии в этом дереве; git-хелперы гейта (#77)
     * работают строго детачем (PR-голова / origin/main), именованных веток не занимая.
     *
     * `npm ci` сразу после создания: `git worktree add` линкует только git-отслеживаемые
     * файлы, `node_modules` (в .gitignore) в новом дереве нет — без установки первый же
     * чек гейта упал бы на отсутствующих зависимостях.
     *
     * #576: дерево ещё и ВНОСИТСЯ В ДОВЕРЕННЫЕ (trustFn) — тем же действием, что создание.
     * Без этого кодер-сессия молча теряла все `permissions.allow` из `.claude/settings.json`
     * («this workspace has not been trusted») и работала на дефолтной политике. Доверие
     * ставится в ОБЕИХ ветках, а не только при создании: дерево, поднятое до этой правки
     * (или на машине, где конфиг Claude пересоздали), иначе так и осталось бы недоверенным
     * до следующего пересоздания worktree. Идемпотентно — уже доверенное дерево не приводит
     * к записи файла (подробности и эмпирика ключа — в workspace-trust.ts).
     *
     * Исход доверия ПРОВЕРЯЕТСЯ на месте (`=== 'failed'`), а не отбрасывается в расчёте на
     * то, что failFn внутри trustFn бросит: тип `FailFn` возвращает `unknown` и `never` не
     * обещает, так что на не-бросающей реализации (мок, обёртка) инвариант «сбой доверия =
     * стоп» молча стал бы fail-open. Стоп выражен здесь же, как у всех прочих отказов
     * функции — `return failFn(...)`.
     */
    function ensureRunnerWorktree(
        worktreePath: string,
        {
            shFn = sh,
            // #252: git fetch перед первым созданием worktree — мутация, через argv.
            runArgvFn = shArgv,
            logFn = log,
            failFn = fail,
            existsFn = fs.existsSync as ExistsFn,
            refreshFn = refreshRunnerWorktree,
            // Путь в argv (execFile без shell), а не в шелл-строку: пробел/спецсимвол из
            // cfg.runnerWorktreePath/RALPH_WORKTREE_PATH не разваливает команду на аргументы
            // и не доезжает до шелла (та же гигиена, что spawnClaude/probeEgress) (#SiaUP).
            addFn = (p: string) => {
                // Забытый addFn в тесте создал бы настоящий git worktree в дереве, где
                // идут тесты (гейт гоняет npm run test прямо в worktree раннера) —
                // предохранитель #138 краснит до реальной git-побочки.
                guardSideEffect('git worktree add (ensureRunnerWorktree)');
                return execFileSync('git', ['worktree', 'add', '--detach', p, 'origin/main'], {
                    stdio: 'inherit',
                });
            },
            // env (#189): `npm ci` исполняет lifecycle-скрипты зависимостей — код с чужих
            // слов. Санируем окружение по allowlist, чтобы скомпрометированная зависимость
            // не нашла в env секретов петли (GH_TOKEN, CLAUDE_*, RALPH_TG_*). buildGateEnvFn —
            // DI для тестов; в проде строит env из gate-env-allowlist.json. Санированный env
            // приходит в installFn аргументом — так подмена видна в тестах через spy.
            buildGateEnvFn = buildSanitizedGateEnv,
            installFn = (dir: string, gateEnv: NodeJS.ProcessEnv) => {
                // Забытый installFn в тесте переустановил бы node_modules в дереве, где
                // идут тесты (ревью PR #141) — тот же предохранитель #138, что у
                // installFn в syncDepsIfLockChanged (state-lock.ts).
                guardSideEffect('installCmd (ensureRunnerWorktree)');
                // #204: команда установки из конфига (дефолт `npm ci`).
                return execSync(getInstallCmd(), { cwd: dir, stdio: 'inherit', env: gateEnv });
            },
            markFn = writeLockMarker,
            // #576: доверие дереву. Дефолт замкнут на logFn/failFn ЭТОГО вызова (порядок
            // деструктуризации это позволяет) — отказ доверия попадает в тот же лог и тот
            // же fail-closed стоп, что и остальные сбои создания дерева.
            trustFn = (p: string) => ensureWorkspaceTrusted(p, { logFn, failFn }),
            repoRoot = process.cwd(),
        }: {
            shFn?: ShFn;
            runArgvFn?: ShArgvFn;
            logFn?: LogFn;
            failFn?: FailFn;
            existsFn?: ExistsFn;
            refreshFn?: typeof refreshRunnerWorktree;
            addFn?: (p: string) => unknown;
            buildGateEnvFn?: () => NodeJS.ProcessEnv;
            installFn?: (dir: string, gateEnv: NodeJS.ProcessEnv) => unknown;
            markFn?: (dir?: string) => void;
            trustFn?: (p: string) => TrustOutcome;
            repoRoot?: string;
        } = {},
        // Возврат `unknown`, а не `string`: успех отдаёт worktreePath (string), но ветки
        // ошибок возвращают failFn(...) — в бою fail не возвращается (process.exit), однако
        // по типу FailFn это `unknown`. `string | unknown` схлопнулось бы в `unknown` и
        // обманывало бы (юнион с unknown поглощает string), поэтому пишем `unknown` честно.
    ): unknown {
        // #SiaUT: путь ВНУТРИ репозитория — ошибка (дефолт-сосед при запуске не из корня,
        // или кривой cfg/env-override): вложенное дерево игнорится .gitignore родителя либо
        // норовит закоммититься как sub-repo. Останавливаемся до любых git-побочек.
        if (worktreePath === repoRoot || worktreePath.startsWith(repoRoot + path.sep)) {
            return failFn(
                `Путь worktree раннера ${worktreePath} — внутри репозитория ${repoRoot}. ` +
                    `Он должен быть СОСЕДОМ репозитория (дефолт ../${defaultWorktreeDirnameFor(repoRoot)}); ` +
                    `поправь runnerWorktreePath/RALPH_WORKTREE_PATH/runnerWorktreeDirname и перезапусти.`,
            );
        }
        let list = '';
        try {
            list = shFn('git worktree list --porcelain');
        } catch (e: unknown) {
            return failFn(`git worktree list упал: ${(e as Error).message}`);
        }
        if (parseWorktreeList(list).includes(worktreePath)) {
            // #SiaUG: обратный к следующей ветке случай — путь ЗАРЕГИСТРИРОВАН, но папки нет
            // (итог ручного `rm -rf` без `git worktree remove`: list отдаёт путь до prune).
            // Без этой проверки main() свалился бы на process.chdir с голым ENOENT. Здесь
            // prune как раз к месту — он чистит регистрации без папок.
            if (!existsFn(worktreePath)) {
                return failFn(
                    `${worktreePath} зарегистрирован как git worktree, но папки на диске нет — ` +
                        `похоже, ручной rm -rf вместо "git worktree remove". Почисти реестр: ` +
                        `"git worktree prune" — и перезапусти.`,
                );
            }
            logFn(`🌳 Worktree раннера уже поднят: ${worktreePath}`);
            refreshFn(worktreePath, { shFn, runArgvFn, logFn });
            if (trustFn(worktreePath) === 'failed') return failFn(untrustedMessage(worktreePath));
            return worktreePath;
        }
        if (existsFn(worktreePath)) {
            // #SiaUJ: здесь папка ЕСТЬ, но не зарегистрирована — prune тут не поможет (он
            // чистит противоположное). Fail-closed: путь занят посторонней папкой.
            return failFn(
                `${worktreePath} существует, но не зарегистрирован как git worktree этого репозитория — ` +
                    `путь занят посторонней папкой. Перенеси или удали её и перезапусти.`,
            );
        }
        logFn(`🌳 Создаю выделенный worktree раннера: ${worktreePath}`);
        // База — свежий origin/main, а не текущий HEAD дерева человека (#499): тот в момент
        // первого запуска может стоять где угодно (древняя ветка, детач посреди ручной
        // археологии), и npm ci ниже поставил бы зависимости случайного коммита.
        try {
            runArgvFn('git', ['fetch', 'origin', 'main'], gitNetworkOpts());
        } catch (e: unknown) {
            return failFn(
                `git fetch origin main перед созданием worktree упал: ${(e as Error).message}`,
            );
        }
        try {
            addFn(worktreePath);
        } catch (e: unknown) {
            return failFn(`git worktree add ${worktreePath} упал: ${(e as Error).message}`);
        }
        // #576: доверие — сразу за созданием, ДО дорогого npm ci: недоверенное дерево
        // означает сессию без permissions.allow, и узнать об этом лучше за секунду, а не
        // за минуту установки зависимостей.
        if (trustFn(worktreePath) === 'failed') return failFn(untrustedMessage(worktreePath));
        logFn('📦 npm ci в новом worktree (git worktree add не копирует node_modules)...');
        // Санацию env считаем ОТДЕЛЬНЫМ шагом с собственной атрибуцией (как в checksGreen):
        // битый allowlist → санировать нельзя → fail-closed, но это не «npm ci упал» (он даже
        // не стартовал), а «санация не удалась» — иначе диагностика врёт про несуществующий сбой.
        let gateEnv: NodeJS.ProcessEnv;
        try {
            gateEnv = buildGateEnvFn();
        } catch (e: unknown) {
            return failFn(
                `санация env для npm ci не удалась (allowlist не читается): ${(e as Error).message} — ` +
                    `чеки без allowlist не запускаем (fail-closed)`,
            );
        }
        try {
            installFn(worktreePath, gateEnv);
        } catch (e: unknown) {
            return failFn(`npm ci в ${worktreePath} упал: ${(e as Error).message}`);
        }
        // Засеваем маркер хэша lock: первый гейт на PR-голове с тем же lock не будет
        // гонять npm ci заново (#SiaUX). Best-effort — маркер лишь оптимизация.
        markFn(worktreePath);
        return worktreePath;
    }

    return {
        resolveWorktreePath,
        parseWorktreeList,
        runnerWorktreeReady,
        refreshRunnerWorktree,
        ensureRunnerWorktree,
    };
}
