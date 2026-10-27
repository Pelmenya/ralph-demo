// Deadman — пороги тишины по последнему событию лога (#147).
//
// Признак жизни петли — время последней записи в ralph.log worktree или в его heartbeat,
// смотря что свежее. log() пишется на каждом шаге хореографии, поэтому свежесть = «раннер
// шевелится»; смена HEAD отклонена (легитимные шаги ревью/гейта подолгу не двигают HEAD).
// Heartbeat (core/event-journal.ts, задача 95) пишется тем же log() и переживает отказ
// записи лога — без него полный диск давал ложный DEADMAN. Слияние двух источников — забота
// монитора (withHeartbeat); этот модуль по-прежнему видит только строки и числа.
//
// Общий порог тишины невозможен: claude-сессия (кодер-итерация, ревью, правки,
// создание PR, разбор blocked — все идут через runClaude → spawnSync) легитимно
// молчит до claudeTimeoutMs (2ч), а гейт и git/gh-шаги — минуты. Поэтому порог
// зависит от того, в каком РЕЖИМЕ сейчас петля, а режим определяется по последнему
// значимому маркеру в хвосте лога.
//
// Этот модуль — чистое правило (строки/числа на вход-выход): классификация хвоста и
// арифметика порога. Чтение файла, сравнение с «сейчас», дедуп и сам пуш — забота
// монитора (#148/#149). Побочек нет — DI и guardSideEffect не нужны.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
// Без побочек вовсе, поэтому, как и ralph-util.ts/api-limit.ts, это набор standalone-
// экспортов, а не фабрика с DI.
//
// ── Числа порогов (замер реальных прогонов фаз 4–5, .claude/ralph/ralph.log) ──
// Кодер-сессии (🔄 → следующий шаг): реальный максимум ~21 мин (фаза 3, итерация 1),
//   типично 6–16 мин. Но легитимный ПОТОЛОК сессии — claudeTimeoutMs (2ч): spawnSync
//   держит claude ровно столько, поэтому порог = claudeTimeoutMs + запас, а не по
//   замеру. Замер лишь подтверждает: реальные сессии ≪ 2ч, ложных пушей не будет.
//   Запас (iterationGraceMs=10 мин) кроет kill по таймауту + запись результата + такт
//   опроса монитора на небыстром VDS.
// API-лимитная пауза (⏳): при упирании в окно лимита runClaude пишет строку
//   `🔔 PUSH: ⏳ … Жду N мин` и СИНХРОННО спит N минут (до сброса окна — parseResetWaitMs
//   в ralph.js даёт вплоть до ~24ч). Всё это время лог заморожен на этой строке, поэтому
//   у паузы СВОЙ режим (apiwait) со своим порогом = N мин + запас: N раннер печатает
//   прямо в строку, формат стабилен. Без отдельного режима строка была бы нейтральной,
//   скан ушёл бы назад к `▶ claude -p`, взял coder-порог (2ч10м) и дал ложный DEADMAN-пуш
//   на любой паузе длиннее ~2ч — ровно то, что запрещает критерий PRD «ноль ложных пушей».
// Пост-мердж ожидание деплоя (⏳ Пост-мердж, #TFO89): после squash-мерджа prod-фазы раннер
//   опрашивает deploy-workflow вплоть до deployCheck.timeoutMs (боевые 20 мин) и всё это
//   время НЕ пишет в лог (запись только в catch сетевого чиха). Своя строка ожидания
//   несёт таймаут N в тексте, поэтому у ожидания СВОЙ режим (deploywait) с порогом = N мин
//   + запас — ровно как apiwait. Без него строка нейтральна, скан ушёл бы к `🚀 Деплой
//   фазы`/`✅ смерджена` → default (5 мин) → ложный DEADMAN-пуш на КАЖДОМ prod-мердже
//   (deploy на VDS регулярно длиннее 5 мин). См. DEPLOY_WAIT_RE ниже.
// Гейт (🚦 → между строками ✓/✗ чеков): checksGreen логирует каждый чек, поэтому
//   тишина внутри гейта ограничена САМЫМ ДОЛГИМ одиночным чеком. Замер сейчас на этом
//   дереве: build ~36с, coverage ~19с, e2e (Playwright, prod-профиль) ~108с — самый
//   долгий. Плюс первый интервал 🚦→✓build кроет git fetch/detach и возможный npm ci
//   при смене lock (до ~2–3 мин). gateSilenceMs=10 мин даёт ~×3 запас над e2e и кроет
//   npm ci-путь на медленном VDS. Значение одно на оба профиля — под ХУДШИЙ (prod с
//   e2e); playground-гейт быстрее, ложных пушей тем более не даст.
// Дефолт (git/gh-шаги, обновление worktree, закрытие milestone): секунды; худшее —
//   стартовый npm ci нового worktree (~1–2 мин). defaultSilenceMs=5 мин с запасом.
// Штатная остановка (⏸ прод-стоп фазы, ✋ HITL, ⛔ circuit breaker и прочие стопы, 🎉 все
//   фазы): раннер вышел из loop, лог заморожен НАВСЕГДА и корректно. Свой режим stopped с
//   порогом +∞ — тишины тут нет и пуша быть не должно (без него default 5 мин давал бы
//   ложный 💀 после каждой сданной прод-фазы). См. STOPPED_RE ниже.

