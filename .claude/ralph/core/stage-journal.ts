// Журнал этапов кодер-итерации (Фаза 8, #92).
//
// До журнала состояние одной попытки было размазано по state, файлу намерений, git, PR и
// памяти процесса (`closedThisRun`, `coderTurnRetriesUsed`), и после рестарта раннер
// собирал его заново — то есть начинал итерацию с начала. Рестарт посреди применения
// намерений означал новую сессию по той же карточке: работу делали второй раз, а намерения
// прошлой сессии уезжали вместе с намерениями следующей.
//
// Правило взято у mshogin/reflex: у каждого запроса обязательный исход, иначе сторож
// выпускает «не обработан». Здесь запрос — этап попытки: у каждого начатого этапа
// обязательна запись исхода, и этап без неё после рестарта — «не завершён», а не
// «выполнен». Отсутствие записи никогда не читается как успех: успех пишется явно.
//
// Журнал держит ОДНУ попытку — текущую. Завершённая попытка снимается целиком: история
// живёт в логе, а журнал отвечает только на вопрос «с какого этапа продолжать».
// Пишется он целиком через временный файл и rename (атомарно): усечённая запись
// неотличима от «этап не начат», а это ровно то окно, которое журнал закрывает. Запись,
// которая всё-таки не разбирается (правка руками, чужой формат), отвергается с диагнозом
// — номер строки и причина, — а не пропускается: пропущенный этап был бы молча
// «не начат», и рестарт повторил бы уже сделанное.

/** Этапы кодер-итерации — в порядке исполнения. */
export const CODER_STAGES = ['pick', 'session', 'intents', 'commit'] as const;
export type TCoderStage = (typeof CODER_STAGES)[number];

/** Человеческие имена этапов — для сводки в логе. */
export const STAGE_TITLES: Record<TCoderStage, string> = {
    pick: 'выбор задачи',
    session: 'сессия',
    intents: 'применение намерений',
    commit: 'коммит остатка',
};

/**
 * Исход этапа. `ok` — сделан, идём дальше; `skip` — делать было нечего (коммит остатка
 * после сессии с кодом 0); `stop` — петля остановилась на этапе с названной причиной, и
 * попытка на этом кончена: продолжать её после рестарта значило бы обойти стоп.
 */
export type TStageOutcome = 'ok' | 'skip' | 'stop';
const OUTCOMES: ReadonlySet<string> = new Set(['ok', 'skip', 'stop']);

export type TStageRecord =
    | {
          v: 1;
          attempt: string;
          milestone: string;
          issue: number;
          stage: TCoderStage;
          event: 'start';
          at: string;
      }
    | {
          v: 1;
          attempt: string;
          milestone: string;
          issue: number;
          stage: TCoderStage;
          event: 'outcome';
          outcome: TStageOutcome;
          // Код возврата сессии: этапы после неё решают по нему, а процесс, который его
          // видел, после рестарта уже не спросить.
          code?: number;
          at: string;
      };

export type TStageStatus = 'выполнен' | 'пропущен' | 'остановлен' | 'не завершён' | 'не начат';

export type TAttemptSummary = {
    attempt: string;
    milestone: string;
    issue: number;
    stages: { stage: TCoderStage; status: TStageStatus }[];
    /** Этап, с которого продолжать; `null` — попытка кончена (все исходы есть или стоп). */
    resumeStage: TCoderStage | null;
    /** Код сессии из её исхода; `null` — сессия исхода не записала. */
    sessionCode: number | null;
};

function fail(where: string, line: number, why: string): never {
    throw new Error(
        `Журнал этапов ${where}, строка ${String(line)}: ${why}. Повреждённую запись не ` +
            'пропускаю: пропущенный этап читался бы «не начат», и рестарт повторил бы ' +
            'сделанное. Разбери файл руками (или убери его, если попытка уже доведена) и ' +
            'перезапусти loop.',
    );
}

function isNonEmptyString(x: unknown): x is string {
    return typeof x === 'string' && x !== '';
}

/**
 * Разбор журнала с проверкой каждой записи и их ПОРЯДКА. Порядок проверяется, потому что
 * восстановление решает по нему: исход без начала, этап вперёд предыдущего или вторая
 * попытка в том же файле означают, что журнал писали не мы, — и решать по нему нельзя.
 */
