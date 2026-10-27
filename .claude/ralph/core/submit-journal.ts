// Журнал этапов сдачи фазы (Фаза 8, #93) — вторая половина журнала попытки (#92).
//
// До журнала сдача помнила себя тремя флагами в разных местах state: `submitted` (PR,
// ревью и правки позади), `reviewOfFixes.arbitrated` (арбитр отработал) и `deployBlock`
// (пост-мердж деплой не досмотрен или красный). Каждый флаг отвечал на один вопрос о
// рестарте, а всё, что между ними, рестарт не видел: убитый после ревью раннер начинал
// сдачу заново — второе ревью той же фазы, второй круг комментариев, иногда второй
// `blocked` поверх снятого человеком.
//
// Правило то же, что у кодер-попытки (mshogin/reflex): у каждого начатого этапа
// обязательна запись исхода, и этап без неё после рестарта — «не завершён», а не
// «выполнен». Три флага стали проекциями журнала, а не полями: `submitted` — это «этап
// арбитра с исходом, мерджа ещё нет», `arbitrated` — «арбитр дал вердикт», `deployBlock` —
// «этап деплоя начат без исхода (pending) или остановлен (красный)».
//
// Журнал живёт ВНУТРИ state, а не отдельным файлом, как у кодер-попытки. Причина — две
// записи, атомарность которых держит мердж: барьер деплоя ложится на диск той же записью,
// что и переход фазы (#88), а вердикт арбитра — той же, что флаг `reReviewPending` (#87).
// Раздели их по двум файлам — и раннер, убитый между записями, встал бы на следующей фазе
// без барьера или смерджил бы подтверждённый блокер. Один файл — одна запись, и окна нет.
//
// Журнал держит ОДНУ попытку сдачи и только текущий путь по ней. Повторный вход в
// пройденный этап (гейт после разбора `blocked`, гейт после отказа форжа в мердже) не
// дописывает историю, а усекает журнал до этого этапа: история живёт в логе, а журнал
// отвечает только на вопрос «с какого этапа продолжать». Доведённая попытка снимается.
//
// В памяти три флага остаются свойствами state — но свойствами-аксессорами поверх
// журнала (`attachSubmitJournal`): код петли и её тесты пишут `state.submitted = true` как
// раньше, а запись уходит в журнал. Отдельного поля, которое могло бы разойтись с
// журналом, нет ни в памяти, ни на диске.

import { normalizeReviewOfFixes, type ClassifiedFinding } from './review-of-fixes.ts';

/** Этапы сдачи — в порядке исполнения. */
export const SUBMIT_STAGES = [
    'pr',
    'review',
    'fixes',
    'fix-review',
    'arbiter',
    'gate',
    'merge',
    'deploy',
] as const;
export type TSubmitStage = (typeof SUBMIT_STAGES)[number];

export const SUBMIT_STAGE_TITLES: Record<TSubmitStage, string> = {
    pr: 'создание PR',
    review: 'ревью',
    fixes: 'правки по ревью',
    'fix-review': 'ревью правок',
    arbiter: 'арбитр',
    gate: 'гейт',
    merge: 'мердж',
    deploy: 'деплой',
};

/**
 * Исход этапа сдачи. `ok` — сделан; `skip` — делать было нечего или этап решился без
 * своей работы (арбитра не понадобилось, деплоя нет); `stop` — петля встала на этапе с
 * названной причиной. В отличие от кодер-попытки, стоп сдачи попытку не кончает: каждый
 * fail-closed стоп сдачи говорит «перезапусти loop», и рестарт ПОВТОРЯЕТ остановленный
 * этап, а не начинает сдачу с PR. Исключение — стоп деплоя: он и есть барьер, и снимает
 * его только человек.
 */
export type TSubmitOutcome = 'ok' | 'skip' | 'stop';
const OUTCOMES: ReadonlySet<string> = new Set(['ok', 'skip', 'stop']);

