// #72 (хвост #55): команды форжа по КАРТОЧКАМ, переехавшие из `core/orchestrator.ts`.
//
// #55 вынес из ядра четыре примитива гейта, но вся остальная GitHub-реализация швов
// осталась внутри оркестратора — десять вызовов `gh` на очередь задач, тела карточек,
// применение намерений сессии, закрытие вехи и синк доски. Барьер чистоты ядра из-за
// этого сторожил СПИСОК очищенных модулей, а не весь `core/**`: одиннадцатый вызов
// дописался бы в оркестратор, не покраснев ни на чём.
//
// Здесь — половина «карточки»: очередь фазы, метки, тело задачи, четыре мутации намерений
// (#40), закрытие вехи и синк доски. Вторая половина (pull request'ы) — соседний
// `github-pr-commands.ts`; примитивы мердж-пути — `github-forge-commands.ts`. Деление по
// темам, а не одним файлом: у оркестратора эти группы имеют разных потребителей (очередь
// читает runLoop, мутации — применение намерений, веха и доска — цикл сдачи), и один
// файл на всё дал бы модуль, который никто не читает целиком.
//
// Что ОСТАЛОСЬ в ядре и почему. Фильтр `human` (#133) стоит поверх шва, а не здесь: копия
// правила в каждой реализации разъезжается — это уже стоило нам #143. Валидация формы
// ответа, которую делает вызывающий (номер PR, sha), тоже остаётся у него: адаптер
// отвечает на «как спросить», ядро — на «что считать годным».
import type { Issue, IssueDetails } from './adapters.ts';

type ExecOpts = { env?: NodeJS.ProcessEnv };
type ShFn = (cmd: string, opts?: ExecOpts) => string;
type ShArgvFn = (file: string, args: string[], opts?: ExecOpts) => string;
type GhJsonFn = <T = unknown>(cmd: string, attempts?: number) => T;
type LogFn = (msg: string) => void;
type FailFn = (msg: string) => never;

export type GithubIssueCommandsEnv = {
    sh: ShFn;
    shArgv: ShArgvFn;
    ghJson: GhJsonFn;
    shq: (value: unknown) => string;
    log: LogFn;
    fail: FailFn;
    /** Ленивый геттер, а не снимок: `config` в оркестраторе заполняется в `main()`, уже
     *  ПОСЛЕ сборки адаптеров, и захваченный список авторов был бы пустым навсегда. */
    getAuthorAllowlist: () => string[];
    /** Путь скрипта синка доски из `consumerScripts` конфига потребителя (канон, задача 23);
     *  ленивый по той же причине. `undefined` — синк выключен. */
    getProjectSyncScript: () => string | undefined;
};

// Предел выборки карточек фазы — ОДИН на все три вопроса к форжу (очередь, полный список,
// метки). Не «сколько влезет», а граница, за которой ответ перестаёт быть доказательством:
// упёршись в неё, функция отказывает, а не отдаёт неполный список.
//
// #19: раньше предел стоял только у чтения меток, а очередь и полный список шли БЕЗ
// `--limit` — то есть на дефолте `gh`, который равен 30. «Полный список открытых карточек
// фазы» полным не был, и урезание было молчаливым: ответ на 31-й карточке выглядит ровно
// так же, как исчерпывающий. На этом ответе стоит разрешение мерджа (C2) и ранняя проверка
// конфликта меток (#17) — оба барьера слепли синхронно.
//
// #72: предел живёт ЗДЕСЬ, а не в ядре, потому что это свойство ЭТОГО форжа. У SourceCraft
// такой дыры нет вовсе: её `listIssues` идёт через `pageThrough`, который обходит страницы
// и отказывает сам, — и общая на две реализации константа врала бы про обе.
const ISSUE_LIST_LIMIT = 200;

