// #188 (Изоляция ralph · Фаза 4): ALLOWLIST-санация окружения чеков гейта.
//
// ЗАЧЕМ. Гейт мерджа гоняет чеки (build/lint/test/…) и `npm ci` в дереве раннера, а
// у раннера в окружении лежат секреты петли (GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN,
// RALPH_TG_BOT_TOKEN — инвариант 11 CLAUDE.md). Любой из этих процессов — код из
// проверяемого PR: тест/скрипт сборки видит `process.env` и может утащить секрет
// (класс #209). Санация отрезает секреты от env дочерних процессов чеков.
//
// ПОЧЕМУ ALLOWLIST, А НЕ BLOCKLIST. Blocklist («вычесть GH_TOKEN, CLAUDE_…») молча
// пропустит СЛЕДУЮЩИЙ секрет — новую переменную, про которую забыли. Allowlist
// перечисляет то, что чекам НУЖНО; всё остальное (включая ещё не придуманные секреты)
// отсекается по умолчанию — fail-closed по духу инварианта 1. Сам список лежит в
// репозитории (gate-env-allowlist.json), не в хардкоде: добавление переменной видно в
// диффе и попадает под эскалацию ревью (`.claude/ralph/**` в review.escalateOnPaths),
// а не растворяется в правке кода.
//
// ГРАНИЦЫ. Санация закрывает ТОЛЬКО env-канал. Файловый канал к тем же секретам
// (~/.config/gh/hosts.yml, ~/.claude/.credentials.json) остаётся открытым, пока в
// allowlist есть HOME, — это остаточный риск, а не песочница (#192). Здесь только
// чистые функции + загрузчик; точки перехвата (checksGreen, installFn) подключает #189.
//
// ── Почему .mts (а не .js/.ts), и почему import.meta.dirname (#403) ──
// Оболочка раннера переводится на TypeScript. Здесь
// перевод упирается в модуль-специфику: TS-модуль под нативным type stripping Node
// исполняется как ESM, где `__dirname` не существует. tsconfig ралфа — `module: nodenext`
// без `"type":"module"` в package.json, поэтому обычный `.ts` TS компилит в CommonJS-режим,
// и там `import.meta` — жёсткая ошибка TS1470 (см. core-purity.test.ts), а вариант с
// `module.exports`/`require`+`__dirname` прячет экспорты от типизированного `.test.mts`
// (для TS такой файл — script без модульных экспортов). Оба тупика снимает ровно `.mts`:
// это ЯВНО-ESM и для TS (import.meta.dirname легален), и для рантайма (модуль грузится
// как ESM, import.meta.dirname = каталог, ОТКУДА ЗАГРУЖЕН модуль). ralph.js берёт его
// через require(esm) (Node 24), провенанс сохранён побайтово.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Список — рядом с модулем, в репозитории (не в env-файле секретов и не в коде).
//
// ПРОВЕНАНС (ревью #247, #403). `import.meta.dirname` — каталог, ОТКУДА ЗАГРУЖЕН модуль,
// то есть launch-дерево человека (`node .claude/ralph/ralph.js` из корня проекта, см.
// RUNBOOK), а НЕ worktree раннера, детаченный на origin/main. Семантика та же, что была у
// `__dirname` до перевода в .mts, но у неё другая модель деплоя, чем у ralph.config.json
// (тот читается по относительному пути ПОСЛЕ process.chdir(worktreePath) — то есть из
// origin/main, подхватывается сам):
//   • Смердженная правка allowlist НЕ действует, пока в launch-дереве не сделан `git pull`
//     (в отличие от ralph.config.json). Порядок деплоя правок списка — в RUNBOOK.
//   • Локальная незакоммиченная правка списка в launch-дереве действует сразу — но именно
//     потому список читается НЕ из cwd, код проверяемого PR не может подменить его на
//     детаче PR-головы (частичное смягчение класса #209; сам скрипт канарейки и npm-скрипты
//     при этом остаются кодом PR). Ради этого свойства чтение оставлено на каталоге модуля
//     (import.meta.dirname), а не переведено на cwd/путь от конфига — это молча сняло бы
//     барьер провенанса.
export const DEFAULT_ALLOWLIST_PATH = join(import.meta.dirname, 'gate-env-allowlist.json');

// Ключи, которыми объект-env мог бы отравить прототип, если строить его обычным `{}`.
// Санируемый env приходит извне (в т.ч. из окружения, куда переменную мог подложить
// код PR) — переменная с именем `__proto__`/`constructor` не должна менять прототип
// результата. Результат строим через Object.create(null), а такие имена отбрасываем.
export const UNSAFE_ENV_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Рабочая форма allowlist после нормализации: точные имена — в Set (O(1) lookup),
// префиксы — массив (проверяются startsWith). Типы TS стираются в рантайме, поэтому
// форму всё равно валидирует normalizeAllowlist на живых данных с диска.
export type GateEnvAllowlist = { exact: Set<string>; prefixes: string[] };

