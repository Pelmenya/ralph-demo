/**
 * Команды launcher `./ralph`: install, update, rollback, doctor, start, stop, version (Фаза 12, `#36`
 * часть 1; update — Фаза 13, #102, `core-update.ts`; rollback — #103, `core-rollback.ts`).
 *
 * Пока человек вбивал SHA и пути руками, продукта не было — была инструкция по сборке
 * (PRD, сценарий владельца проекта). Здесь механизм доставки (`core-install.ts`) и контракт
 * совместимости (`compat.ts`) собраны в четыре команды, и у каждой одно обязательство:
 *
 *   - **install** ставит ревизию из `.ralph/core.lock`, а при пустом `.ralph/` — названную
 *     явно (`--rev`) из названного источника, и пишет lock. «Последней» ревизии нет: SHA,
 *     который выбрал не человек, — та же неизвестность, ради которой lock заведён. Lock,
 *     который есть, но не читается, install не перезаписывает: битый lock — повод
 *     разобраться, а не начать с чистого листа. Смена ревизии — `update` (Фаза 13), и
 *     `--rev`, разошедшийся с lock, — отказ, а не тихая переустановка.
 *   - **rollback** — обратная смена ревизии тем же путём PR, что update; цель — из журнала
 *     активации, а откат через необратимую миграцию state отвергается до правки lock
 *     (`core-rollback.ts`).
 *   - **doctor** — те же проверки без старта, и проваленная проверка не прячет следующую:
 *     человек чинит установку за один заход, а не по одной причине на запуск. Проверка,
 *     которой нужен результат проваленной, не «проходит» и не молчит — она названа
 *     пропущенной с причиной. Код изменённого дерева doctor не исполняет: версии ревизии и
 *     `--doctor` ядра спрашиваются только у дерева, совпавшего с lock.
 *   - **start** — те же проверки, затем `ralph.js` установленной ревизии. Ядро сверяет
 *     себя с lock ещё раз в `main()`: launcher отвечает за то, ЧТО запускать, ядро — за то,
 *     что запущено именно оно. Ядро, вышедшее на рестарт (lock сменился, #38), start
 *     запускает заново по свежему lock — это и есть активация новой ревизии.
 *   - **stop** кладёт запрос мягкой остановки (`ralph.stop`, #88) и не шлёт ни одного
 *     сигнала: петля слышит запрос только на границе итерации, начатая сессия доводится.
 *     Сигнал прервал бы сессию посреди правки, и дерево осталось бы грязным. Лока нет или
 *     его владелец мёртв (брошен после `kill -9`, OOM) — отказ: запрос без живой петли
 *     остановил бы следующий старт на первом шаге. Живой владелец — раннер ЛЮБОЙ ревизии
 *     каталога установок, а не только той, что сейчас в lock (#136): `git pull` меняет lock
 *     под идущей петлёй, и та остаётся живой.
 *
 * Слой «launcher» в контракте совместимости — шим `./ralph` у потребителя
 * (`examples/ralph`), а не этот модуль: модуль едет с ревизией ядра и с ней совпадает по
 * построению, а шим живёт в дереве потребителя и обновляется отдельно. Поэтому версию
 * launcher называет `RALPH_LAUNCHER_VERSION` из окружения, которое выставил шим.
 *
 * Чего модуль НЕ обещает, сказано вслух. Шим исполняет `launcher.mts` установленной
 * ревизии ДО сверки её дерева: правка самого launcher в установке снимает сверку launcher,
 * и тогда остаётся только сверка в `main()` ядра — того же дерева. Барьер, которого правкой
 * установки не снять, требует сверщика вне неё; здесь его нет.
 *
 * TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).
 */
import { isAbsolute, join } from 'node:path';
import {
    CORE_LOCK_PATH,
    CORE_LOCK_SCHEMA,
    parseCoreVersions,
    readCoreLock,
    resolveDataDir,
    verifyInstalledTree,
    type TCoreLock,
    type TCoreVersions,
    type TInstallResult,
    type TTreeReadFs,
} from './core-install.ts';
import {
    COMPAT_LAYERS,
    inspectStateAt,
    LAUNCHER_VERSION_ENV,
    observeConfig,
    observeLauncher,
    observeState,
    type TObservation,
} from './compat.ts';
import {
    consumerLayerProblems,
    describeVersions,
    updateBranchName,
    updateCompatProblems,
    updatePrText,
} from './core-update.ts';
import { ACTIVATION_RESTART_EXIT, parseActivationJournal } from './core-activation.ts';
import {
    irreversibleStateProblem,
    rollbackBranchName,
    rollbackPrText,
    rollbackTarget,
} from './core-rollback.ts';
import { runtimePathsIn } from './runtime-paths.ts';

export const LAUNCHER_COMMANDS = [
    'install',
    'update',
    'rollback',
    'doctor',
    'start',
    'stop',
    'version',
] as const;
export type TLauncherCommand = (typeof LAUNCHER_COMMANDS)[number];

export type TLauncherArgs = {
    command: TLauncherCommand;
    consumerRoot: string;
    source: string | null;
    rev: string | null;
    profile: string | null;
    /** Флаги, которые уходят `ralph.js` как есть (`start`, `doctor`). */
    passthrough: string[];
};

export type TParsedArgs = { ok: true; args: TLauncherArgs } | { ok: false; reason: string };

const USAGE =
    'Команды: install [--rev <ревизия>], update <ревизия>, rollback [--profile <имя>], doctor, start [флаги ralph.js], stop [--profile <имя>], version.';

/**
 * Разбор командной строки launcher. Свои флаги (`--consumer`, `--source`, `--rev`) launcher
 * забирает, остальное у `start`/`doctor` уходит ядру — у того свой allowlist флагов. У
 * остальных команд незнакомый флаг — отказ: опечатка в `install` не должна превращаться в
 * установку не той ревизии.
 */
