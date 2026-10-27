// Ralph monitor — ЛОГИКА панели прогресса AFK-цикла (#404, фаза 8 «Дотипизация оболочки»).
//
// Вынесено из runtime/monitor.js: entry (`monitor.js`) остаётся тонким JS, запускаемым
// напрямую (проверка Node ≥24 до первого require('*.mts')); вся логика — чтение лога,
// сводка, вопросы к трекеру, детект тишины и дедуп пуша — живёт здесь и покрыта
// monitor-panel.test.mts. Место entry в ядре (`runtime/monitor.js`) НЕ меняется: на него
// опираются RUNBOOK и tmux-раскладка, а раннер спавнит его по абсолютному пути от каталога
// ядра (задача 122) — в раскладке с `roots` `.claude/ralph/…` от места запуска указывал бы
// в дерево работы, где ядра нет.
//
// Каждые N секунд (по умолчанию 300 = 5 минут) main() печатает сводку:
//   - жив ли loop (по свежести ralph.log)
//   - текущая фаза / submitted (из ralph.state.json)
//   - сколько задач фазы ещё открыто (шов taskSource, #58)
//   - открытый PR текущей фазы (шов taskSource, по ветке из конфига #214)
//   - последние значимые строки ralph.log (маркеры фаз/итераций/ревью/мерджа)
// и раз в сутки шлёт строку метрики продукта (maybePushDailyMetric).
//
// Только чтение: два чтения шва + чтение файлов. Ничего не мутирует (инвариант №12: монитор
// не пишет в ralph.log — свежесть этого файла и есть признак жизни раннера).
//
// ── Почему трекер — через шов (#58) ──
// Панель звала CLI GitHub напрямую, мимо шва, которым пользуется сама петля. На площадке,
// где этого CLI нет вовсе, она поднималась живой и показывала ветку и хвост лога, а две
// строки из четырёх — ровно «сколько задач осталось» и «есть ли PR» — пустыми. Хуже того,
// сбой спроса на панели был неотличим от честного «PR нет». Теперь она спрашивает шов,
// выбранный тем же `config.adapters`, что у петли (`observerTaskSource` раннера), и у
// каждого вопроса три различимых исхода: ответ, «ответ — ничего» и «спросить не удалось».
// Шов здесь — только читающие методы (`PanelTaskSource`): монитор остаётся наблюдателем.
//
// ── Почему .mts (а не .ts), и почему import.meta.dirname (#404, по образцу gate-env.mts/#403) ──
// Панель берёт ralph.log/state/config ОТ КАТАЛОГА МОДУЛЯ — потому монитор и запускают из
// дерева раннера, иначе он читал бы лог launch-дерева и показывал чужую картину (ровно это
// выглядело как «панель со старыми событиями» 29.07). Под нативным type stripping Node
// TS-модуль с `export` исполняется как ESM, где `__dirname` не существует (проверено:
// require('*.ts') с export → `__dirname is not defined`). Каталог модуля в ESM даёт
// `import.meta.dirname`, но в обычном `.ts` под nodenext-CommonJS это жёсткая ошибка
// TS1470. Снимает тупик ровно `.mts`: это ЯВНО-ESM и для TS (import.meta.dirname легален),
// и для рантайма (модуль грузится как ESM, import.meta.dirname = каталог, ОТКУДА ЗАГРУЖЕН
// модуль). monitor.js берёт его через require(esm) (Node 24), провенанс сохранён.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// Резолв профилей (#71) и примитивы петли — единый источник правды с раннером, чтобы
// монитор не завёл вторую копию правил мерджа. ralph.js — JS-entry без деклараций типов,
// поэтому default-импорт с деструктуризацией (ESM не читает именованные экспорты из CJS
// в sync-пути require(esm)); @ts-expect-error — как в config-profile.test.ts (#366).
// @ts-expect-error — JS-entry раннера без деклараций типов.
import ralph from '../ralph.js';
import type { Issue, PullRequest, TaskSourceAdapter } from '../adapters/adapters.ts';
import type { AdapterConfig } from '../adapters/adapters-impl.ts';
// ralph.js — module.exports = createOrchestrator(...), поэтому его поверхность точно
// описывается ReturnType<typeof createOrchestrator> (#409-ревью). Тем же кастом, что в
// test-helpers.ts, типизируем три функции боевыми типами вместо `any` из ts-expect-error-
// импорта. resolveProfile/parseProfileFlag боевым типом возвращают unknown (конфиг
// недоверенный) — сужение остаётся по месту (см. `as ResolvedConfig` в snapshot()).
type Runtime = ReturnType<typeof import('../core/orchestrator.ts').createOrchestrator>;
const resolveProfile = ralph.resolveProfile as Runtime['resolveProfile'];
const parseProfileFlag = ralph.parseProfileFlag as Runtime['parseProfileFlag'];
const observerTaskSource = ralph.observerTaskSource as Runtime['observerTaskSource'];
// #386: та же чистая функция разводки лога, что и у раннера (exec.ts) — панель обязана
// читать РОВНО тот файл, в который пишет наблюдаемый прогон, иначе судила бы о жизни по
// чужому/протухшему логу (см. monitorLogPath ниже).
const chooseLogPath = ralph.chooseLogPath as Runtime['chooseLogPath'];
// pushEvent СОЗНАТЕЛЬНО остаётся нетипизированным: боевой тип (msg, cfg?: RalphConfig, opts)
// не присваивается локальному PushFn — у панели cfg: ResolvedConfig nullable и частичный
// (конфиг читается мягко), а строгий каст покраснил бы default `pushFn = pushEvent` в
// maybePushDeadman. Тот же осознанный отказ, что у поверхности в orchestrator.test.ts, но по
// конкретной причине — трение строгого типа pushEvent с nullable cfg панели.
const { pushEvent } = ralph;
// Пороги тишины (#147): классификация хвоста лога по режиму + порог по режиму. Здесь
// (в мониторе) — импёровая половина: чтение файла, «сейчас» и сравнение с порогом.
import { classifyActivity, silenceThresholdMs, type Activity } from './deadman.ts';
import { companionPaths, decodeHeartbeat, type THeartbeat } from '../core/event-journal.ts';
import { formatStopMessage } from '../core/stop-message.ts';
import { submittedOf, type TSubmitRecord } from '../core/submit-journal.ts';
import { formatMetricDayLine } from './product-metric.ts';
import { summarizeRuntime } from './metric.mts';
import { evalDisk, freeBytes, maybePushDiskLow } from './disk-watch.ts';
import { resolveObservability } from '../core/observability.ts';

