// Модуль health-check Shadowsocks-туннеля (#361, трек «Фреймворк ralph», фаза 2, исходно
// #92). Вынесен из ralph.js по тому же приёму, что worktree.ts/state-lock.ts (#359/#360):
// прод-режим — VDS в РФ ходит к Anthropic через Shadowsocks → privoxy (HTTPS_PROXY). Если
// туннель ночью отвалится, claude-вызов упрётся в Cloudflare-403/таймаут, а ralph зря сожжёт
// итерацию (а то и окно лимита) об мёртвый канал. Поэтому ПЕРЕД каждой claude-сессией
// сверяем фактический egress-IP (через прокси) с ожидаемым (IP Outline). Красный →
// перезапуск ss-local/privoxy → повторная сверка → если и после этого красный, итерация не
// стартует (fail-closed) + пуш человеку. Поведение НЕ меняется.
//
// Юниты ss-local/privoxy уже с Restart=always (provision.sh) — это подстраховка сверху:
// ловит и «сервис жив, но канал деградировал» (egress не тот), чего systemd не видит.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
//
// Фабрика, а не standalone-экспорты (как в api-limit.ts): ensureTunnel не чистая функция —
// ей нужен контекст ralph.js (log, sleep, pushEvent — единая точка доставки событий в
// Telegram, используемая и другими частями раннера, поэтому сама pushEvent остаётся в
// ralph.js и передаётся сюда как коллаборатор). Фабрика захватывает этот контекст один раз,
// а возвращённые функции сохраняют ПОКАЗАТЕЛЬНУЮ DI: каждая по-прежнему принимает свои
// коллабораторы (probe/restart/sleepFn/push/execFn) параметром — ровно так их зовут
// существующие тесты (tunnel-check.test.ts) через ре-экспорт из ralph.js.

import { execFileSync } from 'node:child_process';

type LogFn = (msg: string) => void;
type SleepFn = (ms: number) => void;
type PushEventFn = (msg: string, cfg?: unknown, opts?: Record<string, unknown>) => unknown;
type ExecFn = (file: string, args: string[], opts?: Record<string, unknown>) => string;
type GuardFn = (what: string) => void;

type TunnelCheckCfg = {
    tunnelCheck?: {
        enabled?: boolean;
        proxyUrl?: string;
        ipCheckUrl?: string;
        restartCmd?: string;
        restartWaitMs?: number;
    };
};

// Контекст ralph.js, захватываемый фабрикой один раз. log/sleep — те же module-level
// коллабораторы, что использует остальной раннер; pushEvent — единая точка пуш-событий
// человеку (#86), общая для всех 4 событий прод-режима, не только туннеля.
// guardSideEffect — общий предохранитель #138: его зовут ОПАСНЫЕ дефолты execFn (реальные
// curl / systemctl restart), чтобы забытый в тесте override не ушёл в настоящую сеть или —
// хуже — в реальный рестарт сервисов туннеля на прод-VDS, где гейт гоняет тесты.
export type TunnelCheckEnv = {
    log: LogFn;
    sleep: SleepFn;
    pushEvent: PushEventFn;
    guardSideEffect: GuardFn;
};

