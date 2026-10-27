// #40: намерения кодер-сессии по отношению к трекеру.
//
// Сессия в трекер НЕ ходит. Она пишет намерение строкой в файл-запрос, а мутацию делает
// петля через шов `TaskSourceAdapter`. Причины две, и обе структурные:
//
//   - БЕЗОПАСНОСТЬ (#2): чтобы сессия могла закрыть issue сама, ей нужен токен форжа в
//     окружении — а вместе с ним и всё остальное, что этим токеном делается, включая
//     одобрение собственного PR. Барьер, который агент может обойти, охраняет пустоту.
//   - ПЕРЕНОСИМОСТЬ (#36): «закрой issue» — намерение, `gh issue close` — способ. Способ
//     живёт в адаптере, где у каждого форжа свой; промпт остаётся верным на любой площадке.
//
// Модуль ЧИСТЫЙ: текст → список намерений. Ни чтения файла, ни сети — это работа
// оркестратора. Так разбор проверяется без побочек, а применение — отдельно.
//
// Разбор fail-closed во всём: файл пишет модель, которая читала тело чужого issue (C3),
// и неожиданная форма данных здесь обязана быть отказом, а не «пропустим эту строку».

import { checkIssueFormat, describeFormatViolations, type TIssueFormat } from './issue-format.ts';
import { MERGE_TRANSIENT_RE } from './merge-retry.ts';
import { formatStopMessage } from './stop-message.ts';

// Что сессия имеет право попросить. Список ЗАКРЫТЫЙ и намеренно короткий: снятие `hold`,
// одобрение ревью (ship/decision) и мердж в него не входят и входить не могут — это
// решения человека и петли, а не сессии. Новое намерение добавляется вместе с методом
// шва и тестом, а не строкой в этот union.
export type TSessionRequest =
    | { kind: 'comment' | 'close' | 'block'; issue: number; comment: string }
    | { kind: 'new-issue'; title: string; body: string; labels: string[] }
    // #45: намерения ревью-сессии по PR СВОЕЙ фазы. Номера PR в них нет намеренно — не
    // забывчивость, а граница: сессия не выбирает, какой PR комментировать, его знает
    // петля. Иначе к списку намерений добавилась бы возможность писать в любой PR
    // репозитория, включая чужие.
    // Якорь — ВЛОЖЕННЫЙ объект, а не два независимых поля: «либо оба, либо ни одного» —
    // это инвариант, и в типе он выражается структурой, а не договорённостью с парсером.
    | { kind: 'pr-comment'; comment: string; anchor?: TRequestAnchor }
    | { kind: 'pr-block'; comment: string };

// Сторона диффа у якоря (#41). Удалённая строка живёт только в СТАРОЙ версии файла, и
// замечание к ней с прошитой новой стороной форж либо отвергал, либо вешал на строку с
// тем же номером в новой версии — то есть на чужой код. Поле необязательно: молчание
// означает новую сторону, как было до него, — замечаний о добавленном и неизменённом
// коде подавляющее большинство.
export type TDiffSide = 'LEFT' | 'RIGHT';
export type TRequestAnchor = { path: string; line: number; side?: TDiffSide };
const DIFF_SIDES: readonly string[] = ['LEFT', 'RIGHT'];

// #603: предел считает КЛАССЫ намерений раздельно, а не кучей. Инцидент PR #601 —
// ревью честно нашло 23 замечания (1 major, 6 minor, 16 nit + сводка), все `pr-comment`,
// ни одной мутации — и батч отвергло целиком: большой отревьюенный PR закономерно даёт
// много замечаний, и чем дотошнее ревью, тем вернее оно упирается в общий предохранитель.
//
// Мутации — то, что меняет состояние проекта: закрывает/блокирует карточку, заводит
// новую, ставит блокер на PR. Именно они опасны при сорвавшейся сессии (штампует их
// пачками), и предел на них остаётся жёстким.
const MUTATION_KINDS = ['close', 'block', 'new-issue', 'pr-block'] as const;
// Комментарии ничего не закрывают, не блокируют и не создают сущностей — это текст в
// ленте PR или карточки. Судить о сорвавшейся сессии по их числу — как судить о буйстве
// по количеству сказанных слов.
const COMMENT_KINDS = ['comment', 'pr-comment'] as const;

