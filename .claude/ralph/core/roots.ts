/**
 * Четыре корня: где проект, где дерево работы, где продукт и где состояние.
 *
 * Раньше понятия «корень» у ядра не было вовсе — пути собирались от CWD константами вида
 * `.claude/ralph/ralph.state.json`, то есть раннер считал, что продукт, рабочее дерево и
 * состояние лежат в одном месте. Пока ядро было копией внутри проекта, это совпадало с
 * правдой. Под подмодулем — уже нет: продукт read-only и общий для потребителей, дерево
 * работы переключается и чистится, состояние обязано пережить и то и другое.
 *
 * Ошибка в раскладке не даёт красного сразу, и этим она дорога: прогон пишет состояние
 * внутрь продукта, `git status` подмодуля перестаёт быть пустым, а связь с причиной
 * теряется через день — на bump gitlink, который тащит за собой рантайм-мусор.
 *
 *   `consumerRoot`  — дерево ПОТРЕБИТЕЛЯ: его код, его `ralph.config.json`. Дом состояния.
 *   `executionRoot` — дерево, В КОТОРОМ раннер работает: worktree фазы либо сам
 *                     `consumerRoot`. Переключается, чистится, удаляется.
 *   `productRoot`   — каталог ядра (подмодуль или клон канона). Read-only во время работы.
 *   `runtimeDir`    — состояние экземпляра: state, лок, лог, сессии, канал намерений.
 *
 * TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).
 */
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { threadId } from 'node:worker_threads';
import { guardSideEffect } from '../shared/side-effect-guard.ts';

export type TRootsInput = {
    consumerRoot?: string;
    executionRoot?: string;
    productRoot?: string;
    runtimeDir?: string;
};

export type TResolvedRoots = {
    consumerRoot: string;
    executionRoot: string;
    productRoot: string;
    runtimeDir: string;
};

/** Что лежит по пути: каталог, не-каталог или ничего (битая ссылка для `stat` — ничего). */
export type TPathKind = 'dir' | 'other' | 'missing';

type TResolveDeps = {
    realpathFn?: (p: string) => string;
    /** По самой записи, БЕЗ перехода по ссылке: отличает «нет записи» от «битая ссылка». */
    lstatKindFn?: (p: string) => TPathKind;
    /** По цели ссылки: 'missing' здесь при существующей записи и означает битую ссылку. */
    statKindFn?: (p: string) => TPathKind;
};

function kindBy(stat: (p: string) => { isDirectory: () => boolean }): (p: string) => TPathKind {
    return (p: string) => {
        try {
            return stat(p).isDirectory() ? 'dir' : 'other';
        } catch {
            return 'missing';
        }
    };
}

const ROOT_NAMES = ['consumerRoot', 'executionRoot', 'productRoot', 'runtimeDir'] as const;

/**
 * Проверка ФОРМЫ пути до всякого обращения к диску.
 *
 * Относительный путь резолвился бы от CWD — то есть один и тот же конфиг означал бы разные
 * каталоги для раннера, монитора и провижн-скрипта, запущенных из разных мест (ревью !18).
 * Сегмент `..` опаснее тоньше: `path.resolve` схлопывает его ЛЕКСИЧЕСКИ, до разворачивания
 * симлинков, и `link/..` проверяется как родитель ссылки, а физически ведёт к родителю её
 * ЦЕЛИ. Тогда проверка пересечений считает раскладку законной, а запись уходит в продукт.
 * Корни задаются в конфиге один раз — `..` там не нужен вовсе, и запрет дешевле разбора.
 */
function assertPathShape(name: string, raw: string): void {
    if (!isAbsolute(raw)) {
        throw new Error(
            `Корень ${name} задан относительным путём (${raw}). Он резолвился бы от места ` +
                `запуска, и один конфиг означал бы разные каталоги для раннера, монитора и ` +
                `провижна. Задай абсолютный путь.`,
        );
    }
    if (raw.split(/[\\/]/).some((seg) => seg === '..')) {
        throw new Error(
            `Корень ${name} содержит сегмент ".." (${raw}). Такой путь схлопывается ` +
                `лексически — ДО разворачивания симлинков, — и проверка пересечений увидит ` +
                `не тот каталог, в который пойдёт запись. Задай путь без подъёмов.`,
        );
    }
}

