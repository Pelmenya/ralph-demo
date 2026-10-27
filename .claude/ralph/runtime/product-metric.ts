// Метрика продукта: доля задач, доведённых до мерджа в бюджет времени, и потери по причинам
// (план, Фаза 4; идея — открытые заметки Михаила Шогина, раздел «Внешние источники» PRD).
//
// ЗАЧЕМ. Преимущество автономного мерджа до сих пор было видно только словами: «петля
// ночью сдала фазу». Число, которое можно сравнить между неделями, отвечает на другой
// вопрос — какая доля взятого доходит до main вовремя и на чём теряется остальное.
//
// ИСТОЧНИК — ralph.log и state, а не журнал этапов, и это выбор: журнал держит только
// ТЕКУЩУЮ попытку и снимается с её концом, а метрике нужна история за период — она живёт
// в логе, который пишется на каждом шаге хореографии. Цена названа: разбор держится на ТЕКСТЕ строк
// раннера. Поэтому шаблоны, которые здесь читаются, сверяет тест с исходником оркестратора
// — поправленная формулировка краснеет там, а не превращает сводку в «исход неизвестен».
//
// ПРАВИЛО СЧЁТА — успехом считается только мердж. Задача без распознанного исхода идёт
// отдельной строкой «исход неизвестен», а не растворяется в успехах: метрика, которая молча
// округляет незнание в свою пользу, хуже её отсутствия.
//
// СЧЁТЧИК БАРЬЕРОВ — вторая половина сводки: сколько раз барьер остановил плохое. «Безопасный
// автономный мердж» иначе виден только словами. Считаются срабатывания, а не задачи: один
// красный чек на трёх кругах гейта — три срабатывания. Барьеры гейта узнаются по строкам
// `⛔ Гейт:` (`core/gate.ts`) — по НАЧАЛУ строки, а не по хвосту: хвост «— мердж отменён»
// общий у разных отказов, и новая строка с таким хвостом молча стала бы чужим барьером.
// Полноту держит тест: каждая строка `⛔ Гейт:` в исходнике гейта — либо барьер из
// `GATE_BARRIERS`, либо названный там не-барьер.
//
// БАРЬЕР И СТОП — РАЗНЫЕ ЧИСЛА. Сдаваясь после красного гейта, оркестратор пушит стоп с
// кодом причины по ТОМУ ЖЕ событию, что гейт уже записал строкой `⛔ Гейт:`. Первая версия
// счётчика складывала обе строки, и каждый терминальный отказ гейта считался дважды. Поэтому
// у каждой причины стопа названа роль (`STOP_ROLES`, `Record` — новая причина без роли не
// компилируется): барьер, который виден ТОЛЬКО стопом, идёт в сумму барьеров; стоп, у
// которого есть парная строка гейта, — нет; стоп петли (breaker, грязное дерево, тишина)
// барьером не является вовсе. Все стопы с кодом печатаются отдельным разделом «чем кончилось».
// ⛔-пуш без кода причины (инфраструктура, арбитр, «старт заблокирован») — не стоп и не
// барьер: петля по многим из них идёт дальше, и стопом он переписал бы исход задач.

import { REASON_TITLES, type TStopReason } from '../core/stop-message.ts';

// Барьеры гейта мерджа. Порядок ключей — порядок строк в сводке.
export const GATE_BARRIERS = {
    hold: "PR помечен 'hold'",
    'pr-blocked': "PR помечен 'blocked'",
    'gate-red': 'красный локальный чек',
    'gate-tool-failure': 'чек упал на инструменте',
    'forge-red': 'красный CI площадки',
    'forge-red-unnamed': 'красный CI площадки, упавший куб не назван',
    'forge-env': 'CI площадки: отказ среды или прерван',
    'forge-no-verdict': 'CI площадки без вердикта',
    'forge-required': 'политика required: подтвердить CI нечем',
} as const;

export type TGateBarrier = keyof typeof GATE_BARRIERS;

