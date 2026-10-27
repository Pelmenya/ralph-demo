// Владение репозиторием на хосте: один writer на один `origin` (канон, задача 76; R15).
//
// `ralph.lock` (state-lock.ts) защищает ДЕРЕВО запуска: второй раннер на том же runtimeDir
// не стартует. Второй КЛОН того же `origin` он не видит вовсе — у клона свой runtimeDir,
// свой лок, — а PR, ветки и карточки у обоих общие. Чаще всего это случается не по
// злому умыслу, а при переключении петли с одной копии ядра на другую: старая ещё жива,
// новая уже поднята, и обе берут одну и ту же карточку.
//
// Поэтому рядом с локом дерева — запись владения по ИДЕНТИЧНОСТИ репозитория: файл на ключ
// «хэш канонического origin» в общем каталоге хоста. Каталог не из конфига потребителя
// намеренно: две копии с разными конфигами обязаны смотреть в одно место, иначе барьер
// мимо них. Умолчание — `/tmp/ralph-owners`, переопределение — `RALPH_OWNERS_DIR` (только
// абсолютный путь: относительный разрешился бы от cwd, свой у каждого клона). Умолчание
// НЕ `os.tmpdir()`: тот читает `TMPDIR`, и две копии с разным окружением получили бы два
// реестра. Служба systemd с `PrivateTmp` видит свой `/tmp` — ей реестр задаётся явно.
//
// Граница названа вслух: это защита ОДНОГО хоста и одного пользователя. Две машины на одном
// `origin` реестр не видит; координатор нескольких петель — вне скоупа (мультипетля).
// Запуск под другим пользователем упирается в права каталога и останавливается с причиной:
// общий каталог с правом записи для всех открыл бы любому подделку записей.
//
// Правило снятия устаревшего владения: владелец мёртв (нет процесса или он зомби) либо его
// pid занят другим процессом — сирота, запись снимается и берётся заново. Живость — пара
// «pid + время старта» из `/proc/<pid>/stat`, а не cmdline, как у лока дерева: лок ищет в
// cmdline относительный путь `ralph.js`, а клон из другой раскладки даёт другой cmdline —
// живая копия сошла бы за сироту ровно при переключении копий. Не удалось выяснить живость
// (процесс есть, а `/proc` не читается — `hidepid`, права) — стоп, а не «мёртв»: снять
// владение живого хуже, чем не стартовать. Таймаута нет: живой раннер может ждать окна
// лимита часами, и истёкший TTL отдал бы репозиторий второй копии посреди работы первой.
//
// Снятие сироты — под мьютексом, названным по САМОЙ сироте (`<запись>.reclaim-<pid>-<старт>`):
// двое, увидевшие одну сироту, иначе по очереди удалили бы и записали, и второй удалил бы
// запись первого. Победитель перечитывает запись под мьютексом и снимает её, только если
// она всё ещё та же. Мьютекс прерванного снятия остаётся, и разбирает его человек: снять
// его автоматически значило бы вернуть ту же гонку, только на мьютексе. Окно — между
// созданием мьютекса и удалением записи, то есть микросекунды.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { guardSideEffect } from '../shared/side-effect-guard.ts';

export type TOwnerRecord = {
    pid: number;
    /** Время старта процесса-владельца (поле 22 `/proc/<pid>/stat`): отличает его от pid-reuse. */
    startTime: string;
    repoId: string;
    /** Лок дерева владельца — по нему оператор находит, КАКОЙ клон держит репозиторий. */
    lockPath: string;
};

/** Что известно о процессе: нет его, жив (с временем старта) или выяснить не удалось. */
export type TProcProbe =
    | { state: 'dead' }
    | { state: 'alive'; startTime: string }
    | { state: 'unknown'; reason: string };

export type TOwnerDeps = {
    readFn?: (p: string) => string;
    /** Эксклюзивное создание: обязано бросить EEXIST, если файл уже есть. */
    writeExclusiveFn?: (p: string, data: string) => void;
    removeFn?: (p: string) => void;
    mkdirFn?: (p: string) => void;
    probeFn?: (pid: number) => TProcProbe;
    logFn?: (msg: string) => void;
    failFn: (msg: string) => void;
};

