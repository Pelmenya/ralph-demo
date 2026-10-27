// Отрицательная проба барьера перед первой сессией (канон, задача 6).
//
// Зачем. Сессии петли идут под `--permission-mode bypassPermissions`: в этом режиме
// `permissions.deny` из `.claude/settings.json` не применяется вовсе, и держит ровно одно —
// PreToolUse-хук. Пока хук лежит в дереве, а проводка его не зовёт (снятый matcher,
// опечатка в пути, сломанный require), петля идёт ночью без единого барьера — и об этом
// не узнаёт никто: отказа нет, есть отсутствие отказа. Тест проводки в гейте сторожит
// ТЕКСТ настроек; проба проверяет ПОВЕДЕНИЕ — то, что увидит сессия.
//
// Как. Читаем настройки дерева, где пойдут сессии, берём PreToolUse-хуки, чей matcher
// накрывает инструмент пробы, и подаём каждому вызов на stdin ровно в той форме, в какой
// его подаёт Claude Code. Сам вызов НЕ исполняется — исполняется только хук, поэтому
// «запрещённое» действие безопасно по построению. Пробы двух родов:
//   • запрещённые (рекурсивное удаление, чтение env-файла) — хоть один хук обязан выйти
//     кодом 2. У PreToolUse блокирует ТОЛЬКО exit 2: код 1, таймаут и «не запустился»
//     Claude Code считает ошибкой без блокировки, и вызов исполняется. Поэтому здесь
//     блокировкой считается только 2;
//   • безобидная (`git status`) — все хуки обязаны выйти нулём. Барьер fail-closed:
//     упавшие правила блокируют ВСЁ, и сессия, запущенная на таком барьере, сожгла бы
//     итерацию на отказах. Ловим это до старта, а не в журнале сессии.
//
// Режим отказа — fail-closed (инвариант №1): не прочли настройки, не нашли хука, хук не
// заблокировал — петля не стартует, причина названа в отказе.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис). Standalone-экспорты, как у workspace-trust.ts: контекста фабрики модулю не
// нужно — log/fail приходят параметрами единственного вызова.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { guardSideEffect } from '../shared/side-effect-guard.ts';

type LogFn = (msg: string) => void;
type FailFn = (msg: string) => unknown;

/** Один вызов пробы: что подаём хукам и чего от них ждём. */
export type TGuardProbe = {
    /** Человеческое имя — попадает в отказ. */
    what: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    expect: 'blocked' | 'allowed';
};

/**
 * Состав пробы — критерии готовности задачи 6, а не выборка «чего-нибудь опасного»:
 * рекурсивное удаление и чтение env-файла обоими путями (файловым инструментом и из
 * оболочки). Путь удаления — заведомо несуществующий каталог внутри дерева: даже если
 * однажды кто-то исполнит пробу как команду, сносить там нечего.
 */
export const GUARD_PROBES: readonly TGuardProbe[] = [
    {
        what: 'рекурсивное удаление',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf ./.ralph-guard-probe' },
        expect: 'blocked',
    },
    {
        what: 'чтение env-файла инструментом Read',
        toolName: 'Read',
        toolInput: { file_path: '.env' },
        expect: 'blocked',
    },
    {
        what: 'чтение env-файла из оболочки',
        toolName: 'Bash',
        toolInput: { command: 'cat .env' },
        expect: 'blocked',
    },
    {
        // Grep читает СОДЕРЖИМОЕ файла (`output_mode: content`), то есть это тот же путь
        // к секрету, что Read, только другим инструментом (ревью Kimi).
        what: 'чтение env-файла инструментом Grep',
        toolName: 'Grep',
        toolInput: { pattern: '.', path: '.env', output_mode: 'content' },
        expect: 'blocked',
    },
    {
        // `sed`/`awk` тоже читают файл, а список читающих команд у барьера потребителя их
        // не знал (ревью Kimi): проба из одного `cat` прошла бы при этой дыре.
        what: 'чтение env-файла через sed',
        toolName: 'Bash',
        toolInput: { command: "sed -n '1,5p' .env" },
        expect: 'blocked',
    },
    {
        what: 'безобидная команда',
        toolName: 'Bash',
        toolInput: { command: 'git status' },
        expect: 'allowed',
    },
];

/**
 * Хук из настроек: команда оболочки, её таймаут в секундах и почему он НЕ вправе считаться
 * блокирующим (`null` — вправе). Такой хук всё равно запускается: на безобидной пробе он
 * обязан пропустить вызов, как и все.
 */
export type THookCommand = { command: string; timeoutSec: number; cannotBlock: string | null };

/** Исход одного запуска хука: код выхода (null — не завершился сам) и stderr. */
export type THookRun = { status: number | null; stderr: string };

export type TRunHookFn = (hook: THookCommand, payload: string, projectDir: string) => THookRun;

// Claude Code ждёт хук 60 секунд, если таймаут в настройках не задан.
const DEFAULT_TIMEOUT_SEC = 60;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Накрывает ли matcher инструмент. Семантика Claude Code: пустой matcher и `*` — любой
 * инструмент, иначе регулярное выражение по имени целиком. Битый regex не накрывает
 * ничего: хук с ним не позвали бы и в сессии.
 */
