// Профили конфига раннера (#71 → #365, трек «Фреймворк ralph», фаза 3). Вынесены из
// ralph.js: сборка плоского конфига из `common` + `profiles.<name>` — одна связная зона,
// поведение НЕ меняется, это извлечение, а не переписывание.
//
// Конфиг разделён на `common` (общее) и `profiles` (дельта). Профиль НЕ дублирует
// общие поля — иначе профили разъезжаются молча: правку modelRouting внесли в один,
// забыли во втором, и прод неделю ходит на старой модели.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).
//
// Фабрика, а не standalone-экспорты: дефолтный failFn всех функций — боевой fail()
// ralph.js (process.exit), а resolveProfile зовёт валидаторы соседних зон
// (assertKnownReviewModels из review.ts, #223) — фабрика захватывает их один раз,
// возвращённые функции сохраняют показательную DI (failFn параметром) — ровно так их
// зовут существующие тесты (config-profile.test.ts) и monitor.js (мягкий failFn `() => null`).

import path from 'node:path';

import {
    ADAPTER_DEFAULTS,
    BOARD_SYNC_TASK_SOURCES,
    CODER_RUNTIME_PROVIDERS,
} from '../adapters/adapters-impl.ts';
// #110: набор уровней severity берётся из review-of-fixes.ts, второй список здесь не
// заводим: тот модуль — лист без импортов форжа и скриптов, поэтому core импортировать
// его можно.
import { FIX_SEVERITY_LEVELS } from './review-of-fixes.ts';
import { resolveRoots, type TRootsInput } from './roots.ts';
import { productRootFromLock } from './core-install.ts';

// fail() боевой уходит в process.exit(1); тестовый failFn может вернуть значение или
// бросить — поэтому возврат unknown, а не never (мягкий результат пробрасывается наверх).
type FailFn = (msg: string) => unknown;
type AssertKnownReviewModelsFn = (
    cfg: Record<string, unknown>,
    profileName: string,
    failFn?: FailFn,
) => unknown;

export type ConfigProfileEnv = {
    fail: FailFn;
    // #223: модели ревью (review.default/escalated) обязаны быть известны планке #217 —
    // валидатор живёт в review.ts, сюда приходит уже собранным из его фабрики.
    assertKnownReviewModels: AssertKnownReviewModelsFn;
};

/** Каталог ядра из lock потребителя (`core-install.ts`); подменяется в тестах. */
export type TLockRootFn = (
    consumerRoot: string,
) => { ok: true; path: string } | { ok: false; reason: string };

export function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Объекты сливаются вглубь (профиль правит ОДНУ метку modelRouting.labels, не
// переписывая блок), массивы и скаляры заменяются целиком. Частичный мердж массивов
// сознательно не делаем: для phases/authorAllowlist «дописать или заменить?» не имеет
// однозначного ответа, а неверная догадка в authorAllowlist — дыра в защите от инъекций.
// JSON.parse создаёт "__proto__" СОБСТВЕННЫМ ключом, но присваивание out[k] дёргает
// сеттер и подменяет прототип результата — в конфиге всплывают фантомные поля, которых
// в файле визуально нет. Легитимных полей с такими именами у нас не бывает, поэтому
// это либо опечатка, либо чужая рука — и то и другое для раннера с bypassPermissions
// повод остановиться, а не тихо нейтрализовать (fail-closed, как и вся схема профилей).
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

// Режимы прав сессии, которые принимает `--permission-mode` CLI кодера (канон, задача 33).
// Список закрыт: значение уходит в CLI как есть, и незнакомое валит старт. Снят с
// Claude Code 2.1.311: `claude --help` перечисляет acceptEdits, auto, bypassPermissions,
// manual, dontAsk, plan; `default` в справке нет, но CLI его принимает (проверено вызовом
// `--permission-mode default`) — старые конфиги с ним не ломаются. Новый режим CLI
// попадает сюда правкой со сверкой по `claude --help`, иначе отказ назовёт опечаткой
// валидное значение.
export const PERMISSION_MODES = [
    'default',
    'acceptEdits',
    'auto',
    'bypassPermissions',
    'manual',
    'dontAsk',
    'plan',
] as const;
export type TPermissionMode = (typeof PERMISSION_MODES)[number];

// Скрипты потребителя, которые умеет звать ядро (канон, задача 23). Список закрыт: он же
// служит проверкой опечатки в имени ключа — незнакомый ключ валит старт, а не тихо
// выключает скрипт.
export const CONSUMER_SCRIPT_KEYS = ['projectSync', 'reviewFindingsJournal'] as const;

// Секция в том виде, в каком её пишет потребитель: путь либо `null` — явное «выключено».
// Тип живёт здесь, рядом с закрытым списком ключей и валидатором, и импортируется теми, кто
// секцию ЧИТАЕТ (orchestrator, review): три копии литерального типа разъехались бы молча.
export type TConsumerScripts = Partial<
    Record<(typeof CONSUMER_SCRIPT_KEYS)[number], string | null>
>;

// Резолвнутая секция: те же ключи, но каждый присутствует явно — `null` означает «выключено»
// (ключа нет, задан null либо площадка синк не зовёт). Читающему не нужно гадать, чем
// отличается отсутствие ключа от выключения: оба уже сведены к одному ответу.
export type TConsumerScriptsResolved = Record<(typeof CONSUMER_SCRIPT_KEYS)[number], string | null>;

// Скан ВСЕЙ глубины, а не только уровней, куда рекурсирует мердж: объект из профиля по
// ключу, которого нет в common, копируется присваиванием — без этого обхода его нутро
// не проверялось бы вовсе, и инвариант «в конфиге не бывает опасных ключей» был бы
// ложным обещанием комментария. Возвращает имя первого найденного ключа с путём.
function findForbiddenKey(value: unknown, path: string): string | null {
    if (!isPlainObject(value)) return null;
    for (const [k, v] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.includes(k)) return `"${k}" в блоке "${path}"`;
        const deeper = findForbiddenKey(v, `${path}.${k}`);
        if (deeper) return deeper;
    }
    return null;
}

