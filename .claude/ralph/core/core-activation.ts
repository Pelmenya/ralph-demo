/**
 * Активация ревизии ядра рестартом на подтверждённой границе и журнал активации (Фаза 13, #38).
 *
 * Инцидент 18.08.2026 на полигоне: петля встала fail-closed на сдаче фазы — «39 намерений,
 * больше предела 20», — хотя разделённые пределы уже лежали на диске. Процесс стартовал в
 * 07:28, фикс смерджен в 09:37, падение — в 10:11: раннер обновлял дерево, но исполнял код,
 * загруженный при старте. При внешней установке тот же класс выглядит иначе:
 * `.ralph/core.lock` уже называет новую ревизию, а работающий процесс исполняет старую.
 * Подменить код под живым Node нельзя, поэтому у модуля три обязательства:
 *
 *   1. **Расхождение не молчит.** На каждой границе итерации петля сверяет исполняемую
 *      ревизию с lock (`checkLockDrift`) и при расхождении говорит «lock новее исполняемой
 *      ревизии — нужен рестарт» в лог и уведомлением. Lock, который посреди прогона перестал
 *      читаться, — тоже повод остановиться: «не знаю, что в lock» не значит «то же, что было».
 *   2. **Рестарт — только на подтверждённой границе.** Граница — вершина цикла: итерация
 *      закрыта, state записан. Сдача фазы, доведённая не до конца (журнал сдачи с
 *      незакрытым этапом), границей НЕ считается (`activationBoundary`): рестарт посреди
 *      неё перенёс бы её середину на другой код — ту самую смесь двух ревизий в одной
 *      операции, из-за которой встала петля 18.08. Тогда расхождение называется, и петля
 *      доводит сдачу на прежней ревизии. Петля выходит кодом `ACTIVATION_RESTART_EXIT`;
 *      рестарт делает тот, кто её запускал (`./ralph start`), заново сверив ревизию из lock.
 *   3. **Журнал активации.** Каждая смена исполняемой ревизии пишется строкой «какая, когда,
 *      с какой снята» в каталог состояния: разбор падения ведёт к той версии, которая
 *      исполнялась, а не к той, что лежит в lock сейчас. Журнал читает `--doctor`. Битая
 *      строка журнала — отказ чтения с номером строки, а не пропуск: пропущенная запись
 *      подменила бы «с какой снята».
 *
 * Чего модуль НЕ обещает, сказано вслух. Сверка идёт только на границе: lock, сменившийся и
 * вернувшийся обратно за одну итерацию, петля не заметит — и это верно, исполняется ровно
 * та ревизия, что в lock. Журнал пишет запущенная ревизия о себе: сверщика вне неё нет, и
 * правленое дерево установки могло бы журнал не писать — его ловит сверка с lock на старте.
 *
 * TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { guardSideEffect } from '../shared/side-effect-guard.ts';
import { isFullSha, readCoreLock } from './core-install.ts';

/**
 * Код выхода «нужен рестарт на новой ревизии» — EX_TEMPFAIL из sysexits: отказ временный,
 * повтор исправит. Отличен от 1 (стоп по существу) и 0 (штатный конец): launcher по нему
 * одному решает перезапуск, и стоп по существу перезапуском не лечится.
 */
export const ACTIVATION_RESTART_EXIT = 75;

/** Фраза расхождения — её ищут глазами в логе и грепом в уведомлениях. */
export const LOCK_AHEAD_PHRASE = 'lock новее исполняемой ревизии — нужен рестарт';

export type TLockDrift = { lockSha: string | null; reason: string };

/**
 * Исполняемая ревизия против lock потребителя. `null` — совпали. Lock не прочитался —
 * расхождение с `lockSha: null`: петля посреди прогона не вправе считать, что в нём то же.
 */
export function checkLockDrift(
    runningSha: string,
    consumerRoot: string,
    readFn?: (p: string) => string,
): TLockDrift | null {
    const r = readCoreLock(consumerRoot, readFn);
    if (!r.ok) {
        return {
            lockSha: null,
            reason: `lock ядра перестал читаться посреди прогона (${r.reason}) — нужен рестарт: старт сверит ревизию заново`,
        };
    }
    if (r.lock.sha === runningSha) return null;
    return {
        lockSha: r.lock.sha,
        reason: `${LOCK_AHEAD_PHRASE}: исполняется ${runningSha}, а ${r.path} называет ${r.lock.sha}`,
    };
}

/**
 * Подтверждена ли граница для рестарта. Вызывается на вершине цикла — итерация уже закрыта
 * и state записан; остаётся сдача: журнал сдачи с незакрытым этапом (`resumeStage`) значит,
 * что сдача идёт, и рестарт перенёс бы её середину на другой код.
 */
