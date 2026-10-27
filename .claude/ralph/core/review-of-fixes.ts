// #625: лестница «ревью правок» — второй проход ревью ПО САМИМ ПРАВКАМ, без остановки петли.
//
// ЗАЧЕМ. Правки по ревью — это код, написанный быстро, под конец сессии и без собственного
// ревью. На разборе 14.08 половина дефектов фазы нашлась именно в них, включая правку,
// которая молча убила фичу. Повторный проход в ядре был, но висел на метке `blocked`
// (см. #217/#223): блокеров не было — прохода не было, и правки по 19 замечаниям уехали
// в main никем не прочитанными (PR #624).
//
// ЦЕНА, КОТОРУЮ НЕЛЬЗЯ ПЛАТИТЬ. Больше качества — но НЕ ценой AFK. Ни бесконечного цикла
// «ревью → правки → ревью», ни остановки на человеке. Отсюда лестница, которую и считает
// этот модуль:
//
//   1. проход ревью правок идёт ПОСЛЕ ЛЮБЫХ правок, а не только при блокерах;
//   2. предмет прохода — только дифф правок (собирает оркестратор, здесь его нет);
//   3. потолок проходов; счётчик растёт ТОЛЬКО от прохода с НОВЫМИ blocker/major —
//      косметика цикл не продлевает;
//   4. мердж держат только blocker и major; незакрытые minor/nit уходят карточками;
//   5. на исчерпании потолка — независимый арбитр, а не стоп;
//   6. анти-пинг-понг: замечание, оспоренное дважды, становится карточкой с обеими
//      позициями и больше никого не держит.
//
// Модуль ЧИСТЫЙ: находки прохода + состояние лестницы → решение. Ни сессий, ни форжа, ни
// диска — их знает оркестратор. Так вся арифметика сходимости («три прохода с новыми major
// упираются в арбитра», «поток nit не продлевает цикл») проверяется тестом, а не прогоном
// петли.
//
// TS без билд-шага: erasable-only синтаксис (нативный type stripping Node 24).

// Словарь серьёзностей — контракт ревью-промпта (`prompts.ts`) и ЕДИНСТВЕННЫЙ источник
// правды о нём. Раньше тот же список вторым экземпляром лежал в метрике находок проекта,
// а сверял их тест ядра, импортируя проектный скрипт: в каноне такого скрипта нет вовсе,
// и барьер держался на чужом дереве. Теперь направление обратное — словарь экспортируется
// отсюда, а потребитель, считающий находки, сверяется с этим экспортом у себя.
//
// Порядок значим: от самого тяжёлого к самому лёгкому. Им же идёт разбор маркеров и по
// нему читаются сводки.
export const SEVERITY_LEVELS = ['blocker', 'major', 'minor', 'nit'] as const;

// Разметка серьёзности: КАЖДЫЙ комментарий ревью начинается строго с эмодзи+тега. Пара
// «маркер → уровень» обязана покрывать словарь целиком и в том же порядке — это сверяет
// `review-of-fixes.test.ts`, иначе новый уровень молча остался бы без маркера и все его
// находки читались бы как «без разметки».
const SEVERITY_MARKERS: ReadonlyArray<[string, FixSeverity]> = [
    ['🔴', 'blocker'],
    ['🟠', 'major'],
    ['🟡', 'minor'],
    ['⚪', 'nit'],
];

export type FixSeverity = 'blocker' | 'major' | 'minor' | 'nit' | null;

// Находка прохода в том виде, в каком её оставила сессия: намерение `pr-comment`
// (`session-requests.ts`). Якорь необязателен — без него это сводка прохода, а не находка.
export type FixFinding = { comment: string; anchor?: { path: string; line: number } };

// Потолок проходов лестницы. Три — как `blockedHealAttempts`: столько же кругов разбора
// петля уже отводит блокерам, и второй потолок другой величины читался бы как случайный.
export const FIX_REVIEW_MAX_PASSES = 3;