// Каталог ядра — родитель import.meta.dirname (модуль лежит в `runtime/`). От него берутся
// только умолчания прежней раскладки: служебные файлы рядом с ядром, если раннер не назвал
// каталог состояния флагом. Дерево РАБОТЫ отсюда не выводится вовсе — см. resolveExecutionRoot.
const RALPH_DIR = path.resolve(import.meta.dirname, '..');

// --runtime-dir <путь> (канон, задача 22): каталог СОСТОЯНИЯ наблюдаемого экземпляра.
// Раннер прокидывает его при авто-спавне, когда состояние уехало из каталога ядра. Без
// флага — прежняя раскладка, файлы рядом с ядром.
//
// Разбирается ДО путей ниже намеренно: панель, читающая не тот каталог, не падает — она
// показывает пустую фазу и «раннер молчит», то есть врёт ровно в ту сторону, ради которой
// её и смотрят. Молчаливая слепота дороже отсутствия панели.
export function resolveRuntimeDir(args: string[], fallback: string): string {
    const idx = args.indexOf('--runtime-dir');
    if (idx === -1) return fallback;
    if (args.indexOf('--runtime-dir', idx + 1) !== -1) {
        throw new Error('--runtime-dir передан дважды: какой из них наблюдать — не догадка.');
    }
    const value = args[idx + 1];
    // Значения нет либо следом идёт другой флаг: без проверки панель молча взяла бы «--once»
    // за путь или откатилась к прежней раскладке — и в обоих случаях показывала бы пустоту
    // как «раннер молчит» (ревью !19). Наблюдатель, который врёт, хуже отсутствующего.
    if (!value || value.startsWith('--')) {
        throw new Error('--runtime-dir без значения: панели нечего наблюдать.');
    }
    if (!path.isAbsolute(value)) {
        throw new Error(
            `--runtime-dir ${value} относительный: он резолвился бы от места запуска панели, ` +
                'а она стартует из другого каталога, чем раннер.',
        );
    }
    return value;
}

const RUNTIME_DIR = resolveRuntimeDir(process.argv.slice(2), RALPH_DIR);

// #386: раннер разводит боевой ralph.log и не-боевой ralph.dry.log (chooseLogPath, exec.ts).
// Панель выбирает между ними тем же кодом — см. monitorLogPath. LOG_PATH (боевой) остаётся
// дефолтом readLogTail для ручных вызовов/тестов; snapshot() переопределяет его по профилю.
const LOG_PATH_BATTLE = path.join(RUNTIME_DIR, 'ralph.log');
const LOG_PATH_SIDELINE = path.join(RUNTIME_DIR, 'ralph.dry.log');
const LOG_PATH = LOG_PATH_BATTLE;
const STATE_PATH = path.join(RUNTIME_DIR, 'ralph.state.json');

// #386: путь лога, который читает панель, = путь, в который пишет наблюдаемый прогон.
// Раннер решает его через chooseLogPath по РЕЗОЛВНУТОМУ профилю (боевой ralph.log только
// для profileName==='prod' && !dry); панель обязана читать ровно тот же файл, иначе о жизни
// боевой петли судила бы по протухшему ralph.dry.log (или наоборот). dry:false — у монитора
// нет своего dry-режима: для dry-прогона раннер монитор вообще не спавнит, значит выбор
// решает один профиль. Конфиг недоверенный/нечитаемый (config===null) → profileName undefined
// → консервативно sideline, как и у самого chooseLogPath.
export function monitorLogPath(config: ResolvedConfig): string {
    return chooseLogPath(
        { dry: false, profileName: config?.profileName },
        { battle: LOG_PATH_BATTLE, sideline: LOG_PATH_SIDELINE },
    );
}

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const intervalIdx = args.indexOf('--interval');
const INTERVAL_SEC = intervalIdx !== -1 ? Number(args[intervalIdx + 1]) || 300 : 300;
// --config <путь> (#SiaT8): раннер прокидывает АБСОЛЮТНЫЙ путь конфига из дерева
// человека — тот же файл, по которому он реально идёт. Без флага (ручной запуск) —
// копия в этом же worktree; она может отставать на детач-коммите, о чём и был ревью.
const configIdx = args.indexOf('--config');
const CONFIG_PATH =
    configIdx !== -1 && args[configIdx + 1]
        ? args[configIdx + 1]
        : path.join(RALPH_DIR, 'ralph.config.json');
// Профиль тем же парсером, что у раннера (раннер прокидывает его при авто-спавне).
// failFn → null: монитор наблюдательный, кривой флаг для него повод показать
// defaultProfile, а не упасть с панелью.
const PROFILE = parseProfileFlag(args, () => null);

// Строки лога, которые считаем «значимыми» (маркеры этапов AFK-цикла).
// ▶ (#249): переход «фаза N → фаза N+1» в непрерывном prod — ключевое событие режима,
// иначе на панели невидимо; заодно в ленту попадают старты claude-сессий (▶ claude -p).
const SIGNAL_RE = /🚀|🔄|✅|🔍|🔧|🛑|⛔|🏁|❌|⚠|🔀|💤|🔔|▶/u;

// Фаза из конфига — панели нужны только milestone (сверка со state) и branch (поиск PR).
// Оба опциональны: конфиг недоверенный, поля читаются мягко (guard'ы по месту).
type PhaseConfig = { milestone?: string; branch?: string };

// Резолвнутый профилем конфиг — как его видят вызывающие (пороги/phases на верхнем
// уровне). Поля читаются мягко (все чеки — Array.isArray / typeof), поэтому тип широкий,
// но phases типизируем сразу PhaseConfig[] — иначе Array.isArray сужал бы до any[] и
// implicit any просачивался бы в currentMilestone/openPhasePRs.
type ResolvedConfig = {
    profileName?: string;
    phases?: PhaseConfig[];
    adapters?: AdapterConfig;
    rootsResolved?: { executionRoot?: string } | null;
} | null;

