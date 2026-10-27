// Три приёмника одной строки лога: человекочитаемый лог, структурный журнал событий и
// heartbeat (задача 95, риск R11 исследования).
//
// До задачи `log()` дописывал строку в `ralph.log` и глотал любую ошибку записи. Свежесть
// этого же файла — единственный признак жизни петли для deadman, поэтому одна неудавшаяся
// запись (полный диск, права, снесённый каталог) превращалась в ложный DEADMAN, а сама
// причина не оставляла следа нигде. Здесь три приёмника пишутся НЕЗАВИСИМО — отказ одного
// не отменяет другие — и отказ каждого называется вслух в stderr, раз на эпизод.
//
// **Журнал событий** (`*.events.jsonl`) — строка на событие с монотонным `seq`. Человеческий
// лог читается глазами и регулярками панели; журнал читается машиной, и пропуск в `seq`
// виден как пропуск, а не как «тихо было». Туда же ложатся события, у которых строки в
// человеческом логе нет вовсе, — стоимость попытки (`attempt-cost.ts`). `seq` живёт в
// памяти процесса и на рестарте начинается с 1 заново: пропуск — это разрыв ВНУТРИ серии,
// а возврат к 1 — новый процесс, не потеря.
//
// Цена названа вслух: каждая строка лога ложится в журнал целиком, так что на диске петля
// растёт вдвое против одного `ralph.log`, и ротации нет ни у того, ни у другого. Дубль
// оставлен намеренно — журнал обязан быть полным сам по себе, иначе пропуск в нём не
// отличить от строки, которой в журнале не было по замыслу. О подходе к полному диску
// предупреждает сторож диска (`observability.diskMinFreeMb`). Спутники лога
// названы в описи (`runtime-paths.ts`), и `--migrate-runtime` переносит их вместе с ним.
//
// **Heartbeat** (`*.heartbeat`) — файл ФИКСИРОВАННОГО размера, который перезаписывается на
// месте (`r+`, смещение 0, без усечения). Перезапись уже выделенного блока новых блоков у
// файловой системы не просит, поэтому heartbeat переживает полный диск, на котором
// дописывание лога уже отказывает: mtime двигается, а содержимое несёт последнюю строку лога
// — по ней монитор узнаёт режим петли, даже если сама строка в лог не легла. Без строки
// режим считался бы по устаревшему хвосту: сессия, чей `▶ claude -p` не записался, жила бы
// под пятиминутным порогом вместо двухчасового и давала бы тот же ложный DEADMAN.
// Оговорка названа: на файловой системе с copy-on-write (btrfs, zfs) перезапись блок
// выделяет, и на полном диске heartbeat откажет вместе с логом — тогда отказ виден в stderr.
//
// Пути обоих спутников выводятся из пути лога, а не из описи `runtime-paths.ts`: у боевого
// и у не-боевого прогона (`chooseLogPath`) свои логи, и спутник чужого прогона не имеет права
// освежать боевой heartbeat — ровно по той причине, по которой dry-run не пишет в боевой лог.

import fs from 'node:fs';

export const HEARTBEAT_RECORD_BYTES = 1024;

export type TCompanionPaths = { events: string; heartbeat: string };

export function companionPaths(logPath: string): TCompanionPaths {
    const base = logPath.endsWith('.log') ? logPath.slice(0, -'.log'.length) : logPath;
    return { events: `${base}.events.jsonl`, heartbeat: `${base}.heartbeat` };
}

export type THeartbeat = { ts: string; msg: string };

// Запись фиксированной длины: JSON, добитый пробелами, с переводом строки в конце. Длина
// постоянна, поэтому перезапись на месте никогда не оставляет хвоста прошлой записи, а
// разбор не зависит от того, какая запись была длиннее.
export function encodeHeartbeat(ts: string, msg: string): Buffer {
    let text = msg;
    let json = JSON.stringify({ ts, msg: text });
    while (Buffer.byteLength(json) > HEARTBEAT_RECORD_BYTES - 1 && text.length > 0) {
        text = text.slice(0, Math.max(0, text.length - 64));
        json = JSON.stringify({ ts, msg: text });
    }
    const buf = Buffer.alloc(HEARTBEAT_RECORD_BYTES, ' ');
    buf.write(json, 0, 'utf8');
    buf.write('\n', HEARTBEAT_RECORD_BYTES - 1, 'utf8');
    return buf;
}

