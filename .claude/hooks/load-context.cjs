#!/usr/bin/env node
/**
 * SessionStart hook — load handoff context + git state at session start.
 *
 * Reads:
 *   - .claude/local/HANDOFF.md (если есть) — локальный, под .gitignore: handoff пишется
 *     с путями машины и именами потребителей, а репозиторий публичный. Прежний
 *     `.claude/state/HANDOFF.md` лежал в git и потому был вынужденно обезличен до
 *     бесполезности — следующей сессии он не говорил, где и над чем идёт работа.
 *   - git status --short
 *   - git log --oneline -5
 *
 * Writes to stdout, which Claude Code prepends to the session context.
 *
 * Cross-platform: only Node API + execSync с git commands.
 * Never throws — exit 0 always.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

function readHandoff() {
    const handoffPath = path.join('.claude', 'local', 'HANDOFF.md');
    try {
        if (fs.existsSync(handoffPath)) {
            return fs.readFileSync(handoffPath, 'utf-8').trim();
        }
        return null;
    } catch {
        return null;
    }
}

function gitOutput(args) {
    try {
        return execSync(`git ${args}`, {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return null;
    }
}

function main() {
    const out = [];

    // 1. Handoff context
    out.push('## Контекст прошлой сессии');
    out.push('');
    const handoff = readHandoff();
    if (handoff) {
        out.push(handoff);
    } else {
        out.push('(handoff отсутствует — первая сессия)');
    }
    out.push('');

    // 2. Git state
    out.push('## Git');
    out.push('');

    const status = gitOutput('status --short');
    if (status !== null) {
        out.push('### Status');
        out.push('```');
        out.push(status.length > 0 ? status : '(working tree clean)');
        out.push('```');
        out.push('');
    }

    const log = gitOutput('log --oneline -5');
    if (log !== null) {
        out.push('### Last 5 commits');
        out.push('```');
        out.push(log);
        out.push('```');
        out.push('');
    }

    if (status === null && log === null) {
        out.push('(не git-репо или git недоступен)');
    }

    process.stdout.write(out.join('\n'));
}

try {
    main();
} catch (e) {
    // Never throw — fail silently, just log to stderr
    process.stderr.write(`[load-context hook error] ${e.message}\n`);
}

process.exit(0);
