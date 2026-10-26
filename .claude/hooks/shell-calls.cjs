/**
 * Разбор команды оболочки в СПИСОК ВЫЗОВОВ: `{ name, args }` для каждого, включая
 * вложенные — из `sh -c`, подстановки команды и heredoc'а, который читает сама оболочка.
 *
 * Зачем отдельный модуль и почему не регулярки. Четыре прохода ревью по этому барьеру дали
 * двадцать находок, и половина — «то же правило, другая запись»: `env sh <<EOF`,
 * `'API_URL=…'`, адрес в кавычках, адрес в данных запроса, клиент по полному пути,
 * значение флага обёртки. Каждая заплатка закрывала форму и открывала соседнюю, потому что
 * правило смотрело на СТРОКУ, а опасен ВЫЗОВ.
 *
 * Со списком вызовов «позиция команды» перестаёт быть понятием: `git commit -m "rm -rf x"`
 * даёт один вызов `git` с аргументом-текстом, и правилу про удаление там нечего искать —
 * не потому, что текст замаскирован, а потому, что вызова `rm` в команде нет.
 *
 * Чем это НЕ является: полноценным парсером оболочки. Экранирование обратным слэшем,
 * вложенные скобки внутри подстановки, `$'…'`-строки и арифметические подстановки вне
 * охвата — отвергнуто трижды с записью в журнале ядра. Барьер закрывает НЕВИДИМОСТЬ
 * обычной правки, а не строку, собранную нарочно против него: под `bypassPermissions` та
 * же команда исполнима напрямую.
 *
 * CommonJS намеренно, как и у соседей: хук запускается до `npm ci`.
 */

/** Глубина вложенности разбора: барьер не должен зависать на присланной ему строке. */
const MAX_DEPTH = 3;

/**
 * Разделители команд вне кавычек. Скобки подоболочки здесь же: `(cd /tmp && npm …)` —
 * два вызова, а не команда с именем `(cd`.
 */
const SEGMENT_CHARS = new Set([';', '|', '&', '\n', '(', ')', '{', '}']);

/**
 * Токен и то, как он был записан: содержимое ОДИНАРНЫХ кавычек оболочка не раскрывает,
 * значит подстановку внутри него исполнять не будет — а из двойных будет.
 */
function tokenize(segment) {
    const tokens = [];
    let value = '';
    let quote = null;
    let seen = false;
    let literal = false;
    const push = () => {
        if (value || seen) tokens.push({ value, literal });
        value = '';
        seen = false;
        literal = false;
    };
    for (const ch of segment) {
        if (quote) {
            if (ch === quote) quote = null;
            else value += ch;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            seen = true;
            if (ch === "'") literal = true;
            continue;
        }
        if (/\s/.test(ch)) {
            push();
            continue;
        }
        value += ch;
    }
    push();
    return tokens;
}

