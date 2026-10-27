// Модуль состояния и блокировок раннера (#359, трек «Фреймворк ralph», фаза 2).
// Вынесен из ralph.js по тому же приёму, что ralph-util.ts / side-effect-guard.ts:
// вся работа с тремя файлами раннера — `ralph.state.json` (state фазы), `ralph.lock`
// (файл-лок от двойного запуска #176/#177/#178) и `.deps-lock.sha` (маркер последнего
// `npm ci` #SiaUX) — собрана здесь одним связным модулем, а ralph.js пользуется только
// его API. Lock и маркер читаются как были; state с задачи 80 несёт `schemaVersion`, а
// state прежних ревизий (без поля) принимается проверенной миграцией — см. inspectState.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
//
// Почему фабрика, а не набор standalone-экспортов (как в ralph-util.ts): эти функции —
// НЕ чистые. Им нужен контекст ralph.js, который standalone-функция взять неоткуда:
// module-level пути (state/lock/…), флаг DRY (#C1 read-only), лениво
// инициализируемый `config` (defaultState берёт первую фазу), общий предохранитель
// побочек #138 (тот же журнал sideEffectAttempts, что у ralph.js), а также
// process-примитивы processAlive/cmdlineIncludes, которые остаются в ralph.js (их делит
// и монитор — иная зона ответственности, не state/lock). Фабрика захватывает этот
// контекст один раз, а возвращённые функции сохраняют ПОКАЗАТЕЛЬНУЮ DI: каждая по-прежнему
// принимает свои коллабораторы (readFn/writeFn/killFn/…) параметром — ровно так их зовут
// сценарные тесты (lock-scenarios.test.ts) и юнит-тесты (state-lock.test.ts) через ре-экспорт
// из ralph.js.

import fs from 'node:fs';
import { underRoot, writeFileAtomic } from './roots.ts';
import crypto from 'node:crypto';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { resolveInstallCmd } from '../shared/ralph-util.ts';
import {
    attachSubmitJournal,
    deployBlockOf,
    parseSubmitJournal,
    stateToDisk,
    type TSubmitRecord,
} from './submit-journal.ts';

// Формат ralph.state.json — контракт (критерий #359). milestone === null означает «все
// фазы пройдены» (см. phaseIndexOf/advancePhase в ralph.js). Остальные поля — счётчики
// брейкеров и планки ревью (#217/#223) и барьер пост-мердж деплоя (#165). Тип описывает
// канонический полный state (его строит defaultState); с диска state приходит только через
// inspectState — проверку формы и версии схемы (задача 80).
//
// Версия схемы — номер ФОРМЫ файла, а не ревизии раннера: поднимать её нужно, когда
// прежний раннер прочитал бы новый файл неверно (переименовали, сменили смысл поля), а не
// на каждое новое поле — новые поля опциональны и читаются старыми раннерами безвредно.
//
// v2 (#93): три чекпоинта сдачи (`submitted`, `deployBlock`, `reviewOfFixes.arbitrated`)
// уехали из полей в журнал этапов `submitStages`. Прежний раннер прочитал бы v2 как
// «submitted нет — сдача не начата» и повторил бы ревью и мердж, поэтому версия поднята.
export const STATE_SCHEMA_VERSION = 2;

export type RalphState = {
    schemaVersion: number;
    count: number;
    milestone: string | null;
    submitted: boolean;
    noProgress: number;
    gateHeals: number;
    blockedHeals: number;
    reviewModelFloor: string | null;
    lastReviewModel: string | null;
    reReviewPending: boolean;
    // #625: состояние лестницы «ревью правок» текущей фазы (счётчики проходов, дедуп
    // находок, споры). Форма — ReviewOfFixesState (review-of-fixes.ts), но тип здесь
    // `unknown` по той же причине, что у deployBlock: state читается с диска, где его мог
    // написать прошлый раннер или рука человека, и приводит его к форме нормализатор
    // (normalizeReviewOfFixes), а не вера в тип.
    reviewOfFixes: unknown;
    deployBlock: unknown;
    // #269-ревью: номер прогона форжа, по логу которого чини-сессия УЖЕ отработала.
    // Форж отдаёт ПОСЛЕДНИЙ прогон workflow, а не прогон конкретного sha, и какое-то
    // время после пуша правок повторяет вердикт предыдущего. Гейт сверяется с этим
    // номером и ждёт НОВЫЙ прогон вместо того, чтобы потратить последнюю попытку лечения
    // на уже починенный лог. Переживает рестарт по той же причине, что gateHeals: бюджет
    // лечения тоже переживает. `null` — лечения по чеку форжа в этой фазе не было.
    forgeHealedRunId: string | null;
    // #88: метка начатого мерджа. Ставится записью ДО POST мерджа и снимается той же
    // записью, что переход фазы, либо определённым отказом форжа. Метка на диске при
    // рестарте — исход мерджа неизвестен: форж мог принять операцию и ещё не показать её.
    // Тогда мердж не повторяется вслепую (задвоение принятой операции), а фаза не
    // считается смердженной без ответа форжа. Опциональна: state прошлых ревизий её не
    // содержит, и отсутствие читается как «мерджа не начинали».
    mergeInFlight?: TMergeInFlight | null;
    // #93: журнал этапов сдачи фазы (submit-journal.ts). `submitted`, `deployBlock` и
    // `reviewOfFixes.arbitrated` выше — его проекции: у state, прошедшего
    // `attachSubmitJournal`, они аксессоры, и на диск ложится журнал, а не поля.
    // Опционален в типе, потому что state литералом (тесты, прежние ревизии) его не несёт —
    // аксессоры перенесут туда флаги сами.
    submitStages?: TSubmitRecord[];
};