/**
 * Абсолютный путь с развёрнутыми симлинками — по САМОМУ ГЛУБОКОМУ существующему предку.
 *
 * Прямой `realpath` здесь не годится: `runtimeDir` создаётся первым прогоном, и требовать
 * его существования значило бы требовать, чтобы раннер стартовал со второго раза. А без
 * разворачивания симлинков проверка пересечений сравнивала бы СТРОКИ и пропускала ровно
 * тот случай, ради которого заведена: worktree и симлинк дают разные пути к одному иноду.
 *
 * Существующий путь обязан быть КАТАЛОГОМ, а битая ссылка — отказ, а не «ещё не создан»:
 * опечатка в корне иначе проходит старт и всплывает позже голым ENOTDIR из середины
 * прогона, где связать её с конфигом уже нечем (ревью !18).
 */
function resolveDeep(name: string, p: string, deps: Required<TResolveDeps>): string {
    let head = p;
    const tail: string[] = [];
    for (;;) {
        if (deps.lstatKindFn(head) === 'missing') {
            const parent = dirname(head);
            // Дошли до корня ФС: разворачивать нечего, отдаём как есть.
            if (parent === head) return p;
            tail.unshift(basename(head));
            head = parent;
            continue;
        }
        const kind = deps.statKindFn(head);
        if (kind === 'missing') {
            throw new Error(
                `Корень ${name}: путь ${head} — битая символическая ссылка. Это не «каталог ` +
                    `ещё не создан», а указание в никуда: первым же прогоном оно даст ENOENT ` +
                    `в середине работы, где о конфиге уже никто не вспомнит.`,
            );
        }
        if (kind !== 'dir') {
            throw new Error(
                `Корень ${name}: путь ${head} существует, но это не каталог. Корень — место, ` +
                    `а не файл; опечатка здесь всплыла бы позже голым ENOTDIR.`,
            );
        }
        return tail.length === 0 ? deps.realpathFn(head) : join(deps.realpathFn(head), ...tail);
    }
}

/**
 * Тот же резолв, но с повторной сверкой: между проверкой существования и `realpath`
 * каталог может появиться (или быть подставлен ссылкой внутрь продукта) — и тогда в
 * результате осталась бы НЕразвёрнутая строка, а пересечение не нашлось бы (ревью !18).
 * Второй проход ловит расхождение; расходится и он — раскладка меняется прямо сейчас,
 * и это повод остановиться, а не гадать.
 */
function resolveStable(name: string, p: string, deps: Required<TResolveDeps>): string {
    const first = resolveDeep(name, p, deps);
    const second = resolveDeep(name, p, deps);
    if (first !== second) {
        throw new Error(
            `Корень ${name} резолвится нестабильно (${first} ≠ ${second}): каталог появился ` +
                `или подменён во время старта. Раскладка меняется под руками — стоп.`,
        );
    }
    return first;
}

/**
 * Лежит ли `child` внутри `parent` (или совпадает с ним).
 *
 * Разделитель в конце обязателен: `/app/state` и `/app/state-old` начинаются одинаково,
 * и наивный `startsWith` объявил бы соседей вложенными — барьер краснел бы на исправной
 * раскладке, а такой барьер отключают.
 */