// Каждая строка узнаётся по своему началу. Три ветки `lastForgeStop` в gate.ts начинаются
// одинаково («чек PR #N»), и различает их следующее слово — там и якорь.
const GATE_LINE_RES: Array<[RegExp, TGateBarrier]> = [
    [/^⛔ Гейт: PR #\S+ помечен 'hold'/u, 'hold'],
    [/^⛔ Гейт: PR #\S+ помечен 'blocked'/u, 'pr-blocked'],
    [/^⛔ Гейт: куб .* красный на площадке/u, 'forge-red'],
    [/^⛔ Гейт: (?:куб .* по ОТКАЗУ СРЕДЫ|прогон .* ПРЕРВАН)/u, 'forge-env'],
    [/^⛔ Гейт: чек PR #\S+ у форжа не дал вердикта/u, 'forge-no-verdict'],
    [/^⛔ Гейт: чек PR #\S+ красный \(прогон/u, 'forge-red-unnamed'],
    [/^⛔ Гейт: чек PR #\S+: политика required/u, 'forge-required'],
    [/^⛔ Гейт: чек .* упал на инструменте/u, 'gate-tool-failure'],
    [/^⛔ Гейт: чек .* красный на PR/u, 'gate-red'],
];

/** Барьер гейта по тексту строки лога (без отметки времени); null — не барьер или незнакомая строка. */
export function classifyGateLine(body: string): TGateBarrier | null {
    for (const [re, key] of GATE_LINE_RES) if (re.test(body)) return key;
    return null;
}

/**
 * Роль причины стопа в счётчике барьеров:
 *   - `barrier` — барьер, который виден только стопом (своей строки `⛔ Гейт:` нет): идёт в
 *     сумму барьеров;
 *   - `paired` — стоп по событию, которое гейт уже записал своей строкой: в сумму не идёт,
 *     иначе один отказ считался бы дважды;
 *   - `loop` — стоп петли, а не пойманное плохое изменение: стена, грязное дерево, тишина.
 */
export const STOP_ROLES: Record<TStopReason, 'barrier' | 'paired' | 'loop'> = {
    // Строки гейта `куб … красный на площадке` / `ОТКАЗУ СРЕДЫ` / `чек PR #… у форжа …`.
    'platform-check-red': 'paired',
    // Строка гейта `чек … красный на PR` на каждом круге чини-сессий.
    'gate-red': 'paired',
    // Строка гейта `чек … упал на инструменте`.
    'gate-tool-failure': 'paired',
    // Спор ревью доходит до стопа через PR с меткой blocked — строка гейта `помечен 'blocked'`.
    'review-dispute': 'paired',
    // Ревью без вердикта и неподтверждённая метка ловятся ДО гейта: строки гейта нет.
    'review-no-verdict': 'barrier',
    'blocked-unconfirmed': 'barrier',
    'main-conflict': 'loop',
    'main-sync-failed': 'loop',
    // Коммиты сессии разбора пушит сам раннер (#85), так что расхождение, дошедшее до
    // гейта, — коллизия историй (ветку допушили снаружи, пуш сессии не доехал), а не
    // пойманное плохое изменение: стоп петли того же рода, что `session-unpushed`.
    'head-diverged': 'loop',
    // Пуш коммитов сессии разбора отвергнут ДО гейта: работа не потеряна и не плоха — стоп
    // петли, а не пойманное изменение.
    'session-unpushed': 'loop',
    'tree-dirty': 'loop',
    // Проба барьера перед сессией (ревью Фазы 12): хуки — из установки ядра, контур — из
    // дерева человека, а не из PR, так что стоп говорит о среде петли, а не о пойманном
    // изменении.
    'guard-probe': 'loop',
    // Раннер убит посреди применения намерения (#86): стоп петли, изменение тут ни при чём.
    'intent-unknown': 'loop',
    // #124: отвергнутый батч намерений не снялся в карантин — стоп петли, а не пойманное
    // изменение: файл отравил бы следующие сессии.
    'intent-rejected': 'loop',
    // Исход мерджа неизвестен (#53, #88): стоп петли на неподтверждённой операции форжа.
    'merge-unknown': 'loop',
    // #123: форж отказал в мердже — после зелёного гейта, то есть изменение не поймано, а
    // петля встала на площадке (конфликт, закрытый PR, затяжной сбой): стоп петли.
    'merge-failed': 'loop',
    // Журнал этапов (#92) повреждён или не пишется: стоп петли, изменение ни при чём.
    'stage-journal': 'loop',
    // #97: форж или git не прочитались серией — стоп петли, изменение ни при чём.
    'forge-unreadable': 'loop',
    // Фаза 10: карточка не по формату потребителя поймана до сессии — строки гейта у этого
    // барьера нет, он виден только стопом.
    'issue-format': 'barrier',
    breaker: 'loop',
    deadman: 'loop',
    unknown: 'loop',
};

export type TMetricEvent =
    | { at: number; kind: 'start'; milestone: string | null }
    | { at: number; kind: 'take'; milestone: string; issue: number }
    | { at: number; kind: 'close'; issue: number }
    | { at: number; kind: 'block'; issue: number }
    | { at: number; kind: 'merged'; milestone: string }
    | { at: number; kind: 'stop'; reason: TStopReason }
    | { at: number; kind: 'barrier'; barrier: TGateBarrier };

const LINE_RE = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\] (.*)$/u;
const TAKE_RE = /^🔄 (.+?) \| итерация \d+\/\d+ \| Issue #(\d+):/u;
const CLOSE_RE = /^✅ Issue #(\d+) закрыт по просьбе сессии\./u;
const BLOCK_RE = /^⛔ Issue #(\d+) помечен blocked/u;
const START_RE = /^🚀 Ralph start \|.*\| фаза "([^"]*)" \|/u;
// Мердж узнаётся по поимённо известным шаблонам, заякоренным на начало строки: пуш гейта
// («смерджена в main», «смерджена, но деплой красный» — с ⛔, но это всё равно мердж) и
// строки пути «фаза уже смерджена». Без якоря мерджем стала бы любая строка, процитировавшая
// это словосочетание, — заголовок PR, текст ревью. «не смерджена» не проходит: после
// кавычки стоит «не».
const MERGED_RE =
    /^(?:🔔 PUSH: (?:✅|⛔) Ralph: фаза|(?:✅|⛔) Фаза) "([^"]+)" (?:уже )?смерджена[ ,]/u;