// Сколько раз одно и то же замечание может быть поднято ПОВТОРНО, прежде чем станет
// карточкой с обеими позициями. Два повтора = стороны высказались дважды каждая; третий
// круг спора — это уже пинг-понг, и решать его должен человек, а не следующий проход.
export const FIX_REVIEW_MAX_DISPUTES = 2;

// Абсолютный предохранитель на число кругов. Потолок `passes` считает только проходы с
// НОВЫМИ блокерами (п.3 лестницы), поэтому сам по себе он не ограничивает круги, где
// мердж держат ПОВТОРНЫЕ замечания: их гасит анти-пинг-понг, но не мгновенно. Верхняя
// граница обоих механизмов вместе — величина конечная, но выводимая; такой ей быть нельзя
// (инвариант №1: fail-closed там, где решается мердж). Множитель 2 даёт запас на законные
// круги спора и при этом гарантирует завершение арбитром, а не «когда-нибудь».
export const FIX_REVIEW_ROUND_FACTOR = 2;

export function severityOf(body: unknown): FixSeverity {
    if (typeof body !== 'string') return null;
    const trimmed = body.trim();
    for (const [marker, severity] of SEVERITY_MARKERS) {
        if (trimmed.startsWith(marker)) return severity;
    }
    return null;
}

// Мердж держат только blocker и major (п.4 лестницы). minor/nit важны, но их место —
// карточка бэклога, а не отложенный на утро мердж.
export function isBlockingSeverity(severity: FixSeverity): boolean {
    return severity === 'blocker' || severity === 'major';
}

// Порядок уровней от самого серьёзного к самому мелкому — тот же, что у
// `SEVERITY_MARKERS` выше и у `SEVERITY_LEVELS` из `scripts/review-findings.mjs` (#110).
// Дубль неизбежен по той же причине, что и у `SEVERITY_MARKERS`: `scripts/*.mjs` в core не
// импортируется (раннер обязан работать до `npm ci`), а совпадение с метрикой сторожит тест
// (`review-of-fixes.test.ts`). Экспортирован отдельно от `SEVERITY_MARKERS`, потому что
// `config-profile.ts` валидирует по нему конфиг и эмодзи ему не нужны.
export const FIX_SEVERITY_LEVELS: ReadonlyArray<Exclude<FixSeverity, null>> = [
    'blocker',
    'major',
    'minor',
    'nit',
];

// Порог серьёзности карточек лестницы (#110). Дренаж накопителя короче производства
// косметики: замер 01.09.2026 — 29 карточек за два дня, разобрано ноль, больше половины —
// `minor`/`nit`. Порог режет заведение карточки, но НЕ решение о мердже (его держат только
// `isBlockingSeverity`, см. выше — это не двигается ни на шаг) и НЕ анти-пинг-понг
// (`pingPongIssueFor` зовётся отдельно и порога не видит: там зафиксировано разногласие
// ДВУХ ревью, а не серьёзность самой находки).
//
// `floor` не задан (undefined/null) → true всегда: это выключатель, а не дефолт-фильтр —
// механизм РЕШАЕТ, что находка будет ПОТЕРЯНА для трекера (комментарий на PR она
// остаётся, в счёт журнала тоже — эти два канала фильтру не подчинены), и тихо включённым
// он быть не может, тот же принцип, что у `backlogStaleDays`.
//
// Находка без метки (unmarked — например, разметка потерялась) порогом не режется: без
// известной серьёзности сравнивать не с чем, и раз потерять находку, у которой даже
// разметка съехала, дороже, чем оставить лишнюю карточку.
export function meetsSeverityFloor(
    severity: FixSeverity,
    floor: FixSeverity | null | undefined,
): boolean {
    if (!floor) return true;
    if (!severity) return true;
    const severityRank = FIX_SEVERITY_LEVELS.indexOf(severity);
    const floorRank = FIX_SEVERITY_LEVELS.indexOf(floor);
    // Незнакомый уровень порога валит старт снаружи (assertValidReviewBacklog,
    // config-profile.ts) — но эта функция чистая и экспортирована сама по себе, и её
    // самый дорогой отказ — потерять находки молча. indexOf на неизвестном значении даёт
    // -1, и без этой ветки `severityRank <= -1` было бы ложным для ЛЮБОЙ находки —
    // функция без единого известного уровня отфильтровала бы всё. Fail-open здесь
    // безопаснее: конфиг снаружи уже проверен, а функция всё равно не должна тихо стать
    // «карточек не заводить никогда».
    if (floorRank === -1) return true;
    return severityRank <= floorRank;
}

