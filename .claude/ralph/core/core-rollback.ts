/**
 * Откат ревизии ядра: `./ralph rollback` (Фаза 13, #103).
 *
 * Откат — единственная страховка потребителя от дефектной ревизии, но откат на ревизию,
 * которая не читает state новой схемы, хуже отказа: старое ядро прочитало бы чужой state и
 * приняло решения по мусору. Отсюда обязательства модуля:
 *
 *   1. **Цель отката — из журнала активации, а не из памяти человека** (`rollbackTarget`).
 *      «Предыдущая» — та ревизия, с которой снята ревизия из lock (`from` её последней
 *      активации). Lock, впереди журнала (update смерджен, рестарта ещё не было), откатывается
 *      на последнюю активированную: она и исполняется сейчас. Журнала нет или «снята» пусто —
 *      отказ: откатываться не на что, и угадывать SHA launcher не вправе, как и при install.
 *   2. **Через необратимую миграцию state отката нет** (`irreversibleStateProblem`).
 *      Миграции state односторонние: ядро переводит прежние схемы в свою и пишет свою, а
 *      обратного перевода не существует. Поэтому подъём схемы между целью и ревизией из lock
 *      — уже необратимость, даже если новая ревизия ещё не успела записать state: lock стоит в
 *      `main`, и первый же её старт переведёт state. Вторая половина — state на диске: схема
 *      новее той, что цель читает, отвергается, откуда бы она ни взялась. State, который не
 *      читается, — тоже отказ: «не знаю, какой схемы» не значит «совместим». Отказ называет
 *      выход — фикс вперёд новой ревизией через update.
 *   3. **Ревизия, на которую возможен откат, не чистится** (`retainedRevisions`,
 *      `pruneCandidates`). Удалить её значило бы оставить откат без дерева ровно тогда, когда
 *      он понадобился: источник ревизии к тому моменту мог уехать или стоять на другой машине.
 *
 * Чего модуль НЕ обещает, сказано вслух. Каталог установок (`~/.local/share/ralph/`) общий на
 * всех потребителей пользователя, а журнал и lock — у каждого свои: набор «не трогать» одного
 * потребителя ничего не знает о ревизиях соседа. Поэтому команды чистки launcher пока не
 * заводит — планировщик принимает наборы всех потребителей, а реестра потребителей на хосте
 * нет. Повторный откат после отката ведёт обратно на снятую ревизию (`from` новой
 * активации): журнал отвечает «с какой снята», а не «какая была дефектной».
 *
 * TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).
 */
import type { TCompatVersions, TObservation } from './compat.ts';
import { CORE_LOCK_PATH, isFullSha, type TCoreLock } from './core-install.ts';
import { describeVersions } from './core-update.ts';
import type { TActivation } from './core-activation.ts';

export type TRollbackTarget = { ok: true; sha: string } | { ok: false; reason: string };

/** Ревизия, на которую откатывается lock, по журналу активации. */
export function rollbackTarget(journal: readonly TActivation[], lockSha: string): TRollbackTarget {
    if (journal.length === 0) {
        return {
            ok: false,
            reason: 'журнал активации пуст — ни одна ревизия здесь не стартовала, откатываться не на что',
        };
    }
    const own = [...journal].reverse().find((a) => a.sha === lockSha);
    if (own === undefined) {
        // Lock впереди журнала: ревизия из lock не стартовала, исполняется последняя активация.
        return { ok: true, sha: (journal.at(-1) as TActivation).sha };
    }
    if (own.from === null) {
        return {
            ok: false,
            reason: `ревизия ${lockSha} — первая в журнале активации, прежней нет — откатываться не на что`,
        };
    }
    return { ok: true, sha: own.from };
}

/** Подсказка выхода из запрещённого отката — одна на все его причины. */
export const FIX_FORWARD_HINT =
    'откат не поддерживается — фикс вперёд: исправь дефект новой ревизией и поставь её ./ralph update <ревизия с фиксом>';

export type TIrreversibleInput = {
    /** Версии цели отката — её собственным кодом. */
    target: TCompatVersions;
    /** Lock ревизии, с которой откатываемся. */
    current: TCoreLock;
    /** State на диске (`observeState`). */
    state: TObservation;
};

/**
 * Причина, по которой откат прошёл бы через необратимую миграцию state. `null` — не прошёл бы.
 * Зовётся ДО любой записи: отказ должен остановить откат раньше правки lock.
 */
export function irreversibleStateProblem(input: TIrreversibleInput): string | null {
    const reads = input.target.state;
    if (input.current.versions.state > reads) {
        return (
            `state: между ревизиями необратимая миграция — ревизия из lock пишет ` +
            `v${String(input.current.versions.state)}, цель отката читает только до v${String(reads)}; ` +
            FIX_FORWARD_HINT
        );
    }
    if (input.state.kind === 'invalid') {
        return `state: ${input.state.reason} — схему не проверить, откат вслепую не идёт`;
    }
    if (input.state.kind === 'version' && input.state.version > reads) {
        return (
            `state: на диске схема v${String(input.state.version)}, цель отката читает только до ` +
            `v${String(reads)}; ${FIX_FORWARD_HINT}`
        );
    }
    return null;
}

/** Имя ветки PR отката: своё, чтобы не столкнуться с веткой update той же ревизии. */
export function rollbackBranchName(sha: string): string {
    return `ralph/rollback-${sha.slice(0, 12)}`;
}

export function rollbackPrText(
    from: TCoreLock,
    to: TCoreLock,
): { title: string; body: string; message: string } {
    const short = to.sha.slice(0, 12);
    const title = `revert(core): откат ревизии ядра на ${short}`;
    const body = [
        `Откат ревизии ядра в \`${CORE_LOCK_PATH}\`, подготовленный \`./ralph rollback\`.`,
        '',
        `- было: \`${from.sha}\``,
        `- стало: \`${to.sha}\` (прежняя по журналу активации)`,
        `- версии слоёв: ${describeVersions(to.versions)}`,
        '',
        'Прежняя ревизия лежит в каталоге установок и сверена со своим манифестом; схема state ' +
            'между ревизиями не поднималась. После мерджа петля выйдет на рестарт на границе ' +
            'итерации, и `./ralph start` запустит ревизию из lock. State не переписывается.',
    ].join('\n');
    return { title, body, message: `${title}\n\n${body}\n` };
}

/**
 * Ревизии одного потребителя, которые чистка обязана оставить: из lock, исполняемая (последняя
 * активация) и цель отката. Журнал, который не разобрался, сюда не доходит — его отказ
 * останавливает чистку целиком: без журнала цель отката неизвестна.
 */
export function retainedRevisions(journal: readonly TActivation[], lockSha: string): Set<string> {
    const keep = new Set<string>([lockSha]);
    const last = journal.at(-1);
    if (last !== undefined) keep.add(last.sha);
    const target = rollbackTarget(journal, lockSha);
    if (target.ok) keep.add(target.sha);
    return keep;
}

/**
 * Каталоги установок, которые можно удалить: только имена-ревизии (полный SHA) вне всех
 * наборов «оставить». Прочее (`.<sha>.partial-…` прерванной установки, чужие файлы) чистка не
 * трогает: недоустановку снимает следующая установка, проверив, что владелец мёртв.
 */
export function pruneCandidates(
    installed: readonly string[],
    keepSets: readonly ReadonlySet<string>[],
): string[] {
    return installed
        .filter((name) => isFullSha(name))
        .filter((name) => !keepSets.some((k) => k.has(name)))
        .sort();
}