// Стоп — только пуш с кодом причины в форме `formatStopMessage`. ⛔-пуш без кода стопом не
// считается (см. докблок модуля): незнакомый код — стоп с неустановленной причиной, а
// отсутствие кода — не стоп вовсе.
const STOP_PUSH_RE = /^🔔 PUSH: ⛔ .*причина: .*? \(([a-z-]+)\)\. /u;

function isStopReason(code: string): code is TStopReason {
    return Object.prototype.hasOwnProperty.call(REASON_TITLES, code);
}

/** Разбор лога в события сводки. Строки, которые сводке не нужны или не разобрались, пропускаются. */
export function parseLogEvents(text: string): TMetricEvent[] {
    const events: TMetricEvent[] = [];
    for (const line of text.split('\n')) {
        const m = LINE_RE.exec(line);
        if (!m) continue;
        const at = Date.parse(m[1]);
        if (!Number.isFinite(at)) continue;
        const body = m[2];
        let x: RegExpExecArray | null;
        const barrier = classifyGateLine(body);
        if (barrier) {
            events.push({ at, kind: 'barrier', barrier });
        } else if ((x = TAKE_RE.exec(body))) {
            events.push({ at, kind: 'take', milestone: x[1], issue: Number(x[2]) });
        } else if ((x = CLOSE_RE.exec(body))) {
            events.push({ at, kind: 'close', issue: Number(x[1]) });
        } else if ((x = BLOCK_RE.exec(body))) {
            events.push({ at, kind: 'block', issue: Number(x[1]) });
        } else if ((x = START_RE.exec(body))) {
            events.push({ at, kind: 'start', milestone: x[1] === '—' ? null : x[1] });
        } else if ((x = MERGED_RE.exec(body))) {
            events.push({ at, kind: 'merged', milestone: x[1] });
        } else if ((x = STOP_PUSH_RE.exec(body))) {
            // Код вне закрытого перечня — всё равно стоп: потерять строку значило бы отдать
            // задачу в «неизвестно», хотя петля честно сказала, что встала и почему.
            const code = x[1];
            events.push({ at, kind: 'stop', reason: isStopReason(code) ? code : 'unknown' });
        }
    }
    return events;
}

export type TOutcomeKey =
    | 'merged-in-budget'
    | 'merged-over-budget'
    | 'blocked'
    | `stop:${TStopReason}`
    | 'in-progress'
    | 'closed-unmerged'
    | 'unknown';

