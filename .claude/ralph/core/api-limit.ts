// Модуль детекции и ожидания API-лимита (#361, трек «Фреймворк ralph», фаза 2).
// Вынесен из ralph.js по тому же приёму, что ralph-util.ts (#232): чистые
// преобразования вход→выход без побочек — идея из frankbria/ralph-claude-code.
// Claude CLI при упирании в 5-часовое окно / usage limit пишет об этом в вывод и
// завершается с ошибкой. Без обработки AFK-итерация фейлится, breaker сжигает
// оставшиеся попытки об ту же стену и ночной прогон умирает. Вместо этого:
// распознать маркер → распарсить время сброса → доспать до него → повторить.
// Сам цикл ожидания/повтора (спит и вызывает claude заново) остаётся в ralph.js
// (runClaude) — он не чистый (sleep, spawn, pushEvent); здесь — только парсинг и
// расчёт длительности паузы плюс текст события.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
// Без побочек вовсе — guardSideEffect здесь не нужен (#138 не при чём: ни один экспорт
// не трогает диск/сеть/процессы), поэтому, как и ralph-util.ts, это набор standalone-
// экспортов, а не фабрика с DI.

// Боевой пример (2026-07-19): «You've hit your session limit · resets 1:20pm» —
// первая версия ждала только «usage limit» и промахнулась; ловим шире.
export const API_LIMIT_RE =
    /(usage limit|session limit|rate.?limit|5-hour limit|hit your .{0,20}limit|limit (?:reached|exceeded)|limit will reset|resets? at)/i;

// #594: сессия, упёршаяся в --max-turns, завершается ненулевым кодом с «Reached max turns
// (N)». Это не отказ, а «не успела»: работа сделана частично и закоммичена. Отдельный
// маркер нужен именно чтобы НЕ путать два случая — настоящее падение остаётся стопом
// fail-closed, а исчерпание ходов вызывающий вправе продолжить новой сессией.
// Формулировка ловится узко (max turns), чтобы не цеплять живую речь модели про «turns».
export const TURN_LIMIT_RE = /(reached max turns|max turns (?:reached|exceeded))/i;

// «resets 3am» / «reset at 7:30pm» → мс до сброса (локальное время; прошедшее
// время суток = завтра). Не распарсилось → null, вызывающий возьмёт fallback.
export function parseResetWaitMs(text: string): number | null {
    const m = /reset[s]?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3] ? m[3].toLowerCase() : null;
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    const now = new Date();
    const target = new Date(now);
    target.setHours(h, min, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target.getTime() - now.getTime();
}

// #130: запас был захардкожен как 2 минуты и оказался слишком тонким — окно
// сбрасывается не мгновенно, и повтор рискует уйти в ту же стену, сжигая попытку
// из apiLimitMaxWaits (их всего 3). Дефолт поднят до 5 минут и вынесен в конфиг.
//
// minutesOrDefault, а не `??`: `??` пропускал бы любой мусор, а мусор здесь не
// «странное число минут», а вечный сон. Atomics.wait(buf, 0, 0, NaN) трактует NaN
// как +∞ — раннер вставал бы навсегда, молча, с записью «Жду NaN мин» в логе
// (блокер ревью PR #132). Ноль при этом остаётся законным: «без запаса» —
// осознанный выбор, его подменять дефолтом нельзя.
// typeof number строго, без приведения: Number(null) и Number('') дают 0, и
// пропущенный/пустой ключ читался бы как осознанный «нулевой запас» вместо
// дефолта. Строку '5' тоже не принимаем — в JSON-конфиге минуты обязаны быть
// числом, а тихое приведение прячет опечатку вместо того, чтобы её проявить.
export function minutesOrDefault(value: unknown, dflt: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : dflt;
}

export function apiLimitWaitMs(
    output: string,
    cfg: { apiLimitFallbackWaitMin?: number; apiLimitGraceMin?: number },
): number {
    const fallbackMs = minutesOrDefault(cfg.apiLimitFallbackWaitMin, 30) * 60 * 1000;
    const graceMs = minutesOrDefault(cfg.apiLimitGraceMin, 5) * 60 * 1000;
    return (parseResetWaitMs(output) ?? fallbackMs) + graceMs;
}

// Текст события API-лимитной паузы — ЕДИНСТВЕННЫЙ источник правды его формата. deadman.ts
// (режим apiwait) парсит из него «Жду N мин» через API_WAIT_RE; раньше формат жил в двух
// местах, связанных лишь копией текста, и правка формулировки здесь молча ломала бы
// классификатор → ложный пуш ночью. Теперь функция экспортирована и её выход сверяется с
// API_WAIT_RE тестом (deadman.test.ts), так что рассинхрон краснит гейт, а не всплывает в бою.
export function apiLimitMessage(waitMs: number, attempt: number, maxWaits: number): string {
    return `⏳ Ralph: API-лимит — сессия упала с маркером лимита. Жду ${Math.round(waitMs / 60000)} мин до сброса окна и повторяю (попытка ${attempt + 1}/${maxWaits}).`;
}
