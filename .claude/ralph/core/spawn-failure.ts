// Классификация отказа ЗАПУСКА процесса и тексты причин (#607/#611, вынесено по ревью
// #612). Чистые преобразования вход→выход, без побочек — тот же жанр и тот же приём, что
// api-limit.ts (#361) и runtime-availability.ts (#606): правила живут отдельным модулем,
// а сам spawn — в оркестраторе.
//
// Почему модуль, а не тело фабрики createOrchestrator: правила ничего не замыкают
// (ни config, ни DRY, ни adapters), а ДВА spawn-пути (spawnClaude и spawnCodex) обязаны
// классифицировать одинаково. До выноса три ветки логирования были продублированы в обоих
// слово в слово — 25 строк копии, где правку (ETIMEDOUT/ENOBUFS) пришлось бы вносить
// дважды, а разъехавшись, они дали бы разный диагноз одному и тому же отказу.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).

import type { RunResult, SpawnFailureKind } from '../adapters/adapters.ts';

// #607: узкая детекция отказа ЗАПУСКА процесса (execve вернул E2BIG — argv/env вместе
// превысили системный предел), а не падения самой сессии. До перехода промпта на stdin
// это был единственный молчаливый путь: spawnSync не поднимал процесс вовсе, отдавал
// res.error, а не status/signal, и раннер это видел как code:1 без единой строки
// вывода — неотличимо от «ревью не дало вердикта». Проверка остаётся defense-in-depth
// (argv теперь фиксированной длины, но имя модели/пути — тоже в argv, и барьер не
// должен зависеть от того, что где-то ещё не выросло).
export const ARGV_TOO_LONG_RE = /E2BIG|Argument list too long/i;

export function isArgvTooLong(error: NodeJS.ErrnoException | null | undefined): boolean {
    if (!error) return false;
    return error.code === 'E2BIG' || ARGV_TOO_LONG_RE.test(error.message ?? '');
}

// Наблюдаемая часть результата spawnSync, по которой принимается решение. Не весь
// SpawnSyncReturns: классификации нужны ровно три поля, и узкий тип делает её вызываемой
// из теста без сборки полного объекта.
export type TSpawnObservation = {
    status?: number | null;
    signal?: NodeJS.Signals | null;
    error?: NodeJS.ErrnoException | null;
};

export type TSpawnOutcome = {
    failureKind: SpawnFailureKind;
    systemErrorCode?: string;
};

/**
 * Классификация исхода spawnSync НА ГРАНИЦЕ — там, где `res.error` ещё доступен.
 *
 * До #611 spawnClaude/spawnCodex читали только status/signal/stdout/stderr, и ENOENT,
 * E2BIG, EACCES, ENOBUFS схлопывались в неотличимый `{code: 1, output: '\n'}`.
 *
 * Ключевая поправка ревью #612: `res.error` НЕ равнозначен «процесс не запустился».
 * spawnSync выставляет его и в двух случаях, когда процесс отработал:
 *
 *   - ТАЙМАУТ: `{status: null, signal: 'SIGTERM', error: ETIMEDOUT}` — сессию убили по
 *     `claudeTimeoutMs`. Это отказ сессии (она шла часами), а не запуска, и точная строка
 *     про сигнал обязана остаться за ним;
 *   - ПЕРЕПОЛНЕННЫЙ maxBuffer: `{status: 0, signal: null, error: ENOBUFS}` — процесс
 *     завершился НУЛЁМ, просто вывод не влез в буфер. Считать это падением значит
 *     превращать успешную (слишком многословную) сессию в fail-closed стоп фазы.
 *
 * Оба проверены прямым запуском spawnSync. Отсюда правило: наличие `status`/`signal`
 * доказывает, что процесс СТАРТОВАЛ, — тогда это `session-failed`, а код ОС остаётся в
 * `systemErrorCode` как деталь диагноза, не как приговор.
 */
export function classifySpawnOutcome(
    error: NodeJS.ErrnoException | null | undefined,
    res: TSpawnObservation = {},
): TSpawnOutcome {
    if (!error) return { failureKind: 'session-failed' };
    // ENOENT и E2BIG приходят ТОЛЬКО с пустыми status/signal (процесс не поднялся вовсе),
    // поэтому проверяются раньше — порядок между ними и признаком старта роли не играет,
    // но так класс отказа читается по причине, а не по побочному признаку.
    if (error.code === 'ENOENT') {
        return { failureKind: 'runtime-unavailable', systemErrorCode: error.code };
    }
    if (isArgvTooLong(error)) {
        return { failureKind: 'arg-too-long', systemErrorCode: error.code ?? 'E2BIG' };
    }
    if ((res.signal ?? null) !== null || (res.status ?? null) !== null) {
        return { failureKind: 'session-failed', systemErrorCode: error.code };
    }
    return { failureKind: 'spawn-failed', systemErrorCode: error.code };
}

