---
title: 'isBlank: строка только из пробельных символов'
milestone: 'Демо · Фаза 3: Слова'
labels: [complexity:low, area:lib]
---

## Зачем

Для проверки полей ввода нужен предикат «пусто ли».

## Что сделать

- В `src/text.mjs` добавить `isBlank(text)`: `true` для пустой строки или строки только из пробельных символов (класс `\s`), иначе `false`.

## Критерии готовности

- [ ] `isBlank('')` → `true`, `isBlank(' \t\n ')` → `true`, `isBlank(' a ')` → `false`.
- [ ] Список пробельных символов в JSDoc не претендует на полноту; не-строка — `TypeError`.
- [ ] Тесты в `test/text.test.mjs`, гейт (`npm run syntax`, `npm test`) зелёный.