export type TSubmitRecord =
    | {
          v: 1;
          track: 'submit';
          milestone: string;
          stage: TSubmitStage;
          event: 'start';
          detail?: unknown;
          at: string;
      }
    | {
          v: 1;
          track: 'submit';
          milestone: string;
          stage: TSubmitStage;
          event: 'outcome';
          outcome: TSubmitOutcome;
          detail?: unknown;
          at: string;
      };

export type TSubmitStageStatus =
    'выполнен' | 'пропущен' | 'остановлен' | 'не завершён' | 'не начат';

export type TSubmitSummary = {
    milestone: string;
    stages: { stage: TSubmitStage; status: TSubmitStageStatus }[];
    /** Первый этап без исхода `ok`/`skip`; `null` — попытка доведена. */
    resumeStage: TSubmitStage | null;
};

const idx = (s: TSubmitStage): number => SUBMIT_STAGES.indexOf(s);

function fail(where: string, n: number, why: string): never {
    throw new Error(
        `Журнал сдачи ${where}, запись ${String(n)}: ${why}. Повреждённую запись не ` +
            'пропускаю: пропущенный этап читался бы «не начат», и рестарт повторил бы ' +
            'сделанное (второе ревью, второй мердж) либо прошёл бы мимо барьера деплоя.',
    );
}

/** Барьер деплоя без фазы и причины не назвал бы человеку, что разбирать (#165). */
function isDeployDetail(d: unknown): boolean {
    if (d === null || typeof d !== 'object' || Array.isArray(d)) return false;
    const b = d as Record<string, unknown>;
    return typeof b.milestone === 'string' && typeof b.reason === 'string';
}

/**
 * Проверка журнала, прочитанного с диска: форма каждой записи и их ПОРЯДОК. Порядок
 * строгий — этап начинается только после исхода предыдущего, после стопа записей нет:
 * повторный вход усекает журнал, а не дописывает его, поэтому любое другое расположение
 * означает, что журнал писали не мы, и решать по нему нельзя.
 */
export function parseSubmitJournal(raw: unknown, where: string): TSubmitRecord[] {
    if (!Array.isArray(raw)) fail(where, 0, 'журнал — не массив записей');
    const out: TSubmitRecord[] = [];
    let milestone: string | null = null;
    let open: number | null = null;
    let lastClosed = -1;
    let stopped = false;
    raw.forEach((r: unknown, i) => {
        const n = i + 1;
        if (r === null || typeof r !== 'object' || Array.isArray(r)) fail(where, n, 'не объект');
        const o = r as Record<string, unknown>;
        if (o.v !== 1) fail(where, n, `неизвестная версия записи (${JSON.stringify(o.v)})`);
        if (o.track !== 'submit') fail(where, n, 'запись не журнала сдачи');
        if (typeof o.milestone !== 'string' || o.milestone === '') fail(where, n, 'нет фазы');
        const k = SUBMIT_STAGES.indexOf(o.stage as TSubmitStage);
        if (k < 0) fail(where, n, `неизвестный этап ${JSON.stringify(o.stage)}`);
        if (typeof o.at !== 'string' || o.at === '') fail(where, n, 'нет времени записи');
        if (milestone === null) milestone = o.milestone;
        else if (o.milestone !== milestone) {
            fail(where, n, 'запись другой фазы — журнал держит одну попытку сдачи');
        }
        if (stopped) fail(where, n, 'запись после исхода «stop» — повторный вход усекает журнал');
        if (o.stage === 'deploy' && o.detail !== undefined && !isDeployDetail(o.detail)) {
            fail(where, n, 'барьер деплоя без строковых milestone и reason');
        }
        const base = {
            v: 1 as const,
            track: 'submit' as const,
            milestone: o.milestone,
            stage: o.stage as TSubmitStage,
            ...(o.detail !== undefined ? { detail: o.detail } : {}),
            at: o.at,
        };
        if (o.event === 'start') {
            if (open !== null) fail(where, n, 'начат новый этап, у прошлого нет исхода');
            if (k !== lastClosed + 1)
                fail(where, n, `этап «${String(o.stage)}» начат не по порядку`);
            open = k;
            out.push({ ...base, event: 'start' });
            return;
        }
        if (o.event === 'outcome') {
            if (open !== k) fail(where, n, `исход этапа «${String(o.stage)}» без его начала`);
            if (!OUTCOMES.has(o.outcome as string)) {
                fail(where, n, `неизвестный исход ${JSON.stringify(o.outcome)}`);
            }
            open = null;
            lastClosed = k;
            if (o.outcome === 'stop') stopped = true;
            out.push({ ...base, event: 'outcome', outcome: o.outcome as TSubmitOutcome });
            return;
        }
        fail(where, n, `неизвестное событие ${JSON.stringify(o.event)}`);
    });
    return out;
}