// Маркеры claude-сессии: старт сессии (▶ claude -p логируется перед каждой) плюс
// шаговые эмодзи — итерация/ревью/правки. Любого достаточно, чтобы понять «идёт
// многочасовая сессия».
export const CODER_RE = /▶ claude -p|🔄|🔍 Ревью|🔧 Правки/u;
// Маркеры гейта: старт (🚦) и строки результата отдельных чеков (checksGreen пишет
// `  ✓ name` / `  ✗ name — красный`). Якорь на начало не ставим: log() префиксит
// строку таймстампом, ✓/✗ идёт в середине. ✓/✗ — U+2713/U+2717, это НЕ ✅ U+2705 из
// completion-маркеров.
export const GATE_RE = /🚦|[✓✗]\s/u;
// Терминальные маркеры ШТАТНОЙ остановки петли: прод-стоп фазы перед деплоем (⏸),
// HITL-стоп (✋), circuit breaker и прочие ⛔-стопы, «все фазы завершены» (🎉). После них
// раннер выходит из loop и процесс завершается — лог замерзает НАВСЕГДА, и это НЕ тишина
// зависшего шага, а корректный конец. Без своего режима эти строки уводили классификатор
// назад к ✅/🏁 → default (5 мин) → ложный 💀 DEADMAN «цикл продолжается» после КАЖДОЙ
// сданной прод-фазы (нарушение критерия PRD «ноль ложных пушей» + вклад в alert fatigue).
// Режим stopped порога не имеет (Infinity) и пуша не даёт. ⛔ проверяется в scanTail ДО
// GATE/DEFAULT: транзитных ⛔ нет — ⛔ как ПОСЛЕДНИЙ стабильный маркер всегда означает
// выход из loop, а гейт-отказ тут же сменяется маркером чини-сессии (▶ claude), который
// свежее ⛔ и выигрывает классификацию.
export const STOPPED_RE = /⏸|✋|🎉|⛔/u;
// Маркеры завершения/старта — закрывают предыдущий режим и переводят в короткий дефолт:
// мердж (✅ PR), сдача фазы/туннель (✅), закрытие milestone (🏁), баннер старта (🚀),
// переключение веток (🔀). Стопы (⏸/✋/⛔/🎉) — не сюда: у них свой режим stopped.
export const DEFAULT_RE = /✅|🏁|🚀|🔀/u;
// Маркер API-лимитной паузы. Формат строки — единственный источник правды в ralph.js
// (функция apiLimitMessage(); pushEvent префиксит `🔔 PUSH:`): `⏳ Ralph: API-лимит — …
// Жду N мин …`. Синхронность текста и этого regex закреплена тестом (deadman.test.ts:
// apiLimitMessage из ralph.js ↔ API_WAIT_RE) — правка формулировки в ралфе, ломающая
// матч, покраснит гейт, а не всплывёт ночью ложным пушем. N (минуты сна до сброса окна)
// захватываем группой — по нему порог именно этой паузы, а не coder-режима.
export const API_WAIT_RE = /⏳ Ralph: API-лимит[\s\S]*?Жду (\d+) мин/u;
// Маркер ожидания пост-мердж деплоя (#TFO89). Формат строки — единственный источник
// правды в ralph.js (функция deployWaitMessage()): `⏳ Пост-мердж: жду итог deploy-workflow
// «…» на sha … (таймаут N мин).`. Цикл опроса deploy-workflow за N мин (боевой таймаут
// 20 мин) не пишет в лог ни строки — без своего режима строка нейтральна, скан ушёл бы
// назад к `🚀 Деплой фазы…`/`✅ … смерджена` → DEFAULT_RE (5 мин) → ложный DEADMAN-пуш на
// каждом prod-мердже. N (таймаут в минутах) захватываем группой — по нему порог именно
// этого ожидания. Синхронность текста и regex закреплена тестом (deadman.test.ts:
// deployWaitMessage из ralph.js ↔ DEPLOY_WAIT_RE), как у apiLimitMessage ↔ API_WAIT_RE.
export const DEPLOY_WAIT_RE = /⏳ Пост-мердж: жду итог[\s\S]*?таймаут (\d+) мин/u;