export type TMetricRow = { key: TOutcomeKey; label: string; count: number; issues: number[] };

export type TBarrierKey = TGateBarrier | `stop:${TStopReason}`;

export type TBarrierRow = { key: TBarrierKey; label: string; count: number };

export type TMetricSummary = {
    since: number;
    until: number;
    budgetMs: number;
    taken: number;
    mergedInBudget: number;
    // null при пустом периоде: «0 из 0» — не ноль процентов и не сто.
    share: number | null;
    rows: TMetricRow[];
    // Срабатывания барьеров за период: строка на каждый барьер гейта и на каждую причину
    // стопа с ролью `barrier`. Стоп с парной строкой гейта и стоп петли сюда не входят.
    barriers: TBarrierRow[];
    // Стопы петли с кодом причины за период — «чем кончилось», строка на каждую причину.
    stops: TBarrierRow[];
};

export type TSummarizeInput = {
    events: TMetricEvent[];
    budgetMs: number;
    since: number;
    until: number;
    // `milestone` из state: фаза, над которой петля работает сейчас. null — очередь пуста
    // или state нет; тогда ни одна незавершённая задача не может быть «в работе».
    currentMilestone: string | null;
};

type TTakes = { first: number; last: number; milestone: string };

/**
 * Исход каждой задачи, взятой в период. Порядок проверок — порядок приоритета:
 *   1. фаза задачи смерджена после её ПЕРВОГО взятия — в бюджет или сверх него (бюджет от
 *      первого взятия: повторный заход после падения сессии — тоже время задачи);
 *   2. сессия пометила задачу blocked после последнего захода;
 *   3. петля встала с причиной после последнего захода, и фазу после стопа никто не
 *      продолжил — стоп последнее слово. Перезапуск той же фазы стоп отменяет: потерей
 *      он становится, только если на нём всё и кончилось;
 *   4. фаза — текущая в state: задача в работе;
 *   5. задача закрыта после последнего захода, а фаза не смерджена: «закрыта, фаза не
 *      смерджена» — это известный факт, а не незнание, но и не успех;
 *   6. иначе исход неизвестен.
 * События позже `until` не учитываются: сводка за вчера не знает о сегодняшнем мердже.
 *
 * Один проход по событиям: лог многодневный и не ротируется, а панель считает сводку
 * синхронно в тике рядом с deadman, — проход по всему логу на каждую задачу был бы
 * O(задачи × лог). Взятия, блоки и закрытия группируются по задаче, мерджи, стопы и ход
 * петли — по фазе.
 */