// Предохранитель от сорвавшейся сессии: десятки мутаций, наделанных за одну итерацию,
// разгребаются дороже, чем один отказ с внятной причиной.
export const MAX_MUTATION_REQUESTS = 20;
// Заметно больше: комментарий стоит строки в ленте, а не состояния проекта — тесный
// предел здесь ловит не сорвавшуюся сессию, а просто дотошное ревью.
//
// Ревью #612: потолок соразмерен ПРОПУСКНОЙ СПОСОБНОСТИ форжа, а не только вкусу. У GitHub
// на создание контента отдельный secondary rate limit (порядка 80 создающих запросов в
// минуту и жёстче — в час), а применение поштучное: батч в 200 комментариев упирался бы в
// стену где-то в середине, и человек получал бы пуш «намерение не применилось» с
// транспортной ошибкой. 100 — вчетверо больше самого дотошного из виденных ревью (23
// находки на PR #601) и в пределах часового окна форжа; ровность потока держит пауза в
// applySessionRequests (orchestrator.ts).
export const MAX_COMMENT_REQUESTS = 100;
// Грубая ранняя граница на объём файла — ДО единого JSON.parse. Точный раздельный счёт по
// классам возможен только после разбора, но разбирать сорвавшийся батч на 100 000 строк
// целиком (каждая — parse + валидация, комментарий до 10 000 символов), чтобы потом его
// отвергнуть, незачем. Второй довод — диагноз: среди тысяч строк почти наверняка найдётся
// кривая, и человек читал бы «строка 137: ожидался объект JSON» вместо «сессия сорвалась».
export const MAX_REQUEST_LINES = MAX_MUTATION_REQUESTS + MAX_COMMENT_REQUESTS;
// Не предел, а водораздел для лога (не отказ): столько комментариев в батче — не срыв,
// но повод сказать человеку «PR/фаза великоват(а)», тем же числом, что раньше отвергало
// батч целиком.
export const COMMENT_NOTICE_THRESHOLD = 20;

// Классификация намерений на мутации/комментарии — используется и здесь (пределы), и
// оркестратором (лог-заметка о размере батча комментариев).
export function classifySessionRequests(requests: readonly TSessionRequest[]): {
    mutations: TSessionRequest[];
    comments: TSessionRequest[];
} {
    const mutations = requests.filter((r) =>
        (MUTATION_KINDS as readonly string[]).includes(r.kind),
    );
    const comments = requests.filter((r) => (COMMENT_KINDS as readonly string[]).includes(r.kind));
    // Ревью #612: классификация ИСЧЕРПЫВАЮЩА, и это проверяется, а не подразумевается.
    // Namespace-типы здесь не помогут — оба массива сведены к `readonly string[]`, так что
    // новый вариант union (докблок TSessionRequest прямо предполагает рост списка) проехал
    // бы мимо ОБОИХ пределов молча, то есть новый класс намерений приехал бы вовсе без
    // предохранителя. Тихий дефолт вместо fail-closed — ровно инвариант №1.
    if (mutations.length + comments.length !== requests.length) {
        const known = new Set([...MUTATION_KINDS, ...COMMENT_KINDS] as readonly string[]);
        const orphans = [...new Set(requests.map((r) => r.kind).filter((k) => !known.has(k)))];
        throw new Error(
            `Запрос сессии: намерение вида ${orphans.map((k) => JSON.stringify(k)).join(', ')} ` +
                'не отнесено ни к мутациям, ни к комментариям — значит оно проехало бы мимо ' +
                'обоих пределов. Добавь его в MUTATION_KINDS или COMMENT_KINDS (session-requests.ts).',
        );
    }
    return { mutations, comments };
}

// Разбивка батча по kind — для сообщения об отказе: человек видит не просто «слишком
// много», а «сколько чего именно» («23 намерения: 23 pr-comment, 0 мутаций»).
function breakdownByKind(requests: readonly TSessionRequest[]): string {
    const counts = new Map<string, number>();
    for (const r of requests) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
    return [...counts.entries()].map(([kind, n]) => `${String(n)} ${kind}`).join(', ');
}

// Пределы длин — не про красоту: комментарий на мегабайт уедет в тело запроса к форжу и
// вернётся отказом транспорта, диагностировать который будет нечем.
const MAX_COMMENT = 10_000;
const MAX_TITLE = 200;
const MAX_BODY = 20_000;

const ISSUE_KINDS = ['comment', 'close', 'block'] as const;
const PR_KINDS = ['pr-comment', 'pr-block'] as const;

