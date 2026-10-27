#!/usr/bin/env node
//
// Печатает путь дерева раннера для заданного профиля — ТЕМ ЖЕ резолвом, которым
// пользуется сам раннер (`createWorktreeManager().resolveWorktreePath`), а не второй
// копией правила. Копия уже разъезжалась бы на первом же шаге: у раннера приоритет
// `cfg.runnerWorktreePath` ВАЖНЕЕ env `RALPH_WORKTREE_PATH` (core/worktree.ts), есть
// `cfg.runnerWorktreeDirname`, а относительный путь резолвится от корня репозитория.
// Скрипту `start-tmux.sh` этот путь нужен, чтобы дождаться дерева перед стартом
// панели монитора — угаданный путь означал бы вечное ожидание и пустую панель.
//
// ЗАПУСК: node resolve-worktree-path.mts <профиль> <корень-репо>
//
// Явно-ESM `.mts` (как gate-env.mts, #403): исполняется нативным type stripping Node 24,
// без билд-шага; синтаксис erasable-only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createConfigProfile } from '../core/config-profile.ts';
import { createWorktreeManager } from '../core/worktree.ts';
import type { WorktreeEnv } from '../core/worktree.ts';

const [profile, repoRoot] = process.argv.slice(2);
if (!profile || !repoRoot) {
    console.error('usage: node resolve-worktree-path.mts <профиль> <корень-репо>');
    process.exit(1);
}

const configPath = fileURLToPath(new URL('../ralph.config.json', import.meta.url));

// Стабы вместо контекста раннера: `resolveWorktreePath` — чистая функция от cfg и
// repoRoot, ни один из коллабораторов фабрики ей не нужен. Стабы БРОСАЮТ, а не молчат:
// если резолв когда-нибудь начнёт дёргать git или писать в лог, это увидят сразу, а не
// в виде тихо неверного пути.
function unexpected(name: string): never {
    throw new Error(
        `resolve-worktree-path: неожиданный вызов ${name} — резолв пути перестал быть чистым`,
    );
}
const stubEnv: WorktreeEnv = {
    sh: () => unexpected('sh'),
    shArgv: () => unexpected('shArgv'),
    shq: () => unexpected('shq'),
    log: () => unexpected('log'),
    fail: () => unexpected('fail'),
    guardSideEffect: () => unexpected('guardSideEffect'),
    buildSanitizedGateEnv: () => unexpected('buildSanitizedGateEnv'),
    writeLockMarker: () => unexpected('writeLockMarker'),
    getInstallCmd: () => unexpected('getInstallCmd'),
};

// Профиль резолвится настоящим resolveProfile (deepMerge common+profile), чтобы
// `runnerWorktreePath` из профиля не потерялся. assertKnownReviewModels здесь заглушён:
// он про модели ревью, к пути дерева отношения не имеет, а его отказ увёл бы вспомогательный
// резолвер в падение на конфиге, с которым раннер стартует нормально.
const { resolveProfile } = createConfigProfile({
    fail: (msg: string) => {
        throw new Error(msg);
    },
    assertKnownReviewModels: () => true,
});

const raw: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
const cfg = resolveProfile(raw, profile) as {
    runnerWorktreePath?: string;
    runnerWorktreeDirname?: string;
};
const { resolveWorktreePath } = createWorktreeManager(stubEnv);
console.log(resolveWorktreePath(cfg, repoRoot));
