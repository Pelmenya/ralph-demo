// TaskSourceAdapter поверх SourceCraft (#415 снят для этого шва — мердж-путь роутится
// через adapters.taskSource, см. докблок RalphConfig.adapters).
//
// Почему площадка легла лучше GitHub, и что из этого следует для кода:
//   - СТАТУС ЖИВЁТ НА САМОЙ ISSUE (шесть значений: open/inProgress/paused/closed/
//     declined/duplicate). У GitHub их два, поэтому там понадобилась доска Projects с
//     полем Status и целый scripts/project-sync.mjs. Здесь доска — ПРОЕКЦИЯ статуса,
//     синхронизировать нечего: syncBoard честный no-op, а не заглушка «потом допишем».
//   - `paused` заменяет метку `hold`: приостановленная карточка выпадает из очереди
//     `status=open` сама, без отдельного фильтра.
//   - СВЯЗЬ issue↔PR структурная (linked_prs), а не фраза «Closes #N» в теле. Инцидент
//     #130 (русское «Закрывает #N» GitHub не распознал) здесь невозможен by design.
//
//   - КОММЕНТАРИИ PR (#37) — спека плюс живой ответ 11.08.2026: ключ
//     `pull_request_comments`, автор в `author.slug`, `anchor` есть ТОЛЬКО у комментария к
//     месту в диффе (у сводного его нет), а ложные поля площадка сериализует явно
//     (`is_deleted: false` приходит в ответе) — то есть отсутствие поля означает смену
//     формата, а не «false».
//
// Транспорт синхронный. Это не выбор стиля: всё ядро синхронно (`sh`/`ghJson` поверх
// execSync), и асинхронный клиент здесь потребовал бы переписать петлю целиком.
import type {
    ForgeCheckFailure,
    ForgeCheckRun,
    ForgeChecks,
    Issue,
    IssueDetails,
    NewPullRequest,
    NewReviewComment,
    PullRequest,
    ReviewComment,
    TaskSourceAdapter,
} from './adapters.ts';
// #269: чек PR на стороне площадки живёт отдельным модулем — у него своя тройка
// маршрутов (`merge-checks`, `cicd/runs`, `cicd/logs`), свой словарь статусов и свой
// режим отказа (лог куба fail-open при fail-closed прогоне). Здесь только проводка.
import { createSourcecraftCiChecks } from './sourcecraft-ci-checks.ts';
import { SOURCECRAFT_TOKEN_ENV } from './sourcecraft-api.ts';

// Ответ REST API, суженный до того, что нужно адаптеру. `unknown` вместо any — данные
// приходят из чужого JSON, форма проверяется на месте использования.
// DELETE в списке не для полноты: снятие метки у площадки — именно DELETE на
// `/labels` (маршрута `/labels/remove` в API нет вовсе), и без этого метода
// `removeBlockedLabel` физически нечем выразить.
export type SourcecraftApi = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
) => unknown;

export type SourcecraftTaskSourceDeps = {
    api: SourcecraftApi;
    org: string;
    repo: string;
    // Авторы, чьи issues раннер имеет право исполнять (C3: тело issue — это инструкции
    // для кодер-сессии). Чужие не попадают в очередь, но держат фазу открытой.
    // Геттер: реестр адаптеров собирается ДО резолва профиля, и снимок значения был бы
    // пустым навсегда — чужие issues перестали бы отсекаться (C3).
    authorAllowlist: () => readonly string[];
    log?: (msg: string) => void;
    // #56: имя переменной с токеном — то же, что получил транспорт (`createSourcecraftApi`).
    // Шов называет его ядру как свой секрет, и ядро вырезает значение из вывода упавшей
    // сессии, лога и пуша.
    tokenEnv?: string;
};

type ScLabel = { name?: unknown; slug?: unknown };
type ScIssue = {
    slug?: unknown;
    title?: unknown;
    labels?: unknown;
    author?: { slug?: unknown } | null;
    created_at?: unknown;
};
type ScPull = { slug?: unknown; labels?: unknown; status?: unknown };
// Комментарий PR у площадки (`PullRequestComment` в OpenAPI). Взято ровно то, от чего
// зависит счёт находок; остальные поля ответа адаптеру не нужны.
type ScPullComment = {
    body?: unknown;
    author?: { slug?: unknown } | null;
    anchor?: unknown;
    is_deleted?: unknown;
    is_published?: unknown;
};

function asArray(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

// Номер карточки у площадки — строковый `slug`, у ядра — число.
//
// Нечисловой slug — ОШИБКА, а не «карточки не существует». Прежняя версия возвращала
// null и карточка молча выпадала из выборки; беда в том, что выпадала она одинаково из
// `listReadyIssues` и `listAllOpenIssues`, а C2 сравнивает ровно эти два множества —
// предохранитель ослеп бы синхронно с обеих сторон. Для fail-closed методов неожиданная
// форма данных обязана быть отказом.
function slugToNumber(slug: unknown): number {
    const raw = String(slug ?? '').trim();
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error(
            `SourceCraft: slug карточки «${raw}» не число — форма ответа площадки изменилась. ` +
                'Молча пропустить карточку нельзя: она держит фазу открытой (C2).',
        );
    }
    return n;
}

