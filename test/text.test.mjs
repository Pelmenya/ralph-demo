// Тесты на встроенном `node:test`: зависимостей у демо нет вовсе, поэтому гейту нечего
// ставить из сети, и его результат зависит только от кода в коммите.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, truncate, wordCount } from '../src/text.mjs';

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
