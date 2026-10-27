// Модуль деплой-проверки (#364, трек «Фреймворк ralph», фаза 3). Вынесен из ralph.js по
// тому же приёму, что gate.ts (#362) и review.ts (#363): пост-мердж проверка фазы —
// ожидание deploy-workflow (#163), HTTP-healthcheck прода (#164) и классификация итога
// (#165) — собраны одним связным модулем, а ralph.js пользуется только его API. Поведение
// НЕ меняется — это извлечение, не переписывание: формат сообщений (deployWaitMessage —
// единственный источник строки, которую парсит DEPLOY_WAIT_RE в deadman.ts), ретраи,
// таймауты и fail-closed классификация — всё как было.
//
// Что собрано здесь:
// - deployPhasePlaceholder — маркер точки цикла, где prod-loop передаёт фазу релизу
//   (сам деплой уже делает CI по факту пуша в main, раннер его не дублирует);
// - mergedShaOf — sha squash-мерджа PR с ретраем на транзиентный mergeCommit:null;
// - deployWaitMessage — единственный источник формата строки ожидания (контракт с
//   deadman.ts, синхронность закреплена тестом deadman.test.ts);
// - waitForDeployRun — поллинг прогонов deploy-workflow до completed/timeout/not-found;
// - probeHttpStatus / checkProdHealth — HTTP-healthcheck главной страницы прода;
// - isWorkflowGreen / classifyDeployOutcome — единый предикат «зелёно» и fail-closed
//   классификация итога (GREEN только при подтверждённо зелёном workflow И здоровом проде).
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
//
// #72 (хвост #55): команд форжа здесь БОЛЬШЕ НЕТ. Два чтения (`коммит мерджа PR` и
// `прогоны deploy-workflow`) приходят инъекцией из `adapters/github-deploy-commands.ts` —
// модуль знает КОНТРАКТ примитива, а не команду, которой он исполняется. Пока команды
// лежали здесь, «пост-мердж проверка» и «GitHub CLI» читались одним модулем, и барьер
// чистоты ядра приходилось держать списком очищенных файлов вместо сплошного скана.
//
// Фабрика, а не standalone-экспорты (как в ralph-util.ts/api-limit.ts): часть функций не
// чистые — им нужен контекст ralph.js (два read-примитива форжа — только ЧТЕНИЕ, #166;
// log; sleep; guardSideEffect и positiveIntOrDefault — тоже общие). Фабрика захватывает
// этот контекст один раз, а
// возвращённые функции сохраняют ПОКАЗАТЕЛЬНУЮ DI: каждая
// по-прежнему принимает свои коллабораторы (примитивы форжа/execFn/sleepFn/logFn/nowFn/…)
// параметром — ровно так их зовут существующие тесты (deploy-check.test.ts) через ре-экспорт
// из ralph.js.
//
// getConfig, а не захваченный config: module-level `config` в ralph.js заполняется в main()
// ПОСЛЕ загрузки этого модуля (createDeployCheckModule зовётся на верхнем уровне), поэтому
// дефолт `cfg = getConfig()` обязан читать ЖИВОЙ config в момент вызова, а не снимок
// undefined с момента сборки фабрики — тот же приём, что state-lock.ts/review.ts. На
// практике вызывающий (runLoop) всегда передаёт cfg явно — дефолт страхует прямые вызовы.
//
// guardSideEffect на дефолтном execFn (#138, тот же приём, что tunnel-check.ts): реальный
// curl не должен уйти в сеть, если тест забыл подменить execFn.

import { execFileSync } from 'node:child_process';

