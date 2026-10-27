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

/** Слово — непустой отрезок между пробельными символами (общее для `wordCount` и `titleCase`). */
const WORD = /\S+/g;

/**
 * Число слов в строке: слово — непустой отрезок между пробельными символами.
 * @param {string} text
 * @returns {number}
 */
export function wordCount(text) {
    return text.match(WORD)?.length ?? 0;
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
    return text.replace(WORD, (word) =>
        word.toLowerCase().replace(/^./u, (first) => first.toUpperCase()),
    );
}