const outcomeOf = (
    records: readonly TSubmitRecord[],
    stage: TSubmitStage,
): TSubmitRecord | undefined => records.find((r) => r.stage === stage && r.event === 'outcome');

/** Этап доведён: исход `ok` или `skip`. Стоп — не доведён, рестарт его повторит. */
export function stageDone(records: readonly TSubmitRecord[], stage: TSubmitStage): boolean {
    const o = outcomeOf(records, stage);
    return o !== undefined && o.event === 'outcome' && o.outcome !== 'stop';
}

/** Сводка попытки для лога и для решения «с какого этапа продолжать». */
export function summarizeSubmit(records: readonly TSubmitRecord[]): TSubmitSummary | null {
    if (records.length === 0) return null;
    let resumeStage: TSubmitStage | null = null;
    const stages = SUBMIT_STAGES.map((stage) => {
        const o = outcomeOf(records, stage);
        const started = records.some((r) => r.stage === stage && r.event === 'start');
        let status: TSubmitStageStatus;
        if (o && o.event === 'outcome') {
            status =
                o.outcome === 'ok' ? 'выполнен' : o.outcome === 'skip' ? 'пропущен' : 'остановлен';
        } else status = started ? 'не завершён' : 'не начат';
        if (resumeStage === null && status !== 'выполнен' && status !== 'пропущен') {
            resumeStage = stage;
        }
        return { stage, status };
    });
    return { milestone: records[0].milestone, stages, resumeStage };
}

export function formatSubmitSummary(s: TSubmitSummary): string {
    const parts = s.stages
        .filter((x) => x.status !== 'не начат')
        .map((x) => `${SUBMIT_STAGE_TITLES[x.stage]} — ${x.status}`);
    const tail =
        s.resumeStage === null
            ? 'сдача доведена'
            : `продолжаю с этапа «${SUBMIT_STAGE_TITLES[s.resumeStage]}»`;
    return `Сдача фазы "${s.milestone}": ${parts.join('; ') || 'этапов нет'} — ${tail}.`;
}

/** Деталь записи этапа (база диффа правок, находки для арбитра, барьер деплоя). */
export function stageDetail(records: readonly TSubmitRecord[], stage: TSubmitStage): unknown {
    const o = outcomeOf(records, stage);
    if (o && o.detail !== undefined) return o.detail;
    return records.find((r) => r.stage === stage && r.event === 'start')?.detail;
}

// ── Операции над журналом: чистые, возвращают новый массив ─────────────────────────

const rec = (
    milestone: string,
    stage: TSubmitStage,
    at: string,
    tail: { event: 'start' } | { event: 'outcome'; outcome: TSubmitOutcome },
    detail: unknown,
): TSubmitRecord =>
    ({
        v: 1,
        track: 'submit',
        milestone,
        stage,
        ...tail,
        ...(detail !== undefined ? { detail } : {}),
        at,
    }) as TSubmitRecord;

/** Попытка этой фазы: журнал другой фазы для неё — пустой. */
const forPhase = (records: readonly TSubmitRecord[], milestone: string): TSubmitRecord[] =>
    records.length > 0 && records[0].milestone === milestone ? [...records] : [];

