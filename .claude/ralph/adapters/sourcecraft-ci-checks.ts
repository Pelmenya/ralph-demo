// Чек PR на стороне SourceCraft: вердикт прогона CI и лог упавшего куба (#269).
//
// Почему отдельный модуль, а не метод в `sourcecraft-task-source.ts`: у CI своя тройка
// маршрутов (`merge-checks`, `cicd/runs`, `cicd/logs`), свой словарь статусов и свой
// режим отказа — читать его нужно НЕ fail-closed целиком (не смогли прочитать лог куба —
// это не повод потерять уже добытый диагноз «упал куб X»). Смешав его с очередью задач,
// мы получили бы модуль, у которого половина методов бросает, а половина глотает,
// и правило «где какой» жило бы только в головах.
//
// Что здесь есть: разбор ответов площадки в форму шва (`ForgeChecks`/`ForgeCheckFailure`).
// Чего нет: решения «ждать или мерджить» и «чинится ли это кодом» — это политика ядра
// (`core/forge-checks.ts`).
import type { ForgeCheckFailure, ForgeCheckRun, ForgeChecks, ForgeCheckState } from './adapters.ts';
import { errorText } from '../shared/ralph-util.ts';
import type { SourcecraftApi } from './sourcecraft-task-source.ts';

// Формы шва ИМПОРТИРУЮТСЯ из `adapters.ts`, а не повторяются здесь копией (правка по
// ревью #269). Прежний довод — «модуль контрактов не должен становиться зависимостью
// каждой реализации» — не работал уже в момент написания: проводку этих двух методов
// делает `sourcecraft-task-source.ts`, и он те же типы оттуда как раз импортирует.
// Два взаимоисключающих правила в одном каталоге дороже импорта, а третья копия формы
// не давала ничего, чего не даёт typecheck проводки.

export type SourcecraftCiChecksDeps = {
    api: SourcecraftApi;
    org: string;
    repo: string;
};

// Сколько символов лога куба отдавать наружу — с запасом на блок отказа vitest вместе
// со стеком, но заведомо меньше окна промпта.
//
// Константа, а не параметр (правка по ревью #269). Ручка `logLimit` была мёртвой:
// единственный боевой вызывающий (`sourcecraft-task-source.ts`) её не прокидывал, и
// тесты тоже — то есть настроить объём вырезки было нельзя ниоткуда, а параметр обещал
// обратное. Понадобится настройка — она приедет из конфига вместе с вызывающим,
// а не останется декорацией сигнатуры. Сама вырезка (`failureExcerpt`) предел принимает
// аргументом и тестируется на любых значениях независимо от этого числа.
const LOG_LIMIT = 4000;

// Словарь `Run.Status` из OpenAPI площадки. Перечислен ПОИМЁННО, а не «всё, что не
// success — красное»: `processing` и `awaiting_approval` мерджу мешают ровно так же, как
// `failed`, но лечатся противоположным (подождать против починить), и схлопывать их
// нельзя. Незнакомое значение — НЕ красное и НЕ зелёное: см. `runState` ниже.
const GREEN_STATUSES = new Set(['success', 'skipped']);
const RED_STATUSES = new Set(['failed', 'canceled', 'timeout', 'rejected']);
const PENDING_STATUSES = new Set(['created', 'prepared', 'processing', 'awaiting_approval']);

function runState(raw: string): ForgeCheckState {
    if (GREEN_STATUSES.has(raw)) return 'success';
    if (RED_STATUSES.has(raw)) return 'failed';
    if (PENDING_STATUSES.has(raw)) return 'pending';
    // Незнакомый статус — «ждём», а не «зелено». Площадка вправе добавить значение в энум,
    // и молчаливое «раз не красный, значит можно мерджить» превратило бы такое добавление
    // в мердж поверх непрошедшего чека. Потолок ожидания в ядре доведёт это до честного
    // стопа с сырым статусом в тексте — то есть человек прочитает НОВОЕ слово, а не
    // «почему-то не смерджилось».
    return 'pending';
}

// ── Чистая часть: чистка и вырезка полезного куска лога ──────────────────────

// CSI-последовательности (цвет, стиль, курсор) — всё, что vitest и npm пишут в TTY.
// Куб отдаёт лог ОДНОЙ строкой вместе с ними, и без очистки сессия лечения получает текст,
// в котором слова разорваны вставками: и человеку нечитаемо, и поиск сигнатур отказа
// спотыкается.
// ESC записан escape-последовательностью, а не литералом: управляющий символ
// в исходнике невидим глазом и не переживает первой же уборки файла.
const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;