// Ключ находки для дедупа между проходами: ФАЙЛ + нормализованный текст.
//
// Номера строки в ключе НЕТ намеренно (ревью #625). Круг лестницы — это коммит в тот же
// файл, после которого то же самое место почти всегда имеет другой `line`: ключ с номером
// строки промахивался бы ровно там, где дедуп и нужен, повтор читался бы как свежая
// находка (двигал потолок `passes`), а карточка спора с обеими позициями требовала бы трёх
// предъявлений с совпавшим номером строки — то есть была бы практически недостижима.
// Файл переживает правку, номер строки — нет.
//
// Текст берём нормализованным и обрезанным: полная строка сделала бы ключ хрупким к любой
// запятой, а одного файла мало — в файле бывает несколько разных замечаний. Цена
// ослабления: два РАЗНЫХ замечания в одном файле, сформулированных первыми 120 символами
// одинаково, склеятся в одно. Размен осознанный — склейка стоит одной потерянной находки,
// промах дедупа стоил бы неработающего анти-пинг-понга.
//
// Ключ намеренно НЕ включает severity: понижение тем же ревью «🔴 → 🟡» того же места —
// это тот же спор, а не новая находка, и продлевать им цикл нельзя.
export function findingKey(finding: FixFinding): string {
    const anchor = finding.anchor ? finding.anchor.path : '-';
    const text = String(finding.comment ?? '')
        // Маркер серьёзности из ключа выбрасываем по той же причине: «тот же дефект,
        // другая оценка» — не новая находка.
        .replace(/^\s*(?:🔴|🟠|🟡|⚪)\s*(?:\[[a-z]+\])?\s*/u, '')
        .toLowerCase()
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 120);
    return `${anchor}|${text}`;
}

// Состояние лестницы, переживающее рестарт раннера (лежит в `ralph.state.json`).
export type ReviewOfFixesState = {
    // Проходы, засчитанные потолку: только те, что принесли НОВЫЕ blocker/major.
    passes: number;
    // Все круги «правки → ревью правок» фазы — предохранитель FIX_REVIEW_ROUND_FACTOR.
    rounds: number;
    // Ключи находок, уже предъявленных в этой фазе (база дедупа).
    answered: string[];
    // Ключ → сколько раз находка предъявлена ПОВТОРНО (после ответа на неё).
    disputes: Record<string, number>;
    // Ключи, спор по которым закрыт карточкой: больше не блокируют и не считаются.
    settled: string[];
    // Независимый арбитр уже отработал — второй раз его не зовём.
    arbitrated: boolean;
};

export function emptyReviewOfFixes(): ReviewOfFixesState {
    return { passes: 0, rounds: 0, answered: [], disputes: {}, settled: [], arbitrated: false };
}

