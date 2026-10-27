// Доверие рабочему дереву раннера (#576).
//
// Симптом. Кодер-сессия петли печатала на каждом старте:
//   Ignoring 32 permissions.allow entries from .claude/settings.json:
//   this workspace has not been trusted.
// То есть ВСЕ разрешения репозитория не действовали, и сессия шла на дефолтной политике.
// Наружу это выходит не ошибкой, а тем, что агент «чего-то не смог» и пошёл обходным
// путём, — тот же класс тихого отказа, что state.milestone из конфига: настройка есть,
// механизм её не читает.
//
// Что проверяет Claude CLI (проверено эмпирически на claude 2.1.233, а не выведено из
// документации): `projects[<КЛЮЧ>].hasTrustDialogAccepted === true` в глобальном
// `~/.claude.json` (либо `$CLAUDE_CONFIG_DIR/.claude.json`). `--permission-mode
// bypassPermissions` этой проверки НЕ снимает — под ним разрешения тоже отбрасываются.
//
// Недоверие роняет ТОЛЬКО `permissions.allow` — `deny` и блок `hooks` действуют (#61).
// Разница не косметическая: уроненный `deny` или `hooks` отключил бы guard.cjs, а под
// `bypassPermissions` он единственный широкий барьер сессии. Замер на claude 2.1.311,
// `-p --permission-mode bypassPermissions`, временный репозиторий не из `projects`:
// в `.claude/settings.json` правило allow, правило deny на `touch deny-probe` и
// PreToolUse-хук, который пишет каждый вызов в журнал и отказывает кодом 2 на
// `hook-probe`. Два прогона — обычное дерево и линкованный worktree (раскладка петли):
//   • CLI печатает «Ignoring 1 permissions.allow entry … not been trusted»;
//   • `touch deny-probe` отклонён правилом deny, файла нет;
//   • `touch hook-probe` отклонён хуком, файла нет; хук видел все три вызова;
//   • `touch free-probe` прошёл — значит, отказы выше не от общей блокировки.
// Значит, провал доверия — послабление в сторону запрета, а не дыра, и отдельного барьера
// на него не нужно: fail-closed ниже остаётся ради разрешений. Проверять снова при смене
// мажорной версии CLI — поведение задаёт он, а не мы.
//
// Главное про КЛЮЧ, и это ровно то, на чём ломается наивная починка. Для линкованного
// git worktree CLI канонизирует cwd до корня ОСНОВНОГО дерева репозитория: сессия в
// `/path/to/app-ralph` (worktree дерева `/path/to/app`) спрашивает про запись `/path/to/app`.
// Проверено тремя прогонами на временном репозитории:
//   • доверен только `/path/to/app-ralph` (сам worktree) → разрешения по-прежнему отброшены;
//   • доверен `/path/to/app` (основное дерево)          → разрешения действуют;
//   • не доверен никто                               → отброшены, и сам CLI в сообщении
//     называет ключ, который ему нужен: `projects["/path/to/app"]`.
// Поэтому вносим ОБА пути: канонический корень (его читает CLI сегодня) и путь самого
// worktree (страховка, если канонизация в CLI изменится, — лишняя запись ничего не стоит,
// а молчаливая потеря разрешений стоила уже целой фазы).
//
// Побочный вывод, важный при переносе (#204): доверие живёт в конфиге МАШИНЫ, а не в
// репозитории, — значит, провижн нового сервера получает его отсюда, а не из настроек
// в гите. Ровно поэтому правка `~/.claude.json` руками закрывает симптом на одной машине
// и не переносится: механизм обязан быть в раннере.
//
// Режим отказа — fail-closed (инвариант №1). Не смогли довериться (битый JSON, нет прав,
// диск только на чтение) → ВИДИМЫЙ отказ раннера через failFn, а не строка, тонущая
// внутри вывода сессии. Тихий дефолт здесь означал бы «петля работает без половины
// разрешений и никто не знает».
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
//
// Standalone-экспорты, а не фабрика (как в gate-env.mts, не как в worktree.ts/gate.ts):
// контекста ralph.js модулю не нужно — log/fail приходят параметрами того единственного
// вызова, который их использует.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardSideEffect } from '../shared/side-effect-guard.ts';

