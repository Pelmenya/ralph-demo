// Команда сводки метрики продукта за период (план, Фаза 4; считалка — product-metric.ts).
//
//   node runtime/metric.mts --config /path/to/app/.claude/ralph/ralph.config.json
//        [--profile <имя>] [--hours 24] [--budget-min <мин>] [--line]
//
// Конфиг — абсолютным путём и только флагом: ядро запускается и своим клоном, и каталогом
// внутри потребителя, и «конфиг рядом с местом запуска» означал бы чужой конфиг в половине
// раскладок. Каталог состояния — из `roots.runtimeDir` того же конфига, а без секции roots —
// каталог самого конфига (прежняя раскладка: всё в `.claude/ralph`).
//
// Лог — всегда БОЕВОЙ `ralph.log`, а не выбранный по профилю: метрика про петлю, которая
// мерджит, а dry-лог мерджей не содержит вовсе. Профиль влияет только на бюджет и корни.
//
// `--budget-min` — явная подмена бюджета из конфига на один запуск (например, чтобы
// посмотреть сводку по установке, где ключа ещё нет). Без флага и без ключа — отказ с
// причиной: доля «в бюджет» без бюджета ничего не значит.
//
// `--line` — та же сводка суточной строкой (`formatMetricDayLine`): формат тот, что панель
// монитора шлёт в Telegram раз в сутки, окно — до момента запуска, а не до полуночи.
// Проверить строку руками — без ожидания полуночи.
//
// Флаги — закрытым списком: незнакомый — отказ, а не сводка с умолчаниями.
//
// Команда только читает. State читается проверкой (`inspectState`): повреждённый state —
// отказ, а не «текущей фазы нет», иначе задачи в работе молча ушли бы в «неизвестно».

import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error — JS-entry раннера без деклараций типов (тот же приём, что monitor-panel.mts).
import ralph from '../ralph.js';
import { runtimePathsIn } from '../core/runtime-paths.ts';
import { inspectState, stateRefusal } from '../core/state-lock.ts';
import {
    formatMetricDayLine,
    formatMetricSummary,
    parseLogEvents,
    resolveTaskBudgetMs,
    summarizeTasks,
    type TMetricSummary,
} from './product-metric.ts';

type Runtime = ReturnType<typeof import('../core/orchestrator.ts').createOrchestrator>;

export type TMetricDeps = {
    resolveProfile: Runtime['resolveProfile'];
    parseProfileFlag: Runtime['parseProfileFlag'];
    readFn: (p: string) => string;
    now: () => number;
};

