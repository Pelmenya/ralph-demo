/**
 * Контракт совместимости пяти слоёв: launcher, ядро, конфиг, state, адаптеры (Фаза 12, #37).
 *
 * Пока ядро было копией внутри проекта, все пять слоёв ездили одним коммитом, и вопроса
 * «совместимы ли они» не возникало. Внешняя установка их развела: launcher лежит в
 * репозитории потребителя, ядро — в `<dataDir>/<sha>/`, конфиг и state — у потребителя,
 * адаптеры ставятся вместе с ядром, но говорят своей версией контракта. Тихий фолбэк на
 * несовместимости — самый дорогой отказ автономной петли: она проработает ночь не так, как
 * думает человек. Поэтому у каждого слоя есть ЦЕЛАЯ версия, и расхождение — отказ, который
 * называет слой, ожидаемую и найденную версию и что делать.
 *
 * Источник ожидаемых версий — `.ralph/core.lock` (`versions`), когда ядро исполняется из
 * установки, и сами константы ядра, когда это клон: у клона lock не применяется, но
 * конфиг и state он читает те же, и несовместимость у них та же. Lock проверяется и сам:
 * версия в нём, которой исполняемое ядро не понимает, — отказ по этому слою, даже если
 * наблюдаемая сторона с lock согласна.
 *
 * Правила сравнения:
 *   - launcher, ядро, конфиг, адаптеры — точное равенство: старше или младше одинаково
 *     значит «говорим разными словами»;
 *   - state — не новее ожидаемого: прежние схемы переводит проверенная миграция
 *     (`inspectState`), чужую новую не прочитать без потерь.
 *
 * Отсутствие источника версии — НЕ «значит совместимо», и у каждого слоя оно решено
 * отдельно и вслух:
 *   - launcher не заявил версию (`RALPH_LAUNCHER_VERSION`) при ядре из установки — отказ:
 *     прямой запуск установленного ядра обходит контракт launcher целиком. У клона
 *     launcher'а нет по построению — исход «не применяется», он виден в строке лога;
 *   - конфиг без `configVersion` — v1 по определению: v1 и есть формат до появления
 *     поля. Это правило, а не фолбэк: когда схема станет v2, такой конфиг будет отвергнут;
 *   - state нет — «не применяется»: первая фаза, читать нечего. Нечитаемый или битый state
 *     — отказ: версия неизвестна, а неизвестная не равна совместимой.
 *
 * Одна функция на старт и на `--doctor`: проверка, которую doctor показывает зелёной, а
 * старт отвергает (или наоборот), учила бы человека не верить обеим.
 *
 * TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).
 */
import { ADAPTERS_CONTRACT_VERSION } from '../adapters/adapters-impl.ts';
// Только тип: core-install сам импортирует отсюда версии слоёв.
import type { TStartCheck } from './core-install.ts';
import { inspectState, STATE_SCHEMA_VERSION, type TStateInspection } from './state-lock.ts';

/** Версия контракта между launcher и ядром: флаги, переменные, коды выхода. */
export const LAUNCHER_CONTRACT_VERSION = 1;
/** Версия контракта самого ядра — то, что lock обещает исполнить. */
export const CORE_CONTRACT_VERSION = 1;
/** Версия схемы `ralph.config.json` (поле `configVersion` верхнего уровня). */
export const CONFIG_SCHEMA_VERSION = 1;
/** Версия контракта швов, которую ядро требует от адаптеров. */
export const CORE_REQUIRES_ADAPTERS = 1;

/** Переменная, которой launcher заявляет свою версию ядру. */
export const LAUNCHER_VERSION_ENV = 'RALPH_LAUNCHER_VERSION';

export const COMPAT_LAYERS = ['launcher', 'core', 'config', 'state', 'adapters'] as const;
export type TCompatLayer = (typeof COMPAT_LAYERS)[number];
export type TCompatVersions = Record<TCompatLayer, number>;

/** Версии, которые понимает ЭТА ревизия ядра. Их же launcher пишет в lock при установке. */
export function supportedVersions(): TCompatVersions {
    return {
        launcher: LAUNCHER_CONTRACT_VERSION,
        core: CORE_CONTRACT_VERSION,
        config: CONFIG_SCHEMA_VERSION,
        state: STATE_SCHEMA_VERSION,
        adapters: CORE_REQUIRES_ADAPTERS,
    };
}