type LogFn = (msg: string) => void;
type SleepFn = (ms: number) => void;
type NowFn = () => number;
// Примитивы форжа, приходящие инъекцией (#72). Оба — ЧТЕНИЯ, оба отдают СЫРОЙ ответ:
// решение «пусто — это ретрай или отказ» принимает ядро, потому что оно же держит таймауты
// и классификацию итога.
//
// Описан только обязательный параметр — без хвостового DI-канала самой реализации (у неё
// он есть). Это не небрежность, а тот же приём, что в `adapters.ts`: параметры функций
// контравариантны, и более узкое описание совместимо в обе стороны, а ядро остаётся без
// знания о том, чем примитив исполняется.
type MergeCommitOidFn = (prNumber: number) => unknown;
type ListWorkflowRunsFn = (workflow: string) => unknown;
type ExecFn = (file: string, args: string[], opts?: Record<string, unknown>) => string;
type GuardFn = (what: string) => void;
type PositiveIntOrDefaultFn = (value: unknown, dflt: number) => number;

// Фаза в форме, которую хранит config.phases: deployPhasePlaceholder берёт из неё milestone.
type Phase = { milestone: string };

type DeployCheckCfg = {
    deployCheck?: {
        workflow?: string;
        timeoutMs?: number;
        pollIntervalMs?: number;
        healthUrl?: string;
        healthTimeoutMs?: number;
        healthRetries?: number;
        healthRetryDelayMs?: number;
    };
};

type RunListItem = {
    databaseId?: number;
    headSha?: string;
    status?: string;
    conclusion?: string | null;
    url?: string;
};

export type DeployOutcome = {
    status: 'completed' | 'timeout' | 'not-found';
    conclusion: string | null;
    sha: string;
    url: string | null;
    runId: number | null;
};

// reason (#204-ревью): различает «прод не ответил» (сеть/HTTP) и «ошибка конфига»
// (healthUrl не задан/кривой). Без него classifyDeployOutcome врал «прод не отвечает
// (HTTP —)», и человек шёл проверять живой прод, хотя причина — незаполненный конфиг.
export type HealthResult = { ok: boolean; status: number; url: string; reason?: 'config' };

export type DeployVerdict = { red: boolean; reason: string };

// Контекст ralph.js, захватываемый фабрикой один раз. getConfig — ленивый геттер живого
// config (см. докблок выше); mergeCommitOid/listWorkflowRuns — два read-примитива форжа
// (#72, только ЧТЕНИЕ — #166), приходящие из адаптера; log/sleep — module-level
// коллабораторы; guardSideEffect — общий предохранитель #138 на дефолтный execFn (curl);
// positiveIntOrDefault — общая чистая утилита (#232).
export type DeployCheckEnv = {
    getConfig: () => DeployCheckCfg;
    mergeCommitOid: MergeCommitOidFn;
    listWorkflowRuns: ListWorkflowRunsFn;
    log: LogFn;
    sleep: SleepFn;
    guardSideEffect: GuardFn;
    positiveIntOrDefault: PositiveIntOrDefaultFn;
    SHA40_RE: RegExp;
};

