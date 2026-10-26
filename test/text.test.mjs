// Тесты на встроенном `node:test`: зависимостей у демо нет вовсе, поэтому гейту нечего
// ставить из сети, и его результат зависит только от кода в коммите.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/text.mjs';

test('slugify: регистр и разделители', () => {
    assert.equal(slugify('Hello, World!'), 'hello-world');
});

test('slugify: дефисы по краям срезаются', () => {
    assert.equal(slugify('  --Ralph Demo--  '), 'ralph-demo');
});

test('slugify: пустая строка остаётся пустой', () => {
    assert.equal(slugify(''), '');
});
