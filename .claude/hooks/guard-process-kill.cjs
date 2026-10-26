/**
 * Убийство процессов из сессии: только свой и только по литеральному pid (#196).
 *
 * Инцидент 22.09.2026 07:51 UTC: кодер-сессия освобождала порт своего dev-сервера
 * циклом `for p in $(ss -lntp | …); do … && kill $p; done`. Пока порт был занят, `kill`
 * получил КАЖДЫЙ слушающий pid хоста — Caddy (прод отвечал 000), userland-прокси dockerd
 * для портов прода, privoxy (прокси API самой сессии — она тут же упала),
 * tailscaled. Прод лежал ~14 минут, петля встала.
 *
 * Барьер соседей (`guard-host-services.cjs`) читает ИМЯ цели: `pkill caddy`,
 * `systemctl stop caddy`. У `kill $p` имени нет — цель известна только в момент
 * исполнения, и по тексту команды её не проверить. Отсюда правило в две половины:
 *
 *   • цель, которой нет в тексте (переменная, подстановка, stdin у `xargs kill`,
 *     имя или шаблон у `pkill`/`killall`, порт у `fuser -k`), запрещена целиком —
 *     не потому, что она обязательно чужая, а потому, что барьер не может сказать,
 *     чья она;
 *   • литеральный pid проверяется по `/proc`: потомок этой сессии или dev-сервер /
 *     тест-раннер, запущенный в её дереве, — свой; всё остальное — отказ с именем
 *     процесса, чтобы сессия видела, во что целилась.
 *
 * Сессия вахты идёт под тем же хуком и задета тем же правилом — осознанно: признак
 * «это вахта» в окружении сессия способна выставить себе сама (довод #472). Цена для
 * вахты — гасить чужие процессы через свои обёртки вне сессии, где команда
 * не проходит через хук.
 *
 * Таблица процессов читается через `deps.processInfo`, а не `fs` напрямую: тест
 * подменяет её, иначе он проверял бы хост, на котором идёт, а не правило. Отказ чтения
 * `/proc` (кроме «процесса нет») — это неисправность барьера, и `decide` роняет вызов
 * fail-closed, как любое исключение правила.
 *
 * CommonJS намеренно, как и у соседей: хук запускается до `npm ci`.
 */

const fs = require('node:fs');

const { argValues, basenameOf, flagsOf, positionalArgs } = require('./shell-calls.cjs');

/**
 * Гасят по имени, шаблону или порту — цели в тексте нет по построению. `kill-port` и
 * `fkill` — то, за чем JS-сессия тянется, когда порт занят (сценарий инцидента), и они
 * идут через `npx`, поэтому обёртка разбирается ниже. Граница правила названа честно:
 * `node -e "process.kill(600)"` и любой другой код, зовущий kill(2) изнутри, барьер по
 * тексту команды не видит, как и строку в кавычках у `watch -n1 'kill 600'` или
 * экранированное `\kill` — под `bypassPermissions` их закрыть нечем (довод
 * `shell-calls.cjs`: барьер против невидимости обычной правки, а не против строки,
 * собранной нарочно).
 */
const PATTERN_KILLERS = new Set(['pkill', 'killall', 'killall5', 'skill', 'kill-port', 'fkill']);
/** Запускают пакет по имени: `npx kill-port 3130` — тот же `kill-port`. */
const PACKAGE_RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
/** Гасят по порту: `fuser -k 3130/tcp`, а 80/443 и соседние порты держат прод и прокси хоста. */
const PORT_KILLERS = new Set(['fuser']);

/** Флаги `kill`, которые ничего не убивают: список сигналов и таблица. */
const KILL_LISTING_RE = /^(?:-l|-L|--list|--table)$/;
/** Флаги со значением-сигналом: следующее слово — сигнал, а не pid. */
const KILL_SIGNAL_VALUE_RE = /^(?:-s|-n|--signal)$/;
/** Сигнал 0 ничего не шлёт — это проверка «жив ли процесс», идиома любого ожидания. */
const ZERO_SIGNAL_RE = /^0$/;
const LITERAL_PID_RE = /^[1-9]\d*$/;
/** `$!` — pid последней фоновой команды ЭТОЙ оболочки; `%N` — её же задание. */
const OWN_SHELL_TARGET_RE = /^(?:\$!|%\d+)$/;
/** Команды, которые сессия запускает в своём дереве и вправе снять после себя. */
const TREE_TOOL_RE = /(?:^|[\s/])(?:next|vitest|playwright|next-server)(?:\s|$)/;
const MAX_ANCESTRY = 64;

