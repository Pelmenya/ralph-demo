// Протокол миграции runtime-состояния (канон, задача 25).
//
// Переезд состояния из старой раскладки («всё в каталоге ядра») в `runtimeDir` контракта
// корней (задача 22) приходится делать на ЖИВОЙ петле, у которой есть незаконченная фаза.
// Самый дорогой исход — два экземпляра на разных раскладках, каждый со «своим»
// единственным состоянием: расходятся они молча, а обнаруживается это по двум PR на одну
// фазу. Поэтому переезд — не `mv`, а протокол с четырьмя свойствами:
//
//   1. **журнал пишется первым.** Обрыв питания посреди переезда обязан быть виден
//      следующему запуску, а не выглядеть как «странное состояние»;
//   2. **схема проверяется на КОПИИ**, до пометки старой раскладки: «переехали» должно
//      означать «на той стороне раннер стартует», а не «байты скопированы»;
//   3. **старое не удаляется, а переименовывается** (`*.migrated`) — откат обязан быть
//      возможен, а старт по прежней раскладке невозможен: иначе второй экземпляр поедет
//      на старом состоянии, ради чего протокол и написан;
//   4. **всё через инъекцию fs.** Модуль не знает про диск: он знает про порядок шагов,
//      а тесты проверяют именно порядок и поведение при обрыве.
//
// Каталоги модуль не создаёт: `runtimeDir` создаёт `main()` до лока (единственная запись,
// разрешённая до него), а переезд идёт уже внутрь готового каталога.

import { runtimePathsIn } from './runtime-paths.ts';

/** Имя журнала переезда в НОВОЙ раскладке: он про её появление, там ему и место. */
export const MIGRATION_JOURNAL = '.migration.json';
/** Маркер в СТАРОЙ раскладке: «состояние уехало туда-то». Читается человеком и стартом. */
export const MIGRATED_MARKER = 'MIGRATED-TO';
/** Суффикс переименованного оригинала — он же материал отката. */
export const MIGRATED_SUFFIX = '.migrated';
/** Файлы, растущие неограниченно: сверяются по размеру, а не по содержимому (см. ниже).
 *  Журнал событий растёт вместе со своим логом (строка на строку), поэтому он здесь же. */
const LOGS: ReadonlySet<string> = new Set([
    'ralph.log',
    'ralph.dry.log',
    'monitor.out',
    'ralph.events.jsonl',
    'ralph.dry.events.jsonl',
]);

export type TMigrationFile = { name: string; from: string; to: string };
export type TMigrationPlan = { from: string; to: string; files: TMigrationFile[] };
export type TMigrationStatus = 'in-progress' | 'done' | 'rolled-back';
export type TMigrationJournal = {
    status: TMigrationStatus;
    from: string;
    to: string;
    files: string[];
    startedAt: string;
    finishedAt?: string;
};

export type TMigrationDeps = {
    existsFn: (p: string) => boolean;
    readFn: (p: string) => string;
    writeFn: (p: string, data: string) => void;
    renameFn: (from: string, to: string) => void;
    removeFn: (p: string) => void;
    // Размер файла — отдельным примитивом: сверять растущие логи по СОДЕРЖИМОМУ значило бы
    // держать в памяти две их полные копии (ревью Codex, !23), а лог не ротируется.
    sizeFn: (p: string) => number;
    // Время — параметром, а не `Date.now()` в коде: иначе журнал недетерминирован, а тест
    // на него — мигающий. Тот же приём, что у остального ядра.
    now: () => string;
};

/** Путь в каталоге — своей склейкой, а не `path.join`: модуль оперирует уже готовыми
 *  адресами из описи, и единственное, что ему нужно, — приписать имя к каталогу. */
function at(dir: string, name: string): string {
    return `${dir}/${name}`;
}

/**
 * Состав переезда — по ОПИСИ путей состояния (`runtimePathsIn`), а не по перечислению
 * здесь. Перечисление разъехалось бы с описью на первом же новом файле состояния: его
 * добавили бы в опись и забыли тут, а он молча остался бы в старой раскладке.
 */