export type TMergeInFlight = { milestone: string; pr: number; sha: string | null };

// Исход чтения state с диска (задача 80). `raw` — разобранный JSON там, где он разобрался:
// --reset достаёт из него барьер деплоя, даже когда форма в целом не прошла проверку.
export type TStateInspection =
    | { status: 'absent' }
    // `foundVersion` — версия на ДИСКЕ (0 у файла без поля): `state.schemaVersion` после
    // миграции уже текущая, а контракту совместимости (#37) нужна та, что была записана.
    | { status: 'ok'; state: RalphState; migrated: boolean; foundVersion: number }
    | { status: 'old-schema'; raw: Record<string, unknown> }
    | { status: 'foreign-version'; found: number; raw: Record<string, unknown> }
    | { status: 'corrupt'; reason: string; raw: Record<string, unknown> | null }
    // Файл есть, но не читается (EACCES, EISDIR, EIO): это права или тип файла, а не
    // повреждение содержимого, и совет «--reset с копией» тут не помог бы — копировать
    // нечего, раз не читается.
    | { status: 'unreadable'; code: string };

// Счётчики проверяются так же, как `count`: целое неотрицательное. `gateHeals: -1` или `1.5`
// сравнивались бы с бюджетом лечения молча и давали бы лишнюю попытку или ни одной.
const NUMBER_FIELDS = ['noProgress', 'gateHeals', 'blockedHeals'] as const;
const NULLABLE_STRING_FIELDS = ['reviewModelFloor', 'lastReviewModel', 'forgeHealedRunId'] as const;

/**
 * Проверка текста state: JSON, версия схемы, форма полей. Чистая — без fs, ей всё равно,
 * откуда пришёл текст.
 *
 * Версия проверяется ДО формы: файл чужой схемы вправе выглядеть иначе, и отказ «не та
 * форма» назвал бы повреждённым файл, который просто писал другой раннер. Отсутствие
 * версии — не отказ, а проверенная миграция: так выглядит каждый state, записанный до
 * задачи 80. v0 и v1 переводятся в v2 (#93) — чекпоинты сдачи из полей в журнал этапов.
 * «Проверенная» значит, что форма сверена целиком теми же правилами, что у v1, а журнал,
 * получившийся из флагов, — тем же разбором, что журнал v2 с диска.
 *
 * Опциональные поля проверяются по типу, только если присутствуют: их добавляли по одному
 * (#217, #223, #269…), и state прошлых ревизий их законно не содержит — код читает их
 * отсутствие как дефолт. Обязательны три поля, без которых раннер не знает, где он:
 * count, milestone и submitted (v0/v1) либо журнал submitStages (v2).
 */