type ReadFileFn = (p: string, enc: 'utf-8') => string;
type WriteFileFn = (p: string, data: string) => void;
type LogFn = (msg: string) => void;
type FailFn = (msg: string) => unknown;

// Исход попытки довериться. Три значения, а не boolean: «уже доверено» и «не смогли» —
// разные вещи для вызывающего, и слипшись в одно `false` они делали fail-closed
// невыразимым в коде (подробности — в докблоке ensureWorkspaceTrusted).
export type TrustOutcome = 'written' | 'already' | 'failed';

// Имя флага — контракт Claude CLI, не наша выдумка: ровно его называет сам CLI в
// сообщении «set projects[…].hasTrustDialogAccepted: true».
export const TRUST_FLAG = 'hasTrustDialogAccepted';

/**
 * Путь глобального конфига Claude CLI. `CLAUDE_CONFIG_DIR` важнее home — читаем ровно
 * то же, что прочтёт спавненная сессия (она наследует env раннера), иначе доверие легло
 * бы в один файл, а проверялось по другому.
 */
export function claudeConfigPath(
    env: NodeJS.ProcessEnv = process.env,
    homeFn: () => string = os.homedir,
): string {
    return path.join(env.CLAUDE_CONFIG_DIR || homeFn(), '.claude.json');
}

/**
 * Канонический ключ доверия для каталога: для линкованного git worktree — корень
 * основного дерева репозитория, для всего остального — сам путь.
 *
 * Читаем ФАЙЛЫ git (`.git`-указатель → `commondir`), а не зовём `git`: ровно так
 * канонизирует сам CLI, плюс это чистая функция без подпроцесса — тестируется без
 * побочек. Любая неожиданность (`.git` — папка обычного клона, нечитаемый commondir,
 * gitdir не из `worktrees/`, то есть submodule) → возвращаем сам путь: не угадываем.
 */
export function canonicalWorkspaceRoot(
    dir: string,
    { readFileFn = fs.readFileSync as unknown as ReadFileFn }: { readFileFn?: ReadFileFn } = {},
): string {
    const self = path.resolve(dir);
    let pointer = '';
    try {
        pointer = readFileFn(path.join(self, '.git'), 'utf-8').trim();
    } catch {
        // `.git` — каталог (обычный клон, EISDIR) либо его нет вовсе.
        return self;
    }
    if (!pointer.startsWith('gitdir:')) return self;
    const gitdir = path.resolve(self, pointer.slice('gitdir:'.length).trim());
    let commondir = '';
    try {
        commondir = readFileFn(path.join(gitdir, 'commondir'), 'utf-8').trim();
    } catch {
        return self;
    }
    const common = path.resolve(gitdir, commondir);
    // Линкованный worktree узнаётся по раскладке: его gitdir лежит в <common>/worktrees/<имя>.
    // Иначе это submodule (<common>/modules/<имя>) — там канонизировать нечего.
    if (path.resolve(path.dirname(gitdir)) !== path.join(common, 'worktrees')) return self;
    // Общий каталог зовётся не `.git` — это `git init --separate-git-dir` / `core.worktree`,
    // где commondir указывает, например, на `/gitdirs/app.git`, и рабочего дерева РЯДОМ с
    // ним нет вовсе. Вернуть `common` здесь значило бы внести в доверенные путь, который
    // никакой сессии не соответствует: лог сказал бы «внесено», а разрешения по-прежнему
    // отбрасывались бы — тихий отказ с зелёным логом, ровно тот, что модуль и закрывает.
    // Раскладку не угадываем (принцип докблока выше) → сам путь.
    if (path.basename(common) !== '.git') return self;
    return path.dirname(common);
}