export function summarizeTasks(input: TSummarizeInput): TMetricSummary {
    const { budgetMs, since, until, currentMilestone } = input;
    const events = input.events.filter((e) => e.at <= until).sort((a, b) => a.at - b.at);

    const takes = new Map<number, TTakes>();
    const lastBlock = new Map<number, number>();
    const lastClose = new Map<number, number>();
    const merges = new Map<string, number[]>();
    // Фаза события стопа — та, над которой петля шла в этот момент: последний старт или
    // взятие перед ним. В строке стопа фаза есть не всегда, а ход петли есть всегда.
    const lastStop = new Map<string, { at: number; reason: TStopReason }>();
    const lastActivity = new Map<string, number>();
    const taken = new Set<number>();
    let phaseNow: string | null = null;
    for (const e of events) {
        if (e.kind === 'start') {
            phaseNow = e.milestone;
            if (e.milestone !== null) lastActivity.set(e.milestone, e.at);
        } else if (e.kind === 'take') {
            phaseNow = e.milestone;
            lastActivity.set(e.milestone, e.at);
            const t = takes.get(e.issue);
            if (t) {
                t.last = e.at;
                t.milestone = e.milestone;
            } else {
                takes.set(e.issue, { first: e.at, last: e.at, milestone: e.milestone });
            }
            if (e.at >= since) taken.add(e.issue);
        } else if (e.kind === 'block') {
            lastBlock.set(e.issue, e.at);
        } else if (e.kind === 'close') {
            lastClose.set(e.issue, e.at);
        } else if (e.kind === 'merged') {
            merges.set(e.milestone, [...(merges.get(e.milestone) ?? []), e.at]);
        } else if (e.kind === 'stop' && phaseNow !== null) {
            lastStop.set(phaseNow, { at: e.at, reason: e.reason });
        }
    }

    const byKey = new Map<TOutcomeKey, number[]>();
    const put = (key: TOutcomeKey, issue: number) =>
        byKey.set(key, [...(byKey.get(key) ?? []), issue]);

    for (const issue of [...taken].sort((a, b) => a - b)) {
        const t = takes.get(issue)!;
        const phase = t.milestone;

        const mergedAt = merges.get(phase)?.find((at) => at >= t.first);
        if (mergedAt !== undefined) {
            put(mergedAt - t.first <= budgetMs ? 'merged-in-budget' : 'merged-over-budget', issue);
            continue;
        }
        if ((lastBlock.get(issue) ?? -Infinity) >= t.last) {
            put('blocked', issue);
            continue;
        }
        // Последний стоп фазы; активность фазы после него (перезапуск, новое взятие)
        // стоп отменяет. Стоп раньше последнего захода к задаче не относится.
        const stop = lastStop.get(phase);
        if (stop && stop.at >= t.last && !((lastActivity.get(phase) ?? -Infinity) > stop.at)) {
            put(`stop:${stop.reason}`, issue);
            continue;
        }
        if (phase === currentMilestone) {
            put('in-progress', issue);
            continue;
        }
        put((lastClose.get(issue) ?? -Infinity) >= t.last ? 'closed-unmerged' : 'unknown', issue);
    }

    const order: TOutcomeKey[] = [
        'merged-in-budget',
        'merged-over-budget',
        'blocked',
        ...(Object.keys(REASON_TITLES) as TStopReason[]).map((r): TOutcomeKey => `stop:${r}`),
        'in-progress',
        'closed-unmerged',
        'unknown',
    ];
    const rows = order.map((key) => {
        const issues = byKey.get(key) ?? [];
        return { key, label: rowLabel(key), count: issues.length, issues };
    });
    const mergedInBudget = byKey.get('merged-in-budget')?.length ?? 0;
    const inPeriod = events.filter((e) => e.at >= since);
    return {
        barriers: countBarriers(inPeriod),
        stops: countStops(inPeriod),
        since,
        until,
        budgetMs,
        taken: taken.size,
        mergedInBudget,
        share: taken.size === 0 ? null : mergedInBudget / taken.size,
        rows,
    };
}

const STOP_REASONS = Object.keys(REASON_TITLES) as TStopReason[];

function countBarriers(events: TMetricEvent[]): TBarrierRow[] {
    const counts = new Map<TBarrierKey, number>();
    const bump = (key: TBarrierKey) => counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const e of events) {
        if (e.kind === 'barrier') bump(e.barrier);
        else if (e.kind === 'stop' && STOP_ROLES[e.reason] === 'barrier') bump(`stop:${e.reason}`);
    }
    const gate = (Object.keys(GATE_BARRIERS) as TGateBarrier[]).map((key) => ({
        key,
        label: `${GATE_BARRIERS[key]} (${key})`,
        count: counts.get(key) ?? 0,
    }));
    const stops = STOP_REASONS.filter((r) => STOP_ROLES[r] === 'barrier').map((r) => {
        const key = `stop:${r}` as const;
        return { key, label: rowLabel(key), count: counts.get(key) ?? 0 };
    });
    return [...gate, ...stops];
}

function countStops(events: TMetricEvent[]): TBarrierRow[] {
    const counts = new Map<TStopReason, number>();
    for (const e of events) {
        if (e.kind === 'stop') counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
    }
    return STOP_REASONS.map((r) => {
        const key = `stop:${r}` as const;
        return { key, label: rowLabel(key), count: counts.get(r) ?? 0 };
    });
}

const sum = (rows: TBarrierRow[]) => rows.reduce((n, r) => n + r.count, 0);

function formatCounted(title: string, rows: TBarrierRow[]): string[] {
    // Ноль печатается: «барьеры молчали» — утверждение о периоде, а не пропуск.
    return [
        `${title}: ${sum(rows)}.`,
        ...rows.filter((r) => r.count > 0).map((r) => `  ${r.label}: ${r.count}`),
    ];
}