/**
 * Отказ вместо неполного ответа. Отличить «ровно предел карточек и есть» от «нам отдали
 * первую страницу» нечем, поэтому равенство трактуется как урезание: тихая полнота здесь
 * хуже честного отказа. Фаза из 200 карточек — сама по себе повод разобраться (правило
 * «не более 5 карточек в вехе, отдаваемой фазой»).
 */
function assertNotTruncated(count: number, milestone: string, what: string): void {
    if (count >= ISSUE_LIST_LIMIT) {
        throw new Error(
            `${what} фазы «${milestone}»: вернулось не меньше предела выборки ` +
                `(${String(ISSUE_LIST_LIMIT)}) — считать ответ полным нельзя, часть карточек ` +
                'могла остаться за пределом. Разбери веху на несколько или подними предел осознанно.',
        );
    }
}

/**
 * Команды форжа по карточкам для GitHub CLI. Тексты логов, режимы отказа и DI-каналы
 * перенесены дословно: переезд не меняет наблюдаемого поведения петли — сценарные сьюты
 * зовут эти функции через ре-экспорт оркестратора и остаются зелёными без правок ассертов.
 */
export function createGithubIssueCommands(env: GithubIssueCommandsEnv) {
    const { sh, shArgv, ghJson, shq, log, fail, getAuthorAllowlist, getProjectSyncScript } = env;

    // Единственная форма «форж авторизован» у GitHub CLI. Раньше этот вызов стоял прямо в
    // preflight ядра — то есть петля требовала `gh` даже там, где форжем выбран не GitHub
    // (#35); потом переехал в composition root оркестратора одной строкой-литералом, что
    // от барьера чистоты ядра его всё равно не отличало (#72).
    function checkAuth(): void {
        sh('gh auth status');
    }

    /**
     * Рабочая очередь фазы: открытые issues МИНУС human МИНУС blocked МИНУС чужие авторы.
     *
     * - human (#410): задача человека, раннер её не исполняет (см. excludeHumanIssues).
     * - blocked: агент упёрся в ручной гейт (npm install и т.п.) — пропускаем, чтобы
     *   AFK-цикл не сжигал итерации об одну стену; label снимает человек. ВАЖНО (C2):
     *   такие issues не выпадают из фазы — сдача проверяет открытые issues БЕЗ фильтров
     *   blocked/author (allOpenIssues ниже), фаза с blocked-хвостами не мерджится.
     * - authorAllowlist (C3): репо публичный, issue может создать кто угодно, а его body
     *   попадает в bypassPermissions-сессию как инструкции — прямой канал инъекции.
     *   Чужие issues не исполняем; они остаются открытыми и сознательно блокируют сдачу
     *   фазы до триажа человеком — fail-closed вместо молчаливого игнора.
     */
    function openIssues(
        milestone: string,
        { ghJsonFn = ghJson, failFn = fail }: { ghJsonFn?: GhJsonFn; failFn?: FailFn } = {},
    ): Issue[] {
        let raw: Issue[];
        try {
            raw = ghJsonFn<Issue[]>(
                `gh issue list --milestone ${shq(milestone)} --state open --json number,title,labels,author,createdAt --limit ${String(ISSUE_LIST_LIMIT)}`,
            );
        } catch (e) {
            return failFn(
                `gh issue list упал (после ретраев): ${(e as Error).message}\nПроверь: gh auth status, milestone "${milestone}" существует.`,
            ) as unknown as Issue[];
        }
        // Проверка полноты стоит ЗА catch намеренно (#72-ревью). Внутри try её отказ
        // выходил наружу с чужим диагнозом — «gh issue list упал (после ретраев) … Проверь:
        // gh auth status, milestone существует», — тогда как урезанная выборка не сбой `gh`
        // и не отсутствующая веха: чинится она разбором вехи, а не логином. Ровно тот класс
        // подмены причины, ради которого заведён #144. Сырой ответ, до фильтров: после
        // отсева blocked/чужих урезание уже неотличимо от «столько и было».
        assertNotTruncated(raw.length, milestone, 'Очередь карточек');
        // #10/#133: `human` здесь БОЛЬШЕ НЕ фильтруется. Фильтр переехал в ядро, поверх шва
        // (`withHumanFilter`): пока он жил тут, площадка со своим адаптером шла мимо
        // него — её очередь фильтровала `blocked` и автора, а `human` нет. Копия правила
        // в каждой реализации разъезжается; одна общая — нет.
        const allow = getAuthorAllowlist();
        return (
            raw
                .filter((i) => !(i.labels || []).some((l) => l.name === 'blocked'))
                .filter((i) => allow.includes((i.author && i.author.login) as string))
                // gh отдаёт новые-первыми; порядок работы — по возрастанию номера (порядок задач в плане)
                .sort((a, b) => a.number - b.number)
        );
    }

    // C2: «рабочая очередь пуста» ≠ «фаза готова». Перед сдачей смотрим открытые issues
    // milestone без фильтров blocked/author: blocked и чужие — незакрытая работа /
    // нерешённый триаж; мерджить фазу поверх них нельзя, следующая фаза строится на этой.
    // ЕДИНСТВЕННОЕ исключение — human-карточки (#410): не работа агента, иначе фаза с
    // человеческим хвостом никогда не смерджится. Бросает исключение при недоступности gh —
    // вызывающий обязан остановиться. Конфликт human+complexity (excludeHumanIssues) при этом
    // НЕ пробрасывается вызывающему: его дефолтный failFn — `fail`, т.е. process.exit(1),
    // так что процесс гаснет на месте (fail-closed на двусмысленности замысла), а не через
    // исключение, которое вызывающий обязан перехватить.
    function allOpenIssues(
        milestone: string,
        { ghJsonFn = ghJson }: { ghJsonFn?: GhJsonFn } = {},
    ): Issue[] {
        // #133: без `excludeHumanIssues` — фильтр стоит в ядре поверх шва, см. openIssues.
        const issues = ghJsonFn<Issue[]>(
            `gh issue list --milestone ${shq(milestone)} --state open --json number,title,labels,author,createdAt --limit ${String(ISSUE_LIST_LIMIT)}`,
        );
        // #19: именно на пустоте ЭТОГО списка стоит разрешение мерджа (C2). Урезанный
        // ответ, отданный как полный, сдаёт фазу с незакрытой работой — молча.
        assertNotTruncated(issues.length, milestone, 'Полный список карточек');
        return issues;
    }

    // C5 (#39): были ли у фазы задачи ВООБЩЕ — `--state all`, то есть вместе с закрытыми.
    // Открытых нет и у сделанной фазы, и у той, которую не начинали; закрытые — то
    // единственное, чем эти два состояния различаются снаружи.
    //
    // `--limit 1`: вопрос булев, полная выборка тут не нужна ни для ответа, ни для лога —
    // а заодно не приходится гадать про дефолтный предел `gh` (30). Fail-closed: ошибку
    // gh НЕ глушим, вызывающий обязан остановиться.
    function hasAnyIssues(
        milestone: string,
        { ghJsonFn = ghJson }: { ghJsonFn?: GhJsonFn } = {},
    ): boolean {
        return (
            ghJsonFn<Array<{ number: number }>>(
                `gh issue list --milestone ${shq(milestone)} --state all --limit 1 --json number`,
            ).length > 0
        );
    }

    // #65: открыта ли веха сама. `state=all`, а не `state=open`: «в списке открытых нет»
    // неотличимо от «вехи нет вовсе», а ненайденная веха по контракту — отказ, не `false`.
    // `--paginate`: дефолтная страница — 30 вех, и веха за её краем читалась бы
    // отсутствующей. Fail-closed: ошибку gh не глушим.
    function milestoneOpen(
        title: string,
        { ghJsonFn = ghJson }: { ghJsonFn?: GhJsonFn } = {},
    ): boolean {
        const all = ghJsonFn<unknown>(
            'gh api --paginate "repos/{owner}/{repo}/milestones?state=all&per_page=100"',
        );
        if (!Array.isArray(all)) throw new Error('gh api milestones вернул не массив');
        const ms = (all as Array<{ title?: unknown; state?: unknown }>).find(
            (m) => m.title === title,
        );
        if (!ms) throw new Error(`milestone "${title}" не найден — статус вехи неизвестен`);
        if (ms.state !== 'open' && ms.state !== 'closed') {
            throw new Error(`milestone "${title}": неизвестный статус ${JSON.stringify(ms.state)}`);
        }
        return ms.state === 'open';
    }

    // #37: метки всех карточек фазы — плоским списком имён. Читает `gh` ОДИН раз и
    // отдаёт то, что нужно вызывающему; раньше этот вызов стоял прямо в review.ts, то
    // есть ядро знало, чем отвечает форж. Fail-closed: ошибку не глушим — «меток не
    // видно» вызывающий трактует как зону риска, и подменять её пустым списком нельзя.
    function milestoneLabels(
        milestone: string,
        { ghJsonFn = ghJson }: { ghJsonFn?: GhJsonFn } = {},
    ): string[] {
        const issues = ghJsonFn<Array<{ labels?: Array<{ name?: string }> }>>(
            `gh issue list --milestone ${shq(milestone)} --state all --json labels --limit ${String(ISSUE_LIST_LIMIT)}`,
        );
        // Ответ, упёршийся в предел, — это «часть карточек мы не видели», и отдать его как
        // полный значит пропустить эскалацию МОЛЧА: вызывающий не отличит «сложных задач
        // нет» от «до них не дочитали». Поэтому отказ — вызывающий трактует его как зону
        // риска и усиливает ревью. Фаза из 200 карточек — сама по себе повод разобраться.
        assertNotTruncated(issues.length, milestone, 'Метки карточек');
        return issues.flatMap((i) =>
            (i.labels ?? []).map((l) => String(l.name ?? '')).filter((n) => n !== ''),
        );
    }

    // #50: карточка целиком. Читает ПЕТЛЯ, а не сессия: у сессии нет ни CLI форжа, ни
    // HTTP-доступа, и требование «прочитай issue по номеру» было верно только на GitHub.
    function issueDetails(
        number: number,
        { ghJsonFn = ghJson }: { ghJsonFn?: GhJsonFn } = {},
    ): IssueDetails {
        const raw = ghJsonFn<{ title?: unknown; body?: unknown; state?: unknown }>(
            `gh issue view ${String(number)} --json number,title,body,state`,
        );
        const title = String(raw.title ?? '').trim();
        if (!title) {
            throw new Error(
                `Карточка #${String(number)} не прочиталась (в ответе форжа нет заголовка). ` +
                    'Сессия без тела задачи выдумает себе работу — это отказ, а не пустая карточка.',
            );
        }
        // #43: статус — для сверки перед взятием. Незнакомое значение — «не знаю», а не
        // «закрыта»: поле просто не ставится.
        const state = String(raw.state ?? '');
        const open = state === 'OPEN' ? true : state === 'CLOSED' ? false : undefined;
        return {
            number,
            title,
            body: String(raw.body ?? ''),
            ...(open === undefined ? {} : { open }),
        };
    }

    // ── Намерения кодер-сессии: применение на стороне GitHub (#40) ───────────
    //
    // Все четыре — через argv (`shArgv`), а не через `sh`: значения приходят из файла,
    // который написала модель, читавшая тело чужого issue (C3). Шелла в этом пути нет
    // вовсе — экранировать нечего, потому что интерпретатора нет.
    //
    // Номер карточки уже проверен разбором (целое положительное), но в argv он всё равно
    // идёт через String(): `gh` числа не примет, а неявное приведение — то место, где
    // однажды окажется не число.
    //
    // Fail-closed: ошибки НЕ глушим (в отличие от меток PR выше). Потерянное закрытие
    // оставит фазу открытой навсегда, потерянный `blocked` — заставит петлю сжечь
    // следующую итерацию об ту же стену.
    function commentOnIssue(
        issue: number,
        body: string,
        { runArgvFn = shArgv }: { runArgvFn?: ShArgvFn } = {},
    ): void {
        runArgvFn('gh', ['issue', 'comment', String(issue), '--body', body]);
    }

    // #125: лента комментариев карточки — для сверки начатого намерения по метке (#94).
    // Те же `issues/N/comments`, что у первой поверхности ленты PR (`prComments`): у GitHub
    // карточка и PR делят этот маршрут. `--paginate` склеивает страницы в один массив —
    // метка давнего прохода могла уехать за первую сотню.
    //
    // Fail-closed: ответ не массивом — отказ, а не пустая лента. Пустую сверка прочла бы
    // как «не лёг» и опубликовала бы комментарий вторым.
    function issueComments(
        issue: number,
        { ghJsonFn = ghJson }: { ghJsonFn?: GhJsonFn } = {},
    ): string[] {
        const endpoint = `repos/{owner}/{repo}/issues/${String(issue)}/comments`;
        const items = ghJsonFn<unknown>(`gh api ${endpoint} --paginate`);
        if (!Array.isArray(items)) {
            throw new Error(
                `gh api ${endpoint} вернул не массив — формат ответа неожиданный ` +
                    `(получено: ${JSON.stringify(items).slice(0, 200)}).`,
            );
        }
        return items.map((raw) => {
            const body = (raw as { body?: unknown } | null)?.body;
            return typeof body === 'string' ? body : '';
        });
    }

    function closeIssue(
        issue: number,
        { runArgvFn = shArgv }: { runArgvFn?: ShArgvFn } = {},
    ): void {
        runArgvFn('gh', ['issue', 'close', String(issue)]);
    }

    function blockIssue(
        issue: number,
        { runArgvFn = shArgv }: { runArgvFn?: ShArgvFn } = {},
    ): void {
        runArgvFn('gh', ['issue', 'edit', String(issue), '--add-label', 'blocked']);
    }

    // ── Закрытие milestones ──────────────────────────────────────────────────
    // Milestone закрывается НЕ при создании PR (ревью может вернуть работу), а когда фаза
    // принята: все issues разобраны И PR фазы смерджен. Делается это в ДВУХ местах цикла
    // сдачи — после нашего мерджа (gate === 'merged') и на пути «фаза уже смерджена»
    // (мердж человеком либо рестарт), оба раза через шов.
    //
    // #37: свипа хвостов на старте раннера больше нет. Он ходил в форж напрямую
    // (`gh api milestones` + `gh pr list`), то есть мимо шва, и на площадке без `gh` не
    // работал вовсе — только шумел предупреждением на каждом старте. Единственный его
    // полезный случай (milestone смердженной фазы остался open) закрыт в цикле сдачи;
    // хвосты фаз, ВЫПАВШИХ из config.phases, закрывает человек — это косметика, на гейт
    // мерджа она не влияет, а ради неё швy пришлось бы знать про листинг milestones и
    // поиск PR по заголовку.

    // Закрыть milestone фазы СРАЗУ после её мерджа, не дожидаясь свипа на следующем
    // старте раннера (из-за него смерджённый на 100% milestone висел open до рестарта).
    // Fail-open: любой сбой лишь логируется и НЕ роняет loop — свип закроет хвост потом.
    // #252: мутация уходит на argv (shArgv), а не строкой через шелл.
    function closeMilestoneByTitle(
        title: string,
        {
            ghJsonFn = ghJson,
            runArgvFn = shArgv,
            logFn = log,
        }: { ghJsonFn?: GhJsonFn; runArgvFn?: ShArgvFn; logFn?: LogFn } = {},
    ): void {
        try {
            const open = ghJsonFn<Array<{ number?: unknown; title?: string }>>(
                'gh api "repos/{owner}/{repo}/milestones?state=open"',
            );
            const ms = open.find((m) => m.title === title);
            if (!ms) return; // уже закрыт или не найден — не критично
            // #251: ms.number из внешнего API — не целое в argv `gh api` не пускаем.
            if (!Number.isInteger(ms.number)) return;
            runArgvFn('gh', [
                'api',
                '-X',
                'PATCH',
                `repos/{owner}/{repo}/milestones/${ms.number}`,
                '-f',
                'state=closed',
            ]);
            logFn(`🏁 Milestone закрыт: "${title}" (фаза смерджена)`);
        } catch (e) {
            logFn(
                `⚠ Не смог закрыть milestone "${title}" сразу (свип подберёт на старте): ${(e as Error).message}`,
            );
        }
    }

    // #199: доска Projects расходилась с реальностью молча — встроенная автоматизация
    // «Item closed» срабатывала не для всех карточек и об этом не сообщала (13 закрытых
    // issues висели в «In Progress»). Синк идёт сразу после мерджа фазы: именно тогда
    // закрываются issues фазы, и это единственный момент, когда раннер точно знает, что
    // доска устарела.
    //
    // Best-effort, в отличие от самого скрипта: `npm run project:sync` fail-closed и
    // краснеет на любых сомнительных данных — это правильно для гейта и для человека, но
    // ронять из-за косметики доски уже смердженную фазу нельзя. Поэтому здесь — лог, как у
    // closeMilestoneByTitle: следующий прогон подберёт (синк идемпотентен).
    // #252: сама мутация — через argv (shArgv), без значений извне (нет инъекции), но
    // направление единообразно с остальными мутациями раннера.
    // #72-ревью: коллабораторы приходят ОБЪЕКТОМ опций, как у всех соседей по модулю.
    // Позиционная форма приехала из оркестратора как есть, и в общем файле читалась как
    // случайность: `syncProjectBoard(runArgvFn, logFn)` не подсказывает, что чем является.
    function syncProjectBoard({
        runArgvFn = shArgv,
        logFn = log,
    }: { runArgvFn?: ShArgvFn; logFn?: LogFn } = {}): void {
        // Путь скрипта — из конфига ПОТРЕБИТЕЛЯ (канон, задача 23). Раньше он был зашит
        // строкой, то есть ядро молча требовало файл с таким именем у каждого, кто его
        // подключит; у площадок, где доска — проекция статуса, синк не нужен вовсе, и
        // «файла нет» выглядело точно так же, как «синк прошёл».
        const script = getProjectSyncScript();
        if (!script) {
            logFn('🗂 Синк доски выключен: в конфиге нет consumerScripts.projectSync.');
            return;
        }
        try {
            const out = runArgvFn('node', [script]);
            logFn(`🗂 ${String(out).trim().split('\n').pop()}`);
        } catch (e) {
            // String(e?.message ?? e), а не e.message: throw не-Error уронил бы TypeError
            // прямо из catch — обёртка, чья единственная работа «не ронять прогон», уронила
            // бы ночной AFK-прогон из-за косметики доски.
            const why = String((e as Error)?.message ?? e).split('\n')[0];
            logFn(`⚠ Синк доски не удался (следующий прогон подберёт): ${why}`);
        }
    }

    return {
        checkAuth,
        openIssues,
        allOpenIssues,
        hasAnyIssues,
        milestoneOpen,
        milestoneLabels,
        issueDetails,
        commentOnIssue,
        issueComments,
        closeIssue,
        blockIssue,
        closeMilestoneByTitle,
        syncProjectBoard,
    };
}
