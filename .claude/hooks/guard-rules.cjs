/**
 * Правила границы безопасности — отдельно от самого хука, чтобы их можно было
 * проверить тестом (`.claude/hooks/guard-rules.test.ts`).
 *
 * Барьер обязан ловить **смысл действия, а не строку**: переставленные буквы флага
 * или другая оболочка не должны его обходить. Поэтому проверяется наличие признаков
 * (рекурсия + принудительность), а не конкретная запись команды.
 *
 * CommonJS намеренно: хук запускается до `npm ci` и обязан работать в любом окружении.
 */

// .env, .env.local, apps/api/.env, ralph.env — но НЕ .env.example / .env.sample
//
// Имя с префиксом (`ralph.env`, `app.env`) закрыто наравне с точка-env: секреты
// в нём те же, а до #382 такой файл проходил барьер целиком — и на чтение, и в команде.
const ENV_FILE_RE =
    /(^|[\\/])(?:\.env(\.(?!example|sample)[\w.-]+)?|[\w.-]+\.env(\.(?!example|sample)[\w.-]+)?)$/i;
// то же для упоминания внутри shell-команды: имя env-файла после пробела/слэша/кавычки
// /начала строки; `)` закрывает подстановки вида `$(grep ... /path/to/ralph.env)`.
const CMD_ENV_RE =
    /(^|[\s\\/"'=@])(?:\.env(\.(?!example|sample)[\w.-]+)?|[\w.-]+\.env(\.(?!example|sample)[\w.-]+)?)(?=\s|$|["';|)])/i;
// команды, которые действительно вычитывают или отправляют содержимое файла
const SECRET_READER_RE =
    /\b(cat|type|less|more|head|tail|cp|copy|scp|curl|wget|Get-Content|gc|grep)\b/i;

/**
 * Команды, которые получают путь env-файла аргументом и НЕ читают его содержимое: смотрят
 * метаданные, создают, удаляют, печатают сам аргумент. Всё прочее с путём env-файла в
 * аргументах — чтение или отправка.
 *
 * Список разрешённых, а не запрещённых, — по ревью Kimi: `SECRET_READER_RE` ниже знал
 * десяток читающих команд, и `sed -n p .env`, `awk 1 .env`, `base64 .env` проходили
 * насквозь. Читающих команд бесконечно много, нечитающих — горсть.
 */
const ENV_SAFE_COMMANDS = new Set([
    'ls',
    'stat',
    'test',
    '[',
    'file',
    'touch',
    'rm',
    'chmod',
    'echo',
    'printf',
    'realpath',
    'basename',
    'dirname',
]);

/** Аргумент — путь env-файла: без пробелов (это не текст сообщения), флаг `--x=` снят. */
function isEnvPathArg(arg) {
    const value = arg.replace(/^--?[\w-]+=/, '');
    return value !== '' && !/\s/.test(value) && ENV_FILE_RE.test(value);
}

/** Вызов, который получает env-файл аргументом и не входит в нечитающие. */
function readsEnvFile(calls) {
    for (const call of calls) {
        if (ENV_SAFE_COMMANDS.has(basenameOf(call.name))) continue;
        if (argValues(call).some(isEnvPathArg)) return basenameOf(call.name);
    }
    return null;
}

const {
    destructiveCall,
    rawAddressTarget,
    mutatesManifest,
    shellCalls,
    skipsGitHooks,
} = require('./guard-shell.cjs');
const { touchesHostService } = require('./guard-host-services.cjs');
const { killsForeignProcess } = require('./guard-process-kill.cjs');
const { argValues, basenameOf } = require('./shell-calls.cjs');

// --- MCP -------------------------------------------------------------------
//
// У MCP-вызова нет ни командной строки, ни пути к файлу — правила выше про него
// ничего сказать не могут, и до этой правки он проходил барьер насквозь
// (matcher хука знал только Bash|Read|Edit|Write). Для сессий с
// `bypassPermissions` это означало канал без единой проверки.
//
// Политика — **allowlist**: неизвестное запрещено. Blocklist дал бы дыру ровно
// на том, чего мы ещё не видели: подключённый завтра сервер получил бы полный
// доступ молча.

// Инструмент MCP узнаётся по ПРЕФИКСУ `mcp__`, и только по нему.
//
// Раньше здесь стоял класс имени сервера (`[a-z0-9-]+`), и это была дыра, а не строгость:
// сервер с подчёркиванием в имени (`mcp__my_server__DeleteEverything`) под регэксп не
// подходил, значит ветку MCP в `decide` не открывал вовсе — и allowlist его не проверял.
// Инструмент, о котором барьер ничего не знает, проходил насквозь. Проверено прогоном
// (проход 5 ревью): `mcpAllowed` возвращал false, а `decide` — «разрешено».
//
// Имена серверов задаёт не наша конвенция, а тот, кто сервер подключил: угадывать их
// алфавит — значит выбирать, каких серверов барьер не заметит. Опознаём по префиксу,
// решение принимает allowlist ниже.
const MCP_TOOL_RE = /^mcp__/i;

// Запрет сильнее любого разрешения ниже: секреты, права, приглашения, удаление,
// перенос и форк. `ListSecrets` — формально чтение, но читает оно секреты.
//
// `file_upload` и `*_unsafe` — из того же ряда, но по другой причине:
// browser_file_upload читает ЛОКАЛЬНЫЙ файл и отдаёт его открытой странице, то есть
// уносит `ralph.env` наружу мимо ENV_FILE_RE (тот сторожит Read/Edit/Write и оболочку,
// про браузер он не знает). Барьер, который обходится соседним инструментом, — не барьер.
const MCP_NEVER_RE = /(secret|role|invite|delete|discard|fork|transfer|file_upload|unsafe)/i;

// Точечные вычеты из запрета выше. Список — ПОЛНЫЕ ИМЕНА, а не шаблон: широкий запрет по
// слову остаётся на месте, из него вынимается ровно одно проверенное имя. Ослабить сам
// регэксп было бы дешевле и хуже — под `discard` попадают ещё и удаление релизов
// (`DiscardByTag`/`DiscardByID`), которым здесь делать нечего.
//
// Почему закрытие PR вычтено: критерий барьера — цена ошибки, а не звучание слова.
// Отменённый PR возвращается (`ReopenPullRequest`), тогда как разрешённый рядом
// `MergePullRequest` необратим и отправляет код в main. Пропускать необратимое и
// блокировать обратимое — охранять не то. Нужда живая: squash-мердж ломает стопку PR
// (ветка от смердженной конфликтует сама с собой), ветку-замену приходится заводить новым
// PR, а старый висит открытым, и убрать его должен тот, кто его завёл.
//
// Обратимость — не слова, а сверка со спекой площадки
// (https://api.sourcecraft.tech/sourcecraft.swagger.json, проверено 11.08.2026):
//   • отмена закрытия ЕСТЬ — `POST /repos/{org}/{repo}/pulls/{slug}/reopen`, и
//     `ReopenPullRequest` разрешён ниже;
//   • отмены мерджа НЕТ — маршрутов revert/undo/unmerge в спеке не существует, а статус
//     `merged` у PR терминальный (`draft|open|discarded|merging|merged`). Обратный коммит
//     в git — это НОВЫЙ коммит, а не отмена: код уже был в main. Разрешить
// закрытие, оставив отмену за бортом, значило бы обосновать вычет обратимостью и тут же
// её отнять: агент отменил бы чужой PR и не смог бы вернуть — чинить пришлось бы человеку.
//
// Исключение НЕ отменяет второй гейт: имя обязано быть ещё и в MCP_WRITE_ALLOWED.
const MCP_NEVER_EXCEPTIONS = new Set(['mcp__sourcecraft__DiscardPullRequest']);

// Чтение у любого сервера: List*/Get* и list_*/get_* — оба стиля именования методов.
//
// Имя разбирается РАЗБИЕНИЕМ по `__`, а не регэкспом с ленивым `\S+?`: тот брал за границу
// сервера первое же попавшееся `__get`, и `mcp__sync__get__CreateReport` (сервер `sync__get`,
// метод — мутация) считался чтением и проходил (проход 6 ревью, проверено прогоном).
//
// Больше трёх частей — имя неоднозначное: где кончается сервер и начинается метод, знает
// только площадка. Такое имя чтением НЕ считается и уходит в allowlist мутаций, то есть
// по умолчанию блокируется. Fail-closed здесь дешевле: ложный отказ на экзотическом имени
// стоит одной записи в allowlist, пропуск — неизвестной мутации.
function mcpReadCall(toolName) {
    const parts = toolName.split('__');
    return parts.length === 3 && /^(list|get)/i.test(parts[2]);
}

// Мутации, без которых не идёт работа: очередь задач, PR, метки, вехи, прогоны.
const MCP_WRITE_ALLOWED = new Set([
    'mcp__sourcecraft__CreateIssue',
    'mcp__sourcecraft__CreateIssueByID',
    'mcp__sourcecraft__UpdateIssue',
    'mcp__sourcecraft__UpdateIssueByID',
    'mcp__sourcecraft__CreateIssueComment',
    'mcp__sourcecraft__UpdateIssueComment',
    'mcp__sourcecraft__CreateIssueLink',
    'mcp__sourcecraft__AddLabels',
    'mcp__sourcecraft__AddLabelsByID',
    'mcp__sourcecraft__RemoveLabels',
    'mcp__sourcecraft__ReplaceLabels',
    'mcp__sourcecraft__CreateLabel',
    'mcp__sourcecraft__UpdateLabel',
    'mcp__sourcecraft__AddPullRequestLabels',
    'mcp__sourcecraft__RemovePullRequestLabels',
    'mcp__sourcecraft__CreatePullRequest',
    'mcp__sourcecraft__UpdatePullRequest',
    'mcp__sourcecraft__PublishPullRequest',
    'mcp__sourcecraft__CreatePullRequestComment',
    'mcp__sourcecraft__UpdatePullRequestComment',
    'mcp__sourcecraft__MergePullRequest',
    // Закрытие PR без мерджа. Разрешено по ОБРАТИМОСТИ, а не по «оно безобидное»:
    // отменённый PR возвращается (`ReopenPullRequest`), тогда как соседний
    // `MergePullRequest` необратим и отправляет код в main. Барьер, пропускающий
    // необратимое и блокирующий обратимое, охраняет не то. Нужда живая: squash-мердж
    // ломает стопку PR (ветка от смердженной конфликтует сама с собой), и ветку-замену
    // приходится заводить новым PR — а старый висел бы вечно.
    'mcp__sourcecraft__DiscardPullRequest',
    // Отмена закрытия — та самая обратимость, на которой держится вычет выше. Под запрет
    // по имени не попадает, но без явного разрешения агент мог бы закрыть и не вернуть.
    'mcp__sourcecraft__ReopenPullRequest',
    'mcp__sourcecraft__AddLinkedPRs',
    // Снятие связи issue↔PR. Разрешено по той же ОБРАТИМОСТИ, что и закрытие PR: связь
    // ставится обратно `AddLinkedPRs`, который разрешён строкой выше, — то есть ошибка
    // здесь стоит одного вызова, а не разбора человеком.
    //
    // Нужда живая и проверена на себе 28.08: площадка вяжет PR к карточке по голому `#N`
    // в описании, и два документационных PR приехали к Issue #1 просто потому, что в их
    // тексте стояло «Issue #1». Правка описания связь НЕ убирает — она остаётся
    // в `linked_issues`. До этой записи чинить было нечем вовсе.
    //
    // Барьер против САМОГО промаха при этом остаётся на месте и не ослабляется: текстовое
    // правило ниже по-прежнему не выпускает наружу `#N` чужого трекера. Разница в том, что
    // раньше проскочившая связь была вечной, а теперь чинится.
    'mcp__sourcecraft__RemoveLinkedPRs',
    // SetDecision НАМЕРЕННО отсутствует: это одобрение ревью (approve/trust/block),
    // а не мутация рабочего цикла. С 01.08.2026 `review.yaml` требует ship человека
    // на путях ядра — при `ignore_self_ship: false` и одном активном аккаунте агент,
    // имея SetDecision, удовлетворял бы требование сам, и барьер сторожил бы пустоту.
    // Одобрение ставит человек руками в интерфейсе.
    'mcp__sourcecraft__CreateMilestone',
    'mcp__sourcecraft__UpdateMilestone',
    'mcp__sourcecraft__RunWorkflow',
    'mcp__sourcecraft__AddReaction',
]);

/** Разрешён ли MCP-вызов. Порядок важен: «никогда» перекрывает чтение. */
function mcpAllowed(toolName) {
    if (MCP_NEVER_EXCEPTIONS.has(toolName)) return MCP_WRITE_ALLOWED.has(toolName);
    if (MCP_NEVER_RE.test(toolName)) return false;
    if (mcpReadCall(toolName)) return true;
    return MCP_WRITE_ALLOWED.has(toolName);
}

const ALLOWED = { blocked: false, reason: null };

/** Инструменты, у которых в аргументах — путь к файлу. */
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep']);

/**
 * Решение по вызову инструмента.
 *
 * @param {string} toolName — имя инструмента из PreToolUse
 * @param {Record<string, unknown>} toolInput — его аргументы
 * @returns {{ blocked: boolean, reason: string | null }}
 */
/**
 * `options` — подмена окружения ТОЛЬКО для тестов правила про kill (#196): таблица
 * процессов, pid хука и дерево сессии. Хук зовёт `decide` двумя аргументами и читает
 * живой `/proc`.
 */
function decide(toolName, toolInput, options = {}) {
    const input = toolInput || {};

    if (MCP_TOOL_RE.test(toolName) && !mcpAllowed(toolName)) {
        return {
            blocked: true,
            reason:
                `Инструмент ${toolName} не в allowlist MCP. Разрешены чтение (List*/Get*, ` +
                'кроме секретов) и мутации рабочего цикла: issues, PR, метки, вехи. ' +
                'Нужен новый — добавляй в MCP_WRITE_ALLOWED отдельным PR с обоснованием.',
        };
    }

    // Все файловые инструменты, а не три: `MultiEdit` и `NotebookEdit` пишут файл тем же
    // путём, а `Grep` с `output_mode: content` ЧИТАЕТ его содержимое (ревью Kimi) — для
    // секрета это тот же Read. `glob` у Grep — тоже адрес файла: `glob: ".env"`.
    if (FILE_TOOLS.has(toolName)) {
        const filePath = [input.file_path, input.notebook_path, input.path, input.glob]
            .filter((v) => typeof v === 'string')
            .find((v) => ENV_FILE_RE.test(v));
        if (filePath) {
            return {
                blocked: true,
                reason:
                    `Доступ к ${filePath} заблокирован: файлы .env содержат секреты. ` +
                    'Используй .env.example для структуры переменных.',
            };
        }
        return ALLOWED;
    }

    if (toolName === 'Bash') {
        const cmd = typeof input.command === 'string' ? input.command : '';
        // Все правила ниже, кроме двух текстовых, судят СПИСОК ВЫЗОВОВ, а не строку.
        const calls = shellCalls(cmd);

        // Упоминание .env блокируем только вместе с командой, которая его читает
        // или отправляет наружу: иначе запрет накрыл бы и разговор о файле.
        if (CMD_ENV_RE.test(cmd) && SECRET_READER_RE.test(cmd)) {
            return {
                blocked: true,
                reason: 'Команда заблокирована: чтение/копирование .env файлов запрещено (секреты).',
            };
        }
        // То же по СПИСКУ ВЫЗОВОВ: любая команда вне нечитающих с путём env-файла в
        // аргументах. Текстовое правило выше остаётся — оно видит перенаправление
        // (`< .env`) и подстановки, которых в аргументах вызова нет.
        const envReader = readsEnvFile(calls);
        if (envReader) {
            return {
                blocked: true,
                reason:
                    `Команда заблокирована: ${envReader} получает env-файл аргументом, а его ` +
                    'содержимое — секреты. Структуру переменных смотри в .env.example.',
            };
        }

        // `--no-verify` отключает git-хуки, то есть и проверку сообщения коммита —
        // а её обход стоит неснимаемой связи с чужой карточкой. Правило репозитория
        // («--no-verify не используется») до сих пор держалось на дисциплине; теперь
        // на барьере. Упал хук — правится причина.
        // Правило смотрит ВЫЗОВ, как и соседние: разговор о команде вызовом не является,
        // а `git commit` внутри `sh -c` — является (ревью, проход 5: здесь оставалась
        // регулярка по строке, и журнал утверждал обратное).
        if (skipsGitHooks(calls)) {
            return {
                blocked: true,
                reason:
                    'git commit --no-verify запрещён: он отключает проверку сообщения ' +
                    'коммита, а её обход стоит неснимаемой связи PR с чужой карточкой. ' +
                    'Упал хук — правь причину, а не выключай хук.',
            };
        }

        // Манифест правится ФАЙЛОМ, а не командой (#131).
        //
        // 20.08.2026 сессии понадобился SHA второй копии ядра. Прямой `git -C <чужое дерево>`
        // тогда упирался в список разрешений (сессии ещё шли не под bypass; сегодня он
        // не закрыт ничем — это отдельная тема, не эта), и она обошла его так: `npm pkg set
        // scripts.tmp="node -e …"` → `npm run tmp` → `npm pkg delete scripts.tmp`. Кода
        // в дифф не попало ни строки, а исполнилось всё.
        //
        // Барьер узкий намеренно: он закрывает не «выполнение произвольного кода» —
        // под bypassPermissions его закрыть нечем, любая команда и так исполнится, —
        // а его НЕВИДИМОСТЬ. Всё, что исполняется, обязано лежать в диффе: тогда его
        // сторожат ревью и гейт. Побочно снимается гонка:
        // упади сессия между `set` и `delete`, временный скрипт уехал бы в коммит.
        //
        // Правило смотрит на ВЫЗОВ, а не на строку: `rg -n "npm pkg set"` ищет по
        // каталогу, а не мутирует манифест.
        if (mutatesManifest(calls)) {
            return {
                blocked: true,
                reason:
                    'Правка package.json из оболочки запрещена: она не попадает в дифф, ' +
                    'а значит мимо ревью и гейта. Нужен новый скрипт — правь файл через ' +
                    'Edit/Write. Нужен разовый расчёт — считай его прямо в команде.',
            };
        }

        // Дальше правила смотрят на СПИСОК ВЫЗОВОВ (`shell-calls.cjs`): упоминание команды
        // в тексте вызовом не является, а вложенные вызовы из `sh -c`, подстановки и
        // heredoc'а, который читает оболочка, в список входят (#173).
        const rawAddress = rawAddressTarget(calls);
        if (rawAddress) {
            return {
                blocked: true,
                reason:
                    `Сетевой вызов на голый адрес ${rawAddress} заблокирован. У адреса без ` +
                    'имени нечего проверить: ни домена, ни владельца. Ходи по имени хоста, ' +
                    'а если адрес действительно нужен — поднимай его сам и зови по localhost.',
            };
        }
        const destructive = destructiveCall(calls);
        if (destructive) {
            return { blocked: true, reason: `Команда заблокирована: ${destructive}` };
        }

        // Сессия петли идёт в оболочке ХОСТА, где рядом крутится прод (#299): она не
        // ревьюер с ограниченным доступом, а полноценный шелл, и то, что для CI —
        // «локальная проверка», для хоста — боевая служба. Правило смотрит на ВЫЗОВ,
        // как соседние: `git log --grep 'systemctl stop caddy'` вызовом не является.
        const hostService = touchesHostService(calls);
        if (hostService) {
            return { blocked: true, reason: hostService };
        }

        // Цель `kill` без имени в тексте (`kill $p`, `xargs kill`, `pkill`, `fuser -k`)
        // барьер служб не видит — ей нечем совпасть с перечнем. Инцидент 22.09.2026:
        // цикл по списку слушателей хоста снял Caddy, docker-proxy и privoxy (#196).
        const foreignKill = killsForeignProcess(calls, options);
        if (foreignKill) {
            return { blocked: true, reason: foreignKill };
        }
    }

    return ALLOWED;
}

module.exports = {
    decide,
    ENV_FILE_RE,
    CMD_ENV_RE,
    mcpAllowed,
};