export function inspectState(text: string): TStateInspection {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        const why = text.trim() === '' ? 'файл пуст' : `не JSON (${(e as Error).message})`;
        return { status: 'corrupt', reason: why, raw: null };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { status: 'corrupt', reason: 'ожидался JSON-объект', raw: null };
    }
    const raw = parsed as Record<string, unknown>;
    const bad = (reason: string): TStateInspection => ({ status: 'corrupt', reason, raw });

    const v = raw.schemaVersion;
    if (v !== undefined) {
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
            return bad(`schemaVersion не целое положительное число (${JSON.stringify(v)})`);
        }
        if (v > STATE_SCHEMA_VERSION) return { status: 'foreign-version', found: v, raw };
    }
    // Старая схема (phaseIndex) — это файл БЕЗ версии и без milestone. При заданной версии
    // отсутствие milestone — не другая схема, а повреждение: v1 его требует.
    if (v === undefined && raw.milestone === undefined) return { status: 'old-schema', raw };
    // v0 (без поля) и v1 держат три чекпоинта сдачи полями, v2 — журналом (#93).
    const legacy = v === undefined || v === 1;

    if (typeof raw.count !== 'number' || !Number.isInteger(raw.count) || raw.count < 0) {
        return bad('count — не целое неотрицательное число');
    }
    if (raw.milestone === undefined) return bad('milestone отсутствует');
    if (typeof raw.milestone !== 'string' && raw.milestone !== null) {
        return bad('milestone — не строка и не null');
    }
    if (legacy) {
        if (typeof raw.submitted !== 'boolean') return bad('submitted — не boolean');
    } else {
        // В v2 чекпоинт полем — не «лишнее поле», а второй источник правды рядом с
        // журналом: какой из них верен, по файлу не решить, поэтому стоп, а не выбор.
        for (const k of ['submitted', 'deployBlock'] as const) {
            if (raw[k] !== undefined) return bad(`${k} в v2 — поле журнала сдачи, а не state`);
        }
        const rof = raw.reviewOfFixes;
        if (
            rof &&
            typeof rof === 'object' &&
            (rof as Record<string, unknown>).arbitrated !== undefined
        ) {
            return bad('reviewOfFixes.arbitrated в v2 — запись журнала сдачи, а не поле');
        }
    }
    for (const k of NUMBER_FIELDS) {
        const n = raw[k];
        if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < 0)) {
            return bad(`${k} — не целое неотрицательное число`);
        }
    }
    for (const k of NULLABLE_STRING_FIELDS) {
        if (raw[k] !== undefined && raw[k] !== null && typeof raw[k] !== 'string') {
            return bad(`${k} — не строка и не null`);
        }
    }
    if (raw.reReviewPending !== undefined && typeof raw.reReviewPending !== 'boolean') {
        return bad('reReviewPending — не boolean');
    }
    // Барьер деплоя — единственное, что держит следующую фазу от недоехавшего main (#165):
    // строка или число на его месте прочитались бы как «блок есть» без единого его поля.
    const db = raw.deployBlock;
    if (db !== undefined && db !== null && (typeof db !== 'object' || Array.isArray(db))) {
        return bad('deployBlock — не объект и не null');
    }
    // Барьер без фазы и причины прочитался бы как блок, о котором нечего сказать: стоп и
    // --reset напечатали бы `фазы "undefined" (undefined)`. Обе строки пишет каждый путь,
    // который барьер ставит (оркестратор), — их отсутствие и есть порча.
    if (db && typeof db === 'object') {
        const b = db as Record<string, unknown>;
        if (typeof b.milestone !== 'string' || typeof b.reason !== 'string') {
            return bad('deployBlock без строковых milestone и reason');
        }
    }
    // Метка начатого мерджа держит фазу от повтора POST: без номера PR и фазы стоп не
    // назвал бы, что проверять человеку, а прочитанная «как есть» строка сошла бы за метку.
    const mf = raw.mergeInFlight;
    if (mf !== undefined && mf !== null) {
        const m = mf as Record<string, unknown>;
        if (
            typeof mf !== 'object' ||
            Array.isArray(mf) ||
            typeof m.milestone !== 'string' ||
            typeof m.pr !== 'number' ||
            (m.sha !== null && typeof m.sha !== 'string')
        ) {
            return bad(
                'mergeInFlight без строковой milestone, числового pr и sha строкой или null',
            );
        }
    }
    let stages: TSubmitRecord[] = [];
    if (!legacy) {
        if (raw.submitStages === undefined) return bad('submitStages отсутствует');
        try {
            stages = parseSubmitJournal(raw.submitStages, 'state.submitStages');
        } catch (e) {
            return bad((e as Error).message);
        }
    }
    // Миграция v0/v1 → v2 — те же операции, которыми пишет петля: флаги ложатся в журнал
    // аксессорами (`attachSubmitJournal`), и форма журнала после них проверяется тем же
    // разбором, что у v2 с диска. Молча принят не будет ни один файл, который v2 отверг бы.
    const { submitStages: _drop, ...rest } = raw;
    const base = legacy ? rest : { ...rest, submitStages: stages };
    let state: RalphState;
    try {
        state = attachSubmitJournal({ ...base, schemaVersion: STATE_SCHEMA_VERSION } as RalphState);
        parseSubmitJournal(state.submitStages, 'state.submitStages (миграция)');
    } catch (e) {
        return bad((e as Error).message);
    }
    return { status: 'ok', state, migrated: legacy, foundVersion: v ?? 0 };
}

/**
 * Барьер деплоя в файле, который проверку не прошёл (`--reset`). v0/v1 держат его полем
 * `deployBlock`, v2 — этапом журнала `submitStages` (#93): ищи только поле, и v2 со
 * стоящим барьером и одним битым посторонним полем читался бы «барьера нет», и `--reset`
 * стёр бы его без `--deploy-resolved`. Журнал, который не разбирается, — неизвестный
 * барьер: прочитать нечем, а снимать вслепую нельзя.
 */
export function rawDeployBlock(raw: Record<string, unknown>): {
    block: unknown;
    unknownBlock: boolean;
} {
    if (raw.deployBlock) return { block: raw.deployBlock, unknownBlock: false };
    if (raw.submitStages === undefined) return { block: null, unknownBlock: false };
    try {
        const records = parseSubmitJournal(raw.submitStages, 'state.submitStages');
        return { block: deployBlockOf(records), unknownBlock: false };
    } catch {
        return { block: null, unknownBlock: true };
    }
}

/** Текст стопа на непрошедшем проверку state: причина, что с файлом и как выйти. */
export function stateRefusal(statePath: string, r: TStateInspection): string {
    if (r.status === 'unreadable') {
        return (
            `State ${statePath} не читается (${r.code}) — это права или тип файла, а не ` +
            `повреждение содержимого. Старт отвергнут: прочитанный как отсутствующий, он начал ` +
            `бы петлю с первой фазы поверх незаконченной. Поправь права (или убери каталог на ` +
            `месте файла) и перезапусти; --reset тут не поможет — сохранить копию нечем.`
        );
    }
    const keep =
        `Файл оставлен на месте для разбора; --reset сохранит его копией ` +
        `${statePath}.${rejectedSuffix(r)}-<время> и вернёт первую фазу конфига.`;
    if (r.status === 'old-schema') {
        return (
            `${statePath} старой схемы (phaseIndex). Раннер адресует фазы по имени milestone. ` +
            `Запусти --reset (вернёт на первую фазу конфига) или пропиши руками: ` +
            `{ count, milestone: <имя фазы>, submitted: false }.`
        );
    }
    if (r.status === 'foreign-version') {
        return (
            `State ${statePath} схемы v${r.found}, а этот раннер знает v${STATE_SCHEMA_VERSION}. ` +
            `Старт отвергнут: прочитанная молча чужая схема теряет или искажает её поля. ` +
            `Запусти ревизию раннера, которая писала этот state, либо --reset. ${keep}`
        );
    }
    if (r.status === 'corrupt') {
        return (
            `State ${statePath} повреждён: ${r.reason}. Старт отвергнут — прочитанный как ` +
            `отсутствующий, он начал бы петлю с первой фазы поверх незаконченной. ${keep}`
        );
    }
    throw new Error(`stateRefusal: исход ${r.status} — не отказ`);
}

