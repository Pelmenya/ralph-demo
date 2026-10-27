---
title: 'reverseWords: слова в обратном порядке'
milestone: 'Демо · Фаза 3: Слова'
labels: [complexity:low, area:lib]
---

## Зачем

Нужна функция, разворачивающая порядок слов.

## Что сделать

- В `src/text.mjs` добавить `reverseWords(text)`: слова в обратном порядке через один пробел; слово — как в `wordCount`.

## Критерии готовности

- [ ] `reverseWords('')` → `''`, `reverseWords('  a\tb  c ')` → `'c b a'`.
- [ ] Буквы внутри слова не переворачиваются.
- [ ] Тесты в `test/text.test.mjs`, гейт (`npm run syntax`, `npm test`) зелёный.