export function stripAnsi(raw: string): string {
    return raw.replace(ANSI_RE, '');
}

// Маркеры МЕСТА ОТКАЗА в логе куба. Нужны потому, что голый хвост врёт: у прогона 350
// последними двумя тысячами символов идёт ТАБЛИЦА ПОКРЫТИЯ, а «Worker exited unexpectedly»
// — за сорок килобайт до неё. Сессия лечения по такому хвосту не увидит ничего.
const FAILURE_MARKERS =
    /(Failed Tests|Unhandled Errors?|Worker exited unexpectedly|AssertionError|npm ERR!|error TS\d+|\bFAIL\b)/g;

/**
 * Позиция ПОСЛЕДНЕГО маркера отказа, а не первого (правка по ревью #269).
 *
 * `text.search()` ищет не «место отказа», а первую строку, ПОХОЖУЮ на маркер: `FAIL`
 * встречается и в именах кейсов («не падает на FAIL-ответе»), и в выводе сторонних
 * инструментов. На первом вхождении окно уезжало бы в начало мегабайтного хвоста,
 * а настоящий блок отказа оставался за кадром. Диагностически ценен последний маркер:
 * fail-fast прогон печатает его непосредственно перед сводкой.
 */
function lastFailureMarker(text: string): number {
    FAILURE_MARKERS.lastIndex = 0;
    let at = -1;
    for (const m of text.matchAll(FAILURE_MARKERS)) at = m.index;
    return at;
}

// Сводка прогона тестов. Отдельный кусок, а не «повезёт попасть в хвост»: по ней ЯДРО
// отличает отказ кода от отказа среды (`classifyForgeFailure`), а лежит она посередине —
// между местом отказа и концом лога, потому что после неё печатается таблица покрытия.
// Без этого куска прогон, где память поджала И тесты честно упали, классифицировался бы
// как отказ среды: сигнатура убитого воркера в окно попадает, а «2 failed» — нет.
const SUMMARY_RE = /^[^\n]*\b(?:Test Files|Tests)\s+\d+[^\n]*$/gm;

// Верхняя граница читаемого лога. Куб печатает сотни килобайт (замер: 225 КБ у одного
// `test`), и разбирать регулярками мегабайты в синхронной петле — это секунды простоя на
// ровном месте. Режем ДО разбора, с обоих концов: начало лога (установка, список файлов)
// диагностической ценности не несёт.
const READ_LIMIT = 1024 * 1024;

/**
 * Кусок лога для сессии лечения: окно вокруг ПОСЛЕДНЕГО маркера отказа плюс хвост.
 *
 * Почему два куска, а не один. Хвост нужен всегда — там сводка («2 failed | 435 passed»),
 * по которой ядро отличает отказ кода от отказа среды. Окно вокруг маркера нужно потому,
 * что сам отказ печатается ВЫШЕ сводки, а между ними может лежать таблица покрытия
 * в десятки килобайт. Куски склеиваются видимым разрывом `…`, чтобы читающий не принял
 * стык за непрерывный текст.
 */
export function failureExcerpt(raw: string, limit: number): string {
    const text = stripAnsi(raw.length > READ_LIMIT ? raw.slice(-READ_LIMIT) : raw);
    if (text.length <= limit) return text;
    const tail = text.slice(-Math.ceil(limit / 2));
    const marker = lastFailureMarker(text);
    // Маркера нет либо он и так попал в хвост — окно было бы дублем.
    const head =
        marker >= 0 && marker < text.length - tail.length
            ? text.slice(marker, marker + Math.floor(limit / 2))
            : '';
    // Две последние строки сводки — и только те, которых нет ни в окне, ни в хвосте.
    // Их длина (десятки символов) сознательно идёт СВЕРХ `limit`: вердикт «лечим или
    // зовём человека» дороже полусотни лишних символов в промпте.
    const summary = [...text.matchAll(SUMMARY_RE)]
        .map((m) => m[0].trim())
        .filter((line) => line !== '' && !head.includes(line) && !tail.includes(line))
        .slice(-2);
    const pieces = [head, ...summary, tail].filter((piece) => piece !== '');
    // Ни окна, ни сводки — прежнее поведение: просто хвост нужной длины.
    return pieces.length === 1 ? text.slice(-limit) : pieces.join('\n…\n');
}