// Суффикс копии непрошедшего state — по причине отказа: файл чужой или старой схемы не
// повреждён, и имя `.corrupt-…` соврало бы тому, кто найдёт копию через месяц.
function rejectedSuffix(r: TStateInspection): string {
    if (r.status === 'old-schema') return 'old-schema';
    if (r.status === 'foreign-version') return `v${String(r.found)}`;
    return 'corrupt';
}

type KillFn = (pid: number, signal?: number | string) => void;
type ReadFn = typeof fs.readFileSync;
type WriteFn = (p: string, data: string) => void;
type RemoveFn = (p: string) => void;
type LogFn = (msg: string) => void;
type FailFn = (msg: string) => void;

// Контекст ralph.js, захватываемый фабрикой один раз. Пути читаются ЛЕНИВО, при каждом
// обращении: их адрес известен только после чтения конфига (`runtimeDir` из контракта
// корней), а фабрика собирается раньше — захваченное значение осталось бы прежним, и
// состояние уехало бы в старое место молча. DRY — значение; config — через геттер
// (заполняется в main() ПОСЛЕ загрузки модуля, а defaultState читает его лениво). guardSideEffect — обёртка ralph.js
// (уже с hint'ом #145): её вызов пишет в ОБЩИЙ журнал sideEffectAttempts, поэтому боевые
// дефолты writeFn/removeFn краснят тест забытым моком ровно как раньше.
export type StateLockEnv = {
    statePath: string;
    lockPath: string;
    lockMarkerPath: string;
    // Подстроки cmdline, любая из которых узнаёт наш раннер (см. PRODUCT.entries).
    ralphPaths: readonly string[];
    dry: boolean;
    // #204: installCmd — команда установки зависимостей из конфига (дефолт `npm ci`).
    // Читается лениво из того же getConfig, что и phases (config ставится в main()).
    getConfig: () => { phases: Array<{ milestone: string }>; installCmd?: string };
    log: LogFn;
    fail: FailFn;
    guardSideEffect: (what: string) => void;
    // Чтение файла state. Дефолт — fs.readFileSync; отсутствие файла — ENOENT, и только
    // оно: любой другой отказ чтения — не «состояния нет», а стоп (задача 80).
    readFile?: (p: string) => string;
    // Копия повреждённого state перед --reset. Дефолт — fs.copyFileSync под общим
    // предохранителем побочек, без перезаписи существующей копии.
    copyFile?: (from: string, to: string) => void;
    now?: () => Date;
    processAlive: (pid: number, killFn?: KillFn) => boolean;
    cmdlineIncludes: (pid: number, needle: string, readFn?: ReadFn) => boolean;
    buildSanitizedGateEnv: () => NodeJS.ProcessEnv;
};

