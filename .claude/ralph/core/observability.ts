// Секция `observability` конфига и ротация логов сессий (задача 95, риск R11).
//
// Три значения, и у каждого своя причина жить в конфиге, а не в коде:
// - `diskMinFreeMb` — порог свободного места под каталогом состояния. Сигнал о нём должен
//   прийти РАНЬШЕ, чем откажет запись state и лога: отказ записи сам по себе тих (лог
//   пишется в никуда, state не обновляется), и узнают о нём по последствиям;
// - `sessionLogsKeep` — сколько сохранённых выводов сессий держит `sessions/`. Выводы
//   пишутся на каждую упавшую сессию и раньше не убирались никогда: каталог рос до тех пор,
//   пока сам не становился причиной полного диска;
// - `pricing` — тариф по модели, USD за миллион токенов. По нему считается стоимость
//   попытки (`attempt-cost.ts`), и снимок тарифа ложится в журнал вместе с ней: тариф
//   меняется, а пересчитать прошлые попытки по новому значило бы соврать о них.
//
// Секция необязательна, умолчания названы здесь. Заданная проверяется fail-closed: опечатка
// в ключе выключала бы порог молча, а тариф строкой давал бы NaN в стоимости.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_DISK_MIN_FREE_MB = 1024;
export const DEFAULT_SESSION_LOGS_KEEP = 50;

export type TTariff = {
    inputPerMTok: number;
    outputPerMTok: number;
    cacheReadPerMTok: number;
    cacheWritePerMTok: number;
};

export type TObservability = {
    diskMinFreeMb: number;
    sessionLogsKeep: number;
    pricing: Record<string, TTariff> | null;
};

const KEYS = ['diskMinFreeMb', 'sessionLogsKeep', 'pricing'];
const TARIFF_KEYS: Array<keyof TTariff> = [
    'inputPerMTok',
    'outputPerMTok',
    'cacheReadPerMTok',
    'cacheWritePerMTok',
];

function isObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

// failFn зовётся на каждую ошибку и может вернуть управление (монитору стоп не нужен, ему
// нужна строка); тогда битое поле получает умолчание, а не роняет всю секцию.
export function resolveObservability(
    cfg: unknown,
    failFn: (msg: string) => unknown,
): TObservability {
    const out: TObservability = {
        diskMinFreeMb: DEFAULT_DISK_MIN_FREE_MB,
        sessionLogsKeep: DEFAULT_SESSION_LOGS_KEEP,
        pricing: null,
    };
    const raw = isObject(cfg) ? cfg.observability : undefined;
    if (raw === undefined) return out;
    const where = 'ralph.config.json: observability';
    if (!isObject(raw)) {
        failFn(`${where} — ожидался объект, получено ${JSON.stringify(raw)}.`);
        return out;
    }
    const unknownKeys = Object.keys(raw).filter((k) => !KEYS.includes(k));
    if (unknownKeys.length > 0) {
        failFn(
            `${where}: незнакомые ключи ${unknownKeys.join(', ')} — допустимы ${KEYS.join(', ')}.`,
        );
    }
    if (raw.diskMinFreeMb !== undefined) {
        const v = raw.diskMinFreeMb;
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) out.diskMinFreeMb = v;
        else
            failFn(
                `${where}.diskMinFreeMb = ${JSON.stringify(v)} — ожидалось число МБ больше нуля.`,
            );
    }
    if (raw.sessionLogsKeep !== undefined) {
        const v = raw.sessionLogsKeep;
        if (typeof v === 'number' && Number.isInteger(v) && v > 0) out.sessionLogsKeep = v;
        else
            failFn(
                `${where}.sessionLogsKeep = ${JSON.stringify(v)} — ожидалось целое больше нуля ` +
                    '(ноль стёр бы вывод упавшей сессии сразу после записи).',
            );
    }
    if (raw.pricing !== undefined)
        out.pricing = resolvePricing(raw.pricing, `${where}.pricing`, failFn);
    return out;
}

function resolvePricing(
    raw: unknown,
    where: string,
    failFn: (msg: string) => unknown,
): Record<string, TTariff> | null {
    if (!isObject(raw) || Object.keys(raw).length === 0) {
        failFn(
            `${where} — ожидался непустой объект «модель → тариф»; пустой выглядит настройкой, а не считает ничего.`,
        );
        return null;
    }
    const out: Record<string, TTariff> = {};
    for (const [model, t] of Object.entries(raw)) {
        if (!isObject(t)) {
            failFn(`${where}.${model} — ожидался объект с ${TARIFF_KEYS.join(', ')}.`);
            continue;
        }
        const extra = Object.keys(t).filter((k) => !(TARIFF_KEYS as string[]).includes(k));
        const bad = TARIFF_KEYS.filter((k) => {
            const v = t[k];
            return typeof v !== 'number' || !Number.isFinite(v) || v < 0;
        });
        if (extra.length > 0 || bad.length > 0) {
            failFn(
                `${where}.${model}: ` +
                    [
                        bad.length > 0 ? `нужны неотрицательные числа в ${bad.join(', ')}` : '',
                        extra.length > 0 ? `незнакомые ключи ${extra.join(', ')}` : '',
                    ]
                        .filter(Boolean)
                        .join('; ') +
                    ' (USD за миллион токенов).',
            );
            continue;
        }
        out[model] = {
            inputPerMTok: t.inputPerMTok as number,
            outputPerMTok: t.outputPerMTok as number,
            cacheReadPerMTok: t.cacheReadPerMTok as number,
            cacheWritePerMTok: t.cacheWritePerMTok as number,
        };
    }
    return Object.keys(out).length > 0 ? out : null;
}

export type TPruneFs = Pick<typeof fs, 'readdirSync' | 'statSync' | 'unlinkSync'>;

// Ротация `sessions/`: остаются `keep` самых свежих `.log` по mtime, остальные удаляются.
// Отказ ротации не роняет ничего — он возвращается строкой, и вызывающий её логирует:
// ротация — уборка, а не условие продолжения. Файл, который не удалился, остаётся, и
// следующая ротация попробует снова.
export function pruneSessionLogs(
    dir: string,
    keep: number,
    fsImpl: TPruneFs = fs,
): { removed: string[]; errors: string[] } {
    const errors: string[] = [];
    let names: string[];
    try {
        names = fsImpl.readdirSync(dir).filter((n) => n.endsWith('.log'));
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { removed: [], errors };
        return { removed: [], errors: [`${dir}: ${(e as Error).message}`] };
    }
    const dated: Array<{ name: string; mtime: number }> = [];
    for (const name of names) {
        try {
            dated.push({ name, mtime: fsImpl.statSync(path.join(dir, name)).mtimeMs });
        } catch (e) {
            errors.push(`${name}: ${(e as Error).message}`);
        }
    }
    dated.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
    const removed: string[] = [];
    for (const { name } of dated.slice(keep)) {
        try {
            fsImpl.unlinkSync(path.join(dir, name));
            removed.push(name);
        } catch (e) {
            errors.push(`${name}: ${(e as Error).message}`);
        }
    }
    return { removed, errors };
}