// ── Разбор ответов площадки ─────────────────────────────────────────────────

function asArray(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

type ScCiWorkflow = {
    status?: unknown;
    disabled?: unknown;
    run_slug?: unknown;
    workflow_slug?: unknown;
    created_at?: unknown;
};
type ScCube = { slug?: unknown; status?: unknown };
type ScTask = { slug?: unknown; cubes?: unknown };
type ScWorkflow = { slug?: unknown; tasks?: unknown };

export function createSourcecraftCiChecks(deps: SourcecraftCiChecksDeps): {
    pullRequestChecks: (prNumber: number) => ForgeChecks;
    redCheckDiagnosis: (run: ForgeCheckRun) => ForgeCheckFailure | null;
} {
    const { api, org, repo } = deps;
    const base = `/repos/${org}/${repo}`;

    return {
        /**
         * Вердикт чека PR. Fail-closed: сбой чтения бросает — «не смогли спросить» ядро
         * обязано отличать от «чек зелёный», иначе первый же сетевой чих открыл бы мердж
         * поверх красного прогона.
         *
         * `disabled` workflow отбрасывается ДО свёртки: выключенный чек мердж не держит,
         * а его статус остаётся в ответе с прошлого прогона и красил бы целое навсегда.
         */
        pullRequestChecks(prNumber: number): ForgeChecks {
            const raw = api('GET', `${base}/pulls/${String(prNumber)}/merge-checks`) as {
                ci_workflows?: unknown;
                status?: unknown;
            } | null;
            // Ключа НЕТ вовсе — это смена формы ответа, а не «чеков нет»: транспорт
            // бросает только на не-2xx и на не-JSON, так что переименованный ключ доехал бы
            // сюда как пустой массив и через льготу в две минуты открыл бы мердж. Пустой
            // массив при этом остаётся законным ответом (репозиторий без CI), и различить
            // их можно ровно здесь.
            if (!Array.isArray(raw?.ci_workflows)) {
                throw new Error(
                    `SourceCraft: ответ merge-checks PR #${String(prNumber)} без массива ci_workflows — ` +
                        'форма ответа изменилась. «Чеков не видно» нельзя читать как «чеки прошли».',
                );
            }
            const runs: ForgeCheckRun[] = asArray(raw.ci_workflows)
                .map((w) => w as ScCiWorkflow)
                .filter((w) => w.disabled !== true)
                .map((w) => {
                    const rawStatus = String(w.status ?? '');
                    const runId = String(w.run_slug ?? '').trim();
                    if (!runId && runState(rawStatus) === 'failed') {
                        // Без номера прогона диагноз недостижим: лог куба адресуется именно
                        // им. Молча отдать «красный без адреса» значило бы отправить петлю
                        // в лечение вслепую.
                        //
                        // Бросаем ТОЛЬКО на красном, и это правка по ревью: у ждущего
                        // прогона номер не нужен вовсе, а «CI/CD-сущности пока без публичных
                        // id» — прямая цитата из спеки площадки, то есть пустые адресные поля
                        // здесь не гипотетика. Общий бросок превратил бы свежесозданный
                        // прогон в три «сбоя чтения» подряд и стоп петли на ровном месте.
                        throw new Error(
                            `SourceCraft: КРАСНЫЙ чек PR #${String(prNumber)} пришёл без run_slug ` +
                                `(workflow «${String(w.workflow_slug ?? '')}», статус «${rawStatus}») — ` +
                                'лог упавшего куба по такому ответу не найти.',
                        );
                    }
                    // #278: `created_at` — RFC3339, разбирается в epoch ms. Значение не
                    // строка или не парсится — поле просто отсутствует в ответе (`undefined`),
                    // а не `NaN`: ядро (`isStale`) читает отсутствие как «свежесть неизвестна»
                    // и не объявляет по этой причине вердикт устаревшим.
                    const createdAtMs =
                        typeof w.created_at === 'string' ? Date.parse(w.created_at) : NaN;
                    return {
                        workflow: String(w.workflow_slug ?? ''),
                        runId,
                        state: runState(rawStatus),
                        rawStatus,
                        ...(Number.isFinite(createdAtMs) ? { createdAt: createdAtMs } : {}),
                    };
                });
            if (runs.length === 0) {
                // Прогонов нет, а общий вердикт площадки — отказ: красит что-то другое
                // (валидация конфига, конфликт). Мерджить нельзя, но и лечить нечего:
                // отдаём `failed` без прогонов, и ядро остановится с честной причиной.
                return {
                    state: String(raw.status ?? '') === 'failure' ? 'failed' : 'none',
                    runs: [],
                };
            }
            // Красный сильнее ждущего: ждать остальных, когда один уже упал, значит терять
            // минуты до одного и того же вывода.
            const state: ForgeCheckState = runs.some((r) => r.state === 'failed')
                ? 'failed'
                : runs.some((r) => r.state === 'pending')
                  ? 'pending'
                  : 'success';
            return { state, runs };
        },

        /**
         * Диагноз красного прогона: первый упавший куб и вырезка его лога.
         *
         * Куб берётся ПЕРВЫЙ красный по порядку исполнения: задача гейта идёт fail-fast,
         * и всё, что после него, — это `created`, то есть не запускавшееся. Последний
         * красный куб был бы тем же самым в норме и неверным в единственном случае, когда
         * порядок вообще важен.
         *
         * Fail-open на ЛОГЕ и fail-closed на ПРОГОНЕ, и это не небрежность: не прочитали
         * прогон — диагноза нет вовсе (бросаем, вызывающий решает); прочитали прогон, но
         * не лог — «упал куб `test`, лог недоступен» строго полезнее, чем ничего, и
         * лишать петлю имени куба из-за недоступного лога незачем.
         */
        redCheckDiagnosis(run: ForgeCheckRun): ForgeCheckFailure | null {
            const raw = api('GET', `${base}/cicd/runs/${encodeURIComponent(run.runId)}`) as {
                workflows?: unknown;
            } | null;
            // Прогон адресуется своим workflow: у PR их может быть несколько, и красный
            // куб чужого workflow к нашему чеку отношения не имеет.
            const workflows = asArray(raw?.workflows).map((w) => w as ScWorkflow);
            // Своего workflow в прогоне не нашлось — отдаём `null` (стоп человеку), а НЕ
            // первый попавшийся: подстановка чужого увела бы в сессию лечения чужое имя
            // куба и чужой лог. Правка по ревью — прежний фолбэк `?? workflows[0]`
            // противоречил комментарию строкой выше.
            const workflow = workflows.find((w) => String(w.slug ?? '') === run.workflow);
            if (!workflow) return null;
            for (const t of asArray(workflow.tasks).map((t) => t as ScTask)) {
                for (const c of asArray(t.cubes).map((c) => c as ScCube)) {
                    if (!RED_STATUSES.has(String(c.status ?? ''))) continue;
                    const cube = String(c.slug ?? '');
                    return {
                        workflow: String(workflow.slug ?? run.workflow),
                        runId: run.runId,
                        cube,
                        log: readCubeLog(
                            run.runId,
                            String(workflow.slug ?? run.workflow),
                            String(t.slug ?? ''),
                            cube,
                        ),
                    };
                }
            }
            return null;
        },
    };

    /**
     * Лог куба — ОДНОЙ страницей, и это решение по факту, а не по спеке.
     *
     * Спека обещает постраничную выдачу («если `page_complete` false, следующая страница
     * ответит 404»), но живой сервер 06.09.2026 на `page=1` и `page=2` одного и того же
     * куба вернул БАЙТ В БАЙТ одинаковые 225 КБ с `page_complete: false`. То есть цикл
     * «читаем, пока страницы не кончатся» здесь не сходится вовсе: он либо крутится
     * бесконечно, либо склеивает лог сам с собой. Берём первую страницу и режем хвост —
     * диагностическая ценность у конца лога, а не у полноты.
     */
    function readCubeLog(runId: string, workflow: string, task: string, cube: string): string {
        const path =
            `${base}/cicd/logs/${encodeURIComponent(runId)}/${encodeURIComponent(workflow)}` +
            `/${encodeURIComponent(task)}/${encodeURIComponent(cube)}`;
        try {
            const raw = api('GET', path) as { logs?: unknown } | null;
            return failureExcerpt(String(raw?.logs ?? ''), LOG_LIMIT);
        } catch (e: unknown) {
            return `(лог куба прочитать не удалось: ${errorText(e)})`;
        }
    }
}