/**
 * Каноническая идентичность репозитория по адресу `origin`. Одна и та же репа приходит
 * в разных клонах разными строками — `https://host/org/repo.git`, `git@host:org/repo`,
 * `ssh://git@host/~/org/repo/` — и барьер, сравнивающий строки как есть, пропустил бы
 * вторую копию ровно на смене транспорта.
 *
 * Где нормализация неоднозначна, она склеивает, а не разводит: ложный отказ виден и
 * снимается человеком, пропуск второго writer не виден никому. Поэтому порт отбрасывается
 * любой (ssh на нестандартном порту и https одной площадки — одна репа), а путь от корня
 * и от домашнего каталога ssh не различаются (на площадках это одно и то же). Регистр
 * приводится только у хоста: путь на части площадок регистрозависим.
 *
 * Локальный путь (bare-remote, `file://`) — абсолютный путь после `realpath`. Относительный
 * разрешается от `baseDir` — каталога клона, где его прочитал git, а не от cwd процесса.
 */
export function canonicalRepoId(
    originUrl: string,
    baseDir: string,
    realpathFn: (p: string) => string = fs.realpathSync,
): string {
    const raw = originUrl.trim();
    if (!raw) throw new Error('адрес origin пуст');
    const strip = (p: string) => p.replace(/\/+$/, '').replace(/\.git$/, '');
    const remotePath = (p: string) => strip(p.replace(/^\/+/, '').replace(/^~\/+/, ''));

    const url = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(raw);
    if (url) {
        const scheme = url[1].toLowerCase();
        if (scheme === 'file') return localId(url[3] ?? '/', baseDir, realpathFn, strip);
        const host = url[2]
            .replace(/^[^@]*@/, '')
            .replace(/:\d*$/, '')
            .toLowerCase();
        return `${host}/${remotePath(url[3] ?? '')}`;
    }
    // scp-форма git: `user@host:path`. Двоеточие до первого слэша и не буква диска.
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(raw);
    if (scp && !/^[a-z]$/i.test(scp[1])) {
        return `${scp[1].toLowerCase()}/${remotePath(scp[2])}`;
    }
    return localId(raw, baseDir, realpathFn, strip);
}

function localId(
    p: string,
    baseDir: string,
    realpathFn: (p: string) => string,
    strip: (p: string) => string,
): string {
    const abs = path.resolve(baseDir, p);
    let real = abs;
    try {
        real = realpathFn(abs);
    } catch {
        // Пути нет — сравниваем по абсолютному: remote, которого нет на диске, у двух клонов
        // всё равно записан одной строкой, а падать здесь значило бы не стартовать вовсе.
    }
    return `file:${strip(real)}`;
}

/** Не от `os.tmpdir()`: он зависит от `TMPDIR` процесса — см. докблок модуля. */
export const DEFAULT_OWNERS_DIR = '/tmp/ralph-owners';

/** Каталог реестра хоста. Не из конфига потребителя — см. докблок модуля. */
export function ownersDir(env: NodeJS.ProcessEnv = process.env): string {
    const fromEnv = env.RALPH_OWNERS_DIR?.trim();
    if (!fromEnv) return DEFAULT_OWNERS_DIR;
    if (!path.isAbsolute(fromEnv)) {
        throw new Error(
            `RALPH_OWNERS_DIR=${fromEnv} не абсолютный: от cwd у каждого клона вышел бы свой реестр`,
        );
    }
    return fromEnv;
}

export function ownerFilePath(dir: string, repoId: string): string {
    const key = createHash('sha256').update(repoId).digest('hex').slice(0, 16);
    return path.join(dir, `${key}.owner`);
}

function parseRecord(raw: string): TOwnerRecord | null {
    try {
        const v: unknown = JSON.parse(raw);
        if (!v || typeof v !== 'object') return null;
        const r = v as Record<string, unknown>;
        if (!Number.isInteger(r.pid) || (r.pid as number) <= 0) return null;
        if (typeof r.startTime !== 'string' || !r.startTime) return null;
        if (typeof r.repoId !== 'string' || typeof r.lockPath !== 'string') return null;
        return {
            pid: r.pid as number,
            startTime: r.startTime,
            repoId: r.repoId,
            lockPath: r.lockPath,
        };
    } catch {
        return null;
    }
}