// state фазы (ralph.state.json): milestone === null — штатный конец очереди (#THS8M).
type PhaseState = {
    milestone?: string | null;
    // v0/v1 — флаг полем; v2 (#93) — проекция журнала сдачи, поля в файле нет.
    submitted?: boolean;
    submitStages?: TSubmitRecord[];
    count?: number;
} | null;

// #93: панель читает файл state напрямую, без миграции раннера — поэтому обе формы.
function submittedOfState(state: PhaseState): boolean {
    if (!state) return false;
    if (Array.isArray(state.submitStages)) {
        return submittedOf(state.submitStages, state.milestone ?? null);
    }
    return state.submitted === true;
}

// Результат детекта тишины (#147/#148). Поля nullable: ветка no-log отдаёт null'ы —
// сам детект тогда не алертит (silent:false), см. evalDeadman.
type DeadmanEval = {
    silent: boolean;
    reason: string | null;
    activity: Activity | null;
    thresholdMs: number | null;
    silenceMs: number | null;
};

// Доставка пуша о тишине — та же сигнатура, что pushEvent(msg, cfg, opts) в ralph.js.
type PushFn = (
    msg: string,
    cfg: ResolvedConfig,
    opts: { logFn: (...a: unknown[]) => void; dry: boolean },
) => boolean;

// Ровно то, о чём панель спрашивает трекер. Узкий тип — барьер, а не экономия: панели
// физически нечем закрыть карточку или смерджить PR, и подставить ей в тесте нечего лишнего.
export type PanelTaskSource = Pick<TaskSourceAdapter, 'listAllOpenIssues' | 'findOpenPullRequest'>;

// «Спросить не удалось» — отдельный исход у КАЖДОГО вопроса панели, с причиной словами шва.
// Без него отказ шва сливался бы с ответом «ничего нет» — ровно та ложь, из-за которой #58.
export type SeamFailure = { error: 'seam-failed'; reason: string };

// Первая строка текста отказа: многострочный ответ форжа разорвал бы рамку панели.
function failureOf(e: unknown): SeamFailure {
    const reason = String((e as Error)?.message ?? e)
        .split('\n')[0]
        .slice(0, 160);
    return { error: 'seam-failed', reason: reason || 'причина не названа' };
}

// Шов для панели — из того же config.adapters, что у петли. Отказ сборки (конфиг не
// прочитался, имя реализации неизвестно) — не падение тика, а строка панели: `failFn`
// бросает, а не делает exit, как `fail` раннера. Наблюдатель обязан пережить кривой конфиг
// и сказать о нём, а не умереть вместе с deadman.
//
// Собранный шов запоминается по выбору (`config.adapters` текстом): конфиг читается на
// каждом тике, и пересборка без кеша теряла бы вместе с адаптером его кеш резолва вех — у
// SourceCraft каждый тик заново листал бы `/milestones`. Сменился выбор — шов собирается
// заново, так что правка конфига доходит до панели тем же тиком. Отказ не запоминается:
// следующий тик пробует снова.
let builtSeam: {
    key: string;
    buildFn: Runtime['observerTaskSource'];
    source: PanelTaskSource;
} | null = null;

export function panelTaskSource(
    config: ResolvedConfig,
    buildFn: Runtime['observerTaskSource'] = observerTaskSource,
): PanelTaskSource | SeamFailure {
    if (!config) {
        return {
            error: 'seam-failed',
            reason: 'конфиг петли не прочитался — шов выбрать не по чему',
        };
    }
    const key = JSON.stringify(config.adapters ?? null);
    if (builtSeam && builtSeam.key === key && builtSeam.buildFn === buildFn)
        return builtSeam.source;
    try {
        const source = buildFn(config.adapters, (msg: string): never => {
            throw new Error(msg);
        });
        builtSeam = { key, buildFn, source };
        return source;
    } catch (e) {
        return failureOf(e);
    }
}

// ── Строка git: чьё дерево и что, если git не ответил (#126) ──
// Каталог репозитория считался подъёмом на два уровня от каталога ядра — остаток раскладки,
// где модуль жил в `.claude/ralph/runtime/`. После переезда подъём уводил выше корня, git
// падал, а обёртка глотала отказ: панель печатала `git:  @ ` — пустоту, неотличимую от
// ответа. И даже верный подъём показал бы не то дерево: ядро исполняется из `productRoot`,
// а работа идёт в `executionRoot` (`core/roots.ts`), и у них разные ветки.
//
// Поэтому дерево работы называет тот, кто его знает: раннер передаёт `--execution-root`
// (каталог, в котором он работает после переезда в worktree фазы). Ручной запуск без флага
// берёт `roots.executionRoot` конфига; нет и его — строка говорит, что дерево не названо, а
// не гадает от места запуска или каталога модуля.
export type ExecutionRoot = { dir: string; source: string } | { error: string };

export function resolveExecutionRoot(args: string[], config: ResolvedConfig): ExecutionRoot {
    const idx = args.indexOf('--execution-root');
    if (idx !== -1) {
        if (args.indexOf('--execution-root', idx + 1) !== -1) {
            return {
                error: '--execution-root передан дважды — какое дерево показывать, не догадка',
            };
        }
        const value = args[idx + 1];
        if (!value || value.startsWith('--')) return { error: '--execution-root без значения' };
        if (!path.isAbsolute(value)) {
            return {
                error: `--execution-root ${value} относительный — резолвился бы от места запуска панели`,
            };
        }
        return { dir: value, source: 'флаг раннера' };
    }
    const fromConfig = config?.rootsResolved?.executionRoot;
    if (typeof fromConfig === 'string' && fromConfig !== '') {
        return { dir: fromConfig, source: 'roots конфига' };
    }
    return {
        error: 'дерево работы не названо: нет ни --execution-root, ни roots.executionRoot в конфиге',
    };
}

// Исполнитель git — параметром: тест подменяет его, не трогая настоящий репозиторий.
export type GitExecFn = (args: string[], cwd: string) => string;

const gitExec: GitExecFn = (args, cwd) =>
    execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