export function parseLauncherArgv(argv: readonly string[]): TParsedArgs {
    let command: string | null = null;
    let consumerRoot: string | null = null;
    let source: string | null = null;
    let rev: string | null = null;
    let profile: string | null = null;
    const rest: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = (): string | null => {
            const v = argv[i + 1];
            i++;
            return v === undefined || v.startsWith('--') ? null : v;
        };
        if (a === '--consumer' || a === '--source' || a === '--rev') {
            const v = value();
            if (v === null) return { ok: false, reason: `${a} без значения. ${USAGE}` };
            // `--consumer` ставит шим перед аргументами человека, а разбор берёт последнее
            // значение: второй `--consumer` молча увёл бы команду в чужое дерево.
            if (a === '--consumer' && consumerRoot !== null) {
                return {
                    ok: false,
                    reason: '--consumer повторён: флаг ставит ./ralph своим каталогом, руками его не задают.',
                };
            }
            if (a === '--consumer') consumerRoot = v;
            else if (a === '--source') source = v;
            else rev = v;
        } else if (command === null && !a.startsWith('-')) {
            command = a;
        } else {
            rest.push(a);
        }
    }
    if (command === null) return { ok: false, reason: `Команда не названа. ${USAGE}` };
    if (!(LAUNCHER_COMMANDS as readonly string[]).includes(command)) {
        return { ok: false, reason: `Неизвестная команда "${command}". ${USAGE}` };
    }
    if (consumerRoot === null || !isAbsolute(consumerRoot)) {
        return {
            ok: false,
            reason: '--consumer <абсолютный путь> не задан: launcher зовут через ./ralph, он передаёт свой каталог.',
        };
    }
    const cmd = command as TLauncherCommand;
    if ((source !== null || rev !== null) && cmd !== 'install' && cmd !== 'update') {
        return { ok: false, reason: `--source и --rev — флаги install и update, а не ${cmd}.` };
    }
    if (cmd === 'update') {
        // Ревизия — позиционным аргументом (`./ralph update <ref>`) или `--rev`, но одна:
        // две разные молча выбрали бы одну из них.
        const positional = rest.filter((a) => !a.startsWith('-'));
        const flag = rest.find((a) => a.startsWith('-'));
        if (flag !== undefined) {
            return { ok: false, reason: `update не знает флага "${flag}". ${USAGE}` };
        }
        if (positional.length + (rev === null ? 0 : 1) !== 1) {
            return {
                ok: false,
                reason: `update ждёт ровно одну ревизию: ./ralph update <ревизия>. ${USAGE}`,
            };
        }
        rev = rev ?? positional[0];
        rest.length = 0;
    }
    if (cmd === 'stop' || cmd === 'rollback') {
        // Профиль у обеих — адрес каталога состояния: у stop там лок, у rollback — журнал
        // активации и state, по которым решается, куда и можно ли откатиться.
        for (let i = 0; i < rest.length; i++) {
            if (rest[i] === '--profile') {
                // Значение с `--` — следующий флаг, а не имя профиля: принятое как имя, оно
                // увело бы запрос в каталог состояния несуществующего профиля.
                const v = rest[i + 1];
                if (v === undefined || v.startsWith('--')) {
                    return { ok: false, reason: `--profile без значения. ${USAGE}` };
                }
                profile = v;
                i++;
                continue;
            }
            return { ok: false, reason: `${cmd} не знает флага "${rest[i]}". ${USAGE}` };
        }
        rest.length = 0;
    }
    if ((cmd === 'install' || cmd === 'version') && rest.length > 0) {
        return { ok: false, reason: `${cmd} не знает флага "${rest[0]}". ${USAGE}` };
    }
    return {
        ok: true,
        args: { command: cmd, consumerRoot, source, rev, profile, passthrough: rest },
    };
}

export type TLauncherDeps = {
    env: Record<string, string | undefined>;
    out: (line: string) => void;
    /** Чтение lock и прочих файлов потребителя. */
    readFn: (p: string) => string;
    exists: (p: string) => boolean;
    fsr?: TTreeReadFs;
    /** Установка ревизии (`installRevision` с экспортом из источника). */
    installFn: (p: {
        sha: string;
        dataDir: string;
        source: string | null;
        expectedTreeHash?: string;
    }) => TInstallResult;
    writeLockFn: (consumerRoot: string, lock: TCoreLock) => string;
    /** Ревизия источника → полный SHA. Неоднозначная или отсутствующая — бросает. */
    resolveRevFn: (source: string, rev: string) => string;
    /** Версии слоёв, на которых говорит установленная ревизия, — её собственным кодом. */
    versionsOfFn: (dir: string) => unknown;
    /** `node <dir>/ralph.js <args>` с cwd потребителя; код выхода. */
    runCoreFn: (dir: string, args: string[], consumerRoot: string) => number;
    /** Часы, мс: сколько проработало ядро до рестарта в ту же ревизию. */
    nowFn: () => number;
    /** `runtimeDir` экземпляра по конфигу потребителя и профилю. */
    runtimeDirOfFn: (consumerRoot: string, profile: string | null) => string;
    /**
     * Ревизия живого раннера с этим pid — по элементу argv `<dataDir>/<SHA>/ralph.js`;
     * `null` — такого раннера нет: `runnerRevision` в `core-install.ts`. Номер мёртвого
     * владельца мог достаться постороннему процессу, и подстрока `ralph.js` его не отличила бы.
     */
    ralphRevisionFn: (pid: number, dataDir: string) => string | null;
    writeStopFn: (p: string) => void;
    /** Сырой `ralph.config.json` потребителя — для сверки `configVersion` в update. */
    rawConfigFn: (consumerRoot: string) => unknown;
    /**
     * Коммит с новым lock поверх свежего `main` и пуш в новую ветку без касания дерева,
     * индекса и HEAD человека (`commitLockOnBranch`). SHA коммита; отказ — бросок.
     */
    pushLockBranchFn: (p: {
        consumerRoot: string;
        branch: string;
        lock: TCoreLock;
        message: string;
    }) => string;
    /**
     * PR ветки в `main` швом форжа потребителя; номер или null, если форж его не назвал.
     * Шов — из `adapters` того профиля, что назван командой (`--profile`), иначе по умолчанию.
     */
    openPrFn: TOpenLockPrFn;
    /**
     * Номер открытого PR ветки или null (`findOpenPullRequest` шва). Повтор update/rollback
     * после обрыва находит PR прежней попытки и второй не заводит (#104). Сбой — бросок.
     */
    findOpenPrFn: TFindLockPrFn;
};

