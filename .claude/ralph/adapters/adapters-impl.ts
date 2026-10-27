// Сборка адаптеров ralph (#369, фаза 5) — реализации точек расширения из adapters.ts,
// подключаемые ЧЕРЕЗ КОНФИГ. adapters.ts описывает ИНТЕРФЕЙСЫ пяти швов (форж, гейт,
// нотификатор, деплой-проверка, рантайм кодер-сессии); здесь текущие боевые реализации
// оформлены как эти интерфейсы, а `buildAdapters` собирает их в единый `RalphAdapters`,
// выбирая реализацию каждого шва по ключу из `ralph.config.json` → `adapters.*`.
//
// Зачем именно так. Ядро петли (orchestrator.ts) зависит ТОЛЬКО от интерфейсов
// (`RalphAdapters`), а не от конкретных модулей: свап реализации шва = правка ключа в
// конфиге, не в коде (переносимость #204/#262). Композиция концентрируется в одной точке
// (composition root в orchestrator строит реестр реализаций и зовёт `buildAdapters`);
// конкретные модули (`gate.ts`, `deploy-check.ts`, `telegram-notifier.ts`, gh-функции,
// `spawnClaude`) остаются внизу, а ядро видит только швы.
//
// Форма мапперов. Каждая `createX*Adapter` — ТОНКИЙ маппер: берёт пучок уже построенных
// боевых функций (замыкания над коллабораторами оркестратора) и раскладывает их по
// именам методов интерфейса. Значения методов — ТЕ ЖЕ ссылки на функции, поэтому
// поведение петли байт-в-байт прежнее: адаптер — типизированная группировка, не новая
// логика. Имена реализаций (`github`/`npm`/`telegram`/`github-actions`/`claude`)
// фиксируют, ЧЬЯ это реализация; фаза 6 добавит рантаймы Kimi/OpenAI тем же путём — новый
// ключ в реестре `coderRuntime`, Claude-путь не трогая.
//
// Fail-closed. Выбор шва — решение о том, ЧЕМ раннер берёт задачи и что мерджит: кривой/
// неизвестный ключ = `fail()` и стоп, не тихий дефолт (инвариант №1). `resolveAdapterSelection`
// отвергает неизвестный ключ шва и неизвестное имя реализации ДО сборки; `buildAdapters`
// повторно страхуется на отсутствии реализации в реестре.
//
// Erasable-only TypeScript без билд-шага (нативный type stripping Node ≥24): только
// `type`/аннотации, ни enum, ни namespace-рантайма. Стиль ядра — `type` без префикса `T`.

import type {
    CoderRuntimeAdapter,
    IssueDetails,
    DeployCheckAdapter,
    GateAdapter,
    Issue,
    NotifierAdapter,
    NewPullRequest,
    NewReviewComment,
    PullRequest,
    RalphAdapters,
    ReviewComment,
    RunOptions,
    RunResult,
    TaskSourceAdapter,
} from './adapters.ts';

// Версия контракта швов, на которой говорят реализации этого каталога (#37). Ядро требует
// свою (`CORE_REQUIRES_ADAPTERS` в core/compat.ts) и сверяет их на старте: адаптеры ставятся
// вместе с ядром, но могут отстать — и шов, разошедшийся с ядром по контракту, отказал бы
// не на старте, а посреди сдачи фазы. Поднимать — когда меняется сигнатура или режим отказа
// метода шва, а не на каждую новую реализацию.
export const ADAPTERS_CONTRACT_VERSION = 1;

// ── Дефолтные реализации швов ────────────────────────────────────────────────
// Канон текущего проекта: форж — GitHub (`gh`), гейт — npm-скрипты, нотификатор —
// Telegram, деплой-проверка — GitHub Actions + HTTP health-URL, рантайм — Claude CLI.
// Конфиг может переопределить любой ключ (`adapters.<шов>`); отсутствие ключа = дефолт.
export const ADAPTER_DEFAULTS = {
    taskSource: 'github',
    gate: 'npm',
    notifier: 'telegram',
    deployCheck: 'github-actions',
    coderRuntime: 'claude',
} as const;