// Нормализация того, что прочитано с диска. State пишет прошлая версия раннера (поля могло
// не быть вовсе) и правит рукой человек — форма здесь не гарантирована ничем, а решение по
// ней принимается о мердже. Кривое значение не роняет петлю, а трактуется как «лестница
// ещё не начиналась»: потеря счётчика в сторону лишнего прохода дешевле, чем в сторону
// пропущенного.
export function normalizeReviewOfFixes(value: unknown): ReviewOfFixesState {
    const empty = emptyReviewOfFixes();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
    const v = value as Record<string, unknown>;
    const int = (x: unknown): number =>
        Number.isInteger(x) && (x as number) >= 0 ? (x as number) : 0;
    const keys = (x: unknown): string[] =>
        Array.isArray(x) ? x.filter((k): k is string => typeof k === 'string' && !!k.trim()) : [];
    const disputes: Record<string, number> = {};
    if (v.disputes && typeof v.disputes === 'object' && !Array.isArray(v.disputes)) {
        for (const [k, n] of Object.entries(v.disputes as Record<string, unknown>)) {
            if (typeof k === 'string' && k.trim() && Number.isInteger(n) && (n as number) > 0) {
                disputes[k] = n as number;
            }
        }
    }
    return {
        passes: int(v.passes),
        rounds: int(v.rounds),
        answered: keys(v.answered),
        disputes,
        settled: keys(v.settled),
        arbitrated: v.arbitrated === true,
    };
}

export type Counts = {
    blocker: number;
    major: number;
    minor: number;
    nit: number;
    unmarked: number;
    total: number;
};

// Счёт по severity ровно в форме журнала находок (`scripts/review-findings-journal.mjs`):
// `total` — все учтённые комментарии, включая unmarked, инвариант total = сумма частей
// проверяет сам журнал. Считаем ЗДЕСЬ, а не в скрипте: скрипт умеет считать только «все
// комментарии PR», а нам нужен счёт ИМЕННО этого прохода — иначе «сколько дефектов нашлось
// в правках» из журнала не прочитать.
export function countsOf(findings: ReadonlyArray<FixFinding>): Counts {
    const counts: Counts = { blocker: 0, major: 0, minor: 0, nit: 0, unmarked: 0, total: 0 };
    for (const f of findings) {
        const severity = severityOf(f.comment);
        if (severity) counts[severity] += 1;
        else counts.unmarked += 1;
        counts.total += 1;
    }
    return counts;
}

export type ClassifiedFinding = { finding: FixFinding; severity: FixSeverity; key: string };

export type FixReviewClassification = {
    // Находки, предъявленные впервые.
    fresh: ClassifiedFinding[];
    // Из них blocking (blocker/major) — ровно они двигают потолок.
    freshBlocking: ClassifiedFinding[];
    // Новые minor/nit — карточки бэклога, цикл не продлевают.
    cosmetic: ClassifiedFinding[];
    // Повторно предъявленные minor/nit, спор по которым ещё не закрыт: сессия правок их
    // уже видела и не приняла. Мердж они не держат (п.4), но и потеряться не должны —
    // иначе «minor не держит мердж» превращается в «minor не делается никогда»: свежую
    // косметику разбирает следующий круг правок, а отклонённую — уже никто.
    repeatedCosmetic: ClassifiedFinding[];
    // Повторно предъявленные blocking, спор по которым ещё не закрыт: мердж держат, но
    // потолок НЕ двигают (иначе несогласие ревью с собой считалось бы новой работой).
    repeatedBlocking: ClassifiedFinding[];
    // Спор дошёл до предела — карточка с обеими позициями, дальше не блокирует.
    pingPong: ClassifiedFinding[];
    // Ключи, спор по которым уже закрыт: учтены только в логе.
    ignored: ClassifiedFinding[];
    // Состояние лестницы ПОСЛЕ прохода (счётчики, дедуп, споры).
    next: ReviewOfFixesState;
};

