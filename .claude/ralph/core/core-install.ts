/**
 * Установка ревизии ядра вне репозитория потребителя и сверка её перед стартом (Фаза 12).
 *
 * Доставка сабмодулем отвергнута 26.10: gitlink не ловится маской защиты, и PR потребителя
 * мог поменять ядро вместе с проектом. Выбрана внешняя установка — ядро в
 * `<dataDir>/<sha>/` (по умолчанию `~/.local/share/ralph/<sha>/`), а в репозитории
 * потребителя только `.ralph/core.lock`. Имя не `ralph.lock`: оно занято файл-локом
 * процесса в `runtimeDir`.
 *
 * Защищает проверка, а не расположение, и у модуля три обязательства:
 *
 *   1. **Каталог ревизии появляется целиком или не появляется вовсе.** Ревизия
 *      чекаутом ложится во временный каталог РЯДОМ (та же ФС — иначе `rename` становится
 *      копированием, то есть ровно тем обрывом, от которого уходим) и переименовывается в
 *      `<sha>` последним шагом. Процесс, убитый до переименования, оставляет только
 *      `.<sha>.partial-<pid>-…`, который следующая установка снимает, если его владелец
 *      мёртв. Повторная установка той же ревизии — no-op: каталог `<sha>` по построению
 *      полный, а перезапись под живой петлёй подменила бы код у работающего Node.
 *   2. **Хэш дерева — от содержимого, а не от архива.** Манифест — отсортированные строки
 *      «вид, sha256, путь»; хэш дерева — sha256 текста манифеста (идея из второго мнения
 *      Kimi K3.1 Pro, `docs/roadmap/delivery-second-opinions.md`: хэш tar-архива зависел
 *      бы от времён и владельцев файлов). Манифест лежит в установке, а его хэш — в lock:
 *      правка файла ловится сверкой с манифестом, правка файла ВМЕСТЕ с манифестом —
 *      сверкой манифеста с lock. Поэтому отказ называет путь и ожидаемый хэш файла, а не
 *      только «дерево не то».
 *   3. **Lock с версией схемы читается fail-closed.** Версия сверяется ДО остальных
 *      полей: будущая схема вправе выглядеть иначе, и попытка прочитать её по правилам
 *      нынешней дала бы «повреждён» вместо честного «не знаю эту версию» — или, хуже,
 *      прочиталась бы частично.
 *
 * Чего модуль НЕ обещает, сказано вслух. Права «только чтение» на установку не ставятся:
 * их снимает тот же пользователь, которым идёт петля, и защитой они не были бы. Без fsync
 * переименованный каталог после потери питания может содержать усечённые файлы — это
 * ловит сверка перед стартом, а не установка. Команды launcher (`install`, `start`, …) —
 * отдельная карточка вехи; здесь примитивы, которыми они пользуются.
 *
 * TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { guardSideEffect } from '../shared/side-effect-guard.ts';
import { writeFileAtomic } from './roots.ts';
import { stripGitContext } from './consumer-tree.ts';
import { gitNetworkOpts } from '../shared/ralph-util.ts';
import { COMPAT_LAYERS, supportedVersions, type TCompatVersions } from './compat.ts';

/** Версия схемы `.ralph/core.lock`, которую знает этот раннер. */
export const CORE_LOCK_SCHEMA = 1;
/** Путь lock от корня потребителя. */
export const CORE_LOCK_PATH = join('.ralph', 'core.lock');
/** Манифест установки — в корне каталога ревизии; в хэш дерева сам не входит. */
export const INSTALL_MANIFEST = '.ralph-manifest';
// Полный SHA объекта git: sha1 (40) или sha256 (64). Сокращённый не годится — он
// неоднозначен по построению, а имя каталога из него стало бы путём, по которому две
// ревизии могли бы совпасть. Заодно форма отсекает `..` и `/` в имени каталога.
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TREE_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const PARTIAL_RE = /^\.([0-9a-f]+)\.partial-(\d+)-[0-9a-f]+$/;

/** Версии пяти слоёв, на которых говорит установленная ревизия (`compat.ts`, #37). */
export type TCoreVersions = TCompatVersions;

export type TCoreLock = {
    schema: typeof CORE_LOCK_SCHEMA;
    sha: string;
    treeHash: string;
    versions: TCoreVersions;
};

/** Версии ЭТОЙ ревизии ядра — то, что launcher пишет в lock при установке. */
export function currentCoreVersions(): TCoreVersions {
    return supportedVersions();
}

export function isFullSha(sha: string): boolean {
    return SHA_RE.test(sha);
}