// Режимы петли, определяемые по последнему значимому маркеру в хвосте лога. Экспортируется
// (#403-review): silenceThresholdMs и DeadmanEval.activity в monitor-panel.mts типизируются
// им, а не широким string.
export type Activity = 'stopped' | 'apiwait' | 'deploywait' | 'coder' | 'gate' | 'default';

type DeadmanThresholds = {
    iterationGraceMs: number;
    gateSilenceMs: number;
    defaultSilenceMs: number;
};

// Дефолты порогов (мс) — если в ralph.config.json нет блока deadman. Совпадают с
// числами в конфиге; здесь — чтобы модуль работал и на «голом» конфиге (fail-safe).
export const DEFAULT_DEADMAN: DeadmanThresholds = {
    iterationGraceMs: 10 * 60 * 1000, // запас поверх claudeTimeoutMs для кодер-сессии
    gateSilenceMs: 10 * 60 * 1000, // тишина внутри гейта (самый долгий чек + запас)
    defaultSilenceMs: 5 * 60 * 1000, // короткий дефолт для шагов git и форжа
};

export const DEFAULT_CLAUDE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // как в runClaudeOnce (ralph.js)

// Единый скан хвоста лога (один проход, один список «значимых» RE — источник правды и
// для режима, и для порога apiwait). От последней строки к первой; возвращаем режим И
// саму строку первого встреченного ЗНАЧИМОГО маркера (stopped/apiwait/coder/gate/default).
// Нейтральные строки (обычные ⚠, многострочные хвосты ошибок без маркера) пропускаем —
// они не меняют режим, иначе стрелой ⚠ посреди сессии режим упал бы в default и короткий
// порог дал бы ложный пуш. Именно этот ПРОПУСК нейтральных строк и есть заявленное
// смещение «к более длинному порогу при неоднозначности» (активная coder/gate-сессия
// переживает шум). Если же во всём хвосте нет ни одного значимого маркера — это не
// активный шаг, отдаём короткий default (fail-safe от обратного: длинный порог на
// неизвестном хвосте замаскировал бы реальную тишину). На практике хвост почти всегда
// содержит маркер log(), так что ветка достижима редко.
export function scanTail(lines: string[]): { activity: Activity; line: string | null } {
    for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (typeof l !== 'string') continue;
        if (STOPPED_RE.test(l)) return { activity: 'stopped', line: l };
        if (API_WAIT_RE.test(l)) return { activity: 'apiwait', line: l };
        if (DEPLOY_WAIT_RE.test(l)) return { activity: 'deploywait', line: l };
        if (CODER_RE.test(l)) return { activity: 'coder', line: l };
        if (GATE_RE.test(l)) return { activity: 'gate', line: l };
        if (DEFAULT_RE.test(l)) return { activity: 'default', line: l };
        // прочее — нейтрально, продолжаем скан к более раннему маркеру
    }
    return { activity: 'default', line: null };
}

// Режим петли по хвосту лога — тонкая обёртка над единым сканом.
export function classifyActivity(lines: string[]): Activity {
    return scanTail(lines).activity;
}

// Порог паузы API-лимита (мс) из строки `🔔 PUSH: ⏳ … Жду N мин`. Тот же единый скан,
// что и у классификатора: значимая строка одна на оба, break-логика не может разойтись.
// N мин × 60000 + запас (iterationGraceMs кроет рестарт сессии после сна и такт монитора).
// Хвост не в режиме apiwait или N не распарсилось — null (вызывающий возьмёт консервативный
// coder-порог: не занижаем).
export function parseApiWaitMs(lines: string[], cfg: unknown): number | null {
    const { activity, line } = scanTail(lines);
    if (activity !== 'apiwait' || line == null) return null;
    const m = API_WAIT_RE.exec(line);
    if (!m) return null;
    const { deadman } = readCfg(cfg);
    return parseInt(m[1], 10) * 60000 + deadman.iterationGraceMs;
}