export function planRuntimeMigration(
    from: string,
    to: string,
    existsFn: (p: string) => boolean,
): TMigrationPlan {
    // Из описи исключены два ключа, и оба — осознанно (ревью Codex, !23):
    //   • `sessions` — АРХИВ логов прошлых сессий, а не состояние, от которого зависит
    //     продолжение фазы. Старые логи остаются на месте, новые пишутся в `runtimeDir`;
    //   • `lock` — файл ЖИВОГО процесса. Переезд идёт под локом, взятым уже в новой
    //     раскладке, и копирование старого лока поверх него затёрло бы собственный лок
    //     мигрирующего процесса, а откат — удалил бы его. Осиротевший legacy-лок снимает
    //     обычный механизм (он и так умеет отличать сироту от живого раннера).
    const SKIP: ReadonlySet<string> = new Set(['sessions', 'lock']);
    const names = Object.entries(runtimePathsIn(''))
        .filter(([key]) => !SKIP.has(key))
        .map(([, p]) => p.replace(/^\/+/, ''));
    const files = names
        .map((name) => ({ name, from: at(from, name), to: at(to, name) }))
        .filter((f) => existsFn(f.from));
    return { from, to, files };
}

function writeJournal(to: string, journal: TMigrationJournal, deps: TMigrationDeps): void {
    deps.writeFn(at(to, MIGRATION_JOURNAL), JSON.stringify(journal, null, 2));
}

export function readMigrationJournal(to: string, deps: TMigrationDeps): TMigrationJournal | null {
    const path = at(to, MIGRATION_JOURNAL);
    if (!deps.existsFn(path)) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(deps.readFn(path));
    } catch {
        throw new Error(
            `Журнал миграции ${path} не разбирается как JSON. «Не разобрал» — не «всё в ` +
                `порядке»: разбери руками, состояние могло остаться на полпути.`,
        );
    }
    const j = raw as Partial<TMigrationJournal>;
    if (!j || typeof j !== 'object' || typeof j.status !== 'string') {
        throw new Error(`Журнал миграции ${path} без поля status — разбери руками.`);
    }
    return j as TMigrationJournal;
}

/**
 * Барьер старта: незавершённый переезд не пускает петлю дальше. Состояние в этот момент
 * лежит в двух местах, и «продолжить как ни в чём не бывало» означало бы выбрать одно из
 * них молча — ровно тот исход, против которого протокол.
 */
export function assertMigrationSettled(to: string, deps: TMigrationDeps): void {
    const journal = readMigrationJournal(to, deps);
    if (!journal) return;
    if (journal.status === 'in-progress') {
        throw new Error(
            `Миграция состояния ${journal.from} → ${journal.to} не завершена (журнал ` +
                `${at(to, MIGRATION_JOURNAL)}). Состояние сейчас в двух местах: доведи переезд ` +
                `повторным --migrate-runtime (он возобновляемый) либо откати (--migrate-rollback).`,
        );
    }
    if (journal.status === 'rolled-back') {
        // Откат вернул состояние в старую раскладку, а конфиг по-прежнему указывает сюда —
        // значит следующий обычный запуск начал бы НОВУЮ фазу в пустом runtimeDir, пока
        // прежняя лежит в legacy (ревью Codex, !23). Разъезд конфига и диска — стоп.
        throw new Error(
            `Состояние откачено в ${journal.from} (журнал ${at(to, MIGRATION_JOURNAL)}), но ` +
                `конфиг всё ещё задаёт runtimeDir ${journal.to}. Убери секцию roots из конфига ` +
                `(вернёшься к прежней раскладке) либо запусти --migrate-runtime заново.`,
        );
    }
}

/** Цела ли копия состояния — тот же критерий, что у `assertStateSchema`, но ответом, а не
 *  броском: возобновление спрашивает «годится ли то, что уже лежит», и на этот вопрос
 *  исключение отвечать не должно. */
function isValidState(text: string): boolean {
    try {
        assertStateSchema('(копия)', text);
        return true;
    } catch {
        return false;
    }
}

/** Схема состояния — минимальная и по существу: раннер читает `count`/`milestone`, и
 *  переехавший файл, который он не разберёт, означает петлю, вставшую на той стороне. */
function assertStateSchema(path: string, text: string): void {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`Переехавшее состояние ${path} не проходит проверку схемы: не JSON.`);
    }
    const s = parsed as Record<string, unknown>;
    const okCount = typeof s.count === 'number';
    const okMilestone = typeof s.milestone === 'string' || s.milestone === null;
    if (!okCount || !okMilestone) {
        throw new Error(
            `Переехавшее состояние ${path} не проходит проверку схемы: ожидались числовой ` +
                `count и строковый milestone (или null).`,
        );
    }
}

/**
 * Переезд. Зовётся ПОД ЛОКОМ — модуль этого не проверяет и проверить не может: лок берёт
 * тот, кто владеет обеими раскладками (`main()`), и он же отвечает за то, что старый
 * экземпляр остановлен. Здесь — порядок шагов и их обратимость.
 */