// Именованные алиасы, а не инлайновые типы: `=>` инлайнового типа скан дефолтов форжа
// (`tests/seam-defaults.test.ts`) читает как `=` дефолта.
export type TOpenLockPrFn = (
    consumerRoot: string,
    pr: { branch: string; title: string; body: string },
    profile: string | null,
) => number | null;
export type TFindLockPrFn = (
    consumerRoot: string,
    branch: string,
    profile: string | null,
) => number | null;

export type TCheckStatus = 'ok' | 'fail' | 'skip';
export type TCheck = { name: string; status: TCheckStatus; detail: string };

const MARK: Record<TCheckStatus, string> = { ok: '✅', fail: '❌', skip: '⏭' };

export function formatCheck(c: TCheck): string {
    return `${MARK[c.status]} ${c.name}: ${c.detail}`;
}

type TInstallation = {
    checks: TCheck[];
    lock: TCoreLock | null;
    dir: string | null;
    treeOk: boolean;
};

/**
 * Проверки установки, общие для doctor и start: lock, каталог ревизии, дерево, версия
 * launcher, версии ревизии. Не останавливаются на первом провале — каждая следующая либо
 * проверяется, либо названа пропущенной с причиной.
 */
export function inspectInstallation(consumerRoot: string, deps: TLauncherDeps): TInstallation {
    const checks: TCheck[] = [];
    const skip = (name: string, why: string) => checks.push({ name, status: 'skip', detail: why });
    const r = readCoreLock(consumerRoot, deps.readFn);
    let lock: TCoreLock | null = null;
    if (r.ok) {
        lock = r.lock;
        checks.push({
            name: 'lock',
            status: 'ok',
            detail: `${r.path}: ревизия ${r.lock.sha}`,
        });
    } else {
        checks.push({ name: 'lock', status: 'fail', detail: r.reason });
    }

    let dir: string | null = null;
    if (lock === null) {
        skip('установка', 'нет lock — неизвестно, какую ревизию искать');
    } else {
        let dataDir: string | null = null;
        try {
            dataDir = resolveDataDir(deps.env);
        } catch (e) {
            checks.push({ name: 'установка', status: 'fail', detail: (e as Error).message });
        }
        if (dataDir !== null) {
            const candidate = join(dataDir, lock.sha);
            if (deps.exists(candidate)) {
                dir = candidate;
                checks.push({ name: 'установка', status: 'ok', detail: candidate });
            } else {
                checks.push({
                    name: 'установка',
                    status: 'fail',
                    detail: `${candidate} нет — поставь ревизию: ./ralph install`,
                });
            }
        }
    }

    let treeOk = false;
    if (lock === null || dir === null) {
        skip('дерево', 'нет установленной ревизии — сверять нечего');
    } else {
        const v = verifyInstalledTree(dir, lock, deps.fsr);
        treeOk = v.ok;
        checks.push(
            v.ok
                ? { name: 'дерево', status: 'ok', detail: `совпало с lock (${lock.treeHash})` }
                : { name: 'дерево', status: 'fail', detail: v.reason },
        );
    }

    const launcher = observeLauncher(deps.env);
    if (lock === null) {
        skip('launcher', 'нет lock — неизвестно, какую версию launcher ждёт ревизия');
    } else if (launcher.kind === 'version') {
        const want = lock.versions.launcher;
        checks.push(
            launcher.version === want
                ? { name: 'launcher', status: 'ok', detail: `v${String(want)}` }
                : {
                      name: 'launcher',
                      status: 'fail',
                      detail: `ревизия ждёт launcher v${String(want)}, найден v${String(launcher.version)} — обнови ./ralph из ревизии ${lock.sha}`,
                  },
        );
    } else {
        checks.push({
            name: 'launcher',
            status: 'fail',
            detail:
                launcher.kind === 'invalid'
                    ? launcher.reason
                    : `${LAUNCHER_VERSION_ENV} не задан — зови через ./ralph, а не launcher.mts напрямую`,
        });
    }

    if (lock === null || dir === null || !treeOk) {
        skip('версии ревизии', 'дерево не сверено с lock — его код не исполняется');
    } else {
        try {
            const parsed = parseCoreVersions(deps.versionsOfFn(dir));
            if (!parsed.ok) throw new Error(`ответ не по контракту (${parsed.reason})`);
            const v = parsed.versions;
            const diff = COMPAT_LAYERS.filter((l) => v[l] !== lock.versions[l]);
            checks.push(
                diff.length === 0
                    ? { name: 'версии ревизии', status: 'ok', detail: describeVersions(v) }
                    : {
                          name: 'версии ревизии',
                          status: 'fail',
                          detail: `lock называет ${describeVersions(lock.versions)}, ревизия говорит ${describeVersions(v)}`,
                      },
            );
        } catch (e) {
            checks.push({
                name: 'версии ревизии',
                status: 'fail',
                detail: `ревизия не назвала свои версии: ${(e as Error).message}`,
            });
        }
    }
    return { checks, lock, dir, treeOk };
}

