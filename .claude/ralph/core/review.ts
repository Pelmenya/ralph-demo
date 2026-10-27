// Модуль ревью фазы (#363, трек «Фреймворк ralph», фаза 3). Вынесен из ralph.js по
// тому же приёму, что gate.ts (#362) и worktree.ts/state-lock.ts/tunnel-check.ts
// (фаза 2): вся логика выбора и планки модели ревью собрана одним связным модулем, а
// ralph.js пользуется только его API. Поведение НЕ меняется — это извлечение, не
// переписывание: роутинг модели по метке/зоне риска, фолбэк, планка повторного ревью
// (#217/#221/#223) и вызов журнала находок — всё как было.
//
// Что собрано здесь:
// - pickReviewModel — выбор модели ревью: эскалация по метке (review.escalateOn) и по
//   зоне риска диффа (review.escalateOnPaths), деградация на default при сбоях (#130);
// - pickReviewFallbackModel — отдельный от общего cfg.fallbackModel фолбэк ревью (#221);
// - REVIEW_MODEL_STRENGTH/reviewModelRank/strongerReviewModel — планка модели повторного
//   ревью (#217): повторное ревью не судится моделью слабее поставившей блок;
// - assertKnownReviewModels — fail-closed на старте: модели ревью конфига известны планке,
//   фолбэк не слабее default (#221/#223);
// - recordReviewFindings — best-effort вызов журнала находок (#169) сразу после мерджа.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
//
// Фабрика, а не standalone-экспорты (как в gate.ts): pickReviewModel/recordReviewFindings
// не чистые — им нужен контекст ralph.js (config, ghJson, sh/shArgv/shq, log, fail,
// isPlainObject и уже определённые помощники matchRiskPaths/phaseDiffFiles). Фабрика
// захватывает этот контекст один раз, а возвращённые функции сохраняют ПОКАЗАТЕЛЬНУЮ DI:
// каждая по-прежнему принимает свои коллабораторы (cfg/ghJsonFn/shFn/…) параметром — ровно
// так их зовут существующие тесты (review.test.ts) через ре-экспорт из ralph.js.
//
// getConfig, а не захваченный config: module-level `config` в ralph.js заполняется в main()
// ПОСЛЕ загрузки этого модуля (createReviewModule зовётся на верхнем уровне), поэтому дефолт
// `cfg = config` обязан читать ЖИВОЙ config в момент вызова, а не снимок undefined с момента
// сборки фабрики. Ленивый геттас закрывает этот разрыв (тот же приём, что state-lock.ts).

// Тип комментария — из контракта швов, а не свой: счёт находок читает ровно то, что шов
// отдаёт, и вторая копия формы разъехалась бы с ним молча. Импорт только типовой —
// зависимость идёт «ядро → абстракция», как ей и положено.
import type { ReviewComment } from '../adapters/adapters.ts';
import type { TConsumerScriptsResolved } from './config-profile.ts';

type ExecOpts = { env?: NodeJS.ProcessEnv; input?: string };
type ShFn = (cmd: string, opts?: ExecOpts) => string;
type ShArgvFn = (file: string, args: string[], opts?: ExecOpts) => string;
type ShqFn = (value: unknown) => string;
type LogFn = (msg: string) => void;
type GhJsonFn = (cmd: string, attempts?: number) => unknown;
// fail() боевой уходит в process.exit(1); тестовый failFn может вернуть значение или
// бросить — поэтому возврат unknown, а не never (assertKnownReviewModels пробрасывает
// результат мягкого failFn наверх, как было в ralph.js).
type FailFn = (msg: string) => unknown;
type IsPlainObjectFn = (v: unknown) => v is Record<string, unknown>;
type MatchRiskPathsFn = (files: unknown, patterns: unknown) => string | null;
// #37: метки ВСЕХ задач фазы (любого статуса) — плоским списком имён. Приходит из шва
// `TaskSourceAdapter.listMilestoneLabels`, а не из `gh` в ядре: «какие метки у задач
// фазы» — вопрос к трекеру, и знать, чем он отвечает, ядру не положено.
type MilestoneLabelsFn = (milestone: string) => string[];
// #37: комментарии PR — тоже из шва (`TaskSourceAdapter.listPullRequestComments`). Раньше
// за ними ходил сам счётчик находок, зная и форж, и форму его ответа; теперь он получает
// готовую ленту и остаётся чистой считалкой severity.
type PrCommentsFn = (prNumber: number) => ReviewComment[];