/**
 * Каталог установок. Окружение приходит параметром, а не читается здесь: домашний каталог
 * — адрес машины, и модуль ядра, дотянувшийся до него сам, был бы якорем наружу
 * (`tests/outside-deps.test.ts`). Порядок — явная переменная, затем XDG, затем `HOME`;
 * относительный путь в любой из них — отказ: база у него — место запуска, а у launcher и
 * петли оно разное, и две установки разъехались бы молча.
 */
export function resolveDataDir(env: Record<string, string | undefined>): string {
    const pick = (name: string, value: string | undefined, suffix: string[]): string | null => {
        if (value === undefined || value === '') return null;
        if (!isAbsolute(value)) {
            throw new Error(
                `${name}=${value} не абсолютный путь: каталог установок ядра не задан.`,
            );
        }
        return join(value, ...suffix);
    };
    const dir =
        pick('RALPH_DATA_DIR', env.RALPH_DATA_DIR, []) ??
        pick('XDG_DATA_HOME', env.XDG_DATA_HOME, ['ralph']) ??
        pick('HOME', env.HOME, ['.local', 'share', 'ralph']);
    if (dir === null) {
        throw new Error(
            'Каталог установок ядра не задан: нет ни RALPH_DATA_DIR, ни XDG_DATA_HOME, ни HOME.',
        );
    }
    return dir;
}

// ── Манифест и хэш дерева ────────────────────────────────────────────────────

export type TManifestKind = 'file' | 'exec' | 'link';
export type TManifestEntry = { kind: TManifestKind; sha256: string; path: string };

/** Чтения дерева. Чтение побочкой не является: путь приходит параметром, а не из живого дерева. */
export type TTreeReadFs = {
    readdir: (dir: string) => string[];
    lstat: (p: string) => {
        isDirectory(): boolean;
        isFile(): boolean;
        isSymbolicLink(): boolean;
        mode: number;
    };
    readFile: (p: string) => Buffer;
    readlink: (p: string) => string;
};

const realReadFs: TTreeReadFs = {
    readdir: (dir) => readdirSync(dir),
    lstat: (p) => lstatSync(p),
    readFile: (p) => readFileSync(p),
    readlink: (p) => readlinkSync(p),
};