export type TObservation =
    | { kind: 'version'; version: number; note?: string }
    | { kind: 'absent'; note: string }
    // `fix` — когда совет слоя по умолчанию к этой причине не ведёт (state, который не
    // читается из-за прав: --reset там не поможет — копировать нечего).
    | { kind: 'invalid'; reason: string; fix?: string };

export type TCompatInput = {
    /** Версии из lock; `null` — ядро не из установки, lock к нему не относится. */
    lock: { path: string; versions: TCompatVersions } | null;
    /** Наблюдаемая сторона. Слой без наблюдения в этом вызове не проверяется. */
    observed: Partial<Record<TCompatLayer, TObservation>>;
    /** Подмена для тестов: что понимает исполняемое ядро. */
    supported?: TCompatVersions;
};

export type TLayerResult =
    | { layer: TCompatLayer; status: 'ok'; version: number; note?: string }
    | { layer: TCompatLayer; status: 'n/a'; note: string }
    | { layer: TCompatLayer; status: 'refused'; reason: string };

export type TCompatReport = { ok: boolean; layers: TLayerResult[] };

// Что делать — по слою и направлению. Совет обязан вести к починке, а не повторять отказ:
// «версии разошлись» человек видит и так.
const FIX: Record<TCompatLayer, string> = {
    launcher:
        'обнови ./ralph потребителя до версии, которую знает ядро из lock (launcher приезжает ' +
        'той же ревизией канона), либо зафиксируй в lock ревизию ядра, знающую этот launcher',
    core:
        'lock записан ревизией с другим контрактом ядра: переустанови ядро ревизии из lock ' +
        '(./ralph install) или обнови lock той же ревизией, что исполняется',
    config:
        'приведи ralph.config.json к схеме, которую знает ядро (поле configVersion верхнего ' +
        'уровня), либо зафиксируй в lock ревизию ядра, знающую эту схему',
    state:
        'запусти ревизию ядра, которая писала этот state, либо --reset (state сохранится ' +
        'копией рядом и вернётся первая фаза конфига)',
    adapters:
        'адаптеры этой установки говорят другой версией контракта, чем требует ядро: ' +
        'переустанови ревизию целиком (./ralph install) — адаптеры и ядро ставятся вместе',
};

function refused(layer: TCompatLayer, reason: string, fix: string = FIX[layer]): TLayerResult {
    return { layer, status: 'refused', reason: `${reason}. Что делать: ${fix}` };
}

function checkLayer(
    layer: TCompatLayer,
    obs: TObservation,
    input: TCompatInput,
    supported: TCompatVersions,
): TLayerResult {
    const lockV = input.lock?.versions[layer];
    const source = input.lock
        ? `lock ${input.lock.path}`
        : 'версии исполняемого ядра (lock не применяется)';
    // Lock сам по себе обязан говорить на языке исполняемого ядра: иначе «наблюдаемое
    // совпало с lock» значило бы «совпало с тем, чего ядро не понимает».
    if (lockV !== undefined && lockV !== supported[layer]) {
        return refused(
            layer,
            `слой ${layer}: ${source} ожидает v${String(lockV)}, а исполняемое ядро понимает ` +
                `v${String(supported[layer])}`,
        );
    }
    const expected = lockV ?? supported[layer];
    if (obs.kind === 'invalid') {
        return refused(
            layer,
            `слой ${layer}: версия не прочитана (${obs.reason}), ожидалась v${String(expected)} (${source})`,
            obs.fix,
        );
    }
    if (obs.kind === 'absent') {
        // Отсутствие решено по слою, а не одним правилом: см. докблок модуля.
        if (layer === 'state' || (layer === 'launcher' && input.lock === null))
            return { layer, status: 'n/a', note: obs.note };
        return refused(
            layer,
            `слой ${layer}: версия не заявлена (${obs.note}), ожидалась v${String(expected)} (${source})`,
        );
    }
    const found = obs.version;
    const fits = layer === 'state' ? found <= expected : found === expected;
    if (!fits) {
        return refused(
            layer,
            `слой ${layer}: ожидалась v${String(expected)}${layer === 'state' ? ' или старше' : ''} ` +
                `(${source}), найдена v${String(found)}${obs.note ? ` — ${obs.note}` : ''}`,
        );
    }
    return obs.note === undefined
        ? { layer, status: 'ok', version: found }
        : { layer, status: 'ok', version: found, note: obs.note };
}