const allOk = (checks: readonly TCheck[]) => checks.every((c) => c.status === 'ok');

/**
 * doctor: проверки установки и `--doctor` самого ядра (совместимость пяти слоёв с конфигом
 * и state). Код 0 — только если прошли все; пропущенная проверка — не «прошла».
 */
export function runDoctorCommand(args: TLauncherArgs, deps: TLauncherDeps): number {
    const inst = inspectInstallation(args.consumerRoot, deps);
    const checks = [...inst.checks];
    if (inst.dir === null || !inst.treeOk) {
        checks.push({
            name: 'ядро',
            status: 'skip',
            detail: 'дерево не сверено с lock — его --doctor не исполняется',
        });
    } else {
        const code = deps.runCoreFn(inst.dir, ['--doctor', ...args.passthrough], args.consumerRoot);
        checks.push(
            code === 0
                ? { name: 'ядро', status: 'ok', detail: 'ralph.js --doctor: старт разрешён' }
                : {
                      name: 'ядро',
                      status: 'fail',
                      detail: `ralph.js --doctor вышел с кодом ${String(code)} — причина в его отчёте выше`,
                  },
        );
    }
    for (const c of checks) deps.out(formatCheck(c));
    const failed = checks.filter((c) => c.status !== 'ok');
    if (failed.length === 0) {
        deps.out('🩺 doctor: все проверки прошли');
        return 0;
    }
    deps.out(
        `🩺 doctor: не прошли ${String(failed.length)} из ${String(checks.length)} — ${failed.map((c) => c.name).join(', ')}`,
    );
    return 1;
}

/**
 * Сколько ядро должно проработать, чтобы его рестарт в ту же ревизию считался новым
 * транзиентом, а не продолжением серии. Сверки старта (два хэша дерева, контракт, проба
 * барьера) укладываются в минуты; итерация с сессией — дольше.
 */
export const SAME_RESTART_WORK_MS = 10 * 60_000;

/**
 * Старт и активация (#38). Ядро, увидевшее на границе итерации lock новее себя, выходит
 * кодом `ACTIVATION_RESTART_EXIT` — и только им: стоп по существу перезапуском не лечится.
 * На этот код start проходит ВСЮ проверку установки заново, по lock, который лежит сейчас,
 * и запускает ревизию из него. Новой ревизии нет или она не сверилась — отказ с причиной,
 * а не запуск прежней: прежняя уже не та, что называет lock.
 *
 * Перезапуск делает процесс launcher прежней ревизии: код новой в него не грузится, она
 * стартует отдельным процессом, как и при обычном start.
 *
 * Рестарт в ту же ревизию допустим один раз подряд (ревью Фазы 13): lock, не прочитавшийся
 * ядром посреди `git pull`, — транзиент. Второй подряд — отказ: ядро сверяет lock по
 * `roots.consumerRoot` конфига, launcher — по своему `--consumer`, и при их расхождении
 * без предела выходила тугая петля перезапусков с двумя сверками дерева на круг.
 *
 * «Подряд» — без работы между ними: ядро, проработавшее дольше `SAME_RESTART_WORK_MS`,
 * счёт обнуляет. Иначе «второй подряд» значил «второй за жизнь процесса launcher», и два
 * транзиента, разнесённых сутками, ночью останавливали петлю (ревью Фазы 13, проход 2).
 * Тугую петлю от транзиента отличает именно это: ядро выходит на рестарт сразу, на
 * сверках старта, не дойдя до итерации. Мерило — часы, а не отчёт ядра об итерациях:
 * канала из ядра в launcher, кроме кода выхода, нет.
 */
export function runStartCommand(args: TLauncherArgs, deps: TLauncherDeps): number {
    let previous: string | null = null;
    let sameRestarts = 0;
    for (;;) {
        const inst = inspectInstallation(args.consumerRoot, deps);
        if (!allOk(inst.checks) || inst.dir === null || inst.lock === null) {
            for (const c of inst.checks) if (c.status !== 'ok') deps.out(formatCheck(c));
            deps.out(
                previous === null
                    ? '⛔ start отменён: установка не прошла проверку — подробности: ./ralph doctor'
                    : `⛔ рестарт после ${previous} отменён: установка по lock не прошла проверку (провалы выше) — подробности: ./ralph doctor`,
            );
            return 1;
        }
        if (previous !== null && inst.lock.sha === previous) {
            sameRestarts += 1;
            if (sameRestarts > 1) {
                deps.out(
                    `⛔ рестарт отменён: ядро ${previous} второй раз подряд вышло на рестарт, а lock ` +
                        `в ${args.consumerRoot} называет ту же ревизию — ядро видит расхождение, ` +
                        'lock его не показывает. Сверь roots.consumerRoot конфига с каталогом ' +
                        'запуска: ./ralph doctor',
                );
                return 1;
            }
        } else {
            sameRestarts = 0;
        }
        deps.out(
            previous === null
                ? `▶ Ralph ${inst.lock.sha} из ${inst.dir}`
                : `🔁 Рестарт: ${previous} → ${inst.lock.sha} из ${inst.dir}`,
        );
        // Дерево здесь уже сверено (`inspectInstallation`), и `main()` ядра сверит его ещё раз —
        // хэшем всего дерева второй раз подряд. Это намеренно, не оптимизируй: launcher
        // отвечает за то, ЧТО запускать, ядро — за то, что запущено именно оно, и сверка ядра
        // обязана стоять и при прямом `node <dir>/ralph.js` мимо launcher.
        const startedAt = deps.nowFn();
        const code = deps.runCoreFn(inst.dir, args.passthrough, args.consumerRoot);
        if (code !== ACTIVATION_RESTART_EXIT) return code;
        if (deps.nowFn() - startedAt > SAME_RESTART_WORK_MS) sameRestarts = 0;
        previous = inst.lock.sha;
    }
}