/** Сегменты команды — по разделителям вне кавычек. Кавычки внутри сегмента сохраняются. */
function segmentsOf(text) {
    const segments = [];
    let current = '';
    let quote = null;
    for (const ch of text) {
        if (quote) {
            current += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            current += ch;
            continue;
        }
        // `2>&1` — одно перенаправление, а не два сегмента: амперсанд после `>`/`<`
        // разделителем не является (ревью, проход 5).
        if (ch === '&' && /[<>]$/.test(current)) {
            current += ch;
            continue;
        }
        if (SEGMENT_CHARS.has(ch) && !current.endsWith('\\')) {
            segments.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    segments.push(current);
    return segments;
}

/**
 * Обёртки, которые запускают следующую команду за нас, и их флаги СО ЗНАЧЕНИЕМ.
 *
 * Значение обязано быть в таблице, а не угадываться: `env -u HTTPS_PROXY npm …` и
 * `sudo -u root bash …` без неё сдвигали имя команды на значение флага, и барьер видел
 * вызов `HTTPS_PROXY` вместо `npm` (ревью, проход 4, blocker).
 */
const WRAPPERS = {
    sudo: new Set(['-u', '-g', '-p', '-C', '-U', '-h', '-r', '-t', '--user', '--group']),
    env: new Set(['-u', '-C', '-S', '--unset', '--chdir']),
    xargs: new Set([
        '-n',
        '-L',
        '-I',
        '-P',
        '-s',
        '-d',
        '-E',
        '-a',
        '--max-args',
        '--replace',
        '--arg-file',
        '--max-procs',
        '--delimiter',
        '--max-lines',
        // `--eof` в таблицу НЕ входит: у него значение необязательное (`--eof[=str]`),
        // и, съедая следующий токен, разбор терял имя запускаемой команды —
        // `xargs --eof rm -rf` проходил насквозь (ревью, проход 6).
    ]),
    nohup: new Set(),
    // `busybox kill 600` — тот же kill; апплет идёт первым позиционным (ревью #196).
    busybox: new Set(),
    time: new Set(['-f', '-o', '--format', '--output']),
    command: new Set(),
    exec: new Set(),
    export: new Set(),
    nice: new Set(['-n']),
    timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
    stdbuf: new Set(['-i', '-o', '-e']),
};

/**
 * Ключевые слова составных команд — прозрачный префикс, как обёртки: `do kill $p`,
 * `then rm -rf …`, `while read p` запускают команду ПОСЛЕ слова. До #196 разбор
 * принимал `do`/`then` за имя команды, и сама форма инцидента 22.09.2026 (`for p in
 * $(ss …); do kill $p; done` без `&&` перед `kill`) проходила барьер целиком —
 * вместе с `for f in a; do rm -rf /var/lib; done` (ревью #196, blocker).
 * `for`/`case`/`select` здесь НЕТ: слово после них — переменная, а не команда.
 */
const SHELL_KEYWORDS = new Set([
    'if',
    'then',
    'elif',
    'else',
    'while',
    'until',
    'do',
    '!',
    'coproc',
]);

const ASSIGNMENT_RE = /^\w+=/;
/**
 * Перенаправление дескриптора — не команда и не её аргумент: `2>&1 curl …` запускает
 * `curl`, а разбор принимал за имя команды сам `2>` (ревью, проход 5). Цель
 * перенаправления (`> /tmp/log`) пропускается вместе с ним.
 */
const REDIRECTION_RE = /^\d*(?:>>?|<)(?:&\d*-?)?$/;
const REDIRECTION_WITH_TARGET_RE = /^\d*(?:>>?|<)(?:&\d*-?)?\S+$/;
const basenameOf = (token) => token.split('/').pop() ?? token;

/**
 * Имя команды сегмента, её аргументы и присваивания окружения перед ней.
 *
 * `timeout 300 git …` и `nice -n 5 npm …` — та же обёртка: первое значение после флага
 * пропускается по таблице, а голое число у `timeout` — по его же правилу (первый
 * позиционный аргумент обёртки).
 */
function callOf(segment) {
    const tokens = tokenize(segment);
    const assignments = [];
    let i = 0;
    while (i < tokens.length) {
        const token = tokens[i].value;
        if (REDIRECTION_RE.test(token)) {
            // `2> file`: цель отдельным токеном.
            i += token.includes('&') ? 1 : 2;
            continue;
        }
        if (REDIRECTION_WITH_TARGET_RE.test(token)) {
            i += 1;
            continue;
        }
        if (ASSIGNMENT_RE.test(token)) {
            assignments.push(token);
            i += 1;
            continue;
        }
        if (SHELL_KEYWORDS.has(token)) {
            i += 1;
            continue;
        }
        const name = basenameOf(token);
        const wrapper = WRAPPERS[name];
        if (wrapper) {
            i += 1;
            // Флаги обёртки и, по таблице, их значения.
            while (i < tokens.length && tokens[i].value.startsWith('-')) {
                const flag = tokens[i].value.split('=')[0];
                i += 1;
                if (wrapper.has(flag) && !tokens[i - 1].value.includes('=')) i += 1;
            }
            // `timeout 300 …`, `nice 5 …`: длительность и приоритет — аргумент обёртки.
            if (
                name === 'timeout' &&
                i < tokens.length &&
                /^[\d.]+[smhd]?$/.test(tokens[i].value)
            ) {
                i += 1;
            }
            continue;
        }
        return {
            name,
            args: tokens.slice(i + 1),
            assignments,
        };
    }
    return { name: '', args: [], assignments };
}

const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SUBSTITUTION_RE = [/\$\(([\s\S]*?)\)/g, /`([\s\S]*?)`/g];
/** Разделитель heredoc'а: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`, `<<\EOF`. */
const HEREDOC_RE = /<<-?\s*(['"\\]?)([A-Za-z_][\w-]*)\1?\r?\n([\s\S]*?)\r?\n\2\b/g;

/**
 * Читает ли оболочка stdin как ПРОГРАММУ — или он останется данными запущенного скрипта.
 *
 * Три случая, когда не читает:
 *   • `-c` — программа в аргументе флага;
 *   • `-n` / `--noexec` — разбор синтаксиса без исполнения;
 *   • назван файл скрипта (`bash provision.sh <<EOF`) — исполняется он, а heredoc или
 *     here-string достаются ему на stdin как данные. Форма обычная для этого репозитория
 *     (`.claude/ralph/provision/provision.sh`), и барьер её ложно блокировал (ревью,
 *     проход 6). Явный `-s` этот случай отменяет: он и означает «программа со stdin»,
 *     а позиционные аргументы при нём — параметры программы.
 */
function shellSkipsStdin(args) {
    const values = args.map(({ value }) => value);
    const flagged = (predicate) =>
        values.some((value) => {
            if (!value.startsWith('-')) return false;
            if (value.startsWith('--')) return predicate(value, true);
            // Короткие флаги слипаются: `-ec` — это и `-e`, и `-c`.
            return predicate(value.slice(1), false);
        });

    if (flagged((v, long) => (long ? /^--(?:command|noexec)$/i.test(v) : /[cn]/i.test(v)))) {
        return true;
    }
    if (flagged((v, long) => (long ? /^--stdin$/i.test(v) : /s/i.test(v)))) return false;
    return values.some((value) => !value.startsWith('-'));
}

/** Программа из `-c`: аргумент этого флага исполняется, а не передаётся как данные. */
function commandFlagArgument(args) {
    for (let i = 0; i < args.length; i += 1) {
        const { value } = args[i];
        if (value === '-c' || value === '--command') return args[i + 1]?.value ?? '';
        if (/^-[a-z]*c$/i.test(value)) return args[i + 1]?.value ?? '';
        if (value.startsWith('--command=')) return value.slice('--command='.length);
    }
    return '';
}

/**
 * Подстановки команды в сегменте — то, что оболочка исполнит и подставит результатом.
 *
 * Ищутся В ТЕКСТЕ, а не в токенах: `TAG=$(rm -rf /var)` при токенизации разваливается по
 * пробелам, и подстановка теряется. Содержимое одинарных кавычек предварительно
 * маскируется пробелами той же длины — там оболочка ничего не раскрывает, — а найденное
 * берётся из исходной строки по тем же смещениям.
 */
function substitutionsOf(segment) {
    const masked = segment.replace(/'([^']*)'/g, (_m, inner) => `'${' '.repeat(inner.length)}'`);
    const found = [];
    for (const re of SUBSTITUTION_RE) {
        for (const hit of masked.matchAll(re)) {
            const raw = segment.slice(hit.index, hit.index + hit[0].length);
            found.push(raw.replace(/^\$\(|^`|\)$|`$/g, ''));
        }
    }
    return found;
}

/**
 * Подстановка команды схлопывается в один токен той же длины: без этого `TAG=$(printf x)`
 * разваливается по пробелам, токен `x)` принимается за имя команды, и настоящая команда
 * за подстановкой теряется. Содержимое подстановок разбирается отдельно — `substitutionsOf`.
 */
const maskSubstitutions = (segment) =>
    segment
        .replace(/\$\(([\s\S]*?)\)/g, (m) => '_'.repeat(m.length))
        .replace(/`([\s\S]*?)`/g, (m) => '_'.repeat(m.length));

/**
 * Все вызовы команды — свои и вложенные.
 *
 * Вложенные берутся из трёх мест, и все три оболочка действительно исполняет: аргумент
 * `-c` у интерпретатора, подстановка команды (кроме той, что стоит в одинарных кавычках)
 * и тело heredoc'а, если его читает интерпретатор.
 */
function shellCalls(command, depth = 0) {
    if (depth > MAX_DEPTH || typeof command !== 'string') return [];
    const calls = [];
    const nested = [];

    const withoutHeredocs = command.replace(HEREDOC_RE, (match, quote, tag, body, offset) => {
        const owner = callOf(segmentsOf(command.slice(0, offset)).pop() ?? '');
        if (SHELL_NAMES.has(owner.name) && !shellSkipsStdin(owner.args)) {
            // Тело становится программой оболочки целиком.
            nested.push(body);
        } else if (!quote) {
            // Разделитель без кавычек: подстановки внутри тела оболочка раскроет.
            for (const re of SUBSTITUTION_RE) {
                for (const hit of body.matchAll(re)) nested.push(hit[1] ?? '');
            }
        }
        return `${' '.repeat(match.length - tag.length - 1)}\n${tag}`;
    });

    // Here-string (`bash <<< 'rm -rf x'`) — та же программа на stdin, что и heredoc,
    // только в одну строку (ревью, проход 5).
    const withoutHereStrings = withoutHeredocs.replace(
        /(^|[;|&\n(]\s*)([^\n;|&]*?)<<<\s*('([^']*)'|"([^"]*)"|\$\([^)]*\)|`[^`]*`|\S+)/g,
        (_match, lead, before, quoted, single, double) => {
            const owner = callOf(before);
            const body = single ?? double ?? quoted;
            if (SHELL_NAMES.has(owner.name) && !shellSkipsStdin(owner.args)) nested.push(body);
            return `${lead}${before}`;
        },
    );

    for (const segment of segmentsOf(withoutHereStrings)) {
        const call = callOf(maskSubstitutions(segment));
        // Вызов без имени, но с присваиваниями — это `export API_BASE_URL=…`: команды
        // нет, а переменная выставлена, и правилам это важно.
        if (call.name || call.assignments.length) calls.push(call);
        if (SHELL_NAMES.has(call.name)) nested.push(commandFlagArgument(call.args));
        nested.push(...substitutionsOf(segment));
        // `find … -exec rm -rf {} +` — команда, которую запустит find, а не его аргументы.
        if (call.name === 'find') {
            const argv = call.args.map(({ value }) => value);
            const at = argv.findIndex((arg) => arg === '-exec' || arg === '-execdir');
            if (at >= 0) {
                const until = argv.findIndex((arg, i) => i > at && (arg === ';' || arg === '+'));
                const inner = argv.slice(at + 1, until < 0 ? argv.length : until);
                // Разбираем как обычный вызов: после `-exec` бывают и обёртки, и
                // присваивания окружения (`env LC_ALL=C rm -rf`), и путь к бинарнику.
                if (inner.length) {
                    const execCall = callOf(inner.join(' '));
                    if (execCall.name || execCall.assignments.length) calls.push(execCall);
                }
            }
        }
    }

    for (const inner of nested) {
        if (inner) calls.push(...shellCalls(inner, depth + 1));
    }
    return calls;
}

/** Значения аргументов вызова — то, что программа получит после снятия кавычек. */
const argValues = (call) => call.args.map(({ value }) => value);

// --- Примитивы над аргументами вызова --------------------------------------
//
// Живут ЗДЕСЬ, а не в правилах: ими пользуются обе политики (`guard-shell.cjs` —
// деструктивные вызовы, `guard-host-services.cjs` — боевые службы хоста), и держать
// их в одной из них значило бы тянуть одну политику в другую ради разбора аргументов.

/**
 * Флаги вызова — токены с дефисом до `--`.
 *
 * Признаки рекурсии и принудительности ищутся среди ФЛАГОВ, а не подстрокой в хвосте
 * команды (#129): в имени `.tmp-check-literal-diff.mjs` находились `-liter` и `-dif`, и
 * точечное удаление двух черновиков отклонялось как рекурсивное — барьер запрещал ровно
 * то, что сам предписывает взамен, и обходился подбором глоба.
 */
function flagsOf(args) {
    const flags = [];
    for (const token of args) {
        if (token === '--') break;
        if (token.startsWith('-') && token.length > 1) flags.push(token);
    }
    return flags;
}

/** Позиционные аргументы: флаги менеджера и `pm` у bun пропускаются. */
const positionalArgs = (args) => args.filter((arg) => !arg.startsWith('-') && arg !== 'pm');

// Сетевые клиенты: у них есть понятие «адрес запроса», и на нём стоят два правила —
// сырой адрес и admin-порт Caddy.
const NET_CLIENTS = new Set(['curl', 'wget', 'xh', 'httpie', 'http']);

// Флаги, чей аргумент — ДАННЫЕ запроса, а не его адрес. Уведомление шлёт текст,
// в котором может быть что угодно, включая адрес; блокировать его значит ломать
// обычную работу.
const PAYLOAD_FLAG_RE = /^--?(?:d|data|data-raw|data-binary|data-urlencode|form|F|H|header)$/i;
const PAYLOAD_ASSIGN_RE = /^--(?:data|data-raw|data-binary|data-urlencode|form|header)=/i;

/**
 * Аргументы, которые вызов трактует как АДРЕС, а не как данные запроса. Разбор общий
 * для правила сырых адресов и для admin-порта Caddy (ревью #299): оба спрашивают «куда
 * вызов реально пойдёт», и оба ошибались бы одинаково, читая тело запроса как цель.
 */
function addressArgs(call) {
    const out = [];
    const args = argValues(call);
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (PAYLOAD_ASSIGN_RE.test(arg)) continue;
        if (PAYLOAD_FLAG_RE.test(arg)) {
            i += 1;
            continue;
        }
        out.push(arg);
    }
    return out;
}

module.exports = {
    addressArgs,
    argValues,
    basenameOf,
    flagsOf,
    NET_CLIENTS,
    positionalArgs,
    callOf,
    segmentsOf,
    shellCalls,
    SHELL_NAMES,
    tokenize,
};