// Путь файла для якоря комментария. Проверяется не «на всякий случай»: строку пишет
// модель, а уходит она в argv `gh api -f path=…`. Абсолютный путь и `..` отвергаем —
// комментарий обязан указывать на файл ЭТОГО репозитория, а не на что угодно в файловой
// системе; ведущий `-` закрывает argument injection (тот же класс, что SAFE_BRANCH_RE).
//
// Скобки разрешены СПЕЦИАЛЬНО и только внутри сегмента: квадратные — динамический маршрут
// Next.js (`app/[slug]/page.tsx`, `[...rest]`, `[[...opt]]`), круглые — группа маршрутов
// (`app/(marketing)/page.tsx`). Это штатные формы, и без них
// любое замечание ревью на такой файл отвергалось, унося ВЕСЬ батч намерений (в проекте,
// где ядро обкатывалось, так дважды подряд встала сдача фазы: пропали проходы ревью
// на 59 и 70 намерений). К классу, ради которого стоит проверка, скобки отношения не
// имеют: ни выхода за дерево, ни подмены флага они не дают — в argv это обычный символ
// имени файла. Первым символом их всё равно нет: ведущий `[` не нужен ни одному
// реальному пути, а сужать вход дешевле, чем рассуждать о нём.
const SAFE_PATH_RE = /^[A-Za-z0-9._][A-Za-z0-9._\-/[\]()]*$/;
const MAX_PATH = 400;

function fail(lineNo: number, what: string): never {
    throw new Error(`Запрос сессии, строка ${String(lineNo)}: ${what}`);
}

function asRecord(value: unknown, lineNo: number): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail(lineNo, 'ожидался объект JSON');
    }
    return value as Record<string, unknown>;
}

// Номер карточки — целое положительное. Строка «7» тоже отвергается: она приходит от
// модели, а не от форжа, и молчаливое приведение типов здесь означало бы, что в мутацию
// уедет значение, которого никто не проверял.
function issueNumber(value: unknown, lineNo: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        fail(
            lineNo,
            `номер карточки должен быть целым положительным, пришло ${JSON.stringify(value)}`,
        );
    }
    return value;
}

function text(value: unknown, lineNo: number, what: string, max: number): string {
    if (typeof value !== 'string' || value.trim() === '') {
        fail(lineNo, `${what} обязателен и не может быть пустым`);
    }
    if (value.length > max) {
        fail(lineNo, `${what} длиннее предела ${String(max)} символов`);
    }
    return value;
}

// Якорь комментария: путь + строка. Либо ОБА поля, либо ни одного — половина якоря
// (путь без строки) у форжа не примется, и намерение потерялось бы уже в транспорте.
// Сторона диффа — только при якоре: без строки ей не к чему относиться, и молча
// выброшенное поле означало бы, что сессия думала о строке, которой в намерении нет.
function anchor(req: Record<string, unknown>, lineNo: number): { anchor?: TRequestAnchor } {
    const rawPath = req['path'];
    const rawLine = req['line'];
    const rawSide = req['side'];
    if (rawPath === undefined && rawLine === undefined) {
        if (rawSide !== undefined)
            fail(lineNo, 'сторона диффа (side) задаётся только при паре path+line');
        return {};
    }
    if (rawPath === undefined || rawLine === undefined) {
        fail(lineNo, 'якорь комментария задаётся ПАРОЙ path+line: одного поля мало');
    }
    const path = text(rawPath, lineNo, 'путь файла', MAX_PATH);
    if (!SAFE_PATH_RE.test(path) || path.split('/').includes('..')) {
        fail(
            lineNo,
            `путь ${JSON.stringify(path)} не похож на файл этого репозитория ` +
                '(ожидается относительный путь без «..» и без ведущего дефиса)',
        );
    }
    if (typeof rawLine !== 'number' || !Number.isInteger(rawLine) || rawLine <= 0) {
        fail(lineNo, `строка должна быть целым положительным, пришло ${JSON.stringify(rawLine)}`);
    }
    if (rawSide === undefined) return { anchor: { path, line: rawLine } };
    if (typeof rawSide !== 'string' || !DIFF_SIDES.includes(rawSide)) {
        fail(
            lineNo,
            `сторона диффа должна быть ${DIFF_SIDES.join(' или ')}, пришло ${JSON.stringify(rawSide)}`,
        );
    }
    return { anchor: { path, line: rawLine, side: rawSide as TDiffSide } };
}

function labels(value: unknown, lineNo: number, allowlist: readonly string[]): string[] {
    if (!Array.isArray(value) || value.length === 0) {
        fail(lineNo, 'метки обязательны: карточка без меток не видна ни роутингу, ни человеку');
    }
    const seen: string[] = [];
    for (const label of value) {
        if (typeof label !== 'string' || !allowlist.includes(label)) {
            fail(
                lineNo,
                `метка ${JSON.stringify(label)} вне разрешённого списка (${allowlist.join(', ')})`,
            );
        }
        // Повтор метки схлопываем, а не отвергаем: это невнимательность модели, а не
        // попытка сделать что-то запрещённое. Отказ здесь стоил бы потерянного намерения,
        // а дубль — отказа форжа (`gh issue create --label x --label x`).
        if (!seen.includes(label)) seen.push(label);
    }
    return seen;
}

