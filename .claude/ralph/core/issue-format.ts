// Формат карточки, который задаёт потребитель, и его исполнение ядром (Фаза 10).
//
// Инцидент у потребителя: веху на вид витрины завели без ссылок на макеты. Петля
// верстала по доводам ревью, а не по макету, и сломала главную на проде. Правило «у
// карточки витрины есть макет» жило текстом в промпте — и не держало: карточку без
// раздела петля взяла так же охотно, как с ним.
//
// Отсюда раздел труда. ЧТО обязательно (какие разделы, где нужна ссылка, для каких
// меток) — проектная специфика и живёт в `ralph.config.json` → `issueFormat`. Ядро
// знает только контракт и исполняет его в двух местах, где карточка входит в работу:
//
//   - намерение `new-issue` кодер-сессии — карточка не по формату не заводится, батч
//     отвергается с названной причиной (`session-requests.ts`);
//   - preflight и выбор карточки в цикле — не по формату не берётся, стоп называет
//     карточку и раздел (`orchestrator.ts`).
//
// Секции нет — проверки нет, ровно как до неё: формат — решение потребителя, а «дефолт
// как у нас» был бы той же проектной спецификой, только спрятанной. Заданная секция
// проверяется fail-closed: опечатка в ключе (`requireLinks`) выключала бы именно то
// правило, ради которого секцию завели, а заметили бы это снова на проде.
//
// Модуль ЧИСТЫЙ: конфиг → правила, тело + метки → нарушения. Ни сети, ни диска.

export type TSectionRule = {
    // Заголовок раздела в markdown-теле карточки (`## Критерии готовности`). Сравнение —
    // без учёта регистра и лишних пробелов, но по ВСЕЙ строке заголовка: префиксный
    // матч принял бы «Макет (будет позже)» за раздел с макетом.
    heading: string;
    // Правило действует только на карточку с этой меткой (зона витрины и т. п.). Нет —
    // на любую.
    whenLabel?: string;
    // В разделе обязана быть ссылка `http(s)://`. Раздел «Макет» с текстом «см. в чате»
    // формально есть, а макета по нему не найти — ровно тот случай инцидента.
    requireLink?: boolean;
};

export type TIssueFormat = { sections: TSectionRule[] };

export type TFormatProblem = 'missing' | 'empty' | 'no-link';
export type TFormatViolation = { heading: string; problem: TFormatProblem };

const KEYS = ['sections'];
const SECTION_KEYS = ['heading', 'whenLabel', 'requireLink'];

function isObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function norm(s: string): string {
    return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Секция `issueFormat` конфига → правила либо `null` («формата нет, работаем как раньше»).
 *
 * failFn зовётся на каждую ошибку и может вернуть управление; тогда секция считается
 * отсутствующей — вызов с проверенным уже конфигом (preflight прошёл) до этого не доходит.
 */
export function resolveIssueFormat(
    cfg: unknown,
    failFn: (msg: string) => unknown,
): TIssueFormat | null {
    const raw = isObject(cfg) ? cfg.issueFormat : undefined;
    if (raw === undefined) return null;
    const where = 'ralph.config.json: issueFormat';
    const bad = (msg: string): null => {
        failFn(msg);
        return null;
    };
    if (!isObject(raw)) return bad(`${where} — ожидался объект, получено ${JSON.stringify(raw)}.`);
    const unknownKeys = Object.keys(raw).filter((k) => !KEYS.includes(k));
    if (unknownKeys.length > 0)
        return bad(
            `${where}: незнакомые ключи ${unknownKeys.join(', ')} — допустимы ${KEYS.join(', ')}.`,
        );
    // Пустой список выглядит настройкой, а не проверяет ничего: выключатель формата —
    // отсутствие секции, и он один.
    if (!Array.isArray(raw.sections) || raw.sections.length === 0)
        return bad(
            `${where}.sections — ожидался непустой список правил разделов; ` +
                'выключить формат можно только удалением секции.',
        );
    const sections: TSectionRule[] = [];
    const seen = new Set<string>();
    for (const [i, s] of raw.sections.entries()) {
        const at = `${where}.sections[${String(i)}]`;
        if (!isObject(s))
            return bad(`${at} — ожидался объект { heading, whenLabel?, requireLink? }.`);
        const extra = Object.keys(s).filter((k) => !SECTION_KEYS.includes(k));
        if (extra.length > 0)
            return bad(
                `${at}: незнакомые ключи ${extra.join(', ')} — допустимы ${SECTION_KEYS.join(', ')}.`,
            );
        if (typeof s.heading !== 'string' || s.heading.trim() === '')
            return bad(`${at}.heading — ожидалась непустая строка заголовка раздела.`);
        if (s.whenLabel !== undefined && (typeof s.whenLabel !== 'string' || s.whenLabel === ''))
            return bad(
                `${at}.whenLabel — ожидалось имя метки, получено ${JSON.stringify(s.whenLabel)}.`,
            );
        if (s.requireLink !== undefined && typeof s.requireLink !== 'boolean')
            return bad(
                `${at}.requireLink — ожидалось true/false, получено ${JSON.stringify(s.requireLink)}.`,
            );
        // Дубль — не ошибка смысла, но почти всегда опечатка в соседнем правиле, которое
        // хотели завести на другую метку: молча слитое, оно не проверяло бы ничего.
        const key = `${norm(s.heading)}\u0000${norm(s.whenLabel ?? '')}`;
        if (seen.has(key))
            return bad(`${at}: правило раздела «${s.heading}» для той же метки задано дважды.`);
        seen.add(key);
        sections.push({
            heading: s.heading.trim(),
            ...(s.whenLabel !== undefined ? { whenLabel: s.whenLabel } : {}),
            ...(s.requireLink !== undefined ? { requireLink: s.requireLink } : {}),
        });
    }
    return { sections };
}

// Закрывающая последовательность `#` по CommonMark отделяется пробелом: `## Раздел C#`
// кончается решёткой, но закрытия у него нет, и срезать её — значит не узнать раздел.
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LINK_RE = /https?:\/\/\S+/;
// HTML-комментарий не рендерится и содержимым карточки не является. В шаблонах раздел
// приходит с подсказкой `<!-- ссылка на макет, например https://… -->`, и незаполненная
// карточка из шаблона проходила бы и «пустой раздел», и «нет ссылки» — ровно те правила,
// ради которых секцию заводят. Незакрытый комментарий тянется до конца тела, как его и
// рендерит markdown.
const HTML_COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;

// Разделы тела: заголовок → текст до следующего заголовка того же или старшего уровня.
// Строки внутри блока кода заголовками не считаются: `## Макет` в примере кода — не
// раздел карточки. Блок закрывает только та же последовательность ограды, не короче
// открывающей: иначе ``` внутри блока из четырёх бэктиков переключил бы состояние, и
// заголовки дальше считались бы наоборот.
function sectionsOf(body: string): Map<string, string> {
    const out = new Map<string, string>();
    const open: Array<{ level: number; key: string; lines: string[] }> = [];
    let fence: string | null = null;
    const flush = (level: number) => {
        while (open.length > 0 && open[open.length - 1].level >= level) {
            const s = open.pop()!;
            const text = s.lines.join('\n');
            // Повтор заголовка — берём непустой: пустой дубль не должен прятать раздел.
            if (!out.has(s.key) || out.get(s.key)!.trim() === '') out.set(s.key, text);
        }
    };
    for (const line of body.replace(HTML_COMMENT_RE, '').split(/\r?\n/)) {
        const f = FENCE_RE.exec(line);
        if (f) {
            const seq = f[1];
            if (fence === null) fence = seq;
            else if (seq[0] === fence[0] && seq.length >= fence.length && f[2].trim() === '')
                fence = null;
        }
        const m = fence === null && !f ? HEADING_RE.exec(line) : null;
        if (m) {
            const level = m[1].length;
            flush(level);
            // Строка подзаголовка в текст родителя не идёт: `## Макет` с одним `### Главная`
            // внутри — раздел без единого слова, и считать его непустым значило бы обойти
            // правило «пустой раздел — нарушение». Содержимое подраздела — идёт.
            open.push({ level, key: norm(m[2] ?? ''), lines: [] });
            continue;
        }
        for (const s of open) s.lines.push(line);
    }
    flush(0);
    return out;
}

/** Нарушения формата у карточки; пустой список — карточка по формату. */
export function checkIssueFormat(
    issue: { body: string; labels: readonly string[] },
    format: TIssueFormat,
): TFormatViolation[] {
    const sections = sectionsOf(issue.body);
    const labels = new Set(issue.labels.map(norm));
    const out: TFormatViolation[] = [];
    for (const rule of format.sections) {
        // Метки у форжей регистронезависимы (`Area:Showcase` и `area:showcase` — одна), и
        // опечатка в регистре в конфиге выключала бы правило молча.
        if (rule.whenLabel !== undefined && !labels.has(norm(rule.whenLabel))) continue;
        const text = sections.get(norm(rule.heading));
        if (text === undefined) out.push({ heading: rule.heading, problem: 'missing' });
        else if (text.trim() === '') out.push({ heading: rule.heading, problem: 'empty' });
        else if (rule.requireLink === true && !LINK_RE.test(text))
            out.push({ heading: rule.heading, problem: 'no-link' });
    }
    return out;
}

const PROBLEM_TEXT: Record<TFormatProblem, string> = {
    missing: 'нет раздела',
    empty: 'пуст раздел',
    'no-link': 'нет ссылки http(s) в разделе',
};

/** «нет раздела «Макет»; пуст раздел «Критерии готовности»» — для отказа и стопа. */
export function describeFormatViolations(violations: readonly TFormatViolation[]): string {
    return violations.map((v) => `${PROBLEM_TEXT[v.problem]} «${v.heading}»`).join('; ');
}
