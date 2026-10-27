// Сторож свободного места под каталогом состояния (задача 95, риск R11).
//
// Полный диск петля сама не замечает: `log()` теперь называет отказ записи в stderr, но
// stderr читает только тот, кто смотрит в панель, а state, не записавшийся перед рестартом,
// всплывает уже потерянной фазой. Поэтому сигнал идёт РАНЬШЕ отказа — по порогу
// `observability.diskMinFreeMb`, пока запись ещё проходит, и идёт он из монитора: тот тикает
// и тогда, когда раннер на два часа ушёл в синхронную сессию.
//
// Эпизод — от падения ниже порога до возврата выше него: пуш один на эпизод, иначе каждый
// тик монитора будил бы человека тем же сообщением. Сбой доставки на prod эпизод не
// защёлкивает — тот же приём, что у DEADMAN: единственный ранний сигнал терять нельзя.

import fs from 'node:fs';

export type TStatfs = (p: string) => { bavail: number; bsize: number };

export function freeBytes(dir: string, statfsFn: TStatfs = fs.statfsSync): number | null {
    try {
        const s = statfsFn(dir);
        return Number(s.bavail) * Number(s.bsize);
    } catch {
        return null;
    }
}

export type TDiskEval =
    { known: false } | { known: true; low: boolean; freeMb: number; minFreeMb: number };

export function evalDisk(free: number | null, minFreeMb: number): TDiskEval {
    if (free === null) return { known: false };
    const freeMb = Math.floor(free / (1024 * 1024));
    return { known: true, low: freeMb < minFreeMb, freeMb, minFreeMb };
}

export function diskLowMessage(ev: { freeMb: number; minFreeMb: number }, dir: string): string {
    return (
        `💾 Ralph: мало места под состоянием петли — свободно ${ev.freeMb} МБ при пороге ` +
        `${ev.minFreeMb} МБ (${dir}). Запись лога и state ещё проходит; когда место кончится, ` +
        'она откажет. Освободи место (порог — observability.diskMinFreeMb).'
    );
}

type TPushFn = (
    msg: string,
    cfg: unknown,
    opts: { logFn: (m: string) => void; dry: boolean },
) => boolean;

// Возвращает, защёлкнут ли эпизод после этого тика; вызывающий держит значение между тиками.
export function maybePushDiskLow(
    ev: TDiskEval,
    latched: boolean,
    {
        pushFn,
        cfg,
        dir,
        logFn = console.log,
    }: {
        pushFn: TPushFn;
        cfg: { profileName?: string } | null;
        dir: string;
        logFn?: (m: string) => void;
    },
): boolean {
    if (!ev.known) return latched;
    if (!ev.low) return false;
    if (latched) return true;
    const delivered = pushFn(diskLowMessage(ev, dir), cfg, { logFn, dry: false });
    const deliveryAttempted = !!cfg && cfg.profileName === 'prod';
    return deliveryAttempted && !delivered ? false : true;
}