/**
 * Живость процесса. `kill(pid, 0)` отвечает «есть ли процесс» и тогда, когда `/proc`
 * чужого пользователя скрыт: ESRCH — нет, EPERM — есть, но чужой. Дальше `/proc/<pid>/stat`:
 * состояние (поле 3) и время старта (поле 22). Имя процесса (поле 2) в скобках и может
 * содержать пробелы и скобки, поэтому поля считаются от ПОСЛЕДНЕЙ `)`. Зомби (`Z`, `X`)
 * — мёртв: он уже вышел, его только не убрал родитель, и писать в репозиторий он не может.
 */
export function probeProcess(
    pid: number,
    {
        killFn = process.kill,
        readFn = (p: string) => fs.readFileSync(p, 'utf-8'),
    }: { killFn?: (pid: number, sig: number) => unknown; readFn?: (p: string) => string } = {},
): TProcProbe {
    try {
        killFn(pid, 0);
    } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === 'ESRCH') return { state: 'dead' };
        if (code !== 'EPERM') return { state: 'unknown', reason: `kill 0: ${String(code ?? e)}` };
    }
    let stat: string;
    try {
        stat = readFn(`/proc/${pid}/stat`);
    } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException)?.code;
        return { state: 'unknown', reason: `/proc/${pid}/stat: ${String(code ?? e)}` };
    }
    const fields = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/);
    // После `)` первым идёт поле 3 (состояние), значит поле 22 — индекс 19.
    if (fields[0] === 'Z' || fields[0] === 'X') return { state: 'dead' };
    const start = fields[19];
    if (!start || !/^\d+$/.test(start)) {
        return { state: 'unknown', reason: `/proc/${pid}/stat без времени старта` };
    }
    return { state: 'alive', startTime: start };
}

// Записи — под предохранителем #138: тест, забывший подменить запись, насорил бы
// в настоящий реестр хоста и заблокировал бы живую петлю на той же машине.
const HINT = 'Передай writeExclusiveFn/removeFn/mkdirFn в deps acquireRepoOwnership.';
const defaultDeps = {
    readFn: (p: string) => fs.readFileSync(p, 'utf-8'),
    writeExclusiveFn: (p: string, data: string) => {
        guardSideEffect(`repo-owner write (${p})`, HINT);
        fs.writeFileSync(p, data, { flag: 'wx' });
    },
    removeFn: (p: string) => {
        guardSideEffect(`repo-owner remove (${p})`, HINT);
        try {
            fs.unlinkSync(p);
        } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
        }
    },
    probeFn: (pid: number) => probeProcess(pid),
    mkdirFn: (p: string) => {
        guardSideEffect(`repo-owner mkdir (${p})`, HINT);
        fs.mkdirSync(p, { recursive: true });
    },
};

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

/**
 * Взятие владения репозиторием:
 *   записи нет                         → пишем свою эксклюзивно, стартуем;
 *   живой владелец                     → ОТКАЗ с pid и локом его дерева;
 *   сирота (мёртв, зомби, pid-reuse)   → событие в лог, снятие под мьютексом, взятие;
 *   живость не выяснить, запись битая  → СТОП fail-closed.
 * Любой отказ файловой системы (права каталога, место) — тоже стоп с причиной, а не стек.
 */