// Адаптеры трекера, которые ЗОВУТ скрипт синка доски потребителя (канон, задача 23).
// Список закрыт и лежит рядом с реестром реализаций: у площадки, где доска — проекция
// статуса issue, `syncBoard` осознанный no-op, и заданный `consumerScripts.projectSync`
// там не позвался бы никогда — молча, как раньше звался зашитый путь. Валидатор конфига
// (config-profile.ts) отвергает такую пару, поэтому новый адаптер, которому синк нужен,
// дописывает себя сюда — иначе его конфиг красный, и это видно сразу, а не через месяц
// расхождения доски.
export const BOARD_SYNC_TASK_SOURCES = ['github'] as const;

// Швы в каноничном порядке — единственный источник имён (итерируется резолвером и сборкой).
export const ADAPTER_SEAMS = Object.keys(ADAPTER_DEFAULTS) as Array<keyof typeof ADAPTER_DEFAULTS>;

// #415: швы, чей МЕРДЖ-ПУТЬ ещё не проведён через `switch(adapters)`. Недефолтная
// реализация такого шва была бы принята конфигом, прошла бы resolveAdapterSelection,
// buildAdapters и контрактный сьют #370 — а мердж молча продолжил бы гонять дефолт
// (класс «тихий дефолт», инвариант №1). Раньше от этого защищала лишь бедность реестра
// (по одной реализации на шов): второе имя отвергал buildAdapters как незарегистрированное.
// Защита исчезла бы в момент регистрации второй реализации — то есть ровно при переносе на
// другой стек, главном сценарии README. Поэтому запрет живёт барьером, а не абзацем в доке
// (инвариант №5).
//
// `taskSource` СНЯТ: composition root (orchestrator.ts) передаёт в `tryMergePhase`
// `findOpenPrFn`/`mergePrFn`/`phaseMergedFn` из `adapters.taskSource`, то есть недефолтная
// реализация действительно доезжает до мердж-пути, а не подменяется молча.
//
// `gate` ОСТАЁТСЯ: состав чеков (`gateChecksFor`) и их прогон (`checksGreen`) петля
// по-прежнему берёт у гейта напрямую, мимо `adapters.gate`. Принять `gate: 'cargo'`
// значило бы соврать — чеки всё равно пошли бы через npm. СНЯТИЕ: провести прогон чеков
// через `adapters.gate.runChecks` (он уже отдаёт `{green, verifiedHead, redCheck}` одним
// объектом вместо boolean плюс двух геттеров состояния) и убрать шов отсюда.
export const MERGE_PATH_BOUND_SEAMS = ['gate'] as const satisfies ReadonlyArray<
    keyof typeof ADAPTER_DEFAULTS
>;

// Предикат вместо приведения по месту: `includes` на `as const`-массиве требует расширения
// типа, и повторять его в двух местах — лишний шум (плюс соблазн приводить `seam` к
// литеральному union и получить ложное «сужение»).
function isMergePathBound(seam: string): boolean {
    return (MERGE_PATH_BOUND_SEAMS as ReadonlyArray<string>).includes(seam);
}

export type AdapterSeam = keyof typeof ADAPTER_DEFAULTS;
export type AdapterSelection = Record<AdapterSeam, string>;

// Провайдеры, реально зарегистрированные под швом `coderRuntime` в composition root
// (orchestrator.ts: adapterRegistries.coderRuntime = { claude, kimi, openai }). Источник
// правды для provider-aware modelRouting (#376, фаза 6): конфиг не может указать
// провайдера, которого раннер не умеет запускать — validateModelRouting (config-profile.ts)
// сверяет modelRouting.*.provider против этого списка ДО сборки адаптеров (инвариант №1:
// опечатка вида "kimy" — fail на старте, а не тихий откат на дефолтный рантайм).
export const CODER_RUNTIME_PROVIDERS = ['claude', 'kimi', 'openai'] as const;
export type CoderRuntimeProvider = (typeof CODER_RUNTIME_PROVIDERS)[number];