type PhaseDiffFilesFn = (
    branch: string,
    opts?: { shFn?: ShFn; runArgvFn?: ShArgvFn; logFn?: LogFn },
) => string[] | null;

type ReviewConfig = {
    default?: string;
    escalated?: string;
    fallback?: string;
    // #625: модель независимого арбитра (последняя ступень лестницы ревью правок).
    arbiter?: string;
    escalateOn?: unknown;
    escalateOnPaths?: unknown;
    // Порядок сил моделей по возрастанию. Не задан — DEFAULT_REVIEW_MODEL_STRENGTH.
    // unknown, а не string[]: значение приходит из чужого JSON и валидируется на старте.
    modelStrength?: unknown;
};
// Конфиг раннера в части, интересной ревью. Легаси-поле reviewModel — прежний плоский
// ключ до появления блока review (pickReviewModel деградирует на него).
type ReviewCfg = {
    review?: ReviewConfig;
    reviewModel?: string;
    // Скрипты ПОТРЕБИТЕЛЯ, которые зовёт ядро. Путь приходит из конфига, а не зашит в код:
    // в каноне этих файлов нет вовсе, и раньше ядро молча требовало, чтобы у потребителя
    // лежал файл с таким именем в таком месте (канон, задача 23). Читается РЕЗОЛВНУТАЯ
    // секция (`consumerScriptsResolved`), а не сырая: относительный путь означает «от места
    // запуска», а место запуска у петли меняется вместе с worktree фазы.
    consumerScriptsResolved?: TConsumerScriptsResolved | null;
};

// Фаза в форме, которую хранит config.phases: recordReviewFindings берёт из неё milestone.
type Phase = { milestone: string };

export type ReviewEnv = {
    getConfig: () => ReviewCfg;
    ghJson: GhJsonFn;
    sh: ShFn;
    shArgv: ShArgvFn;
    shq: ShqFn;
    log: LogFn;
    fail: FailFn;
    isPlainObject: IsPlainObjectFn;
    matchRiskPaths: MatchRiskPathsFn;
    phaseDiffFiles: PhaseDiffFilesFn;
    milestoneLabels: MilestoneLabelsFn;
    prComments: PrCommentsFn;
};

// Задача 78: проход ревью засчитывается по ВЕРДИКТУ, а не по коду выхода сессии. 16.10
// ревью легло на прокси моделей, `claude -p` вышел с кодом 0, не оставив ни одного
// намерения, — и сессия правок получила ноль замечаний, гейт позеленел, фаза уехала в main.
// «Ноль намерений» и «замечаний нет» должны различаться структурно: вердикт — это либо
// `pr-block`, либо сводка прохода (`pr-comment` без якоря), которую промпт ревью требует
// всегда. Находки с якорем без сводки вердиктом не считаются: проход, оборванный на
// середине, выглядит ровно так. Текст сводки не разбирается — барьер держит факт записи.
export type TReviewVerdict = 'pass' | 'block';

export function reviewVerdict(
    findings: readonly { comment: string; anchor?: unknown }[],
    blocked: boolean,
): TReviewVerdict | null {
    if (blocked) return 'block';
    return findings.some((f) => !f.anchor && f.comment.trim() !== '') ? 'pass' : null;
}

