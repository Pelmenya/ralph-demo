// Тесты на встроенном `node:test`: зависимостей у демо нет вовсе, поэтому гейту нечего
// ставить из сети, и его результат зависит только от кода в коммите.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initials, isBlank, reverseWords, slugify, titleCase, truncate, wordCount } from '../src/text.mjs';

test('slugify: регистр и разделители', () => {
    assert.equal(slugify('Hello, World!'), 'hello-world');
});

test('slugify: дефисы по краям срезаются', () => {
    assert.equal(slugify('  --Ralph Demo--  '), 'ralph-demo');
});

test('slugify: пустая строка остаётся пустой', () => {
    assert.equal(slugify(''), '');
});

test('truncate: короткая строка возвращается как есть', () => {
    assert.equal(truncate('hello', 10), 'hello');
});

test('truncate: длинная строка обрезается до max вместе с многоточием', () => {
    assert.equal(truncate('hello world', 6), 'hello…');
});

test('truncate: max меньше 1 — RangeError', () => {
    assert.throws(() => truncate('abc', 0), RangeError);
});

test('truncate: длина ровно max — строка без изменений', () => {
    assert.equal(truncate('hello', 5), 'hello');
});

test('truncate: длина max + 1 — обрезка на один символ', () => {
    assert.equal(truncate('hello!', 5), 'hell…');
});

test('truncate: max равен 1 — только многоточие', () => {
    assert.equal(truncate('hello', 1), '…');
});

test('truncate: отрицательный, NaN, дробный и бесконечный max — RangeError', () => {
    for (const max of [-1, NaN, 1.5, Infinity]) {
        assert.throws(() => truncate('abc', max), RangeError);
    }
});

test('truncate: суррогатная пара не разрезается', () => {
    assert.equal(truncate('a😀bcd', 3), 'a😀…');
    assert.equal(truncate('😀😀', 2), '😀😀');
});

test('wordCount: пустая строка — 0', () => {
    assert.equal(wordCount(''), 0);
});

test('wordCount: пробелы, табуляции и переводы строк', () => {
    assert.equal(wordCount('  one  two\tthree\n'), 3);
});

test('wordCount: строка из одних пробелов — 0', () => {
    assert.equal(wordCount('   \t\n '), 0);
});

test('wordCount: одно слово', () => {
    assert.equal(wordCount('one'), 1);
});

test('wordCount: \\r\\n и неразрывный пробел разделяют слова', () => {
    assert.equal(wordCount('a\r\nb'), 2);
    assert.equal(wordCount('a\u00a0b'), 2);
});

test('titleCase: пустая строка остаётся пустой', () => {
    assert.equal(titleCase(''), '');
});

test('titleCase: первая буква заглавная, остальные строчные', () => {
    assert.equal(titleCase('hello WORLD'), 'Hello World');
});

test('titleCase: пробельные символы сохраняются как есть', () => {
    assert.equal(titleCase('  a\tb\n'), '  A\tB\n');
});

test('titleCase: символ вне BMP не разрезается', () => {
    assert.equal(titleCase('𐐨𐐨 x'), '𐐀𐐨 X');
});

test('titleCase: кириллица', () => {
    assert.equal(titleCase('привет МИР'), 'Привет Мир');
});

test('titleCase: греческая конечная сигма', () => {
    assert.equal(titleCase('ΟΣ'), 'Ος');
});

test('titleCase: идемпотентность и однобуквенные слова', () => {
    assert.equal(titleCase('A b C'), 'A B C');
    assert.equal(titleCase(titleCase('hello WORLD')), 'Hello World');
});

test('titleCase: ведущая пунктуация не меняется, цифра в начале слова', () => {
    assert.equal(titleCase('(HELLO) «мир»'), '(hello) «мир»');
    assert.equal(titleCase('1st PLACE'), '1st Place');
});

test('titleCase: \\r\\n, неразрывный пробел и одни пробелы', () => {
    assert.equal(titleCase('a\r\nb\u00a0c'), 'A\r\nB\u00a0C');
    assert.equal(titleCase('   '), '   ');
});

test('isBlank: пустая строка', () => {
    assert.equal(isBlank(''), true);
});

test('isBlank: только пробельные символы', () => {
    assert.equal(isBlank(' \t\n '), true);
    assert.equal(isBlank(' '), true);
});

test('isBlank: есть непробельный символ', () => {
    assert.equal(isBlank(' a '), false);
});

test('initials: пустая строка', () => {
    assert.equal(initials(''), '');
});

test('initials: несколько пробелов между словами', () => {
    assert.equal(initials('ada  lovelace'), 'AL');
});

test('initials: кириллица, табуляция и пробелы по краям', () => {
    assert.equal(initials(' ёлка\tиз леса '), 'ЁИЛ');
});

test('reverseWords: пустая строка', () => {
    assert.equal(reverseWords(''), '');
});

test('reverseWords: пробельные символы по краям и между словами не сохраняются', () => {
    assert.equal(reverseWords('  a\tb  c '), 'c b a');
});
