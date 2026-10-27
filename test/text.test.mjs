// Тесты на встроенном `node:test`: зависимостей у демо нет вовсе, поэтому гейту нечего
// ставить из сети, и его результат зависит только от кода в коммите.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    capitalize,
    countVowels,
    hasRepeatedWord,
    initials,
    isBlank,
    lastWord,
    repeatWord,
    reverseWords,
    slugify,
    squeeze,
    startsWithWord,
    titleCase,
    truncate,
    uniqueWords,
    wordCount,
} from '../src/text.mjs';

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

test('isBlank: zero-width space не пробел', () => {
    assert.equal(isBlank('\u200b'), false);
});

test('isBlank: не строка — TypeError', () => {
    assert.throws(() => isBlank(null), TypeError);
    assert.throws(() => isBlank(undefined), TypeError);
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

test('initials: символ вне BMP не разрезается', () => {
    assert.equal(initials('𐐨𐐨 x'), '𐐀X');
});

test('initials: ведущая пунктуация и цифра берутся как есть; одно слово', () => {
    assert.equal(initials('(ada) 1st'), '(1');
    assert.equal(initials('ada'), 'A');
});

test('initials: расширение регистра и потеря комбинируемого знака', () => {
    assert.equal(initials('ßa b'), 'SSB');
    assert.equal(initials('e\u0301cole'), 'E');
});

test('reverseWords: пустая строка', () => {
    assert.equal(reverseWords(''), '');
});

test('reverseWords: пробельные символы по краям и между словами не сохраняются', () => {
    assert.equal(reverseWords('  a\tb  c '), 'c b a');
});

test('reverseWords: одно слово и строка из пробелов', () => {
    assert.equal(reverseWords('one'), 'one');
    assert.equal(reverseWords('   '), '');
});

test('reverseWords: NBSP и \\r\\n разделяют слова, буквы внутри слова не переворачиваются', () => {
    assert.equal(reverseWords('a\u00a0b\r\nc'), 'c b a');
    assert.equal(reverseWords('ab cd'), 'cd ab');
});

test('capitalize: пустая строка', () => {
    assert.equal(capitalize(''), '');
});

test('capitalize: только первая буква, остальное без изменений', () => {
    assert.equal(capitalize('ёж ЁЖ'), 'Ёж ЁЖ');
});

test('capitalize: ведущая пунктуация и символ вне BMP не меняются и не разрезаются', () => {
    assert.equal(capitalize('(ada)'), '(ada)');
    assert.equal(capitalize('😀a'), '😀a');
});

test('capitalize: ß даёт SS, ведущая цифра и ведущий пробел не меняются', () => {
    assert.equal(capitalize('ßa'), 'SSa');
    assert.equal(capitalize('1st'), '1st');
    assert.equal(capitalize(' abc'), ' abc');
});

test('squeeze: пустая строка', () => {
    assert.equal(squeeze(''), '');
});

test('squeeze: подряд идущие пробельные символы — один пробел, края обрезаны', () => {
    assert.equal(squeeze(' a \t\n b '), 'a b');
    assert.equal(squeeze('a \r\n b'), 'a b');
});

test('squeeze: строка из одних пробелов — пустая', () => {
    assert.equal(squeeze(' \t\n '), '');
});

test('squeeze: NBSP и U+3000 — пробельные, U+200B — нет', () => {
    assert.equal(squeeze('a\u00a0\u3000b'), 'a b');
    assert.equal(squeeze('a\u200bb'), 'a\u200bb');
});

test('countVowels: пустая строка', () => {
    assert.equal(countVowels(''), 0);
});

test('countVowels: латиница и кириллица без учёта регистра', () => {
    assert.equal(countVowels('Hello, Мир'), 3);
    assert.equal(countVowels('AEIOU аеёиоуыэюя'), 15);
});

test('countVowels: согласные и цифры не считаются', () => {
    assert.equal(countVowels('rhythm 123 стр'), 0);
});

test('countVowels: заглавная кириллица, включая Ё', () => {
    assert.equal(countVowels('АЕЁИОУЫЭЮЯ'), 10);
});

test('countVowels: й не гласная, в том числе в разложенной форме', () => {
    assert.equal(countVowels('йЙ'), 0);
    assert.equal(countVowels('и\u0306'), 0);
    assert.equal(countVowels('e\u0301'), 0);
});

test('countVowels: case folding не добавляет гласных', () => {
    assert.equal(countVowels('\u1c82'), 0);
});

test('startsWithWord: пустая строка и строка без слов — false', () => {
    assert.equal(startsWithWord('', 'a'), false);
    assert.equal(startsWithWord('   ', 'a'), false);
});

test('startsWithWord: ведущие пробелы и регистр не важны', () => {
    assert.equal(startsWithWord('\t\n Hello', 'hello'), true);
    assert.equal(startsWithWord('\u00a0Hello', 'hello'), true);
    assert.equal(startsWithWord('  Hello world', 'hello'), true);
    assert.equal(startsWithWord('hello world', 'HELLO'), true);
});

test('startsWithWord: сравнивается только первое слово целиком', () => {
    assert.equal(startsWithWord('hello world', 'world'), false);
    assert.equal(startsWithWord('helloworld', 'hello'), false);
});

test('lastWord: пустая строка и строка без слов — пустая строка', () => {
    assert.equal(lastWord(''), '');
    assert.equal(lastWord(' \t\n'), '');
});

test('lastWord: последнее слово без краевых пробелов', () => {
    assert.equal(lastWord(' a b\t'), 'b');
    assert.equal(lastWord('single'), 'single');
});

test('startsWithWord: пунктуация — часть слова', () => {
    assert.equal(startsWithWord('hello, world', 'hello'), false);
    assert.equal(startsWithWord('hello, world', 'hello,'), true);
});

test('startsWithWord: не-латиница и NFC', () => {
    assert.equal(startsWithWord('Привет мир', 'ПРИВЕТ'), true);
    assert.equal(startsWithWord('e\u0301cole', '\u00e9cole'), true);
});

test('startsWithWord: не полноценный case folding', () => {
    assert.equal(startsWithWord('Straße x', 'STRASSE'), false);
});

test('startsWithWord: некорректный word — ошибка вызова независимо от text', () => {
    assert.throws(() => startsWithWord('x', undefined), TypeError);
    assert.throws(() => startsWithWord('', undefined), TypeError);
    assert.throws(() => startsWithWord('a', ''), RangeError);
    assert.throws(() => startsWithWord('hello world', 'hello world'), RangeError);
    assert.throws(() => startsWithWord('hello', ' hello'), RangeError);
});

test('lastWord: пунктуация, не-BMP и разные хвостовые пробелы', () => {
    assert.equal(lastWord('the end.'), 'end.');
    assert.equal(lastWord('hi 👋'), '👋');
    assert.equal(lastWord('a b\n'), 'b');
    assert.equal(lastWord('a b\u00a0'), 'b');
});

test('repeatWord: n <= 0 дают пустую строку', () => {
    assert.equal(repeatWord('a', 0), '');
    assert.equal(repeatWord('a', -2), '');
});

test('repeatWord: слово n раз через пробел', () => {
    assert.equal(repeatWord('ой', 3), 'ой ой ой');
    assert.equal(repeatWord('a', 1), 'a');
});

test('repeatWord: не целое n — RangeError', () => {
    for (const n of [0.5, 2.7, Infinity, -Infinity, NaN, 2 ** 32 + 0.5, '3', undefined]) {
        assert.throws(() => repeatWord('a', n), RangeError);
    }
});

test('repeatWord: огромное целое n — RangeError движка, а не зависание', () => {
    assert.throws(() => repeatWord('a', 2 ** 32), RangeError);
});

test('repeatWord: пустое слово и слово с пробелами — RangeError, не строка — TypeError', () => {
    assert.throws(() => repeatWord('', 3), RangeError);
    assert.throws(() => repeatWord('a b', 2), RangeError);
    assert.throws(() => repeatWord('a b', 2), RangeError);
    assert.throws(() => repeatWord(5, 2), TypeError);
});

test('uniqueWords: пустая строка и строка без слов', () => {
    assert.equal(uniqueWords(''), '');
    assert.equal(uniqueWords(' \n '), '');
});

test('uniqueWords: повторы убираются, порядок первого появления', () => {
    assert.equal(uniqueWords('a b a  c b'), 'a b c');
    assert.equal(uniqueWords('x x x'), 'x');
});

test('uniqueWords: регистр различается', () => {
    assert.equal(uniqueWords('A a'), 'A a');
    assert.equal(uniqueWords('The the'), 'The the');
});

test('uniqueWords: разные пробельные разделители, края не попадают в вывод', () => {
    assert.equal(uniqueWords('  a\tb\na b c  '), 'a b c');
});

test('uniqueWords: NFC-формы совпадают, выводится первое вхождение', () => {
    assert.equal(uniqueWords('café café'), 'café');
    assert.equal(uniqueWords('café café'), 'café');
});

test('uniqueWords: слова вне BMP', () => {
    assert.equal(uniqueWords('😀 a 😀'), '😀 a');
});

test('hasRepeatedWord: повтор подряд без учёта регистра', () => {
    assert.equal(hasRepeatedWord('the The cat'), true);
    assert.equal(hasRepeatedWord('Мир мир'), true);
});

test('hasRepeatedWord: неподряд и пустая строка — false', () => {
    assert.equal(hasRepeatedWord('a b a'), false);
    assert.equal(hasRepeatedWord(''), false);
});

test('hasRepeatedWord: повтор в конце строки', () => {
    assert.equal(hasRepeatedWord('a b c c'), true);
});

test('hasRepeatedWord: одно слово и строка из пробелов — false', () => {
    assert.equal(hasRepeatedWord('a'), false);
    assert.equal(hasRepeatedWord(' \t\n '), false);
});

test('hasRepeatedWord: разделители кроме пробела', () => {
    assert.equal(hasRepeatedWord('a\na'), true);
    assert.equal(hasRepeatedWord('a a'), true);
});

test('hasRepeatedWord: NFC-формы считаются одним словом', () => {
    assert.equal(hasRepeatedWord('café café'), true);
});

test('hasRepeatedWord: пунктуация — часть слова', () => {
    assert.equal(hasRepeatedWord('the, the'), false);
});
