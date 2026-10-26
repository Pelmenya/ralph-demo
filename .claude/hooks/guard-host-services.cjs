/**
 * Службы хоста: что из команды оболочки их трогает — и почему это запрещено.
 *
 * Петля идёт в оболочке ХОСТА, а не в песочнице: рядом с ней на той же машине может
 * крутиться чужой прод, воркер CI и сетевые прокси, через которые ходит сама сессия.
 * У потребителя этот барьер родился из двух инцидентов (06.09.2026 — `caddy stop` ушёл
 * в admin боевого экземпляра; ревью #299 — `systemctl reload`, `docker compose down`,
 * `docker system prune -af` как короткие пути к тому же простою) и вырос в перечень
 * БОЕВЫХ имён: какие юниты и контейнеры держат прод.
 *
 * В каноне перечня имён нет, и это решение, а не упрощение. Имена юнитов и контейнеров
 * прода — след конкретной машины, а публичный канон их нести не может
 * (`tests/project-traces.ts`). Вместо «не трогай вот эти» правило здесь строже:
 * «не трогай ничего». Канону для работы не нужен ни systemctl, ни docker, ни Caddy —
 * это библиотека на Node с vitest, и запрет без исключений ничего у сессии не отнимает.
 * Когда барьер станет частью продукта с настройкой под хост (Фаза 11), исключения
 * приедут конфигом установки, а не строкой в коде.
 *
 * CommonJS намеренно, как и у соседей: хук запускается до `npm ci`.
 */

const {
    addressArgs,
    argValues,
    basenameOf,
    flagsOf,
    NET_CLIENTS,
    positionalArgs,
} = require('./shell-calls.cjs');

// Без явного `--address` эти подкоманды говорят с ЕДИНСТВЕННЫМ admin-эндпоинтом хоста:
// «тестовый» экземпляр для демона неотличим от боевого. `validate` и `adapt` ничего
// не запускают и с эндпоинтом не разговаривают — они разрешены.
const CADDY_UNSAFE_SUBCOMMANDS = new Set(['start', 'stop', 'reload', 'run']);

// Действия, меняющие состояние ЛЮБОГО юнита. Юнит не сверяется: свои юниты у сессии
// канона не появляются, а чужой по имени не отличить от боевого. `status`, `show`,
// `list-units`, `is-active` — чтение, они проходят. `enable` сам по себе состояния
// службы не меняет и опасен только с `--now` — его ловит проверка флага ниже.
const HOST_UNIT_ACTIONS = new Set([
    'start',
    'stop',
    'restart',
    'reload',
    'reload-or-restart',
    'try-restart',
    'force-reload',
    'kill',
    'disable',
    'mask',
]);

// Мутации docker. Читающие (`ps`, `logs`, `inspect`, `images`) проходят; создающие
// (`run`, `build`, `exec`) тоже — они не снимают чужого. `prune` здесь потому, что
// откат прода держится на теге образа, на который не ссылается ни один контейнер, и
// `docker system prune -af` уносит его вместе с прочими «неиспользуемыми».
const DOCKER_UNSAFE_SUBCOMMANDS = new Set([
    'stop',
    'kill',
    'restart',
    'pause',
    'rm',
    'rmi',
    'down',
    'prune',
]);
// Управляющие команды: действие у них не первое слово, а второе (`docker compose down`,
// `docker image rm`). Без этого перечня `docker system prune -af` читался бы действием
// `system` и проходил насквозь.
const DOCKER_MANAGEMENT = new Set([
    'compose',
    'container',
    'service',
    'stack',
    'swarm',
    'image',
    'volume',
    'system',
    'network',
]);
// Флаги docker со ЗНАЧЕНИЕМ: иначе `docker compose -f compose.yaml down` дал бы
// действием путь к файлу. У `compose` свой набор: там `-f` — файл, а у клиента — `--force`.
const DOCKER_VALUE_FLAG_RE = /^--?(?:H|host|context|log-level|c|config|t|time|s|signal)$/i;
const DOCKER_COMPOSE_VALUE_FLAG_RE =
    /^--?(?:f|file|p|project-name|project-directory|profile|env-file)$/i;
