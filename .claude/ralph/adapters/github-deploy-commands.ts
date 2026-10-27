// #72 (хвост #55): два примитива форжа, переехавшие из `core/deploy-check.ts`.
//
// Пост-мердж проверка (#163–#166) состоит из двух разных вещей, и до этого переезда они
// лежали в одном модуле: ЛОГИКА ожидания (ретрай на транзиентный `mergeCommit: null`,
// поллинг с таймаутом, классификация итога) и СПОСОБ спросить форж (`gh pr view`,
// `gh run list`). Первое переносится в любой проект как есть; второе верно ровно на одной
// площадке — и пока оно жило внутри ядра, «деплой-проверка» и «GitHub CLI» читались одним
// модулем: следующий вызов `gh` дописался бы туда незамеченным.
//
// Теперь ядро знает КОНТРАКТ — «дай oid мерджа этого PR», «дай последние прогоны этого
// workflow», — а команда живёт здесь. Сторожит границу греп-барьер
// `tests/core-purity.test.ts`: он сканирует весь `core/**` и краснеет на любой команде
// форжа в исполняемом коде ядра.
//
// Только ЧТЕНИЕ (#166). Мутаций форжа тут нет и быть не должно: пост-мердж проверка
// СМОТРИТ на прод и main, а не трогает их — это её главное свойство, и держится оно тем,
// что в модуле нет ни одного пишущего глагола.
type GhJsonFn = (cmd: string, attempts?: number) => unknown;
type ShqFn = (value: unknown) => string;

export type GithubDeployCommandsEnv = {
    /** Чтения форжа с ретраями и backoff (M3) — общий коллаборатор раннера. */
    ghJson: GhJsonFn;
    /** Квотирование значения перед подстановкой в шелл-строку чтения. */
    shq: ShqFn;
};

/** Сколько последних прогонов workflow смотреть. Прогон на нужном sha ищется среди них;
 *  глубже 30 он к моменту опроса не уезжает — поллинг начинается сразу после мерджа. */
const RUN_LIST_LIMIT = 30;

/**
 * Два read-примитива деплой-проверки для GitHub CLI. Обе функции сохраняют DI на канал
 * чтения (`ghJsonFn`) — тем же приёмом, что и остальные адаптеры ралфа: тест подменяет
 * канал, а не перехватывает боевой `gh`.
 *
 * Форму ответа НЕ разбираем: `mergeCommit.oid` валидирует ядро (SHA40_RE), состав прогона
 * читает ядро же. Адаптер отвечает на вопрос «как спросить», а не «что считать валидным» —
 * иначе правило годности sha разъехалось бы по двум модулям.
 */
export function createGithubDeployCommands(env: GithubDeployCommandsEnv) {
    const { ghJson, shq } = env;

    /** Коммит squash-мерджа PR — тот, что уехал в main и запустил deploy-workflow.
     *  Отдаёт сырое значение поля (в том числе `null`/`undefined`): «пусто» здесь —
     *  штатный транзиентный ответ форжа сразу после мерджа, и решение о ретрае принимает
     *  ядро, а не адаптер. */
    function mergeCommitOid(
        prNumber: number,
        { ghJsonFn = ghJson }: { ghJsonFn?: GhJsonFn } = {},
    ): unknown {
        const view = ghJsonFn(`gh pr view ${shq(prNumber)} --json mergeCommit`) as {
            mergeCommit?: { oid?: string };
        };
        return view && view.mergeCommit && view.mergeCommit.oid;
    }

    /** Последние прогоны deploy-workflow. Бросает при устойчивом сбое чтения (ghJson уже
     *  отретраил своё) — ловит и трактует отказ ядро: до таймаута ожидания впереди ещё
     *  опросы, и один чих не обязан давать ложный красный. */
    function listWorkflowRuns(
        workflow: string,
        { ghJsonFn = ghJson }: { ghJsonFn?: GhJsonFn } = {},
    ): unknown {
        return ghJsonFn(
            `gh run list --workflow ${shq(workflow)} ` +
                `--json databaseId,headSha,status,conclusion,url --limit ${String(RUN_LIST_LIMIT)}`,
        );
    }

    return { mergeCommitOid, listWorkflowRuns };
}