/**
 * Разбирает файл-запрос (JSONL) в список намерений.
 *
 * Отказ — на ЛЮБОЙ некорректной строке, и отказывается ВЕСЬ батч: частичное применение
 * оставило бы трекер в состоянии, которого не хотела ни сессия, ни петля, — например
 * карточка закрыта, а объясняющий комментарий потерян вместе с битой строкой.
 */
export function parseSessionRequests(
    raw: string,
    {
        labelAllowlist,
        issueFormat = null,
    }: {
        labelAllowlist: readonly string[];
        // Фаза 10: формат карточки, заданный потребителем (`issue-format.ts`). Нет —
        // new-issue проверяется как раньше.
        issueFormat?: TIssueFormat | null;
    },
): TSessionRequest[] {
    const lines = raw
        .split('\n')
        .map((l, i) => ({ text: l.trim(), no: i + 1 }))
        .filter((l) => l.text !== '');

    // Ревью #612: грубый предохранитель ДО разбора — по числу строк. Точные пределы по
    // классам ниже (после разбора), но батч, который заведомо не влезает даже в их сумму,
    // отвергается сразу и с ПРАВИЛЬНЫМ диагнозом («сессия сорвалась»), а не случайной
    // синтаксической придиркой к 137-й строке из ста тысяч.
    if (lines.length > MAX_REQUEST_LINES) {
        throw new Error(
            `Запрос сессии: ${String(lines.length)} строк — больше суммы пределов ` +
                `(${String(MAX_REQUEST_LINES)}). Батч отвергнут целиком, НЕ разбираясь: столько ` +
                'намерений за одну итерацию похоже на сорвавшуюся сессию.',
        );
    }

    const requests = lines.map(({ text: source, no }) => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(source);
        } catch {
            fail(no, 'не разобралось как JSON');
        }
        const req = asRecord(parsed, no);
        const kind = req['kind'];

        if (kind === 'new-issue') {
            const issue = {
                kind: 'new-issue' as const,
                title: text(req['title'], no, 'заголовок', MAX_TITLE),
                body: text(req['body'], no, 'тело карточки', MAX_BODY),
                labels: labels(req['labels'], no, labelAllowlist),
            };
            // Карточка не по формату потребителя не заводится: заведённая, она попала бы
            // в очередь и встала бы стопом preflight уже у человека — а причину лучше
            // назвать здесь, пока сессия, писавшая тело, ещё названа в логе.
            if (issueFormat !== null) {
                const violations = checkIssueFormat(issue, issueFormat);
                if (violations.length > 0)
                    fail(
                        no,
                        'новая карточка не по формату потребителя (issueFormat) — ' +
                            describeFormatViolations(violations),
                    );
            }
            return issue;
        }
        // #45: комментарий в PR фазы. Замечание ревью без текста — потерянная находка,
        // поэтому `comment` обязателен так же, как у намерений по карточкам.
        if (kind === 'pr-comment') {
            return {
                kind: 'pr-comment' as const,
                comment: text(req['comment'], no, 'комментарий', MAX_COMMENT),
                ...anchor(req, no),
            };
        }
        // Метка blocked на PR фазы. Комментарий обязателен: метка без объяснения оставляет
        // человека (и чини-сессию) гадать, что именно блокирует.
        if (kind === 'pr-block') {
            return {
                kind: 'pr-block' as const,
                comment: text(req['comment'], no, 'комментарий', MAX_COMMENT),
            };
        }
        if (typeof kind === 'string' && (ISSUE_KINDS as readonly string[]).includes(kind)) {
            return {
                kind: kind as 'comment' | 'close' | 'block',
                issue: issueNumber(req['issue'], no),
                comment: text(req['comment'], no, 'комментарий', MAX_COMMENT),
            };
        }
        fail(
            no,
            `неизвестный kind ${JSON.stringify(kind)}. Разрешено: ${[...ISSUE_KINDS, 'new-issue', ...PR_KINDS].join(', ')}. ` +
                'Снятие hold и blocked, одобрение ревью и мердж намерениями сессии не являются.',
        );
    });

    // #603: пределы проверяются ПОСЛЕ разбора и РАЗДЕЛЬНО по классам — иначе большой,
    // но честно отревьюенный PR (сплошь `pr-comment`) бился бы о тот же предохранитель,
    // что и сорвавшаяся сессия, штампующая close/block/new-issue пачками.
    const { mutations, comments } = classifySessionRequests(requests);
    if (mutations.length > MAX_MUTATION_REQUESTS) {
        throw new Error(
            `Запрос сессии: ${String(mutations.length)} мутаций (close/block/new-issue/pr-block) — ` +
                `больше предела ${String(MAX_MUTATION_REQUESTS)}. Батч отвергнут целиком: столько мутаций ` +
                'за одну итерацию похоже на сорвавшуюся сессию. ' +
                `Разбивка по классам: ${String(requests.length)} намерений — ${breakdownByKind(requests)}.`,
        );
    }
    if (comments.length > MAX_COMMENT_REQUESTS) {
        throw new Error(
            `Запрос сессии: ${String(comments.length)} комментариев (comment/pr-comment) — ` +
                `больше предела ${String(MAX_COMMENT_REQUESTS)}. Батч отвергнут целиком. ` +
                `Разбивка по классам: ${String(requests.length)} намерений — ${breakdownByKind(requests)}.`,
        );
    }

    return requests;
}