// Admin-эндпоинт Caddy по HTTP: `curl -X POST localhost:2019/stop` гасит боевой процесс
// без единого упоминания `caddy`. Порт закрыт целиком, без разбора метода: различать
// чтение и мутацию по `-X` — гадание по флагу.
const CADDY_ADMIN_RE = /(?:^|\/\/|@)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1):2019\b/i;

/** Позиционные слова вызова docker: значения флагов пропущены. */
function dockerWords(args) {
    const words = [];
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        const composeFlag = words[0] === 'compose' && DOCKER_COMPOSE_VALUE_FLAG_RE.test(arg);
        if (DOCKER_VALUE_FLAG_RE.test(arg) || composeFlag) {
            i += 1;
            continue;
        }
        if (arg.startsWith('-')) continue;
        words.push(arg.toLowerCase());
    }
    return words;
}

/** Действие: первое слово, а у управляющих команд — второе. */
const dockerAction = (words) => (DOCKER_MANAGEMENT.has(words[0]) ? words[1] : words[0]);

const WHY_HOST =
    ' Сессии канона службы хоста не нужны: рядом может работать чужой прод, и его ' +
    'остановка — решение вахты или человека, а не кодер-сессии.';

/**
 * Команда меняет состояние службы хоста. Причина отказа — почему нельзя, а не только
 * что запрещено: это подсказывает замену.
 */
function touchesHostService(calls) {
    for (const call of calls) {
        const args = argValues(call);
        const positional = positionalArgs(args);
        const name = basenameOf(call.name);

        if (name === 'caddy') {
            const sub = positional[0]?.toLowerCase();
            if (sub && CADDY_UNSAFE_SUBCOMMANDS.has(sub)) {
                return (
                    `caddy ${sub} запрещён из сессии петли: admin-эндпоинт (localhost:2019) ` +
                    'один на хост, и команда без --address говорит с боевым экземпляром. ' +
                    'caddy validate и caddy adapt разрешены.' +
                    WHY_HOST
                );
            }
        }

        // `systemctl stop x` и `service x stop` — одно действие в двух записях, поэтому
        // действие ищется среди ВСЕХ позиционных, а не по позиции: так же закрыт
        // `systemctl --signal SIGKILL kill x`, где значение флага заняло слот действия.
        if (name === 'systemctl' || name === 'service') {
            const action = positional
                .map((a) => a.toLowerCase())
                .find((a) => HOST_UNIT_ACTIONS.has(a));
            if (action) return `${name} ${action} запрещён из сессии петли.` + WHY_HOST;
            if (flagsOf(args).some((f) => /^--now$/i.test(f))) {
                return `${name} … --now запрещён из сессии петли.` + WHY_HOST;
            }
        }

        if (name === 'docker') {
            const action = dockerAction(dockerWords(args));
            if (action && DOCKER_UNSAFE_SUBCOMMANDS.has(action)) {
                return `docker ${action} запрещён из сессии петли.` + WHY_HOST;
            }
        }

        // Адрес ищется среди АРГУМЕНТОВ-АДРЕСОВ, а не среди всех: `curl --data "…:2019…"`
        // шлёт этот адрес ТЕКСТОМ на чужой хост, и это обычная работа нотифаера.
        if (NET_CLIENTS.has(name) && addressArgs(call).some((arg) => CADDY_ADMIN_RE.test(arg))) {
            return (
                'запрос на localhost:2019 запрещён из сессии петли: это admin-эндпоинт ' +
                'Caddy, и POST на /stop гасит его ровно так же, как `caddy stop`.' +
                WHY_HOST
            );
        }
    }
    return null;
}

module.exports = {
    touchesHostService,
    // Перечни экспортируются РАДИ ТЕСТА: он генерирует кейс на каждый элемент, и забытая
    // при расширении подкоманда падает сама.
    CADDY_UNSAFE_SUBCOMMANDS,
    HOST_UNIT_ACTIONS,
    DOCKER_UNSAFE_SUBCOMMANDS,
};
