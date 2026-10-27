// Модуль гейта мерджа (#362, трек «Фреймворк ralph», фаза 3). Вынесен из ralph.js по
// тому же приёму, что worktree.ts / state-lock.ts / tunnel-check.ts (фаза 2): исполнение
// гейта фазы собрано одним связным модулем, а ralph.js пользуется только его API.
// Поведение НЕ меняется — это извлечение, не переписывание: состав чеков, порядок
// fail-fast, hold-первым-blocked-вторым, --match-head-commit, H4-разделение merge и
// пост-мердж шагов, снятие/возврат метки blocked — всё как было.
//
// Что собрано здесь: последовательность шагов гейта (checksGreen + состав чеков) и логика
// перехода в blocked/hold (tryMergePhase).
//
// Примитивы форжа (метка blocked, мердж PR, «фаза уже смерджена») здесь БОЛЬШЕ НЕ ЖИВУТ —
// они уехали в `adapters/github-forge-commands.ts` (#55), а гейт получает их инъекцией
// через `GateEnv` и знает только сигнатуры. Состав шагов приезжает из конфига
// (ralph.config.json → gate.checks/prodChecks/prodDropChecks, #204 фаза 4): ядро знает
// только КОНТРАКТ (fail-fast порядок, дедуп base↔prod), конкретные npm-скрипты проекта —
// в конфиге. resolveGateChecks валидирует форму fail-closed. Санация env чеков живёт в
// отдельном gate-env.mts (#188) и приходит сюда инжектируемым buildSanitizedGateEnv —
// этот модуль её только зовёт.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
//
// Фабрика, а не standalone-экспорты (как в worktree.ts/tunnel-check.ts): checksGreen/
// tryMergePhase/… НЕ чистые — им нужен контекст ralph.js (sh/shArgv/shq, ghJson,
// findOpenPr, ensureClean, парковка/обновление дерева, санация env, sleep, DRY, набор
// regex'ов). Фабрика захватывает этот контекст один раз, а возвращённые функции
// сохраняют ПОКАЗАТЕЛЬНУЮ DI: каждая по-прежнему принимает свои коллабораторы
// (shFn/logFn/checksGreenFn/…) параметром — ровно так их зовут существующие тесты
// (gate.test.ts, blocked-scenarios.test.ts, hold-scenarios.test.ts) через ре-экспорт из
// ralph.js. Module-level state гейта (lastRedCheck/lastVerifiedHead/lastGatePr) живёт в
// замыкании фабрики и читается наружу геттерами — как раньше module.exports у ralph.js.

import type {
    ForgeCheckFailure,
    ForgeCheckRun,
    ForgeChecks,
    ForgeFailureKind,
} from './forge-checks.ts';
import { classifyForgeFailure, waitForForgeChecks } from './forge-checks.ts';
import {
    MERGE_RETRY_BASE_MS,
    classifyMergeFailure,
    describeMergeFailure,
    mergeFailureLine,
    mergeRetryPauseMs,
    resolveMergeRetryMaxMs,
} from './merge-retry.ts';
import type { MergeFailureKind } from './merge-retry.ts';
import { errorText, gitNetworkOpts } from '../shared/ralph-util.ts';
import type { ExecOpts, ShArgvFn } from '../shared/ralph-util.ts';
import { syncPhaseBranchWithMain } from './main-sync.ts';
import type { MainSyncResult } from './main-sync.ts';

type ShFn = (cmd: string, opts?: ExecOpts) => string;
type ShqFn = (value: unknown) => string;
type LogFn = (msg: string) => void;
// fail() боевой уходит в process.exit(1); тестовый может бросить/вернуть — потому unknown.
type FailFn = (msg: string) => unknown;
type GhJsonFn = <T = unknown>(cmd: string, attempts?: number) => T;
// #55: сигнатуры примитивов форжа — гейт зависит от них, но не от их реализации.
type MergePrFn = (
    prNumber: number,
    headSha?: string | null,
    opts?: { runArgvFn?: ShArgvFn },
) => void;
type PhaseMergedFn = (phase: { branch: string }) => boolean;
// #49: sha головы PR — операция ФОРЖА (метод `pullRequestHeadSha` шва TaskSourceAdapter),
// а не гейта. Fail-closed по контракту шва: не смогли прочитать — бросает, а не отдаёт
// пустую строку.
type PrHeadShaFn = (prNumber: number) => string;
type SafeBranchFn = (branch: string, opts?: { logFn?: LogFn; where?: string }) => boolean;
type SleepFn = (ms: number) => void;
type FormatExcerptFn = (raw: string) => string;
type BuildGateEnvFn = () => NodeJS.ProcessEnv;

// PR в форме, которую отдаёт findOpenPr (`gh pr list --json number,labels`).
type Pr = { number: number; labels?: Array<{ name: string }> };
type FindOpenPrFn = (branch: string, opts?: { ghJsonFn?: GhJsonFn; logFn?: LogFn }) => Pr | null;
type EnsureCleanFn = (context: string, opts?: { shFn?: ShFn; logFn?: LogFn }) => boolean;
type ParkFn = (opts?: { runArgvFn?: ShArgvFn; logFn?: LogFn }) => void;
type UpdateTreeFn = (runArgvFn?: ShArgvFn) => void;
type SyncDepsFn = (opts?: { env?: NodeJS.ProcessEnv }) => void;

// Один упавший чек гейта — топливо чини-сессии (self-heal). null = гейт падал не на
// чеках (fetch/HEAD/detach): такие причины кодом не лечатся.
type RedCheck = { name: string; cmd: string; excerpt: string };
// Задача 81: чек, упавший на ИНСТРУМЕНТЕ, а не на коде. Отдельный тип и отдельный геттер, а
// не `RedCheck` с флагом: цикл выбирает топливо чини-сессии по наличию `RedCheck`, и сбой,
// оказавшийся в нём, ушёл бы на лечение кода, которого никто не ломал.
type ToolFailure = { name: string; cmd: string; why: string; excerpt: string };
type ToolFailureSkip = { name: string; cmd: string; why: string };
// #123: отказ мерджа, с которым гейт вернул `not-merged`: класс (merge-retry.ts), первая
// строка ответа форжа (не командная строка исключения), сколько попыток сгорело и под каким
// пределом — всё, из чего цикл собирает диагноз пуша, не пересказывая лог.
export type MergeFailure = {
    pr: number;
    kind: MergeFailureKind;
    line: string;
    attempts: number;
    retryMaxMs: number;
};

// #269: сигнатуры шва «чек PR у форжа». Обе НЕОБЯЗАТЕЛЬНЫЕ: реализация без них означает
// прежнее поведение — мердж сразу после локальных чеков, а красный чек форжа отвергает
// его сам, как и до этой карточки.
type ForgeChecksFn = (prNumber: number) => ForgeChecks;
type ForgeDiagnosisFn = (run: ForgeCheckRun) => ForgeCheckFailure | null;

// Красный чек ФОРЖА, доведённый до формы, в которой его читает цикл: тот же набор полей,
// что у `RedCheck`, плюс `kind` — чинится ли это кодом. Отдельный тип, а не переиспользование
// `RedCheck`: у отказа, который не воспроизводится на хосте, другая подсказка сессии и
// другой исход при `oom`, и схлопнуть их значило бы потерять ровно эту разницу.
type ForgeRedCheck = {
    workflow: string;
    runId: string;
    cube: string;
    log: string;
    kind: ForgeFailureKind;
};

// Пара [имя, команда] шага гейта. Состав приезжает из ralph.config.json (#204, фаза 4):
// ядро гейта не знает конкретных npm-скриптов проекта — только форму «список пар».
type GateCheck = [string, string];

// Блок `gate` из ralph.config.json (после resolveProfile). Ядро читает его лениво через
// getConfig — конфиг присваивается в main() уже после сборки фабрики. Формы валидирует
// resolveGateChecks (fail-closed): неверная схема тут — не «дефолт как у нас», а стоп.
type GateConfigRaw = {
    gate?: {
        checks?: unknown;
        prodChecks?: unknown;
        prodDropChecks?: unknown;
        externalCi?: unknown;
        onToolFailure?: unknown;
    };
    mergeRetryMaxMs?: unknown;
};

// ── Политика гейта (задача 81) ───────────────────────────────────────────────
//
// Что считается подтверждением внешнего CI (`externalCi`). До задачи политика была одна и
// неявная: чеков нет дольше `absentGraceMs` — «мерджим без ожидания», прогон без даты —
// «считаем свежим». Для репозитория без CI это верно, для репозитория, где CI —
// обязательная половина гейта, это дыра: прогон, не заведённый площадкой, и прогон, чью
// свежесть не проверить, пропускали мердж так же, как зелёный.
//
// - `required` — мердж только по зелёному датированному прогону не старше проверенной
//   головы; отсутствие прогона, прогон без даты, неизвестное время коммита головы и шов
//   без чтения чеков — стоп;
// - `optional` — прежнее поведение: прогона нет — мерджим, дата не разобралась — свежим;
// - `disabled` — адаптер чеков не зовётся вовсе.
//
// Что делать со СБОЕМ ИНСТРУМЕНТА (`onToolFailure`) — третьим исходом чека рядом с «прошёл»
// и «регрессия». Образец — флаг `GATE_STRICT` в mshogin/archlint: падение самого
// инструмента не равно находке, и решение о нём принимается настройкой, а не молча.
// `fail-closed` — стоп человеку; `fail-open` — пропуск с записью в доказательстве мерджа.
// При `required` сбой чтения CI мердж не даёт и под `fail-open`: «обязательный» и
// «пропустим, если не прочитался» друг другу противоречат.
//
// Умолчания — `optional` и `fail-closed`: ключей нет — поведение то же, что до задачи, и это
// сказано вслух здесь, а не спрятано. Заданное значение вне списка — стоп: опечатка в
// `requird` молча означала бы `optional`.
export type ExternalCiPolicy = 'required' | 'optional' | 'disabled';
export type ToolFailurePolicy = 'fail-closed' | 'fail-open';
export type GatePolicy = { externalCi: ExternalCiPolicy; onToolFailure: ToolFailurePolicy };

const EXTERNAL_CI_POLICIES: readonly string[] = ['required', 'optional', 'disabled'];
const TOOL_FAILURE_POLICIES: readonly string[] = ['fail-closed', 'fail-open'];

/**
 * Разбор политики гейта из блока `gate`, fail-closed. Если `failFn` вернулся (тестовый или
 * иной потребитель), политика берётся СТРОЖАЙШАЯ, а не умолчание: отказ разбора не имеет
 * права ослабить гейт. Отсутствующий блок `gate` — забота `resolveGateChecks`.
 */
