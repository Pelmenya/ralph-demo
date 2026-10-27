// Токены и стоимость попытки — запуска кодер-рантайма (задача 95; журнал вызовов по образцу
// sourcecraft.dev/derbush/all-together: строка на вызов, тариф — снимком на момент вызова).
//
// Сколько стоила сессия, раньше не знал никто: `claude -p` в текстовом режиме печатает
// только ответ. Токены по моделям отдаёт `--output-format json` — поэтому рантайм Claude
// (и Kimi через тот же бинарь) теперь запускается с ним, а вывод переводится обратно в
// текст, который ждут все читатели вывода: детект API-лимита, бюджета ходов, недоступности
// прокси. Перевод — часть контракта, а не косметика: в JSON исчерпание ходов выглядит как
// `subtype: error_max_turns` и `Reached maximum number of turns (N)`, а `TURN_LIMIT_RE`
// ищет `Reached max turns` текстового режима (проверено живым CLI 2.1.311). Без перевода
// продолжение по бюджету ходов превратилось бы в стоп «сессия упала».
//
// Вывод, который как JSON-результат не разобрался (старый CLI, обрыв посреди, чужой
// рантайм), идёт дальше как есть — читатели видят прежний текст, — а попытка ложится в
// журнал с причиной «токены неизвестны». Молча без записи попытка не остаётся.
//
// Стоимость — по тарифу из `observability.pricing`, и тариф копируется в запись: его поменяют,
// а пересчёт прошлых попыток по новому соврал бы о них. Тарифа модели в конфиге нет — берётся
// стоимость, которую посчитал сам рантайм по своему прайсу на момент вызова (`costUSD`), с
// пометкой источника; нет и её — стоимость неизвестна, и это тоже сказано в записи.

import { TURN_LIMIT_RE } from './api-limit.ts';
import type { TTariff } from './observability.ts';

export const CLAUDE_JSON_ARGS = ['--output-format', 'json'];

export type TModelUsage = {
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reportedCostUsd: number | null;
};