export function runInstallCommand(args: TLauncherArgs, deps: TLauncherDeps): number {
    const lockPath = join(args.consumerRoot, CORE_LOCK_PATH);
    let dataDir: string;
    try {
        dataDir = resolveDataDir(deps.env);
    } catch (e) {
        deps.out(`⛔ install: ${(e as Error).message}`);
        return 1;
    }
    try {
        if (!deps.exists(lockPath)) {
            if (args.source === null || args.rev === null) {
                deps.out(
                    `⛔ install: ${lockPath} нет, а ревизия не названа. Первая установка — ` +
                        'RALPH_SOURCE=<клон канона> ./ralph install --rev <ревизия>: ' +
                        '«последней» ревизии launcher не выбирает.',
                );
                return 1;
            }
            const sha = deps.resolveRevFn(args.source, args.rev);
            const res = deps.installFn({ sha, dataDir, source: args.source });
            if (res.status === 'present') {
                // Каталог уже лежал, а lock ещё нет: сверить его не с чем, кроме собственного
                // манифеста. Без этой сверки правленое дерево исполнило бы свой код
                // (`versionsOfFn`) и закрепилось бы в lock эталоном. Правку дерева ВМЕСТЕ с
                // манифестом так не поймать — это предел первой установки, а не сверки.
                const v = verifyInstalledTree(res.dir, { treeHash: res.treeHash }, deps.fsr);
                if (!v.ok) {
                    deps.out(
                        `⛔ install: ревизия ${sha} уже лежала в ${res.dir}, но ${v.reason}. ` +
                            'В lock она не идёт — убери каталог и поставь заново.',
                    );
                    return 1;
                }
            }
            const vr = parseCoreVersions(deps.versionsOfFn(res.dir));
            if (!vr.ok) {
                deps.out(
                    `⛔ install: ревизия ${sha} назвала версии слоёв не по контракту (${vr.reason}). ` +
                        'Lock не пишется: битый lock следующий install не перезаписал бы.',
                );
                return 1;
            }
            const versions = vr.versions;
            const written = deps.writeLockFn(args.consumerRoot, {
                schema: CORE_LOCK_SCHEMA,
                sha,
                treeHash: res.treeHash,
                versions,
            });
            deps.out(`📦 Ревизия ${sha} ${statusWord(res)} в ${res.dir}; lock записан: ${written}`);
        } else {
            const r = readCoreLock(args.consumerRoot, deps.readFn);
            if (!r.ok) {
                deps.out(
                    `⛔ install: ${r.reason}. Битый lock не перезаписывается — почини его или верни из истории.`,
                );
                return 1;
            }
            if (args.rev !== null) {
                if (args.source === null) {
                    deps.out(
                        '⛔ install: --rev без источника (RALPH_SOURCE) — сверить его с lock нечем.',
                    );
                    return 1;
                }
                const sha = deps.resolveRevFn(args.source, args.rev);
                if (sha !== r.lock.sha) {
                    deps.out(
                        `⛔ install: --rev ${args.rev} — это ${sha}, а ${r.path} называет ${r.lock.sha}. ` +
                            'Смена ревизии — update, а не install.',
                    );
                    return 1;
                }
            }
            const res = deps.installFn({
                sha: r.lock.sha,
                dataDir,
                source: args.source,
                expectedTreeHash: r.lock.treeHash,
            });
            deps.out(`📦 Ревизия ${r.lock.sha} ${statusWord(res)} в ${res.dir}`);
        }
    } catch (e) {
        deps.out(`⛔ install: ${(e as Error).message}`);
        return 1;
    }
    // Контракт совместимости — тем же doctor, что зовёт человек: «поставлено» без проверки
    // значило бы «поставлено что-то», и узналось бы это на первом старте.
    return runDoctorCommand({ ...args, passthrough: [] }, deps);
}

/**
 * update (#102): новая ревизия ставится рядом с исполняемой, сверяется на совместимость с
 * тем, что встретит у потребителя, и уходит PR с правкой lock. Работающую петлю команда не
 * останавливает и её ревизии не касается: каталог исполняемой ревизии — другое имя, а lock в
 * дереве человека не пишется вовсе — только в ветке PR. Любой отказ до PR — с причиной, и PR
 * не заводится: ревизия, которая не встала бы после мерджа, человеку на одобрение не идёт.
 */
export function runUpdateCommand(args: TLauncherArgs, deps: TLauncherDeps): number {
    const refuse = (why: string) => {
        deps.out(`⛔ update: ${why} PR не заведён.`);
        return 1;
    };
    // Источник — флагом или `RALPH_SOURCE`: шим передаёт `--source` только install, а
    // окружение человека видит и launcher.
    const source = args.source ?? (deps.env.RALPH_SOURCE || null);
    if (source === null) {
        return refuse('источник не задан — RALPH_SOURCE=<клон канона> ./ralph update <ревизия>.');
    }
    if (args.rev === null) return refuse('ревизия не названа.');
    const cur = readCoreLock(args.consumerRoot, deps.readFn);
    if (!cur.ok) {
        return refuse(`${cur.reason} — обновлять нечего, сначала почини lock (./ralph doctor).`);
    }
    let dataDir: string;
    let sha: string;
    try {
        dataDir = resolveDataDir(deps.env);
        sha = deps.resolveRevFn(source, args.rev);
    } catch (e) {
        return refuse(`${(e as Error).message}.`);
    }
    if (sha === cur.lock.sha) {
        deps.out(`✅ update: ${cur.path} уже называет ${sha} — менять нечего.`);
        return 0;
    }

    const inst = installedVersions('update', `ревизия ${sha}`, { sha, dataDir, source }, deps);
    if (!inst.ok) return refuse(inst.why);
    const { res, versions } = inst;
    const { config, pinned } = observeConsumerConfig(args.consumerRoot, dataDir, cur.lock, deps);
    const problems = updateCompatProblems({
        next: versions,
        current: cur.lock,
        launcher: observeLauncher(deps.env),
        config,
    });
    if (problems.length > 0) {
        for (const p of problems) deps.out(`❌ ${p}`);
        return refuse(
            `ревизия ${sha} несовместима с этим потребителем (${String(problems.length)}).`,
        );
    }

    const next: TCoreLock = {
        schema: CORE_LOCK_SCHEMA,
        sha,
        treeHash: res.treeHash,
        versions,
    };
    const branch = updateBranchName(sha);
    const pub = publishLockChange('update', args, branch, next, updatePrText(cur.lock, next), deps);
    if (!pub.ok) return pub.refused ? refuse(pub.why) : 1;
    deps.out(
        `📦 Ревизия ${sha} ${statusWord(res)} в ${res.dir} рядом с исполняемой ${cur.lock.sha}.`,
    );
    deps.out(
        `${pub.line} Петля работает на прежней ревизии; после мерджа она выйдет на рестарт на границе итерации.`,
    );
    warnPinned(pinned, join(dataDir, cur.lock.sha), res.dir, deps);
    return 0;
}