// #43: статус карточки (а с #65 и вехи) из ответа площадки — строкой либо объектом со
// `slug`. Иная форма — `null`, то есть «не знаю»: сверка перед взятием тогда молчит, а не
// выкидывает карточку из очереди по догадке, и адрес накопителя не берёт веху вслепую.
function statusSlug(raw: unknown): string | null {
    const slug = typeof raw === 'object' && raw !== null ? (raw as { slug?: unknown }).slug : raw;
    return typeof slug === 'string' && slug.trim() !== '' ? slug.trim() : null;
}

// Метки ядро сравнивает по `name` ('blocked'/'hold'). У площадки есть и name, и slug,
// причём slug теряет двоеточие (`complexity:low` → `complexitylow`) — поэтому берём
// именно name, а slug оставляем как фолбэк для меток, заведённых без отображаемого имени.
function mapLabels(raw: unknown): Array<{ name: string }> {
    return asArray(raw)
        .map((l) => {
            const label = l as ScLabel;
            const name = String(label.name ?? label.slug ?? '').trim();
            return name ? { name } : null;
        })
        .filter((l): l is { name: string } => l !== null);
}

function mapIssue(raw: unknown): Issue {
    const issue = raw as ScIssue;
    return {
        number: slugToNumber(issue.slug),
        title: String(issue.title ?? ''),
        labels: mapLabels(issue.labels),
        author: { login: String(issue.author?.slug ?? '') },
        // #18: дата заведения — как отдаёт площадка (`created_at`, RFC3339). Пустую
        // строку не подставляем: «даты нет» и «дата такая-то» — разные ответы, и чистка
        // обязана видеть первое как «не знаю», а не как «эпоха».
        ...(issue.created_at ? { createdAt: String(issue.created_at) } : {}),
    };
}

function mapPull(raw: unknown): PullRequest {
    const pull = raw as ScPull;
    return { number: slugToNumber(pull.slug), labels: mapLabels(pull.labels) };
}

