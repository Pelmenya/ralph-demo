/**
 * Подготовка смены ревизии ядра: `./ralph update <ref>` (Фаза 13, #102; часть 2 прежней #36).
 *
 * Протокол обновления выбран по ревью плана: ПОДГОТОВКА идёт без остановки петли, АКТИВАЦИЯ —
 * отдельным шагом, рестартом на подтверждённой границе (#38, `core-activation.ts`). Lock —
 * защищённый файл (Фаза 14): смена ревизии проходит одобрение человека в PR, а не пишется в
 * дерево напрямую. Отсюда три обязательства модуля:
 *
 *   1. **Исполняемую ревизию update не трогает.** Новая ставится РЯДОМ, в свой
 *      `<dataDir>/<sha>/` (`installRevision`): каталог исполняемой ревизии — другое имя, и
 *      перезапись под живым Node подменила бы код у работающей петли — ровно инцидент, из
 *      которого вырос #38.
 *   2. **Несовместимая ревизия отвергается до PR** (`updateCompatProblems`). PR на ревизию,
 *      которая после мерджа не стартует, переложил бы отказ на рестарт ночной петли: lock уже
 *      в `main`, прежняя ревизия больше не та, что он называет, — и петля стоит до утра.
 *      Слои сверяются с тем, что ревизия встретит у потребителя: шим `./ralph`, `configVersion`
 *      конфига и state, который пишет нынешняя ревизия. Ядро и адаптеры едут внутри ревизии и
 *      с собой совпадают по построению — сверять их не с чем.
 *   3. **Lock меняется только в ветке PR** (`commitLockOnBranch`). Коммит собирается
 *      плюмбингом git — объект, дерево во ВРЕМЕННОМ индексе, `commit-tree`, пуш по SHA — без
 *      локальной ветки, без `checkout`, без индекса и рабочего дерева человека. Дерево
 *      потребителя — дерево человека и, при раскладке без worktree, дерево работающей петли;
 *      переключение ветки в нём увело бы файлы из-под живой сессии.
 *
 * Повтор после обрыва доводит подготовку до конца (#104). Ветка с таким именем на `origin`,
 * в которой lock тот же, — это прежняя попытка той же подготовки, убитая после пуша: её коммит
 * и берётся, второго пуша нет. Без этого повтор упирался в собственную ветку, а подготовку
 * доводил человек. Ветка с ДРУГИМ lock — отказ, а не перезапись: `--force` здесь нет, чужую
 * попытку разбирает человек. PR заводит шов форжа (`adapters/`); ветка, запушенная без PR,
 * называется в отказе по имени, а повтор команды найдёт её и заведёт PR.
 *
 * TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).
 */
import { randomBytes } from 'node:crypto';
import { COMPAT_LAYERS, type TCompatVersions, type TObservation } from './compat.ts';
import { CORE_LOCK_PATH, formatCoreLock, type TCoreLock } from './core-install.ts';
import { gitNetworkOpts } from '../shared/ralph-util.ts';

/** Опции одного вызова git: stdin, окружение и срок (у сетевых — `gitNetworkOpts`). */
export type TGitOpts = { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };
/** Исполнитель argv без шелла (форма `shArgv` со stdin): stdout без хвостовых пробелов; отказ — бросок. */
export type TRunArgvFn = (file: string, args: string[], opts?: TGitOpts) => string;

export type TUpdateCompatInput = {
    /** Версии, на которых говорит новая ревизия (её собственный `versions`). */
    next: TCompatVersions;
    /** Lock исполняемой ревизии: какую схему state она пишет. */
    current: TCoreLock;
    /** Шим `./ralph` потребителя (`observeLauncher`). */
    launcher: TObservation;
    /** `configVersion` конфига потребителя (`observeConfig`). */
    config: TObservation;
};

/**
 * Причины, по которым ревизия после мерджа lock не стартовала бы. Пусто — совместима.
 * Список полный: человек чинит все расхождения за один заход, как у doctor.
 */
export function updateCompatProblems(input: TUpdateCompatInput): string[] {
    const problems = consumerLayerProblems(input.next, input.launcher, input.config);
    const { next } = input;
    // State «не новее»: прежние схемы переводит миграция новой ревизии, а схему новее своей
    // она не прочтёт — ровно то, что нынешняя петля могла уже записать.
    if (next.state < input.current.versions.state) {
        problems.push(
            `state: нынешняя ревизия пишет v${String(input.current.versions.state)}, новая читает ` +
                `только до v${String(next.state)} — откат схемы state не поддерживается`,
        );
    }
    return problems;
}