export function parseStageJournal(text: string, where: string): TStageRecord[] {
    const records: TStageRecord[] = [];
    const lines = text.split('\n');
    // Последний перевод строки даёт пустой хвост — это не запись. Пустая строка в
    // середине — уже повреждение: атомарная запись её не оставляет.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    let attempt: string | null = null;
    let milestone: string | null = null;
    let issue: number | null = null;
    // Индекс этапа, который сейчас открыт (начат без исхода), и последнего закрытого.
    let open: number | null = null;
    let lastClosed = -1;
    let stopped = false;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const n = i + 1;
        let r: unknown;
        try {
            r = JSON.parse(raw);
        } catch {
            fail(where, n, 'не разбирается как JSON (оборванная или чужая запись)');
        }
        if (r === null || typeof r !== 'object' || Array.isArray(r)) {
            fail(where, n, 'запись — не объект');
        }
        const o = r as Record<string, unknown>;
        if (o.v !== 1) fail(where, n, `неизвестная версия записи (${JSON.stringify(o.v)})`);
        if (!isNonEmptyString(o.attempt)) fail(where, n, 'нет идентификатора попытки');
        if (!isNonEmptyString(o.milestone)) fail(where, n, 'нет фазы попытки');
        if (!Number.isInteger(o.issue) || (o.issue as number) <= 0) {
            fail(where, n, 'номер задачи — не положительное целое');
        }
        const idx = CODER_STAGES.indexOf(o.stage as TCoderStage);
        if (idx < 0) fail(where, n, `неизвестный этап ${JSON.stringify(o.stage)}`);
        if (!isNonEmptyString(o.at)) fail(where, n, 'нет времени записи');
        if (attempt === null) {
            attempt = o.attempt as string;
            milestone = o.milestone as string;
            issue = o.issue as number;
        } else if (o.attempt !== attempt || o.milestone !== milestone || o.issue !== issue) {
            fail(where, n, 'запись другой попытки — журнал держит одну попытку');
        }
        const base = {
            v: 1 as const,
            attempt: o.attempt as string,
            milestone: o.milestone as string,
            issue: o.issue as number,
            stage: o.stage as TCoderStage,
            at: o.at as string,
        };
        if (stopped) fail(where, n, 'запись после исхода «stop» — попытка уже кончена');
        if (o.event === 'start') {
            if (open !== null) fail(where, n, 'начат новый этап, у прошлого нет исхода');
            if (idx !== lastClosed + 1) {
                fail(where, n, `этап «${o.stage as string}» начат не по порядку`);
            }
            open = idx;
            records.push({ ...base, event: 'start' });
            continue;
        }
        if (o.event === 'outcome') {
            if (open !== idx) fail(where, n, `исход этапа «${o.stage as string}» без его начала`);
            if (!OUTCOMES.has(o.outcome as string)) {
                fail(where, n, `неизвестный исход ${JSON.stringify(o.outcome)}`);
            }
            if (o.code !== undefined && !Number.isInteger(o.code)) {
                fail(where, n, 'код сессии — не целое');
            }
            // Этапы после сессии решают по её коду, а спросить его после рестарта не у кого:
            // исход сессии без кода — не «код 0», а запись, по которой решать нельзя. Любой
            // исход: `stop` без кода продолжение не читает, но правленная руками запись
            // иначе дала бы «успех из ничего». `skip` у сессии не бывает вовсе — раннер его
            // не пишет, а сессия, которой «нечего делать», — не сессия.
            if (o.stage === 'session' && o.outcome === 'skip') {
                fail(where, n, 'исход сессии «skip» — у сессии его не бывает');
            }
            if (o.stage === 'session' && o.code === undefined) {
                fail(where, n, 'исход сессии без кода возврата');
            }
            open = null;
            lastClosed = idx;
            if (o.outcome === 'stop') stopped = true;
            records.push({
                ...base,
                event: 'outcome',
                outcome: o.outcome as TStageOutcome,
                ...(o.code !== undefined ? { code: o.code as number } : {}),
            });
            continue;
        }
        fail(where, n, `неизвестное событие ${JSON.stringify(o.event)}`);
    }
    return records;
}

export function serializeStageJournal(records: readonly TStageRecord[]): string {
    return records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
}

/** Сводка попытки по уже разобранным (и тем самым проверенным) записям. */
export function summarizeAttempt(records: readonly TStageRecord[]): TAttemptSummary | null {
    if (records.length === 0) return null;
    const first = records[0];
    let sessionCode: number | null = null;
    let resumeStage: TCoderStage | null = null;
    let stopped = false;
    const stages = CODER_STAGES.map((stage) => {
        const started = records.some((r) => r.stage === stage && r.event === 'start');
        const outcome = records.find((r) => r.stage === stage && r.event === 'outcome');
        if (outcome && outcome.event === 'outcome') {
            if (stage === 'session' && outcome.code !== undefined) sessionCode = outcome.code;
            if (outcome.outcome === 'stop') stopped = true;
            const status: TStageStatus =
                outcome.outcome === 'ok'
                    ? 'выполнен'
                    : outcome.outcome === 'skip'
                      ? 'пропущен'
                      : 'остановлен';
            return { stage, status };
        }
        // Первый этап без исхода — точка продолжения, начат он или нет: начатый без исхода
        // повторяется, не начатый начинается. Этапы ПОСЛЕ стопа не продолжаются вовсе.
        if (!stopped && resumeStage === null) resumeStage = stage;
        return { stage, status: (started ? 'не завершён' : 'не начат') as TStageStatus };
    });
    return {
        attempt: first.attempt,
        milestone: first.milestone,
        issue: first.issue,
        stages,
        resumeStage: stopped ? null : resumeStage,
        sessionCode,
    };
}

