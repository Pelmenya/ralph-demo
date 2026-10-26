#!/usr/bin/env node
/**
 * PreToolUse hook — барьер «скилл загружен до первой правки» для сессий петли.
 *
 * Перенесён от потребителя, где родился из замера 22.09.2026: по 36 сессиям раннера таблица
 * «обязательно загрузить скилл» в проектном промпте читалась, инструмент `Skill` был
 * доступен, а вызовов — ноль. Правило без механизма — пожелание, поэтому здесь механизм:
 * правка файла, за который отвечает скилл, блокируется, пока в транскрипте ЭТОЙ сессии
 * нет вызова `Skill` с нужным именем.
 *
 * В каноне ряд один — тесты и `vitest` (скилл лежит в `.claude/skills/vitest`): канон —
 * библиотека на Node, и других типов файлов со своим скиллом у него нет. Новый ряд —
 * вместе со скиллом в том же PR, иначе барьер требовал бы то, чего нет.
 *
 * Input (stdin): JSON { tool_name, tool_input, transcript_path, session_id }.
 * Exit 2 + stderr — инструмент заблокирован, текст уходит агенту; exit 0 — разрешено.
 *
 * Три решения, без которых барьер молчал бы:
 *
 * 1. **Bash — тоже правка.** Сессии петли пишут файлы не только через `Edit`/`Write`, а
 *    heredoc'ом, `python3 -` и `sed -i` (у потребителя: 54 записи через Bash, ноль через
 *    `Edit` за одну сессию). Поэтому Bash-команда с путём целевого файла И признаком
 *    записи считается правкой.
 * 2. **Сессия петли узнаётся по транскрипту, а не по окружению.** Первое сообщение
 *    пользователя в сессии раннера — проектный промпт из конфига, и он отсылает к файлу
 *    контракта `ralph.md`: у потребителя — `.claude/ralph/ralph.md`, у канона — в корне.
 *    Обе формы узнаются одним правилом. В сессии человека барьер не вмешивается.
 *    Переключатель на случай проверки руками: `RALPH_SKILL_GUARD=on|off`.
 * 3. **Транскрипт назван, но не читается — блокировка, не пропуск**: барьер, отчитавшийся
 *    «нарушений нет», не заглянув в файл, — тот же тихий отказ. Транскрипт не назван
 *    вовсе — разрешено: без него сессию петли не отличить, а ложная блокировка сессии
 *    человека стоит дороже.
 *
 * Факт «скилл загружен» кэшируется маркером в tmpdir по `session_id`: транскрипт только
 * растёт, а барьер стоит на каждом вызове Bash.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXIT_BLOCKED = 2;
// Ссылка на файл контракта как на ПУТЬ: начало строки, пробел, слэш, кавычка или скобка
// перед именем. Так `.claude/ralph/ralph.md` и `ralph.md` узнаются, а `myralph.md` — нет.
const LOOP_PROMPT_RE = /(?:^|[\s/`'"(])ralph\.md\b/;

/** Что за файл → какой скилл обязан быть загружен до его правки. */
const RULES = [
    {
        test: (p) => /\.test\.m?tsx?$/.test(p),
        skills: ['vitest'],
        why: 'тест — моки, фикстуры и покрытие по скиллу vitest',
    },
];

/**
 * Ряды, которые узнаются по команде, а не по файлу. У потребителя здесь стоит коммит →
 * `git-commit`; у канона своего скилла коммита нет, поэтому список пуст, но механизм
 * остаётся — ряд приезжает вместе со скиллом.
 */
const COMMAND_RULES = [];