/** Записи этапов строго до `stage` — повторный вход в этап. */
const before = (records: readonly TSubmitRecord[], stage: TSubmitStage): TSubmitRecord[] =>
    records.filter((r) => idx(r.stage) < idx(stage));

/**
 * Начало этапа. Повторный вход в пройденный или остановленный этап усекает журнал до
 * него; этап, уже открытый (брошенный прошлым процессом), не дублируется. Предшественники
 * обязаны быть доведены: этап, начатый через голову недоделанного, — дефект петли, и
 * писать его на диск значило бы назвать недоделанное сделанным.
 */
export function startStage(
    records: readonly TSubmitRecord[],
    milestone: string,
    stage: TSubmitStage,
    at: string,
    detail?: unknown,
): TSubmitRecord[] {
    const mine = forPhase(records, milestone);
    const last = mine[mine.length - 1];
    if (last && last.event === 'start' && last.stage === stage) return mine;
    const kept = before(mine, stage);
    for (const s of SUBMIT_STAGES.slice(0, idx(stage))) {
        if (!stageDone(kept, s)) {
            throw new Error(
                `журнал сдачи: этап «${SUBMIT_STAGE_TITLES[stage]}» начат раньше исхода этапа «${SUBMIT_STAGE_TITLES[s]}»`,
            );
        }
    }
    return [...kept, rec(milestone, stage, at, { event: 'start' }, detail)];
}

/**
 * Деталь открытого этапа заменяется — без нового начала. Нужна этапу, чьё «откуда
 * продолжать» движется по ходу работы: круг лестницы ревью правок сдвигает базу диффа, и
 * рестарт посреди лестницы, читая базу из начала этапа, диффил бы от самой первой.
 */
export function withOpenStageDetail(
    records: readonly TSubmitRecord[],
    milestone: string,
    stage: TSubmitStage,
    detail: unknown,
): TSubmitRecord[] {
    const mine = forPhase(records, milestone);
    const last = mine[mine.length - 1];
    if (!last || last.event !== 'start' || last.stage !== stage) {
        throw new Error(
            `журнал сдачи: этап «${SUBMIT_STAGE_TITLES[stage]}» не открыт — его детали некуда лечь`,
        );
    }
    return [...mine.slice(0, -1), { ...last, detail }];
}

/**
 * Исход этапа. Не открытый этап начинается здесь же: у мгновенных этапов (деплоя нет,
 * арбитр не понадобился) начало и исход — одна запись state. Последний этап с исходом
 * `ok`/`skip` — попытка доведена, журнал пуст.
 */
export function finishStage(
    records: readonly TSubmitRecord[],
    milestone: string,
    stage: TSubmitStage,
    outcome: TSubmitOutcome,
    at: string,
    detail?: unknown,
): TSubmitRecord[] {
    const opened = startStage(records, milestone, stage, at);
    const startRec = opened[opened.length - 1];
    // Деталь начала сохраняется, если исход своей не несёт: у pending-барьера деплоя она
    // и есть то, что прочтёт следующий старт.
    const keepDetail = detail !== undefined ? detail : startRec.detail;
    const next = [...opened, rec(milestone, stage, at, { event: 'outcome', outcome }, keepDetail)];
    if (stage === 'deploy' && outcome !== 'stop') return [];
    return next;
}