// QL-значения оборачиваются в двойные кавычки, поэтому кавычка внутри значения закрыла бы
// строку и остаток ушёл бы в фильтр как синтаксис. Имя ветки уже проверено SAFE_BRANCH_RE
// в ядре, но фильтр собирается и из milestone — там текст произвольный.
function ql(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Страница ≠ вся выборка. Оборванная на первой странице очередь — тот же класс отказа,
// что и неверный фильтр: петля увидит «фаза готова», не прочитав хвост (C2). Предел
// страниц — предохранитель от сервера, отдающего страницы бесконечно: зацикливание в
// синхронной петле снаружи не отличимо от зависания.
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export function createSourcecraftTaskSource(deps: SourcecraftTaskSourceDeps): TaskSourceAdapter {
    const {
        api,
        org,
        repo,
        authorAllowlist,
        log = () => {},
        tokenEnv = SOURCECRAFT_TOKEN_ENV,
    } = deps;
    const base = `/repos/${org}/${repo}`;
    const ciChecks = createSourcecraftCiChecks({ api, org, repo });

    // Обход страниц. `key` — имя массива в ответе: у issues это `issues`, у PR
    // `pull_requests`, у milestones `items` (у трёх ручек три разных ключа — это факт
    // площадки, проверенный живыми ответами, а не догадка по спеке).
    //
    // `strict` — ключ обязан прийти массивом на КАЖДОЙ странице, иначе отказ. Нужен там,
    // где пустой ответ опасен (#125: лента карточки для сверки намерения): `asArray` на
    // неверном ключе молча отдал бы пустоту, то есть «эффект не лёг» и повтор вслепую.
    const pageThrough = (path: string, key: string, strict = false): unknown[] => {
        const out: unknown[] = [];
        let token = '';
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const sep = path.includes('?') ? '&' : '?';
            const query = `${sep}page_size=${String(PAGE_SIZE)}${
                token ? `&page_token=${encodeURIComponent(token)}` : ''
            }`;
            const res = api('GET', `${path}${query}`) as Record<string, unknown> | null;
            if (strict && !Array.isArray(res?.[key])) {
                throw new Error(
                    `SourceCraft: ответ ${path} без массива \`${key}\` — формат ответа ` +
                        `неожиданный (получено: ${JSON.stringify(res).slice(0, 200)}).`,
                );
            }
            out.push(...asArray(res?.[key]));
            const next = String(res?.['next_page_token'] ?? '');
            // ПУСТОЙ токен (или его отсутствие) — сервер сказал «больше нет»: штатный конец.
            if (!next) return out;
            // ПОВТОРЁННЫЙ токен — сервер ведёт себя не по спеке, и сколько осталось за
            // кадром, неизвестно (#43). Раньше оба случая возвращали собранное как полный
            // ответ: один способ оборвать выборку был закрыт отказом по MAX_PAGES, а этот,
            // соседний, — нет. Неполная очередь читается петлёй как «фаза готова» (C2),
            // поэтому неизвестность здесь обязана быть отказом, а не половиной данных.
            if (next === token) {
                // Токен в сообщении — он опознаёт страницу, на которой сервер зациклился;
                // без него в логе видно только «что-то пошло не так на этом маршруте».
                // Обрезан: у площадки он длинный и в строку лога целиком не нужен.
                const shown = next.length > 40 ? `${next.slice(0, 40)}…` : next;
                throw new Error(
                    `SourceCraft: обход страниц ${path} получил ТОТ ЖЕ page_token дважды ` +
                        `(${shown}) — сервер отвечает не по спеке. Сколько карточек осталось ` +
                        'за кадром, неизвестно; отдать собранное как полную выборку нельзя (C2).',
                );
            }
            token = next;
        }
        throw new Error(
            `SourceCraft: обход страниц ${path} не сошёлся за ${String(MAX_PAGES)} страниц — ` +
                'обрывать выборку нельзя, неполная очередь читается петлёй как готовая фаза (C2).',
        );
    };

    // Имя milestone из конфига фазы — НЕ его slug на площадке (slug генерируется из
    // имени с потерей символов, как у меток). Фильтр issues принимает только
    // `milestone_slug`/`milestone_id`, а сам список milestones фильтровать по имени
    // нечем: сервер не знает полей `title` и `name` («unknown field» на оба). Значит
    // резолв — на клиенте, листингом.
    //
    // Кешируется только НАЙДЕННОЕ: milestone могут завести уже по ходу прогона, и
    // запомненный отрицательный ответ ослепил бы петлю до перезапуска.
    //
    // Резолв отдаёт ОБА адреса вехи, потому что площадка спрашивает их в разных местах
    // разными: фильтр issues понимает `milestone_slug`, а тело создания карточки —
    // `milestone_id` (#16). Один общий листинг на оба — и один кеш.
    const milestoneCache = new Map<string, { slug: string; id: string }>();
    const findMilestone = (name: string): { slug: string; id: string } | null => {
        const cached = milestoneCache.get(name);
        if (cached !== undefined) return cached;
        const found = pageThrough(`${base}/milestones`, 'items').find(
            (m) => String((m as { name?: unknown }).name ?? '') === name,
        ) as { slug?: unknown; id?: unknown } | undefined;
        const slug = String(found?.slug ?? '');
        // Веха без ОБОИХ адресов бесполезна, но требовать оба нельзя: очередь фазы ходит
        // по slug'у и жила бы без id, а адрес карточки — наоборот. Поэтому пустые поля не
        // подставляются молча: пустой `milestone_id` площадка отвергает, и отказ уносил бы
        // с собой карточку (ревью PR !6).
        const id = String(found?.id ?? '');
        if (!slug && !id) return null;
        const resolved = { slug, id };
        milestoneCache.set(name, resolved);
        return resolved;
    };

    // Ненайденная веха ФАЗЫ — отказ: см. выше про C2. Заведение карточки живёт по другому
    // правилу (адрес дешевле находки) и потому зовёт `findMilestone` напрямую.
    const milestoneSlug = (name: string): string => {
        const found = findMilestone(name);
        if (!found?.slug) {
            throw new Error(
                `SourceCraft: milestone «${name}» не найден в ${org}/${repo}. Пустая очередь ` +
                    'вместо отказа означала бы «фаза готова» при неразобранных задачах (C2).',
            );
        }
        return found.slug;
    };

    // #40: имя метки → её slug на площадке. Ядро оперирует ИМЕНАМИ (`complexity:low`),
    // площадка — slug'ами, и slug тут не выводится из имени: автогенерация теряет
    // двоеточие (`complexitylow`), поэтому slug'и заданы руками (`complexity-low`).
    // Вывести его формулой значило бы угадать чужое решение — резолв только листингом.
    //
    // Кешируется только НАЙДЕННОЕ, как и у milestone: метку могут завести по ходу прогона.
    const labelSlugCache = new Map<string, string>();
    const labelSlug = (name: string): string => {
        const cached = labelSlugCache.get(name);
        if (cached !== undefined) return cached;
        const found = pageThrough(`${base}/labels`, 'items').find(
            (l) => String((l as { name?: unknown }).name ?? '') === name,
        ) as { slug?: unknown } | undefined;
        const slug = String(found?.slug ?? '');
        if (!slug) {
            throw new Error(
                `SourceCraft: метка «${name}» не заведена в ${org}/${repo}. Создать карточку без ` +
                    'заявленных меток нельзя: голая карточка не видна ни роутингу моделей, ни человеку.',
            );
        }
        labelSlugCache.set(name, slug);
        return slug;
    };

    // Fail-open обёртка для косметики (метки, закрытие milestone): сбой форжа логируется,
    // но петлю не роняет — таков контракт этих методов в adapters.ts.
    const quiet = (what: string, fn: () => void): void => {
        try {
            fn();
        } catch (e: unknown) {
            log(
                `⚠ ${what} не удалось (не критично): ${String((e as Error)?.message).split('\n')[0]}`,
            );
        }
    };

    // `statusFilter` — не деталь, а разница двух вопросов. «Что брать в работу» — это
    // ровно `open`. «Держит ли фаза» — всё незакрытое: карточка в работе (`in_progress`)
    // или на паузе (`paused`) тоже незакрытая работа, и фазу она держать обязана.
    //
    // Значения — snake_case, хотя ЗАПИСЬ статуса идёт camelCase (`status_slug:
    // 'inProgress'`). Асимметрия площадки, проверенная её же ответом на невалидное
    // значение: «allowed values: open, in_progress, paused, closed, declined,
    // duplicate». Спека при этом перечисляет три значения и врёт — сверять по ней
    // одной было бы недостаточно.
    //
    // Пустой `statusFilter` — выборка без условия по статусу (все шесть значений, в том
    // числе `closed`). Фильтр из одного `milestone_slug` площадка принимает — проверено
    // живым ответом, а не спекой.
    const listIssues = (milestone: string, statusFilter: string): Issue[] => {
        const milestoneClause = `milestone_slug=${ql(milestoneSlug(milestone))}`;
        const filter = statusFilter ? `${statusFilter} and ${milestoneClause}` : milestoneClause;
        return pageThrough(`${base}/issues?filter=${encodeURIComponent(filter)}`, 'issues').map(
            mapIssue,
        );
    };

    // Карточки фазы ЛЮБОГО статуса — общий источник для двух вопросов: «были ли задачи
    // вообще» (C5) и «какие у них метки» (#37). Одна функция, чтобы ответы про одну и ту
    // же фазу не разъехались при правке запроса.
    const allStatusIssues = (milestone: string): Issue[] => listIssues(milestone, '');

    const listPulls = (branch: string, status: 'open' | 'merged'): PullRequest[] => {
        const filter = `status=${status} and source_branch=${ql(branch)}`;
        return pageThrough(
            `${base}/pulls?filter=${encodeURIComponent(filter)}`,
            'pull_requests',
        ).map(mapPull);
    };

    // #49: голова PR — поле `source.sha` ответа `GET /pulls/{slug}` (сверено с OpenAPI
    // площадки). Одно чтение на два вопроса: «на чём гонять чеки» (шов `pullRequestHeadSha`)
    // и «не уехала ли голова перед мерджем». Две копии одного запроса разъехались бы молча,
    // а разъехаться им тут значит сверять мердж не с тем, что проверял гейт.
    //
    // Fail-closed: пустое поле — отказ, а не пустая строка. Ответ без `source.sha` («{}» на
    // пустое тело) и «голова та же» — разные события, и второе из первого не следует.
    const readHeadSha = (prNumber: number): string => {
        const pr = api('GET', `${base}/pulls/${prNumber}`) as {
            source?: { sha?: unknown };
        } | null;
        const sha = String(pr?.source?.sha ?? '').trim();
        if (!sha) {
            throw new Error(
                `Голову PR #${prNumber} прочитать не удалось: площадка не вернула source.sha.`,
            );
        }
        return sha;
    };

    // Метку ставим/снимаем на PR ветки. Отдельным запросом ищем PR: у площадки метки
    // назначаются и на issues, и на PR, но раннер помечает именно PR (#217/#222).
    const labelPull = (branch: string, label: string, add: boolean): void => {
        const pulls = listPulls(branch, 'open');
        if (pulls.length !== 1) {
            log(`⚠ Метка '${label}': открытых PR ветки ${branch} — ${pulls.length}, пропускаю.`);
            return;
        }
        // Тело — `ModifyLabelCollectionRequest`: только `ids` либо `slugs`, поля
        // `labels` в нём нет. Снятие — DELETE на ТОТ ЖЕ путь; маршрута
        // `/labels/remove` в API не существует, прежний запрос уходил в 404 и гас в
        // `quiet()` — метка `blocked` не снималась никогда, а мердж-путь её проверяет.
        // То есть петля вставала намертво после первого блока ревью, молча.
        const path = `${base}/pulls/${pulls[0].number}/labels`;
        api(add ? 'POST' : 'DELETE', path, { slugs: [label] });
    };

    return {
        secretEnvNames: () => [tokenEnv],
        // Дешёвый авторизованный запрос: карточка самого репозитория. Отвергнутый токен
        // даёт 401 на любом маршруте, транспорт превращает ненулевой код curl в
        // исключение — а `checkAuth` его не глушит (fail-closed по контракту шва).
        //
        // Именно репозиторий, а не профиль пользователя: он проверяет разом и токен, и
        // то, что координаты `org`/`repo` указывают на существующее место. Валидный
        // токен при опечатке в репозитории иначе прошёл бы старт и вскрылся пустой
        // очередью — тем самым «фаза готова», от которого мы и защищаемся.
        checkAuth(): void {
            api('GET', base);
        },

        // Fail-closed: сбой площадки на очереди обязан ронять петлю, иначе раннер решит,
        // что фаза пуста, и уйдёт сдавать недоделанную работу (C2).
        listReadyIssues(milestone: string): Issue[] {
            return listIssues(milestone, 'status=open')
                .filter((i) => !(i.labels ?? []).some((l) => l.name === 'blocked'))
                .filter((i) => authorAllowlist().includes(i.author?.login ?? ''))
                .sort((a, b) => a.number - b.number);
        },

        // БЕЗ фильтров по меткам и авторам (C2): blocked и чужие issues тоже держат фазу
        // открытой. И `paused` держит: он заменяет метку `hold` в ОЧЕРЕДИ (карточка не
        // берётся в работу), но приостановленная работа — незакрытая работа, и считать
        // фазу готовой при ней нельзя. `in_progress` — тем более.
        listAllOpenIssues(milestone: string): Issue[] {
            return listIssues(milestone, 'status in (open, in_progress, paused)');
        },

        // #65: статус вехи — свежим листингом, мимо кеша резолва. Кеш помнит адреса вехи,
        // и они не меняются; статус меняет сам раннер, закрывая веху сданной фазы, и
        // запомненный ответ держал бы закрытый том открытым до конца прогона. Статус в
        // листинге — строка (`open`/`closed`), той же формы, какой его пишет closeMilestone,
        // но читается он `statusSlug`, как статус карточки: форма поля спекой не закреплена,
        // и объект со `slug` иначе стал бы «[object Object]» — отказом на каждой вехе, то
        // есть #65 не работал бы вовсе. Незнакомое значение — отказ, а не «открыта»:
        // молчаливое `true` и есть #65.
        isMilestoneOpen(title: string): boolean {
            const found = pageThrough(`${base}/milestones`, 'items').find(
                (m) => String((m as { name?: unknown }).name ?? '') === title,
            ) as { status?: unknown } | undefined;
            if (!found) {
                throw new Error(`SourceCraft: milestone «${title}» не найден в ${org}/${repo}.`);
            }
            const status = statusSlug(found.status);
            if (status !== 'open' && status !== 'closed') {
                throw new Error(
                    `SourceCraft: milestone «${title}» отдан с неизвестным статусом ` +
                        `${JSON.stringify(found.status)} — открыт ли он, неизвестно.`,
                );
            }
            return status === 'open';
        },

        // #37: метки всех карточек фазы. Закрытые карточки характеризуют фазу не меньше
        // открытых — сложная задача, уже сделанная в этой фазе, зону риска не отменяет.
        // Запрос тот же, что у hasAnyIssues, и это ОДНА функция (`allStatusIssues`), а не
        // два похожих вызова: разъехавшись, они дали бы двум ответам про одну фазу разные
        // основания. Предел выборки здесь не нужен — `pageThrough` обходит все страницы
        // и сам отказывает, если обход не сошёлся.
        listMilestoneLabels(milestone: string): string[] {
            return allStatusIssues(milestone).flatMap((i) => (i.labels ?? []).map((l) => l.name));
        },

        // C5: были ли у фазы задачи вообще. Без условия по статусу — закрытые считаются,
        // именно они и отличают сделанную фазу от неначатой. Ненайденный milestone здесь
        // не превращается в `false`: `milestoneSlug` бросает, и это правильный диагноз —
        // конфиг разошёлся с площадкой, а не «фазу не начинали».
        hasAnyIssues(milestone: string): boolean {
            return allStatusIssues(milestone).length > 0;
        },

        // #50: карточка целиком. Отдельный маршрут `GET /issues/{slug}`: в выборке очереди
        // тела нет, да и тянуть тела всей очереди ради одной задачи незачем. Поле тела у
        // площадки — `description`, а не `body` (сверено со спекой).
        getIssue(number: number): IssueDetails {
            const raw = api('GET', `${base}/issues/${String(number)}`) as {
                slug?: unknown;
                title?: unknown;
                description?: unknown;
                status?: unknown;
            } | null;
            const title = String(raw?.title ?? '').trim();
            if (!title) {
                throw new Error(
                    `SourceCraft: карточка #${String(number)} не прочиталась (в ответе нет заголовка). ` +
                        'Сессия без тела задачи выдумает себе работу — это отказ, а не пустая карточка.',
                );
            }
            // #43: статус для сверки перед взятием. В очередь идёт ровно `open`, значит
            // и «берётся» — ровно он: `paused` (замена `hold`) и закрытые не берутся.
            // Форма поля в ответе спекой не закреплена, принимаются обе — строка и объект
            // со `slug`; иная форма — «не знаю», поле не ставится.
            const status = statusSlug(raw?.status);
            return {
                number: slugToNumber(raw?.slug ?? number),
                title,
                body: String(raw?.description ?? ''),
                ...(status === null ? {} : { open: status === 'open' }),
            };
        },

        // #37: комментарии PR одной лентой. У площадки маршрут ОДИН — `GET /pulls/{slug}/
        // comments`, ключ ответа `pull_request_comments` (по её OpenAPI), — тогда как у
        // GitHub поверхностей три. Ровно эта разница и есть причина, по которой вопрос
        // «где лежат комментарии» задаётся шву, а не решается в ядре.
        //
        // `isSummary` определяется СТРУКТУРНО: у комментария к месту в диффе есть `anchor`,
        // у сводного обзорного его нет вовсе. Разбирать формулировку («итого», «в целом»)
        // значило бы завести эвристику там, где площадка отвечает фактом.
        //
        // Размен записан честно: находка, оставленная ревью НЕ к строке, тоже уйдёт в
        // unmarked, то есть метрика скорее занизит severity, чем завысит. Выбрано занижение —
        // сводка дублирует находки того же прохода, и её учёт давал бы систематический +1
        // на каждый проход, искажая ровно тот тренд («ревью слабеет/крепнет»), ради
        // которого журнал заведён.
        listPullRequestComments(prNumber: number): ReviewComment[] {
            return (
                pageThrough(`${base}/pulls/${String(prNumber)}/comments`, 'pull_request_comments')
                    .map((raw) => raw as ScPullComment)
                    // Удалённый комментарий находкой не считается, черновик — тем более: он
                    // виден только автору и в ревью не участвовал. Сверка со ЗНАЧЕНИЕМ, а не
                    // приведение к boolean: отсутствие поля означает «сервер его не прислал»,
                    // и трактовать это как «удалён»/«не опубликован» значило бы выкосить
                    // обычные комментарии на первой же смене формата ответа.
                    .filter((c) => c.is_deleted !== true && c.is_published !== false)
                    .map((c) => ({
                        body: String(c.body ?? ''),
                        isSummary: c.anchor === undefined || c.anchor === null,
                        author: String(c.author?.slug ?? ''),
                    }))
                    // Пустое тело (или комментарий без него) находкой быть не может, а в total
                    // попало бы наравне с остальными и разбавило метрику.
                    .filter((c) => c.body.trim() !== '')
            );
        },

        // #45: комментарий в PR от имени раннера. Тело — `CreatePullRequestCommentBody`.
        //
        // `publish: true` передаётся ЯВНО и это не перестраховка: спека обещает «defaults to
        // true», а живой сервер создал комментарий с `is_published: false` (#23). Черновик
        // виден только автору — то есть ни человеку, ни счётчику находок, который сам же
        // такие и отбрасывает. Молчаливый черновик равен потерянному замечанию ревью.
        //
        // Якорь: `{path, position:{from,to,side}}` (`ShortAnchor` в OpenAPI). Одна строка
        // задаётся вырожденным диапазоном from==to. `side: 'source'` — сторона диффа, в
        // которой живёт правка (проверено живым ответом площадки на комментарий к строке).
        commentOnPullRequest(prNumber: number, input: NewReviewComment): void {
            const anchor = input.anchor;
            // #575: у ядра между инлайном и сводкой есть ступень «комментарий уровня файла»
            // (якорь без строки). В `ShortAnchor` площадки позиция обязательна, файлового
            // комментария как вида здесь нет — и это ОТКАЗ, а не повод положить сводкой
            // самим: сводку кладёт ядро и пишет об этом в лог. Молчаливая подмена дала бы
            // в логе «замечание легло комментарием файла» при фактической сводке.
            if (anchor && anchor.line === undefined) {
                throw new Error(
                    `Комментарий уровня файла (${anchor.path}) площадка не поддерживает: ` +
                        'у якоря обязательна позиция в диффе.',
                );
            }
            // #41: старая сторона диффа. Живым ответом площадки проверена только `source`
            // (новая версия); значение для старой не проверено ничем, и угаданное имя
            // повесило бы замечание к удалённой строке на чужой код. Отказ — и ядро само
            // спустится по ступеням к сводке с местом.
            if (anchor?.line !== undefined && anchor.side === 'LEFT') {
                throw new Error(
                    `Комментарий к удалённой строке (${anchor.path}:${String(anchor.line)}) ` +
                        'площадка в этом адаптере не поддерживает: сторона старой версии не проверена.',
                );
            }
            const created = api('POST', `${base}/pulls/${String(prNumber)}/comments`, {
                body: input.body,
                publish: true,
                ...(anchor
                    ? {
                          anchor: {
                              path: anchor.path,
                              position: { from: anchor.line, to: anchor.line, side: 'source' },
                          },
                      }
                    : {}),
            }) as { is_published?: unknown } | null;
            // СВЕРКА, а не доверие к флагу запроса: черновик отдаётся ответом как успешно
            // созданный комментарий (201 + тело), и отличить его от опубликованного можно
            // только по `is_published`. Ровно так дефект #23 и выглядел снаружи — «всё
            // прошло», а замечания не видит никто. Отсутствие поля отказом НЕ считаем:
            // это смена формата ответа, а не доказательство черновика.
            if (created?.is_published === false) {
                throw new Error(
                    `Комментарий в PR #${String(prNumber)} остался ЧЕРНОВИКОМ (is_published: false) — ` +
                        'его видит только автор, то есть для человека и для счёта находок его нет.',
                );
            }
        },

        // #46: PR фазы. `publish: true` — не перестраховка: спека площадки прямо говорит
        // «default: false = draft», то есть без флага раннер завёл бы черновик, а гейт
        // прочитал бы его как «PR нет» и цикл сдачи встал бы с неверным диагнозом.
        //
        // Сверка по ОТВЕТУ (`status`), а не по флагу запроса — тот же приём, что у
        // комментариев: черновик отдаётся как успешно созданный PR, отличить его можно
        // только по статусу. Значения статуса: draft/open/discarded/merging/merged.
        createPullRequest({ branch, title, body }: NewPullRequest): number | null {
            const created = api('POST', `${base}/pulls`, {
                title,
                description: body,
                source_branch: branch,
                target_branch: 'main',
                publish: true,
            }) as { slug?: unknown; status?: unknown } | null;
            if (String(created?.status ?? '') === 'draft') {
                throw new Error(
                    `PR ветки ${branch} создан ЧЕРНОВИКОМ — для гейта это то же самое, что PR нет. ` +
                        'Публикация обязана быть явной.',
                );
            }
            const num = Number(String(created?.slug ?? '').trim());
            return Number.isInteger(num) && num > 0 ? num : null;
        },

        // Fail-closed на неоднозначности: >1 открытого PR на ветку → null, не гадаем,
        // какой мерджить.
        findOpenPullRequest(branch: string): PullRequest | null {
            const pulls = listPulls(branch, 'open');
            if (pulls.length !== 1) return null;
            return pulls[0];
        },

        // #49: голову для гейта отдаёт форж — раньше её читал сам гейт через `gh`, которого
        // здесь нет вовсе. Реализация — общий с мерджем `readHeadSha` (см. его докблок).
        pullRequestHeadSha: readHeadSha,

        isPhaseMerged(phase: { branch: string }): boolean {
            return listPulls(phase.branch, 'merged').length > 0;
        },

        mergedPullRequestNumber(phase: { branch: string }): number | null {
            const merged = listPulls(phase.branch, 'merged');
            return merged.length > 0 ? merged[0].number : null;
        },

        // ВАЖНО ПРО TOCTOU — ЗДЕСЬ ЗАЩИТА СЛАБЕЕ, ЧЕМ У GitHub. Проверено по OpenAPI
        // (`api.sourcecraft.tech/sourcecraft.swagger.json`), а не по наблюдению:
        //   - тело мерджа = ровно `rebase`/`squash`/`delete_branch`/`force`; аналога
        //     `--match-head-commit` нет;
        //   - условных заголовков (`If-Match`/`ETag`) в API нет ни на одном пути.
        // Единственное, на что можно опереться, — `PullRequest.source.sha` в ответе.
        //
        // Поэтому окно закрывается сверкой: читаем текущую голову и сравниваем с
        // верифицированной гейтом. Признать это эквивалентом нельзя по двум причинам:
        // между сверкой и мерджем остаётся окно, и сам мердж у площадки АСИНХРОННЫЙ
        // (отдаёт operation_id), то есть окно шире, чем у синхронного вызова. Инвариант
        // №4 здесь выполнен слабее — записано в журнал переносимости как факт, а не
        // как недоделка, которую можно дописать.
        //
        // Расхождение = отказ (бросаем): мердж-путь трактует исключение как «не удалось»,
        // а не как «смерджено». НЕВОЗМОЖНОСТЬ ПРОВЕРИТЬ — тоже отказ: пустой `source.sha`
        // (ответ без поля, `{}` на пустое тело) раньше проходил условие `actual &&
        // actual !== headSha` насквозь, и мердж уходил на неверифицированную голову —
        // ровно тот исход, который проверка обязана запрещать.
        mergePullRequest(prNumber: number, headSha?: string | null): void {
            if (headSha) {
                // Тот же `readHeadSha`, что стоит за швом `pullRequestHeadSha` (#49), — не
                // вторая копия запроса. Метод шва уходит в гейт ССЫЛКОЙ (`mergePrFn`), без
                // приёмника, поэтому здесь именно функция замыкания, а не `this.…`:
                // `this` в этой точке undefined, и обращение к нему было бы TypeError'ом
                // ровно на мердж-пути.
                let actual: string;
                try {
                    actual = readHeadSha(prNumber);
                } catch (e: unknown) {
                    throw new Error(
                        `Голову PR #${prNumber} не удалось верифицировать (${(e as Error).message}). ` +
                            'Мердж отменён — «не смогли проверить» не равно «совпало».',
                    );
                }
                if (actual !== headSha) {
                    throw new Error(
                        `Голова PR #${prNumber} уехала после прогона чеков: гейт проверял ${headSha}, ` +
                            `сейчас ${actual}. Мердж отменён — иначе в main уехал бы непрогнанный код.`,
                    );
                }
            }
            api('POST', `${base}/pulls/${prNumber}/merge`, { squash: true, delete_branch: true });
        },

        // #269: вердикт чека PR у площадки и детали красного прогона. Реализация —
        // в `sourcecraft-ci-checks.ts`, здесь проводка: шов обязан отдавать эти два
        // метода, а не заставлять ядро знать про второй модуль.
        pullRequestChecks(prNumber: number): ForgeChecks {
            return ciChecks.pullRequestChecks(prNumber);
        },

        redCheckDiagnosis(run: ForgeCheckRun): ForgeCheckFailure | null {
            return ciChecks.redCheckDiagnosis(run);
        },

        addBlockedLabel(branch: string): void {
            quiet(`Пометить PR ветки ${branch} как blocked`, () =>
                labelPull(branch, 'blocked', true),
            );
        },

        removeBlockedLabel(branch: string): void {
            quiet(`Снять blocked с PR ветки ${branch}`, () => labelPull(branch, 'blocked', false));
        },

        // Fail-open по контракту, поэтому «не найден» здесь — лог, а не отказ (в отличие
        // от очереди issues, где тот же резолв обязан бросать). Прежняя версия была
        // сломана дважды: фильтровала по полю `title`, которого у milestones нет
        // (сервер: «unknown field»), и читала ответ по ключу `milestones` вместо `items`.
        closeMilestone(title: string): void {
            quiet(`Закрыть milestone «${title}»`, () => {
                api('PATCH', `${base}/milestones/${milestoneSlug(title)}`, { status: 'closed' });
            });
        },

        // НЕ заглушка, а осознанный no-op: доска площадки — проекция статуса issue,
        // карточка едет по колонкам сама. Синхронизировать нечего, и это единственная
        // причина, по которой project-sync.mjs здесь не нужен вовсе.
        syncBoard(): void {},

        // ── Намерения кодер-сессии (#40), все fail-closed ───────────────────
        //
        // Никакого `quiet()` здесь нет намеренно: сбой этих четырёх — потеря того, о чём
        // сессия просила (закрытие, блокировка, вопрос человеку), и петля обязана про
        // него узнать. Тело комментария и заголовок уходят полем JSON, не строкой команды:
        // канал шелла в этом пути отсутствует как класс (C3).
        commentOnIssue(issue: number, body: string): void {
            api('POST', `${base}/issues/${String(issue)}/comments`, { body });
        },

        // #125: лента карточки для сверки начатого намерения по метке (#94). Ключ
        // `issue_comments` сверен живым ответом 27.10.2026 (пустая лента приходит
        // `{"issue_comments":[],"next_page_token":""}`, страницы — тем же `page_token`), а не
        // выведен по аналогии с `pull_request_comments`: угаданный ключ дал бы пустую ленту,
        // то есть повтор комментария вслепую. Поэтому обход строгий — нет ключа, отказ.
        listIssueComments(issue: number): string[] {
            return pageThrough(`${base}/issues/${String(issue)}/comments`, 'issue_comments', true)
                .map((raw) => (raw as { body?: unknown } | null)?.body)
                .map((body) => (typeof body === 'string' ? body : ''));
        },

        // Статус пишется camelCase-значением (`closed` тут совпадает, но `inProgress` —
        // нет), тогда как ЧИТАЕТСЯ фильтр snake_case'ом. Асимметрия площадки, см. докблок
        // listIssues.
        closeIssue(issue: number): void {
            api('PATCH', `${base}/issues/${String(issue)}`, { status_slug: 'closed' });
        },

        // Метка на КАРТОЧКЕ. Тело — `ModifyLabelCollectionRequest` (`ids` либо `slugs`),
        // тот же, что у меток PR.
        blockIssue(issue: number): void {
            api('POST', `${base}/issues/${String(issue)}/labels`, {
                slugs: [labelSlug('blocked')],
            });
        },

        // Веху выбирает ВЫЗЫВАЮЩИЙ, а не адаптер (#16): карточка, попавшая в веху текущей
        // фазы, удлинила бы фазу, которую раннер сейчас сдаёт, — но знает про текущую фазу
        // ядро, а не площадка. Не попросили адреса — карточка едет без него, как раньше.
        //
        // Веха названа, но её на площадке нет — карточка всё равно заводится, без адреса и
        // с записью в лог. Отказ здесь стоил бы находки ради удобства чтения бэклога;
        // молчание стоило бы того, что ключ конфига врёт, а узнать об этом неоткуда.
        createIssue({
            title,
            body,
            labels: names,
            milestone,
        }: {
            title: string;
            body: string;
            labels: readonly string[];
            milestone?: string;
        }): number | null {
            const found = milestone ? findMilestone(milestone) : null;
            // Адресуем ТОЛЬКО по непустому id: пустая строка в `milestone_id` — не «без
            // вехи», а невалидный запрос, который площадка отвергает целиком.
            const target = found?.id ? found : null;
            if (milestone && !target) {
                log(
                    `⚠ Веха «${milestone}» не найдена в ${org}/${repo} (или отдана без id) — ` +
                        `карточка «${title}» заведена без неё.`,
                );
            }
            const created = api('POST', `${base}/issues`, {
                title,
                description: body,
                label_slugs: names.map(labelSlug),
                ...(target ? { milestone_id: target.id } : {}),
            }) as { slug?: unknown } | null;
            const slug = String(created?.slug ?? '').trim();
            const num = Number(slug);
            return Number.isInteger(num) && num > 0 ? num : null;
        },
    };
}