/**
 * Слои, которые ревизия встретит у потребителя как есть: шим `./ralph` и `configVersion`.
 * Общие для update и rollback (`core-rollback.ts`): откат — та же смена ревизии в lock, и
 * шим, которого прежняя ревизия не понимает, после мерджа не стартовал бы её точно так же.
 */
export function consumerLayerProblems(
    next: TCompatVersions,
    launcher: TObservation,
    config: TObservation,
): string[] {
    const problems: string[] = [];
    const exact = (layer: 'launcher' | 'config', obs: TObservation, fix: string) => {
        if (obs.kind === 'version') {
            if (obs.version !== next[layer]) {
                problems.push(
                    `${layer}: ревизия ждёт v${String(next[layer])}, у потребителя v${String(obs.version)} — ${fix}`,
                );
            }
        } else {
            problems.push(
                `${layer}: версия не определена (${obs.kind === 'invalid' ? obs.reason : obs.note})`,
            );
        }
    };
    exact('launcher', launcher, 'сначала обнови шим ./ralph из новой ревизии');
    exact('config', config, 'конфиг сначала переводится на схему новой ревизии');
    return problems;
}

/** Имя ветки PR: по ревизии, чтобы повтор той же подготовки не завёл вторую ветку. */
export function updateBranchName(sha: string): string {
    return `ralph/core-${sha.slice(0, 12)}`;
}

export function describeVersions(v: TCompatVersions): string {
    return COMPAT_LAYERS.map((l) => `${l} v${String(v[l])}`).join(', ');
}

export function updatePrText(
    from: TCoreLock,
    to: TCoreLock,
): { title: string; body: string; message: string } {
    const short = to.sha.slice(0, 12);
    const title = `chore(core): ревизия ядра ${short}`;
    const body = [
        `Смена ревизии ядра в \`${CORE_LOCK_PATH}\`, подготовленная \`./ralph update\`.`,
        '',
        `- было: \`${from.sha}\``,
        `- стало: \`${to.sha}\``,
        `- версии слоёв: ${describeVersions(to.versions)}`,
        '',
        'Новая ревизия уже установлена рядом с исполняемой и прошла сверку совместимости. ' +
            'После мерджа работающая петля назовёт расхождение с lock и выйдет на рестарт на ' +
            'границе итерации; `./ralph start` запустит ревизию из lock.',
    ].join('\n');
    return { title, body, message: `${title}\n\n${body}\n` };
}

export type TCommitLockOpts = {
    runArgvFn: TRunArgvFn;
    /** Дерево потребителя: в его репозиторий ложится коммит. */
    consumerRoot: string;
    /** Окружение git-процессов; временный индекс кладётся в его копию. */
    env: NodeJS.ProcessEnv;
    /** Временный файл индекса — вне репозитория и вне индекса человека. */
    indexFile: string;
    branch: string;
    lock: TCoreLock;
    message: string;
    remote?: string;
    base?: string;
    /** Суффикс служебных ref'ов попытки; по умолчанию — pid и случайный токен. */
    refSuffix?: string;
    /** Жив ли процесс: ref'ы попытки мёртвого снимаются как сироты. */
    pidAliveFn?: (pid: number) => boolean;
};

const ATTEMPT_REF_RE = /^refs\/ralph\/update-(?:base|prior)-(\d+)-/;

/** Жив ли процесс: `EPERM` — жив, но чужой; иначе (`ESRCH`) — мёртв. */
export function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * Ref'ы убитых попыток: свой pid (процесс launcher ведёт одну попытку за раз, значит
 * прежняя с тем же номером уже кончилась) или мёртвый. Живого соседа не трогаем — это и
 * есть параллельная попытка; занятый чужим процессом номер оставляет сироту, и только.
 */
function sweepOrphanRefs(o: TCommitLockOpts, gitFn: (args: string[]) => string): void {
    const alive = o.pidAliveFn ?? pidAlive;
    const refs = gitFn(['for-each-ref', '--format=%(refname)', 'refs/ralph/']);
    for (const ref of refs.split('\n')) {
        const m = ATTEMPT_REF_RE.exec(ref);
        if (m === null) continue;
        const pid = Number(m[1]);
        if (pid !== process.pid && alive(pid)) continue;
        try {
            gitFn(['update-ref', '-d', ref]);
        } catch {
            // Уборка best-effort, как и своя в `finally`.
        }
    }
}

/**
 * Коммит с новым lock поверх свежего `<remote>/<base>` и пуш его в новую ветку. Индекс,
 * HEAD и рабочее дерево человека не трогаются: дерево коммита собирается во временном
 * индексе (`GIT_INDEX_FILE`), локальная ветка не заводится. Возвращает SHA коммита — или
 * коммита прежней попытки, если ветка уже несёт этот же lock (повтор после обрыва).
 */