/** Сверка слоёв в каноническом порядке. Отчёт полный: doctor показывает все слои разом. */
export function checkCompatibility(input: TCompatInput): TCompatReport {
    const supported = input.supported ?? supportedVersions();
    const layers: TLayerResult[] = [];
    for (const layer of COMPAT_LAYERS) {
        const obs = input.observed[layer];
        if (obs === undefined) continue;
        layers.push(checkLayer(layer, obs, input, supported));
    }
    return { ok: layers.every(passed), layers };
}

// ── Наблюдения ───────────────────────────────────────────────────────────────

/** Версия launcher из окружения. Окружение — параметром: ядро не читает его само. */
export function observeLauncher(env: Record<string, string | undefined>): TObservation {
    const v = env[LAUNCHER_VERSION_ENV];
    if (v === undefined || v === '') {
        return { kind: 'absent', note: `${LAUNCHER_VERSION_ENV} не задан — запуск мимо launcher` };
    }
    if (!/^[1-9]\d*$/.test(v)) {
        return {
            kind: 'invalid',
            reason: `${LAUNCHER_VERSION_ENV}=${JSON.stringify(v)} не целое положительное`,
        };
    }
    return { kind: 'version', version: Number(v) };
}

export function observeCore(): TObservation {
    return { kind: 'version', version: CORE_CONTRACT_VERSION };
}

export function observeAdapters(): TObservation {
    return { kind: 'version', version: ADAPTERS_CONTRACT_VERSION };
}

/** `configVersion` СЫРОГО конфига: поле верхнего уровня, вне `common` и профилей. */
export function observeConfig(raw: Record<string, unknown>): TObservation {
    const v = raw.configVersion;
    if (v === undefined) {
        return {
            kind: 'version',
            version: 1,
            note: 'configVersion не задан — конфиг до версионирования, это v1',
        };
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
        return {
            kind: 'invalid',
            reason: `configVersion = ${JSON.stringify(v)} не целое положительное`,
        };
    }
    return { kind: 'version', version: v };
}

/** Версия state по исходу его проверки. Файл без версии — v0, его переводит миграция. */
export function observeState(r: TStateInspection): TObservation {
    switch (r.status) {
        case 'absent':
            return { kind: 'absent', note: 'state нет — первая фаза, сверять нечего' };
        case 'unreadable':
            return {
                kind: 'invalid',
                reason: `state не читается (${r.code})`,
                fix:
                    'это права или тип файла, а не содержимое: поправь права (или убери каталог ' +
                    'на месте файла) и перезапусти; --reset тут не поможет — копировать нечего',
            };
        case 'corrupt':
            return { kind: 'invalid', reason: `state повреждён: ${r.reason}` };
        case 'old-schema':
            return { kind: 'invalid', reason: 'state старой схемы (phaseIndex) — нужен --reset' };
        case 'foreign-version':
            return { kind: 'version', version: r.found };
        case 'ok':
            return r.migrated
                ? {
                      kind: 'version',
                      version: r.foundVersion,
                      note: 'прежняя схема — переведётся проверенной миграцией',
                  }
                : { kind: 'version', version: r.foundVersion };
    }
}

/** Чтение state для сверки: «нет» — только ENOENT, как у `inspectStateFile` раннера. */
export function inspectStateAt(statePath: string, readFn: (p: string) => string): TStateInspection {
    let text: string;
    try {
        text = readFn(statePath);
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return { status: 'absent' };
        return { status: 'unreadable', code: code ?? (e as Error).message };
    }
    return inspectState(text);
}

// ── Строки ───────────────────────────────────────────────────────────────────

// Строка прошедшего слоя. Отвергнутый сюда не приходит: его строка — причина целиком.
function layerLine(l: Exclude<TLayerResult, { status: 'refused' }>): string {
    if (l.status === 'ok') return `${l.layer} v${String(l.version)}${l.note ? ` (${l.note})` : ''}`;
    return `${l.layer} — (${l.note})`;
}

type TPassed = Exclude<TLayerResult, { status: 'refused' }>;
function passed(l: TLayerResult): l is TPassed {
    return l.status !== 'refused';
}

/**
 * Строка лога о сверке. Совместимый отчёт — одна строка без предупреждений: шум на штатном
 * пути убивает внимание к настоящим. Несовместимый — каждый отвергнутый слой с причиной.
 */