/** Довести недоведённые этапы до `stage` (не включая) — путь миграции и легаси-флагов. */
function fillTo(
    records: readonly TSubmitRecord[],
    milestone: string,
    stage: TSubmitStage,
    at: string,
): TSubmitRecord[] {
    let out = forPhase(records, milestone);
    for (const s of SUBMIT_STAGES.slice(0, idx(stage))) {
        if (stageDone(out, s)) continue;
        // Арбитр доводится `skip`, а не `ok`: `ok` арбитра — это его ВЕРДИКТ (`arbitrated`),
        // а флаг «сдано» о вердикте не говорит ничего. Доведи его `ok` — и
        // `{submitted: true, reviewOfFixes: {arbitrated: false}}` читался бы обратно с
        // `arbitrated === true`, и повторный вход в лестницу решил бы «мердж». Вердикт,
        // который был, ложится своей операцией (`withArbitrated`) до заполнения.
        const outcome: TSubmitOutcome = s === 'arbiter' ? 'skip' : 'ok';
        // Открытый этап доводится своим началом: его делал тот, кто начал, и до исхода
        // дошло дело — флаг ставится ровно там, где этап кончается (мердж → деплой).
        const last = out[out.length - 1];
        if (last && last.event === 'start' && last.stage === s) {
            out = finishStage(out, milestone, s, outcome, at);
            continue;
        }
        // Этап, о котором известно только «флаг стоял», доводится с пометкой, откуда он
        // взялся: в сводке видно, что этап восстановлен по чекпоинту, а не записан тем,
        // кто его делал.
        out = finishStage(before(out, s), milestone, s, outcome, at, { from: 'checkpoint' });
    }
    return out;
}

// ── Проекции чекпоинтов ─────────────────────────────────────────────────────────────

/** `submitted`: арбитр (последний этап сдачи до гейта) с исходом, мерджа ещё нет. */
export function submittedOf(records: readonly TSubmitRecord[], milestone: string | null): boolean {
    if (milestone === null) return false;
    const mine = forPhase(records, milestone);
    return stageDone(mine, 'arbiter') && !stageDone(mine, 'merge');
}

/** `arbitrated`: арбитр отработал и его вердикт применён — исход `ok`, не `skip`. */
export function arbitratedOf(records: readonly TSubmitRecord[], milestone: string | null): boolean {
    if (milestone === null) return false;
    const o = outcomeOf(forPhase(records, milestone), 'arbiter');
    return o !== undefined && o.event === 'outcome' && o.outcome === 'ok';
}

/**
 * `deployBlock`: этап деплоя начат без исхода (pending) или остановлен (красный).
 *
 * Барьер без детали — не «барьера нет»: раннер такую запись не пишет, но правленный руками
 * или усечённый state иначе молча снимал бы барьер деплоя вместо стопа (задача 80). Такой
 * барьер читается неизвестным — с фазой попытки и причиной, которая это и говорит.
 */
export function deployBlockOf(records: readonly TSubmitRecord[]): unknown {
    const start = records.find((r) => r.stage === 'deploy' && r.event === 'start');
    if (!start) return null;
    const o = outcomeOf(records, 'deploy');
    if (o && o.event === 'outcome' && o.outcome !== 'stop') return null;
    const detail = stageDetail(records, 'deploy');
    if (isDeployDetail(detail)) return detail;
    return {
        milestone: start.milestone,
        reason: 'барьер деплоя без записанной причины (журнал сдачи правлен или усечён)',
    };
}

export function withSubmitted(
    records: readonly TSubmitRecord[],
    milestone: string | null,
    value: boolean,
    at: string,
): TSubmitRecord[] {
    if (milestone === null || submittedOf(records, milestone) === value) return [...records];
    if (value) return fillTo(records, milestone, 'gate', at);
    // Сброс — новая попытка сдачи этой фазы (полный повтор после чини-сессии). `--resubmit`
    // идёт мимо: на попытке до гейта флаг уже ложен, и он снимает журнал `restartSubmitAttempt`.
    // Журнал ЧУЖОЙ фазы и попытку, дошедшую до мерджа, сброс не трогает: там лежит барьер
    // деплоя, и снять его молча означало бы обойти #165.
    const mine = forPhase(records, milestone);
    if (mine.length === 0 || stageDone(mine, 'merge')) return [...records];
    return [];
}

/**
 * Полный повтор сдачи фазы (`--resubmit`): попытка этой фазы снимается целиком, какой бы
 * этап ни был последним. Явной операцией, а не сбросом флагов: `withSubmitted(false)` и
 * `withArbitrated(false)` выходят рано, когда флаг уже ложен, — а у попытки, не дошедшей
 * до гейта, оба ложны, и «полный повтор» молча продолжал бы с середины (с правок без
 * нового ревью). Попытку, дошедшую до мерджа, и журнал чужой фазы повтор не трогает: там
 * лежит барьер деплоя (#165).
 */