// Конфиг-секция выбора реализаций (плоский конфиг ПОСЛЕ resolveProfile). Все ключи
// опциональны — отсутствующий шов берёт дефолт из ADAPTER_DEFAULTS.
export type AdapterConfig = Partial<Record<AdapterSeam, string>>;

// `=> never`, не `=> unknown`: боевой `fail` (process.exit) и тестовый `throwingFail`
// не возвращаются, и код после `failFn(...)` в resolveAdapterSelection/pick недостижим —
// тип это выражает (иначе `out[seam] = v` присвоило бы невалидное имя, а `pick` вернул бы
// `undefined as T` при нестандартном failFn, который бы вернул управление).
type FailFn = (msg: string) => never;

// ── Резолв выбора реализаций из конфига (fail-closed) ─────────────────────────
// Возвращает ПОЛНЫЙ выбор по всем пяти швам: заданное в конфиге либо дефолт. Отвергает:
//   • неизвестный ключ шва в `adapters` (опечатка «taskSrc» молча не станет дефолтом);
//   • нестроковое/пустое имя реализации.
//   • недефолтную реализацию шва из MERGE_PATH_BOUND_SEAMS (#415) — мердж-путь её не
//     использует, принять такой конфиг значило бы соврать про свапаемость.
// Валидность имени против РЕЕСТРА (есть ли такая реализация) проверяет buildAdapters —
// у резолвера реестра нет, он знает только имена швов.
export function resolveAdapterSelection(
    adapters: AdapterConfig | undefined,
    failFn: FailFn,
): AdapterSelection {
    const sel = adapters ?? {};
    for (const key of Object.keys(sel)) {
        // Object.hasOwn, не `key in`: `in` смотрит и цепочку прототипов — ключи вроде
        // `toString`/`valueOf`/`hasOwnProperty` прошли бы проверку «неизвестный шов» молча
        // и затем тихо проигнорировались циклом по ADAPTER_SEAMS (тот самый «тихий дефолт»,
        // от которого этот резолвер защищает; resolveAdapterSelection экспортирована и как
        // самостоятельная API — resolveProfile её не всегда прикрывает).
        if (!Object.hasOwn(ADAPTER_DEFAULTS, key)) {
            failFn(
                `adapters.${key} — неизвестный шов адаптера. Допустимые: ${ADAPTER_SEAMS.join(', ')}.`,
            );
        }
    }
    const out = {} as AdapterSelection;
    for (const seam of ADAPTER_SEAMS) {
        const v = sel[seam];
        if (v === undefined) {
            out[seam] = ADAPTER_DEFAULTS[seam];
            continue;
        }
        if (typeof v !== 'string' || v.trim() === '') {
            failFn(`adapters.${seam} должен быть непустой строкой (имя реализации).`);
        }
        // #415: проверка ПОСЛЕ валидации формы (сначала «это вообще строка», потом «эту
        // реализацию мы умеем довести до мерджа») и ДО записи в out — иначе недефолтное имя
        // попало бы в выбор, а сообщение об ошибке говорило бы о нём как о принятом.
        if (v !== ADAPTER_DEFAULTS[seam] && isMergePathBound(seam)) {
            failFn(
                `adapters.${seam}: '${v}' — свап этого шва пока не поддержан. Прогон чеков ` +
                    `(tryMergePhase → gateChecksFor/checksGreen) берёт функции напрямую из ` +
                    `gate.ts, а не из adapters.${seam}, поэтому выбранная реализация не ` +
                    `участвовала бы в сдаче фазы: чеки продолжили бы идти через ` +
                    `'${ADAPTER_DEFAULTS[seam]}'. Это «тихий дефолт» (инвариант №1), поэтому ` +
                    `конфиг отвергается. Подробности — «свапаемость швов» в .claude/ralph/README.md; ` +
                    `свапаемые сегодня швы: ${ADAPTER_SEAMS.filter((s) => !isMergePathBound(s)).join(', ')}.`,
            );
        }
        out[seam] = v;
    }
    return out;
}

