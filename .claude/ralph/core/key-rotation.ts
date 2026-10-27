// Ротация ключей подписки по кругу (канон, задача 96).
//
// До неё маркер лимита вёл в один путь: кросс-провайдерный фолбэк и дальше сон до сброса
// окна (`api-limit.ts`, `apiLimitMaxWaits`). Простой петли на часы дороже второй подписки,
// поэтому ключей может быть несколько, и сон начинается только тогда, когда упёрлись ВСЕ:
//
// - лимит на активном ключе → ключ помечается временем своего сброса, сессия сразу идёт на
//   следующем непомеченном по кругу, счётчик ожиданий не тратится;
// - помечены все → сон до БЛИЖАЙШЕГО сброса, а не до сброса первого по порядку: ключ,
//   упёршийся раньше, освобождается раньше, и ждать первый — лишний простой;
// - кросс-провайдерный фолбэк — после ротации: своя подписка дешевле чужого провайдера.
//
// Ключ адресуется НОМЕРОМ в списке, и в файл ротации, в лог и в пуш уходит только номер.
// Хэш ключа тоже не пишется: производная секрета в файле состояния — та же утечка, только
// отложенная. Цена номера — смена состава списка; поэтому в файле лежит число ключей, и
// другое число означает «индексы больше не значат те же ключи» — ротация начинается
// заново, вслух. Переставить ключи местами, сохранив число, раннер не заметит: худший исход
// — одна сессия на сожжённом ключе, которая тут же упрётся и уйдёт на следующий.
//
// Одиночный ключ — список из одного, и вызывающий тогда ротацию не включает вовсе:
// поведение байт-в-байт прежнее (env сессии наследуется, файл ротации не пишется).
//
// Модуль чистый, как api-limit.ts: время, env и текст файла приходят аргументами, а запись
// на диск и спавн остаются в оркестраторе.

// Список ключей — через запятую. Имя своё, а не множественное от CLI-переменной: сам CLI
// эту переменную не читает, и путать её с его собственными ключами незачем.
export const SUBSCRIPTION_KEYS_ENV = 'RALPH_CLAUDE_OAUTH_TOKENS';
// Одиночный ключ, который CLI читает сам, — и который ротация подменяет в env сессии.
export const SUBSCRIPTION_KEY_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

export function subscriptionKeys(env: Record<string, string | undefined>): string[] {
    const list = env[SUBSCRIPTION_KEYS_ENV];
    if (list !== undefined) {
        // Повтор схлопывается: «следующий по кругу» оказался бы тем же сожжённым ключом, и
        // сессия ушла бы в ту же стену, не потратив ни ожидания, ни строки о причине.
        return [
            ...new Set(
                list
                    .split(',')
                    .map((k) => k.trim())
                    .filter(Boolean),
            ),
        ];
    }
    const solo = env[SUBSCRIPTION_KEY_ENV];
    return solo ? [solo] : [];
}

// `exhausted` — номер ключа → момент сброса его окна (мс эпохи, уже с запасом grace).
export type TKeyRotation = { keyCount: number; active: number; exhausted: Record<string, number> };

export function freshRotation(keyCount: number): TKeyRotation {
    return { keyCount, active: 0, exhausted: {} };
}

/**
 * Файл ротации с диска. Битый файл — не стоп, а свежая ротация С ПРИЧИНОЙ: мердж от него не
 * зависит, и худший исход — одна сессия на ключе, который уже упёрся, после чего ротация
 * сама уйдёт дальше. Стоп петли из-за этого файла стоил бы ночи простоя ради экономии одной
 * сессии. Молчать при этом нельзя — причину вызывающий пишет в лог.
 */
export function parseKeyRotation(
    text: string | null,
    keyCount: number,
): { rot: TKeyRotation; reason?: string } {
    if (text === null) return { rot: freshRotation(keyCount) };
    const fresh = (reason: string) => ({ rot: freshRotation(keyCount), reason });
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        return fresh(`не JSON (${(e as Error).message})`);
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return fresh('ожидался JSON-объект');
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.keyCount !== 'number' || !Number.isInteger(r.keyCount)) {
        return fresh('keyCount — не целое число');
    }
    if (r.keyCount !== keyCount) {
        return fresh(`в файле ${r.keyCount} ключей, в env ${keyCount} — номера сместились`);
    }
    if (
        typeof r.active !== 'number' ||
        !Number.isInteger(r.active) ||
        r.active < 0 ||
        r.active >= keyCount
    ) {
        return fresh('active — не номер ключа из списка');
    }
    const ex = r.exhausted;
    if (typeof ex !== 'object' || ex === null || Array.isArray(ex)) {
        return fresh('exhausted — не объект');
    }
    const exhausted: Record<string, number> = {};
    for (const [k, v] of Object.entries(ex)) {
        const idx = Number(k);
        if (!Number.isInteger(idx) || idx < 0 || idx >= keyCount) {
            return fresh(`метка у ключа «${k}» вне списка`);
        }
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            return fresh(`метка ключа ${idx} — не число`);
        }
        exhausted[idx] = v;
    }
    return { rot: { keyCount, active: r.active, exhausted } };
}