export function createTunnelCheck(env: TunnelCheckEnv) {
    const { log, sleep, pushEvent, guardSideEffect } = env;

    // Включён ли health-check. Локально/в dev туннеля нет — по умолчанию ВЫКЛ, чтобы не
    // ломать обычный запуск. Включается прод-профилем (config.tunnelCheck.enabled) или
    // env-флагом RALPH_TUNNEL_CHECK=1 (мост до профилей Фазы 2; ставится в ralph.env).
    function tunnelCheckEnabled(cfg: TunnelCheckCfg): boolean {
        return (
            process.env.RALPH_TUNNEL_CHECK === '1' || !!(cfg.tunnelCheck && cfg.tunnelCheck.enabled)
        );
    }

    // Ожидаемый egress — публичный IP прокси-сервера (Франкфурт). Секрет-ish → из env,
    // НЕ из конфига в гите. SS_SERVER уже есть в ralph.env (его же сверяет provision.sh).
    // trim() (ревью #98): ralph.env часто редактируют/копируют с Windows-машины (CRLF) —
    // без обрезки хвостовой \r/пробел comparison с уже-трим'нутым egress НИКОГДА не
    // совпадёт, даже когда канал реально здоров, и health-check будет вечно красным.
    function expectedEgress(): string {
        return (process.env.RALPH_EXPECTED_EGRESS || process.env.SS_SERVER || '').trim();
    }

    // Чистая функция (ядро проверки, юнит-тест «мок curl: совпал/не совпал IP»): туннель
    // здоров ⟺ фактический egress непуст И точно равен ожидаемому. Пустой ожидаемый или
    // пустой egress (ошибка curl) — НЕ здоров.
    function tunnelHealthy(egress: string, expected: string): boolean {
        return !!expected && egress === expected;
    }

    // Фактический egress-IP через прокси. Аргументы curl — МАССИВ через execFileSync
    // (ревью #98), не строка через sh()/execSync: тот же anti-RCE паттерн, которым #67
    // увёл spawnClaude от shell-интерполяции — proxy/ipUrl не проходят через шелл, так
    // спецсимволы в них не раскрываются. Сегодня оба значения из доверенных источников
    // (config.json в гите / env, который задаёт сам оператор VDS), но это тот класс
    // защиты, что ничего не стоит держать по умолчанию. -4 форсирует IPv4: ожидаемый
    // egress (SS_SERVER) — IPv4 Outline-сервера, а api.ipify.org на dual-stack хосте
    // без -4 мог бы отдать IPv6 и увести сравнение в ложный красный.
    // Пустая строка при любой ошибке (таймаут, мёртвый прокси) — вызывающий трактует
    // пустоту как «не здоров». execFn инжектируется для тестов; в проде — execFileSync.
    // Дефолтный execFn гардится #138: забытый override в тесте ушёл бы в настоящий curl
    // (сеть, до 15 с таймаута) — предохранитель краснит до реальной побочки.
    function probeEgress(
        cfg: TunnelCheckCfg,
        execFn: ExecFn = (file, args, opts) => {
            guardSideEffect('curl (probeEgress)');
            return (execFileSync as ExecFn)(file, args, opts);
        },
    ): string {
        const tc = cfg.tunnelCheck || {};
        const proxy =
            process.env.HTTPS_PROXY ||
            process.env.HTTP_PROXY ||
            tc.proxyUrl ||
            'http://127.0.0.1:8118';
        const ipUrl = tc.ipCheckUrl || 'https://api.ipify.org';
        try {
            return execFn('curl', ['-4', '-s', '--max-time', '15', '-x', proxy, ipUrl], {
                encoding: 'utf-8',
            }).trim();
        } catch {
            return '';
        }
    }

    // Перезапуск сервисов туннеля. restartCmd из конфига — простая команда без кавычек/
    // пайпов (бинарь + имена systemd-юнитов), поэтому безопасно разбить по пробелам и
    // выполнить через execFileSync (тот же anti-RCE паттерн, что и probeEgress выше),
    // а не execSync(cmd) строкой через шелл. Fail-open: сбой самого рестарта лишь
    // логируем — финальная повторная сверка egress всё равно решит, здоров канал или нет.
    // Дефолтный execFn гардится #138: забытый override в тесте ушёл бы в настоящий
    // systemctl restart сервисов туннеля на прод-VDS, где гейт гоняет тесты.
    function restartTunnel(
        cfg: TunnelCheckCfg,
        execFn: ExecFn = (file, args, opts) => {
            guardSideEffect('systemctl (restartTunnel)');
            return (execFileSync as ExecFn)(file, args, opts);
        },
    ): void {
        const cmd =
            (cfg.tunnelCheck && cfg.tunnelCheck.restartCmd) ||
            'systemctl restart shadowsocks-libev-local@frankfurt privoxy';
        const [bin, ...cmdArgs] = cmd.trim().split(/\s+/);
        try {
            execFn(bin, cmdArgs);
        } catch (e: unknown) {
            log(
                `⚠ Перезапуск сервисов туннеля упал: ${String((e as Error).message).split('\n')[0]}`,
            );
        }
    }

    // Оркестровка health-check. true = туннель здоров ИЛИ проверка выключена (можно
    // стартовать сессию); false = красный даже после перезапуска (стартовать нельзя).
    // Зависимости инжектируются (probe/restart/sleepFn/push) — для детерминированных
    // юнит-тестов без реального curl/systemctl/сна.
    function ensureTunnel(
        cfg: TunnelCheckCfg,
        {
            probe = probeEgress,
            restart = restartTunnel,
            sleepFn = sleep,
            push = pushEvent,
        }: {
            probe?: typeof probeEgress;
            restart?: typeof restartTunnel;
            sleepFn?: SleepFn;
            push?: PushEventFn;
        } = {},
    ): boolean {
        if (!tunnelCheckEnabled(cfg)) return true; // dev/локально — туннеля нет
        const expected = expectedEgress();
        if (!expected) {
            // Проверка включена, но не задан ожидаемый egress — сверять не с чем. Fail-open
            // с предупреждением: не блокируем прогон из-за неполной конфигурации канала.
            log(
                '⚠ Health-check туннеля включён, но не задан ожидаемый egress (RALPH_EXPECTED_EGRESS / SS_SERVER) — проверка пропущена.',
            );
            return true;
        }
        let egress = probe(cfg);
        if (tunnelHealthy(egress, expected)) return true;
        log(
            `⚠ Туннель красный: egress='${egress || '—'}', ждали '${expected}'. Перезапуск ss-local/privoxy...`,
        );
        restart(cfg);
        sleepFn((cfg.tunnelCheck && cfg.tunnelCheck.restartWaitMs) || 3000);
        egress = probe(cfg);
        if (tunnelHealthy(egress, expected)) {
            log('✅ Туннель восстановлен после перезапуска сервисов.');
            return true;
        }
        log(
            `⛔ Туннель не восстановился (egress='${egress || '—'}', ждали '${expected}') — claude-сессия не стартует.`,
        );
        push(
            `Ralph: Shadowsocks-туннель на VDS красный (egress='${egress || '—'}' != '${expected}') и не поднялся после перезапуска. Loop остановлен — почини канал.`,
            cfg,
        );
        return false;
    }

    return {
        tunnelCheckEnabled,
        expectedEgress,
        tunnelHealthy,
        probeEgress,
        restartTunnel,
        ensureTunnel,
    };
}