export function commitLockOnBranch(o: TCommitLockOpts): string {
    const remote = o.remote ?? 'origin';
    const base = o.base ?? 'main';
    const gitFn = (args: string[], opts?: TGitOpts) =>
        o.runArgvFn('git', ['-C', o.consumerRoot, ...args], opts);
    // Свой ref, а не `origin/main`: побочка fetch по имени ветки при нестандартном refspec
    // может его не обновить, и коммит лёг бы на устаревшую базу. Имя — своё у попытки
    // (ревью Фазы 13): с общим update и rollback из двух терминалов перезаписывали базу
    // друг друга, а `finally` первого снимал ref второго посреди его `commit-tree`. Ref
    // убитой попытки снимает следующая (`sweepOrphanRefs`) — по pid в имени.
    sweepOrphanRefs(o, gitFn);
    const suffix = o.refSuffix ?? `${String(process.pid)}-${randomBytes(4).toString('hex')}`;
    const baseRef = `refs/ralph/update-base-${suffix}`;
    const priorRef = `refs/ralph/update-prior-${suffix}`;
    o.runArgvFn(
        'git',
        [
            '-C',
            o.consumerRoot,
            'fetch',
            '--no-recurse-submodules',
            remote,
            `+refs/heads/${base}:${baseRef}`,
        ],
        gitNetworkOpts(o.env),
    );
    try {
        const baseSha = gitFn(['rev-parse', '--verify', `${baseRef}^{commit}`]);
        const blob = gitFn(['hash-object', '-w', '--stdin'], { input: formatCoreLock(o.lock) });
        const prior = priorAttempt(o, remote, priorRef, blob);
        if (prior !== null) return prior;
        const env = { ...o.env, GIT_INDEX_FILE: o.indexFile };
        gitFn(['read-tree', baseSha], { env });
        gitFn(
            ['update-index', '--add', '--cacheinfo', `100644,${blob},${toGitPath(CORE_LOCK_PATH)}`],
            {
                env,
            },
        );
        const tree = gitFn(['write-tree'], { env });
        const commit = gitFn(['commit-tree', tree, '-p', baseSha, '-F', '-'], {
            input: o.message,
        });
        // Без `--force`: ветка с этим именем уже есть — отказ, а не перезапись чужой попытки.
        o.runArgvFn(
            'git',
            ['-C', o.consumerRoot, 'push', remote, `${commit}:refs/heads/${o.branch}`],
            gitNetworkOpts(o.env),
        );
        return commit;
    } finally {
        for (const ref of [baseRef, priorRef]) {
            try {
                gitFn(['update-ref', '-d', ref]);
            } catch {
                // Уборка best-effort: оставшийся ref держит только уже опубликованную историю.
            }
        }
    }
}

/**
 * Ветка уже на `origin` (#104): её коммит, если lock в ней — ровно `blob`, иначе бросок.
 * Нет ветки — `null`. Сравнивается lock, а не дерево: `main` мог уйти вперёд с прошлой
 * попытки, и дерево нового коммита разошлось бы с её деревом при той же правке.
 */
function priorAttempt(
    o: TCommitLockOpts,
    remote: string,
    priorRef: string,
    blob: string,
): string | null {
    const head = `refs/heads/${o.branch}`;
    const listed = o.runArgvFn(
        'git',
        ['-C', o.consumerRoot, 'ls-remote', remote, head],
        gitNetworkOpts(o.env),
    );
    if (listed === '') return null;
    o.runArgvFn(
        'git',
        ['-C', o.consumerRoot, 'fetch', '--no-recurse-submodules', remote, `+${head}:${priorRef}`],
        gitNetworkOpts(o.env),
    );
    const gitFn = (args: string[]) => o.runArgvFn('git', ['-C', o.consumerRoot, ...args]);
    const commit = gitFn(['rev-parse', '--verify', `${priorRef}^{commit}`]);
    let lockBlob: string | null;
    try {
        lockBlob = gitFn(['rev-parse', '--verify', `${priorRef}:${toGitPath(CORE_LOCK_PATH)}`]);
    } catch {
        lockBlob = null;
    }
    if (lockBlob !== blob) {
        throw new Error(
            `ветка ${o.branch} уже есть на ${remote} (${commit}), и в ней другой lock — ` +
                'это не повтор этой подготовки; разбери прежнюю попытку, перезаписи без --force нет',
        );
    }
    return commit;
}

function toGitPath(p: string): string {
    return p.split('\\').join('/');
}