/**
 * Установка ревизии смены (update, rollback) и её версии слоёв. Каталог мог уже лежать
 * (прошлая попытка, оборванная после установки, или прежняя ревизия): его код исполняется
 * здесь же (`versionsOfFn`), поэтому сначала — сверка с собственным манифестом, как у install.
 */
function installedVersions(
    cmd: 'update' | 'rollback',
    what: string,
    req: { sha: string; dataDir: string; source: string | null },
    deps: TLauncherDeps,
): { ok: true; res: TInstallResult; versions: TCoreVersions } | { ok: false; why: string } {
    let res: TInstallResult;
    try {
        res = deps.installFn(req);
    } catch (e) {
        return { ok: false, why: `${what} не установлена — ${(e as Error).message}.` };
    }
    const tree = verifyInstalledTree(res.dir, { treeHash: res.treeHash }, deps.fsr);
    if (!tree.ok) {
        return {
            ok: false,
            why: `${what} в ${res.dir} не цела: ${tree.reason}. Убери каталог и повтори ${cmd}.`,
        };
    }
    try {
        const vr = parseCoreVersions(deps.versionsOfFn(res.dir));
        if (!vr.ok) throw new Error(`ответ не по контракту (${vr.reason})`);
        return { ok: true, res, versions: vr.versions };
    } catch (e) {
        return { ok: false, why: `${what} не назвала свои версии: ${(e as Error).message}.` };
    }
}

/**
 * Вторая копия SHA — `roots.productRoot` конфига: lock в PR её не меняет, и рестарт после
 * мерджа отказал бы расхождением (`productRootMismatch`). Молчать здесь значило бы узнать об
 * этом от вставшей ночью петли. Конфиг смена ревизии не трогает (#134): ключ необязателен,
 * без него путь выводится из lock, — это и советует предупреждение.
 */
function warnPinned(pinned: readonly string[], locked: string, next: string, deps: TLauncherDeps) {
    for (const key of pinned) {
        deps.out(
            `⚠ ${key} конфига указывает на ревизию из lock ${locked}: ` +
                `вместе с мерджем PR убери ключ (launcher выводит его из lock) или поправь его на ${next}, иначе рестарт откажет расхождением.`,
        );
    }
}

/**
 * `configVersion` конфига потребителя и ключи `roots.productRoot`, указывающие на ревизию из
 * lock: обе смены ревизии (update, rollback) сверяют одно и то же и предупреждают одинаково.
 */
function observeConsumerConfig(
    consumerRoot: string,
    dataDir: string,
    current: TCoreLock,
    deps: TLauncherDeps,
): { config: TObservation; pinned: string[] } {
    try {
        const raw = deps.rawConfigFn(consumerRoot);
        const pinned = pinnedProductRoots(raw, join(dataDir, current.sha));
        const config: TObservation =
            raw !== null && typeof raw === 'object' && !Array.isArray(raw)
                ? observeConfig(raw as Record<string, unknown>)
                : { kind: 'invalid', reason: 'конфиг не объект' };
        return { config, pinned };
    } catch (e) {
        return {
            config: { kind: 'invalid', reason: `конфиг не прочитан: ${(e as Error).message}` },
            pinned: [],
        };
    }
}

/**
 * rollback (#103): lock возвращается на предыдущую ревизию из журнала активации тем же путём,
 * что update, — веткой и PR, без правки дерева человека и без остановки петли. Решения
 * (цель, необратимость миграции state) — в `core-rollback.ts`; здесь порядок, и он
 * содержателен: всё, что может отвергнуть откат, стоит ДО пуша ветки с правкой lock, а код
 * прежней ревизии исполняется только после сверки её дерева с манифестом. State откат не
 * переписывает вовсе: его схему он только читает.
 */
