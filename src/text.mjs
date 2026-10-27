// Крошечная библиотека строк — предмет демо. Задачи для петли лежат в `cards/`: каждая
// добавляет сюда одну функцию с тестом, и гейт из двух детерминированных команд
// (`npm run syntax`, `npm test`) решает, мерджить ли результат.

/**
 * Строка в slug: нижний регистр, всё, кроме латиницы и цифр, — в дефис, без дефисов по
 * краям.
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Обрезает строку до `max` символов (Unicode code points, а не UTF-16 единиц, поэтому
 * эмодзи не разрезается); обрезанный текст заканчивается на `…`, и вместе с ним длина
 * ровно `max`.
 * @param {string} text
 * @param {number} max максимальная длина результата, целое не меньше 1
 * @returns {string}
 * @throws {RangeError} если `max` не целое или меньше 1
 */
export function truncate(text, max) {
    if (!Number.isInteger(max) || max < 1) {
        throw new RangeError(`max must be an integer >= 1, got ${max}`);
    }
    const chars = Array.from(text);
    if (chars.length <= max) {
        return text;
    }
    return chars.slice(0, max - 1).join('') + '…';
}

/** Слово — непустой отрезок между пробельными символами; общее определение для всего модуля. */
const WORD = /\S+/g;

/**
 * Слова строки в порядке следования; для пустой строки и строки без слов — пустой массив.
 * Каждое слово непустое — на этом держится `codePointAt(0)` в `initials`.
 * @param {string} text
 * @returns {string[]}
 */
function words(text) {
    return text.match(WORD) ?? [];
}

/**
 * Число слов в строке: слово — непустой отрезок между пробельными символами.
 * @param {string} text
 * @returns {number}
 */
export function wordCount(text) {
    return words(text).length;
}

/**
 * Первая кодовая точка строки в верхнем регистре, остальное без изменений.
 * @param {string} text
 * @returns {string}
 */
function upperFirst(text) {
    return text.replace(/^./u, (first) => first.toUpperCase());
}

/**
 * Первый символ каждого слова — заглавный, остальные — строчные; слово — непустой отрезок
 * между пробельными символами, сами пробельные символы сохраняются как есть.
 * Первый символ — это первая кодовая точка слова, а не первая буква: у слова с ведущей
 * пунктуацией (`(hello)`, `«мир»`) регистр не меняется, дефис слов не разделяет.
 * Регистр — `toUpperCase`/`toLowerCase` без учёта локали (`istanbul` → `Istanbul`), а не
 * titlecase Unicode: `ß` даёт `SS`, `ǆ` — `Ǆ` (не `ǅ`), поэтому длина строки может
 * измениться.
 * @param {string} text
 * @returns {string}
 */
export function titleCase(text) {
    return text.replace(WORD, (word) => upperFirst(word.toLowerCase()));
}

/**
 * Пуста ли строка: `true` для пустой строки или строки только из пробельных символов
 * класса `\s` (например, пробел, табуляция, `\r`, `\n`, неразрывный пробел U+00A0,
 * U+2028/2029, U+3000, а также BOM U+FEFF), иначе `false`. Zero-width space U+200B в `\s`
 * не входит: `isBlank('\u200b')` → `false`.
 * @param {string} text
 * @returns {boolean}
 * @throws {TypeError} если `text` не строка (остальные функции модуля тип не проверяют)
 */
export function isBlank(text) {
    if (typeof text !== 'string') {
        throw new TypeError(`text must be a string, got ${typeof text}`);
    }
    return !/\S/.test(text);
}

/**
 * Первые символы слов в верхнем регистре, без разделителей; слово — непустой отрезок между
 * пробельными символами.
 * Первый символ — это первая кодовая точка слова, а не первая буква: у слова с ведущей
 * пунктуацией или цифрой берётся она сама (`initials('(ada) «мир»')` → `'(«'`). Символ вне
 * BMP не разрезается. Регистр — `toUpperCase` без учёта локали, поэтому символ может дать
 * несколько (`ß` → `SS`: `initials('ßa b')` → `'SSB'`); комбинируемые знаки после первой
 * кодовой точки теряются (`'e\u0301cole'` → `'E'`).
 * @param {string} text
 * @returns {string}
 */
export function initials(text) {
    return words(text)
        .map((word) => String.fromCodePoint(word.codePointAt(0)).toUpperCase())
        .join('');
}

/**
 * Слова в обратном порядке через один пробел; слово — непустой отрезок между пробельными
 * символами, пробельные символы по краям и между словами не сохраняются.
 * @param {string} text
 * @returns {string}
 */
export function reverseWords(text) {
    return words(text).reverse().join(' ');
}

/**
 * Первый символ строки — заглавный, остальное без изменений; для пустой строки — пустая.
 * Первый символ — это первая кодовая точка, а не первая буква: у строки с ведущей
 * пунктуацией или цифрой регистр не меняется. Регистр — `toUpperCase` без учёта локали,
 * поэтому длина может измениться (`ß` → `SS`). Ведущий пробел — тоже первая кодовая
 * точка: `capitalize(' abc')` → `' abc'` (в отличие от `titleCase`, где слово начинается
 * с непробельного символа).
 * @param {string} text
 * @returns {string}
 */
export function capitalize(text) {
    return upperFirst(text);
}

/**
 * Схлопывает подряд идущие пробельные символы в один пробел и обрезает края.
 * Пробельным считается всё, что матчит `\s` (включая NBSP, табы и переводы строк), —
 * то же определение, что у `words`; U+200B пробелом не считается.
 * @param {string} text
 * @returns {string} строка без ведущих и хвостовых пробелов; для пустой — пустая.
 */
export function squeeze(text) {
    return words(text).join(' ');
}

/**
 * Число гласных латиницы (`aeiou`) и кириллицы (`аеёиоуыэюя`) без учёта регистра;
 * `y` и `й` гласными не считаются. Перед подсчётом строка приводится к NFC, поэтому
 * разложенные формы считаются как составные (`'и\u0306'` = `й` → 0, `'e\u0301'` = `é` → 0).
 * Регистры перечислены явно, без флага `i`, чтобы case folding не добавлял символов.
 * @param {string} text
 * @returns {number}
 */
export function countVowels(text) {
    return (text.normalize('NFC').match(/[aeiouAEIOUаеёиоуыэюяАЕЁИОУЫЭЮЯ]/g) ?? []).length;
}

/**
 * Равно ли первое слово строки `word` без учёта регистра; слово — непустой отрезок между
 * пробельными символами, ведущие пробелы пропускаются. Регистр — `toLowerCase` без учёта
 * локали. Для строки без слов — `false`.
 * @param {string} text
 * @param {string} word
 * @returns {boolean}
 */
export function startsWithWord(text, word) {
    const [first] = words(text);
    return first !== undefined && first.toLowerCase() === word.toLowerCase();
}