// Приводит распарсенный JSON к рабочей форме и валидирует его fail-closed: кривой
// allowlist — это стоп, а не «пустой список» (пустой отрезал бы PATH и покрасил бы гейт
// инфраструктурной ошибкой, а не отсутствием секретов). Возвращает { exact:Set, prefixes:[] }.
export function normalizeAllowlist(parsed: unknown, source = '<inline>'): GateEnvAllowlist {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error(
            `gate-env allowlist (${source}): ожидается объект с полями "exact" и "prefixes"`,
        );
    const { exact, prefixes } = parsed as { exact?: unknown; prefixes?: unknown };
    if (!Array.isArray(exact) || !Array.isArray(prefixes))
        throw new Error(
            `gate-env allowlist (${source}): поля "exact" и "prefixes" обязаны быть массивами`,
        );
    const check = (arr: unknown[], field: string): void => {
        for (const v of arr) {
            if (typeof v !== 'string' || v.length === 0)
                throw new Error(
                    `gate-env allowlist (${source}): в "${field}" допустимы только непустые строки, встретилось ${JSON.stringify(v)}`,
                );
        }
    };
    check(exact, 'exact');
    check(prefixes, 'prefixes');
    // Пустой exact — форма корректна (проверять нечего), но это ровно тот «пустой список»,
    // что докблок называет недопустимым: чеки не получат ни PATH, ни HOME и упадут невнятным
    // "command not found" вместо честного сообщения санации, а fail-closed-ветка checksGreen
    // не сработает. Усечённый/обнулённый файл должен давать тот же стоп, что и битый JSON.
    if (exact.length === 0)
        throw new Error(
            `gate-env allowlist (${source}): "exact" не может быть пустым — без PATH/HOME чеки не запустятся; ` +
                `усечённый allowlist — это стоп (fail-closed), а не «пустой список»`,
        );
    return { exact: new Set(exact as string[]), prefixes: [...(prefixes as string[])] };
}

// Читает allowlist из файла репозитория. readFileFn инжектируется для тестов; в проде —
// fs.readFileSync. Нечитаемый/непарсящийся файл → бросок (fail-closed): без списка
// санировать нельзя, а «санировать всем дефолтом» вернуло бы секреты в env.
export function loadGateEnvAllowlist(
    filePath: string = DEFAULT_ALLOWLIST_PATH,
    readFileFn: (path: string, encoding: 'utf8') => string = readFileSync,
): GateEnvAllowlist {
    let raw: string;
    try {
        raw = readFileFn(filePath, 'utf8');
    } catch (e) {
        throw new Error(
            `gate-env allowlist не читается (${filePath}): ${(e as Error).message} — санация fail-closed, чеки без allowlist не запускаем`,
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new Error(
            `gate-env allowlist не парсится как JSON (${filePath}): ${(e as Error).message}`,
        );
    }
    return normalizeAllowlist(parsed, filePath);
}

// Переменная разрешена, если она в exact ЛИБО начинается с одного из prefixes
// (семейства вроде LC_*). Пустой prefix запрещён валидацией — иначе пропускал бы всё.
export function isAllowed(name: string, allowlist: GateEnvAllowlist): boolean {
    if (allowlist.exact.has(name)) return true;
    return allowlist.prefixes.some((p) => name.startsWith(p));
}

// Возвращает НОВЫЙ env, где остались только разрешённые переменные. Исходный объект не
// мутируется. Результат — Object.create(null): у него нет унаследованных ключей и его
// нельзя отравить именем `__proto__` из входного env (см. UNSAFE_ENV_KEYS).
export function sanitizeEnv(
    env: Record<string, string | undefined>,
    allowlist: GateEnvAllowlist,
): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = Object.create(null);
    for (const key of Object.keys(env)) {
        if (UNSAFE_ENV_KEYS.has(key)) continue;
        if (isAllowed(key, allowlist)) out[key] = env[key];
    }
    return out;
}

// Удобная обёртка для точек перехвата (#189): загрузить allowlist и сразу санировать env.
// Дефолты — боевые (файл рядом, process.env), в тестах подменяются.
export function buildSanitizedGateEnv({
    env = process.env,
    allowlistPath = DEFAULT_ALLOWLIST_PATH,
    readFileFn = readFileSync,
}: {
    env?: Record<string, string | undefined>;
    allowlistPath?: string;
    readFileFn?: (path: string, encoding: 'utf8') => string;
} = {}): Record<string, string | undefined> {
    return sanitizeEnv(env, loadGateEnvAllowlist(allowlistPath, readFileFn));
}