// Порог ожидания пост-мердж деплоя (мс) из строки `⏳ Пост-мердж: жду итог … (таймаут N
// мин)`. Тот же единый скан, что и у классификатора. N мин × 60000 + запас
// (iterationGraceMs кроет healthcheck после ожидания + такт монитора). Хвост не в режиме
// deploywait или N не распарсилось → null (вызывающий возьмёт консервативный coder-порог).
export function parseDeployWaitMs(lines: string[], cfg: unknown): number | null {
    const { activity, line } = scanTail(lines);
    if (activity !== 'deploywait' || line == null) return null;
    const m = DEPLOY_WAIT_RE.exec(line);
    if (!m) return null;
    const { deadman } = readCfg(cfg);
    return parseInt(m[1], 10) * 60000 + deadman.iterationGraceMs;
}

// Секция deadman и claudeTimeoutMs из УЖЕ резолвнутого профилем конфига (resolveProfile
// кладёт поля на верхний уровень). Контракт узкий: сюда подаётся ТОЛЬКО резолвнутый
// конфиг. Сырой `{ common, profiles }` не читаем: без имени профиля честно слить его
// оверрайды нельзя — взяли бы `common`, молча потеряв возможные prod-пороги (ровно тот
// «гадаем», которого docblock обещал избегать). И раннер, и монитор резолвят профиль до
// вызова детекта, так что сужение ничего в бою не ломает. null/битый конфиг → дефолты.
// По-полевая проверка порогов deadman. Опечатка в ralph.config.json (`"gateSilenceMs":
// "600000"` строкой, null, вложенный объект) без неё дала бы NaN/конкатенацию в
// арифметике порога → `silenceMs > thresholdMs` навсегда false → watchdog молча
// обезоружен, ровно тот класс тихого отказа, с которым борется этот модуль. Годное
// значение — конечное неотрицательное число (0 у iterationGraceMs легитимен: нулевой
// запас); всё остальное (строка/null/объект/NaN/±∞/отрицательное) откатывается на
// DEFAULT_DEADMAN по-полевно, а не роняет весь блок.
function coerceDeadmanThresholds(raw: unknown): DeadmanThresholds {
    const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const out = {} as DeadmanThresholds;
    for (const key of Object.keys(DEFAULT_DEADMAN) as Array<keyof DeadmanThresholds>) {
        const v = src[key];
        out[key] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_DEADMAN[key];
    }
    return out;
}

function readCfg(cfg: unknown): { deadman: DeadmanThresholds; claudeTimeoutMs: number } {
    const src = cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>) : {};
    return {
        deadman: coerceDeadmanThresholds(src.deadman),
        claudeTimeoutMs:
            typeof src.claudeTimeoutMs === 'number' &&
            Number.isFinite(src.claudeTimeoutMs) &&
            src.claudeTimeoutMs > 0
                ? src.claudeTimeoutMs
                : DEFAULT_CLAUDE_TIMEOUT_MS,
    };
}

// Порог тишины (мс) для режима. Неизвестный режим → default (fail-safe: не занижаем).
// lines нужны только режиму apiwait/deploywait (порог берётся из строки паузы); для
// остальных режимов параметр не читается, поэтому старые вызовы (activity, cfg) валидны.
export function silenceThresholdMs(activity: Activity, cfg: unknown, lines?: string[]): number {
    const { deadman, claudeTimeoutMs } = readCfg(cfg);
    switch (activity) {
        case 'stopped':
            // Штатная остановка петли: процесс вышел из loop, лог заморожен КОРРЕКТНО —
            // это не зависший шаг. Порог = +∞: silenceMs > Infinity всегда false → пуша
            // нет (см. STOPPED_RE и docblock режима stopped).
            return Infinity;
        case 'coder':
            return claudeTimeoutMs + deadman.iterationGraceMs;
        case 'apiwait':
            // Порог самой паузы (N мин + запас). Не распарсилось (не должно — activity
            // ставится ровно по этой строке) → консервативно coder-порог, не занижаем.
            return parseApiWaitMs(lines ?? [], cfg) ?? claudeTimeoutMs + deadman.iterationGraceMs;
        case 'deploywait':
            // Порог ожидания деплоя (таймаут N мин + запас). Не распарсилось → консервативно
            // coder-порог, не занижаем (тот же приём, что и apiwait).
            return (
                parseDeployWaitMs(lines ?? [], cfg) ?? claudeTimeoutMs + deadman.iterationGraceMs
            );
        case 'gate':
            return deadman.gateSilenceMs;
        default:
            return deadman.defaultSilenceMs;
    }
}

// Удобный композит: хвост лога → порог. Монитор сравнит его с (сейчас − время
// последней записи лога) и решит про пуш. lines прокидываем и в порог — режиму apiwait
// они нужны, чтобы вынуть `Жду N мин` из строки паузы.
export function thresholdForTail(lines: string[], cfg: unknown): number {
    return silenceThresholdMs(classifyActivity(lines), cfg, lines);
}