/**
 * Имя карантина отвергнутого батча (#124): `<файл>.rejected-<время>`, а занятое имя —
 * с номером. `rename` на занятую цель молча затирает её, и два отказа в одну
 * миллисекунду оставили бы на разбор только второй батч. Время — параметром: имя, взятое
 * из `new Date()` внутри, тест не проверил бы детерминированно.
 */
export function quarantinePath(
    file: string,
    nowMs: number,
    existsFn: (p: string) => boolean,
): string {
    const base = `${file}.rejected-${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}`;
    let target = base;
    for (let n = 1; existsFn(target); n++) target = `${base}-${String(n)}`;
    return target;
}

/**
 * Сериализует намерение обратно в строку JSONL — так, как его читает `parseSessionRequests`.
 *
 * Нужна, потому что хвост неприменённого батча пишется на диск и читается СЛЕДУЮЩИМ
 * прогоном тем же парсером. Наивный `JSON.stringify` отдавал НОРМАЛИЗОВАННУЮ форму
 * (`anchor: {path, line}`), а парсер ждёт ПЛОСКИЕ `path`/`line` — якорь молча терялся,
 * и замечание к строке возвращалось сводкой (#64). Здесь форма разворачивается обратно:
 * запись и чтение обязаны сходиться, иначе round-trip врёт.
 */
export function serializeSessionRequest(req: TSessionRequest): string {
    if (req.kind === 'pr-comment' && req.anchor) {
        const { anchor, ...rest } = req;
        return JSON.stringify({
            ...rest,
            path: anchor.path,
            line: anchor.line,
            ...(anchor.side ? { side: anchor.side } : {}),
        });
    }
    return JSON.stringify(req);
}

// ── #41: отказ форжа, который повтор не лечит ───────────────────────────────────────
//
// Раньше ЛЮБОЙ отказ на N-м намерении сохранял хвост целиком и останавливал применение.
// Для транзиента (сеть, 5xx, лимит) это верно — следующая итерация пройдёт. Но карточка
// удалена, метки нет, прав нет — такой отказ повторяется детерминированно, и одно битое
// намерение навсегда загораживало собой весь хвост батча: остальные не применялись ни
// этой итерацией, ни следующей.
//
// Классов три, и умолчание — СОХРАНИТЬ хвост, а не выбросить: незнакомая формулировка
// отказа не должна молча отнимать у намерения повтор (тот же выбор, что у повтора мерджа
// в merge-retry.ts):
//
//   - `deterministic` — выбывает то, что форж назвал прямо: 403/404/410/422 и их словесные
//     формы. Ответ форжа пришёл, значит отказ окончательный;
//   - `unsent` — соединения не было вовсе (адрес не разрешился, порт отказал): запрос
//     доказуемо не ушёл, и хвост повторяется без сверки — как до #94;
//   - `retry` — всё прочее, включая обрыв посреди обмена: эффект мог лечь.
//
// Транзиент проверяется ПЕРВЫМ — GitHub отвечает на упор в лимит кодом 403 (в том числе
// устаревшим «abuse detection» без слов «rate limit»), и ветка «нет прав» съела бы его.
// Набор транзиентов тот же, что у мерджа (`MERGE_TRANSIENT_RE`): у намерения он был у́же,
// и обрыв вида `connection reset by peer` без errno-токена уходил «по существу».
//
// Признаки — только из ОТВЕТА форжа, и это держит не регулярка, а вход: классификатор
// получает `intentFailureText`, а не сообщение исключения. У `execFileSync` первой строкой
// сообщения идёт вся команда, а адаптер GitHub кладёт тело комментария в argv — тело,
// упомянувшее «HTTP 404» (карточки про отказы форжа именно такие), делало бы из обрыва
// сети отказ по существу, и намерение выбывало бы безвозвратно.
export type TIntentFailureKind = 'deterministic' | 'unsent' | 'retry';