// Строка панели целиком. Три различимых исхода, как у вопросов шву: ответ, «git ответил
// пусто» и «git не ответил» с причиной — иначе отказ снова выглядел бы пустой веткой.
export function gitLine(root: ExecutionRoot, execFn: GitExecFn = gitExec): string {
    if ('error' in root) return `git: (${root.error})`;
    let branch: string;
    let head: string;
    try {
        branch = execFn(['rev-parse', '--abbrev-ref', 'HEAD'], root.dir);
        head = execFn(['rev-parse', '--short', 'HEAD'], root.dir);
    } catch (e) {
        const err = e as { stderr?: unknown; message?: unknown };
        const text = String(err?.stderr || err?.message || e)
            .trim()
            .split('\n')[0]
            .slice(0, 160);
        return `git: (не прочиталось в ${root.dir}: ${text || 'причина не названа'})`;
    }
    if (!branch || !head) return `git: (git ответил пусто в ${root.dir})`;
    return `git: ${branch} @ ${head}   дерево: ${root.dir} (${root.source})`;
}

function readJSON(p: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
}

export function fmtAge(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}с назад`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}м ${s % 60}с назад`;
    const h = Math.floor(m / 60);
    return `${h}ч ${m % 60}м назад`;
}

// Длительность без «назад» — для печати порога.
export function fmtDur(ms: number): string {
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m}м`;
    return `${Math.floor(m / 60)}ч ${m % 60}м`;
}

// Сырой хвост лога (НЕ отфильтрованный по SIGNAL_RE) + время последней записи. deadman
// классифицирует режим по маркерам ✓/✗/🚦, которых нет в SIGNAL_RE, поэтому детект
// читает сырые строки, а панель значимые получает фильтром signalTail поверх этого же
// чтения (одно чтение на тик). lastMtime = mtime файла: свежесть
// лога и есть признак жизни петли (log() пишется на каждом шаге хореографии). logPath
// параметром — чтобы тестировать на временном файле, а не только на боевом LOG_PATH.
// n — сколько последних строк вернуть; n === null → ВЕСЬ файл (явный контракт вместо
// slice(-Infinity), который «случайно» отдавал весь массив). Весь файл нужен ПАНЕЛИ:
// значимые маркеры редки, последние 8 (signalTail) приходится искать по всей глубине.
// Детект же в snapshot() намеренно ограничен последними 200 строками (allLogLines.slice(-200)):
// расширять окно детекта на весь файл нельзя — древний ⛔/🎉 из глубины лога переклассифицировал
// бы режим (реальное изменение поведения, а не оптимизация).
export function readLogTail(
    n: number | null = 200,
    logPath: string = LOG_PATH,
): { lines: string[]; lastMtime: number | null } {
    let raw: string;
    try {
        raw = fs.readFileSync(logPath, 'utf8');
    } catch {
        return { lines: [], lastMtime: null };
    }
    let lastMtime: number | null = null;
    try {
        lastMtime = fs.statSync(logPath).mtimeMs;
    } catch {
        /* ignore */
    }
    const all = raw.split('\n');
    return { lines: n == null ? all : all.slice(-n), lastMtime };
}

// Heartbeat раннера (задача 95) — спутник лога, который пишется даже тогда, когда
// дописывание лога уже отказывает (полный диск, права). Отдаёт mtime и последнюю строку
// лога, которую раннер пытался записать. null — файла нет или он не читается: тогда
// детект судит по логу, как до задачи.
export function readHeartbeat(hbPath: string): { mtime: number; record: THeartbeat | null } | null {
    try {
        const mtime = fs.statSync(hbPath).mtimeMs;
        return { mtime, record: decodeHeartbeat(fs.readFileSync(hbPath, 'utf8')) };
    } catch {
        return null;
    }
}

// Признак жизни — свежее из двух: лог или heartbeat. Одного лога мало: отказ его записи
// замораживал mtime при живом раннере и давал ложный DEADMAN. Одного mtime heartbeat тоже
// мало: режим считается по хвосту, а хвост без строки, не легшей в лог, классифицирует
// прошлый шаг — сессия под коротким порогом шага git. Поэтому строка heartbeat, которой
// в хвосте нет, дописывается в хвост; если она там уже есть (штатный случай: heartbeat
// пишется сразу после строки лога), хвост не трогается, иначе панель показала бы дубль.
// Сверяется КОНЕЦ хвоста с записью целиком, а не последняя строка: сообщение бывает
// многострочным (пуш стопа, вклейка разбора падения), и последней строкой файла тогда стоит
// хвост сообщения — сравнение по ней дописывало бы дубль почти после каждого такого лога.
export function withHeartbeat(
    log: { lines: string[]; lastMtime: number | null },
    hb: { mtime: number; record: THeartbeat | null } | null,
): { lines: string[]; lastMtime: number | null } {
    if (!hb || (log.lastMtime != null && hb.mtime <= log.lastMtime)) return log;
    if (!hb.record) return { lines: log.lines, lastMtime: hb.mtime };
    const line = `[${hb.record.ts}] ${hb.record.msg}`;
    const tail = log.lines.join('\n').trimEnd();
    const lines = tail.endsWith(line) ? log.lines : [...log.lines, ...line.split('\n')];
    return { lines, lastMtime: hb.mtime };
}

// Детект тишины: возраст последней записи лога (now − lastMtime) против порога режима
// текущего шага (coder до 2ч, гейт/хоз-шаги — минуты). Чистая функция — все входы
// аргументами, «сейчас» приходит извне: детект смотрит на ФАЙЛ, а не на процесс
// раннера, поэтому переживает его смерть (kill -9, OOM). Сам пуш и дедуп — #149.
export function evalDeadman({
    now,
    lastMtime,
    lines,
    config,
}: {
    now: number;
    lastMtime: number | null;
    lines: string[];
    // config уходит только в silenceThresholdMs (deadman.ts), где тип уже unknown и все
    // поля читаются мягко: сюда одинаково валиден резолвнутый конфиг, null и тестовый CFG
    // (пороги на верхнем уровне) — без weak-type-конфликта с ResolvedConfig.
    config: unknown;
}): DeadmanEval {
    if (lastMtime == null) {
        return {
            silent: false,
            reason: 'no-log',
            activity: null,
            thresholdMs: null,
            silenceMs: null,
        };
    }
    const activity = classifyActivity(lines);
    // lines прокидываем — режиму apiwait порог берётся из строки паузы `Жду N мин`.
    const thresholdMs = silenceThresholdMs(activity, config, lines);
    // Math.max(0, …): mtime снимается ПОСЛЕ чтения контента, а now — до обоих. Запись в
    // лог между этими точками (или скачок системных часов назад) дала бы lastMtime > now
    // → отрицательный silenceMs и косметический `⏱ лог -1с назад`. Зажимаем в ноль.
    const silenceMs = Math.max(0, now - lastMtime);
    return { silent: silenceMs > thresholdMs, reason: null, activity, thresholdMs, silenceMs };
}

// Дедуп повторных пушей об одной и той же тишине (#149 — alert fatigue главный риск
// по PRD). Эпизод тишины идентифицируем по lastMtime — моменту, когда лог перестал
// расти: пока файл не сдвинулся дальше, это ТА ЖЕ тишина, повторный пуш не нужен. Как
// только лог снова пишется (loop ожил или человек вмешался), lastMtime меняется —
// следующая тишина, если наступит, будет уже новым эпизодом со своим ключом.
export function shouldPushDeadman(
    deadman: { silent: boolean },
    lastMtime: number | null,
    lastPushedForMtime: number | null,
): boolean {
    return deadman.silent && lastMtime !== lastPushedForMtime;
}

// Текст пуша — та же формулировка, что и на панели (evalDeadman/fmtAge/fmtDur), плюс
// имя фазы и явное «цикл не остановлен» — по PRD автостоп не делаем, ложный ночной
// стоп дороже лишнего пуша, и человек должен понимать, что раннер продолжит идти.
// silenceMs/thresholdMs здесь всегда числа (пуш только при silent), `?? 0` — лишь чтобы
// удовлетворить nullable-тип DeadmanEval, в бою эта ветка недостижима.
export function deadmanPushMessage(
    deadman: { silenceMs: number | null; thresholdMs: number | null; activity: Activity | null },
    milestoneName: string,
): string {
    return (
        // #289: DEADMAN не «стоп PR», а сигнал вахте — но той же формой (причина/диагноз/
        // вопрос), чтобы ночью не приходилось держать в голове второй формат сообщения.
        // Прежний хвост «Цикл продолжается без остановки — проверь вручную» снят по ревью:
        // вопрос человеку ниже говорит то же самое дословно, а пуш от повтора вдвое длиннее.
        // Второй проход ревью: числа тишины и порога тоже шли дважды — в заголовке и в
        // диагнозе теми же словами. Заголовок оставлен МАРКЕРОМ, числа живут в диагнозе.
        `💀 Ralph: DEADMAN на фазе "${milestoneName}". ` +
        formatStopMessage({
            reason: 'deadman',
            // «молчит N» — длительность тишины (fmtDur, без «назад»): fmtAge добавил бы
            // «назад» и вышло бы «молчит 5м назад» (как будто молчание было в прошлом,
            // а оно длится).
            diagnosis: `ralph.log молчит ${fmtDur(deadman.silenceMs ?? 0)} на фазе "${milestoneName}" (порог ${fmtDur(deadman.thresholdMs ?? 0)}, режим ${deadman.activity}).`,
            question:
                'проверь, жив ли процесс раннера (tmux-панель ralph, ps, хвост ralph.log) — цикл сам себя не остановил',
        })
    );
}

// Оценка + сам пуш, вынесено из snapshot(), чтобы тестировать без реальных вызовов трекера
// остального снапшота — тот же приём, что evalDeadman/readLogTail (#147/#148): чистая
// логика решения отдельно от побочек панели. pushFn инжектируется (как pushEventFn в
// ralph.js) — тесты мокают сам вызов, не profileName/Telegram. Возвращает новый ключ
// дедупа (вызывающий код держит его в состоянии между тиками).
// logFn у pushFn — НЕ log() раннера: та функция дописывает СТРОКУ В ТОТ ЖЕ ralph.log,
// по свежести которого детект и определяет тишину. Если бы пуш писал туда же,
// lastMtime «ожил» бы от собственного пуша монитора, и реальная тишина маскировалась
// бы навсегда (мёртвый раннер выглядел бы живым из-за пуша про его смерть). Печатаем
// в свой stdout — monitor.out, куда и так льётся вся панель, tail -f видит и его.
export function maybePushDeadman(
    // reason не читается (используются только silent/silenceMs/thresholdMs/activity),
    // поэтому тип уже DeadmanEval — снапшот подаёт его результат (надмножество), а тесты
    // конструируют ровно этот набор полей.
    deadman: {
        silent: boolean;
        silenceMs: number | null;
        thresholdMs: number | null;
        activity: Activity | null;
    },
    lastMtime: number | null,
    lastPushedForMtime: number | null,
    {
        pushFn = pushEvent,
        cfg,
        milestoneName,
    }: { pushFn?: PushFn; cfg: ResolvedConfig; milestoneName: string },
): number | null {
    if (!shouldPushDeadman(deadman, lastMtime, lastPushedForMtime)) {
        return lastPushedForMtime;
    }
    // Кривой/нечитаемый конфиг (resolveProfile → null): в prod pushEvent молча вернёт
    // false ДО доставки, то есть деадман обезоружен ровно в аварийном состоянии, о
    // котором watchdog и должен кричать. Fail-safe-доставка при null-конфиге — фаза 2;
    // здесь минимум — раз на эпизод явно предупредить в свой stdout (monitor.out).
    if (!cfg) {
        console.log(
            '⚠ Ralph deadman: конфиг не резолвится — deadman-пуши НЕ доставляются (проверь ralph.config.json / --profile).',
        );
    }
    // dry: false явно. У монитора нет своего dry-режима, но pushEvent по умолчанию берёт
    // dry из argv СВОЕГО процесса (require('../ralph.js') парсит DRY из process.argv). Если
    // монитор на prod-хосте запустить со случайно скопированным `--dry-run` в argv,
    // pushEvent вернул бы false ДО проверки профиля → maybePushDeadman счёл бы это сбоем
    // доставки (deliveryAttempted) → вечный ретрай с маркером каждый тик, при «доставка
    // пушей: вкл» на панели. Прокидываем false — доставка deadman не зависит от argv.
    const delivered = pushFn(deadmanPushMessage(deadman, milestoneName), cfg, {
        logFn: console.log,
        dry: false,
    });
    // Дедуп-ключ защёлкиваем не безусловно: в prod false у pushEvent = доставка НЕ удалась
    // (сбой curl/сети/Telegram, fail-open вернул false) — единственный алерт о мёртвом
    // ночном раннере нельзя терять, поэтому ключ НЕ двигаем, следующий тик повторит.
    // В non-prod/при null-конфиге false = пуш штатно подавлен профилем (доставки нет и не
    // будет) — тогда защёлкиваем, иначе наивный ретрай спамил бы monitor.out каждый тик.
    const deliveryAttempted = !!cfg && cfg.profileName === 'prod';
    if (deliveryAttempted && !delivered) {
        return lastPushedForMtime;
    }
    return lastMtime;
}

// Суточная строка метрики продукта (план, Фаза 4) — раз в сутки, на первом тике после
// полуночи UTC, сводка за прошедшие календарные сутки UTC. Окно кончается полуночью, а не
// моментом тика: тик дрейфует на минуты, и окна «24 ч до тика» соседних дней перекрывались
// бы или оставляли щели, хотя ключ строки — календарная дата. Почему здесь, а не в цикле раннера: панель
// живёт рядом с петлёй и уже владеет пушами наблюдения, а раннер между сессиями может
// стоять часами — «раз в сутки» в его цикле значило бы «когда придётся».
//
// Ключ — дата UTC последнего решения, в памяти процесса. На старте (ключа нет) ключ
// встаёт на сегодня без пуша: монитор перезапускается вместе с петлёй, и пуш на каждом
// старте превратил бы «раз в сутки» в «раз на рестарт». Цена — сутки, на границе которых
// панель не жила, строки не дают; это честнее, чем файл-отметка, которую монитор, по
// инварианту «только читает», писать не должен.
//
// Fail-open, как у остальных уведомлений: ни сбой расчёта, ни сбой доставки не роняют
// панель — исключение в тике setInterval убило бы процесс монитора, а вместе с ним и
// deadman. Сбой расчёта уходит человеку строкой с причиной: молчание в полночь читалось
// бы как «пуш потерялся», а не «метрика не считается». Ключ сдвигается и при неудачной
// доставке: строка — пульс, а не алерт, и ретрай каждые пять минут при лежащем
// Telegram был бы спамом в monitor.out.
export function metricDayKey(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
}

export function maybePushDailyMetric(
    now: number,
    lastDay: string | null,
    {
        pushFn = pushEvent,
        cfg,
        computeLine,
        logFn = console.log,
    }: {
        pushFn?: PushFn;
        cfg: ResolvedConfig;
        computeLine: (now: number) => string;
        logFn?: (...a: unknown[]) => void;
    },
): string {
    const today = metricDayKey(now);
    if (lastDay === null || lastDay === today) return today;
    let line: string;
    try {
        line = computeLine(Date.parse(`${today}T00:00:00.000Z`));
    } catch (e) {
        line = `📈 Метрика за сутки не посчитана: ${(e as Error).message}`;
    }
    try {
        // dry: false — по той же причине, что в maybePushDeadman: argv монитора не решает.
        pushFn(line, cfg, { logFn, dry: false });
    } catch (e) {
        logFn(`⚠ Суточная строка метрики не отправлена: ${(e as Error).message}`);
    }
    return today;
}

/**
 * Расчёт суточной строки по каталогу состояния, который наблюдает панель. Вынесен фабрикой,
 * чтобы проводку (какой каталог, какой конфиг, какое окно) проверял тест на фикстуре: не тот
 * каталог дал бы в полночь «лог не читается», а гейт остался бы зелёным.
 *
 * Лог — боевой ralph.log каталога (как у команды сводки): dry-лог мерджей не содержит.
 * Конфиг, который не прочитался (`resolveProfile` → null), — своя причина: без неё
 * человек получил бы «нет metrics.taskBudgetMin» о ключе, которого никто не проверял.
 */
export function dailyMetricLine(
    config: unknown,
    runtimeDir: string,
    readFn: (p: string) => string,
): (until: number) => string {
    return (until) => {
        if (config === null || config === undefined) {
            throw new Error('конфиг петли не прочитался — бюджет задачи взять неоткуда');
        }
        return formatMetricDayLine(
            summarizeRuntime({ config, runtimeDir, readFn, now: until, hours: 24 }).summary,
        );
    };
}

// Значимые строки (маркеры этапов) из УЖЕ прочитанного хвоста — последние n. Своего
// чтения файла НЕ делает: и панель значимых строк, и детект тишины идут от одного
// readLogTail в snapshot(). Так у тика ровно одно чтение (растущий многодневный лог не
// читается дважды за тик) и ровно один mtime — иначе два независимых statSync могли бы
// разойтись, и возраст одного файла в строках `🟢 активен` и `⏱ лог` показал бы разное.
function signalTail(lines: string[], n: number): string[] {
    return lines.filter((l) => SIGNAL_RE.test(l)).slice(-n);
}

function currentMilestone(
    state: PhaseState,
    config: ResolvedConfig,
): { idx: number; phase: PhaseConfig | null; total: number } | null {
    // state.milestone может быть точным именем фазы; сверяем с конфигом,
    // чтобы понять индекс/ветку.
    if (!config || !Array.isArray(config.phases)) return null;
    const idx = config.phases.findIndex((p) => p.milestone === state?.milestone);
    return {
        idx,
        phase: idx !== -1 ? config.phases[idx] : null,
        total: config.phases.length,
    };
}

// Сколько задач фазы ещё открыто — `listAllOpenIssues`, тот же вопрос, которым петля решает,
// готова ли фаза к сдаче (C2): открытые `blocked` и чужие карточки фазу тоже держат, и панель
// их тоже считает. Закрытых шов не отдаёт — и это не потеря: человек смотрит на панель, чтобы
// понять, сколько ОСТАЛОСЬ, а прежний процент от «открытые + закрытые» стоил отдельного запроса.
// `blocked` выделен из открытых: такие петля не возьмёт, и фаза ждёт человека.
export function issuesProgress(
    milestone: string | null,
    source: PanelTaskSource | SeamFailure,
): { open: number; blocked: number } | { error: 'no-milestone' } | SeamFailure {
    if (!milestone) return { error: 'no-milestone' };
    if ('error' in source) return source;
    let issues: Issue[];
    try {
        issues = source.listAllOpenIssues(milestone);
    } catch (e) {
        return failureOf(e);
    }
    if (!Array.isArray(issues)) {
        return { error: 'seam-failed', reason: 'шов вернул не список карточек' };
    }
    const blocked = issues.filter((i) => i.labels?.some((l) => l.name === 'blocked')).length;
    return { open: issues.length, blocked };
}

// Поиск открытого PR текущей фазы по ветке из конфига (#214) — `findOpenPullRequest` шва.
// Различает исходы (fail-closed, каждый — своя строка панели): ветку фазы определить не
// удалось → { error: 'no-branch' }; все фазы завершены (штатный конец) → { error:
// 'all-done' }; шов не собран или бросил → SeamFailure; иначе найденный PR или [] — ответ
// шва «открытого PR нет». Ветку панель передаёт шву как есть: точное совпадение и
// экранирование — забота реализации (#THS8X, класс #133), а не наблюдателя.
//
// Оговорка контракта: при нескольких открытых PR на ветку шов тоже отвечает null (не гадает,
// что мерджить, M5) — это ответ шва, а не сбой, поэтому и на панели он «нет».
export function openPhasePRs(
    config: ResolvedConfig,
    state: PhaseState,
    source: PanelTaskSource | SeamFailure,
): PullRequest[] | { error: 'all-done' | 'no-branch' } | SeamFailure {
    // #THS8M: milestone === null — не «битый state», а штатный конец: advancePhase после
    // ПОСЛЕДНЕЙ фазы пишет milestone: null. Отдельный маркер, чтобы панель не пугала
    // «не удалось определить ветку фазы» на успешно сданной очереди.
    if (state && state.milestone === null) {
        return { error: 'all-done' };
    }
    // Определяем текущую ветку фазы из конфига по milestone в state.
    if (!config || !Array.isArray(config.phases) || !state?.milestone) {
        return { error: 'no-branch' };
    }
    const phase = config.phases.find((p) => p.milestone === state.milestone);
    if (!phase || !phase.branch) {
        return { error: 'no-branch' };
    }
    if ('error' in source) return source;
    try {
        const pr = source.findOpenPullRequest(phase.branch);
        return pr ? [pr] : [];
    } catch (e) {
        return failureOf(e);
    }
}

// Ключ дедупа деадмана (#149) — переживает между тиками setInterval (тот же процесс
// monitor.js на весь прогон петли), но НЕ переживает перезапуск самого монитора: это
// уже фаза 2 (взаимный контроль раннер↔монитор), здесь не в скоупе.
let lastDeadmanPushMtime: number | null = null;

// Дата UTC последнего решения о суточной строке (см. maybePushDailyMetric).
let lastMetricDay: string | null = null;

// Разовое предупреждение об исчезнувшем логе (см. snapshot). Сбрасывается, когда лог
// снова находится, — чтобы каждый эпизод отсутствия файла предупреждал ровно раз.
let warnedNoLog = false;

// Эпизод «мало места» (задача 95, disk-watch.ts) и разовое предупреждение о том, что
// свободное место не читается: молчащий сторож диска не должен выглядеть «места хватает».
let diskLowLatched = false;
let warnedDiskUnknown = false;

function snapshot(): void {
    const now = Date.now();
    const state: PhaseState = (readJSON(STATE_PATH) as PhaseState) || {};
    // Конфиг профильный (#71) — phases лежат в common, поэтому резолвим тем же кодом,
    // что и раннер, а не читаем сырой JSON. failFn → null: монитор наблюдательный,
    // кривой конфиг для него повод показать «—», а не упасть (упасть должен ralph.js).
    // resolveProfile боевым типом возвращает unknown (конфиг недоверенный) — сужаем к
    // ResolvedConfig здесь; поля всё равно читаются мягко (Array.isArray/typeof по месту).
    const config = resolveProfile(readJSON(CONFIG_PATH), PROFILE, () => null) as ResolvedConfig;
    // Одно чтение лога на тик — источник правды и для панели, и для детекта. readLogTail
    // отдаёт весь хвост (n=null — явный контракт «весь файл») и ОДИН mtime: от него и
    // признак жизни (alive), и детект тишины, и последние значимые строки. Детект смотрит
    // сырой хвост (маркеры ✓/✗/🚦 в SIGNAL_RE не попадают), панель — только значимые
    // (signalTail). Сам пуш о тишине и дедуп — #149; здесь только детект и его показ.
    // #386: путь лога — по профилю резолвнутого конфига, а не жёстко ralph.log: не-боевой
    // прогон (playground) пишет в ralph.dry.log, и панель обязана читать именно его.
    // Задача 95: свежесть берётся у лога ИЛИ у heartbeat — отказ записи лога при живом
    // раннере больше не выглядит тишиной (см. withHeartbeat).
    const logPath = monitorLogPath(config);
    const { lines: allLogLines, lastMtime } = withHeartbeat(
        readLogTail(null, logPath),
        readHeartbeat(companionPaths(logPath).heartbeat),
    );
    const lines = signalTail(allLogLines, 8);
    const deadman = evalDeadman({
        now,
        lastMtime,
        lines: allLogLines.slice(-200),
        config,
    });
    // reason:'no-log' сам по себе НЕ алертит (silent:false): если ralph.log пропал
    // (чистка, ротация, снесённый worktree — а раннер при этом мёртв), детект навсегда
    // возвращал бы silent:false и watchdog молча обезоружен в состоянии, которое сам
    // должен ловить. Fail-safe-доставка — фаза 2; здесь минимум, как у null-конфига в
    // maybePushDeadman: раз на эпизод отсутствия файла предупредить в свой stdout
    // (monitor.out). Флаг сбрасывается, когда лог снова находится.
    if (deadman.reason === 'no-log') {
        if (!warnedNoLog) {
            console.log(
                '⚠ Ralph deadman: ralph.log не найден — watchdog не может судить о тишине (проверь путь/worktree/ротацию).',
            );
            warnedNoLog = true;
        }
    } else {
        warnedNoLog = false;
    }
    const ms = currentMilestone(state, config);
    const milestoneName = ms?.phase?.milestone || state?.milestone || '—';
    // Пуш о тишине (#149): только доставка события, цикл раннера монитор не трогает —
    // он вообще не властен над ним, у монитора нет доступа к процессу сессии/loop.
    lastDeadmanPushMtime = maybePushDeadman(deadman, lastMtime, lastDeadmanPushMtime, {
        cfg: config,
        milestoneName,
    });
    // Сторож диска (задача 95): сигнал раньше отказа записи state и лога. Битая секция
    // observability панель не роняет — строка в свой stdout и умолчание; стоп по ней даёт
    // preflight раннера.
    const observability = resolveObservability(config, (msg) =>
        console.log(`⚠ Ralph disk-watch: ${msg} — беру умолчание.`),
    );
    const disk = evalDisk(freeBytes(RUNTIME_DIR), observability.diskMinFreeMb);
    if (!disk.known && !warnedDiskUnknown) {
        console.log(
            `⚠ Ralph disk-watch: свободное место под ${RUNTIME_DIR} не читается — сторож диска слеп.`,
        );
    }
    warnedDiskUnknown = !disk.known;
    diskLowLatched = maybePushDiskLow(disk, diskLowLatched, {
        pushFn: pushEvent,
        cfg: config,
        dir: RUNTIME_DIR,
    });
    lastMetricDay = maybePushDailyMetric(now, lastMetricDay, {
        cfg: config,
        computeLine: dailyMetricLine(config, RUNTIME_DIR, (p) => fs.readFileSync(p, 'utf8')),
    });
    // Выбор шва сверяется на каждом тике: конфиг читается заново, и реализация обязана
    // идти за ним, а не застыть на первом тике (сборка при том же выборе — из кеша).
    const source = panelTaskSource(config);
    const prog = issuesProgress(ms?.phase?.milestone || state?.milestone || null, source);
    const prs = openPhasePRs(config, state, source);
    const git = gitLine(resolveExecutionRoot(args, config));

    const alive =
        lastMtime != null && now - lastMtime < INTERVAL_SEC * 1000 * 3
            ? `🟢 активен (лог ${fmtAge(now - lastMtime)})`
            : lastMtime != null
              ? `🟡 тихо (лог ${fmtAge(now - lastMtime)})`
              : '⚪ лог не найден';

    const bar = '═'.repeat(64);
    const out: string[] = [];
    out.push('');
    out.push(`╔${bar}╗`);
    out.push(`  RALPH MONITOR   ${new Date(now).toLocaleString('ru-RU')}`);
    out.push(`  ${alive}`);
    if (deadman.activity === 'stopped') {
        // Штатная остановка петли: порог +∞, тишина сюда не применяется. Отдельная
        // строка, а не «порог Infinityм» — раннер вышел из loop корректно, не завис.
        out.push(
            // fmtAge уже включает «назад» — своё «назад» в шаблоне не дублируем.
            `  ⏹  петля штатно остановлена (лог ${fmtAge(deadman.silenceMs ?? 0)}) — watchdog не считает это тишиной`,
        );
    } else if (deadman.reason !== 'no-log') {
        out.push(
            deadman.silent
                ? // «молчит N» — длительность (fmtDur), не «N назад» (fmtAge): тишина длится.
                  `  💀 DEADMAN: лог молчит ${fmtDur(deadman.silenceMs ?? 0)} — дольше порога ${fmtDur(deadman.thresholdMs ?? 0)} (режим ${deadman.activity})`
                : `  ⏱  лог ${fmtAge(deadman.silenceMs ?? 0)}, порог тишины ${fmtDur(deadman.thresholdMs ?? 0)} (режим ${deadman.activity})`,
        );
    }
    out.push(
        disk.known
            ? `  ${disk.low ? '💾 МАЛО МЕСТА' : '💾 диск'}: свободно ${disk.freeMb} МБ, порог ${disk.minFreeMb} МБ`
            : '  💾 диск: свободное место не читается',
    );
    out.push(`╚${bar}╝`);
    out.push(
        `Фаза: ${milestoneName}` +
            (ms && ms.idx !== -1 ? `  (${ms.idx + 1}/${ms.total})` : '') +
            `   submitted=${submittedOfState(state) ? 'да' : 'нет'}   iter=${state?.count ?? '?'}`,
    );
    out.push(git);
    // Профиль и статус доставки пушей. Операционный шов: ручной перезапуск монитора без
    // --profile берёт defaultProfile (playground) — и на prod-хосте deadman-пуши молча не
    // доставляются (pushEvent шлёт только в prod). Именно ручной рестарт после смерти
    // монитора — аварийный сценарий, где watchdog нужнее всего, поэтому статус доставки
    // виден в панели, а не молча выключен. null-конфиг → доставки тоже нет (см. maybePush).
    const deliveryOn = !!config && config.profileName === 'prod';
    out.push(
        `профиль: ${config?.profileName || '—'}   доставка пушей: ${deliveryOn ? 'вкл' : 'выкл (только prod)'}`,
    );

    if ('open' in prog) {
        out.push(
            `Issues фазы: открыто ${prog.open}` +
                (prog.blocked ? ` (из них blocked: ${prog.blocked} — ждут человека)` : ''),
        );
    } else if (prog.error === 'no-milestone') {
        out.push('Issues фазы: (фаза не определена — спрашивать не о чем)');
    } else {
        out.push(
            `Issues фазы: (шов задач не ответил: ${prog.reason}) — сколько осталось, неизвестно`,
        );
    }

    if (Array.isArray(prs)) {
        if (prs.length) {
            out.push('PR фазы:');
            for (const pr of prs) {
                const labels = (pr.labels ?? []).map((l) => l.name).join(', ');
                out.push(`  #${pr.number}  метки: ${labels || '—'}`);
            }
        } else {
            out.push('PR фазы: шов ответил — открытого нет');
        }
    } else if ('reason' in prs) {
        out.push(`PR фазы: (шов задач не ответил: ${prs.reason}) — статус PR неизвестен`);
    } else if (prs.error === 'all-done') {
        out.push('PR фазы: (все фазы завершены)');
    } else {
        out.push('PR фазы: (не удалось определить ветку фазы из конфига)');
    }

    out.push('Лог (последние события):');
    if (lines.length) {
        for (const l of lines) out.push(`  ${l.slice(0, 160)}`);
    } else {
        out.push('  (пусто)');
    }
    out.push('');
    console.log(out.join('\n'));
}

// Точка входа панели — зовётся тонким entry monitor.js (require(esm) → main()). Здесь
// НЕ запускается сама: импорт из теста (monitor-panel.test.mts) выполняет только
// объявления, без запросов к трекеру и setInterval.
export function main(): void {
    snapshot();
    if (ONCE) return;
    console.log(`⏱  Обновление каждые ${INTERVAL_SEC}с. Ctrl+C для выхода.`);
    setInterval(snapshot, INTERVAL_SEC * 1000);
}
