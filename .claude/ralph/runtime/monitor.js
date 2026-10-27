#!/usr/bin/env node
/*
 * Ralph monitor — ТОНКИЙ ENTRY панели прогресса AFK-цикла (#404, фаза 8).
 *
 * Вся логика (чтение лога, сводка, gh-запросы, детект тишины, дедуп пуша) живёт в
 * runtime/monitor-panel.mts и покрыта monitor-panel.test.mts. Здесь остаётся ровно то,
 * что обязано быть в JS-entry: проверка Node ≥24 ДО первого require('*.mts') и запуск
 * панели. Имя и место файла в ядре (`runtime/monitor.js`) НЕ меняются — на них опираются
 * RUNBOOK, tmux-раскладка и спавн монитора из core/orchestrator.ts (cmdline матчится по
 * 'monitor.js'). Раннер спавнит его по абсолютному пути от каталога ядра (задача 122), а
 * не `.claude/ralph/…` от места запуска: в раскладке с `roots` там дерево работы без ядра.
 *
 * ── Почему этот файл — JS, а не TS ──
 * Монитор запускают НАПРЯМУЮ: руками из tmux и detached-спавном из раннера. Такой файл
 * исполняется до того, как проверена версия Node, поэтому сам обязан быть исполним на
 * любой: на Node <24 первый же require('*.mts')/require('*.ts') упал бы криптичным
 * ERR_UNKNOWN_FILE_EXTENSION в глубине зависимостей вместо внятного отказа (fail-closed,
 * инвариант №1). Логика — в monitor-panel.mts, требуемом отсюда после проверки версии.
 *
 * Использование:
 *   node .claude/ralph/runtime/monitor.js              # цикл каждые 5 мин
 *   node .claude/ralph/runtime/monitor.js --once       # разовый снимок и выход
 *   node .claude/ralph/runtime/monitor.js --interval 60   # свой интервал (сек)
 *   node .claude/ralph/runtime/monitor.js --profile <name> --config <путь>  # как спавнит раннер
 *
 * Только чтение: gh-запросы + чтение файлов. Ничего не мутирует (инвариант №12).
 */

// node:url — встроенный модуль, его статический импорт проверку версии ниже не обходит.
import { pathToFileURL } from 'node:url';

// #232/#404: логика панели — в .mts-модуле, его исполняет нативный type stripping Node 24
// (проект стандартизует Node 24, engines в package.json это фиксирует). На Node <24
// первый же импорт '*.mts' упал бы криптичным ERR_UNKNOWN_FILE_EXTENSION в глубине
// зависимостей; отсекаем раньше внятным сообщением (fail-closed). Как в ralph.js: пишем в
// stderr и выходим напрямую — fail() ядра сюда ещё нельзя грузить.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 24) {
    console.error(
        `❌ Монитор требует Node >=24 (нативный type stripping для .mts-модуля панели), запущен на ${process.versions.node}.`,
    );
    process.exit(1);
}

// Динамический import, а не статический: статический поднялся бы выше проверки версии.
const { main } = await import('./monitor-panel.mts');

// Гейт «запущен напрямую» — как в ralph.js: панель стартует ТОЛЬКО при прямом
// `node monitor.js` (tmux/спавн раннера). При случайном импорте (глоб тест-раннера)
// выполнятся лишь объявления, но не побочки панели — gh-запросы и бесконечный
// setInterval. Стоит одну строку, снимает целый класс тихого запуска.
if (import.meta.url === (process.argv[1] ? pathToFileURL(process.argv[1]).href : null)) main();