export function migrateRuntime(plan: TMigrationPlan, deps: TMigrationDeps): TMigrationJournal {
    // ВОЗОБНОВЛЕНИЕ, а не новый переезд (ревью Codex, !23): после обрыва часть файлов уже
    // переименована, и построенный заново план их не увидит — он собирается по тому, что
    // ЛЕЖИТ в старой раскладке. Тогда повтор перевёз бы остаток, переписал журнал, и откат
    // вернул бы только остаток: половина состояния осталась бы в новой раскладке навсегда.
    // Поэтому список файлов берётся из журнала, если тот не закрыт.
    const previous = readMigrationJournal(plan.to, deps);
    const resuming = previous?.status === 'in-progress';
    const journal: TMigrationJournal = resuming
        ? previous
        : {
              status: 'in-progress',
              from: plan.from,
              to: plan.to,
              files: plan.files.map((f) => f.name),
              startedAt: deps.now(),
          };
    // Журнал — первым, ДО единственного байта копирования: обрыв на любом следующем шаге
    // виден следующему запуску как незавершённый переезд, а не как странное состояние.
    if (!resuming) writeJournal(plan.to, journal, deps);

    // Каждый шаг идемпотентен и смотрит на диск, а не на позицию в списке: возобновление
    // обязано доводить переезд с ЛЮБОГО места обрыва, включая «все переименованы, маркер не
    // записан» — иначе журнал остался бы in-progress навсегда, а петля не стартовала бы.
    for (const name of journal.files) {
        const from = at(journal.from, name);
        const to = at(journal.to, name);
        const parked = `${from}${MIGRATED_SUFFIX}`;
        const isState = name.endsWith('ralph.state.json');
        // Годность копии решает СВЕРКА С ПАРКОВКОЙ, а не валидность формата (ревью Codex,
        // !23). Формат знает только `ralph.state.json`; у лога и `ralph.requests.jsonl`
        // «правильного вида» нет вовсе, и усечённый хвост JSONL выглядел бы целым файлом.
        //
        // Но сверяются они по-разному, и разница вынужденная: логи растут неограниченно
        // (`ralph.log` не ротируется), и сравнение по содержимому держало бы в памяти две
        // их полные копии — на большом логе это отказ по памяти, из которого повтор не
        // выводит. Для них сверяется РАЗМЕР: он ловит усечение, единственный отказ, который
        // тут вообще возможен (лог только дописывается). Остальные файлы малы по устройству
        // — состояние, маркер зависимостей, очередь намерений, — и сверяются побайтно, что
        // ловит ещё и устаревшую копию от прошлой попытки.
        const sameAsParked = () =>
            LOGS.has(name)
                ? deps.sizeFn(to) === deps.sizeFn(parked)
                : deps.readFn(to) === deps.readFn(parked);
        const copyOk = deps.existsFn(parked)
            ? deps.existsFn(to) && sameAsParked()
            : deps.existsFn(to) && (!isState || isValidState(deps.readFn(to)));
        if (deps.existsFn(from)) {
            const text = deps.readFn(from);
            deps.writeFn(to, text);
            // Схема проверяется на КОПИИ и до пометки старого места: отказ здесь оставляет
            // прежнюю раскладку рабочей, и возвращаться некуда не приходится.
            if (isState) assertStateSchema(to, text);
        } else if (deps.existsFn(parked) && !copyOk) {
            // Оригинал уже припаркован, а копии нет, она усечена или отстала от парковки:
            // обрыв между переименованием и записью. Молча считать такой переезд удавшимся
            // нельзя — обычный запуск продолжил бы фазу по неверному состоянию.
            const text = deps.readFn(parked);
            deps.writeFn(to, text);
            if (isState) assertStateSchema(to, text);
        } else if (!deps.existsFn(parked) && !deps.existsFn(to)) {
            // Ни оригинала, ни парковки, ни копии — файл исчез между планом и переездом.
            // Молчать нельзя: это ровно тот случай, когда «переехали» означало бы потерю.
            throw new Error(
                `Файл состояния ${name} исчез посреди переезда: нет ни ${from}, ни ${parked}, ` +
                    `ни ${to}. Разбери руками — откат (--migrate-rollback) вернёт остальное.`,
            );
        } else if (!copyOk) {
            // Копия есть, но битая, а восстанавливать неоткуда: оригинал не сохранился.
            throw new Error(
                `Переехавшее состояние ${to} испорчено, а восстановить его неоткуда: ни ` +
                    `${from}, ни ${parked} нет. Разбери руками.`,
            );
        }
    }

    for (const name of journal.files) {
        const from = at(journal.from, name);
        if (deps.existsFn(from)) deps.renameFn(from, `${from}${MIGRATED_SUFFIX}`);
    }
    // Маркер — СТРУКТУРНЫЙ (ревью Codex, !23): сверка подстрокой пропустила бы запуск с
    // runtimeDir `/runtime/prod`, когда состояние уехало в `/runtime/prod-old`, — и петля
    // завела бы второе состояние. Человеку он тоже читается: JSON с полем `note`.
    deps.writeFn(
        at(journal.from, MIGRATED_MARKER),
        JSON.stringify(
            {
                to: journal.to,
                at: journal.startedAt,
                note:
                    `Состояние раннера уехало в ${journal.to}. Файлы рядом с суффиксом ` +
                    `${MIGRATED_SUFFIX} — прежние копии, материал отката.`,
            },
            null,
            2,
        ),
    );

    const done: TMigrationJournal = { ...journal, status: 'done', finishedAt: deps.now() };
    writeJournal(journal.to, done, deps);
    return done;
}