function sha256(data: string | Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

/**
 * Опись дерева: каждый файл и ссылка, отсортированные по пути. Каталоги в опись не входят
 * (как у git: пустой каталог содержимым не считается). Ссылка хэшируется по цели, а не по
 * тому, куда она ведёт: переход по ней вывел бы опись за пределы установки. Всё прочее
 * (fifo, сокет, устройство) — отказ: в ревизии ядра такому взяться неоткуда.
 */
export function buildManifest(root: string, fsr: TTreeReadFs = realReadFs): TManifestEntry[] {
    const out: TManifestEntry[] = [];
    const walk = (rel: string): void => {
        const abs = rel === '' ? root : join(root, rel);
        for (const name of fsr.readdir(abs).sort()) {
            const childRel = rel === '' ? name : `${rel}/${name}`;
            // Манифест в опись не входит сам, `.git` — репозиторий, которым установка
            // доказывает хукам свою ревизию (`gitCheckoutExport`), а не дерево ревизии.
            if (childRel === INSTALL_MANIFEST || childRel === '.git') continue;
            // Перевод строки в имени сломал бы построчный манифест: строка разобралась бы
            // в две записи, и правка одного файла читалась бы как два чужих.
            if (/[\n\r]/.test(name))
                throw new Error(
                    `Имя с переводом строки в дереве ревизии: ${JSON.stringify(childRel)}`,
                );
            const childAbs = join(root, childRel);
            const st = fsr.lstat(childAbs);
            if (st.isSymbolicLink()) {
                out.push({ kind: 'link', sha256: sha256(fsr.readlink(childAbs)), path: childRel });
            } else if (st.isDirectory()) {
                walk(childRel);
            } else if (st.isFile()) {
                const kind: TManifestKind = (st.mode & 0o111) !== 0 ? 'exec' : 'file';
                out.push({ kind, sha256: sha256(fsr.readFile(childAbs)), path: childRel });
            } else {
                throw new Error(`Не файл, не каталог и не ссылка в дереве ревизии: ${childRel}`);
            }
        }
    };
    walk('');
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function formatManifest(entries: readonly TManifestEntry[]): string {
    return entries.map((e) => `${e.kind} ${e.sha256} ${e.path}\n`).join('');
}

/** Хэш дерева — sha256 текста манифеста. Один источник формы и для установки, и для lock. */
export function treeHashOf(manifestText: string): string {
    return `sha256:${sha256(manifestText)}`;
}

export function parseManifest(text: string): TManifestEntry[] {
    const lines = text.split('\n');
    if (lines.pop() !== '') throw new Error('манифест не кончается переводом строки — усечён');
    return lines.map((line, i) => {
        const m = /^(file|exec|link) ([0-9a-f]{64}) (.+)$/.exec(line);
        if (!m)
            throw new Error(
                `строка ${String(i + 1)} манифеста не разбирается: ${JSON.stringify(line)}`,
            );
        return { kind: m[1] as TManifestKind, sha256: m[2], path: m[3] };
    });
}

// ── Lock ─────────────────────────────────────────────────────────────────────

export type TParseLock = { ok: true; lock: TCoreLock } | { ok: false; reason: string };

function isPositiveInt(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Разбор `.ralph/core.lock`. Схема сверяется первой и точным равенством: версия выше
 * нашей — отказ «не знаю», а не чтение по нынешним правилам. Незнакомый ключ — тоже отказ:
 * lock решает, какой код исполнится, и поле, которого раннер не понял, могло значить
 * для автора больше, чем для читателя.
 */
export function parseCoreLock(text: string): TParseLock {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        return { ok: false, reason: `не JSON (${(e as Error).message})` };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { ok: false, reason: 'не объект JSON' };
    }
    const o = raw as Record<string, unknown>;
    if (o.schema !== CORE_LOCK_SCHEMA) {
        return {
            ok: false,
            reason:
                `версия схемы ${JSON.stringify(o.schema)} неизвестна этому раннеру (знает ${String(CORE_LOCK_SCHEMA)}); ` +
                'lock не читается дальше — обнови launcher или верни lock прежней схемы',
        };
    }
    const unknownKeys = Object.keys(o).filter(
        (k) => !['schema', 'sha', 'treeHash', 'versions'].includes(k),
    );
    if (unknownKeys.length > 0)
        return { ok: false, reason: `незнакомые ключи: ${unknownKeys.join(', ')}` };
    if (typeof o.sha !== 'string' || !isFullSha(o.sha)) {
        return { ok: false, reason: `sha не полный SHA ревизии (${JSON.stringify(o.sha)})` };
    }
    if (typeof o.treeHash !== 'string' || !TREE_HASH_RE.test(o.treeHash)) {
        return {
            ok: false,
            reason: `treeHash не вида sha256:<64 hex> (${JSON.stringify(o.treeHash)})`,
        };
    }
    const v = parseCoreVersions(o.versions);
    if (!v.ok) return v;
    return {
        ok: true,
        lock: { schema: CORE_LOCK_SCHEMA, sha: o.sha, treeHash: o.treeHash, versions: v.versions },
    };
}

export type TParseVersions = { ok: true; versions: TCoreVersions } | { ok: false; reason: string };

/**
 * Версии слоёв — ровно `COMPAT_LAYERS`, каждая целое положительное. Та же проверка стоит
 * и на ответе ревизии при первой установке, ДО записи lock: ревизия, назвавшая другой
 * набор слоёв, оставила бы lock, который `parseCoreLock` потом отвергнет, а битый lock
 * install не перезаписывает — установка сама загнала бы себя в тупик.
 */
export function parseCoreVersions(v: unknown): TParseVersions {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
        return { ok: false, reason: 'versions не объект' };
    const vv = v as Record<string, unknown>;
    const vKeys = Object.keys(vv).sort().join(',');
    if (vKeys !== [...COMPAT_LAYERS].sort().join(',')) {
        return {
            ok: false,
            reason: `versions обязаны быть ровно ${COMPAT_LAYERS.join(', ')} (найдено: ${vKeys || 'пусто'})`,
        };
    }
    for (const k of COMPAT_LAYERS) {
        if (!isPositiveInt(vv[k]))
            return {
                ok: false,
                reason: `versions.${k} не целое положительное (${JSON.stringify(vv[k])})`,
            };
    }
    return {
        ok: true,
        versions: Object.fromEntries(
            COMPAT_LAYERS.map((k) => [k, vv[k] as number]),
        ) as TCoreVersions,
    };
}

export function formatCoreLock(lock: TCoreLock): string {
    return `${JSON.stringify(lock, null, 2)}\n`;
}

export type TReadLock =
    { ok: true; lock: TCoreLock; path: string } | { ok: false; reason: string; path: string };

/** Чтение lock из дерева потребителя. Нет файла — отказ с адресом, а не «ядро любое». */
export function readCoreLock(
    consumerRoot: string,
    readFn: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): TReadLock {
    const path = join(consumerRoot, CORE_LOCK_PATH);
    let text: string;
    try {
        text = readFn(path);
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        return {
            ok: false,
            path,
            reason:
                code === 'ENOENT'
                    ? `${path} нет`
                    : `${path} не читается (${code ?? (e as Error).message})`,
        };
    }
    const r = parseCoreLock(text);
    return r.ok
        ? { ok: true, lock: r.lock, path }
        : { ok: false, path, reason: `${path}: ${r.reason}` };
}

export type TLockWriteFs = {
    mkdir: (dir: string) => void;
    writeAtomic: (p: string, text: string) => void;
};

const realLockWriteFs: TLockWriteFs = {
    mkdir: (dir) => {
        guardSideEffect(`mkdir(${dir})`, 'Подмени fs записи lock в тесте.');
        mkdirSync(dir, { recursive: true });
    },
    writeAtomic: (p, text) => writeFileAtomic(p, text),
};

/** Запись lock целиком или никак — тем же приёмом, что state (`writeFileAtomic`). */
export function writeCoreLock(
    consumerRoot: string,
    lock: TCoreLock,
    fsw: TLockWriteFs = realLockWriteFs,
): string {
    const path = join(consumerRoot, CORE_LOCK_PATH);
    fsw.mkdir(join(consumerRoot, '.ralph'));
    fsw.writeAtomic(path, formatCoreLock(lock));
    return path;
}

// ── Установка ────────────────────────────────────────────────────────────────

/** Кладёт дерево ревизии `sha` в пустой каталог `dest`. */
export type TExportFn = (sha: string, dest: string) => void;

export type TInstallFs = TTreeReadFs & {
    exists: (p: string) => boolean;
    mkdir: (dir: string) => void;
    writeFile: (p: string, text: string) => void;
    rename: (from: string, to: string) => void;
    rm: (p: string) => void;
};

const HINT = 'Подмени fs установки в тесте.';

export const realInstallFs: TInstallFs = {
    ...realReadFs,
    exists: (p) => existsSync(p),
    mkdir: (dir) => {
        guardSideEffect(`mkdir(${dir})`, HINT);
        mkdirSync(dir, { recursive: true });
    },
    writeFile: (p, text) => {
        guardSideEffect(`writeFile(${p})`, HINT);
        writeFileSync(p, text, { flag: 'wx' });
    },
    rename: (from, to) => {
        guardSideEffect(`rename(${to})`, HINT);
        renameSync(from, to);
    },
    rm: (p) => {
        guardSideEffect(`rm(${p})`, HINT);
        rmSync(p, { recursive: true, force: true });
    },
};

/**
 * Источник по умолчанию — чекаут точного SHA из клона канона в СВОЙ git-репозиторий
 * каталога ревизии. Никакого отката на ветку или «последнюю»: SHA, которого нет в
 * источнике, — отказ git, а не подстановка соседней ревизии.
 *
 * Почему репозиторий, а не распакованный `git archive` (ревью Фазы 12). Хуки установки
 * сверяют себя с ревизией `RALPH_CORE_SHA` через `git ls-tree` своего каталога
 * (`core-revision.cjs`), и старт с `roots` требует, чтобы ядро было git-репозиторием с
 * корнем в `productRoot` (`resolveCoreSha`). Распакованный архив не был ни тем, ни другим:
 * ядро, поставленное launcher'ом, не стартовало ни живым прогоном, ни `--dry-run`. Каталог
 * `.git` в манифест не входит (`buildManifest`): манифест описывает дерево ревизии, а не
 * объекты, которыми git его доказывает.
 *
 * Атрибуты источника на чекаут не действуют: `.git/info/attributes` старше `.gitattributes`
 * дерева и снимает с каждого пути `text`, `eol`, `filter`, `ident` и перекодировку. Иначе
 * файл на диске разошёлся бы с блобом ревизии, и хуки сверки блокировали бы каждый вызов, а
 * `export-ignore` архива выкидывал бы из установки пути, которые в ревизии есть.
 */
export type TCheckoutDeps = {
    spawnFn: (
        file: string,
        args: string[],
        opts: { encoding: 'utf8'; env: NodeJS.ProcessEnv; timeout?: number; maxBuffer: number },
    ) => { status: number | null; stdout: string; stderr: string; error?: Error };
    writeFileFn: (p: string, text: string) => void;
};

/** Запись с созданием каталога: `.git/info` без шаблона init не существует. */
export function writeFileWithDir(p: string, text: string): void {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
}

export function gitCheckoutExport(sourceRepo: string, deps?: TCheckoutDeps): TExportFn {
    return (sha, dest) => {
        // Предохранитель — у боевых коллабораторов; подменённые в тесте ничего не трогают.
        if (deps === undefined) guardSideEffect(`git checkout ${sha}`, 'Подмени exportFn в тесте.');
        const { spawnFn, writeFileFn } = deps ?? {
            spawnFn: (file, args, opts) => spawnSync(file, args, opts),
            writeFileFn: writeFileWithDir,
        };
        // `GIT_DIR` и родня сильнее `-C`: унаследованные, они увели бы чекаут в чужой
        // репозиторий. Хуки источника и человека в каталог ревизии не исполняются.
        const env = stripGitContext(process.env);
        const git = (
            args: string[],
            run: { env: NodeJS.ProcessEnv; timeoutMs?: number } = { env },
        ): string => {
            const r = spawnFn(
                'git',
                [
                    '-C',
                    dest,
                    '-c',
                    'core.hooksPath=/dev/null',
                    '-c',
                    'core.autocrlf=false',
                    ...args,
                ],
                {
                    encoding: 'utf8',
                    env: run.env,
                    timeout: run.timeoutMs,
                    maxBuffer: 64 * 1024 * 1024,
                },
            );
            if (r.status !== 0) {
                throw new Error(
                    `git ${args.join(' ')} в ${dest} (источник ${sourceRepo}) не отработал: ${(r.stderr || String(r.error ?? '')).trim()}`,
                );
            }
            return r.stdout.trim();
        };
        // Шаблон init отключён явно: `info/` git создаёт только из шаблона, а `init.templateDir`
        // человека на пустой каталог оставлял `.git` без `info/`, и запись атрибутов падала
        // ENOENT (ревью Фазы 12). Без шаблона раскладка `.git` одна на любой машине, а каталог
        // под атрибуты создаёт запись сама.
        git(['init', '-q', '--template=']);
        writeFileFn(
            join(dest, '.git', 'info', 'attributes'),
            '* -text -eol -filter -ident -working-tree-encoding\n',
        );
        // Источник — обычно локальный клон, но адрес волен быть и сетевым: запрет промпта
        // кредов и срок — как у каждого сетевого git ядра (задача 30).
        const gitNetwork = (args: string[]): string => git(args, gitNetworkOpts(env));
        gitNetwork(['fetch', '-q', '--no-tags', '--no-write-fetch-head', sourceRepo, sha]);
        git(['-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', sha]);
        const head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
        if (head !== sha) throw new Error(`чекаут в ${dest} встал на ${head}, а не на ${sha}`);
    };
}

export type TInstallOpts = {
    sha: string;
    dataDir: string;
    exportFn: TExportFn;
    /** Хэш из lock: дерево, разошедшееся с ним, не переименовывается в `<sha>`. */
    expectedTreeHash?: string;
    fs?: TInstallFs;
    pid?: number;
    isAliveFn?: (pid: number) => boolean;
    logFn?: (line: string) => void;
};

export type TInstallResult = { status: 'installed' | 'present'; dir: string; treeHash: string };

/**
 * Номер занят. EPERM — процесс есть, но чужого пользователя: он жив. Решения поверх этого
 * («его каталог не снимаем», «это не наш раннер») принимает вызывающий, а не сигнал.
 */
export function pidAlive(
    pid: number,
    killFn: (pid: number, sig: 0) => unknown = (p, sig) => process.kill(p, sig),
): boolean {
    try {
        killFn(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * Ревизия живого раннера из этого каталога установок: номер занят и в argv процесса есть
 * элемент, равный `<dataDir>/<полный SHA>/ralph.js`; иначе `null`. Подстрока «ralph.js»
 * здесь не годится: при pid-reuse за живую петлю сошли бы `vim ralph.js` или тест — а
 * `./ralph stop` положил бы запрос, который остановит следующий старт. Так же сверяет путь
 * entry и ядро (`lockAlive`, `PRODUCT.entries`); `/proc` не читается — «не наш».
 *
 * Возвращается именно ревизия, а не «совпал ли entry из lock» (#136): lock лежит в дереве
 * потребителя под git, и `git pull`, сменивший в нём `sha`, не трогает петлю, идущую на
 * прежней ревизии. Сверка с entry ТЕКУЩЕГО lock назвала бы такую петлю брошенной.
 */
export function runnerRevision(
    pid: number,
    dataDir: string,
    deps: {
        killFn?: (pid: number, sig: 0) => unknown;
        readFn?: (p: string) => string;
    } = {},
): string | null {
    if (!pidAlive(pid, deps.killFn)) return null;
    const read = deps.readFn ?? ((p: string) => readFileSync(p, 'utf8'));
    let argv: string[];
    try {
        argv = read(`/proc/${String(pid)}/cmdline`).split('\0');
    } catch {
        return null;
    }
    for (const arg of argv) {
        const sha = basename(dirname(arg));
        if (SHA_RE.test(sha) && arg === join(dataDir, sha, 'ralph.js')) return sha;
    }
    return null;
}

const isAlive = (pid: number): boolean => pidAlive(pid);

function installedTreeHash(dir: string, fsi: TInstallFs): string {
    const p = join(dir, INSTALL_MANIFEST);
    let text: string;
    try {
        text = fsi.readFile(p).toString('utf8');
    } catch (e) {
        // Каталог `<sha>` лежит без манифеста: его удалили или каталог положили руками.
        // Голый ENOENT не говорил ни где, ни что делать.
        const code = (e as NodeJS.ErrnoException).code;
        throw new Error(
            `${dir} лежит, но манифест ${p} ${code === 'ENOENT' ? 'отсутствует' : `не читается (${code ?? (e as Error).message})`}: ` +
                'установка не доказывает своё дерево — убери каталог и поставь ревизию заново.',
        );
    }
    return treeHashOf(text);
}

export function installRevision(opts: TInstallOpts): TInstallResult {
    const fsi = opts.fs ?? realInstallFs;
    const pid = opts.pid ?? process.pid;
    const alive = opts.isAliveFn ?? isAlive;
    const log = opts.logFn ?? (() => {});
    const { sha, dataDir } = opts;
    if (!isFullSha(sha))
        throw new Error(
            `Ревизия ${JSON.stringify(sha)} не полный SHA: установка по нему неоднозначна.`,
        );
    if (!isAbsolute(dataDir)) throw new Error(`Каталог установок ${dataDir} не абсолютный.`);
    if (opts.expectedTreeHash !== undefined && !TREE_HASH_RE.test(opts.expectedTreeHash)) {
        throw new Error(`Ожидаемый хэш дерева ${opts.expectedTreeHash} не вида sha256:<64 hex>.`);
    }
    const target = join(dataDir, sha);
    if (fsi.exists(target)) {
        // No-op: `<sha>` появляется только переименованием готового дерева. Годность его
        // решает сверка перед стартом, а не повторная установка поверх.
        return { status: 'present', dir: target, treeHash: installedTreeHash(target, fsi) };
    }
    fsi.mkdir(dataDir);
    // Остатки прерванных установок ЛЮБОЙ ревизии с мёртвым владельцем: живость владельца
    // от ревизии не зависит, а остаток ревизии, которую больше не ставят, — полный чекаут с
    // `.git` — иначе лежал бы в каталоге установок навсегда. Живой владелец — соседняя
    // установка идёт прямо сейчас, и снять её каталог значило бы уронить её посреди.
    for (const name of fsi.readdir(dataDir)) {
        const m = PARTIAL_RE.exec(name);
        if (!m) continue;
        const owner = Number(m[2]);
        if (owner !== pid && alive(owner)) continue;
        log(`🧹 Остаток прерванной установки ${name} (владелец ${String(owner)} мёртв) — снимаю`);
        fsi.rm(join(dataDir, name));
    }
    const tmp = join(dataDir, `.${sha}.partial-${String(pid)}-${randomBytes(4).toString('hex')}`);
    fsi.mkdir(tmp);
    let renamed = false;
    try {
        opts.exportFn(sha, tmp);
        const manifest = formatManifest(buildManifest(tmp, fsi));
        const treeHash = treeHashOf(manifest);
        if (opts.expectedTreeHash !== undefined && treeHash !== opts.expectedTreeHash) {
            throw new Error(
                `Дерево ревизии ${sha} не совпало с lock: ожидался ${opts.expectedTreeHash}, получен ${treeHash}. ` +
                    'Источник отдал не ту ревизию — в установку она не идёт.',
            );
        }
        fsi.writeFile(join(tmp, INSTALL_MANIFEST), manifest);
        try {
            fsi.rename(tmp, target);
            renamed = true;
        } catch (e) {
            // Соседняя установка той же ревизии успела раньше: её дерево полное по тому же
            // построению, наше лишнее.
            if (fsi.exists(target))
                return { status: 'present', dir: target, treeHash: installedTreeHash(target, fsi) };
            throw e;
        }
        return { status: 'installed', dir: target, treeHash };
    } finally {
        if (!renamed) fsi.rm(tmp);
    }
}

// ── Сверка перед стартом ─────────────────────────────────────────────────────

export type TVerify = { ok: true } | { ok: false; reason: string };

const MAX_LISTED = 5;

/**
 * Дерево установки против lock: сначала манифест против `treeHash`, затем каждый файл
 * против манифеста. Отказ перечисляет расхождения поимённо (до пяти и счёт остальных) —
 * «дерево не совпало» без пути отправило бы человека сравнивать сотни файлов руками.
 */
export function verifyInstalledTree(
    dir: string,
    lock: Pick<TCoreLock, 'treeHash'>,
    fsr: TTreeReadFs = realReadFs,
): TVerify {
    let manifestText: string;
    try {
        manifestText = fsr.readFile(join(dir, INSTALL_MANIFEST)).toString('utf8');
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        return {
            ok: false,
            reason: `${join(dir, INSTALL_MANIFEST)} ${code === 'ENOENT' ? 'нет' : `не читается (${code ?? (e as Error).message})`} — установка не доказывает своё дерево`,
        };
    }
    const found = treeHashOf(manifestText);
    if (found !== lock.treeHash) {
        return {
            ok: false,
            reason: `манифест установки ${dir} не совпал с lock: ожидался ${lock.treeHash}, найден ${found}`,
        };
    }
    let expected: TManifestEntry[];
    let actual: TManifestEntry[];
    try {
        expected = parseManifest(manifestText);
        actual = buildManifest(dir, fsr);
    } catch (e) {
        return {
            ok: false,
            reason: `дерево установки ${dir} не описывается: ${(e as Error).message}`,
        };
    }
    const want = new Map(expected.map((e) => [e.path, e]));
    const have = new Map(actual.map((e) => [e.path, e]));
    const diffs: string[] = [];
    for (const e of expected) {
        const a = have.get(e.path);
        if (!a) diffs.push(`${e.path}: файла нет, ожидался sha256 ${e.sha256}`);
        else if (a.sha256 !== e.sha256)
            diffs.push(`${e.path}: изменён — ожидался sha256 ${e.sha256}, найден ${a.sha256}`);
        else if (a.kind !== e.kind)
            diffs.push(`${e.path}: вид ${a.kind} вместо ${e.kind} (sha256 ${e.sha256})`);
    }
    for (const a of actual)
        if (!want.has(a.path)) diffs.push(`${a.path}: лишний файл (sha256 ${a.sha256})`);
    if (diffs.length === 0) return { ok: true };
    const rest = diffs.length > MAX_LISTED ? `; и ещё ${String(diffs.length - MAX_LISTED)}` : '';
    return {
        ok: false,
        reason: `дерево ${dir} разошлось с манифестом: ${diffs.slice(0, MAX_LISTED).join('; ')}${rest}`,
    };
}

export type TStartCheck =
    | { status: 'ok'; sha: string; dir: string; lock: TCoreLock; lockPath: string }
    | { status: 'not-installed'; dir: string }
    | { status: 'refused'; reason: string };

/**
 * Сверка перед стартом петли. Ядро, исполняемое из установки (в его корне лежит манифест
 * или оно лежит в каталоге установок под именем полного SHA), обязано совпасть с lock
 * потребителя: ревизия — по имени каталога, дерево — по хэшу. Ядро на месте установки без
 * манифеста — отказ, а не клон (`installPlaceOf`). Ядро без манифеста в другом месте —
 * клон канона или прежняя раскладка, и lock к нему не относится: это исход
 * `not-installed`, его вызывающий называет вслух, а не молчит.
 *
 * Lock отсутствует при ядре из установки — отказ: «нет записи, какое ядро ждём» и есть
 * та самая неизвестность, ради которой lock заведён.
 */
export function checkCoreBeforeStart(
    productRoot: string,
    consumerRoot: string | null,
    deps: {
        fsr?: TTreeReadFs;
        exists?: (p: string) => boolean;
        readFn?: (p: string) => string;
        /** Окружение для каталога установок: ядро на его месте — установка и без манифеста. */
        env?: Record<string, string | undefined>;
        realpathFn?: (p: string) => string;
    } = {},
): TStartCheck {
    const exists = deps.exists ?? existsSync;
    if (!exists(join(productRoot, INSTALL_MANIFEST))) {
        const place = installPlaceOf(productRoot, deps.env, deps.realpathFn);
        if (place !== null) {
            return {
                status: 'refused',
                reason:
                    `ядро ${productRoot} лежит в каталоге установок ${place} под именем ревизии, ` +
                    `а манифеста ${INSTALL_MANIFEST} в нём нет — установка не доказывает своё ` +
                    'дерево; убери каталог и поставь ревизию заново: ./ralph install',
            };
        }
        return { status: 'not-installed', dir: productRoot };
    }
    if (consumerRoot === null) {
        return {
            status: 'refused',
            reason: `ядро исполняется из установки ${productRoot}, а секции roots в конфиге нет — lock потребителя искать негде`,
        };
    }
    const r = readCoreLock(consumerRoot, deps.readFn);
    if (!r.ok) return { status: 'refused', reason: r.reason };
    const running = basename(productRoot);
    if (running !== r.lock.sha) {
        return {
            status: 'refused',
            reason: `исполняется ревизия ${running}, а ${r.path} называет ${r.lock.sha} — запусти ядро той ревизии, что в lock`,
        };
    }
    const v = verifyInstalledTree(productRoot, r.lock, deps.fsr);
    if (!v.ok) return { status: 'refused', reason: v.reason };
    // Lock отдаётся дальше: из него контракт совместимости (#37) берёт ожидаемые версии
    // слоёв, и читать его второй раз значило бы сверять с другим чтением.
    return { status: 'ok', sha: r.lock.sha, dir: productRoot, lock: r.lock, lockPath: r.path };
}

/**
 * Каталог установок, если ядро лежит в нём под именем полного SHA, иначе `null`. Признак
 * «из установки» по одному манифесту снимался удалением манифеста: `checkCoreBeforeStart`
 * отдавал `not-installed`, и прямой `node <dataDir>/<sha>/ralph.js` стартовал правленое
 * дерево как клон, мимо сверки с lock (ревью Фазы 12). Место от манифеста не зависит.
 * Каталог установок не определяется (окружение не передано или в нём нет пути) — признака
 * по месту нет, остаётся манифест.
 */
export function installPlaceOf(
    productRoot: string,
    env: Record<string, string | undefined> | undefined,
    realpathFn: (p: string) => string = (p) => realpathSync(p),
): string | null {
    if (env === undefined || !isFullSha(basename(productRoot))) return null;
    let dataDir: string;
    try {
        dataDir = resolveDataDir(env);
    } catch {
        return null;
    }
    const canon = (p: string): string => {
        try {
            return realpathFn(p);
        } catch {
            return p;
        }
    };
    return canon(dirname(productRoot)) === canon(dataDir) ? dataDir : null;
}

/**
 * `roots.productRoot`, выведенный из lock: `<каталог установок>/<sha из .ralph/core.lock>`
 * (#134). Ключ в конфиге был второй копией SHA рядом с lock, и человек после `./ralph
 * install` вписывал путь руками — и снова руками на каждой смене ревизии, хотя смена
 * (`update`/`rollback`) меняет только lock. Теперь ключ необязателен: нет его — путь
 * выводится отсюда. Lock нет или он битый — отказ с причиной, а не догадка о каталоге:
 * без lock ядро не из установки, и где оно лежит, знает только конфиг.
 */
export function productRootFromLock(
    consumerRoot: string,
    deps: {
        readFn?: (p: string) => string;
        env?: Record<string, string | undefined>;
    } = {},
): { ok: true; path: string } | { ok: false; reason: string } {
    // Боевой дефолт резолва конфига: тест с `roots` без `productRoot`, забывший подать
    // `lockRootFn`, иначе молча читал бы живой lock и окружение машины (ревью Фазы 13).
    if (deps.readFn === undefined || deps.env === undefined) {
        guardSideEffect(
            `productRootFromLock(${consumerRoot})`,
            'Подай lockRootFn резолву конфига или readFn и env сюда.',
        );
    }
    const r = readCoreLock(consumerRoot, deps.readFn);
    if (!r.ok) return { ok: false, reason: r.reason };
    try {
        return { ok: true, path: join(resolveDataDir(deps.env ?? process.env), r.lock.sha) };
    } catch (e) {
        return { ok: false, reason: (e as Error).message };
    }
}

/**
 * `roots.productRoot` против каталога ядра, которое исполняется. Заданный в конфиге ключ
 * при ядре из установки — вторая копия SHA рядом с lock, и при смене ревизии она
 * расходилась с ним молча: lock и исполняемое ядро сверены, а проверка пересечений корней
 * (`roots.ts`) шла по устаревшему пути. Выведенный из lock путь (`from: 'lock'`) тоже
 * сверяется: ядро, запущенное не из того каталога установок, иначе работало бы с корнями
 * чужой раскладки. Отказ называет обе стороны и не выбирает ни одну молча. Сравнение — по
 * каноническим путям: симлинк на каталог установок расхождением не считается.
 */
export function productRootMismatch(
    configured: string,
    running: string,
    realpathFn: (p: string) => string = (p) => realpathSync(p),
    from: 'config' | 'lock' = 'config',
): string | null {
    const canon = (p: string): string => {
        try {
            return realpathFn(p);
        } catch {
            return p;
        }
    };
    if (canon(configured) === canon(running)) return null;
    if (from === 'lock') {
        return (
            `roots.productRoot выведен из ${CORE_LOCK_PATH} — ${configured}, а исполняется ядро ` +
            `${running}: запусти ядро ревизии из lock (./ralph start) или задай roots.productRoot явно`
        );
    }
    return (
        `roots.productRoot конфига — ${configured}, а исполняется ядро ${running}: ` +
        'убери ключ (launcher выводит его из lock) или поправь на каталог ревизии из lock'
    );
}

/** Строка лога о сверке: у каждого исхода своя, молчания нет ни у одного. */
export function describeStartCheck(check: TStartCheck): string {
    if (check.status === 'ok') return `🔐 Ядро ${check.sha} сверено с lock: дерево совпало`;
    if (check.status === 'not-installed') {
        return `🔐 Ядро не из установки (${check.dir}) — сверка с lock не применяется`;
    }
    return `🔐 Старт отвергнут сверкой ядра с lock: ${check.reason}`;
}
