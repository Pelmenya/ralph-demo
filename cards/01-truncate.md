---
title: 'truncate: обрезка строки до длины с многоточием'
milestone: 'Демо · Фаза 1: Строки'
labels: [complexity:low, area:lib]
---

## Зачем

Длинные заголовки ломают вывод в одну строку. Нужна функция, которая обрезает текст до
заданной длины и показывает, что он обрезан.

## Что сделать

- В `src/text.mjs` добавить `truncate(text, max)`: строка не длиннее `max` возвращается
  как есть, длиннее — обрезается так, чтобы вместе с `…` длина была ровно `max`.
- `max` меньше 1 — `RangeError`.

## Критерии готовности

- [ ] `truncate('hello', 10)` → `'hello'`, `truncate('hello world', 6)` → `'hello…'`.
- [ ] `truncate('abc', 0)` бросает `RangeError`.
- [ ] Тесты в `test/text.test.mjs`, гейт (`npm run syntax`, `npm test`) зелёный.