// Текст — ЕДИНСТВЕННЫЙ источник формулировки причины (тот же приём, что
// runtimeUnavailableExhaustedMessage в runtime-availability.ts, #606): называет её
// прямо, а не оставляет раннеру гадать по пустому выводу.
//
// Код ОС дописывается, ТОЛЬКО если он отличается от E2BIG (ревью #612): на самом частом
// входе `error.code === 'E2BIG'` прежняя форма читалась тавтологией «(E2BIG / код E2BIG)».
// Ветка осмысленна ровно тогда, когда сработал текстовый матч «Argument list too long» с
// другим (или отсутствующим) кодом — вот его и показываем.
export function argvTooLongMessage(binary: string, error: NodeJS.ErrnoException): string {
    const alsoCode = error.code && error.code !== 'E2BIG' ? ` / код ${error.code}` : '';
    return (
        `⛔ ${binary} не запустился: превышен предел ядра на аргумент командной строки ` +
        `(E2BIG${alsoCode} — обычно MAX_ARG_STRLEN, 131072 байта). Это отказ ЗАПУСКА ` +
        `процесса, а НЕ отказ сессии/ревью по существу — ${error.message}`
    );
}

/**
 * Полный разбор исхода spawnSync: что вернуть вызывающему и что сказать в лог.
 *
 * Общая для ОБОИХ spawn-путей (Claude и Codex) — критерий готовности #611 требует
 * одинаковой классификации, а ревью #612 добавило к этому одинаковые ТЕКСТЫ: имя бинаря
 * параметризовано, остальное дословно одно. Функция чистая: логирование — возвращённые
 * строки, а не побочка, поэтому тексты проверяются юнитом без перехвата console.
 */
export function resolveSpawnResult(
    binary: string,
    res: TSpawnObservation,
    output: string,
    timeoutMs: number,
): { result: RunResult; logLines: string[] } {
    const error = res.error ?? null;
    const outcome = classifySpawnOutcome(error, res);

    if (outcome.failureKind === 'arg-too-long') {
        return {
            result: { code: 1, output, ...outcome },
            logLines: [argvTooLongMessage(binary, error as NodeJS.ErrnoException)],
        };
    }
    if (outcome.failureKind === 'runtime-unavailable') {
        return {
            result: { code: 1, output, ...outcome },
            logLines: [
                `⚠ ${binary} не запустился: рантайм недоступен (${outcome.systemErrorCode ?? ''}) — ` +
                    `похоже, CLI обновляется, бинарь временно отсутствует. Это отказ ЗАПУСКА ` +
                    `процесса, а НЕ отказ сессии по существу — ${error?.message ?? ''}`,
            ],
        };
    }
    if (outcome.failureKind === 'spawn-failed') {
        return {
            result: { code: 1, output, ...outcome },
            logLines: [
                `⚠ ${binary} не запустился: ошибка запуска процесса` +
                    `${outcome.systemErrorCode ? ` (${outcome.systemErrorCode})` : ''} — ` +
                    `${error?.message ?? ''}. Это отказ ЗАПУСКА, а НЕ отказ сессии по существу.`,
            ],
        };
    }
    // Дальше процесс СТАРТОВАЛ. Сигнал (в т.ч. SIGTERM по таймауту, приходящий вместе с
    // error: ETIMEDOUT) — свой класс с прежней точной строкой: она существует ровно ради
    // таймаута, и уводить её под общий «не запустился» значило бы врать в логе.
    if (res.signal) {
        return {
            result: { code: 1, output, failureKind: 'session-failed' },
            logLines: [`⚠ ${binary} убит по сигналу ${res.signal} (таймаут ${timeoutMs}мс?)`],
        };
    }
    const code = res.status ?? 1;
    // ENOBUFS при живом status: вывод не влез в maxBuffer. Исход процесса не меняем (0
    // остаётся успехом), но говорим прямо — иначе обрезанный вывод молча объясняет собой
    // любую последующую странность (ревью #612).
    const logLines = outcome.systemErrorCode
        ? [
              `⚠ ${binary} отработал (код ${String(code)}), но spawnSync вернул ошибку ` +
                  `(${outcome.systemErrorCode}) — вероятнее всего вывод превысил maxBuffer и обрезан. ` +
                  `Это НЕ отказ запуска: ${error?.message ?? ''}`,
          ]
        : [];
    return {
        result: code === 0 ? { code, output } : { code, output, failureKind: 'session-failed' },
        logLines,
    };
}
