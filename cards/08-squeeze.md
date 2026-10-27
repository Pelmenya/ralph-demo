---
title: 'squeeze: схлопывание пробельных символов'
milestone: 'Демо · Фаза 4: Символы'
labels: [complexity:low, area:lib]
---

## Зачем

Нужна функция, нормализующая пробелы.

## Что сделать

- В `src/text.mjs` добавить `squeeze(text)`: подряд идущие пробельные символы — один пробел, края обрезаны; пробельный — как в `wordCount`.

## Критерии готовности

- [ ] `squeeze('')` → `''`, `squeeze(' a \t\n b ')` → `'a b'`.
- [ ] NBSP — пробельный, U+200B — нет.
- [ ] Тесты в `test/text.test.mjs`, гейт (`npm run syntax`, `npm test`) зелёный.