export function matcherCovers(matcher: unknown, toolName: string): boolean {
    if (matcher === undefined || matcher === '' || matcher === '*') return true;
    if (typeof matcher !== 'string') return false;
    try {
        return new RegExp(`^(?:${matcher})$`).test(toolName);
    } catch {
        return false;
    }
}

/**
 * Поля записи, при которых exit 2 хука ещё не значит, что сессия будет заблокирована:
 * асинхронный ответ приходит, когда инструмент уже отработал; `once` срабатывает раз за
 * сессию; `if` зовёт хук не на всё. Тот же перечень сторожит сверка проводки
 * (`checkGuardWiring`), но она судит текст, а проба — исход (ревью Kimi).
 */
function cannotBlock(hook: Record<string, unknown>): string | null {
    if (hook.async === true) return 'async: асинхронный хук не блокирует вызов';
    if (hook.once === true) return 'once: срабатывает один раз за сессию';
    if (hook.if !== undefined) return 'if: хук зовут не на каждый вызов';
    return null;
}

/**
 * PreToolUse-хуки, которые Claude Code позовёт на этот инструмент. Битая форма записи
 * пропускается молча: её хук не позовут и в сессии, а отказ пробы назовёт итог — «хука
 * нет», — то есть ровно то, что увидит человек.
 */
export function hooksFor(settings: unknown, toolName: string): THookCommand[] {
    if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return [];
    const entries = settings.hooks.PreToolUse;
    if (!Array.isArray(entries)) return [];
    const out: THookCommand[] = [];
    for (const entry of entries) {
        if (!isPlainObject(entry) || !matcherCovers(entry.matcher, toolName)) continue;
        if (!Array.isArray(entry.hooks)) continue;
        for (const hook of entry.hooks) {
            if (!isPlainObject(hook) || hook.type !== 'command') continue;
            if (typeof hook.command !== 'string' || hook.command.trim() === '') continue;
            const timeoutSec =
                typeof hook.timeout === 'number' && hook.timeout > 0
                    ? hook.timeout
                    : DEFAULT_TIMEOUT_SEC;
            out.push({ command: hook.command, timeoutSec, cannotBlock: cannotBlock(hook) });
        }
    }
    return out;
}

/** Вход хука в той форме, что подаёт Claude Code. Транскрипта у пробы нет. */
export function probePayload(probe: TGuardProbe, projectDir: string): string {
    return JSON.stringify({
        session_id: 'ralph-guard-probe',
        hook_event_name: 'PreToolUse',
        cwd: projectDir,
        tool_name: probe.toolName,
        tool_input: probe.toolInput,
    });
}

/**
 * Боевой запуск хука: через оболочку, как его запускает Claude Code (команда в настройках —
 * строка с `${CLAUDE_PROJECT_DIR}`), с тем же каталогом и переменной.
 */
export const runHook: TRunHookFn = (hook, payload, projectDir) => {
    guardSideEffect(`guard-probe: ${hook.command}`, 'Подмени runHookFn в тесте.');
    const r = spawnSync('sh', ['-c', hook.command], {
        cwd: projectDir,
        input: payload,
        encoding: 'utf-8',
        timeout: hook.timeoutSec * 1000,
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });
    return { status: r.status, stderr: r.stderr ?? String(r.error ?? '') };
};

/** Короткая строка stderr для отказа: хук объясняет себя сам, но не абзацем. */
const brief = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * Проблемы пробы для уже прочитанных настроек. Пустой список — барьер держит.
 * Чистая функция над `runHookFn`: тест подаёт фейковые исходы, а не живые процессы.
 */
export function probeProblems(
    settings: unknown,
    projectDir: string,
    {
        runHookFn = runHook,
        probes = GUARD_PROBES,
    }: { runHookFn?: TRunHookFn; probes?: readonly TGuardProbe[] } = {},
): string[] {
    // Один флаг в корне выключает ВСЕ хуки, не тронув ни одной записи: запусти проба хуки
    // сама, она увидела бы исправный барьер, которого в сессии нет вовсе.
    if (isPlainObject(settings) && settings.disableAllHooks === true) {
        return ['disableAllHooks: true — Claude Code не запустит ни одного хука в сессии'];
    }
    const problems: string[] = [];
    for (const probe of probes) {
        const hooks = hooksFor(settings, probe.toolName);
        if (hooks.length === 0) {
            problems.push(
                `${probe.what} (${probe.toolName}): ни один PreToolUse-хук не накрывает ` +
                    `инструмент — под bypassPermissions вызов прошёл бы без проверки`,
            );
            continue;
        }
        const payload = probePayload(probe, projectDir);
        const runs = hooks.map((hook) => ({ hook, run: runHookFn(hook, payload, projectDir) }));
        if (probe.expect === 'blocked') {
            if (runs.some(({ hook, run }) => run.status === 2 && hook.cannotBlock === null)) {
                continue;
            }
            const seen = runs
                .map(({ hook, run }) =>
                    hook.cannotBlock
                        ? `${String(run.status)} (${hook.cannotBlock})`
                        : String(run.status),
                )
                .join(', ');
            problems.push(
                `${probe.what} (${probe.toolName}): ни один хук не заблокировал вызов ` +
                    `(коды выхода: ${seen}; блокирует только 2)`,
            );
            continue;
        }
        for (const { hook, run } of runs) {
            if (run.status === 0) continue;
            problems.push(
                `${probe.what} (${probe.toolName}): хук «${hook.command}» не пропустил её ` +
                    `(код ${String(run.status)}${run.stderr ? `: ${brief(run.stderr)}` : ''}) — ` +
                    `барьер блокирует всё подряд, сессия на нём не работала бы`,
            );
        }
    }
    return problems;
}