/** Строка сводки для лога: каждый этап со статусом, «не завершён» виден поимённо. */
export function formatAttemptSummary(s: TAttemptSummary): string {
    const parts = s.stages.map((x) => `${STAGE_TITLES[x.stage]} — ${x.status}`);
    const tail =
        s.resumeStage === null
            ? 'попытка кончена, продолжать нечего'
            : `продолжаю с этапа «${STAGE_TITLES[s.resumeStage]}»`;
    return `Попытка ${s.attempt} (Issue #${String(s.issue)}, фаза "${s.milestone}"): ${parts.join('; ')} — ${tail}.`;
}

export type TStageJournalStore = {
    /** Текст журнала; `null` — журнала нет. */
    read: () => string | null;
    /** Запись целиком или никак (боевая — `writeFileAtomic`). */
    write: (text: string) => void;
    remove: () => void;
};

export type TStageJournal = {
    /** Сводка незаконченной попытки на диске; бросает на повреждённой записи. */
    load: () => TAttemptSummary | null;
    /** Новая попытка: прежний журнал заменяется. */
    begin: (milestone: string, issue: number) => string;
    /** Начало этапа; этап, уже открытый (брошенный прошлым процессом), не дублируется. */
    start: (stage: TCoderStage) => void;
    finish: (stage: TCoderStage, outcome: TStageOutcome, code?: number) => void;
    /** Попытка доведена: журнал снимается. */
    close: () => void;
};

/**
 * Журнал поверх хранилища. Каждая запись переписывает файл ЦЕЛИКОМ: попытка — это
 * десяток строк, а дозапись в конец оставила бы оборванную строку там, где rename
 * оставляет либо старую версию, либо новую.
 */
export function createStageJournal(
    store: TStageJournalStore,
    {
        where = 'ralph.stages.jsonl',
        nowFn = () => new Date().toISOString(),
        idFn = () => `${String(Date.now())}-${String(process.pid)}`,
    }: { where?: string; nowFn?: () => string; idFn?: () => string } = {},
): TStageJournal {
    let records: TStageRecord[] = [];
    const head = (): { attempt: string; milestone: string; issue: number } => {
        if (records.length === 0) throw new Error('журнал этапов: этап вне попытки');
        const { attempt, milestone, issue } = records[0];
        return { attempt, milestone, issue };
    };
    const commit = (next: TStageRecord[]): void => {
        // Проверяем то, что собираемся записать, тем же разбором, что и читаем: запись,
        // которую сами же потом отвергнем, лучше не писать вовсе.
        const text = serializeStageJournal(next);
        parseStageJournal(text, where);
        store.write(text);
        records = next;
    };
    const load = (): TAttemptSummary | null => {
        const text = store.read();
        if (text === null) {
            records = [];
            return null;
        }
        // Пустой СУЩЕСТВУЮЩИЙ файл — не «попытки нет». Запись атомарна (rename), но без
        // fsync файла и каталога: после потери питания файл нулевой длины на месте
        // переименованного — известный исход на ряде ФС, и это ровно то окно («усечённая
        // запись неотличима от „этап не начат“»), которое журнал закрывает.
        if (text === '') {
            fail(where, 0, 'файл пуст — запись оборвана, попытка на нём неизвестна');
        }
        records = parseStageJournal(text, where);
        return summarizeAttempt(records);
    };
    return {
        load,
        begin: (milestone, issue) => {
            const attempt = idFn();
            records = [];
            commit([
                { v: 1, attempt, milestone, issue, stage: 'pick', event: 'start', at: nowFn() },
            ]);
            return attempt;
        },
        start: (stage) => {
            // Этап, брошенный прошлым процессом, повторяется под ТЕМ ЖЕ началом: вторая
            // запись «начат» без исхода первой — то самое повреждение, которое отвергает
            // разбор, а для восстановления важен исход, а не число стартов.
            const last = records[records.length - 1];
            if (last && last.event === 'start' && last.stage === stage) return;
            commit([...records, { v: 1, ...head(), stage, event: 'start', at: nowFn() }]);
        },
        finish: (stage, outcome, code) => {
            const rec: TStageRecord = {
                v: 1,
                ...head(),
                stage,
                event: 'outcome',
                outcome,
                at: nowFn(),
            };
            if (code !== undefined) rec.code = code;
            commit([...records, rec]);
        },
        close: () => {
            store.remove();
            records = [];
        },
    };
}

/** Хранилище в памяти — умолчание `runLoop`: чтение боевого файла в тесте — побочка. */
export function memoryStageJournalStore(initial: string | null = null): TStageJournalStore & {
    text: () => string | null;
} {
    let text = initial;
    return {
        read: () => text,
        write: (t) => {
            text = t;
        },
        remove: () => {
            text = null;
        },
        text: () => text,
    };
}