/** Признаки, по которым Bash-команда считается ЗАПИСЬЮ в файл, а не чтением. */
const WRITE_MARKERS = [
    /(^|[^<>])>{1,2}\s*["']?[^\s"'|;&]*\.[cm]?tsx?\b/, // `> file.tsx`, `>> file.ts`
    /\btee\b/,
    /\bsed\s+(-[a-zA-Z]*i|--in-place)/,
    /\bperl\s+-\S*i/,
    /write_text\(|\.write\(|open\([^)]*['"][wa]/, // python
    // node -e: запись через fs — та же правка, что heredoc (ревью Kimi).
    /\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\b/,
    /\bapply_patch\b|\bgit\s+apply\b|(^|\s)patch\s/,
    /\b(mv|cp)\s+[^|;&]*\.[cm]?tsx?\b/,
];

// Слэш в пути не обязателен: тест в корне репозитория (`gate-env.test.mts`) — такой же
// тест, и до ревью Kimi он правился без скилла.
const PATH_RE = /[\w@./-]+\.[cm]?tsx?\b/g;

/** Пути, которые правит вызов: у файловых инструментов — из полей, у Bash — из текста. */
function targetsOf(toolName, toolInput) {
    const input = toolInput || {};
    if (toolName === 'Bash') {
        const command = typeof input.command === 'string' ? input.command : '';
        if (!WRITE_MARKERS.some((re) => re.test(command))) return [];
        return [...new Set(command.match(PATH_RE) || [])];
    }
    const paths = [];
    for (const key of ['file_path', 'path', 'notebook_path']) {
        if (typeof input[key] === 'string') paths.push(input[key]);
    }
    if (Array.isArray(input.edits)) {
        for (const edit of input.edits) {
            if (edit && typeof edit.file_path === 'string') paths.push(edit.file_path);
        }
    }
    return paths;
}

/** Скиллы, обязательные для набора путей и команды, с причиной — для текста отказа. */
function requiredSkills(targets, command = '') {
    const required = new Map();
    const add = (rule, target) => {
        for (const skill of rule.skills) {
            if (!required.has(skill)) required.set(skill, { why: rule.why, target });
        }
    };
    for (const target of targets) {
        for (const rule of RULES) if (rule.test(target)) add(rule, target);
    }
    for (const rule of COMMAND_RULES) if (rule.test(command)) add(rule, 'команда');
    return required;
}

/** Команда вызова, если это Bash, — для рядов таблицы, узнаваемых по команде. */
function commandOf(toolName, toolInput) {
    const input = toolInput || {};
    return toolName === 'Bash' && typeof input.command === 'string' ? input.command : '';
}

/** Первое сообщение пользователя из транскрипта — строкой, как его прислал раннер. */
function firstUserPrompt(lines) {
    for (const line of lines) {
        if (!line.includes('"type":"user"')) continue;
        let record;
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }
        if (record.type !== 'user') continue;
        const content = record.message && record.message.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            const text = content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
            return text ? text.text : '';
        }
        return '';
    }
    return '';
}

function isLoopTranscript(lines, env = process.env) {
    if (env.RALPH_SKILL_GUARD === 'on') return true;
    if (env.RALPH_SKILL_GUARD === 'off') return false;
    return LOOP_PROMPT_RE.test(firstUserPrompt(lines));
}

/** Имена скиллов, вызванных инструментом `Skill` за сессию. */
function loadedSkills(lines) {
    const loaded = new Set();
    for (const line of lines) {
        if (!line.includes('"name":"Skill"')) continue;
        let record;
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }
        const content = record.message && record.message.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
            if (block && block.type === 'tool_use' && block.name === 'Skill') {
                const skill = block.input && block.input.skill;
                if (typeof skill === 'string') loaded.add(skill.replace(/^\//, ''));
            }
        }
    }
    return loaded;
}

function markerDir(sessionId) {
    return path.join(os.tmpdir(), 'ralph-skill-barrier', String(sessionId || 'no-session'));
}

/** Вердикт по вызову: {blocked, reason}. Чистая функция — транскрипт приходит строками. */
function decide({ toolName, toolInput, transcriptLines, env = process.env, cached = new Set() }) {
    const required = requiredSkills(targetsOf(toolName, toolInput), commandOf(toolName, toolInput));
    if (required.size === 0) return { blocked: false };
    if (transcriptLines === null) return { blocked: false }; // транскрипт не назван
    if (!isLoopTranscript(transcriptLines, env)) return { blocked: false };
    const missing = [...required].filter(([skill]) => !cached.has(skill));
    if (missing.length === 0) return { blocked: false, loaded: [...required.keys()] };
    const loaded = loadedSkills(transcriptLines);
    const stillMissing = missing.filter(([skill]) => !loaded.has(skill));
    if (stillMissing.length === 0) return { blocked: false, loaded: [...required.keys()] };
    const list = stillMissing
        .map(([skill, { why, target }]) => `  - Skill(${skill}) — ${why} (${target})`)
        .join('\n');
    return {
        blocked: true,
        reason:
            '[skill-barrier.cjs] Правка заблокирована: до первой правки этого файла в сессии ' +
            `обязан быть вызван инструмент Skill. Не хватает:\n${list}\n` +
            "Вызови Skill с этим именем (не читай файл скилла cat'ом — это не считается) " +
            'и повтори правку.',
    };
}

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (chunk) => (data += chunk));
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(''));
        setTimeout(() => resolve(data), 5000);
    });
}

function block(reason) {
    process.stderr.write(reason);
    process.exit(EXIT_BLOCKED);
}

async function main() {
    let input;
    try {
        input = JSON.parse((await readStdin()) || '{}');
    } catch (error) {
        block(`[skill-barrier.cjs] Вход не разобрался (${String(error)}) — вызов заблокирован.`);
    }
    const toolName = input.tool_name || '';
    const toolInput = input.tool_input || {};
    if (requiredSkills(targetsOf(toolName, toolInput), commandOf(toolName, toolInput)).size === 0)
        return;

    let transcriptLines = null;
    if (typeof input.transcript_path === 'string' && input.transcript_path !== '') {
        try {
            transcriptLines = fs.readFileSync(input.transcript_path, 'utf-8').split('\n');
        } catch (error) {
            block(
                `[skill-barrier.cjs] Транскрипт ${input.transcript_path} не читается ` +
                    `(${String(error)}) — судить о сессии нечем, вызов заблокирован fail-closed.`,
            );
        }
    }

    const dir = markerDir(input.session_id);
    const cached = new Set();
    try {
        for (const name of fs.readdirSync(dir)) cached.add(name);
    } catch {
        /* маркеров ещё нет */
    }
    const verdict = decide({ toolName, toolInput, transcriptLines, cached });
    if (verdict.blocked) block(verdict.reason);
    if (verdict.loaded) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            for (const skill of verdict.loaded) fs.writeFileSync(path.join(dir, skill), '');
        } catch {
            /* кэш — ускорение, не источник правды */
        }
    }
}

module.exports = {
    RULES,
    COMMAND_RULES,
    LOOP_PROMPT_RE,
    targetsOf,
    requiredSkills,
    firstUserPrompt,
    isLoopTranscript,
    loadedSkills,
    decide,
};

if (require.main === module) {
    main().then(
        () => process.exit(0),
        (error) => block(`[skill-barrier.cjs] Ошибка барьера: ${String(error)} — заблокировано.`),
    );
}