export function resolveGatePolicy(
    cfg: GateConfigRaw | undefined,
    failFn: (msg: string) => unknown,
): GatePolicy {
    const gate = cfg && typeof cfg.gate === 'object' && cfg.gate ? cfg.gate : {};
    let externalCi: ExternalCiPolicy = 'optional';
    let onToolFailure: ToolFailurePolicy = 'fail-closed';
    let broken = false;
    if (gate.externalCi !== undefined) {
        if (typeof gate.externalCi === 'string' && EXTERNAL_CI_POLICIES.includes(gate.externalCi)) {
            externalCi = gate.externalCi as ExternalCiPolicy;
        } else {
            failFn(
                `ralph.config.json: gate.externalCi = ${JSON.stringify(gate.externalCi)} — ожидалось ` +
                    `одно из ${EXTERNAL_CI_POLICIES.join(' | ')}.`,
            );
            broken = true;
        }
    }
    if (gate.onToolFailure !== undefined) {
        if (
            typeof gate.onToolFailure === 'string' &&
            TOOL_FAILURE_POLICIES.includes(gate.onToolFailure)
        ) {
            onToolFailure = gate.onToolFailure as ToolFailurePolicy;
        } else {
            failFn(
                `ralph.config.json: gate.onToolFailure = ${JSON.stringify(gate.onToolFailure)} — ` +
                    `ожидалось одно из ${TOOL_FAILURE_POLICIES.join(' | ')}.`,
            );
            broken = true;
        }
    }
    // Любой отказ разбора — обе половины строжайшие: валидный `fail-open` рядом с
    // опечаткой в `externalCi` не должен пережить стоп, который не остановил.
    return broken
        ? { externalCi: 'required', onToolFailure: 'fail-closed' }
        : { externalCi, onToolFailure };
}

// Упавший локальный чек: регрессия (чинится кодом) или сбой инструмента (кодом не чинится).
//
// Признаки сбоя — только те, что дают сам процесс и шелл, а не текст вывода: код 127
// (команда не найдена) и 126 (не исполняется), код ≥ 128 (убит сигналом сквозь шелл — 137
// у OOM-killer), сигнал у самого процесса, `status === null` (процесс не дал кода вовсе)
// и системный код ошибки запуска (`ENOENT`, `ETIMEDOUT`, `ENOBUFS`). Код 2 — НЕ сбой:
// `tsc` и `prettier` так сообщают о находках, и перевод его в сбой увёл бы регрессию от
// чини-сессии. Ошибка без поля `status` — регрессия: формы `execSync` у неё нет, и делать
// вывод о сбое не из чего.
//
// Трейдофф, принятый осознанно: ЛЮБОЙ `E*`-код — сбой, включая `ENOBUFS` на переполнении
// буфера вывода. Регрессия, зацикливающая вывод теста (бесконечный лог в цикле), уйдёт
// сбоем инструмента, а не чини-сессии. Обратный выбор хуже: `ENOBUFS` чаще значит «вывод
// честно большой» или сбой среды, и чини-сессия по обрезанному выводу правила бы вслепую.
// Цена — стоп человеку вместо лечения (при `fail-closed`) либо пропуск чека вслух (при
// `fail-open`, и только рядом с прошедшими чеками). Не «чинить» в обратную сторону без
// разбора этого случая.
export type CheckFailureKind = 'regression' | 'tool-failure';

export function classifyCheckFailure(e: unknown): CheckFailureKind {
    const err = (e ?? {}) as { status?: unknown; signal?: unknown; code?: unknown };
    if (typeof err.signal === 'string' && err.signal.length > 0) return 'tool-failure';
    if (typeof err.code === 'string' && /^E[A-Z]+$/.test(err.code)) return 'tool-failure';
    if (err.status === null) return 'tool-failure';
    if (typeof err.status === 'number') {
        if (err.status === 126 || err.status === 127 || err.status >= 128) return 'tool-failure';
    }
    return 'regression';
}

// Короткое имя сбоя для лога, стопа и доказательства мерджа: по нему человек отличает
// «нет бинаря» от «убит по памяти», не открывая вывод.
function toolFailureWhy(e: unknown): string {
    const err = (e ?? {}) as { status?: unknown; signal?: unknown; code?: unknown };
    const parts: string[] = [];
    if (typeof err.status === 'number') parts.push(`код ${String(err.status)}`);
    if (typeof err.signal === 'string' && err.signal) parts.push(`сигнал ${err.signal}`);
    if (typeof err.code === 'string' && err.code) parts.push(err.code);
    return parts.join(', ') || 'процесс не дал кода выхода';
}

// Разобранный и провалидированный состав гейта. base — всем профилям; prodChecks —
// добавка prod; prodDrop — имена базовых чеков, которые prod снимает (дедуп test↔coverage,
// #80): раньше это был хардкод `name !== 'test'`, теперь — конфиг, чтобы не-npm стек не
// правил код ради своей пары «тест ⊂ покрытие».
type ResolvedGateChecks = { base: GateCheck[]; prodChecks: GateCheck[]; prodDrop: string[] };

// Контекст ralph.js, захватываемый фабрикой один раз. sh/shArgv/shq/log/ghJson — те же
// module-level коллабораторы, что использует остальной раннер. safeBranch/findOpenPr/
// ensureClean/parkOnOriginMain/updateRunnerTreeToOriginMain/syncDepsIfLockChanged/
// formatExcerpt — уже определённые в ralph.js помощники хореографии. buildSanitizedGateEnv
// — санация env чеков (#188/#189, отдельный gate-env.mts). sleep — ожидание между
// повторами мутации. dry — снимок DRY на момент создания фабрики (DRY иммутабелен,
// ставится из argv на старте): defense-in-depth guard C1 внутри tryMergePhase. regex'ы
// и RUNNER_TREE_FIX_HINT — константы ralph.js.
export type GateEnv = {
    sh: ShFn;
    shArgv: ShArgvFn;
    shq: ShqFn;
    log: LogFn;
    fail: FailFn;
    ghJson: GhJsonFn;
    // #49: чтение головы PR — через шов форжа, как и findOpenPr. Дефолт для checksGreen
    // приходит контекстом (в composition root это GitHub-реализация), а мердж-путь
    // прокидывает сюда метод выбранного адаптера — см. tryMergePhase.
    prHeadSha: PrHeadShaFn;
    // #55: примитивы форжа приходят инъекцией, а не живут в гейте. Раньше их
    // GitHub-реализации лежали прямо здесь, и «гейт» с «GitHub-адаптером» читались одним
    // модулем. Теперь их место — adapters/github-forge-commands.ts, а гейт знает только
    // сигнатуры: мердж состоявшегося PR и ответ «фаза уже смерджена?».
    mergePr: MergePrFn;
    phaseMerged: PhaseMergedFn;
    safeBranch: SafeBranchFn;
    findOpenPr: FindOpenPrFn;
    ensureClean: EnsureCleanFn;
    parkOnOriginMain: ParkFn;
    updateRunnerTreeToOriginMain: UpdateTreeFn;
    // Канон, задача 28: дерево ПОТРЕБИТЕЛЯ подтягивается тем же мерджем фазы. Тип общий с
    // обновлением дерева раннера, а поведение обратное по контракту: этот вызов не бросает
    // никогда — состояние дерева человека следующей фазе не мешает, и стопом быть не может.
    updateConsumerTreeAfterMerge: UpdateTreeFn;
    syncDepsIfLockChanged: SyncDepsFn;
    buildSanitizedGateEnv: BuildGateEnvFn;
    formatExcerpt: FormatExcerptFn;
    sleep: SleepFn;
    dry: boolean;
    SHA40_RE: RegExp;
    PR_NUMBER_RE: RegExp;
    runnerTreeFixHint: string;
    // #204 (фаза 4): ленивый доступ к конфигу — состав чеков гейта живёт в
    // ralph.config.json (gate.checks/prodChecks/prodDropChecks), а не в этом модуле.
    // Ленивый, потому что config присваивается в main() уже после сборки фабрики
    // (тот же приём, что getConfig в deploy-check.ts).
    getConfig: () => GateConfigRaw;
};

// Проверка «пара [строка, непустая строка]» — одна на checks и prodChecks.
function isGateCheckPair(v: unknown): v is GateCheck {
    return (
        Array.isArray(v) &&
        v.length === 2 &&
        typeof v[0] === 'string' &&
        v[0].length > 0 &&
        typeof v[1] === 'string' &&
        v[1].length > 0
    );
}