const INTENT_RATE_LIMIT_RE = /rate limit|abuse detection|secondary rate/i;
const INTENT_UNSENT_RE =
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Could not resolve host|no such host|connection refused|Failed to connect/i;
const INTENT_DETERMINISTIC_RE = new RegExp(
    [
        'HTTP (?:403|404|410|422)\\b',
        'returned error: (?:403|404|410|422)\\b',
        'Could not resolve to an? (?:Issue|PullRequest|Label)',
        "could not add label: '[^']*' not found",
        'Resource not accessible by',
        'does not have the correct permissions',
    ].join('|'),
    'i',
);

/**
 * Текст ответа форжа из пойманного отказа: stderr процесса, иначе сообщение исключения
 * без строки `Command failed: …`. Сообщение, которое ЦЕЛИКОМ — команда (stderr пуст), не
 * отдаёт ничего: тело в argv может занимать несколько строк, и отделить его от ответа
 * нечем, а пустой текст классифицируется умолчанием — повтором.
 */
export function intentFailureText(e: unknown): string {
    const err = (e ?? {}) as { stderr?: unknown; message?: unknown };
    const stderr = err.stderr === undefined || err.stderr === null ? '' : String(err.stderr);
    if (stderr.trim() !== '') return stderr.trim();
    const message = String(err.message ?? e).trim();
    return message.startsWith('Command failed:') ? '' : message;
}

export function classifyIntentFailure(forgeText: string): TIntentFailureKind {
    if (INTENT_RATE_LIMIT_RE.test(forgeText)) return 'retry';
    if (INTENT_UNSENT_RE.test(forgeText)) return 'unsent';
    if (MERGE_TRANSIENT_RE.test(forgeText)) return 'retry';
    return INTENT_DETERMINISTIC_RE.test(forgeText) ? 'deterministic' : 'retry';
}

// ── #86: окно падения посреди применения ─────────────────────────────────────────────
//
// Применение поштучное, и между эффектом на форже и записью «применено» есть окно: убитый
// там раннер (OOM, рестарт службы, `kill -9`) оставлял файл целым, и после рестарта весь
// батч применялся заново — комментарий ложился вторым, карточка заводилась дублем. Хвост
// раньше писался только на ПОЙМАННОМ отказе, а убийство исключения не бросает.
//
// Поэтому перед каждым эффектом файл переписывается в вид «метка + неприменённый хвост»,
// а после эффекта — в «хвост без него». Убит до метки — файл честный, повтор безопасен.
// Убит после метки — исход первого намерения хвоста НЕИЗВЕСТЕН: эффект мог лечь, а мог
// нет. Различает его сверка с форжем по метке в теле эффекта (#94, ниже); где сверить
// нечем, неизвестный исход — стоп с причиной и пушем, а не догадка: повтор вслепую дал
// бы дубль, пропуск — потерю.
//
// Тот же неизвестный исход у ПОЙМАННОГО отказа, брошенного после того, как запрос к
// форжу ушёл: обрыв ответа неотличим от отказа, а эффект мог лечь (воспроизведено в
// исследовании: комментарий PR опубликован дважды). Поэтому такой отказ оставляет метку
// на диске, а не переписывает файл в голый хвост, — и повтор идёт через сверку.
//
// Метка — строка без `kind`: парсер намерений её отвергает, так что файл с меткой не
// применится НИКАКИМ путём, даже если проверку метки однажды забудут поставить перед ним.
//
// #94: метка несёт ИДЕНТИФИКАТОР попытки (`id`), а тот же идентификатор уходит в тело
// эффекта невидимой меткой (`intentMark`). Раньше по метке на диске было известно только
// «что-то начато», и исход решал человек; теперь его решает форж: метка в ленте — эффект
// лёг, нет — не лёг, и повтор безопасен. Идентификатор одноразовый, а не производный от
// текста: два одинаковых комментария к одной карточке из разных сессий — обычное дело
// («тесты красные, вот вывод»), и хэш содержимого нашёл бы в ленте ЧУЖОЙ, давний, приняв
// неприменённое намерение за применённое. Живёт он ровно столько, сколько метка: в файле,
// рядом с начатым намерением, — другого места, переживающего убийство, у раннера нет.
//
// Префикс общий у метки с `id` и у прежней, без него: файл, оставленный раннером до #94,
// обязан узнаваться меткой (сверять там нечем — стоп), а не читаться битой строкой.
export const IN_FLIGHT_PREFIX = '{"ralph":"in-flight"';
const INTENT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Строка-метка начатого намерения с идентификатором попытки. `landed: 'comment'` — у
 * `close`/`block` комментарий уже лёг, и это известно ЭТОМУ процессу (вызов вернулся), а
 * отказал статус. Сверять тогда нечего: повтор доводит только статус, он идемпотентен.
 */