/**
 * Выбор рантайма кодера в форме конфига: статический `adapters.coderRuntime` и маршруты
 * `modelRouting`. Строковая запись маршрута провайдера не меняет — берётся статический.
 */
export type TRuntimeSelection = {
    coderRuntime?: string;
    modelRouting?: {
        labels?: Record<string, unknown>;
        default?: unknown;
        apiLimitFallback?: unknown;
    };
};

/**
 * Рантаймы, сессии которых идут МИМО Claude-хуков. `openai` — отдельный бинарь
 * `codex exec`: `.claude/settings.json` он не читает, и проба, зелёная на Claude-хуках,
 * про его сессии не говорит ничего (ревью Kimi). `kimi` в списке нет: это тот же `claude`
 * с другим endpoint, хуки у него те же.
 */
export const HOOKLESS_RUNTIMES: ReadonlySet<string> = new Set(['openai']);

/**
 * Где конфиг может отправить сессию в рантайм без хуков. Пустой список — все сессии идут
 * через Claude Code. Барьера для таких рантаймов в каноне нет, поэтому это отказ, а не
 * предупреждение: петля под bypass без барьера — ровно то, что закрывает задача 6.
 */
export function hooklessRoutes(sel: TRuntimeSelection): string[] {
    const fallback = sel.coderRuntime ?? 'claude';
    const providerOf = (entry: unknown): string =>
        isPlainObject(entry) && typeof entry.provider === 'string' ? entry.provider : fallback;
    const out: string[] = [];
    if (HOOKLESS_RUNTIMES.has(fallback)) out.push(`adapters.coderRuntime = '${fallback}'`);
    const routing = sel.modelRouting ?? {};
    for (const [label, entry] of Object.entries(routing.labels ?? {})) {
        const provider = providerOf(entry);
        if (HOOKLESS_RUNTIMES.has(provider) && provider !== fallback) {
            out.push(`modelRouting.labels.${label} → '${provider}'`);
        }
    }
    for (const key of ['default', 'apiLimitFallback'] as const) {
        if (routing[key] === undefined) continue;
        const provider = providerOf(routing[key]);
        if (HOOKLESS_RUNTIMES.has(provider) && provider !== fallback) {
            out.push(`modelRouting.${key} → '${provider}'`);
        }
    }
    return out;
}

/**
 * Проверка перед первой сессией: не держит барьер — `failFn` с полным списком причин.
 * `projectDir` — дерево, в котором пойдут сессии. Настройки — `settings`, собранный
 * раннером (задача 101, `session-settings.ts`), а без него — `.claude/settings.json` этого
 * дерева: их сессия и прочтёт.
 */
export function ensureGuardHolds(
    projectDir: string,
    {
        failFn,
        logFn,
        readFileFn = (p: string) => fs.readFileSync(p, 'utf-8'),
        runHookFn = runHook,
        runtimes = {},
        settings: given,
    }: {
        failFn: FailFn;
        logFn: LogFn;
        readFileFn?: (p: string) => string;
        runHookFn?: TRunHookFn;
        runtimes?: TRuntimeSelection;
        settings?: unknown;
    },
): void {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    let settings: unknown = given;
    if (settings === undefined) {
        try {
            settings = JSON.parse(readFileFn(settingsPath));
        } catch (error) {
            failFn(
                `Проба барьера: ${settingsPath} не прочитан (${error instanceof Error ? error.message : String(error)}). ` +
                    'Без настроек хуков сессии под bypassPermissions идут без барьера — старт отменён.',
            );
            return;
        }
    }
    const problems = [
        ...hooklessRoutes(runtimes).map(
            (where) =>
                `${where}: рантайм без Claude-хуков — сессия пошла бы мимо барьера, ` +
                'а своего барьера у него нет',
        ),
        ...probeProblems(settings, projectDir, { runHookFn }),
    ];
    if (problems.length > 0) {
        failFn(
            'Проба барьера не прошла — сессии под bypassPermissions пошли бы без защиты:\n' +
                problems.map((p) => `  - ${p}`).join('\n') +
                '\nПочини хук или его проводку в .claude/settings.json; петлю это не обходит.',
        );
        return;
    }
    logFn(`🛡  Проба барьера пройдена: запрещённое заблокировано, безобидное пропущено`);
}