function dropExpired(rot: TKeyRotation, nowMs: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(rot.exhausted)) if (v > nowMs) out[k] = v;
    return out;
}

// Первый непомеченный по кругу, начиная СО СЛЕДУЮЩЕГО за `from`; null — помечены все.
function nextFree(keyCount: number, from: number, exhausted: Record<string, number>) {
    for (let i = 1; i <= keyCount; i++) {
        const idx = (from + i) % keyCount;
        if (exhausted[idx] === undefined) return idx;
    }
    return null;
}

function earliestReset(exhausted: Record<string, number>): { idx: number; at: number } {
    let best = { idx: -1, at: Infinity };
    for (const [k, v] of Object.entries(exhausted))
        if (v < best.at) best = { idx: Number(k), at: v };
    return best;
}

/**
 * Ротация на старте вызова (в том числе после рестарта): истёкшие метки сняты, а активный
 * ключ, который ещё не сбросился, заменён первым свободным — иначе первая же сессия после
 * рестарта ушла бы в стену, о которой раннер уже знает. Помечены все — активным становится
 * ключ ближайшего сброса: сессия на нём упрётся и уйдёт в сон ровно до этого сброса.
 */
export function normalizeRotation(rot: TKeyRotation, nowMs: number): TKeyRotation {
    const exhausted = dropExpired(rot, nowMs);
    if (exhausted[rot.active] === undefined) return { ...rot, exhausted };
    const free = nextFree(rot.keyCount, rot.active, exhausted);
    const active = free ?? earliestReset(exhausted).idx;
    return { ...rot, active, exhausted };
}

export type TKeyLimitStep =
    | { kind: 'rotate'; rot: TKeyRotation; from: number; to: number }
    | { kind: 'wait'; rot: TKeyRotation; waitUntilMs: number; next: number };

/** Лимит на активном ключе: пометить его и выбрать следующий либо ближайший сброс. */
export function onKeyLimit(rot: TKeyRotation, nowMs: number, resetAtMs: number): TKeyLimitStep {
    const exhausted = { ...dropExpired(rot, nowMs), [rot.active]: resetAtMs };
    const free = nextFree(rot.keyCount, rot.active, exhausted);
    if (free !== null) {
        return {
            kind: 'rotate',
            rot: { ...rot, active: free, exhausted },
            from: rot.active,
            to: free,
        };
    }
    const { idx, at } = earliestReset(exhausted);
    return { kind: 'wait', rot: { ...rot, exhausted }, waitUntilMs: at, next: idx };
}

/** После сна ключ ближайшего сброса снова активен, и его метка снята. */
export function resumeAfterWait(rot: TKeyRotation, index: number): TKeyRotation {
    const { [index]: _done, ...exhausted } = rot.exhausted;
    return { ...rot, active: index, exhausted };
}

export function keyRotateMessage(from: number, to: number, keyCount: number): string {
    return `🔑 API-лимит на ключе подписки ${from + 1}/${keyCount} — сессия сразу на ключе ${to + 1}/${keyCount}, ожидание не тратится.`;
}

// Формат держит префикс и «Жду N мин» из apiLimitMessage: deadman (API_WAIT_RE) узнаёт по
// ним режим ожидания лимита и порог тишины, и без них сон до сброса выглядел бы смертью.
export function allKeysExhaustedMessage(
    waitMs: number,
    attempt: number,
    maxWaits: number,
    keyCount: number,
): string {
    return `⏳ Ralph: API-лимит — все ключи подписки (${keyCount}) упёрлись. Жду ${Math.round(waitMs / 60000)} мин до ближайшего сброса окна и повторяю (попытка ${attempt + 1}/${maxWaits}).`;
}