export function activationBoundary(
    submit: { resumeStage: string | null } | null,
): { ok: true } | { ok: false; reason: string } {
    if (submit !== null && submit.resumeStage !== null) {
        return {
            ok: false,
            reason: `сдача фазы не доведена (этап «${submit.resumeStage}») — рестарт после неё`,
        };
    }
    return { ok: true };
}

// ── Журнал активации ─────────────────────────────────────────────────────────

export type TActivation = { at: string; sha: string; from: string | null };

export type TActivationStore = {
    /** Текст журнала; `null` — журнала нет (ENOENT). Иной отказ чтения бросает. */
    read: () => string | null;
    append: (line: string) => void;
};

/** Боевое хранилище журнала по пути в каталоге состояния. */
export function activationFileStore(path: string): TActivationStore {
    return {
        read: () => {
            guardSideEffect(
                `readActivationJournal(${path})`,
                'Подай хранилище журнала активации параметром.',
            );
            try {
                return readFileSync(path, 'utf8');
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw e;
            }
        },
        append: (line) => {
            guardSideEffect(
                `appendActivationJournal(${path})`,
                'Подай хранилище журнала активации параметром.',
            );
            appendFileSync(path, line);
        },
    };
}

/** Разбор журнала строго: каждая строка — `{at, sha, from}`, иначе бросок с номером строки. */
export function parseActivationJournal(text: string): TActivation[] {
    const out: TActivation[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') continue;
        const bad = (why: string): never => {
            throw new Error(`Журнал активации, строка ${String(i + 1)}: ${why}`);
        };
        let v: unknown;
        try {
            v = JSON.parse(line);
        } catch {
            bad('не JSON');
        }
        if (v === null || typeof v !== 'object' || Array.isArray(v)) bad('не объект');
        const o = v as Record<string, unknown>;
        if (typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at))) bad('нет времени at');
        if (typeof o.sha !== 'string' || !isFullSha(o.sha)) bad('sha не полный SHA ревизии');
        if (o.from !== null && (typeof o.from !== 'string' || !isFullSha(o.from))) {
            bad('from — не полный SHA и не null');
        }
        out.push({ at: o.at as string, sha: o.sha as string, from: o.from as string | null });
    }
    return out;
}

/**
 * Записать активацию, если исполняемая ревизия отличается от последней записанной. Повторный
 * старт той же ревизии строки не добавляет: журнал отвечает «когда сменилась», а не «сколько
 * раз запускали». Возвращает записанную активацию или `null`.
 */
export function recordActivation(
    sha: string,
    store: TActivationStore,
    now: () => string,
): TActivation | null {
    const text = store.read();
    const all = text === null ? [] : parseActivationJournal(text);
    const last = all.at(-1) ?? null;
    if (last !== null && last.sha === sha) return null;
    const entry: TActivation = { at: now(), sha, from: last?.sha ?? null };
    store.append(`${JSON.stringify(entry)}\n`);
    return entry;
}

export function describeActivation(a: TActivation): string {
    return a.from === null
        ? `🔁 Активирована ревизия ${a.sha} (${a.at}), прежней в журнале нет`
        : `🔁 Активирована ревизия ${a.sha} (${a.at}), снята ${a.from}`;
}

/**
 * Строка doctor о журнале. Журнал не прочитался — провал: doctor обязан назвать, что разбор
 * падения сейчас не приведёт к исполнявшейся версии. Последняя активация разошлась с lock —
 * предупреждение: петля на прежней ревизии ещё жива или не перезапущена.
 */
export function doctorActivationLine(
    store: TActivationStore,
    lockSha: string | null,
): { ok: boolean; warn?: boolean; line: string } {
    let all: TActivation[];
    try {
        const text = store.read();
        all = text === null ? [] : parseActivationJournal(text);
    } catch (e) {
        return { ok: false, line: `журнал активации не читается: ${(e as Error).message}` };
    }
    const last = all.at(-1);
    if (last === undefined) {
        return { ok: true, line: 'журнал активации пуст — ревизия из установки ещё не стартовала' };
    }
    const from = last.from === null ? 'прежней в журнале нет' : `снята ${last.from}`;
    const head = `журнал активации: последняя — ${last.sha} (${last.at}), ${from}; записей ${String(all.length)}`;
    if (lockSha !== null && lockSha !== last.sha) {
        return { ok: true, warn: true, line: `${head}; lock называет ${lockSha} — нужен рестарт` };
    }
    return { ok: true, line: head };
}