export function decodeHeartbeat(raw: string): THeartbeat | null {
    try {
        const v = JSON.parse(raw.trim()) as unknown;
        if (!v || typeof v !== 'object') return null;
        const { ts, msg } = v as Record<string, unknown>;
        return typeof ts === 'string' && typeof msg === 'string' ? { ts, msg } : null;
    } catch {
        return null;
    }
}

export type TSinkFs = Pick<
    typeof fs,
    'appendFileSync' | 'openSync' | 'writeSync' | 'closeSync' | 'writeFileSync'
>;

export function writeHeartbeat(p: string, record: Buffer, fsImpl: TSinkFs = fs): void {
    let fd: number;
    try {
        fd = fsImpl.openSync(p, 'r+');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        fsImpl.writeFileSync(p, record);
        return;
    }
    try {
        fsImpl.writeSync(fd, record, 0, record.length, 0);
    } finally {
        fsImpl.closeSync(fd);
    }
}

export type TSinkName = 'log' | 'events' | 'heartbeat';
export type TSinkReport = Record<TSinkName, boolean>;

// Предупреждение об отказе приёмника — раз на эпизод: строка на каждый вызов `log()`
// утопила бы stderr, а молчание после первой повторяло бы прежний `catch {}`. Эпизод
// кончается первой удачной записью, и об этом тоже сказано: иначе по stderr не понять,
// длится ли отказ до сих пор.
export function createLogSinks({
    fsImpl = fs,
    errFn = (msg: string) => console.error(msg),
}: { fsImpl?: TSinkFs; errFn?: (msg: string) => void } = {}) {
    let seq = 0;
    const failing: Record<TSinkName, boolean> = { log: false, events: false, heartbeat: false };

    function attempt(name: TSinkName, target: string, fn: () => void): boolean {
        try {
            fn();
        } catch (e) {
            if (!failing[name]) {
                failing[name] = true;
                errFn(
                    `⚠ Запись ${name} не удалась (${target}): ${(e as Error).message} — ` +
                        'остальные приёмники пишутся дальше; следующее предупреждение — после восстановления.',
                );
            }
            return false;
        }
        if (failing[name]) {
            failing[name] = false;
            errFn(`✓ Запись ${name} восстановлена (${target}).`);
        }
        return true;
    }

    function emit(target: string, kind: string, data: Record<string, unknown>, ts: string) {
        seq += 1;
        const { events } = companionPaths(target);
        // Служебные поля — последними: полезная нагрузка с полем `seq`/`ts`/`kind` иначе
        // перезаписала бы их и тихо сломала монотонность, на которой держится журнал.
        const record = JSON.stringify({ ...data, seq, ts, kind });
        return attempt('events', events, () => fsImpl.appendFileSync(events, record + '\n'));
    }

    // Порядок — лог, журнал, heartbeat — и каждый в своём `try`. Heartbeat последним: он
    // утверждает «строка обработана», и после него не остаётся шага, который мог бы бросить.
    function write(target: string, msg: string, ts: string): TSinkReport {
        const line = `[${ts}] ${msg}`;
        const log = attempt('log', target, () => fsImpl.appendFileSync(target, line + '\n'));
        // `logLost` — строка есть только здесь: по журналу видно, чего не хватает в логе.
        const events = emit(target, 'log', log ? { msg } : { msg, logLost: true }, ts);
        const { heartbeat: hb } = companionPaths(target);
        const heartbeat = attempt('heartbeat', hb, () =>
            writeHeartbeat(hb, encodeHeartbeat(ts, msg), fsImpl),
        );
        return { log, events, heartbeat };
    }

    return { write, emit };
}
