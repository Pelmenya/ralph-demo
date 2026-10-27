// Общий util-модуль без побочек (#232): `shq`/`positiveIntOrDefault`/`sleep` жили в
// копиях в ralph.js и telegram-notifier.ts (ревью PR #231) — правка в одной не доезжала
// до другой. Вынесены сюда по тому же приёму, что и guardSideEffect (#145,
// side-effect-guard.ts): общий модуль без cycle на ralph.js, требуется и через
// require() (CommonJS-entry ralph.js), и через import (telegram-notifier.ts —
// ESM-потребитель, уже фактически импортирует sleep/positiveIntOrDefault отсюда).
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
// Без побочек вовсе — guardSideEffect здесь не нужен (#138 не при чём: ни один экспорт
// не трогает диск/сеть/процессы).

// #133: sh() в ralph.js исполняет СТРОКУ через /bin/sh — любое значение, попадающее в
// неё (milestone/branch из конфига, номера PR и заголовки issues с публичного GitHub),
// обязано быть заквотировано. Одинарные кавычки в POSIX sh не интерпретируют вообще
// ничего, поэтому достаточно закрыть-экранировать-открыть на каждой одинарной кавычке
// внутри значения: don't → 'don'\''t'.
export function shq(value: unknown): string {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Строго typeof number, без приведения (#132): строка '80' из JSON-конфига — это
// опечатка, а не «странное число», и Number('80') тихо простил бы её вместо дефолта.
// value > 0: 0 — не «без ограничения», а бюджет без единого хода/попытки.
export function positiveIntOrDefault(value: unknown, dflt: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : dflt;
}

// #594: то же, что positiveIntOrDefault, но 0 — валидное значение, а не мусор. Нужен
// счётчикам ПОВТОРОВ (в отличие от бюджетов): 0 повторов — осмысленная настройка «не
// повторять, сразу стоп», и трактовать её как «возьми дефолт» значило бы молча включить
// повторы тому, кто их явно выключил.
export function nonNegativeIntOrDefault(value: unknown, dflt: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : dflt;
}

// #204-ревью: единый резолвер команды установки зависимостей. Дефолт `npm ci` жил в трёх
// местах (state-lock installFn + лог-строка, orchestrator getInstallCmd) — при смене дефолта
// их пришлось бы вспоминать все, а разъехавшись, лог сказал бы одно, а исполнилось другое.
// Пробельная строка трактуется как «не задано» (иначе installCmd: "  " запустил бы пустую
// команду) — тот же дух, что positiveIntOrDefault: кривое значение → дефолт, не тихая беда.
export function resolveInstallCmd(cfg?: { installCmd?: string } | null): string {
    const cmd = cfg && cfg.installCmd;
    return typeof cmd === 'string' && cmd.trim() ? cmd : 'npm ci';
}

// Синхронный sleep: раннер и телеграм-ретраи — синхронный код (execSync-хореография),
// event loop свободен, поэтому Atomics.wait — корректный способ подождать без busy-loop.
// Валидация ms на правильном слое (#232): Atomics.wait трактует NaN-таймаут как +∞ —
// вечный сон посреди прогона. Пока функция была приватной копией, защиту держали
// вызывающие (minutesOrDefault в ralph.js, комментарий у base в telegram-notifier.ts);
// теперь это общий API фреймворка — новый потребитель про эту мину не знает, поэтому
// отсекаем NaN/±∞/отрицательное здесь: нечего ждать — сразу возвращаемся.
export function sleep(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// #390: захваченный stdout/stderr упавшей кодер-сессии может процитировать env, в
// котором она запускалась (унаследованный процессом claude, инвариант №11), поэтому
// перед записью на диск гоняем его через тот же приём, что уже применяет
// telegram-notifier.ts к TG-токену — replaceAll ЗНАЧЕНИЯ секрета на '***', не паттерн.
// Пустые/undefined секреты пропускаем (иначе replaceAll('') вставил бы '***' между
// каждым символом строки).
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
    let redacted = text;
    for (const secret of secrets) {
        if (secret) redacted = redacted.replaceAll(secret, '***');
    }
    return redacted;
}

// Первая строка причины отказа — из ЧЕГО УГОДНО, а не только из `Error` (правка по
// ревью #269). `(e as Error).message` — приведение, а не проверка: на `throw 'timeout'`
// из чужой реализации шва (транспорт, HTTP-клиент, чужой рантайм) оно даёт `undefined`,
// и человек получает стоп петли без причины. Первая строка, а не весь текст: причина
// уходит в строку лога и в `detail` исхода, а стек там только мешает.
export function errorText(e: unknown): string {
    return String(e instanceof Error ? e.message : e).split('\n')[0];
}

// Окружение СЕТЕВОГО вызова git: интерактивный запрос кредов запрещён (задача 71).
//
// Без этого git при отсутствии кредов открывает `/dev/tty` и ждёт логин — не stdin, а именно
// tty, поэтому перенаправление ввода не спасает. В петле отвечать некому: вызов стоит до
// дедмана, петля не падает и причины в лог не пишет. Отказ здесь дешевле молчания. Раньше
// запрет стоял только у проводки на ветку фазы, а fetch и ls-remote остального ядра —
// включая перенесённые из копии потребителя — шли без него.
//
// Задача 30 добавила к запрету второй сценарий, тише первого: креды есть, но origin молчит
// (мёртвый прокси, отвалившийся туннель). Запрет промпта тут не помогает, помогает только
// срок. Срок держит `shArgv` (`timeoutMs` → `timeout` + `SIGKILL` у `execFileSync`), но
// убивает он лишь сам `git`: транспорт `git-remote-http` — его ребёнок, и после убийства
// родителя он остаётся сиротой, держащей сокет (проверено на стенде с молчащим сервером).
// Поэтому транспорту уходит свой детектор молчания — порог низкой скорости: меньше байта в
// секунду дольше `GIT_NETWORK_STALL_S`, и транспорт отказывает сам. Порог и срок разведены
// намеренно: порог ловит тишину и живую передачу не трогает, а срок — страховка поверх него
// и убивает git, даже когда байты идут. Равные, они обрывали бы медленный, но живой fetch
// крупной ветки ровно на пороге тишины. Значение пользователя, если он его задал, не
// перекрываем; короткий явный срок вызывающего порог укорачивает до себя.
//
// Транспорт `ssh://` / `git@` порог не накрывает: это переменные libcurl. Git по сроку
// вернётся вовремя (spawnSync отдаёт ETIMEDOUT и при внуке, держащем пайпы), но `ssh`
// останется сиротой с открытым соединением, как `git-remote-http` без порога. Своего
// `GIT_SSH_COMMAND` мы не ставим: он сильнее `core.sshCommand` и молча снял бы ключ и опции,
// которые пользователь задал в конфиге git. Ограничение названо, а не закрыто.
function gitNetworkEnv(
    env: NodeJS.ProcessEnv = process.env,
    timeoutMs: number = GIT_NETWORK_TIMEOUT_MS,
): NodeJS.ProcessEnv {
    const stallS = Math.min(GIT_NETWORK_STALL_S, Math.max(1, Math.ceil(timeoutMs / 1000)));
    return {
        ...env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_HTTP_LOW_SPEED_LIMIT: env.GIT_HTTP_LOW_SPEED_LIMIT ?? '1',
        GIT_HTTP_LOW_SPEED_TIME: env.GIT_HTTP_LOW_SPEED_TIME ?? String(stallS),
    };
}

// Порог тишины транспорта: минута без единого байта — канал мёртв. Это детектор молчания, а
// не предел длительности передачи.
export const GIT_NETWORK_STALL_S = 60;

// Жёсткий срок сетевого вызова git — страховка поверх порога тишины, а не детектор: живую
// медленную передачу он рвёт, поэтому стоит заметно выше порога. Десять минут — с запасом на
// fetch и push крупной ветки по медленному каналу и всё ещё ничто рядом с окном AFK, которое
// без срока уходило в ожидание целиком. Цена `SIGKILL` посреди обновления ссылок — брошенный
// `*.lock` в `.git`; при этом сроке её платит только вызов, который и так уже завис.
export const GIT_NETWORK_TIMEOUT_MS = 600_000;

// Подкоманды git, которые ходят в сеть. Остальные (`diff`, `status`, `rev-parse`, …) ни
// запрета, ни срока не получают: по сети они не ходят, а срок на них — источник мигания под
// нагрузкой. Список закрытый: новая сетевая подкоманда в ядре — повод дописать её сюда, и
// барьер `tests/git-network-calls.test.ts` смотрит в этот же список.
export const GIT_NETWORK_SUBCOMMANDS: readonly string[] = [
    'fetch',
    'pull',
    'push',
    'clone',
    'ls-remote',
];

// Глобальные опции git, за которыми идёт отдельный аргумент-значение. Список закрыт так же,
// как подкоманды: пропущенная опция отдала бы своё значение за подкоманду, и сетевой вызов
// ушёл бы без политики.
const GIT_GLOBAL_OPTS_WITH_VALUE = new Set([
    '-C',
    '-c',
    '--config-env',
    '--git-dir',
    '--work-tree',
    '--namespace',
]);

/** Подкоманда git из argv: первый аргумент после глобальных опций, иначе `null`. */
export function gitSubcommand(args: readonly string[]): string | null {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (GIT_GLOBAL_OPTS_WITH_VALUE.has(a)) {
            i++;
            continue;
        }
        if (a.startsWith('-')) continue;
        return a;
    }
    return null;
}

/** Вызов `file args` — сетевой вызов git. */
export function isGitNetworkCall(file: string, args: readonly string[]): boolean {
    const sub = file === 'git' ? gitSubcommand(args) : null;
    return sub !== null && GIT_NETWORK_SUBCOMMANDS.includes(sub);
}

export type GitNetworkOpts = { env: NodeJS.ProcessEnv; timeoutMs: number };

// Опции исполнителя argv, общие для всех модулей ядра, которые его принимают. Копия формы в
// каждом модуле расходилась бы молча: задача 30 правила шесть копий по одной.
export type ExecOpts = { env?: NodeJS.ProcessEnv; timeoutMs?: number };

/** Исполнитель argv без шелла — форма `shArgv`, которую модули ядра получают инъекцией. */
export type ShArgvFn = (file: string, args: string[], opts?: ExecOpts) => string;

/** Опции сетевого вызова git: запрет промпта кредов и срок — всегда парой. */
export function gitNetworkOpts(
    env: NodeJS.ProcessEnv = process.env,
    timeoutMs: number = GIT_NETWORK_TIMEOUT_MS,
): GitNetworkOpts {
    return { env: gitNetworkEnv(env, timeoutMs), timeoutMs };
}

/**
 * Опции запуска, которые `shArgv` применит на деле. Сетевой git получает запрет промпта и
 * срок, даже если вызывающий их не передал: забытая опция у нового вызова — ровно тот
 * дефект, из которого выросла задача 30, и закрывать его нужно на единственном пути
 * исполнения, а не просьбой к каждому месту вызова. Явный срок вызывающего уважается.
 */
export function execPolicy(file: string, args: readonly string[], opts: ExecOpts): ExecOpts {
    if (!isGitNetworkCall(file, args)) return { env: opts.env, timeoutMs: opts.timeoutMs };
    const timeoutMs = opts.timeoutMs ?? GIT_NETWORK_TIMEOUT_MS;
    return { env: gitNetworkEnv(opts.env ?? process.env, timeoutMs), timeoutMs };
}

/**
 * Отказ по сроку называется сроком. Голый `spawnSync … ETIMEDOUT` или код убитого процесса
 * уводит разбор по ложному следу — «git сломался», «нет кредов», — тогда как на деле молчит
 * канал. Ошибка без `stderr` намеренно: `gitErrorText` читает его первым, и обрывок вывода
 * убитого процесса заслонил бы причину.
 */
export class ExecTimeoutError extends Error {
    constructor(file: string, args: readonly string[], timeoutMs: number) {
        super(
            `срок ${formatTimeout(timeoutMs)} истёк — ${file} ${args.join(' ')} убит: ` +
                'ответа нет (сеть, прокси или туннель молчат)',
        );
        this.name = 'ExecTimeoutError';
    }
}

// Срок в сообщении: короткий не округляется в «0 с» — срок, которого будто не было,
// отправил бы разбор искать что угодно, кроме срока.
function formatTimeout(ms: number): string {
    return ms < 1000 ? `${ms} мс` : `${Math.ceil(ms / 1000)} с`;
}

/** Отказ — истёкший срок (свой `ExecTimeoutError` или сырой `ETIMEDOUT` процесса). */
export function isExecTimeout(e: unknown): boolean {
    if (e instanceof ExecTimeoutError) return true;
    return (e as { code?: unknown } | null)?.code === 'ETIMEDOUT';
}

// Разбор отказа git из `execFileSync` — один на ядро (ревью #66/#85). Три копии жили в
// `phase-branch.ts`, `main-sync.ts`, `session-push.ts`, и правка одной (скажем, на `stderr`
// типа Buffer) разъехалась бы с остальными молча.

/** Код возврата git: по нему отличают ответ «нет» (1/2 у отдельных команд) от отказа. */
export function gitExitStatus(e: unknown): number | null {
    const status = (e as { status?: unknown } | null)?.status;
    return typeof status === 'number' ? status : null;
}

/**
 * Причина отказа git для лога и пуша человеку. Берётся stderr, иначе текст исключения;
 * строка `Command failed: …` — это команда, а не ответ, и пропускается. Одной строки мало:
 * у `git fetch` первая — `fatal: unable to access '…'`, а DNS/TLS/403 стоят следующей,
 * поэтому до трёх строк ответа склеиваются через « / ». Стек на пол-экрана не нужен тоже.
 */
export function gitErrorText(e: unknown): string {
    const err = (e ?? {}) as { stderr?: unknown; message?: unknown };
    const stderr = err.stderr === undefined || err.stderr === null ? '' : String(err.stderr);
    const raw = stderr.trim() || String(err.message ?? e).trim();
    const lines = raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('Command failed:'));
    return lines.length > 0 ? lines.slice(0, 3).join(' / ') : raw;
}