export function acquireRepoOwnership(
    {
        dir,
        repoId,
        lockPath,
        pid = process.pid,
    }: { dir: string; repoId: string; lockPath: string; pid?: number },
    deps: TOwnerDeps,
): boolean {
    const d = { ...defaultDeps, logFn: () => {}, ...deps };
    const file = ownerFilePath(dir, repoId);
    const stop = (msg: string): false => {
        d.failFn(msg);
        return false;
    };
    try {
        return take();
    } catch (e: unknown) {
        return stop(
            `Реестр владения ${dir} недоступен (${String(code(e) ?? e)}) — не берусь решать, ` +
                `работает ли на ${repoId} другая копия. Проверь права и место или задай ` +
                `RALPH_OWNERS_DIR.`,
        );
    }

    function take(): boolean {
        const self = d.probeFn(pid);
        if (self.state !== 'alive') {
            // Без своего времени старта запись не отличить от pid-reuse — писать такую нельзя.
            return stop(
                `Не выяснено время старта своего процесса (pid ${pid}) — владение не взять.`,
            );
        }
        const mine = JSON.stringify({ pid, startTime: self.startTime, repoId, lockPath });
        const raced = () =>
            stop(
                `Владение ${repoId} перехвачено в момент взятия (${file}) — вторая копия ` +
                    `раннера стартовала одновременно. Второй writer на тот же репозиторий запрещён.`,
            );
        const claim = (): boolean => {
            try {
                d.writeExclusiveFn(file, mine);
                return true;
            } catch (e: unknown) {
                if (code(e) === 'EEXIST') return raced();
                throw e;
            }
        };

        d.mkdirFn(dir);
        let raw: string;
        try {
            raw = d.readFn(file);
        } catch (e: unknown) {
            if (code(e) === 'ENOENT') return claim();
            throw e;
        }
        const held = parseRecord(raw);
        if (!held) {
            return stop(
                `Запись владения ${file} битая — не берусь решать, работает ли на ${repoId} ` +
                    `другая копия. Разберись руками и перезапусти.`,
            );
        }
        // Своя запись этого же процесса — повтор взятия, а не второй writer.
        if (raw === mine) return true;

        const probe = d.probeFn(held.pid);
        if (probe.state === 'unknown') {
            return stop(
                `Не выяснить, жив ли владелец ${repoId} pid ${held.pid} (${probe.reason}), ` +
                    `лок ${held.lockPath}. Снять владение живой копии хуже, чем не стартовать.`,
            );
        }
        if (probe.state === 'alive' && probe.startTime === held.startTime) {
            return stop(
                `Репозиторий ${repoId} уже ведёт другая копия раннера: pid ${held.pid}, лок ` +
                    `${held.lockPath}. Второй writer на тот же origin запрещён — гонка за PR, ` +
                    `ветки и карточки. Останови ту копию или дождись её выхода.`,
            );
        }
        return reclaim(held, raw, claim, raced);
    }

    function reclaim(
        held: TOwnerRecord,
        raw: string,
        claim: () => boolean,
        raced: () => false,
    ): boolean {
        const mutex = `${file}.reclaim-${held.pid}-${held.startTime}`;
        try {
            d.writeExclusiveFn(mutex, String(pid));
        } catch (e: unknown) {
            if (code(e) !== 'EEXIST') throw e;
            return stop(
                `Сироту ${file} (pid ${held.pid}) уже снимает другой запуск: мьютекс ${mutex}. ` +
                    `Если запуска нет, снятие прервалось — удали мьютекс руками и перезапусти.`,
            );
        }
        try {
            // Под мьютексом — перечитать: запись могла смениться, пока мы решали.
            let now: string | null;
            try {
                now = d.readFn(file);
            } catch (e: unknown) {
                if (code(e) !== 'ENOENT') throw e;
                now = null;
            }
            if (now !== null && now !== raw) return raced();
            d.logFn(
                `🔓 Устаревшее владение ${repoId}: pid ${held.pid} мёртв или занят другим ` +
                    `процессом (лок ${held.lockPath}) — снимаю ${file} и беру.`,
            );
            if (now !== null) d.removeFn(file);
            return claim();
        } finally {
            // Сбой уборки мьютекса не меняет исход: он назван по СТАРОЙ сироте, и после её
            // удаления ничего не охраняет. Превратить здесь успешное взятие в отказ значило бы
            // выйти, не зарегистрировав снятие своей записи, — то есть создать себе сироту.
            try {
                d.removeFn(mutex);
            } catch (e: unknown) {
                d.logFn(`⚠ Мьютекс ${mutex} не убран (${String(code(e) ?? e)}) — удали руками.`);
            }
        }
    }
}

/**
 * Снятие СВОЕЙ записи на выходе: и pid, и время старта — наши. Чужую не трогаем. Подменить
 * запись живого владельца мог бы только реклейм, а он требует мёртвого владельца, поэтому
 * между проверкой и удалением запись сменить некому.
 */
export function releaseRepoOwnershipIfOurs(
    { dir, repoId, pid = process.pid }: { dir: string; repoId: string; pid?: number },
    deps: Pick<TOwnerDeps, 'readFn' | 'removeFn' | 'probeFn'> = {},
): void {
    const d = { ...defaultDeps, ...deps };
    const file = ownerFilePath(dir, repoId);
    try {
        const held = parseRecord(d.readFn(file));
        const self = d.probeFn(pid);
        if (held?.pid !== pid || self.state !== 'alive') return;
        if (held.startTime !== self.startTime) return;
        d.removeFn(file);
    } catch {
        // Выход процесса: снять не вышло — следующий запуск разберёт запись как сироту.
    }
}
