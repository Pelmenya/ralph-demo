#!/usr/bin/env node
/**
 * PostToolUse hook — пересобрать `AGENTS.md` после правки `CLAUDE.md`.
 *
 * Правила лежат под двумя именами (почему — в docs-sync.mts), и копию, собранную руками,
 * рано или поздно забывают пересобрать: правка уезжает в коммит, а половина агентов
 * продолжает читать вчерашнюю версию. Хук закрывает самый частый путь — правку файла
 * агентом прямо в сессии: `AGENTS.md` обновляется в том же ходе, без отдельной команды.
 *
 * Хук — НЕ барьер, и на него ничего не вешается: правка руками, другим инструментом или из
 * CI приезжает мимо него. Расхождение ловит сьют (`tests/docs-coverage.test.ts`) в составе
 * гейта; хук лишь избавляет от красного теста там, где чинить нечего.
 *
 * Cross-platform: только Node API. Никогда не бросает — exit 0 всегда: сорванная синхра
 * доков не повод ронять ход агента, её всё равно поймает гейт.
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');

function readStdin() {
    try {
        return require('node:fs').readFileSync(0, 'utf-8');
    } catch {
        return '';
    }
}

/**
 * Правку `CLAUDE.md` ищем по всему `tool_input`, а не по одному полю `file_path`: у разных
 * инструментов правки путь лежит по-разному, и лишний холостой запуск генератора (он
 * идемпотентен и молчит, когда всё совпадает) дешевле пропущенной правки.
 */
function touchesSource(payload) {
    try {
        return JSON.stringify(payload.tool_input ?? {}).includes('CLAUDE.md');
    } catch {
        return false;
    }
}

function main() {
    const raw = readStdin();
    if (!raw.trim()) return;

    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        return;
    }
    if (!touchesSource(payload)) return;

    let out;
    try {
        out = execFileSync('node', [path.join(PROJECT_DIR, 'docs-sync.mts')], {
            cwd: PROJECT_DIR,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    } catch (e) {
        process.stderr.write(`[sync-docs hook] генератор не отработал: ${e.message}\n`);
        return;
    }

    // Молчим, когда пересобирать было нечего: сообщение «всё совпадает» на каждой правке
    // любого файла — шум, из-за которого перестают читать и полезные строки.
    if (!out.startsWith('✅ пересобран')) return;

    process.stdout.write(
        JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                additionalContext: `${out} (парный AGENTS.md пересобран из CLAUDE.md — правь только CLAUDE.md)`,
            },
        }),
    );
}

try {
    main();
} catch (e) {
    process.stderr.write(`[sync-docs hook error] ${e.message}\n`);
}

process.exit(0);