function flagValue(argv: string[], name: string): string | undefined {
    const i = argv.indexOf(name);
    if (i === -1) return undefined;
    if (argv.indexOf(name, i + 1) !== -1) throw new Error(`${name} передан дважды.`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} без значения.`);
    return v;
}

// Закрытый список флагов. Незнакомый флаг — отказ, а не молчание: опечатка `--hour 1` или
// `--budget 10` дала бы сводку за 24 ч с бюджетом из конфига, и человек читал бы цифры не
// того запроса (цена такой опечатки известна: `--dry` вместо `--dry-run` гасил петлю).
const VALUE_FLAGS = new Set(['--config', '--profile', '--hours', '--budget-min']);
const BARE_FLAGS = new Set(['--line']);

function assertKnownFlags(argv: string[]): void {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (VALUE_FLAGS.has(a)) {
            // Значение разбирает flagValue — с отказом «без значения», если его нет.
            if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i++;
        } else if (!BARE_FLAGS.has(a) && !a.startsWith('--profile=')) {
            throw new Error(
                `незнакомый аргумент ${a}: команда знает только ${[...VALUE_FLAGS, ...BARE_FLAGS].join(' ')}.`,
            );
        }
    }
}

function positive(name: string, raw: string): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0)
        throw new Error(`${name} ${raw}: ожидалось положительное число.`);
    return n;
}

/** Сводка или отказ с причиной. Исключение здесь — всегда отказ по существу, с текстом для человека. */
export function runMetric(argv: string[], deps: TMetricDeps): string {
    assertKnownFlags(argv);
    const configPath = flagValue(argv, '--config');
    if (!configPath) throw new Error('нужен --config <абсолютный путь к ralph.config.json>.');
    if (!path.isAbsolute(configPath)) {
        throw new Error(`--config ${configPath} относительный: он резолвился бы от места запуска.`);
    }
    const hoursRaw = flagValue(argv, '--hours');
    const hours = hoursRaw === undefined ? 24 : positive('--hours', hoursRaw);
    const budgetRaw = flagValue(argv, '--budget-min');
    // Флаги проверяются до чтения конфига: битый флаг — отказ про флаг, а не про конфиг.
    const budgetMinOverride =
        budgetRaw === undefined ? undefined : positive('--budget-min', budgetRaw);

    const fail = (msg: string): never => {
        throw new Error(msg);
    };
    let raw: unknown;
    try {
        raw = JSON.parse(deps.readFn(configPath));
    } catch (e) {
        throw new Error(`конфиг ${configPath} не читается: ${(e as Error).message}`);
    }
    const config = deps.resolveProfile(raw, deps.parseProfileFlag(argv, fail), fail) as {
        rootsResolved?: { runtimeDir: string } | null;
    };
    const { summary, logPath } = summarizeRuntime({
        config,
        runtimeDir: config.rootsResolved?.runtimeDir ?? path.dirname(configPath),
        readFn: deps.readFn,
        now: deps.now(),
        hours,
        budgetMinOverride,
    });
    if (argv.includes('--line')) return formatMetricDayLine(summary);
    return `${formatMetricSummary(summary)}\nЛог: ${logPath}`;
}

export type TSummarizeRuntimeInput = {
    config: unknown;
    runtimeDir: string;
    readFn: (p: string) => string;
    now: number;
    hours: number;
    // Подмена бюджета конфига на один запуск (`--budget-min`); без неё — только конфиг.
    budgetMinOverride?: number;
};

/**
 * Сводка экземпляра по его каталогу состояния. Общая для команды и суточной строки
 * панели (monitor-panel.mts): два места, читающие лог и state по-разному, рано или
 * поздно разошлись бы в цифрах. Бросает с причиной для человека.
 */
export function summarizeRuntime(input: TSummarizeRuntimeInput): {
    summary: TMetricSummary;
    logPath: string;
} {
    const { config, readFn, now, hours, budgetMinOverride } = input;
    let budgetMs: number;
    if (budgetMinOverride !== undefined) {
        budgetMs = budgetMinOverride * 60_000;
    } else {
        const b = resolveTaskBudgetMs(config);
        if (!b.ok) throw new Error(`${b.reason}; на один запуск — --budget-min <мин>.`);
        budgetMs = b.ms;
    }

    const paths = runtimePathsIn(input.runtimeDir);
    let logText: string;
    try {
        logText = readFn(paths.log);
    } catch (e) {
        // Пустой результат сводки на отсутствующем логе читался бы как «за сутки ничего не
        // брали» — то есть как утверждение о петле, которого никто не проверял.
        throw new Error(`лог ${paths.log} не читается: ${(e as Error).message}`);
    }

    let currentMilestone: string | null = null;
    let stateText: string | null = null;
    try {
        stateText = readFn(paths.state);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error(`state ${paths.state} не читается: ${(e as Error).message}`);
        }
    }
    if (stateText !== null) {
        const st = inspectState(stateText);
        if (st.status !== 'ok') throw new Error(stateRefusal(paths.state, st));
        currentMilestone = st.state.milestone ?? null;
    }

    const until = now;
    const summary = summarizeTasks({
        events: parseLogEvents(logText),
        budgetMs,
        since: until - hours * 3_600_000,
        until,
        currentMilestone,
    });
    return { summary, logPath: paths.log };
}

if (import.meta.main) {
    try {
        console.log(
            runMetric(process.argv.slice(2), {
                resolveProfile: ralph.resolveProfile,
                parseProfileFlag: ralph.parseProfileFlag,
                readFn: (p) => fs.readFileSync(p, 'utf8'),
                now: () => Date.now(),
            }),
        );
    } catch (e) {
        console.error(`❌ Сводка не построена: ${(e as Error).message}`);
        process.exit(1);
    }
}