// Разбор и ВАЛИДАЦИЯ блока `gate` из конфига (#204, фаза 4). Fail-closed: пустой список
// базовых чеков, битая пара [имя, команда], нестроковый prodDropChecks — это стоп с
// внятным сообщением, а НЕ «подставлю дефолтный набор, как у проекта-донора». Молчаливый
// дефолт вернул бы ровно ту проектную привязку, ради выноса которой затевалась фаза:
// чужой проект с забытым/кривым `gate` тихо гонял бы наши npm-скрипты. Чистая функция
// (без побочек) — зовётся и на старте (ранний отказ), и из gateChecksFor (рантайм).
export function resolveGateChecks(
    cfg: GateConfigRaw | undefined,
    failFn: (msg: string) => unknown,
): ResolvedGateChecks {
    const gate = cfg && cfg.gate;
    if (!gate || typeof gate !== 'object') {
        failFn(
            'ralph.config.json: нет блока "gate" — состав чеков гейта задаётся конфигом (#204).',
        );
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    const rawChecks = gate.checks;
    if (!Array.isArray(rawChecks) || rawChecks.length === 0) {
        failFn(
            'ralph.config.json: gate.checks пуст или не массив — базовый набор чеков гейта обязателен ' +
                '(пара [имя, команда]). Пустой гейт смерджил бы фазу без единой проверки.',
        );
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    const bad = rawChecks.find((c) => !isGateCheckPair(c));
    if (bad !== undefined) {
        failFn(
            `ralph.config.json: gate.checks содержит некорректный шаг ${JSON.stringify(bad)} — ` +
                `ожидалась пара [имя, команда] из двух непустых строк.`,
        );
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    const rawProd = gate.prodChecks ?? [];
    if (!Array.isArray(rawProd)) {
        failFn('ralph.config.json: gate.prodChecks должен быть массивом пар [имя, команда].');
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    const badProd = rawProd.find((c) => !isGateCheckPair(c));
    if (badProd !== undefined) {
        failFn(
            `ralph.config.json: gate.prodChecks содержит некорректный шаг ${JSON.stringify(badProd)} — ` +
                `ожидалась пара [имя, команда] из двух непустых строк.`,
        );
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    const rawDrop = gate.prodDropChecks ?? [];
    if (!Array.isArray(rawDrop) || rawDrop.some((n) => typeof n !== 'string')) {
        failFn('ralph.config.json: gate.prodDropChecks должен быть массивом имён чеков (строк).');
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    // Дубли имён внутри набора (#204-ревью): чек с тем же именем исполнится дважды, а
    // атрибуция красного по имени станет неоднозначной (два `test` — какой упал?). Отвергаем
    // на старте, а не гоняем один чек по два раза.
    const checkNames = (rawChecks as GateCheck[]).map(([name]) => name);
    const prodNames = (rawProd as GateCheck[]).map(([name]) => name);
    const dupCheck = checkNames.find((n, i) => checkNames.indexOf(n) !== i);
    if (dupCheck !== undefined) {
        failFn(
            `ralph.config.json: gate.checks содержит дублирующееся имя чека "${dupCheck}" — ` +
                `имена чеков обязаны быть уникальны (иначе двойной прогон и неоднозначная атрибуция красного).`,
        );
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    const dupProd = prodNames.find((n, i) => prodNames.indexOf(n) !== i);
    if (dupProd !== undefined) {
        failFn(
            `ralph.config.json: gate.prodChecks содержит дублирующееся имя чека "${dupProd}" — имена обязаны быть уникальны.`,
        );
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    // prodDropChecks обязан ссылаться на имя ИЗ базового набора (#204-ревью): опечатка
    // (`tests` вместо `test`) иначе молча ничего не снимет — в prod поедут и `test`, и
    // `coverage`, лишние минуты на каждом прогоне гейта, и никто не заметит (класс «гейт
    // толще, чем задумано, молча»). Fail-closed здесь же, а не тихий no-op.
    const unknownDrop = (rawDrop as string[]).find((n) => !checkNames.includes(n));
    if (unknownDrop !== undefined) {
        failFn(
            `ralph.config.json: gate.prodDropChecks ссылается на "${unknownDrop}", которого нет ` +
                `среди gate.checks (${checkNames.join(', ') || 'пусто'}) — опечатка молча ничего бы не сняла.`,
        );
        return { base: [], prodChecks: [], prodDrop: [] };
    }
    return {
        base: rawChecks as GateCheck[],
        prodChecks: rawProd as GateCheck[],
        prodDrop: rawDrop as string[],
    };
}

export function createGateRunner(env: GateEnv) {
    const {
        sh,
        shArgv,
        shq,
        log,
        fail,
        ghJson,
        prHeadSha,
        mergePr,
        phaseMerged,
        safeBranch,
        findOpenPr,
        ensureClean,
        parkOnOriginMain,
        updateRunnerTreeToOriginMain,
        updateConsumerTreeAfterMerge,
        syncDepsIfLockChanged,
        buildSanitizedGateEnv,
        formatExcerpt,
        sleep,
        dry: DRY,
        SHA40_RE,
        PR_NUMBER_RE,
        runnerTreeFixHint: RUNNER_TREE_FIX_HINT,
        getConfig,
    } = env;

    // ── State гейта (замыкание фабрики) ──────────────────────────────────────
    // sha PR-головы, на которой последний прогон гейта дал ВСЕ зелёные (null = гейт не
    // доходил до зелёного финала). Отдаётся в `gh pr merge --match-head-commit`, чтобы
    // закрыть TOCTOU-окно между прогоном чеков и мерджем (#SiaTz).
    let lastVerifiedHead: string | null = null;
    // Последний упавший ЧЕК гейта (null = гейт падал не на чеках: fetch/HEAD/detach).
    // Разделение важно: чини-сессия имеет смысл только для красных чеков — сетевые
    // и git-проблемы кодом не лечатся.
    let lastRedCheck: RedCheck | null = null;
    // Номер PR последнего прохода гейта (null = гейт не дошёл до findOpenPr). #218:
    // нужен runLoop'у для текста пуша «блокер снят автоматически» — событие рождается
    // ПОСЛЕ tryMergePhase вернул строку-статус, а не объект с PR, так что номер несём
    // тем же геттер-паттерном, что lastRedCheck/lastVerifiedHead.
    let lastGatePr: number | null = null;
    // #269: красный чек ПЛОЩАДКИ последнего прохода гейта (null = чек площадки не краснел
    // либо его не спрашивали). Отдаётся геттером тем же приёмом, что lastRedCheck: значение
    // ставится побочкой ВНУТРИ tryMergePhase и читается циклом уже после её возврата.
    let lastForgeRedCheck: ForgeRedCheck | null = null;
    // #66: последний прогон гейта встал на подтяжке main (конфликт или сбой влития).
    // Геттер тем же приёмом, что lastRedCheck: ставится внутри checksGreen, читается после.
    let lastMainSyncStop: Exclude<MainSyncResult, { kind: 'current' | 'updated' }> | null = null;
    // #85: локальный ref ветки разошёлся с головой PR — строка, которую гейт напечатал. Раньше
    // этот отказ уходил безымянным 'not-merged', и пуш человеку нёс «причина не установлена»,
    // хотя гейт назвал её точно. Геттер тем же приёмом, что lastMainSyncStop.
    let lastHeadDivergence: { local: string; remote: string; line: string } | null = null;
    // #269-ревью: причина стопа на чеке форжа БЕЗ вердикта (потолок ожидания, устойчивый
    // сбой чтения, красный прогон без названного куба). Отдаётся тем же геттер-приёмом,
    // что lastForgeRedCheck: цикл читает её ПОСЛЕ возврата статуса `forge-unknown` и
    // кладёт в пуш человеку — иначе ночная остановка выясняется только утром.
    let lastForgeStop: string | null = null;
    // #123: мердж не удался — класс отказа и строка ответа форжа. Раньше гейт писал их только
    // логом, и пуш на `not-merged` уходил катч-оллом «причина не установлена», хотя класс
    // (по существу / транзиент дольше предела / нераспознанный) гейт знал точно. Геттер тем
    // же приёмом, что lastHeadDivergence: ставится внутри tryMergePhase, читается после.
    let lastMergeFailure: MergeFailure | null = null;
    // Задача 81: чек последнего прогона, упавший на ИНСТРУМЕНТЕ при `fail-closed` (null —
    // такого не было), и чеки, пропущенные по `fail-open`. Оба ставятся побочкой
    // checksGreen и читаются геттерами — тем же приёмом, что lastRedCheck.
    let lastToolFailure: ToolFailure | null = null;
    let lastToolSkips: ToolFailureSkip[] = [];
    // Доказательство мерджа последнего прохода: что проверено, по какой политике и что
    // решено со сбоями инструмента. null — до мерджа проход не дошёл.
    let lastMergeProof: string | null = null;

    // ── Состав шагов гейта: из конфига (#204, фаза 4) ─────────────────────────
    //
    // Раньше BASE/PROD_GATE_CHECKS были хардкодом здесь и прибивали ядро к npm-скриптам
    // одного проекта. Теперь состав живёт в ralph.config.json (gate.checks/prodChecks/
    // prodDropChecks) — ядро знает только КОНТРАКТ, не конкретные команды. Что осталось в
    // коде (потому что это правила ядра, а не проектная специфика):
    //
    // - Fail-fast порядок «дешёвый → дорогой» — ОТВЕТСТВЕННОСТЬ автора конфига: список
    //   исполняется как есть, красный первого чека отменяет мердж, не оплатив следующих.
    //   Секундные проверки (канарейка секретов, `vitest list`, `git grep`) должны идти
    //   раньше минутных (build) и очень дорогих (e2e). Пояснение к КОНКРЕТНОМУ порядку —
    //   дело проекта: рядом со списком в его `ralph.config.json`.
    // - Дедуп base↔prod через prodDropChecks (#80): в prod проект снимает базовый `test`
    //   в пользу `coverage` (тот же `vitest run` + инструментация — строгое надмножество,
    //   двойной прогон = лишние минуты). Раньше это был хардкод `name !== 'test'`; теперь
    //   имена снимаемых чеков задаёт конфиг — не-npm стек без этой пары просто оставляет
    //   prodDropChecks пустым. Атрибуция красного не теряется: упавший тест красит coverage
    //   тем же ненулевым кодом.
    // - Селектор ТОЛЬКО собирает список — fail-closed сохранён в checksGreen: падение любого
    //   чека по-прежнему отменяет мердж. Неизвестный/пустой профиль → только база (безопасный
    //   дефолт, лишний прогон никогда не мягче нужного).

    // cfg — параметр с дефолтом getConfig() (как cfg у deploy-check): в проде и в runLoop
    // прокидывают активный конфиг явно, тесты состава передают синтетический. Дефолт нужен
    // для checksGreen (её вызывают без cfg) — тогда берётся фабричный config, уже присвоенный
    // main().
    function gateChecksFor(profileName?: string, cfg: GateConfigRaw = getConfig()): GateCheck[] {
        const { base, prodChecks, prodDrop } = resolveGateChecks(cfg, fail);
        if (profileName === 'prod') {
            const kept = base.filter(([name]) => !prodDrop.includes(name));
            return [...kept, ...prodChecks];
        }
        return [...base];
    }

    // ── Прогон чеков на PR-голове (#77) ──────────────────────────────────────

    function checksGreen(
        branch: string,
        prNumber: number,
        {
            shFn = sh,
            // #193: git fetch/checkout — МУТАЦИИ на пути к автодеплою, через argv (shArgv),
            // не строкой через шелл. Имя ветки и sha PR-головы уходят отдельными элементами
            // argv — shell-инъекция закрыта структурно, а не квотированием shq(). Чтение
            // (git rev-parse) остаётся на shFn — оно не мутация (обоснование — #194).
            runArgvFn = shArgv,
            // #49: голову PR отдаёт ШОВ форжа, а не гейт. Раньше здесь стоял inline-вызов
            // `gh pr view --json headRefOid` — операция форжа, застрявшая внутри гейта: на
            // площадке без `gh` она давала три ретрая и 'not-merged' НАВСЕГДА, то есть
            // мердж-путь был мёртв целиком. Дефолт — из контекста фабрики; мердж-путь
            // прокидывает сюда метод выбранного адаптера через tryMergePhase.
            prHeadShaFn = prHeadSha,
            logFn = log,
            parkFn = parkOnOriginMain,
            syncDepsFn = syncDepsIfLockChanged,
            // env-санация чеков (#189): строит окружение по allowlist один раз на прогон
            // гейта. DI — для теста fail-closed; в проде — buildSanitizedGateEnv.
            buildGateEnvFn = buildSanitizedGateEnv,
            // Состав гейта (#80): по умолчанию база (playground) из конфига. tryMergePhase
            // прокидывает сюда список по активному профилю; для prod он длиннее на толстые
            // чеки. Дефолт вычисляется лениво (#204) — конфиг присваивается в main() уже
            // после сборки фабрики; в проде checksGreen всегда зовут с явным `checks`.
            checks = gateChecksFor(),
            // Задача 81: что делать с чеком, упавшим на инструменте. Дефолт — из конфига
            // тем же ленивым приёмом, что `checks`; tryMergePhase прокидывает явно.
            onToolFailure = resolveGatePolicy(getConfig(), fail).onToolFailure,
            // #66: подтяжка `origin/main` в отставшую ветку фазы. DI — ради юнитов гейта:
            // настоящий git этого шага проверяет `tests/main-sync-scenarios.test.ts`.
            mainSyncFn = syncPhaseBranchWithMain,
        }: {
            shFn?: ShFn;
            runArgvFn?: ShArgvFn;
            prHeadShaFn?: PrHeadShaFn;
            logFn?: LogFn;
            parkFn?: ParkFn;
            syncDepsFn?: SyncDepsFn;
            buildGateEnvFn?: BuildGateEnvFn;
            checks?: GateCheck[];
            onToolFailure?: ToolFailurePolicy;
            mainSyncFn?: typeof syncPhaseBranchWithMain;
        } = {},
    ): boolean {
        // Сброс СРАЗУ: любой выход из этого раунда до чеков не должен носить red-check
        // прошлого раунда — tryMergePhase иначе вернул бы 'red-checks' с устаревшей
        // ошибкой и чини-сессия чинила бы уже починенное. lastVerifiedHead тоже сбрасываем:
        // старый sha не должен доехать до --match-head-commit, если этот раунд упал до чеков.
        lastRedCheck = null;
        lastVerifiedHead = null;
        lastToolFailure = null;
        lastToolSkips = [];
        lastMainSyncStop = null;
        lastHeadDivergence = null;
        // #204-ревью: пустой список чеков не имеет права привести к мерджу. Цикл ниже с
        // пустым `checks` не сделал бы ни одной итерации, lastVerifiedHead записался бы и
        // фаза уехала в main без единой проверки. Сегодня этот путь прикрыт тем, что боевой
        // fail в resolveGateChecks делает process.exit(1), но сигнатура FailFn допускает
        // возвращающийся fail (тест/иной потребитель) — тогда gateChecksFor() отдаёт []. По
        // инварианту №5 (барьеры важнее промптов) дешёвая страховка в самой точке исполнения.
        if (checks.length === 0) {
            logFn(
                `⛔ Гейт мерджа: список чеков пуст — мердж без единой проверки отменён (gate.checks в конфиге).`,
            );
            parkFn();
            return false;
        }
        // #135: валидация ДО git — это путь к авто-мерджу в main (= автодеплой прода),
        // и он единственный оставался без проверки имени ветки.
        if (!safeBranch(branch, { logFn, where: 'гейт мерджа' })) {
            parkFn();
            return false;
        }
        try {
            runArgvFn('git', ['fetch', 'origin', branch], gitNetworkOpts());
        } catch (e: unknown) {
            logFn(
                `⛔ git fetch origin ${branch} упал (${(e as Error).message}) — без свежего remote нельзя убедиться, что тестируем то, что мерджим. Авто-мердж отменён.`,
            );
            parkFn();
            return false;
        }
        let remoteHead: string;
        try {
            remoteHead = prHeadShaFn(prNumber);
        } catch (e: unknown) {
            logFn(
                `⛔ Не смог получить голову PR #${prNumber}: ${(e as Error).message} — авто-мердж отменён.`,
            );
            parkFn();
            return false;
        }
        // Формат проверяем ЗДЕСЬ, хотя шов и обязан отдавать голову либо бросать: sha уходит
        // в argv `git checkout --detach` и в `--match-head-commit`, и доверять этот путь
        // добросовестности реализации шва (в т.ч. будущей, чужого форжа) нельзя (инв. C3/7).
        if (!SHA40_RE.test(String(remoteHead))) {
            logFn(
                `⛔ Голова PR #${prNumber} не похожа на sha коммита ('${remoteHead}') — авто-мердж отменён.`,
            );
            parkFn();
            return false;
        }
        // H3 в worktree-модели: чеки идут на remote-голове, но незапушенная работа не
        // должна молча теряться. refs/heads/<branch> ОБЩИЙ для всех worktree репозитория —
        // это тот самый ref, куда коммитили кодер-сессии; разошёлся с PR (push агента
        // упал; допушено с другой машины) → в main уехала бы фаза без части работы или
        // непрогнанный код. Не совпало → не мерджим. Ветки нет локально (свежая машина,
        // хвост после --delete-branch) — локальной работы нет, сверять нечего: гоняем
        // чеки на PR-голове как есть.
        let localHead: string | null = null;
        try {
            localHead = shFn(`git rev-parse --verify --quiet ${shq('refs/heads/' + branch)}`);
        } catch {}
        if (localHead && localHead !== remoteHead) {
            // #466: расхождение бывает двух разных смыслов, а раньше они были схлопнуты
            // в одно сообщение. Отставший ref (localHead — предок головы PR) — не
            // конфликт: так выглядит ветка после того, как человек допушил в неё
            // (например, влил main ради внешнего красного чека). Терять тут нечего,
            // ff-подтяжка безопасна по построению.
            let refIsBehind = false;
            try {
                runArgvFn('git', ['merge-base', '--is-ancestor', localHead, remoteHead]);
                refIsBehind = true;
            } catch {}
            if (refIsBehind) {
                // #134: ДО перевода ref дерево снимается с ветки. Раньше это подразумевалось
                // («дерево раннера detached»), и с приходом проводки на ветку перестало быть
                // правдой: `git update-ref` двигает ref, не спрашивая, выбран ли он, — и в
                // дереве мгновенно появляется фантомная разница (файлы головы PR числятся
                // удалёнными). Проверено опытом: `D g` в статусе сразу после update-ref,
                // и он переживает последующий детач. Дальше чеки шли бы по неполному дереву,
                // а commitLeftovers следующей итерации закоммитил бы это удаление в ветку.
                try {
                    runArgvFn('git', ['checkout', '--detach', remoteHead]);
                } catch (e: unknown) {
                    logFn(
                        `⛔ Не смог снять дерево с ветки ${branch} перед подтяжкой ref (${(e as Error).message}) — авто-мердж отменён.`,
                    );
                    parkFn();
                    return false;
                }
                // Отказ перевода ref (ref-lock от параллельного процесса, права на .git)
                // раньше улетал исключением мимо парковки и внятного сообщения. С детачем
                // выше цена такого отказа выросла: дерево уже на голове PR, а ref остался
                // старым — молчать тут нельзя.
                try {
                    runArgvFn('git', ['update-ref', `refs/heads/${branch}`, remoteHead]);
                } catch (e: unknown) {
                    logFn(
                        `⛔ Не смог подтянуть локальный ref ${branch} к голове PR #${prNumber} (${(e as Error).message}) — авто-мердж отменён.`,
                    );
                    parkFn();
                    return false;
                }
                logFn(
                    `↪ Локальный ref ${branch} отстал от головы PR #${prNumber} (${localHead.slice(0, 8)} → ${remoteHead.slice(0, 8)}) — подтянут fast-forward, работа не теряется.`,
                );
            } else {
                // Настоящее ветвление: локально есть коммиты, которых нет в PR. Здесь
                // нужен человек — но подсказка обязана быть выполнимой. Дерево раннера
                // detached, а ref общий для всех worktree, поэтому ни push, ни pull не
                // помогают: лечится только принудительным переводом ref.
                const line = `Локальный ref ${branch} (${localHead.slice(0, 8)}) разошёлся с головой PR #${prNumber} (${remoteHead.slice(0, 8)}): локально есть коммиты, которых нет в PR — в main уехал бы не тот код. Разбери руками, затем: git branch -f ${branch} origin/${branch}`;
                lastHeadDivergence = { local: localHead, remote: remoteHead, line };
                logFn(`⛔ ${line}`);
                parkFn();
                return false;
            }
        }
        try {
            runArgvFn('git', ['checkout', '--detach', remoteHead]);
        } catch (e: unknown) {
            logFn(
                `⛔ Не смог встать на голову PR #${prNumber} (${(e as Error).message}) — авто-мердж отменён.`,
            );
            parkFn();
            return false;
        }
        // #66: ветка фазы живёт часами, а `main` за это время уходит вперёд чужими мерджами.
        // Подтягиваем его ДО чеков: чеки обязаны проверять то, что уедет в main, а встречная
        // правка того же файла иначе всплывала безымянным отказом мерджа уже после гейта.
        // Конфликт петля не разбирает — стоп с именами файлов (`main-sync.ts`).
        const synced = mainSyncFn(branch, remoteHead, { runArgvFn, logFn });
        if (synced.kind === 'conflict' || synced.kind === 'failed') {
            lastMainSyncStop = synced;
            logFn(
                synced.kind === 'conflict'
                    ? `⛔ Ветка ${branch} отстала от main (${synced.main.slice(0, 8)}) и конфликтует с ним в: ${synced.files.join(', ')} — влитие отменено, авто-мердж отменён.`
                    : `⛔ Ветка ${branch}: не смог подтянуть origin/main (${synced.why}) — авто-мердж отменён.`,
            );
            parkFn();
            return false;
        }
        // Чеки, санация и `--match-head-commit` — уже на голове с влитым main. Форж узнаёт о
        // ней из пуша, и между пушем и мерджем идут чеки и ожидание его CI, так что окно
        // мало. Не успел — отказ «голова не та» (`Head branch was modified`, `head sha …`)
        // merge-retry.ts считает отказом по существу: это стоп петли с текстом форжа, а
        // не повтор. Не та голова в main при этом не уходит: привязку держит сам флаг.
        if (synced.kind === 'updated') remoteHead = synced.head;
        // env-санация (#189): чеки и `npm ci` ниже исполняют код проверяемого PR в дереве
        // раннера, где в окружении лежат секреты петли. Строим санированный env по allowlist
        // ОДИН раз на прогон и прокидываем его и в syncDeps (npm ci), и в каждый чек. Fail-closed:
        // битый/нечитаемый allowlist → стоп, а не запуск чеков с полным env (инвариант 1).
        let gateEnv: NodeJS.ProcessEnv;
        try {
            gateEnv = buildGateEnvFn();
        } catch (e: unknown) {
            logFn(
                `⛔ Санация окружения чеков гейта не удалась (${(e as Error).message}) — чеки без allowlist не запускаем, авто-мердж отменён.`,
            );
            parkFn();
            return false;
        }
        // #SiaUX: PR-голова могла добавить зависимость (её package-lock новее, а node_modules
        // дерева раннера — старые). Переустанавливаем ДО чеков при расхождении lock, иначе
        // build/test упали бы красным на «module not found» из-за инфраструктуры, а не кода.
        syncDepsFn({ env: gateEnv });
        // Хвост вывода последнего пропущенного по fail-open чека — на случай, если пропущены
        // ВСЕ: тогда он становится выводом стопа (см. нижнюю планку после цикла).
        let lastSkipExcerpt = '';
        for (const [name, cmd] of checks) {
            try {
                shFn(cmd, { env: gateEnv });
                logFn(`  ✓ ${name}`);
            } catch (e: unknown) {
                const err = e as { stdout?: string; stderr?: string; message?: string };
                const raw =
                    `${err.stdout || ''}\n${err.stderr || ''}`.trim() || String(err.message);
                // Задача 81: третий исход. Чек, упавший на инструменте (нет бинаря, убит
                // сигналом, не запустился), — не регрессия: в `lastRedCheck` он не попадает
                // никогда, иначе цикл отдал бы его чини-сессии, и та «чинила» бы код,
                // которого никто не ломал.
                if (classifyCheckFailure(e) === 'tool-failure') {
                    const why = toolFailureWhy(e);
                    if (onToolFailure === 'fail-open') {
                        logFn(
                            `  ⚠ ${name} — сбой инструмента (${why}), не регрессия: пропущен по ` +
                                'gate.onToolFailure: fail-open, решение уйдёт в доказательство мерджа',
                        );
                        lastToolSkips.push({ name, cmd, why });
                        lastSkipExcerpt = formatExcerpt(raw);
                        continue;
                    }
                    logFn(
                        `  ✗ ${name} — сбой инструмента (${why}), не регрессия: кодом не чинится, авто-мердж отменён`,
                    );
                    lastToolFailure = { name, cmd, why, excerpt: formatExcerpt(raw) };
                    parkFn();
                    return false;
                }
                logFn(`  ✗ ${name} — красный, авто-мердж отменён`);
                // Хвост вывода чека — топливо для чини-сессии гейта (self-heal): без
                // текста ошибки агент чинил бы вслепую. Спецсимволы безопасны — см. formatExcerpt.
                lastRedCheck = {
                    name,
                    cmd,
                    excerpt: formatExcerpt(raw),
                };
                parkFn();
                return false;
            }
        }
        // Нижняя планка fail-open (задача 81, ревью): если на инструменте упали ВСЕ чеки
        // (нет node — каждый `npm run …` даёт 127), реально не прошёл ни один, и мердж ушёл
        // бы в main с нулём проверок — тот же случай, что пустой список чеков выше.
        // Пропуск по fail-open разрешён только РЯДОМ с хотя бы одним прошедшим чеком; иначе
        // это стоп сбоя инструмента, как при fail-closed.
        if (lastToolSkips.length === checks.length) {
            const names = lastToolSkips.map((k) => `${k.name} — ${k.why}`).join('; ');
            logFn(
                `  ✗ все ${String(checks.length)} чек(а) упали на инструменте (${names}) — ` +
                    'fail-open не пропускает гейт без единого прошедшего чека, авто-мердж отменён',
            );
            const last = lastToolSkips[lastToolSkips.length - 1];
            lastToolFailure = {
                name: last.name,
                cmd: last.cmd,
                why: `все чеки гейта упали на инструменте: ${names}`,
                excerpt: lastSkipExcerpt,
            };
            parkFn();
            return false;
        }
        // Все чеки зелёные на ЭТОМ sha — запоминаем его для --match-head-commit при мердже
        // (#SiaTz): gh иначе смерджил бы голову PR НА МОМЕНТ мерджа, а не ту, что прогнали.
        lastVerifiedHead = remoteHead;
        return true;
    }

    // ── «Фаза уже смерджена?» ────────────────────────────────────────────────

    // ── Удаление локального ref ветки фазы после мерджа (#387) ─────────────────
    // Локальную ветку фазы создаёт САМ РАННЕР (не дерево человека) для инварианта H3 —
    // сверка «локальный ref == голова PR» перед мерджем (checksGreen). После мерджа она
    // не нужна и копится мусором фаза за фазой: `gh pr merge --delete-branch` иногда её
    // не успевает/не может убрать (дерево раннера в этот момент детачено на sha PR, не
    // стоит на branch), и тогда ref остаётся — раньше это молча объяснялось неверной
    // причиной («занятый деревом человека», #SiaUf). Зовётся ПОСЛЕ подтверждённого
    // мерджа (см. tryMergePhase), fail-open: неудача удаления — чистка, не инвариант,
    // ронять цикл она не должна. Имя ветки — только через safeBranch (anti-injection,
    // инв. C3/7), сама мутация — argv (shArgv), не строка через шелл.
    function deleteLocalBranchRef(
        branch: string,
        {
            shFn = sh,
            runArgvFn = shArgv,
            logFn = log,
        }: { shFn?: ShFn; runArgvFn?: ShArgvFn; logFn?: LogFn } = {},
    ): void {
        if (!safeBranch(branch, { logFn, where: 'deleteLocalBranchRef' })) return;
        let exists = true;
        try {
            shFn(`git rev-parse --verify --quiet ${shq('refs/heads/' + branch)}`);
        } catch {
            exists = false;
        }
        if (!exists) return;
        try {
            runArgvFn('git', ['branch', '-D', branch]);
            logFn(`🧹 Локальный ref ветки ${branch} удалён после мерджа фазы (#387).`);
        } catch (e: unknown) {
            logFn(
                `⚠ Не удалось удалить локальный ref ветки ${branch} после мерджа (${(e as Error).message}) — не критично, продолжаем.`,
            );
        }
    }

    // ── Момент коммита головы PR (#278) ──────────────────────────────────────
    // Нижняя граница свежести вердикта форжа (`sinceMs` у `waitForForgeChecks`): прогон
    // с `createdAt` раньше этого момента физически не может отвечать за код текущей
    // головы — форж ещё не мог его увидеть. Читаем ЛОКАЛЬНО, без похода к форжу: к
    // этому моменту `checksGreen` уже сделал `git checkout --detach` ровно на этот sha
    // (дерево раннера содержит коммит целиком). Sha приходит из `lastVerifiedHead`,
    // прошедшего проверку `SHA40_RE` в checksGreen, — интерполяция в шелл безопасна.
    function headCommittedAt(sha: string, shFn: ShFn = sh, shqFn: ShqFn = shq): number {
        const iso = shFn(`git log -1 --format=%cI ${shqFn(sha)}`).trim();
        const ms = Date.parse(iso);
        if (!Number.isFinite(ms)) {
            throw new Error(`git log -1 не вернул валидную дату коммита ${sha} ('${iso}')`);
        }
        return ms;
    }

    // ── Гейт мерджа фазы ─────────────────────────────────────────────────────

    /**
     * Гейт мерджа фазы. Возвращает:
     *   'merged'             — смерджено, дерево раннера на свежем origin/main → к следующей фазе;
     *   'merge-unconfirmed'  — форж ПРИНЯЛ мердж, но не подтвердил его (#53). У площадки
     *                          мердж асинхронный: `POST /pulls/{n}/merge` отдаёт
     *                          operation_id и статус `scheduled`, а не свершившийся факт.
     *                          Раньше петля сразу фетчила origin/main и считала фазу сданной —
     *                          в непрерывном режиме следующая фаза могла строиться от
     *                          ДО-мерджевого main. «Не подтверждён» ≠ «не смерджен»: повторять
     *                          мердж нельзя, продолжать тоже, поэтому отдельный исход и стоп;
     *   'merged-local-stale' — PR СМЕРДЖЕН, но fetch/detach origin/main упал (H4). Раньше
     *                          merge и пост-мердж шаги жили в одном try, и лог ВРАЛ
     *                          «мердж не удался» при уже влитом PR — состояние надо
     *                          различать: восстановление другое (руками + рестарт);
     *   'hold'                — на PR label hold (#222): человек остановил PR. Проверяется
     *                          ПЕРВОЙ, впереди blocked — hold сильнее и не подлежит
     *                          авто-разбору вообще: ни чини-сессии, ни повторного ревью,
     *                          ни чеков. Раннер эту метку не снимает никогда (в отличие
     *                          от blocked, который снимает и переоценивает сам — #217) —
     *                          снять может только человек;
     *   'blocked'            — на PR label blocked (ревью нашло блокеры): цикл запустит
     *                          разбор блокеров (до blockedHealAttempts раз), потом человек;
     *   'red-checks'         — гейт упал именно на ЧЕКАХ (build/lint/.../test): это
     *                          чинится кодом → цикл запустит чини-сессию (self-heal);
     *   'forge-red'          — ЛОКАЛЬНЫЕ чеки зелёные, а чек PR у форжа красный (#269), и
     *                          его лог говорит про код: цикл запустит ту же чини-сессию,
     *                          но с логом упавшего куба площадки и подсказкой «отказ
     *                          воспроизводится только там»;
     *   'forge-env'          — чек форжа красный по отказу СРЕДЫ (OOM контейнера гейта,
     *                          убитый форк) без единого проваленного кейса: кодом это не
     *                          чинится, и сессия лечения принялась бы «чинить» здоровые
     *                          тесты. Стоп с диагнозом человеку;
     *   'forge-unknown'      — чек форжа не дал ВЕРДИКТА (потолок ожидания, устойчивый
     *                          сбой чтения, красный прогон без названного куба). Тоже стоп
     *                          человеку, но отдельным статусом от 'not-merged' (правка по
     *                          ревью #269): цикл обязан отдать его ПУШЕМ, а не только
     *                          строкой в `ralph.log`. Потолок в 20 минут при `max_slots: 1`
     *                          достижим штатно — один чужой прогон в очереди съедает
     *                          бюджет, — и ночью такая остановка иначе выясняется утром.
     *                          Причина текстом лежит в `lastForgeStop` (геттер ниже);
     *   'main-conflict'      — ветка фазы отстала от main, и подтянуть его не вышло (#66):
     *                          встречная правка тех же файлов либо сбой влития/пуша. Файлы
     *                          и причина — в `getLastMainSyncStop()`; стоп человеку пушем;
     *   'head-diverged'      — локальный ref ветки разошёлся с головой PR (#85): локально
     *                          есть коммиты, которых нет в PR. Строка гейта — в
     *                          `getLastHeadDivergence()`; стоп человеку пушем с ней же;
     *   'pr-unreadable'      — открытый PR ветки не прочитался: форж бросил (#127). Это не
     *                          «PR нет» — стоп человеку пушем, причина в `lastForgeStop`;
     *   'not-merged'         — не мерджили по нечинимой причине (нет PR / blocked /
     *                          сеть-git проблемы / merge упал).
     *
     * DI (#77): коллабораторы с побочками и флаг dry — параметрами с дефолтами из
     * контекста фабрики, как у preflight/runLoop; в проде зовётся без deps.
     * getLastRedCheckFn — геттер, а не снимок: red-check ставится как побочка ВНУТРИ
     * checksGreen и читается после её вызова (та же причина, что у runLoop).
     */
    function tryMergePhase(
        phase: { branch: string; milestone?: string },
        {
            dry = DRY,
            shFn = sh,
            // #193: gh pr merge и пост-мердж git fetch/checkout — МУТАЦИИ, ведущие в main
            // (= автодеплой прода), через argv (shArgv), не строкой через шелл. shFn остаётся
            // для чтений/прочей хореографии (обоснование оставленного на shq — #194).
            runArgvFn = shArgv,
            logFn = log,
            ensureCleanFn = ensureClean,
            findOpenPrFn = findOpenPr,
            checksGreenFn = checksGreen,
            // #49: шов чтения головы PR приходит от runLoop вместе с findOpenPrFn/mergePrFn —
            // и обязан доехать до checksGreen. Иначе подмена taskSource меняла бы мердж, но
            // не прогон чеков: чеки продолжили бы спрашивать голову у GitHub («тихий дефолт»,
            // инвариант №1, тот же класс, ради которого стоит барьер #415).
            prHeadShaFn = prHeadSha,
            phaseMergedFn = phaseMerged,
            sleepFn = sleep,
            parkFn = parkOnOriginMain,
            mergePrFn = mergePr,
            deleteLocalBranchRefFn = deleteLocalBranchRef,
            getLastRedCheckFn = () => lastRedCheck,
            getVerifiedHeadFn = () => lastVerifiedHead,
            // Профиль (#80) решает состав гейта. runLoop прокидывает cfg.profileName; по
            // умолчанию (undefined) — только база, безопасный дефолт вне цикла.
            profileName = undefined,
            // #53: сколько раз спросить форж «фаза уже смерджена?» после принятого мерджа и
            // с какой паузой. Значения скромные не случайно: у синхронного форжа (GitHub)
            // первый же ответ — подтверждение, и цена проверки нулевая; у асинхронного речь
            // о секундах очереди, а не о минутах. Параметрами, а не константами, — тесты
            // обязаны проходить без реальных пауз (правило «время — параметр»).
            mergeConfirmAttempts = 6,
            mergeConfirmDelayMs = 5_000,
            // #47: предел по времени на повторы мерджа при транзиентных отказах форжа.
            // Дефолт — из конфига (`mergeRetryMaxMs`), его отсутствие — дефолт модуля.
            mergeRetryMaxMs = resolveMergeRetryMaxMs(getConfig(), fail),
            // #269: шов «чек PR у форжа». Приходит из runLoop вместе с остальными
            // примитивами мердж-пути; undefined = у реализации шва такого метода нет,
            // и тогда шаг пропускается целиком (прежнее поведение).
            forgeChecksFn,
            forgeDiagnosisFn,
            // #269-ревью: прогон, по логу которого чини-сессия УЖЕ отработала. Форж отдаёт
            // ПОСЛЕДНИЙ прогон workflow, а не прогон конкретного sha, — и после пуша правок
            // какое-то время повторяет вердикт прошлого. Без этого номера петля тратила бы
            // вторую (последнюю) попытку лечения на уже починенный лог.
            healedForgeRunId,
            // #278: момент коммита проверенной головы — нижняя граница свежести вердикта
            // форжа (`sinceMs`). DI ради тестов: боевой дефолт зовёт `git log`, юнит-тест
            // гейта не обязан таскать за собой настоящий git-репозиторий ради этой мелочи.
            headCommittedAtFn = headCommittedAt,
            // Политика ожидания — чистая функция ядра, инжектится ради тестов: иначе
            // проверка потолка шла бы двадцать реальных минут.
            waitForForgeChecksFn = waitForForgeChecks,
            classifyForgeFailureFn = classifyForgeFailure,
            nowFn = () => Date.now(),
            // Задача 81: политика внешнего CI и сбоев инструмента. Дефолт — из конфига;
            // тесты кладут свою через getConfig фабрики или этим параметром.
            gatePolicy = resolveGatePolicy(getConfig(), fail),
            getLastToolFailureFn = () => lastToolFailure,
            getToolFailureSkipsFn = () => lastToolSkips,
            getLastMainSyncStopFn = () => lastMainSyncStop,
            getLastHeadDivergenceFn = () => lastHeadDivergence,
            // #88: метка начатого мерджа — запись state раньше POST. Гейт state не знает,
            // поэтому пишет её вызывающий; без него (юнит гейта) шаг пуст, как до карточки.
            onMergeStartFn = () => {},
            // #88: исход мерджа определён без влития — форж отказал по существу на ПЕРВОЙ
            // попытке. Только тогда метку можно снять: после транзиента любая из попыток
            // могла лечь в очередь форжа с потерянным ответом.
            onMergeSettledFn = () => {},
        }: {
            dry?: boolean;
            shFn?: ShFn;
            runArgvFn?: ShArgvFn;
            logFn?: LogFn;
            ensureCleanFn?: EnsureCleanFn;
            findOpenPrFn?: FindOpenPrFn;
            checksGreenFn?: typeof checksGreen;
            prHeadShaFn?: PrHeadShaFn;
            phaseMergedFn?: PhaseMergedFn;
            sleepFn?: SleepFn;
            parkFn?: ParkFn;
            mergePrFn?: MergePrFn;
            deleteLocalBranchRefFn?: typeof deleteLocalBranchRef;
            getLastRedCheckFn?: () => RedCheck | null;
            getVerifiedHeadFn?: () => string | null;
            profileName?: string;
            mergeConfirmAttempts?: number;
            mergeConfirmDelayMs?: number;
            mergeRetryMaxMs?: number;
            forgeChecksFn?: ForgeChecksFn;
            forgeDiagnosisFn?: ForgeDiagnosisFn;
            healedForgeRunId?: string;
            headCommittedAtFn?: (sha: string) => number;
            waitForForgeChecksFn?: typeof waitForForgeChecks;
            classifyForgeFailureFn?: typeof classifyForgeFailure;
            nowFn?: () => number;
            gatePolicy?: GatePolicy;
            getLastToolFailureFn?: () => ToolFailure | null;
            getToolFailureSkipsFn?: () => ToolFailureSkip[];
            getLastMainSyncStopFn?: () => typeof lastMainSyncStop;
            getLastHeadDivergenceFn?: () => typeof lastHeadDivergence;
            onMergeStartFn?: (prNumber: number, head: string | null) => void;
            onMergeSettledFn?: () => void;
        } = {},
    ):
        | 'merged'
        | 'merge-unconfirmed'
        | 'merged-local-stale'
        | 'hold'
        | 'blocked'
        | 'red-checks'
        | 'forge-red'
        | 'forge-env'
        | 'forge-unknown'
        | 'gate-tool-failure'
        | 'main-conflict'
        | 'head-diverged'
        | 'pr-unreadable'
        | 'not-merged' {
        // #218: сброс СРАЗУ, тем же приёмом, что checksGreen сбрасывает lastRedCheck/
        // lastVerifiedHead — раунд, упавший ДО findOpenPr (dry/грязное дерево), не должен
        // оставлять номер PR прошлого раунда для текста пуша «блокер снят автоматически».
        lastGatePr = null;
        // #269: тем же приёмом и по той же причине — раунд, упавший до чека площадки,
        // не должен носить красный куб прошлого раунда.
        lastForgeRedCheck = null;
        lastForgeStop = null;
        lastMergeFailure = null;
        lastMergeProof = null;
        // C1: dry-run строго read-only. Основной guard стоит в цикле ДО вызова гейта;
        // этот — defense in depth: даже если будущая правка цикла потеряет внешний
        // guard, dry-run всё равно не смерджит и не тронет дерево раннера.
        if (dry) {
            logFn('💤 DRY: гейт мерджа пропущен — ничего не мерджим и не переключаем ветки.');
            return 'not-merged';
        }
        // M2: checkout с грязью либо упадёт, либо утащит полу-работу между коммитами.
        // #13: ensureClean сообщает только наблюдаемое — об отказе мерджить говорит гейт.
        if (!ensureCleanFn('гейт мерджа')) {
            logFn(`⛔ Гейт: дерево раннера грязное — мердж не выполняется.`);
            return 'not-merged';
        }
        // #127: сбой чтения — не «PR нет». Шов бросает, и гейт отдаёт его своим исходом:
        // строка «PR не найден» отправила бы человека искать PR, который, может, и есть, а
        // неперехваченный бросок ронял бы петлю без пуша. Причина — в `lastForgeStop`.
        let pr: ReturnType<FindOpenPrFn>;
        try {
            pr = findOpenPrFn(phase.branch);
        } catch (e) {
            const why = String((e as Error).message).split('\n')[0];
            lastForgeStop = `открытый PR ветки ${phase.branch} не прочитался у форжа: ${why}`;
            logFn(
                `⛔ Гейт: открытый PR ветки ${phase.branch} не прочитался у форжа: ${why} — мердж отменён.`,
            );
            return 'pr-unreadable';
        }
        if (!pr) {
            logFn(
                `⛔ Гейт: открытый PR ветки ${phase.branch} в main не найден — мердж невозможен.`,
            );
            return 'not-merged';
        }
        lastGatePr = pr.number;
        // #222: hold проверяется ДО blocked — человеческий стоп-кран сильнее любого
        // автоматического вердикта. Функции, снимающей hold, в коде нет вообще (в отличие
        // от removeBlockedLabel) — это структурный барьер, не полагающийся на промпт: убрать
        // метку может только человек через `gh pr edit --remove-label hold`.
        if ((pr.labels || []).some((l) => l.name === 'hold')) {
            logFn(`⛔ Гейт: PR #${pr.number} помечен 'hold' — стоп, снять может только человек.`);
            return 'hold';
        }
        if ((pr.labels || []).some((l) => l.name === 'blocked')) {
            logFn(`⛔ Гейт: PR #${pr.number} помечен 'blocked'.`);
            return 'blocked';
        }
        const gateChecks = gateChecksFor(profileName);
        // Число чеков — для доказательства мерджа: «прошли N из M» при пропусках по fail-open.
        const checksCount = gateChecks.length;
        if (
            !checksGreenFn(phase.branch, pr.number, {
                checks: gateChecks,
                prHeadShaFn,
                onToolFailure: gatePolicy.onToolFailure,
            })
        ) {
            // #66: ветка отстала от main и не подтянулась — свой исход, а не безымянный
            // 'not-merged': человеку нужны файлы встречной правки, а не «мердж не удался».
            // Чини-сессии нет и здесь: конфликт по смыслу петля не разрешает.
            if (getLastMainSyncStopFn()) {
                logFn(
                    `⛔ Гейт: ветка PR #${pr.number} не подтянута к main — мердж не выполняется.`,
                );
                return 'main-conflict';
            }
            // #85: расхождение HEAD — тоже известная причина, а не катч-олл `unknown`.
            if (getLastHeadDivergenceFn()) {
                logFn(
                    `⛔ Гейт: локальный ref ветки PR #${pr.number} разошёлся с головой PR — мердж не выполняется.`,
                );
                return 'head-diverged';
            }
            const redCheck = getLastRedCheckFn();
            if (redCheck) {
                logFn(`⛔ Гейт: чек ${redCheck.name} красный на PR #${pr.number}.`);
                return 'red-checks';
            }
            // Задача 81: сбой инструмента — свой исход, а не 'red-checks' и не безымянный
            // 'not-merged'. Первое отдало бы его чини-сессии, второе — катч-оллу с
            // причиной `unknown`, хотя причина как раз известна.
            const toolFailure = getLastToolFailureFn();
            if (toolFailure) {
                logFn(
                    `⛔ Гейт: чек ${toolFailure.name} упал на инструменте (${toolFailure.why}) на PR #${pr.number} — ` +
                        'это не регрессия, чини-сессии не будет.',
                );
                return 'gate-tool-failure';
            }
            logFn(`⛔ Гейт: не прошёл до чеков (fetch/HEAD/detach) на PR #${pr.number}.`);
            return 'not-merged';
        }
        // Голова, которую ТОЛЬКО ЧТО проверил checksGreen: один опрос шва на круг, а не
        // два (правка по ревью #278). Нужна дважды — как нижняя граница свежести вердикта
        // форжа (#278) и как `--match-head-commit` при мердже (#SiaTz); между этими
        // точками значение не меняется, и читателю не приходится это доказывать.
        const verifiedHead = getVerifiedHeadFn();
        // #269: локальные чеки зелёные — но у площадки СВОЙ чек, и мердж она отвергает
        // (400), пока он красный. Раньше раннер спрашивал только себя: три попытки мерджа
        // через 30 с и стоп «PR оставлен человеку», а причина оставалась в контейнере
        // площадки. Шаг стоит ПОСЛЕ локальных чеков нарочно — красный локальный чек
        // чинится дешевле и не должен ждать двадцать минут; к этому моменту прогон
        // площадки обычно уже отработал параллельно нашему гейту.
        //
        // Шов необязателен: без него шаг пропускается, и мердж идёт ровно как до карточки, —
        // кроме политики `required` (задача 81): там «прочитать CI нечем» мердж не даёт.
        //
        // `ciVerdict` — строка внешнего CI для доказательства мерджа: каждая ветка ниже,
        // разрешившая мердж, обязана её назвать, иначе решение не было бы видно.
        const required = gatePolicy.externalCi === 'required';
        const stopRequired = (why: string): 'forge-unknown' => {
            lastForgeStop = `чек PR #${String(pr.number)}: ${why}`;
            logFn(`⛔ Гейт: ${lastForgeStop} — мердж отменён.`);
            parkFn();
            return 'forge-unknown';
        };
        let ciVerdict: string;
        if (gatePolicy.externalCi === 'disabled') {
            ciVerdict = 'не спрашивался';
            logFn(
                '🚦 Чек площадки: внешний CI выключен (gate.externalCi: disabled) — адаптер чеков не зовём.',
            );
        } else if (!forgeChecksFn) {
            if (required) {
                return stopRequired(
                    'политика required, а у адаптера форжа нет чтения чеков PR — подтвердить прогон нечем',
                );
            }
            ciVerdict = 'не проверен: у адаптера форжа нет чтения чеков';
        } else {
            // #278: свежесть вердикта — форж отдаёт ПОСЛЕДНИЙ прогон workflow, а не прогон
            // именно этой головы, и «на практике успевает» (тайминг локального гейта)
            // барьером не было. Нижняя граница — момент коммита проверенной головы: прогон
            // старше него физически не может быть про этот код. Сбой чтения git — не повод
            // ронять весь мердж-путь (та же логика, что у прочей fail-open диагностики):
            // просто эта конкретная проверка свежести в этом круге не работает.
            let sinceMs: number | undefined;
            if (verifiedHead) {
                try {
                    sinceMs = headCommittedAtFn(verifiedHead);
                } catch (e: unknown) {
                    logFn(
                        `⚠ Не удалось узнать время коммита ${verifiedHead.slice(0, 8)} (${errorText(e)}) — свежесть вердикта площадки в этом круге не проверяется.`,
                    );
                }
            }
            // Задача 81: без нижней границы свежесть не проверить вовсе, и при `required`
            // это стоп ДО похода к форжу — ждать вердикт, который не примем, незачем.
            if (required && sinceMs === undefined) {
                return stopRequired(
                    'политика required, а время коммита проверенной головы неизвестно — свежесть прогона CI не проверить',
                );
            }
            const forge = waitForForgeChecksFn({
                readFn: () => forgeChecksFn(pr.number),
                sleepFn: sleepFn,
                nowFn,
                logFn,
                ...(healedForgeRunId ? { healedRunId: healedForgeRunId } : {}),
                ...(sinceMs !== undefined ? { sinceMs } : {}),
                ...(required ? { requireDated: true } : {}),
            });
            if (forge.kind === 'timeout' || forge.kind === 'error') {
                // Сбой инструмента на стороне CI: вердикта нет. `fail-open` пропускает его
                // только при `optional` — для `required` «не прочиталось» и есть «не
                // подтверждено». И только исход `error` (сбой ЧТЕНИЯ): `timeout` — не сбой
                // инструмента, а «площадка не завела прогон новее пуша», при том что старый
                // прогон мог быть красным (он отфильтрован как устаревший, а не как
                // зелёный). Под fail-open он превратился бы в «медленный CI = мердж».
                if (
                    forge.kind === 'error' &&
                    !required &&
                    gatePolicy.onToolFailure === 'fail-open'
                ) {
                    ciVerdict = `сбой инструмента (${forge.detail}), пропущен по gate.onToolFailure: fail-open`;
                    logFn(`⚠ Гейт: чек PR #${String(pr.number)} у форжа — ${ciVerdict}.`);
                } else {
                    lastForgeStop = `чек PR #${String(pr.number)} у форжа не дал вердикта (${forge.detail})`;
                    logFn(`⛔ Гейт: ${lastForgeStop} — мердж отменён, PR оставлен человеку.`);
                    parkFn();
                    return 'forge-unknown';
                }
            } else if (forge.kind === 'absent') {
                // Очередь площадка отдаёт ждущим прогоном (`created`), а не `none`: так
                // видно по логу петли потребителя. Значит, `none` дольше льготы — прогона
                // действительно нет, и при `required` подтверждать мердж нечем.
                if (required) {
                    return stopRequired(
                        'политика required, а за льготный срок у PR не завелось ни одного прогона CI',
                    );
                }
                ciVerdict = 'прогонов нет, мерджим без ожидания';
            } else if (forge.kind === 'green') {
                ciVerdict = 'зелёный';
            } else {
                // Диагноз читается ОТДЕЛЬНЫМ вызовом и его отсутствие не приговор коду:
                // «прогон красный, а какой куб — форж не сказал» лечить вслепую нельзя,
                // это стоп человеку, но и молчать о нём нельзя.
                let failure: ForgeCheckFailure | null = null;
                try {
                    failure = forgeDiagnosisFn ? forgeDiagnosisFn(forge.run) : null;
                } catch (e: unknown) {
                    logFn(
                        `⚠ Детали красного прогона ${forge.run.runId} прочитать не удалось: ${errorText(e)}`,
                    );
                }
                if (!failure) {
                    lastForgeStop =
                        `чек PR #${String(pr.number)} красный (прогон ${forge.run.runId}), ` +
                        'но упавший куб не назван — чинить вслепую нельзя';
                    logFn(`⛔ Гейт: ${lastForgeStop}, PR оставлен человеку.`);
                    parkFn();
                    return 'forge-unknown';
                }
                const kind = classifyForgeFailureFn(failure.log, forge.run.rawStatus);
                lastForgeRedCheck = { ...failure, kind };
                if (kind !== 'code') {
                    logFn(
                        kind === 'aborted'
                            ? `⛔ Гейт: прогон ${failure.runId} ПРЕРВАН (статус «${forge.run.rawStatus}») ` +
                                  'на кубе ' +
                                  `${failure.cube} — это не отказ кода, лечить нечего.`
                            : `⛔ Гейт: куб ${failure.cube} прогона ${failure.runId} упал по ОТКАЗУ СРЕДЫ ` +
                                  '(нет ни одного проваленного кейса, есть сигнатура убитого воркера/OOM). ' +
                                  'Кодом это не чинится — сессия лечения принялась бы править здоровые тесты.',
                    );
                    parkFn();
                    return 'forge-env';
                }
                logFn(
                    `⛔ Гейт: куб ${failure.cube} прогона ${failure.runId} красный на площадке при зелёном локальном гейте.`,
                );
                parkFn();
                return 'forge-red';
            }
            // 'green', 'absent' при optional и пропущенный по fail-open сбой — мердж разрешён.
        }
        // Доказательство мерджа (задача 81): одна строка, в которой видно, на чём мердж
        // держится, — голова, локальный гейт, политика и исход внешнего CI, решение о
        // сбоях инструмента. Пишется ДО вызова мерджа: после — ему уже нечего доказывать.
        const skips = getToolFailureSkipsFn();
        lastMergeProof =
            `PR #${String(pr.number)}, голова ${verifiedHead ? verifiedHead.slice(0, 8) : 'не зафиксирована'}: ` +
            (skips.length > 0
                ? `локальный гейт: прошли ${String(checksCount - skips.length)} из ${String(checksCount)}, ` +
                  `пропущены по fail-open: ${skips.map((k) => `${k.name} — ${k.why}`).join('; ')}`
                : 'локальный гейт зелёный') +
            `; внешний CI — политика ${gatePolicy.externalCi}, ${ciVerdict}` +
            `; сбой инструмента — ${gatePolicy.onToolFailure}.`;
        logFn(`🧾 Доказательство мерджа: ${lastMergeProof}`);
        // H4: merge и пост-мердж шаги — РАЗНЫЕ try. Упал сам merge → PR цел, честное
        // «не удался». Merge прошёл, а обновление дерева раннера упало → это НЕ «мердж
        // не удался», а «смерджено, локалка отстала»: другой статус, другое восстановление.
        //
        // Ретрай мутации (боевой случай 2026-07-19): локальный прокси оборвал соединение
        // с GitHub API на зелёном гейте, и ночь встала из-за одного сетевого чиха.
        // Мутации вслепую не ретраим — но здесь между попытками СВЕРЯЕМСЯ phaseMerged():
        // если первый вызов на самом деле прошёл (упал только ответ) — задвоения нет.
        // #SiaTz: --match-head-commit закрывает TOCTOU-окно между прогоном чеков и мерджем.
        // checksGreen тестировал ТОЧНЫЙ sha PR-головы; за минуты чеков гейта в ветку могли
        // допушить (недобитая кодер-сессия, человек с другой машины) — без этой привязки gh
        // смерджил бы новую, НЕ прогнанную голову. Сервер отвергнет мердж, если голова уехала.
        // Пусто (мок checksGreen в тестах не выставил sha) → мерджим как раньше, без привязки.
        // Мердж — через примитив форжа mergePr (шов TaskSourceAdapter, #369): argv (#193),
        // --match-head-commit при валидном sha (#SiaTz). Ретрай и сверку phaseMerged держит
        // ЭТА функция (оркестрация), не примитив. runArgvFn прокинут насквозь — тесты видят
        // тот же вызов `gh pr merge …`, что и раньше.
        // #53-ревью: ОДИН вопрос «мердж дошёл?» — одно терпение. Раньше сверка внутри
        // ретрая была мгновенной (один вызов), а после успешного POST — терпеливой (6×5с).
        // На асинхронном форже это давало худший из исходов: ответ оборвала сеть, операция
        // в очереди честно отвечает «не вижу», и ретрай ПОВТОРЯЛ принятый мердж — то самое
        // задвоение, которое эта же правка объявляет недопустимым. Теперь обе точки зовут
        // один помощник: сбой чтения — сгоревшая попытка, а не ответ «не смерджено».
        const mergeConfirmed = (): boolean => {
            for (let attempt = 1; attempt <= mergeConfirmAttempts; attempt++) {
                try {
                    if (phaseMergedFn(phase)) return true;
                } catch (e: unknown) {
                    logFn(
                        `⚠ Подтверждение мерджа PR #${pr.number}: форж не ответил (${String((e as Error).message).split('\n')[0]}).`,
                    );
                }
                if (attempt < mergeConfirmAttempts) sleepFn(mergeConfirmDelayMs);
            }
            return false;
        };

        // #47: повтор зависит от КЛАССА отказа (merge-retry.ts). Транзиент форжа (5xx,
        // таймаут, обрыв) — растущая пауза до предела по времени; отказ по существу —
        // стоп сразу, повторять нечего; нераспознанный — один повтор, как до #47. Отсчёт
        // предела — от первого отказа: он меряет терпение к сбою площадки, а не длину гейта.
        // #88: метка начатого мерджа ложится ДО первого POST и не снимается здесь: принятый
        // форжем мердж — неизвестный исход до подтверждения, и рестарт, убитый в этом окне,
        // не должен ни повторить POST вслепую, ни счесть фазу смердженной. Запись бросила —
        // мерджа нет: без метки POST был бы ровно тем слепым окном, которое она закрывает.
        onMergeStartFn(pr.number, verifiedHead);
        let mergedOk = false;
        let failedSinceMs: number | null = null;
        // Один повтор нераспознанного — по ЧИСЛУ его повторов, а не по номеру попытки:
        // transient → unknown иначе встал бы стопом «не распознан и после повтора», хотя
        // нераспознанный отказ не повторялся ни разу.
        let unknownRetried = false;
        for (let attempt = 1; !mergedOk; attempt++) {
            try {
                mergePrFn(pr.number, verifiedHead, { runArgvFn });
                mergedOk = true;
            } catch (e: unknown) {
                try {
                    if (mergeConfirmed()) {
                        // Безобидные причины ошибки при уже влитом PR: --delete-branch не
                        // успел/не смог удалить локальный ref ветки, который для инварианта
                        // H3 создал сам раннер (не дерево человека, #387/#SiaUf); либо сеть
                        // оборвала ответ на success. Удаление ref ниже подчищает первую причину
                        // сам раннер, независимо от того, справился ли с ней --delete-branch.
                        logFn(
                            `⚠ мердж PR #${pr.number} вернул ошибку, но PR уже влит (частая безобидная причина — ` +
                                `--delete-branch не успел удалить локальный ref ветки, созданный самим раннером для сверки H3) — продолжаем.`,
                        );
                        mergedOk = true;
                        break;
                    }
                } catch {}
                const message = String((e as Error).message);
                const why = mergeFailureLine(message);
                const kind = classifyMergeFailure(message);
                failedSinceMs ??= nowFn();
                const leftMs = mergeRetryMaxMs - (nowFn() - failedSinceMs);
                const pauseMs =
                    kind === 'transient'
                        ? Math.min(mergeRetryPauseMs(attempt), leftMs)
                        : kind === 'unknown' && !unknownRetried
                          ? MERGE_RETRY_BASE_MS
                          : 0;
                if (pauseMs > 0) {
                    if (kind === 'unknown') unknownRetried = true;
                    logFn(
                        `⚠ Мердж PR #${pr.number} не удался (${why}) — ` +
                            (kind === 'transient'
                                ? `транзиентный отказ форжа, повтор через ${Math.round(pauseMs / 1000)}с ` +
                                  `(попытка ${attempt}, до предела ${Math.round(Math.max(leftMs, 0) / 1000)}с).`
                                : `отказ не распознан, единственный повтор через ${Math.round(pauseMs / 1000)}с.`),
                    );
                    sleepFn(pauseMs);
                    continue;
                }
                logFn(
                    `⛔ Гейт: мердж PR #${pr.number} не удался (${message}) — ` +
                        describeMergeFailure(kind, {
                            attempts: attempt,
                            retryMaxMs: mergeRetryMaxMs,
                        }) +
                        (kind === 'transient' ? ', стоп fail-closed' : '') +
                        ' — оставлен человеку.',
                );
                lastMergeFailure = {
                    pr: pr.number,
                    kind,
                    line: why,
                    attempts: attempt,
                    retryMaxMs: mergeRetryMaxMs,
                };
                if (kind === 'refusal' && attempt === 1) onMergeSettledFn();
                parkFn();
                return 'not-merged';
            }
        }
        // #53: форж ПРИНЯЛ мердж — это ещё не «смерджено». У площадки операция асинхронная
        // (`scheduled` + operation_id), и `git fetch origin main` сразу после ответа может
        // прийти на ДО-мерджевый main. Спрашиваем сам форж, пока он не подтвердит.
        //
        // Fail-closed и БЕЗ повтора мерджа: повторять принятую операцию нельзя (задвоение),
        // продолжать по неподтверждённой — тоже (следующая фаза легла бы мимо влитого кода).
        // Поэтому отдельный исход и стоп: разбирает человек, а рестарт увидит фазу
        // смердженной веткой phaseMerged, если операция всё-таки дошла.
        if (!mergeConfirmed()) {
            logFn(
                `⛔ Гейт: мердж PR #${pr.number} принят форжем, но за ${mergeConfirmAttempts} попыток не подтверждён — ` +
                    `дерево раннера НЕ обновляем и следующую фазу не начинаем. Проверь PR руками: если он влит, ` +
                    `перезапуск увидит фазу смердженной и продолжит сам.`,
            );
            parkFn();
            return 'merge-unconfirmed';
        }
        // #387: PR подтверждённо смерджен (mergedOk) — локальный ref ветки фазы больше
        // не нужен, чистим его сами, не полагаясь на --delete-branch. Fail-open в два слоя:
        // сама deleteLocalBranchRef глотает ошибку и логирует, а try/catch здесь — defense
        // in depth на случай инжектированной в тестах/дефолт заменённой реализации, которая
        // этот контракт не соблюла. Чистка не должна ронять цикл ни при каких условиях.
        try {
            deleteLocalBranchRefFn(phase.branch, { shFn, runArgvFn, logFn });
        } catch (e: unknown) {
            logFn(
                `⚠ Удаление локального ref ветки ${phase.branch} после мерджа упало (${(e as Error).message}) — не критично, продолжаем.`,
            );
        }
        // #77: локальный main не трогаем ВООБЩЕ — его ref держит дерево человека, git не
        // даст ни занять его вторым worktree, ни обновить из-под чужого checkout.
        // «Обновлённый main» раннера = свежий origin/main + detach на нём: следующая
        // фаза стартует ровно от этого коммита.
        // Задача 28: дерево ПОТРЕБИТЕЛЯ подтягиваем ЗДЕСЬ — после подтверждённого мерджа и
        // ДО обновления дерева раннера. Порядок содержателен: своё дерево может не
        // обновиться (транзиентный git-сбой), и тогда мы уходим в `merged-local-stale`
        // мимо всего, что ниже. Фаза при этом влита, и дерево человека к исправности
        // локального git раннера отношения не имеет — оставлять его старым из-за чужого
        // сбоя значило бы вернуть ровно ту дыру, ради которой задача заводилась
        // (ревью, 1-й проход). Бросить этот вызов не может по контракту.
        updateConsumerTreeAfterMerge(runArgvFn);
        try {
            updateRunnerTreeToOriginMain(runArgvFn);
        } catch (e: unknown) {
            logFn(
                `⚠ PR #${pr.number} СМЕРДЖЕН, но дерево раннера не обновилось (${(e as Error).message}). ` +
                    `Почини руками в дереве раннера: ${RUNNER_TREE_FIX_HINT} — ` +
                    `затем перезапусти loop (рестарт увидит фазу смердженной и продолжит со следующей).`,
            );
            return 'merged-local-stale';
        }
        logFn(`✅ PR #${pr.number} смерджен (squash), дерево раннера на свежем origin/main.`);
        return 'merged';
    }

    return {
        gateChecksFor,
        checksGreen,
        tryMergePhase,
        deleteLocalBranchRef,
        // Наружу ради тестов ТЕЛА (правка по ревью #278): параметры `shFn`/`shqFn` заводились
        // ради подмены, но подменить их было неоткуда — функция не отдавалась из фабрики,
        // и тесты гейта проверяли только проводку через `headCommittedAtFn`. Тот же приём,
        // что у соседнего `deleteLocalBranchRef`.
        headCommittedAt,
        // Геттеры module-level state гейта — наружу для runLoop/tryMergePhase (дефолтные
        // депы) и для ассертов тестов (то же, что раньше отдавал module.exports ralph.js).
        getLastRedCheck: (): RedCheck | null => lastRedCheck,
        getVerifiedHead: (): string | null => lastVerifiedHead,
        getLastGatePr: (): number | null => lastGatePr,
        getLastForgeRedCheck: (): ForgeRedCheck | null => lastForgeRedCheck,
        getLastForgeStop: (): string | null => lastForgeStop,
        getLastMergeFailure: (): MergeFailure | null => lastMergeFailure,
        getLastToolFailure: (): ToolFailure | null => lastToolFailure,
        getToolFailureSkips: (): ToolFailureSkip[] => lastToolSkips,
        getLastMergeProof: (): string | null => lastMergeProof,
        getLastMainSyncStop: (): typeof lastMainSyncStop => lastMainSyncStop,
        getLastHeadDivergence: (): typeof lastHeadDivergence => lastHeadDivergence,
    };
}