function rowLabel(key: TOutcomeKey): string {
    if (key === 'merged-in-budget') return 'смерджено в бюджет';
    if (key === 'merged-over-budget') return 'смерджено сверх бюджета';
    if (key === 'blocked') return 'blocked — ждёт человека';
    if (key === 'in-progress') return 'в работе';
    if (key === 'closed-unmerged') return 'закрыта, фаза не смерджена';
    if (key === 'unknown') return 'исход неизвестен';
    const reason = key.slice('stop:'.length) as TStopReason;
    return `стоп: ${REASON_TITLES[reason]} (${reason})`;
}

// Время и процент — контрактные строки обеих печатей; одна функция на каждую, чтобы
// правка одной печати не развела их.
function isoMinute(t: number): string {
    return new Date(t).toISOString().slice(0, 16) + 'Z';
}

function sharePct(s: TMetricSummary): number {
    return Math.round((s.share ?? 0) * 100);
}

/**
 * Сводка для человека. Нулевые строки опущены, кроме «исход неизвестен»: её ноль —
 * утверждение («все исходы распознаны»), и молчание о нём читалось бы как непроверенное.
 */
export function formatMetricSummary(s: TMetricSummary): string {
    const head = `📈 Сводка петли ${isoMinute(s.since)} — ${isoMinute(s.until)}, бюджет задачи ${Math.round(s.budgetMs / 60_000)} мин`;
    const lines = [head];
    if (s.taken === 0) {
        lines.push('За период задач не брали — доли нет.');
    } else {
        lines.push(
            `Взято задач: ${s.taken}. Доведено до мерджа в бюджет: ${s.mergedInBudget} из ${s.taken} (${sharePct(s)} %).`,
        );
        for (const r of s.rows) {
            if (r.count === 0 && r.key !== 'unknown') continue;
            const nums = r.issues.length > 0 ? ` — ${r.issues.map((n) => `#${n}`).join(' ')}` : '';
            lines.push(`  ${r.label}: ${r.count}${nums}`);
        }
    }
    lines.push(...formatCounted('Сработали барьеры', s.barriers));
    lines.push(...formatCounted('Остановки петли (чем кончилось)', s.stops));
    return lines.join('\n');
}

/**
 * Суточная строка для Telegram (план, Фаза 4): обе цифры метрики — доля задач, доведённых
 * до мерджа в бюджет, и число срабатываний барьеров (без стопов петли и без повторного
 * счёта стопа, парного строке гейта), — и рядом число стопов петли. Одна строка, потому
 * что раз в сутки человеку нужен пульс, а не отчёт: разбивку печатает команда.
 * Формат — контракт (тест сверяет строку целиком).
 */
export function formatMetricDayLine(s: TMetricSummary): string {
    const hours = Math.round((s.until - s.since) / 3_600_000);
    const share =
        s.taken === 0
            ? 'задач не брали'
            : `в бюджет ${s.mergedInBudget} из ${s.taken} (${sharePct(s)} %)`;
    return `📈 Метрика за ${hours} ч до ${isoMinute(s.until)}: ${share}, пойманных отказов ${sum(s.barriers)}, остановок петли ${sum(s.stops)}.`;
}

const NO_BUDGET = 'бюджет задачи не задан: в конфиге нет metrics.taskBudgetMin (минуты)';

/**
 * Бюджет времени задачи — `metrics.taskBudgetMin` резолвнутого конфига. Fail-closed:
 * без ключа сводки нет, потому что «в бюджет» без бюджета — это чьё-то умолчание, а
 * умолчание «как у нас» и есть спрятанная проектная специфика.
 */
export function resolveTaskBudgetMs(
    config: unknown,
): { ok: true; ms: number } | { ok: false; reason: string } {
    const metrics = (config as { metrics?: unknown } | null)?.metrics;
    if (
        metrics !== undefined &&
        (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics))
    ) {
        return { ok: false, reason: 'metrics в конфиге — не объект' };
    }
    const v = (metrics as { taskBudgetMin?: unknown } | undefined)?.taskBudgetMin;
    if (v === undefined) return { ok: false, reason: NO_BUDGET };
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        return {
            ok: false,
            reason: `metrics.taskBudgetMin = ${JSON.stringify(v)}: ожидалось положительное число минут`,
        };
    }
    return { ok: true, ms: v * 60_000 };
}