// ── Мапперы боевых функций → типизированные адаптеры ──────────────────────────
// Каждый маппер — раскладка уже построенных функций по именам методов интерфейса. Значения
// методов — ТЕ ЖЕ ссылки (поведение прежнее). Имена методов интерфейса ≠ имена боевых
// функций (checkProdHealth → checkHealth, closeMilestoneByTitle → closeMilestone и т.п.) —
// этот сдвиг и есть работа маппера.

// Форж GitHub: issues/PR/мердж/метки/milestone/доска (orchestrator.ts + gate.ts).
export type GithubTaskSourceFns = {
    // `gh auth status` — единственная форма «форж авторизован» у GitHub CLI.
    checkAuth: () => void;
    openIssues: (milestone: string) => Issue[];
    allOpenIssues: (milestone: string) => Issue[];
    hasAnyIssues: (milestone: string) => boolean;
    milestoneOpen: (title: string) => boolean;
    milestoneLabels: (milestone: string) => string[];
    // #37: комментарии PR одной лентой. Раскладку по трём поверхностям GitHub делает сама
    // боевая функция — маппер, как и везде здесь, только раскладывает имена.
    prComments: (prNumber: number) => ReviewComment[];
    // #50: карточка целиком — её читает петля и кладёт сессии в промпт.
    getIssue: (number: number) => IssueDetails;
    // #45: комментарий в PR от имени раннера — ревью-сессия в форж не ходит.
    commentOnPr: (prNumber: number, input: NewReviewComment) => void;
    // #46: PR фазы заводит раннер, а не сессия.
    createPr: (input: NewPullRequest) => number | null;
    findOpenPr: (branch: string) => PullRequest | null;
    // #49: голова PR для гейта — `gh pr view --json headRefOid`. Гейт её больше не читает
    // сам: команда форжа внутри гейта делала мердж-путь непроходимым везде, где `gh` нет.
    prHeadSha: (prNumber: number) => string;
    phaseMerged: (phase: { branch: string }) => boolean;
    mergedPhasePr: (phase: { branch: string }) => number | null;
    // Третий параметр — DI-канал исполнения, как в `TaskSourceAdapter.mergePullRequest`.
    // Он здесь не для галочки: по ЭТОМУ типу пишется следующая реализация шва, и без
    // него компилятор не подскажет, что канал надо поддержать. Сам параметр опционален,
    // так что старые реализации остаются валидными.
    mergePr: (
        prNumber: number,
        headSha?: string | null,
        opts?: { runArgvFn?: (file: string, args: string[]) => string },
    ) => void;
    addBlockedLabel: (branch: string) => void;
    removeBlockedLabel: (branch: string) => void;
    closeMilestoneByTitle: (title: string) => void;
    syncProjectBoard: () => void;
    // #40: применение намерений кодер-сессии. Имена боевых функций совпадают с методами
    // интерфейса — сдвига здесь нет, и это не повод их не перечислять: маппер обязан
    // ломаться компиляцией, когда шов обзавёлся методом, а реализация нет.
    commentOnIssue: (issue: number, body: string) => void;
    // #125: лента карточки для сверки намерения (#94).
    issueComments: (issue: number) => string[];
    closeIssue: (issue: number) => void;
    blockIssue: (issue: number) => void;
    createIssue: (input: {
        title: string;
        body: string;
        labels: readonly string[];
        milestone?: string;
    }) => number | null;
};