export function createReviewModule(env: ReviewEnv) {
    const {
        getConfig,
        ghJson,
        sh,
        shArgv,
        shq,
        log,
        fail,
        isPlainObject,
        matchRiskPaths,
        phaseDiffFiles,
        milestoneLabels,
        prComments,
    } = env;

    // Модель ревью фазы. Дефолт — review.default (opus).
    //
    // #130: эскалация решается по ЦЕНЕ ОШИБКИ, а не по сложности написания. Раньше
    // триггером была метка complexity:expert — но это свойство issue («тяжело писать»),
    // а ревью должно усиливаться там, где ошибка дорого стоит: деплой (мердж в main
    // катит прод автоматически), права доступа Payload, сам раннер (автономный агент
    // с bypassPermissions). Метки как триггер сохранены для обратной совместимости,
    // но в конфиге по умолчанию пусты.
    //
    // Ошибка получения ДИФФА — не фатальна: ревьюим дефолтной моделью (полноценное ревью
    // плюс гейт мерджа впереди; fail-closed стоп тут дал бы ложные ночные простои). А вот
    // ошибка чтения МЕТОК фазы с #37 ведёт к эскалации, а не к деградации — см. ниже.
    function pickReviewModel(
        milestone: string,
        branch: string,
        {
            cfg = getConfig(),
            ghJsonFn = ghJson,
            shFn = sh,
            runArgvFn = shArgv,
            logFn = log,
            milestoneLabelsFn = milestoneLabels,
            files: known,
        }: {
            cfg?: ReviewCfg;
            ghJsonFn?: GhJsonFn;
            shFn?: ShFn;
            runArgvFn?: ShArgvFn;
            logFn?: LogFn;
            milestoneLabelsFn?: MilestoneLabelsFn;
            files?: string[] | null;
        } = {},
    ): string | undefined {
        const review = cfg.review;
        if (!review) return cfg.reviewModel; // легаси-конфиг без блока review

        // Эскалация без заданной escalated-модели вернула бы undefined, а runLoop
        // трактует «нет модели» как «ревью за супервизором» и пропускает ревью ЦЕЛИКОМ
        // — fail-open ровно на самых опасных фазах (находка ревью PR #132). Поэтому
        // деградируем на default: полноценное ревью, просто не усиленное.
        const escalatedModel = () => {
            if (review.escalated) return review.escalated;
            logFn(
                '⚠ review.escalated не задан — эскалация невозможна, ревьюю моделью по умолчанию.',
            );
            return review.default;
        };

        const escalateOn = Array.isArray(review.escalateOn) ? review.escalateOn : [];
        if (escalateOn.length) {
            let labels: string[];
            try {
                labels = milestoneLabelsFn(milestone);
            } catch (e) {
                // #37: НЕ деградируем на default. «Не смогли узнать, есть ли в фазе
                // сложная задача» — это не «сложных задач нет», а прежнее поведение
                // отдавало ровно такую подмену: сбой чтения тихо ослаблял ревью там, где
                // строгость и нужна. Цена ошибки в сторону эскалации — минуты сильной
                // модели; в другую сторону — непойманный дефект в смердженной фазе.
                logFn(
                    `⚠ Не смог прочитать метки задач фазы (${(e as Error).message}) — эскалирую ревью: ` +
                        'неизвестность считаем зоной риска.',
                );
                return escalatedModel();
            }
            if (labels.some((name) => escalateOn.includes(name))) {
                logFn('🔺 Ревью эскалировано: в фазе есть issue с меткой из review.escalateOn.');
                return escalatedModel();
            }
        }

        // files приходит извне, когда вызывающий уже собрал дифф (runLoop собирает его
        // один раз на выбор модели И на контекст ревью — иначе fetch+diff шли дважды
        // подряд, находка ревью #135).
        const files =
            known !== undefined ? known : phaseDiffFiles(branch, { shFn, runArgvFn, logFn });
        const hit = files && matchRiskPaths(files, review.escalateOnPaths);
        if (hit) {
            logFn(`🔺 Ревью эскалировано: дифф фазы трогает зону риска (${hit}).`);
            return escalatedModel();
        }
        return review.default;
    }

    // ── Фолбэк модели ревью (#221) ────────────────────────────────────────────
    // Раньше (M8) ревью-сессии шли с noFallback:true — при overload/недоступности
    // модели сессия честно падала, и сдача фазы стояла до перезапуска. С возвратом
    // fallbackModel на opus (#202) это стало убытком: honest-падение останавливало
    // фазу, хотя рядом был живой и качественный ревьюер. review.fallback — отдельный
    // от общего cfg.fallbackModel ключ: общий fallback теперь НИКАК не влияет на
    // ревью (см. buildClaudeArgs — опции.fallbackModel всегда передаётся явно).
    //
    // Дефолт при отсутствии ключа — review.default (см. #221): ревью без
    // сконфигурированного фолбэка не деградирует НИЖЕ своей обычной планки, а не
    // остаётся вовсе без фолбэка. Явное 'none' — осознанный отказ от фолбэка
    // (тогда падение при overload останется прежним fail-closed стопом).
    // #221: явное review.fallback: 'none' — ОСОЗНАННЫЙ отказ от фолбэка (honest-стоп при
    // недоступности модели, как было при M8). Возвращаем 'none' как есть, а не null: иначе
    // сигнал отказа терялся бы, и strongerReviewModel(null, floor) в повторном ревью поднял
    // бы фолбэк до планки — то есть 'none' всё равно ушёл бы с --fallback-model <floor>,
    // прямо противореча контракту (CLAUDE.md инв. 6). buildClaudeArgs строку 'none' гасит
    // (фолбэк не передаётся). Отсутствие ключа — другой случай: дефолт на review.default.
    function pickReviewFallbackModel(cfg: ReviewCfg = getConfig()): string | null {
        const review = cfg.review;
        if (!isPlainObject(review)) return null;
        const fb = review.fallback;
        if (fb === undefined || fb === null) return review.default ?? null;
        if (fb === 'none') return 'none';
        return fb;
    }

    // ── Планка модели повторного ревью (#217) ─────────────────────────────────
    // Порядок силы моделей ревью: чем правее в списке — тем сильнее. Планка нужна
    // барьеру #217: повторное ревью после разбора blocked НЕ должно судиться моделью
    // слабее той, что поставила блок, — иначе эскалацию обходят удешевлением ревьюера
    // (взять haiku после блока от fable). Список закрыт (сравниваем не любую строку):
    // неизвестная модель = ранг -1, то есть слабее любой известной.
    //
    // Ранг -1 корректен только когда неизвестен КАНДИДАТ (он проиграет известной планке).
    // Если же неизвестна модель, ПОСТАВИВШАЯ блок (floor), rank -1 инвертирует барьер:
    // floor проиграл бы любому известному кандидату, и блок сильнейшей судил бы haiku
    // (#223). Поэтому дрейф закрыт на входе: assertKnownReviewModels на валидации конфига
    // требует, чтобы review.default/escalated входили в этот список — сюда неизвестная
    // модель-ревьюер попасть уже не может (новый id модели в конфиге = fail на старте, а
    // не тихая инверсия планки в момент разбора).
    // ВСТРОЕННЫЙ ДЕФОЛТ, а не единственный источник правды: список моделей — данные,
    // которые устаревают с каждым релизом, и держать их в коде значит требовать правки
    // ядра от каждого проекта (грабля 3 журнала переносимости). Проект задаёт свой
    // порядок в `review.modelStrength`; барьер от этого не слабеет — список по-прежнему
    // закрытый, меняется лишь его происхождение.
    const DEFAULT_REVIEW_MODEL_STRENGTH = [
        'claude-haiku-4-5-20251001',
        'claude-sonnet-5',
        'claude-opus-4-8',
        'claude-fable-5',
    ];

    // Действующий порядок сил: из конфига либо встроенный дефолт. Форму валидирует
    // assertReviewModelStrength — сюда значение приходит уже проверенным на старте, но
    // функция обязана быть безопасной и до валидации (её зовёт сам валидатор).
    function reviewModelStrength(cfg: ReviewCfg = getConfig()): string[] {
        // Опциональная цепочка обязательна: до main() module-level config пуст, а планку
        // спрашивают и раньше (сценарные прогоны, монитор). Раньше вопрос не вставал —
        // список был константой и конфига не касался.
        const raw = cfg?.review?.modelStrength;
        return Array.isArray(raw) && raw.length > 0
            ? (raw as string[])
            : DEFAULT_REVIEW_MODEL_STRENGTH;
    }

    // Ранг силы модели ревью (индекс в действующем списке). Неизвестная/пустая → -1.
    // cfg параметром, а не только через getConfig(): валидация конфига профиля идёт ДО
    // того, как этот конфиг станет текущим, и ранг там обязан считаться по проверяемому
    // списку, иначе профиль сверялся бы с чужой планкой.
    function reviewModelRank(model: unknown, cfg?: ReviewCfg): number {
        return reviewModelStrength(cfg).indexOf(model as string);
    }

    // Fail-closed на форме списка. Тихий откат к дефолту здесь был бы худшим исходом:
    // автор конфига заказал одну планку, а барьер судил бы по другой — и заметить это
    // можно было бы только по итогам ревью, которое уже случилось (инвариант №1).
    function assertReviewModelStrength(
        cfg: ReviewCfg,
        profileName: string,
        failFn: FailFn,
    ): unknown {
        const raw = cfg.review?.modelStrength;
        if (raw === undefined || raw === null) return true; // не задан — дефолт
        const where = `ralph.config.json (профиль "${profileName}"): review.modelStrength`;
        if (!Array.isArray(raw) || raw.length === 0) {
            return failFn(`${where} должен быть непустым массивом моделей от слабой к сильной.`);
        }
        const seen = new Set<string>();
        for (const item of raw) {
            if (typeof item !== 'string' || item.trim() === '') {
                return failFn(
                    `${where}: каждый элемент — непустая строка с идентификатором модели.`,
                );
            }
            if (seen.has(item)) {
                return failFn(
                    `${where}: "${item}" встречается дважды — ранг модели стал бы неоднозначным.`,
                );
            }
            seen.add(item);
        }
        return true;
    }

    // #223: fail-closed на старте — все модели ревью конфига обязаны быть известны планке.
    // В reviewModelRank/strongerReviewModel уходят только review.default и review.escalated
    // (pickReviewModel других источников не имеет; modelRouting.* — КОДЕРСКИЕ модели, во
    // floor не попадают, поэтому их здесь не проверяем — иначе честный coder-only id ложно
    // красил бы старт). Значение 'none' и отсутствие ключа допустимы (review отключён/дефолт).
    // review.fallback (#221) проверяется тем же циклом (тот же класс дрейфа: незнакомая
    // модель фолбэка попала бы в pickReviewFallbackModel так же слепо, как раньше
    // незнакомый ревьюер — в reviewModelRank), плюс отдельно — что фолбэк не слабее
    // review.default (иначе overload тихо ослаблял бы ревью ниже базовой планки, а не
    // просто заменял модель на равнозначную/сильнее).
    // Возврат: true — все известны; иначе результат failFn (мягкий failFn пробрасываем наверх).
    function assertKnownReviewModels(
        cfg: { review?: unknown },
        profileName: string,
        failFn: FailFn = fail,
    ): unknown {
        const review = cfg.review;
        if (!isPlainObject(review)) return true; // review не задан — планке нечего проверять

        // Форма списка — ПЕРВОЙ: дальше по нему считаются ранги, и кривой список дал бы
        // не отказ, а бессмысленное сравнение.
        const strengthCheck = assertReviewModelStrength(cfg as ReviewCfg, profileName, failFn);
        if (strengthCheck !== true) return strengthCheck;

        const strength = reviewModelStrength(cfg as ReviewCfg);
        // #625: `arbiter` проверяется тем же циклом и по той же причине, что остальные:
        // незнакомая модель арбитра получила бы ранг -1, и планка reviewModelFloor
        // «подняла» бы его до модели, поставившей блок, — то есть последняя ступень
        // лестницы молча стала бы тем же ревьюером, от согласия которого она и спасает.
        for (const key of ['default', 'escalated', 'fallback', 'arbiter'] as const) {
            const model = review[key];
            if (model === undefined || model === null || model === 'none') continue;
            if (reviewModelRank(model, cfg as ReviewCfg) === -1) {
                return failFn(
                    `ralph.config.json (профиль "${profileName}"): review.${key} = "${model}" не входит в REVIEW_MODEL_STRENGTH. ` +
                        `Планка повторного ревью (#217) сравнивает модели по этому списку; незнакомая модель-ревьюер инвертировала бы барьер (блок сильнейшей судила бы слабейшая). ` +
                        `Добавь модель в review.modelStrength своего конфига или поправь конфиг. Известные: ${strength.join(', ')}.`,
                );
            }
        }
        // #221: фолбэк ревью не может ослаблять ревью ниже review.default. Без этой
        // проверки overload тихо перевёл бы ревью на модель слабее базовой — ровно
        // та деградация, от которой M8 защищал жёстким noFallback.
        const fallback = review.fallback;
        const hasFallback = fallback !== undefined && fallback !== null && fallback !== 'none';
        if (
            hasFallback &&
            review.default &&
            reviewModelRank(fallback, cfg as ReviewCfg) <
                reviewModelRank(review.default, cfg as ReviewCfg)
        ) {
            return failFn(
                `ralph.config.json (профиль "${profileName}"): review.fallback = "${fallback}" слабее review.default = "${review.default}". ` +
                    `Фолбэк ревью (#221) не может ослаблять ревью ниже базовой планки — иначе overload тихо подменяет ревьюера на более слабого. ` +
                    `Известные модели по рангу: ${strength.join(', ')}.`,
            );
        }
        return true;
    }

    // Сильнейшая из двух моделей ревью — это и есть операция «поднять планку». null /
    // undefined / 'none' у любого аргумента игнорируется (берём вторую); обе пусты → null.
    // Неизвестные строки сравниваются по rank (-1): известная всегда победит неизвестную.
    function strongerReviewModel(a: unknown, b: unknown): string | null {
        const norm = (m: unknown) => (m && m !== 'none' ? (m as string) : null);
        const x = norm(a);
        const y = norm(b);
        if (!x) return y;
        if (!y) return x;
        return reviewModelRank(x) >= reviewModelRank(y) ? x : y;
    }

    // #169: журнал находок ревью петли по severity — «ревью слабеет/крепнет» становится
    // числом (PRD `docs/ralph-reliability/prd.md` п.4). Зовётся сразу после мерджа, тем же
    // приёмом, что closeMilestoneByTitle/syncProjectBoard: best-effort, лог вместо throw —
    // косметика наблюдаемости не имеет права уронить уже смерджённую фазу. Журнал живёт в
    // рантайм-каталоге раннера (это решает сам скрипт журнала у потребителя), не в
    // git — раннер нигде не коммитит в main напрямую, только через ревьюенные PR.
    // #252: мутация — через argv (shArgv), не строкой через шелл. Номер PR, milestone
    // и логины авторов уходят отдельными элементами argv — shq() больше не нужен для
    // закрытия инъекции (аргументы структурно не разбираются шеллом), но фильтр
    // authorAllowlist на пустые/нестроковые значения остаётся.
    //
    // #37: КОММЕНТАРИИ ЧИТАЕТ ШОВ, а не скрипт. Раньше скрипт ходил в форж сам (`gh api`),
    // и на площадке без его CLI каждый вызов падал бы, а журнал молча оставался пустым:
    // вызов fail-open, петля цела, метрика ревью исчезла без единого сигнала. Теперь лента
    // приходит сюда через шов и уходит счётчику на stdin — argv для неё не годится, предел
    // одного аргумента у ядра ОС жёсткий, а обрезанная лента дала бы заниженный счёт вместо
    // отказа.
    function recordReviewFindings(
        phase: Phase,
        prNumber: number,
        authorAllowlist: unknown = [],
        runArgvFn: ShArgvFn = shArgv,
        logFn: LogFn = log,
        prCommentsFn: PrCommentsFn = prComments,
    ): void {
        if (!Number.isInteger(prNumber) || prNumber <= 0) {
            logFn(`⚠ Журнал находок: номер PR неизвестен, запись пропущена.`);
            return;
        }
        // #237: прокидываем allowlist авторов в счёт — метрика считает только доверенные
        // комментарии (репо публичный).
        const authors = (Array.isArray(authorAllowlist) ? authorAllowlist : []).filter(
            (a) => typeof a === 'string' && a.trim(),
        );
        // Шов fail-closed, а вся запись в журнал — fail-open: сбой чтения гасим здесь, но
        // ЗАПИСЬ при этом не делаем вовсе. Записать в журнал нули после непрочитанного
        // ревью хуже пропуска: пропуск виден дырой в ряду фаз, а нули читаются как факт.
        // Адрес журнала берётся ЗДЕСЬ, до чтения ленты, а возврат — ниже, после диагностики
        // (второй и третий проходы ревью !21). Порядок именно такой, потому что у двух
        // фактов разные адресаты: «журнал выключен» обязано быть видно ВСЕГДА, в том числе
        // когда форж недоступен, а лента нужна не журналу — её диагностика про ревью и про
        // allowlist, и тот же allowlist молча фильтрует комментарии для сессии правок.
        const journal = getConfig().consumerScriptsResolved?.reviewFindingsJournal;
        let comments: ReviewComment[];
        try {
            comments = prCommentsFn(prNumber);
        } catch (e) {
            const why = String((e as Error)?.message ?? e).split('\n')[0];
            logFn(
                journal
                    ? `⚠ Не смог прочитать комментарии PR #${String(prNumber)} (${why}) — ` +
                          'записи о находках не будет: ноль находок и непрочитанное ревью в журнале неразличимы.'
                    : `⚠ Не смог прочитать комментарии PR #${String(prNumber)} (${why}). ` +
                          '📊 Журнал находок при этом выключен: в конфиге нет consumerScripts.reviewFindingsJournal.',
            );
            return;
        }
        // «Ревью прошло, комментариев ноль» — легитимно ровно один раз в жизни (идеальный
        // PR) и подозрительно всегда: так же выглядит ревью-сессия, которая до форжа не
        // достучалась. Красным это не делаем — фаза уже смерджена, ронять петлю ради
        // косметики метрики нельзя (инвариант №1 про fail-open косметики), — но след в
        // логе обязан быть, иначе тихий ноль не отличить от честного.
        if (comments.length === 0) {
            logFn(
                `⚠ Комментарии ревью: у PR #${String(prNumber)} нет ни одного — ` +
                    'проверь, что ревью-сессия их действительно оставляет.',
            );
        } else if (authors.length > 0 && !comments.some((c) => authors.includes(c.author ?? ''))) {
            // Тот же молчаливый ноль с другого конца: комментарии есть, но фильтр доверенных
            // авторов выкосит все до одного, и в журнал уйдут нули. Так выглядит allowlist,
            // заданный в терминах ДРУГОГО форжа: у GitHub автор — `user.login`, у SourceCraft
            // — `author.slug`, и совпадать они не обязаны. Считать при этом продолжаем (фильтр
            // сторожит публичный репозиторий и ослаблять его нельзя), но молчать нельзя тоже.
            const seen = [...new Set(comments.map((c) => c.author ?? ''))].slice(0, 5).join(', ');
            logFn(
                `⚠ Комментарии ревью: у PR #${String(prNumber)} ${String(comments.length)} комментариев, ` +
                    `но ни один автор не входит в authorAllowlist (ждём: ${authors.join(', ')}; ` +
                    `в ленте: ${seen}) — счёт будет нулевым. Похоже, allowlist задан в терминах другого форжа.`,
            );
        }
        if (!journal) {
            // Молчать нельзя: журнал находок — метрика, по которой судят о ревью, и её
            // отсутствие обязано быть ВИДНЫМ решением, а не следствием того, что файла нет.
            logFn(
                '📊 Журнал находок выключен: в конфиге нет consumerScripts.reviewFindingsJournal.',
            );
            return;
        }
        try {
            const out = runArgvFn(
                'node',
                [journal, String(prNumber), phase.milestone, ...authors],
                { input: JSON.stringify(comments) },
            );
            logFn(`📊 Находки ревью зафиксированы в журнале: ${String(out).trim()}`);
        } catch (e) {
            const why = String((e as Error)?.message ?? e).split('\n')[0];
            logFn(`⚠ Не смог записать находки ревью в журнал (не критично): ${why}`);
        }
    }

    // #625: журнальная запись ОДНОГО прохода ревью правок. Отдельная функция, а не флаг у
    // recordReviewFindings: у той вся работа — сходить в форж за лентой комментариев и
    // посчитать её, а здесь счёт УЖЕ посчитан петлёй (только она знает, что в проходе
    // нового), и ходить никуда не нужно. Общего кода между ними — одна строка вызова
    // скрипта, общего смысла — ноль.
    //
    // Fail-open, как и у соседки: журнал — метрика наблюдаемости, и уронить из-за неё цикл
    // сдачи нельзя (инвариант №1 в части «косметика не имеет права остановить петлю»).
    function recordFixReviewFindings(
        phase: Phase,
        prNumber: number | null,
        counts: Record<string, number>,
        pass: number,
        runArgvFn: ShArgvFn = shArgv,
        logFn: LogFn = log,
    ): void {
        if (!Number.isInteger(prNumber) || (prNumber as number) <= 0) {
            logFn('⚠ Журнал находок (ревью правок): номер PR неизвестен, запись пропущена.');
            return;
        }
        const journal = getConfig().consumerScriptsResolved?.reviewFindingsJournal;
        if (!journal) {
            logFn(
                '📊 Журнал находок выключен: в конфиге нет consumerScripts.reviewFindingsJournal.',
            );
            return;
        }
        try {
            const out = runArgvFn('node', [
                journal,
                String(prNumber),
                phase.milestone,
                `--counts=${JSON.stringify(counts)}`,
                `--pass=${String(pass)}`,
            ]);
            logFn(
                `📊 Находки прохода ${String(pass)} ревью правок в журнале: ${String(out).trim()}`,
            );
        } catch (e) {
            const why = String((e as Error)?.message ?? e).split('\n')[0];
            logFn(`⚠ Не смог записать находки ревью правок в журнал (не критично): ${why}`);
        }
    }

    return {
        pickReviewModel,
        pickReviewFallbackModel,
        // Прежнее имя сохранено: на нём сидит REQUIRED_API и монитор. Теперь это
        // встроенный дефолт, а действующий список отдаёт reviewModelStrength(cfg).
        REVIEW_MODEL_STRENGTH: DEFAULT_REVIEW_MODEL_STRENGTH,
        reviewModelStrength,
        reviewModelRank,
        assertKnownReviewModels,
        strongerReviewModel,
        recordReviewFindings,
        recordFixReviewFindings,
    };
}