export function runRollbackCommand(args: TLauncherArgs, deps: TLauncherDeps): number {
    const refuse = (why: string) => {
        deps.out(`⛔ rollback: ${why} Lock не тронут, PR не заведён.`);
        return 1;
    };
    const cur = readCoreLock(args.consumerRoot, deps.readFn);
    if (!cur.ok) {
        return refuse(`${cur.reason} — откатывать нечего, сначала почини lock (./ralph doctor).`);
    }
    let paths: ReturnType<typeof runtimePathsIn>;
    let dataDir: string;
    try {
        paths = runtimePathsIn(deps.runtimeDirOfFn(args.consumerRoot, args.profile));
        dataDir = resolveDataDir(deps.env);
    } catch (e) {
        return refuse(`${(e as Error).message}.`);
    }
    let journalText: string | null;
    try {
        journalText = deps.readFn(paths.activations);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            return refuse(
                `журнал активации ${paths.activations} не читается — ${(e as Error).message}.`,
            );
        }
        journalText = null;
    }
    let target: ReturnType<typeof rollbackTarget>;
    try {
        target = rollbackTarget(
            journalText === null ? [] : parseActivationJournal(journalText),
            cur.lock.sha,
        );
    } catch (e) {
        return refuse(`${(e as Error).message} — без журнала цель отката неизвестна.`);
    }
    if (!target.ok) return refuse(`${target.reason}.`);
    const sha = target.sha;

    // Прежняя ревизия обычно лежит (чистка её не трогает); нет — ставится из источника.
    const source = deps.env.RALPH_SOURCE || null;
    const inst = installedVersions(
        'rollback',
        `прежняя ревизия ${sha}`,
        { sha, dataDir, source },
        deps,
    );
    if (!inst.ok) return refuse(inst.why);
    const { res, versions } = inst;
    const { config, pinned } = observeConsumerConfig(args.consumerRoot, dataDir, cur.lock, deps);
    const problems = consumerLayerProblems(versions, observeLauncher(deps.env), config);
    const migration = irreversibleStateProblem({
        target: versions,
        current: cur.lock,
        state: observeState(inspectStateAt(paths.state, deps.readFn)),
    });
    if (migration !== null) problems.push(migration);
    if (problems.length > 0) {
        for (const p of problems) deps.out(`❌ ${p}`);
        return refuse(`откат на ${sha} отвергнут (${String(problems.length)}).`);
    }

    const prev: TCoreLock = { schema: CORE_LOCK_SCHEMA, sha, treeHash: res.treeHash, versions };
    const branch = rollbackBranchName(sha);
    const pub = publishLockChange(
        'rollback',
        args,
        branch,
        prev,
        rollbackPrText(cur.lock, prev),
        deps,
    );
    if (!pub.ok) return pub.refused ? refuse(pub.why) : 1;
    deps.out(`⏪ Откат ${cur.lock.sha} → ${sha}: прежняя ревизия ${statusWord(res)} в ${res.dir}.`);
    deps.out(
        `${pub.line} Петля работает на ревизии прежнего lock; после мерджа она выйдет на рестарт на границе итерации.`,
    );
    warnPinned(pinned, join(dataDir, cur.lock.sha), res.dir, deps);
    return 0;
}

type TPublished = { ok: true; line: string } | { ok: false; refused: boolean; why: string };

/**
 * Последние шаги смены ревизии — ветка с lock и PR — общие для update и rollback. Повтор
 * после обрыва (#104) их доводит: ветка прежней попытки с тем же lock берётся как есть
 * (`commitLockOnBranch`), открытый PR ветки — тоже, второй не заводится. Отказ пуша — это
 * отказ всей команды (`refused`: PR не заведён и lock не тронут); отказ после пуша уже
 * назван строкой здесь, с именем ветки — повтор команды найдёт её и доведёт PR.
 */
function publishLockChange(
    cmd: 'update' | 'rollback',
    { consumerRoot, profile }: TLauncherArgs,
    branch: string,
    lock: TCoreLock,
    text: { title: string; body: string; message: string },
    deps: TLauncherDeps,
): TPublished {
    let commit: string;
    try {
        commit = deps.pushLockBranchFn({ consumerRoot, branch, lock, message: text.message });
    } catch (e) {
        return {
            ok: false,
            refused: true,
            why: `ветка ${branch} с правкой lock не запушена — ${(e as Error).message}.`,
        };
    }
    let pr: number | null;
    let existing = false;
    try {
        try {
            pr = deps.findOpenPrFn(consumerRoot, branch, profile);
        } catch (e) {
            // «Не прочитал» не значит «PR нет»: второй PR на ту же ветку — дубль у человека.
            throw new Error(`PR ветки не прочитан: ${(e as Error).message}`);
        }
        existing = pr !== null;
        if (!existing)
            pr = deps.openPrFn(
                consumerRoot,
                { branch, title: text.title, body: text.body },
                profile,
            );
    } catch (e) {
        deps.out(
            `⛔ ${cmd}: ветка ${branch} (${commit}) запушена, но PR не заведён — ` +
                `${(e as Error).message}. Повтори ${cmd} или заведи PR из неё в main руками.`,
        );
        return { ok: false, refused: false, why: '' };
    }
    const num = pr === null ? '' : ` #${String(pr)}`;
    return {
        ok: true,
        line: `🔀 PR${num} из ${branch} (${commit})${existing ? ' уже открыт' : ''}: правка ${CORE_LOCK_PATH}.`,
    };
}

/**
 * Где сырой конфиг называет каталог ревизии `roots.productRoot` — в `common` и профилях.
 * Сравнение по строке: конфиг пишет путь как есть, а канонизация потребовала бы диска.
 */
export function pinnedProductRoots(raw: unknown, revisionDir: string): string[] {
    const obj = (v: unknown): Record<string, unknown> | null =>
        v !== null && typeof v === 'object' && !Array.isArray(v)
            ? (v as Record<string, unknown>)
            : null;
    const root = obj(raw);
    if (root === null) return [];
    const blocks: [string, unknown][] = [['common', root.common]];
    for (const [name, p] of Object.entries(obj(root.profiles) ?? {})) {
        blocks.push([`profiles.${name}`, p]);
    }
    return blocks
        .filter(([, b]) => obj(obj(b)?.roots)?.productRoot === revisionDir)
        .map(([where]) => `${where}.roots.productRoot`);
}

function statusWord(res: TInstallResult): string {
    return res.status === 'installed' ? 'установлена' : 'уже стояла';
}