// #56: переменные, из которых GitHub CLI берёт токен (`GH_TOKEN` важнее, `GITHUB_TOKEN` —
// запасной). Обе — секрет этой площадки, и редакции нужны обе.
export const GITHUB_SECRET_ENV_NAMES = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;

export function createGithubTaskSource(fns: GithubTaskSourceFns): TaskSourceAdapter {
    return {
        checkAuth: fns.checkAuth,
        secretEnvNames: () => GITHUB_SECRET_ENV_NAMES,
        listReadyIssues: fns.openIssues,
        listAllOpenIssues: fns.allOpenIssues,
        hasAnyIssues: fns.hasAnyIssues,
        isMilestoneOpen: fns.milestoneOpen,
        listMilestoneLabels: fns.milestoneLabels,
        getIssue: fns.getIssue,
        listPullRequestComments: fns.prComments,
        commentOnPullRequest: fns.commentOnPr,
        createPullRequest: fns.createPr,
        findOpenPullRequest: fns.findOpenPr,
        pullRequestHeadSha: fns.prHeadSha,
        isPhaseMerged: fns.phaseMerged,
        mergedPullRequestNumber: fns.mergedPhasePr,
        mergePullRequest: fns.mergePr,
        addBlockedLabel: fns.addBlockedLabel,
        removeBlockedLabel: fns.removeBlockedLabel,
        closeMilestone: fns.closeMilestoneByTitle,
        syncBoard: fns.syncProjectBoard,
        commentOnIssue: fns.commentOnIssue,
        listIssueComments: fns.issueComments,
        closeIssue: fns.closeIssue,
        blockIssue: fns.blockIssue,
        createIssue: fns.createIssue,
    };
}

// Гейт npm: состав чеков + прогон на точном sha PR-головы (gate.ts).
export type NpmGateFns = {
    resolveChecks: GateAdapter['resolveChecks'];
    runChecks: GateAdapter['runChecks'];
};

export function createNpmGate(fns: NpmGateFns): GateAdapter {
    return {
        resolveChecks: fns.resolveChecks,
        runChecks: fns.runChecks,
    };
}

// Нотификатор Telegram: доставка текста, fail-open (telegram-notifier.ts).
export type TelegramNotifierFns = {
    notify: NotifierAdapter['notify'];
};

export function createTelegramNotifier(fns: TelegramNotifierFns): NotifierAdapter {
    return { notify: fns.notify };
}

// Деплой-проверка GitHub Actions + HTTP health (deploy-check.ts).
export type GithubActionsDeployFns = {
    mergedShaOf: DeployCheckAdapter['mergedShaOf'];
    waitForDeployRun: DeployCheckAdapter['waitForDeployRun'];
    checkProdHealth: DeployCheckAdapter['checkHealth'];
    classifyDeployOutcome: DeployCheckAdapter['classifyOutcome'];
};

export function createGithubActionsDeploy(fns: GithubActionsDeployFns): DeployCheckAdapter {
    return {
        // Деплой у этой реализации есть по определению: она и есть его проверка.
        isEnabled: () => true,
        mergedShaOf: fns.mergedShaOf,
        waitForDeployRun: fns.waitForDeployRun,
        checkHealth: fns.checkProdHealth,
        classifyOutcome: fns.classifyDeployOutcome,
    };
}

// «Деплоя нет» (#51) — не заглушка на будущее, а полноправная реализация шва для проектов,
// где пост-мердж релиза не существует. Ровно как `syncBoard` у SourceCraft: осознанный
// no-op, а не недоделка.
//
// Методы проверки БРОСАЮТ, а не возвращают выдуманный зелёный вердикт. Тихий `{red:false}`
// был бы худшим исходом из возможных: петля решила бы, что релиз проверен, хотя проверять
// нечем, — и это ровно тот «тихий дефолт», против которого стоит инвариант №1. Ядро
// спрашивает `isEnabled()` ПЕРВЫМ и до этих методов не доходит; если дошло — сломана
// проводка, и отказ обязан быть громким, а не молчаливым.
export function createNoDeployCheck(): DeployCheckAdapter {
    const absent = (what: string): never => {
        throw new Error(
            `Деплоя в проекте нет (adapters.deployCheck: 'none') — ${what} спрашивать не у кого. ` +
                'Ядро обязано было проверить isEnabled() перед вызовом.',
        );
    };
    return {
        isEnabled: () => false,
        mergedShaOf: () => absent('sha мерджа для деплоя'),
        waitForDeployRun: () => absent('итог деплой-воркфлоу'),
        checkHealth: () => absent('здоровье прода'),
        classifyOutcome: () => absent('вердикт деплоя'),
    };
}