function num(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function numOrNull(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function parseClaudeJsonResult(
    stdout: string,
): { text: string; models: TModelUsage[]; durationMs: number | null } | null {
    let v: unknown;
    try {
        v = JSON.parse(stdout.trim());
    } catch {
        return null;
    }
    if (!isObject(v) || v.type !== 'result') return null;
    const parts: string[] = [];
    if (typeof v.result === 'string' && v.result !== '') parts.push(v.result);
    if (Array.isArray(v.errors)) {
        for (const e of v.errors) if (typeof e === 'string') parts.push(`Error: ${e}`);
    }
    const joined = parts.join('\n');
    if (v.subtype === 'error_max_turns' && !TURN_LIMIT_RE.test(joined)) {
        parts.push(`Error: Reached max turns (${num(v.num_turns)})`);
    }
    // Ошибочный результат несёт ещё и сырой JSON: детекторы лимита и прокси ищут слова, а
    // форм ошибки у CLI больше, чем проверено живьём, — потерять маркер дороже лишней строки.
    if (v.is_error === true) parts.push(stdout.trim());
    const models: TModelUsage[] = [];
    if (isObject(v.modelUsage)) {
        for (const [model, u] of Object.entries(v.modelUsage)) {
            if (!isObject(u)) continue;
            models.push({
                model,
                input: num(u.inputTokens),
                output: num(u.outputTokens),
                cacheRead: num(u.cacheReadInputTokens),
                cacheWrite: num(u.cacheCreationInputTokens),
                reportedCostUsd: numOrNull(u.costUSD),
            });
        }
    } else if (isObject(v.usage)) {
        // Старый формат без разбивки по моделям: модель неизвестна, тариф к ней не приложить.
        models.push({
            model: 'unknown',
            input: num(v.usage.input_tokens),
            output: num(v.usage.output_tokens),
            cacheRead: num(v.usage.cache_read_input_tokens),
            cacheWrite: num(v.usage.cache_creation_input_tokens),
            reportedCostUsd: numOrNull(v.total_cost_usd),
        });
    }
    return { text: parts.join('\n'), models, durationMs: numOrNull(v.duration_ms) };
}

export type TCostBasis = 'config-tariff' | 'runtime-reported' | 'unknown';

export type TPricedModel = TModelUsage & {
    tariff: TTariff | null;
    costUsd: number | null;
    costBasis: TCostBasis;
};

export function priceModel(u: TModelUsage, pricing: Record<string, TTariff> | null): TPricedModel {
    const t = pricing?.[u.model];
    if (t) {
        const costUsd =
            (u.input * t.inputPerMTok +
                u.output * t.outputPerMTok +
                u.cacheRead * t.cacheReadPerMTok +
                u.cacheWrite * t.cacheWritePerMTok) /
            1_000_000;
        return { ...u, tariff: { ...t }, costUsd, costBasis: 'config-tariff' };
    }
    if (u.reportedCostUsd !== null) {
        return { ...u, tariff: null, costUsd: u.reportedCostUsd, costBasis: 'runtime-reported' };
    }
    return { ...u, tariff: null, costUsd: null, costBasis: 'unknown' };
}

export type TAttemptRecord = {
    runtime: string;
    code: number;
    durationMs: number | null;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
    costUsd: number | null;
    models: TPricedModel[];
    usageUnknown?: string;
};

// Запись попытки для журнала. Итог стоимости — сумма по моделям, только если известна
// каждая: частичная сумма выглядела бы полной.
export function attemptRecord({
    runtime,
    code,
    parsed,
    pricing,
    unknownReason,
}: {
    runtime: string;
    code: number;
    parsed: ReturnType<typeof parseClaudeJsonResult>;
    pricing: Record<string, TTariff> | null;
    unknownReason?: string;
}): TAttemptRecord {
    if (!parsed || parsed.models.length === 0) {
        return {
            runtime,
            code,
            durationMs: parsed?.durationMs ?? null,
            tokens: null,
            costUsd: null,
            models: [],
            usageUnknown:
                unknownReason ??
                (parsed
                    ? 'рантайм не отдал расход по моделям'
                    : 'вывод рантайма не разобрался как JSON-результат'),
        };
    }
    const models = parsed.models.map((u) => priceModel(u, pricing));
    const tokens = models.reduce(
        (a, m) => ({
            input: a.input + m.input,
            output: a.output + m.output,
            cacheRead: a.cacheRead + m.cacheRead,
            cacheWrite: a.cacheWrite + m.cacheWrite,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
    const costUsd = models.every((m) => m.costUsd !== null)
        ? models.reduce((a, m) => a + (m.costUsd as number), 0)
        : null;
    return { runtime, code, durationMs: parsed.durationMs, tokens, costUsd, models };
}

// Человеческая строка о попытке — для лога. Маркер 💰 нейтрален для deadman: режим петли он
// не меняет, и порог сессии не сбрасывается на короткий. Кеш назван отдельно от итога: у него
// свой тариф и свой смысл, и одно число человек принял бы за объём работы — в типичной
// попытке почти всё оно приходится на запись кеша.
export function attemptLogLine(r: TAttemptRecord): string {
    if (!r.tokens) return `💰 Попытка (${r.runtime}): расход неизвестен — ${r.usageUnknown}.`;
    const cache = r.tokens.cacheRead + r.tokens.cacheWrite;
    const total = r.tokens.input + r.tokens.output + cache;
    const bases = [...new Set(r.models.map((m) => m.costBasis))].join('+');
    const cost = r.costUsd === null ? 'стоимость неизвестна' : `$${r.costUsd.toFixed(4)}`;
    return `💰 Попытка (${r.runtime}): ${total} токенов (из них кеш ${cache}), ${cost} (тариф: ${bases}).`;
}