export function inFlightMarker(id: string, landed?: 'comment'): string {
    if (!INTENT_ID_RE.test(id)) throw new Error(`идентификатор намерения не по форме: ${id}`);
    return JSON.stringify(landed ? { ralph: 'in-flight', id, landed } : { ralph: 'in-flight', id });
}

/** Файл для записи ПЕРЕД эффектом: метка и неприменённый хвост, первым — начатое намерение. */
export function serializeInFlight(
    tail: readonly TSessionRequest[],
    id: string,
    landed?: 'comment',
): string {
    return `${[inFlightMarker(id, landed), ...tail.map(serializeSessionRequest)].join('\n')}\n`;
}

// Невидимая метка в теле эффекта. HTML-комментарий markdown не рисует ни GitHub, ни
// SourceCraft, а в сыром теле, которое отдаёт лента, он есть. Стоит ХВОСТОМ: журнал
// находок ревью засчитывает severity, только если она первый значимый символ тела.
export function intentMark(id: string): string {
    return `<!-- ralph-intent:${id} -->`;
}
export function withIntentMark(body: string, id: string): string {
    return `${body}\n\n${intentMark(id)}`;
}
export function carriesIntentMark(body: string, id: string): boolean {
    return body.includes(intentMark(id));
}

/**
 * Начатое, но не подтверждённое намерение. `null` — метки нет, файл можно применять.
 * `id: null` — метка без идентификатора (оставлена раннером до #94 или испорчена): сверять
 * её с форжем не по чему. `rest` — файл без метки и без начатого намерения.
 *
 * Метка не на первом месте — тоже метка, а не «нет её»: раннер ставит её только первой,
 * значит файл собран не им, и решать, что в нём начато, раннер не вправе — такой метке
 * идентификатор не признаётся.
 */
export type TInFlight = {
    marker: string;
    id: string | null;
    /** Что из эффекта уже легло по записи самого раннера; `null` — не известно. */
    landed: 'comment' | null;
    started: string;
    rest: string;
};
export function inFlightEntry(raw: string | null): TInFlight | null {
    if (!raw) return null;
    const lines = raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
    const at = lines.findIndex((l) => l.startsWith(IN_FLIGHT_PREFIX));
    if (at === -1) return null;
    const marker = lines[at];
    let id: string | null = null;
    let landed: 'comment' | null = null;
    try {
        const parsed = JSON.parse(marker) as { ralph?: unknown; id?: unknown; landed?: unknown };
        const keys = Object.keys(parsed);
        const landedOk = parsed.landed === undefined || parsed.landed === 'comment';
        if (
            at === 0 &&
            parsed.ralph === 'in-flight' &&
            typeof parsed.id === 'string' &&
            INTENT_ID_RE.test(parsed.id) &&
            landedOk &&
            keys.length === (parsed.landed === undefined ? 2 : 3)
        ) {
            id = parsed.id;
            landed = parsed.landed === 'comment' ? 'comment' : null;
        }
    } catch {
        id = null;
    }
    const started = lines[at + 1] ?? '(строки намерения за меткой нет)';
    const rest = lines.slice(at + 2);
    return { marker, id, landed, started, rest: rest.length > 0 ? `${rest.join('\n')}\n` : '' };
}

/** Начатое намерение строкой (для текстов) — `null`, если метки нет. */
export function inFlightRequest(raw: string | null): string | null {
    return inFlightEntry(raw)?.started ?? null;
}

// ── #94: сверка начатого намерения с форжем ─────────────────────────────────────────
//
// Чем кончилась сверка. `landed` — сколько эффектов намерения уже на форже: `all` —
// намерение применено целиком, `comment` — у `close`/`block` лёг комментарий, а статус
// (закрытие, метка) нет либо неизвестен и повторяется: оба идемпотентны, повтор не
// плодит сущностей. `none` — метки в ленте нет, намерение применяется заново под тем же
// идентификатором. `unknown` — сверить не по чему, и это стоп с причиной, а не догадка.
export type TReconcile =
    { verdict: 'landed'; landed: 'all' | 'comment' | 'none' } | { verdict: 'unknown'; why: string };

// Чем сверять — решает вид намерения. Комментарий PR ищется в ленте PR (её шов читает
// всегда), комментарий карточки — в ленте карточки, если источник умеет её читать. Новая
// карточка не сверяется НИКАК: поиска карточки по метке в шве нет, и неизвестный исход
// заведения — стоп.
//
// `listIssueComments` в контракте `TaskSourceAdapter` объявлен НЕОБЯЗАТЕЛЬНЫМ (#125): обе
// реализации канона ленту карточки читают, но шов без неё законен — у такого шва
// неизвестный исход `comment`/`close`/`block` остаётся стопом, а не повтором вслепую.
export type TReconcileSource = {
    listIssueComments?: (issue: number) => string[];
    listPullRequestComments: (pr: number) => Array<{ body: string }>;
    findOpenPullRequest: (branch: string) => { number: number } | null;
};