function contains(parent: string, child: string): boolean {
    return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Резолв и проверка раскладки. Бросает с внятной диагностикой — какой корень не задан или
 * какая пара пересекается; тихого умолчания нет ни у одного.
 *
 * Запрещены НЕ все пересечения, и это решение, а не недосмотр. `productRoot` внутри
 * `consumerRoot` — ровно то, чем является подмодуль, а `runtimeDir` внутри `consumerRoot` —
 * его законный дом. Запрещено то, что ломает работу: состояние внутри продукта (пачкает
 * подмодуль) и состояние внутри ОТДЕЛЬНОГО дерева работы (исчезает вместе с worktree фазы —
 * ровно тогда, когда по нему собирались восстанавливаться).
 */
export function resolveRoots(input: TRootsInput, deps: TResolveDeps = {}): TResolvedRoots {
    const d = {
        realpathFn: deps.realpathFn ?? realpathSync,
        lstatKindFn: deps.lstatKindFn ?? kindBy(lstatSync),
        statKindFn: deps.statKindFn ?? kindBy(statSync),
    };

    const out = {} as Record<(typeof ROOT_NAMES)[number], string>;
    for (const name of ROOT_NAMES) {
        const raw = input[name];
        if (typeof raw !== 'string' || raw.trim() === '') {
            throw new Error(
                `Корень ${name} не задан. Раскладка ядра больше не выводится из места запуска: ` +
                    `подмодуль, дерево работы и состояние — разные места, и догадка о любом из ` +
                    `них однажды окажется неверной молча. Задай его в конфиге явно.`,
            );
        }
        const trimmed = raw.trim();
        assertPathShape(name, trimmed);
        out[name] = resolveStable(name, trimmed, d);
    }

    const pair = (a: (typeof ROOT_NAMES)[number], b: (typeof ROOT_NAMES)[number], why: string) => {
        if (contains(out[a], out[b]) || contains(out[b], out[a])) {
            throw new Error(`Корни ${a} (${out[a]}) и ${b} (${out[b]}) пересекаются: ${why}`);
        }
    };

    pair(
        'runtimeDir',
        'productRoot',
        'состояние внутри продукта делает подмодуль грязным — bump gitlink потащит рантайм за собой',
    );
    // Только когда работа идёт в ОТДЕЛЬНОМ дереве: если раннер работает дома
    // (executionRoot === consumerRoot), `<consumerRoot>/.ralph/runtime` — законный дом
    // состояния, и запрещать его значило бы запретить раскладку без worktree вовсе.
    if (out.executionRoot !== out.consumerRoot) {
        pair(
            'runtimeDir',
            'executionRoot',
            'дерево работы переключают, чистят и удаляют вместе с worktree фазы — состояние обязано это пережить',
        );
    }
    if (out.productRoot === out.executionRoot) {
        throw new Error(
            `Корни productRoot и executionRoot совпадают (${out.productRoot}): продукт — ` +
                `подмодуль внутри дерева работы, а не само дерево. Совпав, они делают ` +
                `любую запись прогона записью в продукт.`,
        );
    }
    if (out.productRoot === out.consumerRoot) {
        throw new Error(
            `Корни productRoot и consumerRoot совпадают (${out.productRoot}): ядро — ` +
                `подключённый продукт, а не сам проект. Совпав, они означают, что потребителя ` +
                `нет вовсе, и правки ядра поедут в его историю.`,
        );
    }

    return out as TResolvedRoots;
}

/**
 * Имя каталога состояния для ОДНОГО экземпляра раннера.
 *
 * Два раннера из одного дерева (боевой и playground) обязаны иметь разное состояние: общий
 * `runtimeDir` — это чужой лок, чужая фаза и чужой лог в одном файле, причём расходятся они
 * тихо. Имя детерминировано: перезапуск обязан найти СВОЁ состояние, а не завести новое.
 *
 * Хэш берётся от пути дерева, а не от одного имени профиля: два клона одного репозитория на
 * машине — обычное дело, и профиль `prod` у них разный.
 *
 * `consumerRoot` сюда передают УЖЕ РЕЗОЛВНУТЫМ — тем, что вернул `resolveRoots`. Иначе
 * запуск через симлинк и через настоящий путь дадут два namespace для одного инода, и
 * перезапуск не найдёт своё состояние (ревью !18); сырую строку функция отвергает.
 */
export function instanceNamespace(consumerRoot: string, instance: string): string {
    if (!isAbsolute(consumerRoot) || consumerRoot.split(/[\\/]/).some((seg) => seg === '..')) {
        throw new Error(
            `instanceNamespace: consumerRoot должен быть уже резолвнутым абсолютным путём ` +
                `(получено «${consumerRoot}»). Иначе один и тот же экземпляр получит разные ` +
                `каталоги состояния при запуске через симлинк и напрямую.`,
        );
    }
    const slug = instance
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    // Хэш — от пары «дерево + ИМЯ ЭКЗЕМПЛЯРА», а не от одного дерева: `prod/eu` и `prod-eu`
    // дают одинаковый slug, и без имени в хэше два разных экземпляра поделили бы state, лок
    // и лог — молча, до первого странного отказа (ревью !18). Разделитель `\0` в путях и
    // именах не встречается, поэтому склейка однозначна. Двенадцать шестнадцатеричных цифр,
    // а не восемь: восемь — 32 бита, и на десятке деревьев это уже не «никогда».
    const digest = createHash('sha256')
        .update(`${consumerRoot}\u0000${instance}`)
        .digest('hex')
        .slice(0, 12);
    return `${slug === '' ? 'instance' : slug}-${digest}`;
}

/**
 * Путь относительно базы — но абсолютный остаётся собой.
 *
 * `path.join('/work/tree', '/state/ralph.log')` даёт `/work/tree/state/ralph.log`: склейка
 * молча теряет абсолютность, и файл уезжает ВНУТРЬ дерева работы — ровно туда, откуда его
 * увозили. Отказ при этом тихий: раннер пишет лог в одно место, монитор читает другое и
 * показывает «раннер молчит» (ревью !19).
 */
export function underRoot(base: string, p: string): string {
    return isAbsolute(p) ? p : join(base, p);
}

type TWriteDeps = {
    /** `mode` — права, с которыми создать временный файл (права цели, если она была). */
    writeFn?: (path: string, data: string, mode?: number) => void;
    renameFn?: (from: string, to: string) => void;
    /** Права существующего целевого файла; `null` — файла ещё нет. */
    modeOfFn?: (path: string) => number | null;
};

/**
 * Права существующего файла состояния; `null` — файла ещё нет (новый получит права от umask).
 *
 * `lstat`, а не `stat`, и символическая ссылка — ОТКАЗ (ревью !20). Через ссылку сюда
 * приехали бы права её цели: подставленная ссылка на файл 0666 сделала бы новый state
 * доступным на запись всем, причём тихо. И сам `rename` поверх ссылки заменил бы саму
 * ссылку, а не то, на что она указывает, — состояние оказалось бы не там, где его ждут.
 */
function modeOf(p: string): number | null {
    let st;
    try {
        st = lstatSync(p);
    } catch {
        return null;
    }
    if (st.isSymbolicLink()) {
        throw new Error(
            `Файл состояния ${p} — символическая ссылка. Ни права, ни место записи в этом ` +
                `случае не те, что предполагает вызывающий: замена пошла бы поверх ссылки, а ` +
                `права приехали бы от её цели.`,
        );
    }
    return st.mode & 0o777;
}

// Счётчик в пределах ПОТОКА: имени временного файла нужна уникальность, а не случайность
// (`Math.random()` дал бы недетерминированный тест на ровном месте). Поэтому в имя входит и
// `threadId`: у worker-потоков один `process.pid`, но свой счётчик с нуля — два потока иначе
// взяли бы одно имя, перетёрли данные друг друга, и один получил бы ENOENT на rename
// (ревью !18).
let tmpCounter = 0;

/**
 * Запись файла состояния целиком или никак: временный файл рядом, затем `rename`.
 *
 * Прямая запись оставляет полуфайл, если прогон прервали посередине, — и раннер при
 * следующем старте читает битый JSON состояния как «состояния нет». Временный файл лежит
 * В ТОМ ЖЕ каталоге намеренно: `rename` атомарен только в пределах одной файловой системы,
 * а `/tmp` на другой ФС превращает его в копирование — то есть ровно в тот обрыв, от
 * которого мы уходим.
 */
export function writeFileAtomic(target: string, data: string, deps: TWriteDeps = {}): void {
    // Права задаются ПРИ СОЗДАНИИ временного файла, а не отдельным `chmod` после записи:
    // между записью и chmod оставалось окно, в котором файл существует с правами от umask,
    // и оно же было гонкой — chmod мог примениться уже не к тому иноду (ревью !20).
    // Флаг `wx` — создать эксклюзивно: имя временного уникально по процессу, потоку и
    // счётчику, и совпадение означало бы не «перезапишем», а что-то, чего мы не понимаем.
    const write =
        deps.writeFn ??
        ((p: string, text: string, mode?: number) => {
            guardSideEffect(`writeFileAtomic(${p})`, 'Подмени writeFn/renameFn в тесте.');
            writeFileSync(p, text, mode === undefined ? { flag: 'wx' } : { flag: 'wx', mode });
        });
    const rename =
        deps.renameFn ??
        ((from: string, to: string) => {
            guardSideEffect(`writeFileAtomic:rename(${to})`, 'Подмени writeFn/renameFn в тесте.');
            renameSync(from, to);
        });

    // Права ЦЕЛЕВОГО файла переносятся на временный: `rename` кладёт поверх новый инод со
    // своими правами от umask, и state, лежавший 0600, после первой же записи стал бы
    // читаемым всем — тихо, без единого сообщения (ревью !19).
    const mode = deps.modeOfFn ? deps.modeOfFn(target) : modeOf(target);

    tmpCounter += 1;
    const tmp = join(
        dirname(target),
        `.tmp-${String(process.pid)}-${String(threadId)}-${String(tmpCounter)}-${basename(target)}`,
    );
    write(tmp, data, mode ?? undefined);
    rename(tmp, target);
}