export function restartSubmitAttempt(
    records: readonly TSubmitRecord[],
    milestone: string | null,
): TSubmitRecord[] {
    if (milestone === null) return [...records];
    const mine = forPhase(records, milestone);
    if (mine.length === 0 || stageDone(mine, 'merge')) return [...records];
    return [];
}

export function withArbitrated(
    records: readonly TSubmitRecord[],
    milestone: string | null,
    value: boolean,
    at: string,
): TSubmitRecord[] {
    if (milestone === null || arbitratedOf(records, milestone) === value) return [...records];
    if (!value) {
        // Сброс лестницы у попытки, дошедшей до мерджа (переход фазы обнуляет лестницу), —
        // не повод трогать журнал: за мерджем лежит барьер деплоя, и усечение до арбитра
        // сняло бы его молча.
        const mine = forPhase(records, milestone);
        return stageDone(mine, 'merge') ? [...records] : before(mine, 'arbiter');
    }
    const filled = fillTo(records, milestone, 'arbiter', at);
    return finishStage(filled, milestone, 'arbiter', 'ok', at);
}

export function withDeployBlock(
    records: readonly TSubmitRecord[],
    block: unknown,
    at: string,
): TSubmitRecord[] {
    if (block === null || block === undefined) {
        // Барьер снят (зелёный деплой или --deploy-resolved): деплой — последний этап,
        // и попытка с ним доведена.
        return records.some((r) => r.stage === 'deploy') ? [] : [...records];
    }
    if (!isDeployDetail(block)) {
        throw new Error('журнал сдачи: барьер деплоя без строковых milestone и reason');
    }
    const b = block as { milestone: string; status?: unknown };
    const filled = fillTo(records, b.milestone, 'deploy', at);
    if (b.status === 'pending') {
        return [
            ...before(filled, 'deploy'),
            rec(b.milestone, 'deploy', at, { event: 'start' }, block),
        ];
    }
    return finishStage(before(filled, 'deploy'), b.milestone, 'deploy', 'stop', at, block);
}

// ── State: аксессоры в памяти и форма на диске ─────────────────────────────────────

const ATTACHED = Symbol.for('ralph.submitJournal');

type TCheckpointState = {
    milestone: string | null;
    submitted?: unknown;
    deployBlock?: unknown;
    reviewOfFixes?: unknown;
    submitStages?: TSubmitRecord[];
};

const withoutArbitrated = (v: unknown): unknown => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v ?? null;
    const { arbitrated: _drop, ...rest } = v as Record<string, unknown>;
    return rest;
};

/**
 * Перевести state на журнал: `submitted`, `deployBlock` и `reviewOfFixes.arbitrated`
 * становятся аксессорами, чтение — проекция журнала, запись — операция над ним. Значения
 * полей, стоявшие на объекте, переносятся в журнал теми же операциями (это и есть миграция
 * старого state, и путь тестов, собирающих state литералом). Журнал — `submitStages`,
 * НЕ перечисляемое свойство: в JSON попадает только через `stateToDisk`, и копия state
 * через JSON несёт флаги, а не журнал, — как state до журнала.
 *
 * Идемпотентно: второй вызов на том же объекте ничего не меняет.
 */