/**
 * Пути, которые надо внести в доверенные для дерева раннера: канонический корень ПЕРВЫМ
 * (его и читает CLI), путь самого дерева следом. Совпали — один элемент.
 */
export function trustTargets(
    worktreePath: string,
    { canonicalFn = canonicalWorkspaceRoot }: { canonicalFn?: (dir: string) => string } = {},
): string[] {
    const self = path.resolve(worktreePath);
    const root = canonicalFn(self);
    return root === self ? [self] : [root, self];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Чистое преобразование глобального конфига: проставить флаг доверия перечисленным путям,
 * не тронув ничего больше. Возвращает НОВЫЙ объект (исходный не мутируется) и список
 * реально добавленного — по нему вызывающий решает, писать ли файл вообще.
 *
 * Бросает (а не чинит молча) на конфиге, который не объект, и на относительном пути:
 * ключ `projects` адресуется абсолютным путём, относительный ключ CLI не найдёт никогда,
 * то есть «доверие» оказалось бы записанным и недействующим — худший из исходов.
 * Собственную запись НЕ объектом (битый конфиг) чиним заменой: правим только свой ключ.
 */
export function withTrustedWorkspaces(
    raw: unknown,
    targets: string[],
): { config: Record<string, unknown>; added: string[] } {
    if (raw !== undefined && !isPlainObject(raw)) {
        throw new Error('глобальный конфиг Claude — не JSON-объект');
    }
    const config: Record<string, unknown> = { ...(raw ?? {}) };
    const rawProjects = config.projects;
    if (rawProjects !== undefined && !isPlainObject(rawProjects)) {
        throw new Error('поле projects глобального конфига Claude — не объект');
    }
    // Spread, а не присваивание в исходный объект: чистота функции + own-property-копия
    // (JSON.parse кладёт "__proto__" как ОБЫЧНОЕ own-свойство, и spread копирует его тоже
    // own-свойством, без прототипной записи).
    const projects: Record<string, unknown> = { ...(rawProjects ?? {}) };
    const added: string[] = [];
    for (const target of targets) {
        if (!path.isAbsolute(target)) {
            throw new Error(`путь доверия "${target}" не абсолютный — CLI такой ключ не найдёт`);
        }
        const prev = projects[target];
        if (isPlainObject(prev) && prev[TRUST_FLAG] === true) continue;
        projects[target] = { ...(isPlainObject(prev) ? prev : {}), [TRUST_FLAG]: true };
        added.push(target);
    }
    config.projects = projects;
    return { config, added };
}

// Боевая запись: атомарно (temp + rename в том же каталоге) и с правами 600 — в файле
// лежат данные аккаунта, а rename нового файла не наследует режим старого.
// guardSideEffect (#138): забытый в тесте override переписал бы НАСТОЯЩИЙ ~/.claude.json
// машины, где идут тесты, — это вне репозитория, откатить нечем.
function writeConfigFile(p: string, data: string): void {
    guardSideEffect(
        `write ${p} (ensureWorkspaceTrusted)`,
        'Подмени writeFileFn в опциях ensureWorkspaceTrusted — это запись глобального ' +
            'конфига Claude ВНЕ репозитория.',
    );
    // Имя временного файла — с pid: на машине штатно живут два прогона (боевой prod и
    // playground/--dry-run кодер-сессии, RUNBOOK) с общим `$HOME` и общим `~/.claude.json`.
    // Фиксированное имя дало бы гонку, в которой один процесс пишет в файл, уже
    // переименованный вторым, — и атомарность, ради которой temp+rename и заведён,
    // теряется именно тогда, когда она нужна.
    const tmp = `${p}.${String(process.pid)}.ralph-trust.tmp`;
    try {
        fs.writeFileSync(tmp, data, { mode: 0o600 });
        fs.renameSync(tmp, p);
    } catch (e: unknown) {
        // Мусор в домашнем каталоге живёт вечно и никем не подметается: чистим за собой.
        // Уборка — best-effort, отказ несёт исходная ошибка, а не сбой rm.
        try {
            fs.unlinkSync(tmp);
        } catch {
            /* нечего чистить либо и это не вышло — исходную ошибку не подменяем */
        }
        throw e;
    }
}

/**
 * Вносит дерево раннера в доверенные Claude CLI. Идемпотентно: уже доверенное дерево не
 * приводит к записи файла вовсе — конфиг машины принадлежит человеку, и переписывать его
 * без нужды (тем более пока рядом может идти его собственная сессия) незачем.
 *
 * Любой сбой — failFn (в бою это стоп раннера с сообщением в ralph.log): доверие либо
 * есть, либо о его отсутствии известно.
 *
 * Возвращает ИСХОД, а не boolean: `'written' | 'already' | 'failed'`. Прежний boolean
 * склеивал «уже доверено» и «не смогли» в одно `false`, и весь fail-closed держался
 * исключительно на том, что боевой `fail` из exec.ts делает `process.exit`. Тип
 * `FailFn = (msg: string) => unknown` этого не обещает — первая же не-бросающая
 * реализация (мок в тесте, обёртка) молча превратила бы инвариант в fail-open. Теперь
 * вызывающий (`ensureRunnerWorktree`) различает исходы САМ и на `'failed'` останавливается
 * своим failFn, не полагаясь на чужое поведение.
 */
export function ensureWorkspaceTrusted(
    worktreePath: string,
    {
        configPath = claudeConfigPath(),
        readFileFn = fs.readFileSync as unknown as ReadFileFn,
        writeFileFn = writeConfigFile,
        targetsFn = trustTargets,
        logFn,
        failFn,
    }: {
        configPath?: string;
        readFileFn?: ReadFileFn;
        writeFileFn?: WriteFileFn;
        targetsFn?: (p: string) => string[];
        logFn: LogFn;
        failFn: FailFn;
    },
): TrustOutcome {
    const targets = targetsFn(worktreePath);
    let raw: string | null = null;
    try {
        raw = readFileFn(configPath, 'utf-8');
    } catch (e: unknown) {
        // Файла нет — свежая машина после провижна: создадим. Всё остальное (права, IO) —
        // отказ: молча пропустить значило бы отдать сессии дефолтную политику.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            failFn(
                `Глобальный конфиг Claude ${configPath} не читается: ${(e as Error).message} — ` +
                    `без него дерево раннера не довериться, и кодер-сессия молча потеряет ` +
                    `permissions.allow из .claude/settings.json (fail-closed).`,
            );
            return 'failed';
        }
        logFn(`🔐 ${configPath} ещё нет — создаю с доверием дереву раннера.`);
    }
    let parsed: unknown;
    if (raw !== null) {
        try {
            parsed = JSON.parse(raw);
        } catch (e: unknown) {
            failFn(
                `Глобальный конфиг Claude ${configPath} не разбирается как JSON: ` +
                    `${(e as Error).message}. Чинить руками — переписывать битый файл раннер ` +
                    `не станет (снесло бы аккаунт и настройки человека).`,
            );
            return 'failed';
        }
    }
    let next: { config: Record<string, unknown>; added: string[] };
    try {
        next = withTrustedWorkspaces(parsed, targets);
    } catch (e: unknown) {
        failFn(`Не могу внести дерево раннера в доверенные: ${(e as Error).message}.`);
        return 'failed';
    }
    if (next.added.length === 0) {
        logFn(`🔐 Дерево раннера уже доверено (${targets.join(', ')}) — permissions.allow в силе.`);
        return 'already';
    }
    try {
        writeFileFn(configPath, `${JSON.stringify(next.config, null, 2)}\n`);
    } catch (e: unknown) {
        failFn(
            `Флаг доверия дереву раннера не записан в ${configPath}: ${(e as Error).message} — ` +
                `кодер-сессия работала бы без permissions.allow (fail-closed).`,
        );
        return 'failed';
    }
    logFn(`🔐 Дерево раннера внесено в доверенные (${next.added.join(', ')}) → ${configPath}`);
    return 'written';
}