// Конструктор шва кодер-рантайма: раскладывает боевую функцию запуска сессии
// (`run(prompt, options) → {code, output}`) по имени метода интерфейса CoderRuntimeAdapter.
// ОДИН конструктор на все провайдеры (claude/kimi/openai): контракт шва у них идентичен, а
// провайдер-специфика (Claude — `runClaudeOnce`; Kimi — endpoint Moonshot через env `claude`
// в `runKimiOnce`; OpenAI — отдельный бинарь `codex exec` в `runOpenAIOnce`) живёт ВНУТРИ
// боевой функции, а не в маппере. Читаемость намерения даёт КЛЮЧ реестра `coderRuntime`
// (`{ claude, kimi, openai }` в composition root orchestrator.ts) + говорящее имя переданной
// функции, а не имя конструктора — поэтому три байт-в-байт копии не нужны (research:
// `docs/…/research.md`). Claude-путь не трогается.
//
// `checkAvailable` (#44) обязателен, а не опционален: реализация без проверки готовности
// пропустила бы сломанный рантайм на старте молча — ровно тот исход, ради которого метод
// заведён.
export type CoderRuntimeFns = {
    run: (prompt: string, options: RunOptions) => RunResult;
    checkAvailable: () => void;
};

export function createCoderRuntime(fns: CoderRuntimeFns): CoderRuntimeAdapter {
    return { run: fns.run, checkAvailable: fns.checkAvailable };
}

// ── Сборка набора швов по выбору из конфига (fail-closed) ─────────────────────
// registries: реестр доступных реализаций по швам — { taskSource: { github: … }, … }.
// Реализаций по одной на большинство швов (текущий проект); шов coderRuntime несёт три —
// `claude`/`kimi`/`openai` (фаза 6, #373/#374), выбираемые config.adapters.coderRuntime.
// selection: результат resolveAdapterSelection. failFn: боевой fail (стоп раннера).
// Реализация, которой нет в реестре под выбранным ключом, = fail (тот же класс, что
// неизвестный ключ — просто ловится на слой ниже, когда реестр знает набор имён).
export type AdapterRegistries = {
    taskSource: Record<string, TaskSourceAdapter>;
    gate: Record<string, GateAdapter>;
    notifier: Record<string, NotifierAdapter>;
    deployCheck: Record<string, DeployCheckAdapter>;
    coderRuntime: Record<string, CoderRuntimeAdapter>;
};

export function buildAdapters(
    registries: AdapterRegistries,
    selection: AdapterSelection,
    failFn: FailFn,
): RalphAdapters {
    function pick<T>(seam: AdapterSeam, registry: Record<string, T>): T {
        const key = selection[seam];
        const impl = registry[key];
        if (!impl) {
            const known = Object.keys(registry);
            failFn(
                `adapters.${seam}: реализация '${key}' не зарегистрирована. ` +
                    `Доступные: ${known.length ? known.join(', ') : '(нет)'}.`,
            );
        }
        return impl;
    }
    return {
        taskSource: pick('taskSource', registries.taskSource),
        gate: pick('gate', registries.gate),
        notifier: pick('notifier', registries.notifier),
        deployCheck: pick('deployCheck', registries.deployCheck),
        coderRuntime: pick('coderRuntime', registries.coderRuntime),
    };
}