export function createConfigProfile(env: ConfigProfileEnv) {
    const { fail, assertKnownReviewModels } = env;

    // Рекурсивный мердж БЕЗ скана запрещённых ключей: findForbiddenKey уже прошёл оба
    // дерева на всю глубину в deepMerge (единожды, до мерджа), поэтому здесь повторно
    // сканировать нечего — иначе каждый уровень рекурсии перепроверял бы всё поддерево
    // заново (лишний проход на каждый уровень глубины). Никогда не зовёт failFn.
    function deepMergeInner(
        base: Record<string, unknown>,
        override: Record<string, unknown>,
    ): Record<string, unknown> {
        const out: Record<string, unknown> = { ...base };
        for (const [k, v] of Object.entries(override)) {
            if (!isPlainObject(v) || !isPlainObject(base[k])) {
                out[k] = v;
                continue;
            }
            out[k] = deepMergeInner(base[k] as Record<string, unknown>, v);
        }
        return out;
    }

    function deepMerge(
        base: Record<string, unknown>,
        override: Record<string, unknown>,
        failFn: FailFn = fail,
        basePath = 'common',
        // base — это common, override — профиль: у них РАЗНЫЕ блоки конфига, поэтому и
        // ярлыки пути разные (иначе запрещённый ключ из common всплывёт как «в блоке
        // "prod.…"» — внятность сообщения соврёт про блок). Прямые вызовы (тесты/монитор)
        // с одним path получают его для обоих аргументов — обратная совместимость.
        overridePath: string = basePath,
    ): unknown {
        // Один скан обоих деревьев на верхнем уровне (findForbiddenKey сам рекурсивен на
        // всю глубину), а не на каждом уровне мерджа. failFn мог не бросить (монитор
        // передаёт `() => null`) — тогда его результат уходит наверх, а не собирается
        // конфиг из полуфабриката (resolveProfile проверяет isPlainObject).
        const bad = findForbiddenKey(base, basePath) || findForbiddenKey(override, overridePath);
        if (bad) return failFn(`ralph.config.json: запрещённый ключ ${bad}.`);
        return deepMergeInner(base, override);
    }

    // Флаг --profile <name> | --profile=<name> (#72). Нет флага → null, дальше решает
    // defaultProfile из конфига. Флаг БЕЗ имени — стоп: это почти всегда оборванная
    // команда, а «молча ушёл в playground, когда просили prod» — ровно тот тихий сдвиг
    // режима, против которого затевались профили.
    function parseProfileFlag(argv: string[], failFn: FailFn = fail): unknown {
        // Обе формы собираем разом: при дубле (`--profile a --profile=b`) «кто победит»
        // решал бы порядок веток кода, а не намерение человека — тихий уход не в тот
        // профиль. Дубль — стоп, даже с одинаковыми именами: команда явно собрана криво.
        const hits = argv.filter((a) => a === '--profile' || a.startsWith('--profile='));
        if (hits.length === 0) return null;
        if (hits.length > 1) {
            return failFn(`Флаг --profile указан ${hits.length} раза — оставь один.`);
        }
        if (hits[0].startsWith('--profile=')) {
            const name = hits[0].slice('--profile='.length);
            // Пустое имя ИЛИ ведущий `--` (`--profile=--once`) — пропущенное имя, ровно как
            // у пробельной формы ниже: без этой проверки `--once` уехал бы в имя профиля
            // (downstream resolveProfile отверг бы «Неизвестный профиль "--once"», но
            // сообщение хуже и поведение двух форм расходится).
            if (!name || name.startsWith('--')) {
                return failFn('Флаг --profile= без имени профиля.');
            }
            return name;
        }
        const value = argv[argv.indexOf('--profile') + 1];
        // Следующий флаг вместо имени (`--profile --once`) — тоже пропущенное имя.
        if (!value || value.startsWith('--')) {
            return failFn('Флаг --profile требует имя профиля: --profile <name>.');
        }
        return value;
    }

    // #249: haltBeforeDeploy валидируется на старте — тип и место (инвариант №1: кривой
    // конфиг = fail-closed стоп, а не тихий дефолт). Решение о непрерывном prod принимает
    // строгое `cfg.haltBeforeDeploy !== false`, поэтому `"false"` (строка), `0` или `null`
    // в конфиге молча дали бы halt-режим — опечатка в типе должна валить старт, а не
    // всплывать утром остановленным треком, который человек считал непрерывным. Флаг
    // осмыслен только в профиле `prod` (пост-мердж деплой фазы 5): заданный вне prod он
    // молча ничего не значит — тоже fail, чтобы не создавать ложного ощущения непрерывности.
    // Возврат: true — валиден; иначе результат failFn (мягкий failFn пробрасываем наверх).
    function assertValidHaltBeforeDeploy(
        cfg: Record<string, unknown>,
        profileName: string,
        failFn: FailFn = fail,
    ): unknown {
        const v = cfg.haltBeforeDeploy;
        if (v === undefined) return true; // не задан — дефолт (halt), проверять нечего
        if (typeof v !== 'boolean') {
            return failFn(
                `ralph.config.json (профиль "${profileName}"): haltBeforeDeploy = ${JSON.stringify(v)} — ожидался boolean. ` +
                    `Непрерывный prod решает строгое "!== false", поэтому строка/число/null молча дали бы halt-режим (#249). ` +
                    `Убери ключ (дефолт = стоп перед деплоем) либо задай true/false.`,
            );
        }
        if (profileName !== 'prod') {
            return failFn(
                `ralph.config.json (профиль "${profileName}"): haltBeforeDeploy осмыслен только в профиле "prod" ` +
                    `(пост-мердж деплой фазы 5, #249). Вне prod флаг молча ничего не значит — убери его из этого профиля/common.`,
            );
        }
        return true;
    }

    // Канон, задача 33: permissionMode уходит в `--permission-mode` кодер-сессии как есть
    // (`buildClaudeArgs`). Опечатка (`bypassPermission`, `bypass-permissions`) без барьера
    // молча уехала бы в CLI, и режим прав сессии оказался бы не тем, который заказан
    // конфигом, — заметно это только по поведению живой сессии. Класс тот же, что у
    // haltBeforeDeploy: сдвиг режима, который выглядит исправной конфигурацией. Список
    // закрыт: новый режим CLI попадает сюда правкой, а не догадкой.
    // Возврат: true — валиден; иначе результат failFn (мягкий failFn пробрасываем наверх).
    function assertValidPermissionMode(
        cfg: Record<string, unknown>,
        profileName: string,
        failFn: FailFn = fail,
    ): unknown {
        const v = cfg.permissionMode;
        if (v === undefined) return true; // не задан — режим CLI по умолчанию, проверять нечего
        const allowed = PERMISSION_MODES.join(', ');
        if (typeof v !== 'string') {
            return failFn(
                `ralph.config.json (профиль "${profileName}"): permissionMode = ${JSON.stringify(v)} — ожидалась строка. ` +
                    `Допустимые: ${allowed}. Убери ключ (режим CLI по умолчанию) либо задай одно из них.`,
            );
        }
        if (!(PERMISSION_MODES as readonly string[]).includes(v)) {
            return failFn(
                `ralph.config.json (профиль "${profileName}"): permissionMode = ${JSON.stringify(v)} — неизвестный режим. ` +
                    `Допустимые: ${allowed}. Значение уходит в --permission-mode как есть, и опечатка тихо сменила бы режим прав сессии.`,
            );
        }
        return true;
    }

    // #16/#18/#110: схема блока `review`, отвечающего за карточки, которые петля заводит
    // по ходу работы, — ПЯТЬ независимых ключей: `backlogMilestone`, `backlogMilestoneCap`,
    // `backlogStaleDays`, `backlogStaleBudget` и `backlogSeverityFloor`. Имя без «вехи»
    // намеренно (ревью правок #110): последний ключ к вехе отношения не имеет вовсе — это
    // порог серьёзности находки, и ищущий, где он валидируется, по имени «…Milestone»
    // сюда бы не пришёл.
    //
    // Оба ключа адреса необязательны — не задан ни один,
    // карточки едут как раньше, без вехи. Но ЗАДАННЫЙ мусор валит старт, а не тихо
    // превращается в «адреса нет» (инвариант №1): именно этот режим отказа задача и
    // чинила. `backlogMilestone: 42` без барьера означал бы, что человек считает бэклог
    // разложенным по вехам, а карточки по-прежнему ложатся ровным слоем — и заметить это
    // можно только вручную пересчитав их через месяц.
    //
    // Пустой список и пустая строка тоже отказ: они выглядят как «ключ заполнен», а
    // работают как «ключа нет». Потолок — положительное ЦЕЛОЕ: ноль означал бы веху, в
    // которую ничего не влезает (все карточки мимо адреса), дробное — сравнение, которое
    // сработает на половине карточки.
    // Возврат: true — валиден; иначе результат failFn (мягкий failFn пробрасываем наверх).
    function assertValidReviewBacklog(
        cfg: Record<string, unknown>,
        profileName: string,
        failFn: FailFn = fail,
    ): unknown {
        const review = isPlainObject(cfg.review) ? (cfg.review as Record<string, unknown>) : null;
        if (!review) return true;
        const where = `ralph.config.json (профиль "${profileName}"): review.`;
        const milestone = review.backlogMilestone;
        if (milestone !== undefined) {
            const list = Array.isArray(milestone) ? milestone : [milestone];
            const bad =
                list.length === 0 || list.some((m) => typeof m !== 'string' || m.trim() === '');
            if (bad) {
                return failFn(
                    `${where}backlogMilestone = ${JSON.stringify(milestone)} — ожидалось непустое имя вехи ` +
                        `либо непустой список имён (#16). Молча принятый мусор означал бы, что карточки лестницы ` +
                        `по-прежнему ложатся в общий бэклог, тогда как конфиг говорит обратное. ` +
                        `Убери ключ (прежнее поведение — без адреса) либо задай имена вех.`,
                );
            }
            // Накопитель — веха, которую петля НЕ исполняет. На этом держится всё
            // остальное: и запрет «карточка не удлиняет фазу», и право заводить карточки
            // без потолка. Правило без механизма — пожелание, а механизма тут не было:
            // рантайм отвергает только веху ТЕКУЩЕЙ фазы (pickBacklogMilestone), и
            // накопитель, названный вехой БУДУЩЕЙ фазы, проезжал молча — а когда петля до
            // неё дойдёт, начнёт удлинять фазу ровно настолько, насколько сама находит
            // постороннего. Fail-closed на старте: это опечатка человека, и стоит она
            // несходящейся фазы посреди окна.
            const phases = Array.isArray(cfg.phases) ? cfg.phases : [];
            const phaseNames = new Set(
                phases
                    .map((p) =>
                        isPlainObject(p) ? (p as Record<string, unknown>).milestone : null,
                    )
                    .filter((m): m is string => typeof m === 'string'),
            );
            const clash = list.filter(
                (m): m is string => typeof m === 'string' && phaseNames.has(m),
            );
            if (clash.length > 0) {
                return failFn(
                    `${where}backlogMilestone = ${JSON.stringify(clash)} — эта веха стоит и в phases (#16). ` +
                        `Накопитель по определению веха, которую петля не исполняет: карточки, найденные по ходу ` +
                        `работы, попадая в очередь исполняемой фазы, удлиняют её ровно настолько, насколько петля ` +
                        `находит постороннего, — и фаза перестаёт кончаться. Заведи под накопитель отдельную веху.`,
                );
            }
        }
        const cap = review.backlogMilestoneCap;
        if (cap !== undefined && (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1)) {
            return failFn(
                `${where}backlogMilestoneCap = ${JSON.stringify(cap)} — ожидалось положительное целое (#16). ` +
                    `Ноль означал бы веху, в которую не влезает ни одна карточка, строка и дробное — сравнение, ` +
                    `которое сработает не там. Убери ключ (дефолт) либо задай число.`,
            );
        }
        // #18: срок годности карточек лестницы. Ключ не задан — чистки нет вовсе; заданный
        // мусор валит старт, а не превращается в тихое «чистки нет». Разница важна: это
        // механизм, ЗАКРЫВАЮЩИЙ чужие карточки, и «я думал, он включён» здесь стоит
        // потерянных находок, а «я думал, он выключен» — закрытых живых замечаний.
        const stale = review.backlogStaleDays;
        if (
            stale !== undefined &&
            (typeof stale !== 'number' || !Number.isInteger(stale) || stale < 1)
        ) {
            return failFn(
                `${where}backlogStaleDays = ${JSON.stringify(stale)} — ожидалось положительное целое ` +
                    `число дней (#18). Ноль и отрицательное означали бы «протухло всё, включая заведённое ` +
                    `минуту назад», строка и дробное — сравнение, которое сработает не там. ` +
                    `Убери ключ (чистки нет) либо задай число дней.`,
            );
        }
        // Бюджет чистки за прогон. Раньше числа не было вовсе — бюджет молча брался
        // равным `backlogMilestoneCap`, и обоснование звучало «больше, чем в веху влезает,
        // чистить не за чем». У вехи-НАКОПИТЕЛЯ, которой потолок не нужен вовсе, это
        // рассуждение разваливается: подняв потолок до пятисот ради вместимости, человек
        // заодно и незаметно поднимал до пятисот число закрытий за один прогон. Два
        // разных решения на одном числе — и второе принималось не глядя.
        const staleBudget = review.backlogStaleBudget;
        if (
            staleBudget !== undefined &&
            (typeof staleBudget !== 'number' || !Number.isInteger(staleBudget) || staleBudget < 1)
        ) {
            return failFn(
                `${where}backlogStaleBudget = ${JSON.stringify(staleBudget)} — ожидалось положительное ` +
                    `целое (#18). Ноль означал бы выключенную чистку, но выключатель у неё другой — ` +
                    `сними backlogStaleDays; строка и дробное — сравнение, которое сработает не там. ` +
                    `Убери ключ (дефолт) либо задай число карточек.`,
            );
        }
        // #110: порог серьёзности карточек лестницы ревью правок. Не задан — карточка
        // заводится на любую находку, включая nit: это прежнее поведение, и оно обязано
        // остаться дефолтом — механизм РЕШАЕТ, что находка будет ПОТЕРЯНА для трекера
        // (комментарий на PR и счёт журнала находок фильтру не подчинены), и тихо
        // включённым ему быть нельзя, тот же принцип, что у backlogStaleDays. Заданное
        // значение обязано быть ОДНИМ ИЗ известных уровней — набор берётся из
        // review-of-fixes.ts (FIX_SEVERITY_LEVELS), а не заводится здесь заново.
        const severityFloor = review.backlogSeverityFloor;
        if (
            severityFloor !== undefined &&
            !(FIX_SEVERITY_LEVELS as readonly unknown[]).includes(severityFloor)
        ) {
            return failFn(
                `${where}backlogSeverityFloor = ${JSON.stringify(severityFloor)} — ожидался один из уровней ` +
                    `${FIX_SEVERITY_LEVELS.join(', ')} (#110). Неизвестный уровень выглядел бы как заполненный ` +
                    `порог, а фильтр молча пропускал бы всё — то же самое, что и отсутствие ключа, просто без ` +
                    `предупреждения. Убери ключ (дефолт — заводить карточку на любую находку) либо задай ` +
                    `известный уровень.`,
            );
        }
        return true;
    }

    // #48: плейсхолдеры промпта кодер-сессии. Петля подставляет РОВНО `{milestone}` и
    // `{branch}`; всё остальное в фигурных скобках уедет в сессию как есть.
    //
    // Барьер, а не вычитка глазами: боевой конфиг задавал `{{MILESTONE}}`/`{{BRANCH}}` — ни
    // одного совпадения с подстановкой, — и первая же итерация уходила бы с промптом
    // «возьми issue из milestone «{{MILESTONE}}»». Сессия при этом не падает: она честно
    // делает что-то не то, а брейкер `maxNoProgress` гасит петлю через три сожжённые
    // сессии. Отказ на старте стоит трёх строк, диагностика молчаливого случая — вечера.
    //
    // Проверяется ОСТАТОК после подстановки, а не исходный текст: так барьер ловит и
    // опечатку в имени (`{mileston}`), и чужую форму (`{{…}}`), не перечисляя их.
    function assertValidPromptPlaceholders(
        cfg: Record<string, unknown>,
        profileName: string,
        failFn: FailFn = fail,
    ): unknown {
        const prompt = cfg.prompt;
        if (typeof prompt !== 'string' || prompt === '') return true;
        const left = prompt.replaceAll('{milestone}', '').replaceAll('{branch}', '');
        const stray = [...left.matchAll(/\{[^{}\n]{0,60}\}/g)].map((m) => m[0]);
        if (stray.length > 0) {
            return failFn(
                `ralph.config.json (профиль "${profileName}"): в prompt остались нераскрытые ` +
                    `плейсхолдеры ${stray.join(', ')} — петля подставляет только {milestone} и {branch}. ` +
                    'Сессия получила бы их буквально и делала бы не то, а понять это можно только ' +
                    'по трём сожжённым итерациям (#48).',
            );
        }
        return true;
    }

    // #376 (фаза 6): значение modelRouting — либо строка (обратная совместимость,
    // claude-модель, провайдер по умолчанию — статический adapters.coderRuntime), либо
    // объект { provider, model } (явный выбор провайдера кодер-рантайма). provider
    // сверяется ПРОТИВ РЕЕСТРА (CODER_RUNTIME_PROVIDERS), а не принимается любой строкой —
    // иначе опечатка вида "kimy" тихо укатилась бы на дефолтный рантайм (инвариант №1).
    // Используется для modelRouting.labels[*]/default/apiLimitFallback/healEscalation.route —
    // один валидатор на все четыре места, схема одинаковая. Имя `assertValid*` (а не
    // `describe*`) отражает роль: функция ВАЛИДИРУЕТ (true / результат failFn), а не
    // форматирует описание — консистентно с соседями assertValidHaltBeforeDeploy/…
    //
    // requireProvider (ревью-blocker): когда статический adapters.coderRuntime ≠ 'claude',
    // безпровайдерная запись (голая строка ИЛИ объект без provider) означает «модель для
    // статического НЕ-claude рантайма» — но модель может оказаться claude-именем из
    // дефолтного роутинга, и она молча уехала бы на чужой endpoint (регрессия
    // «claude --model claude-… против Moonshot»). Тогда требуем provider явно в каждой
    // записи — barrier вместо надежды, что оператор обновил имена моделей (инвариант №5).
    function assertValidModelRouteEntry(
        path: string,
        entry: unknown,
        failFn: FailFn,
        { requireProvider = false }: { requireProvider?: boolean } = {},
    ): unknown {
        if (entry === undefined) return true; // не задан — нечего проверять
        if (typeof entry === 'string') {
            if (entry.trim() === '') {
                return failFn(
                    `ralph.config.json: ${path} — пустая строка. Задай имя модели (строка) либо объект { provider, model }.`,
                );
            }
            if (requireProvider) {
                return failFn(
                    `ralph.config.json: ${path} — голая строка-модель "${entry}" недопустима, когда ` +
                        `adapters.coderRuntime ≠ 'claude': она берёт статический не-claude рантайм, а claude-имя ` +
                        `из дефолтного роутинга молча уехало бы на чужой endpoint. Задай { provider, model } явно.`,
                );
            }
            return true;
        }
        if (!isPlainObject(entry)) {
            return failFn(
                `ralph.config.json: ${path} должен быть строкой (имя claude-модели, обратная совместимость) ` +
                    `либо объектом { provider, model } (#376, provider-aware роутинг). Получено: ${JSON.stringify(entry)}.`,
            );
        }
        const { provider, model } = entry;
        if (
            provider !== undefined &&
            (typeof provider !== 'string' ||
                !(CODER_RUNTIME_PROVIDERS as readonly string[]).includes(provider))
        ) {
            return failFn(
                `ralph.config.json: ${path}.provider = ${JSON.stringify(provider)} — неизвестный провайдер кодер-рантайма. ` +
                    `Допустимые (реестр coderRuntime): ${CODER_RUNTIME_PROVIDERS.join(', ')}.`,
            );
        }
        if (requireProvider && provider === undefined) {
            return failFn(
                `ralph.config.json: ${path}.provider обязателен, когда adapters.coderRuntime ≠ 'claude': без него ` +
                    `запись берёт статический не-claude рантайм, а model может оказаться claude-именем (тихий mismatch).`,
            );
        }
        if (typeof model !== 'string' || model.trim() === '') {
            return failFn(
                `ralph.config.json: ${path}.model обязателен и должен быть непустой строкой модели провайдера.`,
            );
        }
        return true;
    }

    // Fail-closed на схеме modelRouting целиком (#376): labels/default читает КАЖДЫЙ
    // кодер-запуск (pickModel/pickRuntime, orchestrator.ts), apiLimitFallback/healEscalation —
    // доп.скоуп кросс-провайдерного фолбэка и эскалации heal-сессий гейта. Невалидная
    // комбинация провайдер/модель ловится здесь, на старте, а не в момент диспетчеризации
    // кодер-сессии посреди ночного прогона. Возврат: true — валиден; иначе результат failFn
    // (мягкий failFn пробрасываем наверх).
    function assertValidModelRouting(
        cfg: Record<string, unknown>,
        profileName: string,
        failFn: FailFn = fail,
    ): unknown {
        const routing = cfg.modelRouting;
        if (routing === undefined) return true; // не задан — раннер берёт config.model как раньше
        if (!isPlainObject(routing)) {
            return failFn(
                `ralph.config.json (профиль "${profileName}"): modelRouting должен быть объектом.`,
            );
        }
        // Статический кодер-рантайм всего прогона (adapters.coderRuntime, дефолт 'claude').
        // Когда он ≠ 'claude' — безпровайдерные записи роутинга запрещены (см. requireProvider
        // в assertValidModelRouteEntry): иначе claude-имя молча уехало бы на чужой endpoint.
        const adapters = cfg.adapters;
        const staticRuntime =
            isPlainObject(adapters) && typeof adapters.coderRuntime === 'string'
                ? adapters.coderRuntime
                : ADAPTER_DEFAULTS.coderRuntime;
        const requireProvider = staticRuntime !== 'claude';
        const entryOpts = { requireProvider };

        const defaultOk = assertValidModelRouteEntry(
            'modelRouting.default',
            routing.default,
            failFn,
            entryOpts,
        );
        if (defaultOk !== true) return defaultOk;
        if (routing.labels !== undefined) {
            if (!isPlainObject(routing.labels)) {
                return failFn(
                    `ralph.config.json (профиль "${profileName}"): modelRouting.labels должен быть объектом label → модель.`,
                );
            }
            for (const [label, entry] of Object.entries(routing.labels)) {
                const ok = assertValidModelRouteEntry(
                    `modelRouting.labels["${label}"]`,
                    entry,
                    failFn,
                    entryOpts,
                );
                if (ok !== true) return ok;
            }
        }
        // Доп.скоуп #376: кросс-провайдерный фолбэк при API-лимите — та же схема записи.
        const fallbackOk = assertValidModelRouteEntry(
            'modelRouting.apiLimitFallback',
            routing.apiLimitFallback,
            failFn,
            entryOpts,
        );
        if (fallbackOk !== true) return fallbackOk;
        // Ревью-thread: apiLimitFallback, резолвящийся в ТОТ ЖЕ провайдер, что и статический
        // coderRuntime — гарантированный no-op: runClaude пропускает same-provider фолбэк
        // («повтор тем же провайдером до ожидания бессмыслен»). Молчаливый no-op-конфиг хуже
        // честного отказа (инвариант №1) — кросс-провайдерный фолбэк требует ДРУГОГО
        // провайдера. Смена только модели в рамках провайдера тут не поддержана намеренно
        // (в отличие от healEscalation, где эскалация модели того же провайдера осмысленна).
        if (routing.apiLimitFallback !== undefined) {
            const fb = routing.apiLimitFallback;
            const fbProvider =
                typeof fb === 'string'
                    ? staticRuntime
                    : isPlainObject(fb) && typeof fb.provider === 'string'
                      ? fb.provider
                      : staticRuntime;
            if (fbProvider === staticRuntime) {
                return failFn(
                    `ralph.config.json (профиль "${profileName}"): modelRouting.apiLimitFallback резолвится в ТОТ ЖЕ ` +
                        `провайдер "${staticRuntime}", что и статический coderRuntime — runClaude пропускает ` +
                        `same-provider фолбэк, запись была бы молчаливым no-op. Укажи provider, отличный от ` +
                        `статического, либо убери apiLimitFallback.`,
                );
            }
        }
        // Доп.скоуп #376: эскалация heal-сессий гейта «с дешёвой на сильную» после
        // afterAttempts неудачных попыток. Секция задана — требуем ОБА поля (afterAttempts И
        // route): частично заданная (`{route}` без afterAttempts, `{afterAttempts}` без route)
        // в рантайме — тихий no-op (эскалация никогда не сработает), тот же класс «тихий
        // дефолт», против которого весь валидатор (инвариант №1). afterAttempts — положительное
        // число (0/отрицательное эскалировали бы на первой же попытке — не по намерению автора).
        if (routing.healEscalation !== undefined) {
            if (!isPlainObject(routing.healEscalation)) {
                return failFn(
                    `ralph.config.json (профиль "${profileName}"): modelRouting.healEscalation должен быть объектом { afterAttempts, route }.`,
                );
            }
            const { afterAttempts, route } = routing.healEscalation;
            if (afterAttempts === undefined) {
                return failFn(
                    `ralph.config.json (профиль "${profileName}"): modelRouting.healEscalation задан, но afterAttempts отсутствует — ` +
                        `секция была бы молчаливым no-op (эскалация никогда не сработает). Укажи afterAttempts И route, либо убери секцию.`,
                );
            }
            if (!(typeof afterAttempts === 'number' && afterAttempts > 0)) {
                return failFn(
                    `ralph.config.json (профиль "${profileName}"): modelRouting.healEscalation.afterAttempts должен быть положительным числом попыток.`,
                );
            }
            if (route === undefined) {
                return failFn(
                    `ralph.config.json (профиль "${profileName}"): modelRouting.healEscalation задан, но route отсутствует — ` +
                        `эскалации не на что переключаться, секция молчаливый no-op. Укажи route И afterAttempts.`,
                );
            }
            const routeOk = assertValidModelRouteEntry(
                'modelRouting.healEscalation.route',
                route,
                failFn,
                entryOpts,
            );
            if (routeOk !== true) return routeOk;
        }
        return true;
    }

    // Fail-closed: любой изъян схемы — стоп с внятным сообщением, а не тихий дефолт.
    // Автономный раннер с bypassPermissions не имеет права УГАДЫВАТЬ, в каком режиме он
    // работает: «молча свалился в playground, думая что он prod» — худший исход из всех.
    // failFn инжектируется (как в preflight) — тесты проверяют отказы без process.exit.
    /**
     * Раскладка четырёх корней (канон, задача 21): `consumerRoot`, `executionRoot`,
     * `productRoot`, `runtimeDir`.
     *
     * Секция НЕОБЯЗАТЕЛЬНА ровно до переезда состояния (задача 22): её отсутствие означает
     * старую раскладку «всё в каталоге ядра» — сказанное вслух умолчание, а не догадка о
     * путях. Но заданная секция проверяется целиком, и полусобранная отвергается: конфиг с
     * тремя корнями из четырёх выглядит настроенным, и именно поэтому опаснее пустого —
     * четвёртый путь молча уедет туда, куда упадёт `resolve` от места запуска.
     *
     * Возвращает РЕЗОЛВНУТЫЕ корни, а не `true`: резолв разворачивает симлинки и стоит
     * обращений к диску, и выбросить его результат значило бы пересчитывать то же самое в
     * каждом месте, где корень понадобится, — с шансом получить другой ответ, если дерево
     * между вызовами изменилось (ревью !18). Отсутствие секции — `null`: «раскладки нет»
     * и «раскладка пустая» должны различаться на вкус вызывающего.
     *
     * Исключение из «целиком» одно — `productRoot` (#134): его launcher выводит из lock
     * (`productRootFromLock`), потому что при ядре из установки ключ был второй копией SHA и
     * требовал ручной правки на каждой смене ревизии. Вывод — не догадка от места запуска:
     * lock нет — отказ с причиной. Откуда взят путь, уходит вызывающему (`productRootFrom`):
     * старт сверяет с исполняемым ядром и выведенный путь, а не только заданный.
     */
    function assertValidRoots(
        cfg: Record<string, unknown>,
        profileName: string,
        failFn: FailFn = fail,
        lockRootFn: TLockRootFn = productRootFromLock,
    ): unknown {
        const raw = cfg.roots;
        if (raw === undefined) return { rootsResolved: null, productRootFrom: null };
        if (!isPlainObject(raw)) {
            return failFn(`ralph.config.json: "roots" в профиле "${profileName}" — не объект.`);
        }
        const input = { ...raw } as TRootsInput;
        const pinned = typeof raw.productRoot === 'string' && raw.productRoot.trim() !== '';
        const consumer = typeof raw.consumerRoot === 'string' ? raw.consumerRoot.trim() : '';
        // Без годного consumerRoot lock искать негде — резолв ниже назовёт сам consumerRoot.
        if (!pinned && path.isAbsolute(consumer)) {
            const fromLock = lockRootFn(consumer);
            if (!fromLock.ok) {
                return failFn(
                    `ralph.config.json: "roots" в профиле "${profileName}": roots.productRoot не ` +
                        `задан, а вывести его из lock нельзя (${fromLock.reason}). Ядро из ` +
                        `установки — поставь ревизию: ./ralph install; ядро-клон или подмодуль — ` +
                        `задай roots.productRoot явно.`,
                );
            }
            input.productRoot = fromLock.path;
        }
        try {
            return {
                rootsResolved: resolveRoots(input),
                productRootFrom: pinned ? 'config' : 'lock',
            };
        } catch (e) {
            return failFn(
                `ralph.config.json: "roots" в профиле "${profileName}": ${(e as Error).message}`,
            );
        }
    }

    // Канон, задача 23: скрипты ПОТРЕБИТЕЛЯ, которые зовёт ядро (синк доски, журнал
    // находок ревью). В каноне их нет вовсе, и раньше ядро звало их по зашитым путям —
    // то есть молча требовало у каждого потребителя файл с таким именем в таком месте.
    //
    // Секция необязательна: у площадки, где доска — проекция статуса, синка нет вовсе, и
    // «журнала не веду» — законный выбор. Но ЗАДАННАЯ секция проверяется целиком, потому
    // что оба вызова fail-open: «файла нет» неотличимо от «прошло успешно», и опечатка в
    // пути осталась бы видна только через месяц пустого журнала.
    //
    // Форма значения: непустой путь ЛИБО `null` — явное «выключено». `null` нужен именно
    // профилю: `{}` в профиле мерджем растворяется и молча наследует путь из `common`
    // (ревью !21), то есть выключить унаследованный скрипт было бы нечем — а профиль
    // playground, дёргающий боевой синк доски, ровно тот отказ, ради которого профили и
    // заводились.
    function checkConsumerScriptsShape(section: unknown, where: string, failFn: FailFn): unknown {
        if (section === undefined) return true;
        if (!isPlainObject(section)) {
            return failFn(
                `${where} — не объект (получено ${JSON.stringify(section)}). Ожидались пути скриптов ` +
                    `потребителя: { ${CONSUMER_SCRIPT_KEYS.join(', ')} } (канон, задача 23). ` +
                    `Выключается КАЖДЫЙ ключ значением null, а не секция целиком: ` +
                    `{ ${CONSUMER_SCRIPT_KEYS.map((k) => `"${k}": null`).join(', ')} }.`,
            );
        }
        const keys = Object.keys(section);
        if (keys.length === 0) {
            return failFn(
                `${where} задан, но не содержит ни одного скрипта. Пустая секция выглядит ` +
                    `настроенной, а работает как отсутствующая (в профиле — как наследование пути из ` +
                    `"common"): убери её либо задай путь — ${CONSUMER_SCRIPT_KEYS.join(' и/или ')}. ` +
                    `Выключить унаследованный скрипт — значением null.`,
            );
        }
        for (const key of keys) {
            if (!(CONSUMER_SCRIPT_KEYS as readonly string[]).includes(key)) {
                return failFn(
                    `${where}.${key} — незнакомый ключ. Известные: ${CONSUMER_SCRIPT_KEYS.join(', ')}. ` +
                        `Опечатка в имени ключа тихо выключила бы скрипт: ядро сказало бы «выключен, ключа нет», ` +
                        `а ключ в файле есть.`,
                );
            }
            const value = section[key];
            if (value === null) continue; // явное «выключено» — законная запись
            if (typeof value !== 'string' || value.trim() === '') {
                return failFn(
                    `${where}.${key} = ${JSON.stringify(value)} — ожидался непустой путь к скрипту ` +
                        `либо null (выключено). Вызов fail-open: мусор здесь означал бы «скрипт молча не ` +
                        `отработал», а не отказ.`,
                );
            }
            if (value !== value.trim()) {
                return failFn(
                    `${where}.${key} = ${JSON.stringify(value)} — путь с пробелом по краям. ` +
                        `Исполняется значение как есть, и такой путь падает ENOENT в рантайме, ` +
                        `где отказ уже fail-open (одна строка в логе).`,
                );
            }
            if (value.startsWith('-')) {
                return failFn(
                    `${where}.${key} = ${JSON.stringify(value)} — путь начинается с дефиса. ` +
                        `Ядро зовёт скрипт как \`node <путь>\`, и всё, что начинается с дефиса, node разбирает ` +
                        `как СВОЮ опцию (\`--eval\` и подобные) — исполнилось бы не то, что задумано.`,
                );
            }
        }
        return true;
    }

    /**
     * Итоговая секция скриптов потребителя: форма (см. checkConsumerScriptsShape), привязка
     * к площадке и резолв путей от известного корня.
     *
     * Возвращает РЕЗОЛВНУТЫЕ пути отдельным полем — по образцу `rootsResolved`: `consumerScripts`
     * остаётся тем, что написано в файле, а исполняется резолвнутое. Относительный путь — это
     * «от места запуска», а место запуска у петли меняется (chdir в worktree фазы), поэтому
     * при заданной раскладке корней путь якорится к `consumerRoot`: скрипт принадлежит дереву
     * потребителя и обязан находиться там же независимо от того, в каком дереве идёт работа.
     * Раскладки нет (старая, «всё в каталоге ядра») — путь остаётся относительным, как раньше;
     * это умолчание сказано вслух, а не подобрано.
     */
    function assertValidConsumerScripts(
        cfg: Record<string, unknown>,
        profileName: string,
        failFn: FailFn = fail,
        consumerRoot: string | null = null,
    ): unknown {
        const raw = cfg.consumerScripts;
        if (raw === undefined) return { consumerScriptsResolved: null };
        const where = `ralph.config.json (профиль "${profileName}"): consumerScripts`;
        const shapeOk = checkConsumerScriptsShape(raw, where, failFn);
        if (shapeOk !== true) return shapeOk;
        const section = raw as Record<string, unknown>;

        // Привязка к площадке: синк доски зовёт ТОЛЬКО тот taskSource, у которого доска —
        // отдельная сущность. Там, где доска — проекция статуса issue, `syncBoard` осознанный
        // no-op, и заданный `projectSync` не позвался бы никогда: ключ в файле есть, скрипт
        // не зовётся, лог молчит — ровно тот отказ, ради которого отвергается опечатка в
        // имени ключа. Реестр закрыт списком: новый адаптер, которому синк нужен, дописывает
        // себя сюда — и это видно в диффе.
        const adapters = cfg.adapters;
        // `adapters` не объектом — отдельный отказ (третий проход ревью !21): `null`, число
        // и массив прошли бы дальше как «швов нет», `taskSource` стал бы дефолтным, и
        // `projectSync` проехал бы ровно ту проверку, ради которой всё это писалось.
        // resolveAdapterSelection такую форму тоже не ловит: `adapters ?? {}` + Object.keys.
        if (adapters !== undefined && !isPlainObject(adapters)) {
            return failFn(
                `ralph.config.json (профиль "${profileName}"): adapters = ${JSON.stringify(adapters)} — ` +
                    `ожидался объект { шов: "реализация" }.`,
            );
        }
        const rawTaskSource = isPlainObject(adapters) ? adapters.taskSource : undefined;
        // Нестроковое имя шва здесь НЕ проваливается в дефолт (второй проход ревью !21):
        // `"taskSource": 7` иначе молча читался бы как "github", и `projectSync` проехал бы
        // проверку — разрешительная ошибка там, где весь валидатор строг. Само имя (знакомо
        // ли оно реестру реализаций) проверяет resolveAdapterSelection позже: список имён
        // живёт у адаптеров, а не здесь.
        if (rawTaskSource !== undefined && typeof rawTaskSource !== 'string') {
            return failFn(
                `ralph.config.json (профиль "${profileName}"): adapters.taskSource = ` +
                    `${JSON.stringify(rawTaskSource)} — ожидалось имя реализации строкой.`,
            );
        }
        const taskSource = rawTaskSource ?? ADAPTER_DEFAULTS.taskSource;
        if (
            typeof section.projectSync === 'string' &&
            !(BOARD_SYNC_TASK_SOURCES as readonly string[]).includes(taskSource)
        ) {
            return failFn(
                `${where}.projectSync задан, но синк доски зовут только: ` +
                    `${BOARD_SYNC_TASK_SOURCES.join(', ')} — а трекер задан как "${taskSource}". ` +
                    `Там, где доска есть проекция статуса issue, syncBoard — осознанный no-op: скрипт не ` +
                    `позвался бы никогда, и лог об этом молчал бы. Убери ключ, задай null — либо проверь ` +
                    `само имя adapters.taskSource, если оно написано с опечаткой.`,
            );
        }

        const resolved: Record<string, string | null> = {};
        for (const key of CONSUMER_SCRIPT_KEYS) {
            const value = section[key];
            if (typeof value !== 'string') {
                resolved[key] = null; // ключа нет либо явное «выключено»
                continue;
            }
            resolved[key] = consumerRoot ? path.resolve(consumerRoot, value) : value;
        }
        return { consumerScriptsResolved: resolved };
    }

    function resolveProfile(
        raw: unknown,
        name: unknown,
        failFn: FailFn = fail,
        lockRootFn: TLockRootFn = productRootFromLock,
    ): unknown {
        if (!isPlainObject(raw)) return failFn('ralph.config.json: ожидался JSON-объект.');
        if (!isPlainObject(raw.common)) {
            return failFn('ralph.config.json: нет блока "common" — общие поля профилей.');
        }
        if (!isPlainObject(raw.profiles)) {
            return failFn('ralph.config.json: нет блока "profiles".');
        }

        const profiles = raw.profiles;
        const available = Object.keys(profiles);
        if (!available.length) return failFn('ralph.config.json: "profiles" пуст.');

        // name (флаг --profile, #72) важнее defaultProfile; нет ни того ни другого — стоп.
        const wanted = (name ?? raw.defaultProfile) as string | undefined;
        if (!wanted) {
            return failFn(
                `ralph.config.json: профиль не задан и нет "defaultProfile". Доступны: ${available.join(', ')}.`,
            );
        }
        if (!Object.prototype.hasOwnProperty.call(profiles, wanted)) {
            return failFn(`Неизвестный профиль "${wanted}". Доступны: ${available.join(', ')}.`);
        }
        if (!isPlainObject(profiles[wanted])) {
            return failFn(`ralph.config.json: профиль "${wanted}" — не объект.`);
        }

        // profileName в итоговом конфиге: раннеру и логам нужно знать режим, а исходный
        // raw после резолва никто не таскает.
        // Канон, задача 23 (ревью !21): секция скриптов проверяется и в СЫРЫХ блоках, до
        // мерджа. Пустая секция в профиле мерджем растворяется — на итоговом конфиге её уже
        // не видно, а человек, написавший `"consumerScripts": {}` в playground, считает
        // скрипты выключенными, тогда как они унаследовались из `common`.
        const commonShapeOk = checkConsumerScriptsShape(
            raw.common.consumerScripts,
            'ralph.config.json (common): consumerScripts',
            failFn,
        );
        if (commonShapeOk !== true) return commonShapeOk; // мягкий failFn — наверх как есть
        const profileShapeOk = checkConsumerScriptsShape(
            (profiles[wanted] as Record<string, unknown>).consumerScripts,
            `ralph.config.json (профиль "${wanted}"): consumerScripts`,
            failFn,
        );
        if (profileShapeOk !== true) return profileShapeOk; // мягкий failFn — наверх как есть

        const merged = deepMerge(
            raw.common,
            profiles[wanted] as Record<string, unknown>,
            failFn,
            'common',
            wanted,
        );
        if (!isPlainObject(merged)) return merged; // мягкий failFn — наверх как есть
        // #223: модели ревью (review.default/escalated) обязаны быть известны планке #217.
        // Незнакомая модель, поставившая блок, получила бы rank -1 и проиграла ЛЮБОму
        // известному кандидату — планка инвертировалась бы (haiku судит блок сильнейшей).
        // Ловим на старте (fail-closed дешевле тихой инверсии), а не в момент разбора.
        const known = assertKnownReviewModels(merged, wanted, failFn);
        if (known !== true) return known; // мягкий failFn — наверх как есть
        // #249: haltBeforeDeploy обязан быть boolean и только в профиле prod (fail-closed,
        // иначе опечатка в типе тихо даёт halt-режим — см. assertValidHaltBeforeDeploy).
        const haltOk = assertValidHaltBeforeDeploy(merged, wanted, failFn);
        if (haltOk !== true) return haltOk; // мягкий failFn — наверх как есть
        // Канон, задача 33: permissionMode уходит в --permission-mode как есть — опечатка
        // тихо сменила бы режим прав сессии (см. assertValidPermissionMode).
        const permOk = assertValidPermissionMode(merged, wanted, failFn);
        if (permOk !== true) return permOk; // мягкий failFn — наверх как есть
        // #376: modelRouting провайдер-осведомлён — валидируем схему целиком (labels/
        // default/apiLimitFallback/healEscalation) до того, как раннер начнёт резолвить
        // провайдера по label'ам issue.
        const routingOk = assertValidModelRouting(merged, wanted, failFn);
        if (routingOk !== true) return routingOk; // мягкий failFn — наверх как есть
        // #16: адрес карточек лестницы — схема обоих ключей (fail-closed: заданный мусор
        // валит старт, а не превращается в тихое «адреса нет»).
        const backlogOk = assertValidReviewBacklog(merged, wanted, failFn);
        if (backlogOk !== true) return backlogOk; // мягкий failFn — наверх как есть
        // #48: плейсхолдеры промпта — последняя проверка схемы: она про содержимое, а не
        // про форму, и осмысленна только на уже слитом конфиге.
        const promptOk = assertValidPromptPlaceholders(merged, wanted, failFn);
        if (promptOk !== true) return promptOk; // мягкий failFn — наверх как есть
        // Канон, задача 21: раскладка корней. Последней в ряду — она про место на диске,
        // и осмысленна только когда остальная схема уже признана целой.
        const rootsOk = assertValidRoots(merged, wanted, failFn, lockRootFn);
        if (!isPlainObject(rootsOk) || !('rootsResolved' in rootsOk)) return rootsOk; // мягкий failFn
        const roots = rootsOk.rootsResolved as { consumerRoot?: string } | null;
        // Канон, задача 23: скрипты потребителя — ПОСЛЕ корней: их пути якорятся к
        // `consumerRoot`, и до резолва раскладки якорить не к чему.
        const scriptsOk = assertValidConsumerScripts(
            merged,
            wanted,
            failFn,
            roots?.consumerRoot ?? null,
        );
        if (!isPlainObject(scriptsOk) || !('consumerScriptsResolved' in scriptsOk)) {
            return scriptsOk; // мягкий failFn — наверх как есть
        }
        return {
            ...merged,
            profileName: wanted,
            rootsResolved: rootsOk.rootsResolved,
            productRootFrom: rootsOk.productRootFrom,
            consumerScriptsResolved: scriptsOk.consumerScriptsResolved,
        };
    }

    return {
        deepMerge,
        parseProfileFlag,
        assertValidHaltBeforeDeploy,
        assertValidPermissionMode,
        assertValidModelRouting,
        assertValidPromptPlaceholders,
        assertValidReviewBacklog,
        assertValidConsumerScripts,
        assertValidRoots,
        resolveProfile,
    };
}