/**
 * Почему начатое намерение этого вида с этим швом НЕ сверить; `null` — сверить можно.
 * Одна формулировка на все места, где её называют человеку: старт, применение, сверка.
 */
export function unreconcilableWhy(kind: TSessionRequest['kind'], source: object): string | null {
    if (reconcilableKind(kind, source)) return null;
    return kind === 'new-issue'
        ? 'у шва форжа нет поиска карточки по метке намерения'
        : 'шов форжа не умеет читать комментарии карточки';
}

/** Можно ли вообще сверить начатое намерение этого вида с этим швом — без похода в форж. */
// Источник — `object`, а не тип с одним необязательным полем: шов, у которого метода нет
// (см. выше), TypeScript отверг бы как «слабый тип» без общих полей.
export function reconcilableKind(kind: TSessionRequest['kind'], source: object): boolean {
    if (kind === 'pr-comment' || kind === 'pr-block') return true;
    if (kind === 'new-issue') return false;
    return typeof (source as { listIssueComments?: unknown }).listIssueComments === 'function';
}

export function reconcileInFlight(
    req: TSessionRequest,
    id: string,
    source: TReconcileSource,
    phase: { branch: string } | undefined,
): TReconcile {
    const why = unreconcilableWhy(req.kind, source);
    if (why !== null) return { verdict: 'unknown', why };
    const unread = (e: unknown): TReconcile =>
        // Не прочитали ленту — не знаем. «Не нашли» здесь означало бы повтор вслепую.
        ({ verdict: 'unknown', why: `лента форжа не прочиталась: ${(e as Error).message}` });
    if (req.kind === 'pr-comment' || req.kind === 'pr-block') {
        if (!phase) return { verdict: 'unknown', why: 'намерение по PR вне цикла сдачи фазы' };
        try {
            const pr = source.findOpenPullRequest(phase.branch);
            if (!pr) {
                return {
                    verdict: 'unknown',
                    why: `открытого PR ветки ${phase.branch} не найдено — ленту читать негде`,
                };
            }
            const found = source
                .listPullRequestComments(pr.number)
                .some((c) => carriesIntentMark(c.body, id));
            return { verdict: 'landed', landed: found ? 'all' : 'none' };
        } catch (e) {
            return unread(e);
        }
    }
    // Несверяемое отсеяно выше — здесь только сужение типа. Инвариант проверяется броском
    // ВНЕ `try`: пойманный, он ушёл бы человеку «лентой, которая не прочиталась».
    const list = source.listIssueComments;
    if (req.kind === 'new-issue' || !list) {
        throw new Error(`сверка намерения ${req.kind}: несверяемый вид дошёл до чтения ленты`);
    }
    try {
        const found = list(req.issue).some((b) => carriesIntentMark(b, id));
        if (!found) return { verdict: 'landed', landed: 'none' };
        return { verdict: 'landed', landed: req.kind === 'comment' ? 'all' : 'comment' };
    } catch (e) {
        return unread(e);
    }
}

/**
 * Стоп по неизвестному исходу: что начато, почему не повторяем и что решить человеку.
 * Вопрос называет обе развилки построчно — человек правит файл, а не гадает, что в нём.
 * `why` — почему сверка с форжем не решила исход сама (#94).
 */
export function inFlightStopMessage(
    entry: Pick<TInFlight, 'started' | 'marker'>,
    requestsPath: string,
    why?: string,
): string {
    const { started, marker } = entry;
    // #87: у pr-block два эффекта, и о мердже решает метка — она ставится первой. Судить
    // по комментарию значило бы гадать: он ложится вторым и мог не лечь при живой метке.
    const block = /"kind"\s*:\s*"pr-block"/.test(started)
        ? '; у pr-block эффект — метка blocked на PR (она ставится первой, до комментария): ' +
          'метка есть — эффект лёг'
        : '';
    return formatStopMessage({
        reason: 'intent-unknown',
        diagnosis:
            `применение намерения ${started} оборвалось — эффект на ` +
            'форже мог лечь, а мог нет' +
            (why ? `, а сверить его с форжем нечем (${why})` : '') +
            '. Повтор вслепую задвоил бы комментарий или карточку, ' +
            `пропуск потерял бы его, поэтому не применено ничего; файл ${requestsPath} ` +
            'оставлен как есть',
        question:
            'проверь на форже, лёг ли эффект этого намерения: лёг — удали из файла метку ' +
            `${marker} и строку за ней, не лёг — только метку${block}; затем перезапусти loop`,
    });
}