const SAFE_WAY =
    ' Свой dev-сервер гаси по pid, запомненному при запуске (`$!`), или по номеру задания ' +
    '(`%1`); никогда — по списку слушателей хоста (ss/lsof/pgrep).';

/**
 * Живой `/proc`: имя, родитель, каталог и командная строка процесса; `null` — процесса
 * нет. Любой другой отказ чтения пробрасывается: барьер, не заглянувший в таблицу,
 * не вправе сказать «свой».
 */
function readProcessInfo(pid, procRoot = '/proc') {
    let status;
    try {
        status = fs.readFileSync(`${procRoot}/${pid}/status`, 'utf-8');
    } catch (error) {
        // Граница названа: на хосте с `hidepid=2` чужой процесс тоже даёт ENOENT и
        // читается как «нет». Этот хост монтирует /proc без hidepid, а сессия идёт
        // от root; смена того или другого — повод перечитать это место.
        if (error && error.code === 'ENOENT') return null;
        throw error;
    }
    const field = (name) => {
        const match = status.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'));
        return match ? match[1].trim() : '';
    };
    const readOr = (fn, fallback) => {
        try {
            return fn();
        } catch {
            return fallback;
        }
    };
    return {
        comm: field('Name'),
        ppid: Number(field('PPid')) || 0,
        cwd: readOr(() => fs.readlinkSync(`${procRoot}/${pid}/cwd`), ''),
        cmdline: readOr(
            () => fs.readFileSync(`${procRoot}/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim(),
            '',
        ),
    };
}

/** Цепочка предков от `pid` вверх (сам `pid` включительно), до pid 1 или обрыва. */
function ancestry(pid, processInfo) {
    const chain = [];
    let current = pid;
    for (let i = 0; i < MAX_ANCESTRY && current > 1; i += 1) {
        const info = processInfo(current);
        chain.push({ pid: current, info });
        if (!info) break;
        current = info.ppid;
    }
    return chain;
}

/**
 * Pid сессии: ближайший предок хука по имени `claude`. Без него (тест, чужой запуск)
 * сессией считается родитель самого хука — граница уже, чем tmux или systemd, под
 * которыми живут ВСЕ сессии хоста разом.
 */
function sessionPidOf(selfPid, processInfo) {
    const chain = ancestry(selfPid, processInfo);
    const session = chain.find((entry) => entry.info && entry.info.comm === 'claude');
    if (session) return session.pid;
    const self = chain[0] && chain[0].info;
    return self ? self.ppid : 0;
}

/**
 * Цель принадлежит сессии: её потомок либо инструмент, запущенный в её дереве.
 * Предок сессии (сама сессия, раннер, tmux, init) своим не бывает, даже если его cwd
 * совпадает с деревом: в контейнере гейта pid 1 — это `sh -c "<куб>"` в `/repo`
 * (ревью #196, major).
 */
function ownsProcess(pid, info, deps) {
    if (pid <= 1 || deps.sessionAncestors.has(pid)) return false;
    const chain = ancestry(info.ppid, deps.processInfo);
    if (chain.some((entry) => entry.pid === deps.sessionPid)) return true;
    const inTree = info.cwd === deps.sessionCwd || info.cwd.startsWith(`${deps.sessionCwd}/`);
    return inTree && TREE_TOOL_RE.test(info.cmdline);
}

/** Как назвать цель в отказе: сам токен после разбора — артефакт (`$`, `____`). */
function describeTarget(target) {
    if (/^_+$/.test(target)) return 'подстановка `…`';
    if (target.includes('$')) return `подстановка или переменная (${target.slice(0, 24)})`;
    return `«${target}»`;
}

/** Цели `kill`: слова после флагов, значения `-s`/`-n`/`--signal` пропущены. */
function killTargets(args) {
    const targets = [];
    let afterDashes = false;
    let zeroSignal = false;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (afterDashes) {
            targets.push(arg);
            continue;
        }
        if (arg === '--') {
            afterDashes = true;
            continue;
        }
        if (KILL_SIGNAL_VALUE_RE.test(arg)) {
            if (ZERO_SIGNAL_RE.test(args[i + 1] || '')) zeroSignal = true;
            i += 1;
            continue;
        }
        if (arg === '-0' || arg === '--signal=0') zeroSignal = true;
        if (arg.startsWith('-') && arg.length > 1) continue;
        targets.push(arg);
    }
    return { targets, zeroSignal };
}

/**
 * Не заглянув в таблицу процессов, барьер не вправе сказать «свой»: отказ с причиной
 * чтения, а не исключение — его хук и так блокирует, но без объяснения, что именно
 * не прочиталось.
 */
function procUnreadable(what, error) {
    const detail = error && error.message ? error.message : String(error);
    return (
        `${what} запрещён: таблицу процессов прочитать не удалось (${detail}), и барьер ` +
        'не может признать процесс своим — отказ fail-closed.' +
        SAFE_WAY
    );
}

function killVerdict(args, deps) {
    if (flagsOf(args).some((flag) => KILL_LISTING_RE.test(flag))) return null;
    const { targets, zeroSignal } = killTargets(args);
    if (zeroSignal) return null;
    if (targets.length === 0) {
        return (
            'kill без названной цели запрещён из сессии петли: pid придёт из stdin (`xargs ' +
            'kill`) или не придёт вовсе, и барьер не может сказать, чей он. Так 22.09.2026 ' +
            'сессия сняла Caddy, docker-proxy портов прода и privoxy — прод лежал 14 минут.' +
            SAFE_WAY
        );
    }
    for (const target of targets) {
        if (OWN_SHELL_TARGET_RE.test(target)) continue;
        if (!LITERAL_PID_RE.test(target)) {
            return (
                `kill по цели ${describeTarget(target)} запрещён из сессии петли: pid из подстановки, ` +
                'переменной или процесс-группы неизвестен до исполнения, а список слушателей ' +
                'хоста включает Caddy, docker-proxy портов прода и privoxy — так 22.09.2026 ' +
                'сессия положила прод на 14 минут.' +
                SAFE_WAY
            );
        }
        const pid = Number(target);
        let info;
        let owned;
        try {
            info = deps.processInfo(pid);
            if (!info) continue; // процесса уже нет — убивать нечего, `kill` откажет сам.
            owned = ownsProcess(pid, info, deps);
        } catch (error) {
            return procUnreadable(`kill ${pid}`, error);
        }
        if (!owned) {
            const why =
                pid <= 1 || deps.sessionAncestors.has(pid)
                    ? 'это предок самой сессии (сессия, раннер, tmux или init)'
                    : 'не потомок этой сессии и не dev-сервер её дерева';
            return (
                `kill ${pid} запрещён из сессии петли: pid ${pid} — ${info.comm}, ${why}. ` +
                'Боевые службы хоста снимает вахта или человек, а не кодер-сессия.' +
                SAFE_WAY
            );
        }
    }
    return null;
}

/**
 * Команда гасит процесс, которого барьер не может признать своим. Причина отказа —
 * почему нельзя и что делать вместо этого, а не только что запрещено.
 */
function killsForeignProcess(calls, options = {}) {
    const processInfo = options.processInfo || readProcessInfo;
    const selfPid = options.selfPid || process.pid;
    const sessionCwd = options.sessionCwd || process.cwd();
    let deps = null;
    for (const call of calls) {
        let name = basenameOf(call.name);
        const args = argValues(call);
        if (PACKAGE_RUNNERS.has(name)) {
            const pkg = positionalArgs(args)[0] || '';
            if (PATTERN_KILLERS.has(basenameOf(pkg))) name = basenameOf(pkg);
        }
        if (PATTERN_KILLERS.has(name)) {
            return (
                `${name} запрещён из сессии петли: цель по имени, шаблону или порту неизвестна до ` +
                'исполнения — под шаблон попадают и боевые процессы хоста, и собственная ' +
                'оболочка сессии (`pkill -f`).' +
                SAFE_WAY
            );
        }
        if (
            PORT_KILLERS.has(name) &&
            flagsOf(args).some((flag) => flag === '--kill' || /^-[a-z]*k[a-z]*$/i.test(flag))
        ) {
            return (
                `${name} -k запрещён из сессии петли: цель по порту — это любой процесс, ` +
                'который его держит, а 80/443 и соседние порты держат прод и прокси хоста.' +
                SAFE_WAY
            );
        }
        if (name !== 'kill') continue;
        if (!deps) {
            try {
                const sessionPid = sessionPidOf(selfPid, processInfo);
                const sessionAncestors = new Set(
                    ancestry(sessionPid, processInfo).map((entry) => entry.pid),
                );
                deps = { processInfo, sessionCwd, sessionPid, sessionAncestors };
            } catch (error) {
                return procUnreadable('свой pid', error);
            }
        }
        const reason = killVerdict(args, deps);
        if (reason) return reason;
    }
    return null;
}

module.exports = {
    killsForeignProcess,
    // Ради теста на поддельном `/proc`: живой в тесте проверял бы хост, а не разбор.
    readProcessInfo,
    // Перечни — ради теста и промпта сессии, как у соседей (#299).
    PATTERN_KILLERS,
    PORT_KILLERS,
};
