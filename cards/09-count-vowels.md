---
title: 'countVowels: число гласных'
milestone: 'Демо · Фаза 4: Символы'
labels: [complexity:low, area:lib]
---

## Зачем

Нужна функция, считающая гласные.

## Что сделать

- В `src/text.mjs` добавить `countVowels(text)`: число гласных латиницы и кириллицы без учёта регистра; `y` и `й` не считаются.

## Критерии готовности

- [ ] `countVowels('')` → `0`, `countVowels('АЕЁИОУЫЭЮЯ')` → `10`.
- [ ] Результат не зависит от нормализации Unicode (NFC/NFD).
- [ ] Тесты в `test/text.test.mjs`, гейт (`npm run syntax`, `npm test`) зелёный.