// Разбор одного прохода ревью правок. Порядок ветвей — это и есть п.3/п.6 лестницы:
// закрытый спор не считается ничем, повтор идёт в споры (и однажды — в карточку), и только
// впервые увиденное замечание может быть «новым».
export function classifyFixReview(
    findings: ReadonlyArray<FixFinding>,
    state: ReviewOfFixesState,
    { maxDisputes = FIX_REVIEW_MAX_DISPUTES }: { maxDisputes?: number } = {},
): FixReviewClassification {
    const answered = new Set(state.answered);
    const settled = new Set(state.settled);
    const disputes: Record<string, number> = { ...state.disputes };

    const fresh: ClassifiedFinding[] = [];
    const cosmetic: ClassifiedFinding[] = [];
    const repeatedCosmetic: ClassifiedFinding[] = [];
    const freshBlocking: ClassifiedFinding[] = [];
    const repeatedBlocking: ClassifiedFinding[] = [];
    const pingPong: ClassifiedFinding[] = [];
    const ignored: ClassifiedFinding[] = [];
    // Дубль ВНУТРИ одного прохода (ревью дважды сказало то же самое) считаем один раз:
    // иначе повтор в пределах прохода выглядел бы как спор с самим собой.
    const seenThisPass = new Set<string>();

    for (const finding of findings) {
        // Сводка прохода (комментарий без якоря) — не находка: у форжа именно якорь
        // отличает замечание к коду от обзора, и метрика считает так же (#37/#168).
        if (!finding.anchor) continue;
        const key = findingKey(finding);
        const severity = severityOf(finding.comment);
        const item: ClassifiedFinding = { finding, severity, key };
        if (seenThisPass.has(key)) continue;
        seenThisPass.add(key);

        if (settled.has(key)) {
            ignored.push(item);
            continue;
        }
        if (answered.has(key)) {
            const n = (disputes[key] ?? 0) + 1;
            disputes[key] = n;
            if (n >= maxDisputes) {
                settled.add(key);
                pingPong.push(item);
            } else if (isBlockingSeverity(severity)) {
                repeatedBlocking.push(item);
            } else {
                repeatedCosmetic.push(item);
            }
            continue;
        }
        answered.add(key);
        fresh.push(item);
        if (isBlockingSeverity(severity)) freshBlocking.push(item);
        else cosmetic.push(item);
    }

    return {
        fresh,
        freshBlocking,
        cosmetic,
        repeatedCosmetic,
        repeatedBlocking,
        pingPong,
        ignored,
        next: {
            // Потолок двигают ТОЛЬКО новые blocker/major (п.3): поток свежих nit не
            // продлевает цикл, и повторное несогласие — тоже.
            passes: state.passes + (freshBlocking.length > 0 ? 1 : 0),
            rounds: state.rounds + 1,
            answered: [...answered],
            disputes,
            settled: [...settled],
            arbitrated: state.arbitrated,
        },
    };
}

export type FixReviewDecision =
    // Держать нечем — лестница закончена, фаза идёт на гейт.
    | { action: 'merge'; reason: string }
    // Есть blocker/major — ещё один круг правок.
    | { action: 'fix'; reason: string; blocking: ClassifiedFinding[] }
    // Потолок исчерпан — независимый арбитр вместо стопа человеку.
    | { action: 'arbiter'; reason: string; blocking: ClassifiedFinding[] };

// Решение по итогам прохода. `blocked` — сессия ещё и попросила метку (`pr-block`): это
// самостоятельный сигнал «мердж держать», даже если разметку severity она перепутала.
export function decideAfterFixReview(
    classification: FixReviewClassification,
    {
        blocked = false,
        maxPasses = FIX_REVIEW_MAX_PASSES,
        roundFactor = FIX_REVIEW_ROUND_FACTOR,
    }: { blocked?: boolean; maxPasses?: number; roundFactor?: number } = {},
): FixReviewDecision {
    const { freshBlocking, repeatedBlocking, next } = classification;
    const blocking = [...freshBlocking, ...repeatedBlocking];
    if (!blocking.length && !blocked) {
        return { action: 'merge', reason: 'блокирующих находок в правках нет' };
    }
    if (next.arbitrated) {
        // Арбитр уже высказался в этой фазе. Второй раз его звать не о чем — а держать
        // фазу дальше значит вернуть ровно тот стоп, ради отмены которого он и заведён.
        return {
            action: 'merge',
            reason: 'независимый арбитр по этой фазе уже отработал — второй раз петлю не крутим',
        };
    }
    if (next.passes >= maxPasses) {
        return {
            action: 'arbiter',
            reason: `потолок проходов с новыми blocker/major исчерпан (${String(next.passes)}/${String(maxPasses)})`,
            blocking,
        };
    }
    if (next.rounds >= maxPasses * roundFactor) {
        return {
            action: 'arbiter',
            reason: `кругов ревью правок ${String(next.rounds)} при потолке проходов ${String(maxPasses)} — спор не сходится сам`,
            blocking,
        };
    }
    return {
        action: 'fix',
        reason: blocked
            ? 'сессия ревью правок попросила блок'
            : `блокирующих находок в правках: ${String(blocking.length)}`,
        blocking,
    };
}