export function createDeployCheckModule(env: DeployCheckEnv) {
    const {
        getConfig,
        mergeCommitOid,
        listWorkflowRuns,
        log,
        sleep,
        guardSideEffect,
        positiveIntOrDefault,
        SHA40_RE,
    } = env;

    // Деплой фазы (#87) — явный no-op-плейсхолдер. Боевой прод уже раскатывается
    // САМ CI (.github/workflows/deploy.yml → scripts/deploy-remote.sh) по факту пуша
    // в main — squash-мердж внутри tryMergePhase выше его и запускает. Раннеру незачем
    // ДУБЛИРОВАТЬ деплой; эта функция — только маркер точки цикла, где prod-loop
    // логически передаёт фазу релизу. Исход CI-раскатки раннер, однако, ДОЖИДАЕТСЯ
    // (#163): сразу после этого маркера runLoop зовёт waitForDeployRun на смердженном
    // sha — иначе откат деплоя остался бы в main незамеченным (см. runLoop, gate === 'merged').
    function deployPhasePlaceholder(phase: Phase, { logFn = log }: { logFn?: LogFn } = {}): void {
        logFn(
            `🚀 Деплой фазы "${phase.milestone}": плейсхолдер — раскатку уже делает CI по пушу в main, раннер её не дублирует.`,
        );
    }

    // #163: sha squash-мерджа PR. Это ровно тот коммит, что уехал в main и запустил
    // deploy-workflow (headSha его run'а), — по нему пост-мердж проверка и следит.
    // Чтение — примитивом форжа (ретраи внутри него). Fail-closed: без валидного oid
    // бросаем: «не смог узнать sha» и «деплой прошёл» — разные ответы, молчаливый пропуск
    // здесь недопустим.
    function mergedShaOf(
        prNumber: number,
        {
            mergeCommitOidFn = mergeCommitOid,
            sleepFn = sleep,
            attempts = 3,
            retryMs = 5000,
        }: {
            mergeCommitOidFn?: MergeCommitOidFn;
            sleepFn?: SleepFn;
            attempts?: number;
            retryMs?: number;
        } = {},
    ): string {
        // fail-fast на невалидном prNumber (getLastGatePr() отдаёт null, если гейт не дошёл
        // до findOpenPr): без гарда запрос по номеру 'null' сжёг бы attempts×ретраи чтения с
        // бэкофф-паузами (десятки секунд сети), прежде чем упасть. Симметрично гарду
        // recordReviewFindings (#169) — оба честно обрабатывают null (см. RunLoopDeps).
        if (!Number.isInteger(prNumber) || prNumber <= 0) {
            throw new Error(`mergedShaOf: невалидный номер PR "${prNumber}"`);
        }
        // Форж иногда отдаёт коммит мерджа пустым с лагом сразу после squash-мерджа. Ретраи
        // самого чтения (внутри примитива) на это не срабатывают — ответ-то валидный, просто
        // поле пустое. Короткая петля именно на пустом oid (attempts×retryMs) убирает самый
        // вероятный ложный красный этого пути; исчерпав её — fail-closed бросаем (в runLoop
        // это барьер).
        let oid: unknown = null;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            oid = mergeCommitOidFn(prNumber);
            if (SHA40_RE.test(String(oid))) return oid as string;
            if (attempt < attempts) sleepFn(retryMs);
        }
        throw new Error(`mergedShaOf: не удалось получить sha мерджа PR #${prNumber}`);
    }

    // #TFO89: единственный источник формата строки ожидания пост-мердж деплоя. Её парсит
    // DEPLOY_WAIT_RE в deadman.ts (режим deploywait, порог = таймаут ожидания + запас):
    // цикл опроса ниже за ~20 мин не пишет в лог ни строки, и без своего режима deadman
    // увёл бы классификацию к default (5 мин) → ложный DEADMAN-пуш на каждом prod-мердже
    // (нарушение инварианта 10 и критерия PRD «ноль ложных пушей»). N (таймаут в минутах)
    // захватывается тем же способом, что «Жду N мин» у apiLimitMessage; синхронность
    // формата и regex закреплена тестом (deadman.test.ts: deployWaitMessage ↔ DEPLOY_WAIT_RE).
    function deployWaitMessage(workflow: string, sha: string, timeoutMs: number): string {
        return (
            `⏳ Пост-мердж: жду итог deploy-workflow «${workflow}» на sha ${String(sha).slice(0, 8)} ` +
            `(таймаут ${Math.round(timeoutMs / 60000)} мин).`
        );
    }

    // #163: После squash-мерджа фазы deploy-workflow раскатывает main на прод. Прежде
    // чем строить следующую фазу поверх этого main, раннер (prod) ДОЖИДАЕТСЯ итога
    // workflow на смердженном sha — иначе откат раскатки остаётся в main и следующий
    // мердж передеплоит битый коммит. Возвращает {status, conclusion, sha, url, runId}:
    //   status='completed' — workflow досмотрен, conclusion — его итог (success/failure/…);
    //   status='timeout'   — run найден, но не завершился за timeoutMs (итог не считаем ни
    //                        зелёным, ни красным — решение стоп+пуш за #165);
    //   status='not-found' — run на sha так и не появился за таймаут.
    // Только ЧТЕНИЕ прогонов (ретраи — внутри примитива): прод и main не трогаем (#166).
    // Устойчивый сетевой чих (примитив исчерпал свои ретраи) не роняет всё ожидание —
    // впереди ещё поллы, один чих не даёт ложного красного. Часы (nowFn) инжектируемы ради
    // детерминизма тестов.
    function waitForDeployRun(
        sha: string,
        cfg: DeployCheckCfg = getConfig(),
        {
            listWorkflowRunsFn = listWorkflowRuns,
            sleepFn = sleep,
            logFn = log,
            nowFn = Date.now,
        }: {
            listWorkflowRunsFn?: ListWorkflowRunsFn;
            sleepFn?: SleepFn;
            logFn?: LogFn;
            nowFn?: NowFn;
        } = {},
    ): DeployOutcome {
        // fail-closed: без валидного sha следить не за чем — это ошибка вызывающего,
        // а не повод молча вернуть «всё хорошо».
        if (!SHA40_RE.test(String(sha))) {
            throw new Error(`waitForDeployRun: невалидный sha "${sha}"`);
        }
        const dc = (cfg && cfg.deployCheck) || {};
        const workflow =
            typeof dc.workflow === 'string' && dc.workflow ? dc.workflow : 'deploy.yml';
        const timeoutMs = positiveIntOrDefault(dc.timeoutMs, 1_200_000);
        const pollIntervalMs = positiveIntOrDefault(dc.pollIntervalMs, 15_000);

        logFn(deployWaitMessage(workflow, sha, timeoutMs));

        const start = nowFn();
        let lastSeen: RunListItem | null = null;
        while (nowFn() - start < timeoutMs) {
            let runs: RunListItem[] | null = null;
            try {
                runs = listWorkflowRunsFn(workflow) as RunListItem[];
            } catch (e) {
                // Примитив уже отретраил свой набор попыток; устойчивый чих не роняет всё
                // ожидание — до таймаута ещё поллы, ложного красного он не даёт. runs=null
                // → падаем в общий sleep-or-break ниже (повтор на следующем опросе).
                logFn(
                    `⚠ Пост-мердж: чтение прогонов deploy-workflow не удалось ` +
                        `(${String((e as Error).message).split('\n')[0]}) — повтор на следующем опросе.`,
                );
            }
            const run = (Array.isArray(runs) ? runs : []).find((r) => r && r.headSha === sha);
            if (run) {
                lastSeen = run;
                if (run.status === 'completed') {
                    logFn(
                        `✓ Пост-мердж: deploy-workflow на ${sha.slice(0, 8)} завершён — ` +
                            `итог «${run.conclusion}».`,
                    );
                    return {
                        status: 'completed',
                        conclusion: run.conclusion ?? null,
                        sha,
                        url: run.url ?? null,
                        runId: run.databaseId ?? null,
                    };
                }
            }
            // #THS8T: не спим перед гарантированным таймаутом — иначе холостые pollIntervalMs
            // на каждом timeout/not-found исходе (проснулись бы ровно чтобы while вышел).
            if (nowFn() - start + pollIntervalMs >= timeoutMs) break;
            sleepFn(pollIntervalMs);
        }
        // Таймаут. Итог не досмотрен — не выдаём его за зелёный (риск ложного красного на
        // каждом мердже как раз в обратную сторону: молча «сойдёт» опаснее честного «не знаю»).
        if (lastSeen) {
            logFn(
                `⚠ Пост-мердж: deploy-workflow на ${sha.slice(0, 8)} не завершился за таймаут ` +
                    `(последний статус «${lastSeen.status}»).`,
            );
            return {
                status: 'timeout',
                conclusion: null,
                sha,
                url: lastSeen.url ?? null,
                runId: lastSeen.databaseId ?? null,
            };
        }
        logFn(`⚠ Пост-мердж: deploy-workflow на ${sha.slice(0, 8)} не найден за таймаут ожидания.`);
        return { status: 'not-found', conclusion: null, sha, url: null, runId: null };
    }

    // #164: HTTP-код главной страницы прода. Только ЧТЕНИЕ (GET) — прод не трогаем (#166).
    // Аргументы curl — МАССИВ через execFileSync (тот же anti-RCE паттерн, что и
    // probeEgress/restartTunnel в tunnel-check.ts), не строка через sh(): url приходит из
    // конфига в гите, но защита ничего не стоит. Пустая/нечисловая строка ответа (таймаут,
    // DNS-сбой) → код 0, не 200 — вызывающий трактует как «не здоров», та же логика, что и
    // у probeEgress. Дефолтный execFn гардится #138: забытый override в тесте ушёл бы в
    // настоящий curl к прод-домену.
    function probeHttpStatus(
        url: string,
        timeoutSec: number,
        execFn: ExecFn = (file, args, opts) => {
            guardSideEffect('curl (probeHttpStatus)');
            return (execFileSync as ExecFn)(file, args, opts);
        },
    ): number {
        try {
            const out = execFn(
                'curl',
                [
                    '-4',
                    '-s',
                    // -L: следуем редиректам главной (www, локаль-префикс, смена схемы) —
                    // иначе будущий 301/308 дал бы устойчивый ложнокрасный барьер на каждом
                    // prod-мердже (#THS8Q). %{http_code} после -L — код КОНЕЧНОГО ответа.
                    '-L',
                    '-o',
                    '/dev/null',
                    '-w',
                    '%{http_code}',
                    '--max-time',
                    String(timeoutSec),
                    // `--` завершает опции: даже url с ведущим `-` (argument injection, тот
                    // же класс, что и SAFE_BRANCH_RE) curl прочтёт как адрес, а не как флаг.
                    '--',
                    url,
                ],
                { encoding: 'utf-8' },
            ).trim();
            const code = Number(out);
            return Number.isInteger(code) ? code : 0;
        } catch {
            return 0;
        }
    }

    // #164: Healthcheck прода после деплоя — MVP-определение «живо» (PRD/plan фаза 5):
    // workflow success (waitForDeployRun выше) + HTTP 200 главной страницы. Игровой смоук
    // (Playwright по проду) — кандидат в бэклог, не MVP.
    // Флаки-запрос (сетевой чих до прода) ретраится с фиксированной паузой между попытками
    // (дефолт 3×5с, как таймауты/паузы остальных пост-мердж проверок) — не должен стопить
    // петлю зря (критерий готовности #164). Итог не используется здесь для решения
    // стоп/пуш — это #165; #164 только сообщает {ok, status, url} и логирует попытки.
    // Дефолтный execFn гардится #138 отдельно от probeHttpStatus: checkProdHealth передаёт
    // СВОЙ execFn вниз явным параметром, поэтому забытый override здесь тоже ушёл бы в
    // настоящую сеть, минуя гард самого probeHttpStatus.
    function checkProdHealth(
        cfg: DeployCheckCfg = getConfig(),
        {
            execFn = (file, args, opts) => {
                guardSideEffect('curl (checkProdHealth)');
                return (execFileSync as ExecFn)(file, args, opts);
            },
            sleepFn = sleep,
            logFn = log,
        }: { execFn?: ExecFn; sleepFn?: SleepFn; logFn?: LogFn } = {},
    ): HealthResult {
        const dc = (cfg && cfg.deployCheck) || {};
        // #204: без проектного фолбэка (был домен конкретного проекта). URL задаётся конфигом
        // (deployCheck.healthUrl); его отсутствие/кривизна — не «прод упал», а ошибка
        // конфига → fail-closed (ok:false), а НЕ подставим чужой домен и не спросим curl.
        const url = typeof dc.healthUrl === 'string' && dc.healthUrl ? dc.healthUrl : '';
        // #TFO9D: healthUrl из конфига обязан быть http(s)-адресом. Кривое/пустое значение —
        // фиксируем отдельным сообщением, не отправляя мусор в curl-argv.
        if (!/^https?:\/\//.test(url)) {
            logFn(
                url
                    ? `⚠ Пост-мердж: healthUrl "${url}" не похож на http(s)-адрес — проверка не выполнена.`
                    : `⚠ Пост-мердж: healthUrl не задан в конфиге (deployCheck.healthUrl) — проверка не выполнена.`,
            );
            return { ok: false, status: 0, url, reason: 'config' };
        }
        const timeoutSec = Math.max(
            1,
            Math.round(positiveIntOrDefault(dc.healthTimeoutMs, 10_000) / 1000),
        );
        const retries = positiveIntOrDefault(dc.healthRetries, 3);
        const retryDelayMs = positiveIntOrDefault(dc.healthRetryDelayMs, 5_000);

        let status = 0;
        for (let attempt = 1; attempt <= retries; attempt++) {
            status = probeHttpStatus(url, timeoutSec, execFn);
            if (status === 200) {
                logFn(
                    `✓ Пост-мердж: healthcheck ${url} — HTTP 200 (попытка ${attempt}/${retries}).`,
                );
                return { ok: true, status, url };
            }
            logFn(
                `⚠ Пост-мердж: healthcheck ${url} — HTTP ${status || '—'} (попытка ${attempt}/${retries}).`,
            );
            if (attempt < retries) sleepFn(retryDelayMs);
        }
        logFn(
            `⚠ Пост-мердж: healthcheck ${url} не вернул 200 после ${retries} попыток ` +
                `(последний код ${status || '—'}).`,
        );
        return { ok: false, status, url };
    }

    // #THS8S: единственный предикат «workflow зелёный» — и для решения «звать ли
    // healthcheck» в runLoop, и для первой ветки classifyDeployOutcome (как отрицание).
    // Иначе условие продублировано в двух местах и при уточнении классификации (например,
    // neutral/skipped станет допустимым) одно из них легко забыть — healthcheck разошёлся
    // бы с вердиктом.
    function isWorkflowGreen(outcome: DeployOutcome | null | undefined): boolean {
        return !!outcome && outcome.status === 'completed' && outcome.conclusion === 'success';
    }

    // #165: классификация пост-мердж итога → зелёный/красный (alert-first, fail-closed).
    // GREEN только при ПОДТВЕРЖДЁННО успешном workflow И здоровом проде. Всё прочее —
    // упавший/недосмотренный workflow (failure/timeout/not-found), недоступный прод,
    // брошенная ошибка чтения — красный: «не знаю» опаснее ложного «всё хорошо», иначе
    // следующий мердж передеплоит недоехавший main. Чистая функция (тестируема без gh/сети);
    // `reason` — человекочитаемая причина для пуша и лога. health=null трактуем как
    // «не проверяли» (workflow сам уже не зелёный) — до healthcheck дело не дошло.
    function classifyDeployOutcome(
        outcome: DeployOutcome | null | undefined,
        health: HealthResult | null | undefined,
    ): DeployVerdict {
        if (!isWorkflowGreen(outcome)) {
            const status = outcome && outcome.status ? outcome.status : 'unknown';
            const concl = outcome && outcome.conclusion ? ` (${outcome.conclusion})` : '';
            return { red: true, reason: `workflow ${status}${concl}` };
        }
        if (health && health.ok === false) {
            // #204-ревью: ошибку конфига (healthUrl не задан/кривой) не выдаём за «прод
            // упал» — иначе пуш зовёт человека проверять живой прод по ложному следу.
            if (health.reason === 'config') {
                return {
                    red: true,
                    reason: 'healthUrl не задан/неверен в конфиге (deployCheck.healthUrl) — ошибка конфига, не прод',
                };
            }
            return { red: true, reason: `прод не отвечает (HTTP ${health.status || '—'})` };
        }
        return { red: false, reason: 'workflow success + прод HTTP 200' };
    }

    return {
        deployPhasePlaceholder,
        mergedShaOf,
        deployWaitMessage,
        waitForDeployRun,
        probeHttpStatus,
        checkProdHealth,
        isWorkflowGreen,
        classifyDeployOutcome,
    };
}