/**
 * Барьер СТАРОЙ раскладки: маркер `MIGRATED-TO` читается, а не только пишется.
 *
 * Без этого запуск со старым конфигом (секции `roots` нет) не увидел бы ни маркера, ни
 * переименованного состояния, счёл бы, что состояния просто нет, и начал бы НОВУЮ фазу
 * рядом с уехавшей — два независимых состояния, ради предотвращения которых весь протокол
 * (ревью Codex, !23).
 */
export function assertLegacyNotMigrated(
    legacyDir: string,
    runtimeDir: string | null,
    deps: TMigrationDeps,
): void {
    const marker = at(legacyDir, MIGRATED_MARKER);
    if (!deps.existsFn(marker)) return;
    let target: unknown;
    try {
        target = (JSON.parse(deps.readFn(marker)) as { to?: unknown }).to;
    } catch {
        // Нечитаемый маркер — стоп, а не «наверное, всё в порядке»: он ставится ровно там,
        // где состояние уже уехало, и разобрать его обязан человек.
        throw new Error(
            `Маркер ${marker} не разбирается как JSON, а он означает уехавшее состояние. ` +
                `Разбери руками: продолжить — значит завести второе состояние.`,
        );
    }
    // Сверка ТОЧНАЯ, а не по подстроке: `/runtime/prod` и `/runtime/prod-old` — разные
    // каталоги, и подстрочное сравнение пропустило бы второй экземпляр (ревью Codex, !23).
    if (typeof target === 'string' && runtimeDir && target === runtimeDir) return;
    throw new Error(
        `Состояние из ${legacyDir} уже переехало в ${String(target)} (см. ${marker}), а этот ` +
            `запуск идёт ${runtimeDir ? `с runtimeDir ${runtimeDir}` : 'по СТАРОЙ раскладке'}. ` +
            `Продолжить — значит завести второе состояние рядом с уехавшим. Пропиши в конфиг ` +
            `тот же runtimeDir либо откати переезд (--migrate-rollback).`,
    );
}

/**
 * Откат к прежней раскладке — без окна, в котором живы два состояния: сначала возвращается
 * оригинал, потом исчезает копия. Работает и по ПРЕРВАННОЙ миграции (журнал in-progress):
 * именно она и нуждается в откате чаще завершённой.
 */
export function rollbackRuntime(to: string, deps: TMigrationDeps): TMigrationJournal {
    const journal = readMigrationJournal(to, deps);
    if (!journal) {
        throw new Error(
            `Откатывать нечего: журнала миграции ${at(to, MIGRATION_JOURNAL)} нет. Тихое ` +
                `«готово» здесь означало бы, что состояние трогали неизвестно как.`,
        );
    }
    for (const name of journal.files) {
        const original = at(journal.from, name);
        const parked = `${original}${MIGRATED_SUFFIX}`;
        if (deps.existsFn(parked)) deps.renameFn(parked, original);
        if (deps.existsFn(at(journal.to, name))) deps.removeFn(at(journal.to, name));
    }
    const marker = at(journal.from, MIGRATED_MARKER);
    if (deps.existsFn(marker)) deps.removeFn(marker);
    const rolled: TMigrationJournal = { ...journal, status: 'rolled-back', finishedAt: deps.now() };
    writeJournal(to, rolled, deps);
    return rolled;
}