export type BacklogIssue = { title: string; body: string; labels: string[] };

// Обрезка заголовка карточки: заголовок форжа не резиновый, а находка ревью бывает абзацем.
function titleFrom(text: string, limit = 90): string {
    const flat = text.replace(/\s+/gu, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function anchorOf(finding: FixFinding): string {
    return finding.anchor ? `${finding.anchor.path}:${String(finding.anchor.line)}` : 'без якоря';
}

// Незакрытая косметика (п.4): мердж её не ждёт, но и потерять её нельзя — иначе «minor не
// держит мердж» на практике означает «minor не делается никогда». Ссылка на место — номер
// PR и якорь: у комментария форжа своего адреса петля не знает (шов его не отдаёт), а
// пара «PR + файл:строка» находит его однозначно.
// `context` не украшение: карточка объясняет, ПОЧЕМУ замечание не остановило фазу, и для
// двух путей причина РАЗНАЯ. Косметика не держит мердж по правилу; блокирующая находка,
// пережившая потолок проходов, не держит его потому, что независимый арбитр её не
// воспроизвёл. Один текст на оба случая соврал бы в одном из них — а карточку читает
// человек, который решает, что с находкой делать.
// Заголовки карточек лестницы — не украшение, а ПРИЗНАК авторства (#18). По ним чистка
// протухшего отличает свою косметику от карточки, заведённой человеком в той же вехе:
// метки для этого не годятся (человек ставит те же), а автор — тем более (раннер коммитит
// под аккаунтом инженера). Меняешь текст — ломаешь чистку, поэтому он константа.
export const BACKLOG_TITLE_PREFIX = 'Ревью правок: ';
export const DISPUTE_TITLE_PREFIX = 'Спор ревью и правок: ';

/**
 * Машинный признак авторства карточки косметики (#18, ревью).
 *
 * Заголовка мало: его набирает и человек. «Ревью правок: проверить миграцию», заведённое
 * руками в накопительной вехе, старше порога — и чистка закрыла бы чужую карточку, а это
 * необратимо. Маркер живёт в ТЕЛЕ, невидим в отрендеренном markdown и в заголовке не
 * повторяется, поэтому случайно воспроизвести его нельзя.
 *
 * Ставится ТОЛЬКО на косметику. У карточки спора его нет намеренно: спор решает человек,
 * и «срок годности» к нему не применяется ни при каком пороге.
 *
 * Карточки, заведённые ДО этой правки, маркера не имеют и под чистку не попадут никогда —
 * осознанная цена миграции: их несколько десятков, и закрыть их руками дешевле, чем
 * ослаблять признак ради разовой уборки.
 */
export const LADDER_CARD_MARKER = '<!-- ralph:ladder-card -->';

export function backlogIssueFor(
    item: ClassifiedFinding,
    {
        milestone,
        pr,
        labels = [],
        context = 'cosmetic',
    }: {
        milestone: string;
        pr: number | null;
        labels?: string[];
        context?: 'cosmetic' | 'arbiter';
    },
): BacklogIssue {
    const where = anchorOf(item.finding);
    const ref = pr ? `PR #${String(pr)}, комментарий ревью правок к ${where}` : `место: ${where}`;
    const why =
        context === 'arbiter'
            ? `Серьёзность по мнению ревью: ${item.severity ?? 'без метки'}. Мердж фазы это ` +
              `замечание не остановило: потолок проходов ревью правок был исчерпан, и независимый ` +
              `арбитр (сильнейшая модель, без истории предыдущих проходов) блокирующего дефекта ` +
              `в правках не воспроизвёл. Спорная находка сохранена карточкой, а не потеряна.`
            : `Серьёзность: ${item.severity ?? 'без метки'} — мердж фазы такие замечания не держат ` +
              `(держат только blocker и major), поэтому оно заведено карточкой, а не остановило петлю.`;
    return {
        title: titleFrom(`${BACKLOG_TITLE_PREFIX}${item.finding.comment}`),
        body:
            `Замечание ревью ПРАВОК по фазе «${milestone}» осталось незакрытым на момент мерджа.\n\n` +
            `${why}\n\n` +
            `Источник: ${ref}.\n\n` +
            `Текст замечания:\n\n${item.finding.comment}\n\n` +
            `Критерий готовности: замечание либо исправлено в ${where}, либо карточка закрыта ` +
            `с обоснованием, почему правка неверна.\n\n${LADDER_CARD_MARKER}`,
        labels,
    };
}

// Спор, заведённый в карточку (п.6). Обе позиции — в теле: сама находка и то, что о ней
// уже сказано. Разрешает спор человек; петля к нему больше не возвращается.
export function pingPongIssueFor(
    item: ClassifiedFinding,
    {
        milestone,
        pr,
        disputes,
        labels = [],
    }: { milestone: string; pr: number | null; disputes: number; labels?: string[] },
): BacklogIssue {
    const where = anchorOf(item.finding);
    const ref = pr ? `PR #${String(pr)} (${where})` : where;
    return {
        title: titleFrom(`${DISPUTE_TITLE_PREFIX}${item.finding.comment}`),
        body:
            `Замечание по фазе «${milestone}» предъявлено повторно ${String(disputes)} раз(а): ревью ` +
            `настаивает, правки его не приняли. Петля такие споры не докручивает — третий круг ` +
            `«ревью → правки → ревью» стоит дороже, чем решение человека.\n\n` +
            `Позиция ревью (${where}):\n\n${item.finding.comment}\n\n` +
            `Позиция правок: см. ответы кодер-сессии в ${ref} — на каждое непринятое замечание ` +
            `она обязана оставить обоснование.\n\n` +
            `Критерий готовности: одна из позиций принята явно — правка внесена либо карточка ` +
            `закрыта с объяснением, почему замечание неверно.`,
        labels,
    };
}

// Признак заголовка карточки, заведённой ЛЕСТНИЦЕЙ, — оба префикса разом. Спор
// исключается из чистки дальше, отдельным условием: см. `staleLadderCards`.
const LADDER_TITLE_PREFIXES = [BACKLOG_TITLE_PREFIX, DISPUTE_TITLE_PREFIX];

// Бюджет чистки протухшего за один прогон (#18).
//
// Раньше своего числа у него не было: он молча брался равным `BACKLOG_MILESTONE_CAP`, и
// это читалось как экономия — «больше, чем в веху влезает, чистить не за чем». Но у вехи
// потолок отвечает за размер диффа, а тут число отвечает за РАЗМАХ МУТАЦИИ: сколько чужих
// карточек механизм имеет право закрыть, если ошибётся порог или часы. У вехи-накопителя,
// которой потолок не нужен вовсе, первое рассуждение разваливается, а второе остаётся, —
// и человек, поднявший потолок до пятисот ради вместимости, поднимал заодно и размах.
// Поэтому число своё, и по умолчанию оно НЕ следует за потолком.
export const BACKLOG_STALE_BUDGET = 5;

// Срок годности карточек лестницы (#18).
//
// ЗАЧЕМ. Адрес решает, ГДЕ лежит косметика, но не решает, что её заводится больше, чем
// разбирается. Замечание, пролежавшее несколько фаз, почти наверняка не будет сделано
// никогда: код ушёл вперёд, и «поправить пробел» относится уже к другому коду. Честнее
// закрыть его с причиной, чем держать вечно открытым, — иначе получается свалка поменьше,
// но с адресом.
//
// ЧТО ЭТА ФУНКЦИЯ НЕ ДЕЛАЕТ. Она ничего не мутирует и ни к какому форжу не ходит: отдаёт
// номера кандидатов. Мутация чужих карточек — решение вызывающего, и её предел, выключатель
// и след живут там же.
//
// ЧЕТЫРЕ ОТКАЗА ТРОГАТЬ КАРТОЧКУ, и каждый — про цену ошибки:
//
//   - порог не задан (или ноль) — чистки нет вовсе. У механизма, закрывающего чужие
//     карточки, тихого дефолта быть не должно;
//   - заголовок не наш — карточку завёл человек, и срок годности к ней не относится.
//     ЗАГОЛОВКА ОДНОГО МАЛО: он набирается руками, поэтому это лишь дешёвый предфильтр,
//     а последнее слово за маркером в теле (`LADDER_CARD_MARKER`) — его проверяет
//     вызывающий, потому что тело карточки в списке очереди не приходит;
//   - заголовок спора — спор решает человек, а не календарь: там blocker или major,
//     который не развели два ревью и арбитр. Карточка лестницы узнаётся по ОБОИМ
//     префиксам, и спор отсекается отдельной строкой НАМЕРЕННО (ревью правок #98):
//     сегодня `DISPUTE_TITLE_PREFIX` не начинается с `BACKLOG_TITLE_PREFIX`, и на одном
//     предфильтре спор отсекался бы сам — то есть защита стояла бы не там, где её ищут,
//     и переживала бы удаление собственной строки. Заголовки заводит один и тот же
//     механизм, и общий префикс у них — правка одной строки;
//   - даты нет или она не разобралась — «не знаю возраст» не повод закрывать.
export function staleLadderCards({
    issues,
    now,
    staleDays,
    limit = Number.POSITIVE_INFINITY,
}: {
    issues: readonly { number: number; title: string; createdAt?: string }[];
    now: number;
    staleDays?: number;
    limit?: number;
}): number[] {
    if (!staleDays || staleDays <= 0) return [];
    const out: number[] = [];
    for (const issue of issues) {
        if (out.length >= limit) break;
        if (!LADDER_TITLE_PREFIXES.some((prefix) => issue.title.startsWith(prefix))) continue;
        if (issue.title.startsWith(DISPUTE_TITLE_PREFIX)) continue;
        const created = issue.createdAt ? Date.parse(issue.createdAt) : Number.NaN;
        if (!Number.isFinite(created)) continue;
        // Строго больше: ровно порог — ещё не протухла. Граница принадлежит карточке,
        // потому что на ней срабатывает МУТАЦИЯ, и ошибиться в её сторону дороже.
        if (now - created > staleDays * 24 * 60 * 60 * 1000) out.push(issue.number);
    }
    return out;
}

// АДРЕС накопительной вехи для карточек этого модуля (`BACKLOG_MILESTONE_CAP`,
// `pickBacklogMilestone`, `createBacklogAddress`, `backlogCandidates`) — в
// `core/backlog-address.ts` (#98). Канал общий с намерением `new-issue` кодер-сессии,
// а к арифметике ЛЕСТНИЦЫ он отношения не имеет. Чистка протухшего осталась ЗДЕСЬ
// (`staleLadderCards`, выше): она узнаёт карточку по заголовку, то есть по признаку
// авторства лестницы, — уехав, она тянула бы префиксы за собой импортом и делала бы
// «общий» модуль адреса зависимым от арифметики лестницы (ревью правок #98).