export function createStateLock(env: StateLockEnv) {
    // Пути НЕ деструктурируем — см. докблок типа: они меняются между сборкой фабрики и
    // первым обращением. Остальное — значения, их можно взять сразу.
    const {
        dry: DRY,
        getConfig,
        log,
        fail,
        guardSideEffect,
        processAlive,
        cmdlineIncludes,
        buildSanitizedGateEnv,
    } = env;

    // ── State: ralph.state.json ──────────────────────────────────────────────

    function defaultState(): RalphState {
        return attachSubmitJournal({
            schemaVersion: STATE_SCHEMA_VERSION,
            count: 0,
            milestone: getConfig().phases[0].milestone,
            submitted: false,
            noProgress: 0,
            gateHeals: 0,
            blockedHeals: 0,
            // #217: планка модели повторного ревью (сильнейшая модель, поставившая блок в
            // этой фазе) и модель последнего проведённого ревью — из них считается floor.
            reviewModelFloor: null,
            lastReviewModel: null,
            // #223: раннер снял label blocked, но повторное ревью ещё не дало вердикта.
            // Флаг переживает рестарт → гейт вернёт метку, если сессия ревью погибла.
            // Задача 79: шире — «метка blocked обязана стоять, но не подтверждена чтением
            // PR» (путь арбитра тоже); снимает его только подтверждённая запись.
            reReviewPending: false,
            // #625: лестница ревью правок ещё не начиналась. Живёт ровно одну фазу —
            // advancePhase её обнуляет вместе с blockedHeals: дедуп находок и счётчик
            // споров относятся к КОНКРЕТНОМУ PR и на следующей фазе смысла не имеют.
            reviewOfFixes: null,
            // #165: красный/недосмотренный пост-мердж деплой прошлой фазы. Пока не null —
            // барьер в preflight не даёт строить следующую фазу поверх недоехавшего до
            // прода main; снимает только человек флагом --deploy-resolved (см. preflight).
            // advancePhase его НЕ обнуляет: блок ставится уже ПОСЛЕ advancePhase и обязан
            // пережить и переход фазы, и рестарт.
            deployBlock: null,
            // #269-ревью: прогона, по которому уже лечили, ещё нет.
            forgeHealedRunId: null,
        });
    }

    // Только ENOENT — «нет»: EACCES/EISDIR/EIO, прочитанные как отсутствие, вернули бы ту же
    // потерю фазы, от которой защищает inspectState, — просто через другую дверь.
    function inspectStateFile(): TStateInspection {
        const read = env.readFile ?? ((p: string) => fs.readFileSync(p, 'utf-8'));
        try {
            return inspectState(read(env.statePath));
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') return { status: 'absent' };
            return { status: 'unreadable', code: code ?? (e as Error).message };
        }
    }

    // failFn инжектируется (дефолт — module-level fail): preflight пробрасывает свой
    // failFn, чтобы юнит-тест ловил отказ через исключение, а не process.exit.
    //
    // Задача 80: раньше чтение шло через loadJson с фолбэком null, и обрезанный файл читался
    // как отсутствующий — петля стартовала с первой фазы поверх незаконченной, теряя её
    // счётчики, барьер деплоя и флаг «метка blocked не подтверждена». Теперь «нет» — только
    // отсутствие файла; всё, что лежит, но не проходит проверку, — стоп с диагнозом, а сам
    // файл остаётся на месте нетронутым: разбирать его человеку.
    function loadState(failFn: FailFn = fail): RalphState {
        const r = inspectStateFile();
        if (r.status === 'absent') return defaultState();
        if (r.status === 'ok') {
            if (r.migrated) {
                log(
                    `🗂 State ${env.statePath} прежней схемы — форма проверена, принят как ` +
                        `v${STATE_SCHEMA_VERSION}: чекпоинты сдачи перенесены в журнал этапов, ` +
                        `новая форма запишется со следующим сохранением.`,
                );
            }
            return r.state;
        }
        const msg = stateRefusal(env.statePath, r);
        failFn(msg);
        // Боевой fail уходит в process.exit; failFn, который вернулся, не должен превратить
        // отказ в «читаем дальше» — у вызывающего нет state, с которым можно продолжать.
        throw new Error(msg);
    }

    // --reset. Жил в main() оркестратора, но решает он о state, и с задачей 80 у него
    // появились исходы, которые надо проверять юнитом: файл, который не разобрался, —
    // это одновременно улика (сохраняем копией до перезаписи) и неизвестный барьер деплоя
    // (#THS8J: снимать его молча нельзя, а прочитать нечем — требуем --deploy-resolved).
    // Возвращает путь сохранённой копии или null, если копировать было нечего.
    function resetState({
        deployResolved,
        failFn = fail,
    }: {
        deployResolved: boolean;
        failFn?: FailFn;
    }): string | null {
        const r = inspectStateFile();
        // Нечитаемый файл --reset не лечит: копию снять нечем, а перезапись поверх файла,
        // который мы не прочли (или каталога на его месте), — та же слепая потеря барьера.
        if (r.status === 'unreadable') {
            const msg = `--reset: ${stateRefusal(env.statePath, r)}`;
            failFn(msg);
            throw new Error(msg);
        }
        let block: unknown = null;
        let unknownBlock = false;
        if (r.status === 'ok') block = r.state.deployBlock;
        else if (r.status !== 'absent') {
            if (r.raw) ({ block, unknownBlock } = rawDeployBlock(r.raw));
            else unknownBlock = true;
        }
        if (unknownBlock && !deployResolved) {
            const msg =
                `--reset: state ${env.statePath} не разбирается, и активен ли в нём барьер ` +
                `красного деплоя, не прочитать. --reset стёр бы его вслепую — разбери файл ` +
                `руками или повтори с --deploy-resolved, если сбрасываешь state вместе с барьером.`;
            failFn(msg);
            throw new Error(msg);
        }
        const b = block as { milestone?: unknown; reason?: unknown } | null;
        if (b && !deployResolved) {
            const msg =
                `--reset при активном барьере красного деплоя фазы "${b.milestone}" ` +
                `(${b.reason}). --reset стёр бы барьер молча — снятие барьера деплоя ` +
                `должно быть осознанным. Разберись с деплоем и повтори с --deploy-resolved, если ` +
                `действительно сбрасываешь state вместе с барьером.`;
            failFn(msg);
            throw new Error(msg);
        }
        if (b || unknownBlock) {
            log(
                `⚠ --reset вместе с --deploy-resolved стирает барьер красного деплоя` +
                    (b
                        ? ` фазы "${b.milestone}" (${b.reason}).`
                        : ' (какой — из файла не прочитать).'),
            );
        }
        let kept: string | null = null;
        if (r.status !== 'absent' && r.status !== 'ok' && !DRY) {
            const stamp = (env.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
            kept = `${env.statePath}.${rejectedSuffix(r)}-${stamp}`;
            const copy =
                env.copyFile ??
                ((from: string, to: string) => {
                    guardSideEffect(`copyFile(${from} → ${to})`);
                    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
                });
            copy(env.statePath, kept);
            log(`🗂 Непрошедший проверку state сохранён для разбора: ${kept}`);
        }
        saveState(defaultState());
        return kept;
    }

    function saveState(state: RalphState): void {
        // C1: --dry-run обязан быть строго read-only. Guard ЗДЕСЬ, в единственной точке
        // записи, а не у каждого вызова — невозможно забыть обернуть новый вызов в !DRY
        // (именно так dry-run и начал когда-то двигать phaseIndex).
        if (DRY) return;
        // Тот же guard, что у sh(): забытый saveStateFn в тесте перезаписал бы state
        // ЖИВОГО прогона — гейт мерджа гоняет npm run test прямо в worktree раннера.
        guardSideEffect(`saveState(${env.statePath})`);
        // Целиком или никак: прерванный прогон иначе оставляет полуфайл, который следующий
        // старт читает как «состояния нет» — то есть теряет фазу вместе с её PR.
        // #93: на диск — журнал сдачи вместо трёх чекпоинтов (stateToDisk).
        writeFileAtomic(env.statePath, JSON.stringify(stateToDisk(state), null, 2));
    }

    // ── Маркер зависимостей: .deps-lock.sha ──────────────────────────────────

    // Хэш package-lock.json в дереве dir (sha256 содержимого) или null, если файла нет.
    // Чистая обёртка над fs — вынесена, чтобы гейт и bootstrap считали хэш одинаково.
    function lockHash(dir = '.', readFn: ReadFn = fs.readFileSync): string | null {
        try {
            return crypto
                .createHash('sha256')
                .update(readFn(path.join(dir, 'package-lock.json')))
                .digest('hex');
        } catch {
            return null;
        }
    }

    // Записывает текущий хэш lock как маркер «под эти зависимости уже прогнан npm ci».
    function writeLockMarker(
        dir = '.',
        {
            readFn = fs.readFileSync,
            writeFn = fs.writeFileSync,
        }: { readFn?: ReadFn; writeFn?: typeof fs.writeFileSync } = {},
    ): void {
        const h = lockHash(dir, readFn);
        if (!h) return;
        try {
            // Абсолютный путь маркера остаётся собой: склейка увела бы его внутрь дерева,
            // а читатель ниже смотрит в runtimeDir — маркер не находился бы никогда, и
            // `npm ci` шёл бы перед каждым гейтом (ревью !19).
            writeFn(underRoot(dir, env.lockMarkerPath), h);
        } catch {}
    }

    // Гейт детачится на PR-голову ТОЧНОГО коммита, который уедет в main — а её lock мог
    // добавить зависимость (node_modules дерева раннера при этом старые). Сверяем хэш lock
    // с маркером последнего npm ci и при расхождении переустанавливаем ДО чеков (#SiaUX):
    // иначе фаза-с-новой-зависимостью гарантированно красила бы ночной гейт на «module not
    // found», а README честно, но против цели AFK-прогона, отсылал бы чинить руками.
    function syncDepsIfLockChanged({
        logFn = log,
        existsFn = fs.existsSync,
        readFn = fs.readFileSync,
        writeFn = fs.writeFileSync,
        // env (#189): санированное окружение для `npm ci`. checksGreen прокидывает сюда уже
        // построенный env (один allowlist-load на прогон гейта); при прямом вызове дефолт
        // строит его сам через buildGateEnvFn. installFn исполняет lifecycle-скрипты
        // зависимостей — код с чужих слов, ему секреты петли видеть нельзя. Разрешённый env
        // приходит в installFn аргументом — так подмена видна в тестах через spy.
        env: gateEnv,
        buildGateEnvFn = buildSanitizedGateEnv,
        installFn = (resolvedEnv: NodeJS.ProcessEnv) => {
            // Забытый installFn в тесте запустил бы настоящую установку в дереве, где идут
            // тесты, — переустановка node_modules посреди прогона (ревью PR #141).
            guardSideEffect('installCmd (syncDepsIfLockChanged)');
            // #204: команда из конфига (дефолт `npm ci`) — не-npm стек ставит своё, не правя
            // код. Единый резолвер resolveInstallCmd (ralph-util) — тот же, что в логе ниже и
            // в orchestrator.getInstallCmd: дефолт не разъедется между «сказано» и «сделано».
            return execSync(resolveInstallCmd(getConfig()), {
                stdio: 'inherit',
                env: resolvedEnv,
            });
        },
    }: {
        logFn?: LogFn;
        existsFn?: typeof fs.existsSync;
        readFn?: ReadFn;
        writeFn?: typeof fs.writeFileSync;
        env?: NodeJS.ProcessEnv;
        buildGateEnvFn?: () => NodeJS.ProcessEnv;
        installFn?: (resolvedEnv: NodeJS.ProcessEnv) => unknown;
    } = {}): void {
        const current = lockHash('.', readFn);
        if (!current) return; // нет package-lock.json — сверять нечего
        let prev: string | null = null;
        try {
            if (existsFn(env.lockMarkerPath))
                prev = String(readFn(env.lockMarkerPath, 'utf-8')).trim();
        } catch {}
        if (prev === current) return;
        logFn(
            `📦 package-lock.json PR-головы отличается от установленного — ${resolveInstallCmd(getConfig())} перед чеками...`,
        );
        // env из checksGreen (уже санирован), иначе строим сам — fail-closed при битом allowlist.
        installFn(gateEnv ?? buildGateEnvFn());
        writeLockMarker('.', { readFn, writeFn });
    }

    // ── Файл-лок от двойного запуска: ralph.lock (#176/#177/#178) ─────────────

    // Сверка «за pid действительно наш ralph.js» — по путям env.ralphPaths в cmdline. Тот же
    // приём, что isRalphMonitorProcess. ВНИМАНИЕ: относительная подстрока уникальности проекта
    // не гарантирует (см. PRODUCT.entries в оркестраторе) — для лока это лишь ложный отказ при
    // pid-reuse (fail-closed), не снос чужого процесса. Переиспользованный pid (чужой процесс
    // под тем же номером) → ни одной подстроки нет → false, лок считается сиротой.
    function isRalphProcess(pid: number, readFn: ReadFn = fs.readFileSync): boolean {
        return env.ralphPaths.some((needle) => cmdlineIncludes(pid, needle, readFn));
    }

    // Держит ли лок ЖИВОЙ раннер: номер занят (kill 0) И cmdline подтверждает ralph.js.
    // Обе проверки обязательны и в этом порядке — kill(pid, 0) на мёртвом pid бросит
    // (ESRCH → false) и до чтения /proc не дойдём; на переиспользованном номере kill
    // пройдёт, но cmdline-сверка отсечёт чужой процесс. Так pid-reuse не сойдёт за живой
    // раннер и не заблокирует легитимный запуск. procReadFn читает ТОЛЬКО /proc/<pid>/cmdline
    // (отдельный от чтения лок-файла контракт — в acquireLock это разные dep'ы).
    function lockAlive(
        pid: number,
        {
            killFn = process.kill,
            procReadFn = fs.readFileSync,
        }: { killFn?: KillFn; procReadFn?: ReadFn } = {},
    ): boolean {
        return processAlive(pid, killFn) && isRalphProcess(pid, procReadFn);
    }

    // Пишет pid текущего процесса в лок-файл ЭКСКЛЮЗИВНО (flag 'wx'): создаёт файл, только
    // если его ещё нет, иначе бросает EEXIST. Это закрывает гонку check-then-act в acquireLock
    // (см. там) — второй одновременно стартующий раннер, прошедший ту же проверку «лока нет»,
    // на записи получит EEXIST и не перезапишет победителя. Побочка — под предохранителем
    // #138: забытый writeFn в тесте иначе насорил бы настоящим ralph.lock в дереве тестов.
    function writeLock(
        pid: number = process.pid,
        { writeFn, lockPath = env.lockPath }: { writeFn?: WriteFn; lockPath?: string } = {},
    ): void {
        const doWrite: WriteFn =
            writeFn ||
            ((p, data) => {
                guardSideEffect(`writeLock (${p})`);
                return fs.writeFileSync(p, data, { flag: 'wx' });
            });
        doWrite(lockPath, String(pid));
    }

    // Снимает лок-файл (осиротевший лок при взятии, свой лок при выходе). Побочка — под
    // предохранителем #138. ENOENT при удалении не ошибка: лок уже снят (гонка, ручная
    // чистка) — цель «файла нет» достигнута, а не «удаление провалилось».
    function removeLock({
        lockPath = env.lockPath,
        removeFn,
    }: { lockPath?: string; removeFn?: RemoveFn } = {}): void {
        const doRemove: RemoveFn =
            removeFn ||
            ((p) => {
                guardSideEffect(`removeLock (${p})`);
                try {
                    fs.unlinkSync(p);
                } catch (e: unknown) {
                    if (!e || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
                }
            });
        doRemove(lockPath);
    }

    // Снятие СВОЕГО лока при штатном выходе (exit-хендлер main()). Без него каждый рестарт
    // шёл бы через путь «🔓 осиротевший лок»: шум в логе + событие перестаёт быть сигналом
    // РЕАЛЬНОГО kill -9, а устаревший файл расширяет окно pid-reuse (номер достанется grep/
    // tail/vim по ralph.js → ложный «живой раннер» и отказ старта). Две оговорки: (1) снимаем
    // ТОЛЬКО если файл ещё держит наш pid — если лок в странной гонке украли/переписали,
    // слепой unlink снёс бы чужой; (2) путь передаётся АБСОЛЮТНЫЙ, зафиксированный ДО chdir в
    // worktree, — относительный путь лока после chdir указал бы внутрь дерева раннера (тот же
    // прецедент, что репойнт logTarget, #SiaUB). Свои побочки — через DI под #138.
    function releaseLockIfOurs(
        lockPath: string,
        {
            readFn = fs.readFileSync,
            removeFn,
            pid = process.pid,
        }: { readFn?: ReadFn; removeFn?: RemoveFn; pid?: number } = {},
    ): void {
        let held: number;
        try {
            held = Number(String(readFn(lockPath, 'utf-8')).trim());
        } catch {
            return; // нет файла / нечитаем — снимать нечего
        }
        if (held !== pid) return; // лок уже не наш — чужой не трогаем
        removeLock({ lockPath, removeFn });
    }

    // --- Взятие лока: fail-closed решение (#177) -------------------------------
    // Единственная точка решения «стартовать или отказать» по лок-файлу. Четыре исхода:
    //
    //   нет файла (ENOENT)                  → лок свободен: пишем свой pid, стартуем.
    //   живой раннер (kill 0 + cmdline)     → ОТКАЗ fail-closed, сообщение с pid и путём.
    //   сирота (pid мёртв / чужой cmdline)  → снимаем лок, событие в лог, берём себе.
    //   нечитаем / битый pid                → СТОП fail-closed (не «лока нет»).
    //
    // Читаем файл здесь напрямую и парсим со СТРОГОЙ валидацией: «нет файла», «нет прав» и
    // «битый pid» для #177 — три разных исхода (ENOENT — норм-путь, EACCES/битое содержимое —
    // fail-closed стоп по образцу scripts/security-audit.mjs). lockAlive — примитив живости;
    // acquireLock — слой политики над ним.
    //
    // Взятие лока АТОМАРНО: и на пути «нет файла», и на пути реклейма сироты запись идёт через
    // writeLock (flag 'wx' — эксклюзивное создание). Между нашим чтением и записью второй
    // одновременно стартующий раннер мог пройти ту же проверку и записать свой pid — тогда наш
    // 'wx' бросит EEXIST, и это ОТКАЗ (лок только что появился), а не молчаливая перезапись
    // победителя гонки. Иначе неатомарный check-then-act пропустил бы оба процесса — ровно та
    // гонка за state/ветки/мердж, ради запрета которой лок существует.
    //
    // Все побочки — через DI (#138): чтение лок-файла (readFn) и /proc (procReadFn) РАЗДЕЛЕНЫ
    // (у каждого свой контракт, тестам не надо мультиплексировать по пути), плюс удаление,
    // запись, kill, лог, стоп. failFn по умолчанию — fail() (process.exit(1)); в бою после
    // него исполнение не продолжается, return в тестах нужен мок-failFn, который не роняет
    // процесс.
    function acquireLock({
        lockPath = env.lockPath,
        pid = process.pid,
        readFn = fs.readFileSync,
        procReadFn = fs.readFileSync,
        killFn = process.kill,
        removeFn,
        writeFn,
        logFn = log,
        failFn = fail,
    }: {
        lockPath?: string;
        pid?: number;
        readFn?: ReadFn;
        procReadFn?: ReadFn;
        killFn?: KillFn;
        removeFn?: RemoveFn;
        writeFn?: WriteFn;
        logFn?: LogFn;
        failFn?: FailFn;
    } = {}): boolean {
        // Эксклюзивная запись своего pid: writeLock идёт через flag 'wx', поэтому если лок УСПЕЛ
        // появиться между проверкой и записью (гонка двух стартов) — EEXIST → fail-closed отказ.
        const claim = (): boolean => {
            try {
                writeLock(pid, { writeFn, lockPath });
                return true;
            } catch (e: unknown) {
                if (e && (e as NodeJS.ErrnoException).code === 'EEXIST') {
                    failFn(
                        `Лок ${lockPath} возник в момент взятия — другой раннер стартовал ` +
                            `одновременно. Второй запуск на том же состоянии запрещён.`,
                    );
                    return false;
                }
                throw e;
            }
        };

        let raw: string | Buffer;
        try {
            raw = readFn(lockPath, 'utf-8');
        } catch (e: unknown) {
            // Файла нет — лок свободен, это норм-путь. Только ENOENT: любую другую ошибку
            // чтения (нет прав, битый inode) трактовать как «лока нет» = тихо стартовать
            // поверх возможного живого раннера, ровно то, что fail-closed запрещает.
            if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
                return claim();
            }
            const err = e as NodeJS.ErrnoException;
            failFn(
                `Лок-файл ${lockPath} нечитаем (${String(err?.code ?? err?.message ?? e)}) — ` +
                    `не берусь решать, жив ли другой раннер. Разберись руками и перезапусти.`,
            );
            return false;
        }

        const trimmed = String(raw).trim();
        const heldPid = Number(trimmed);
        // Битое содержимое: пусто или не положительное целое. Не «пропустим проверку» и не
        // «считаем сиротой и крадём» — стоп fail-closed. Осознанная цена: усечённый при
        // падении лок требует ручной чистки, но гонка двух раннеров дороже (deadman заметит
        // «не стартовал»).
        if (!trimmed || !Number.isInteger(heldPid) || heldPid <= 0) {
            failFn(
                `Лок-файл ${lockPath} битый (содержимое ${JSON.stringify(trimmed)}) — ` +
                    `не берусь решать, жив ли другой раннер. Разберись руками и перезапусти.`,
            );
            return false;
        }

        if (lockAlive(heldPid, { killFn, procReadFn })) {
            // Живой раннер держит лок — отказ. Сообщение обязано назвать pid и путь (кто
            // держит и где), критерий #177.
            failFn(
                `Другой раннер уже держит лок: pid ${heldPid}, файл ${lockPath}. ` +
                    `Второй запуск на том же состоянии запрещён — гонка за state/ветки/мердж.`,
            );
            return false;
        }

        // Сирота: pid мёртв (kill 0 → ESRCH) или за ним чужой процесс (pid-reuse, cmdline не
        // наш ralph.js). Снимаем лок и берём себе — без ручной чистки после kill -9 / OOM.
        // ВНИМАНИЕ (#178): это событие уходит через log() ДО репойнта logTarget на worktree (он
        // в main() ПОСЛЕ загрузки конфига, а лок — самый первый шаг, впереди конфига по
        // построению). Поэтому строка «🔓» ляжет в ralph.log ДЕРЕВА ЧЕЛОВЕКА, а монитор тейлит
        // только worktree-лог — на панели этого события НЕ будет. Ищи его в ralph.log клона
        // запуска, не в monitor.out. Изменить порядок нельзя: лок обязан быть до побочек.
        logFn(
            `🔓 Осиротевший лок pid ${heldPid} (процесс мёртв или не наш ralph.js) — ` +
                `снимаю ${lockPath} и стартую.`,
        );
        removeLock({ lockPath, removeFn });
        // Реклейм тоже через эксклюзивную запись: между unlink и созданием второй процесс мог
        // снять ту же сироту и взять лок — тогда наш claim() получит EEXIST, а не перезапишет
        // победителя гонки за реклейм.
        return claim();
    }

    return {
        defaultState,
        loadState,
        resetState,
        saveState,
        lockHash,
        writeLockMarker,
        syncDepsIfLockChanged,
        isRalphProcess,
        lockAlive,
        writeLock,
        removeLock,
        releaseLockIfOurs,
        acquireLock,
    };
}