export function attachSubmitJournal<T extends TCheckpointState>(
    state: T,
    { nowFn = () => new Date().toISOString() }: { nowFn?: () => string } = {},
): T {
    const s = state as T & { [ATTACHED]?: true };
    if (s[ATTACHED]) return state;
    let journal: TSubmitRecord[] = Array.isArray(state.submitStages) ? [...state.submitStages] : [];
    const legacy = {
        submitted: state.submitted,
        deployBlock: state.deployBlock,
        reviewOfFixes: state.reviewOfFixes,
    };
    let ladder: unknown = withoutArbitrated(legacy.reviewOfFixes);
    // Фаза флагов — фаза попытки в журнале, а без попытки — фаза state. Флаг говорит о
    // той сдаче, что идёт; после перехода фазы попытка прошлой (с барьером деплоя) флагам
    // новой не отвечает: `submittedOf` за мерджем ложен, `arbitratedOf` — о прошлом PR.
    const cur = (): string | null => journal[0]?.milestone ?? state.milestone;
    Object.defineProperty(s, ATTACHED, { value: true, enumerable: false });
    Object.defineProperty(s, 'submitStages', {
        enumerable: false,
        configurable: true,
        get: () => journal,
        set: (v: TSubmitRecord[]) => {
            journal = [...v];
        },
    });
    Object.defineProperty(s, 'submitted', {
        enumerable: true,
        configurable: true,
        get: () => submittedOf(journal, cur()),
        set: (v: unknown) => {
            journal = withSubmitted(journal, cur(), v === true, nowFn());
        },
    });
    Object.defineProperty(s, 'reviewOfFixes', {
        enumerable: true,
        configurable: true,
        get: () => {
            if (!ladder || typeof ladder !== 'object') return ladder ?? null;
            return { ...(ladder as object), arbitrated: arbitratedOf(journal, cur()) };
        },
        set: (v: unknown) => {
            ladder = withoutArbitrated(v);
            const arb = v !== null && typeof v === 'object' && normalizeReviewOfFixes(v).arbitrated;
            journal = withArbitrated(journal, cur(), arb, nowFn());
        },
    });
    Object.defineProperty(s, 'deployBlock', {
        enumerable: true,
        configurable: true,
        get: () => deployBlockOf(journal),
        set: (v: unknown) => {
            journal = withDeployBlock(journal, v, nowFn());
        },
    });
    // Перенос значений, стоявших на объекте. Порядок важен: барьер деплоя последним —
    // сброс `submitted` его не снимает, но ставить барьер раньше значило бы, что поле
    // `submitted: false` литерала судило бы о попытке, дошедшей до мерджа.
    if (legacy.submitted === true) s.submitted = true;
    else if (legacy.submitted === false && journal.length > 0) s.submitted = false;
    if (normalizeReviewOfFixes(legacy.reviewOfFixes).arbitrated) {
        s.reviewOfFixes = legacy.reviewOfFixes;
    }
    if (legacy.deployBlock) s.deployBlock = legacy.deployBlock;
    return state;
}

/** Форма state на диске: журнал вместо трёх флагов. */
export function stateToDisk<T extends TCheckpointState>(state: T): Record<string, unknown> {
    const attached = attachSubmitJournal(state);
    const out: Record<string, unknown> = { ...attached };
    delete out.submitted;
    delete out.deployBlock;
    out.reviewOfFixes = withoutArbitrated(attached.reviewOfFixes);
    out.submitStages = attached.submitStages ?? [];
    return out;
}

/** База диффа правок из начала этапа правок; `null` — не зафиксирована. */
export function fixBaseOf(detail: unknown): string | null {
    if (!detail || typeof detail !== 'object') return null;
    const b = (detail as { base?: unknown }).base;
    return typeof b === 'string' && b !== '' ? b : null;
}

/**
 * Находки, которые ревью правок передало арбитру (деталь исхода этапа ревью правок).
 * Запись, не похожая на находку, отбрасывается: решает о мердже вердикт самого арбитра, а
 * эти находки — только то, что уйдёт карточками, если он блокера не воспроизведёт.
 */
export function ladderFindingsOf(
    detail: unknown,
    key: 'blocking' | 'cosmetic',
): ClassifiedFinding[] {
    if (!detail || typeof detail !== 'object') return [];
    const v = (detail as Record<string, unknown>)[key];
    if (!Array.isArray(v)) return [];
    return v.filter(
        (x: unknown): x is ClassifiedFinding =>
            !!x &&
            typeof x === 'object' &&
            typeof (x as ClassifiedFinding).key === 'string' &&
            !!(x as ClassifiedFinding).finding &&
            typeof (x as ClassifiedFinding).finding === 'object',
    );
}