export function runStopCommand(args: TLauncherArgs, deps: TLauncherDeps): number {
    let runtimeDir: string;
    try {
        runtimeDir = deps.runtimeDirOfFn(args.consumerRoot, args.profile);
    } catch (e) {
        deps.out(`⛔ stop: каталог состояния не определён — ${(e as Error).message}`);
        return 1;
    }
    const paths = runtimePathsIn(runtimeDir);
    if (!deps.exists(paths.lock)) {
        deps.out(
            `⛔ stop: ${paths.lock} нет — петля здесь не идёт. Запрос без живой петли ` +
                'остановил бы следующий старт на первом шаге, поэтому он не кладётся.',
        );
        return 1;
    }
    // Лок на диске — ещё не живая петля: после `kill -9` или OOM он остаётся, и запрос,
    // положенный рядом с брошенным локом, остановил бы следующий старт на первой границе.
    let ownerText: string;
    try {
        ownerText = deps.readFn(paths.lock).trim();
    } catch (e) {
        deps.out(
            `⛔ stop: ${paths.lock} не читается (${(e as Error).message}) — жива ли петля, ` +
                'не проверить, и запрос не кладётся.',
        );
        return 1;
    }
    const owner = /^[1-9]\d*$/.test(ownerText) ? Number(ownerText) : null;
    if (owner === null) {
        deps.out(
            `⛔ stop: в ${paths.lock} не pid (${JSON.stringify(ownerText.slice(0, 40))}) — жива ли ` +
                'петля, не проверить, и запрос не кладётся.',
        );
        return 1;
    }
    // Живая петля — это `ralph.js` ревизии из этого каталога установок. Не обязательно из
    // lock (#136): lock в дереве потребителя под git, и `git pull`, сменивший `sha`, петлю на
    // прежней ревизии не трогает. Её запрос остановки услышит так же — он лежит в каталоге
    // состояния, а не в каталоге ревизии; назвать «брошенной» живую петлю было бы ложью.
    const entry = lockedRevision(args.consumerRoot, deps);
    if (!entry.ok) {
        deps.out(
            `⛔ stop: ${entry.reason} — чей раннер держит лок, не проверить, и запрос не кладётся.`,
        );
        return 1;
    }
    const running = deps.ralphRevisionFn(owner, entry.dataDir);
    if (running === null) {
        deps.out(
            `⛔ stop: лок ${paths.lock} брошен — раннера ${join(entry.dataDir, '<ревизия>', 'ralph.js')} ` +
                `с pid ${String(owner)} нет, петля здесь не идёт. Следующий старт снимет лок сам; ` +
                'запрос не кладётся, иначе он остановил бы этот старт на первом шаге.',
        );
        return 1;
    }
    if (running !== entry.sha) {
        deps.out(
            `ℹ️ Петля с pid ${String(owner)} идёт на ревизии ${running}, а lock называет ${entry.sha} ` +
                '(lock сменили после её старта) — запрос кладётся ей же.',
        );
    }
    const already = () =>
        deps.out(
            `⏸ Запрос остановки уже лежит (${paths.stopRequest}) — петля встанет на границе итерации.`,
        );
    if (deps.exists(paths.stopRequest)) {
        already();
        return 0;
    }
    try {
        deps.writeStopFn(paths.stopRequest);
    } catch (e) {
        // Между проверкой и записью файл мог положить второй `./ralph stop` или сама петля:
        // запись эксклюзивная (`wx`), и EEXIST — тот же исход «уже лежит», а не стек node.
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
            already();
            return 0;
        }
        deps.out(`⛔ stop: запрос ${paths.stopRequest} не положен — ${(e as Error).message}`);
        return 1;
    }
    deps.out(
        `⏸ Запрос остановки положен (${paths.stopRequest}): начатая сессия доводится, ` +
            'петля встанет на границе итерации и сохранит state.',
    );
    return 0;
}

/** Каталог установок и ревизия из lock — с чем сверяется раннер, который держит лок. */
function lockedRevision(
    consumerRoot: string,
    deps: TLauncherDeps,
): { ok: true; dataDir: string; sha: string } | { ok: false; reason: string } {
    const r = readCoreLock(consumerRoot, deps.readFn);
    if (!r.ok) return { ok: false, reason: r.reason };
    try {
        return { ok: true, dataDir: resolveDataDir(deps.env), sha: r.lock.sha };
    } catch (e) {
        return { ok: false, reason: (e as Error).message };
    }
}

/** Версия продукта человеку: ревизия из lock и версии слоёв — без чтения git. */
export function runVersionCommand(args: TLauncherArgs, deps: TLauncherDeps): number {
    const launcher = observeLauncher(deps.env);
    deps.out(
        `launcher (./ralph): ${launcher.kind === 'version' ? `v${String(launcher.version)}` : 'версия не задана'}`,
    );
    const r = readCoreLock(args.consumerRoot, deps.readFn);
    if (!r.ok) {
        deps.out(`ядро: ${r.reason}`);
        return 1;
    }
    deps.out(`Ralph ${r.lock.sha.slice(0, 12)} (ревизия ${r.lock.sha})`);
    deps.out(`версии: ${describeVersions(r.lock.versions)}`);
    return 0;
}

export function runLauncher(argv: readonly string[], deps: TLauncherDeps): number {
    const parsed = parseLauncherArgv(argv);
    if (!parsed.ok) {
        deps.out(`⛔ ${parsed.reason}`);
        return 2;
    }
    const a = parsed.args;
    switch (a.command) {
        case 'install':
            return runInstallCommand(a, deps);
        case 'update':
            return runUpdateCommand(a, deps);
        case 'rollback':
            return runRollbackCommand(a, deps);
        case 'doctor':
            return runDoctorCommand(a, deps);
        case 'start':
            return runStartCommand(a, deps);
        case 'stop':
            return runStopCommand(a, deps);
        case 'version':
            return runVersionCommand(a, deps);
    }
}