export function describeCompat(report: TCompatReport): string {
    if (report.ok)
        return `🧩 Совместимость слоёв: ${report.layers.filter(passed).map(layerLine).join(', ')}`;
    const why = report.layers
        .filter((l): l is Extract<TLayerResult, { status: 'refused' }> => l.status === 'refused')
        .map((l) => l.reason)
        .join('; ');
    return `🧩 Старт отвергнут контрактом совместимости: ${why}`;
}

// ── doctor ───────────────────────────────────────────────────────────────────

/**
 * Отчёт `--doctor`: сверка ядра с lock и каждый слой отдельной строкой. Код выхода — тот
 * же вердикт, что вынес бы старт: 0 — старт пройдёт эти проверки, 1 — будет отвергнут.
 */
export function runDoctor(
    core: { ok: boolean; line: string },
    report: TCompatReport,
    out: (line: string) => void,
    startChecks: readonly { ok: boolean; warn?: boolean; line: string }[] = [],
): 0 | 1 {
    out(`🩺 ${core.line}`);
    // Проверки старта вне контракта слоёв (ревизия ядра, settings сессии, корни): doctor
    // обязан отказывать там же, где старт, иначе его зелёному не верят.
    // Предупреждение старт не валит, но и зелёным не красится: деградацию видно маркером.
    for (const c of startChecks) out(`${!c.ok ? '❌' : c.warn ? '⚠️' : '✅'} ${c.line}`);
    for (const l of report.layers) {
        if (l.status === 'refused') out(`❌ ${l.reason}`);
        else if (l.status === 'n/a') out(`➖ ${l.layer}: не применяется — ${l.note}`);
        else out(`✅ ${layerLine(l)}`);
    }
    const ok = core.ok && report.ok && startChecks.every((c) => c.ok);
    out(ok ? '🩺 Итог: старт эти проверки пройдёт' : '🩺 Итог: старт будет отвергнут');
    return ok ? 0 : 1;
}

/**
 * Doctor — режим только для чтения, и в паре с флагом, который пишет или меняет режим,
 * один из двух молча проиграл бы порядку веток кода. Возвращает текст отказа или `null`.
 */
export function doctorFlagConflict(flags: Record<string, boolean | undefined>): string | null {
    const others = Object.entries(flags)
        .filter(([k, v]) => k !== 'doctor' && v === true)
        .map(([k]) => k);
    if (flags.doctor !== true || others.length === 0) return null;
    return `--doctor — отдельный режим только для чтения, а с ним заданы ещё: ${others.join(', ')}. Оставь один.`;
}

/**
 * Где doctor ищет state — там же, где его прочтёт старт: в `runtimeDir` при заданных
 * roots, иначе в дереве раннера, если оно уже поднято (старт переедет туда до чтения),
 * иначе от места запуска, как dry.
 */
export function doctorStatePath(p: {
    runtimeState: string | null;
    worktree: string;
    worktreeReady: boolean;
    legacyState: string;
    resolveFn: (...parts: string[]) => string;
}): string {
    if (p.runtimeState !== null) return p.runtimeState;
    return p.worktreeReady ? p.resolveFn(p.worktree, p.legacyState) : p.resolveFn(p.legacyState);
}

/** Lock для сверки слоёв: только у ядра, сверенного с ним; иначе ожидаемое — само ядро. */
export function compatLockOf(check: TStartCheck): TCompatInput['lock'] {
    return check.status === 'ok' ? { path: check.lockPath, versions: check.lock.versions } : null;
}

/**
 * Режим `--doctor` целиком: отказ на соседних флагах, затем отчёт. State читается здесь,
 * а не в `main()`, — тем же наблюдателем, что у старта.
 */
export function runDoctorMode(p: {
    flags: Record<string, boolean | undefined>;
    coreCheck: TStartCheck;
    coreLine: string;
    observed: TCompatInput['observed'];
    statePath: string;
    readFn: (p: string) => string;
    out: (line: string) => void;
    failFn: (msg: string) => never;
    /** Проверки старта вне слоёв — их строит `main()` теми же функциями, что старт. */
    startChecks?: readonly { ok: boolean; warn?: boolean; line: string }[];
}): 0 | 1 {
    const conflict = doctorFlagConflict(p.flags);
    if (conflict) p.failFn(conflict);
    const report = checkCompatibility({
        lock: compatLockOf(p.coreCheck),
        observed: { ...p.observed, state: observeState(inspectStateAt(p.statePath, p.readFn)) },
    });
    return runDoctor(
        { ok: p.coreCheck.status !== 'refused', line: p.coreLine },
        report,
        p.out,
        p.startChecks ?? [],
    );
}
