// Settings сессии петли собирает раннер из доверенных источников (Фаза 12, задача 101).
//
// Зачем. До этой задачи сессия брала хуки из `.claude/settings.json` того дерева, в котором
// работала, — то есть из ветки фазы, которую сама же и правит. Код под проверкой мог
// ослабить собственную проверку: поправить guard, снять matcher, положить в настройки
// `"disableAllHooks": true` (стенд Фазы 11, `docs/install-stand.md`: проектный выключатель
// снимает и внешний хук). Проба барьера при этом гонялась только перед первой сессией, и
// правка, легшая посреди фазы, жила до рестарта.
//
// Как. Перед КАЖДОЙ сессией раннер собирает файл и отдаёт его CLI флагом `--settings`:
//   • канонические PreToolUse-хуки (`CANON_SESSION_HOOKS`) — абсолютным путём в каталог
//     ядра, который исполняется сейчас (установленная ревизия), а не в дерево сессии;
//   • данные контура (`.claude/ralph/hooks.json`) — из дерева человека (`consumerRoot`):
//     путь уходит хуку переменной `RALPH_HOOKS_DATA` прямо в его команде;
//   • остальное — `.claude/settings.json` дерева человека как есть, со всеми его хуками:
//     собранный файл не теряет хуков потребителя (`SessionStart`, `PostToolUse`, свои
//     PreToolUse), он к ним добавляет;
//   • `"disableAllHooks": false` — настройки командной строки старше проектных, и
//     выключатель в дереве сессии внешний хук больше не снимает (решение стенда);
//   • контракт запуска `RALPH_CORE_SHA` — ревизия установки ядра (`resolveCoreSha`) — тоже
//     в команде канонического хука (#132): хук узнаёт петлю по нему и сверяет себя с этой
//     ревизией, и проба на собранном идёт с тем же контрактом — хук другой ревизии
//     блокирует безобидное, и раннер не стартует. У ядра не из установки (копия в дереве
//     потребителя) своего git может не быть: тогда контракта нет, о чём старт говорит
//     строкой, а барьер скиллов включает переключатель (`coreShaPolicy`).
//
// Почему контракт в команде хука, а не в окружении сессии. Окружение сессии наследуют ВСЕ
// её хуки, в том числе зарегистрированные настройками дерева сессии
// (`${CLAUDE_PROJECT_DIR}/.claude/hooks`, их Claude Code складывает с нашими). На каноне
// это хуки ветки фазы: под контрактом первая же сессия, тронувшая хук, блокировала бы
// себе всё; у потребителя этот каталог — вовсе не репозиторий ядра, и `git ls-tree`
// ревизии ядра там отказывает на каждом вызове. Контракт получают ровно те хуки, которые
// раннер зарегистрировал из установки, — а их сверка и есть то, что контракт обещает.
// Затем отрицательная проба (`guard-probe.ts`) на СОБРАННОМ файле: запрещённое обязано
// быть заблокировано, безобидное — пропущено. Не прошла — сессия не стартует.
//
// Чего это НЕ обещает, сказано вслух. Claude Code по-прежнему читает и проектные настройки
// дерева сессии и складывает их хуки с нашими: хук из дерева сессии может заблокировать
// больше, но не может снять наш — блокирует любой код 2. Отказаться от проектных настроек
// (`--setting-sources user`) стенд умеет, но вместе с ними CLI теряет и то, что берёт из
// проекта помимо хуков; это решение отдельной задачи, а не попутное. Хук потребителя,
// названный через `${CLAUDE_PROJECT_DIR}`, исполняет код дерева сессии — так он написан
// потребителем, и переписывать чужие команды раннер не берётся. Отсюда и удвоение: когда
// дерево сессии — worktree того же репозитория (канон, обычно и потребитель), такой хук
// приходит и из собранного файла, и из проектных настроек дерева сессии, и на каждом вызове
// инструмента может стартовать дважды — лишний node на guard и на прочие хуки потребителя.
// Корректность это не ломает: оба экземпляра исполняют один код и блокируют одинаково.
// Записи, совпавшие с настройками дерева сессии, намеренно не выбрасываются: решать по
// дереву, которое правит PR, какие хуки человека снять из собранного файла, — значит снова
// дать правимому коду голос в настройках сессии, ради чего модуль и заведён.
//
// Файл settings лежит в каталоге состояния: сессия, умеющая писать куда угодно на хосте,
// может его поправить, но перед следующей сессией он собирается заново, а проба гоняется на
// свежесобранном.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { guardSideEffect } from '../shared/side-effect-guard.ts';
import { probeProblems, runHook, type TRunHookFn } from './guard-probe.ts';
import { stripGitContext } from './consumer-tree.ts';
import { writeFileAtomic } from './roots.ts';

/**
 * Канонические PreToolUse-хуки сессии петли. Matcher'ы — те же, что в `.claude/settings.json`
 * канона: их совпадение сверяет тест, иначе два списка разъехались бы на первой правке.
 */
export const CANON_SESSION_HOOKS: readonly { file: string; matcher: string; timeout: number }[] = [
    {
        file: 'guard.cjs',
        matcher: 'Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Grep|mcp__.*',
        timeout: 10,
    },
    { file: 'skill-barrier.cjs', matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', timeout: 10 },
];

/** Переменная, которой хук получает путь данных контура (читает `consumer-data.cjs`). */
export const HOOKS_DATA_ENV = 'RALPH_HOOKS_DATA';

/**
 * Переключатель барьера скиллов (читает `skill-barrier.cjs`). Раннер ставит его сессиям в
 * раскладке без `roots`: контракта там нет, и без переключателя барьер молча снят.
 */
export const SKILL_GUARD_ENV = 'RALPH_SKILL_GUARD';

/** Контракт запуска петли: ожидаемая ревизия ядра (читает `core-revision.cjs`). */
export const CORE_SHA_ENV = 'RALPH_CORE_SHA';

/**
 * Переменные, которые раннер кладёт только в команду своего хука. В env сессии их быть не
 * должно: его наследуют и хуки дерева сессии, и унаследованное из окружения раннера значение
 * дало бы им чужой контракт или чужие данные контура (`withSkillGuard` в оркестраторе).
 */
export const HOOK_COMMAND_ONLY_ENV: readonly string[] = [CORE_SHA_ENV, HOOKS_DATA_ENV];

// Та же форма, что у `core-revision.cjs`: полный SHA, а не сокращение и не имя ветки.
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const SETTINGS_REL = path.join('.claude', 'settings.json');
const HOOKS_DATA_REL = path.join('.claude', 'ralph', 'hooks.json');

/** Строка в одинарных кавычках оболочки: команда хука исполняется через `sh -c`. */
export function shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Команда канонического хука: файл из каталога ядра, данные контура из дерева человека,
 * контракт запуска — ревизия этого ядра. Пустая ревизия — ядро-копия без своего git
 * (`coreShaPolicy`): контракта нет, и барьер скиллов включается переключателем, иначе в
 * сессиях петли он был бы снят молча. `RALPH_CORE_SHA` тогда ставится пустым ЯВНО: env
 * сессии — окружение раннера, и значение, унаследованное из окружения запуска или
 * env-файла, заставило бы хук сверять себя с чужой ревизией и блокировать всё, а стоп
 * назвал бы причиной пробу барьера, а не окружение.
 */
export function canonHookCommand(
    productRoot: string,
    file: string,
    humanRoot: string,
    coreSha: string,
): string {
    const data = path.join(humanRoot, HOOKS_DATA_REL);
    const hook = path.join(productRoot, '.claude', 'hooks', file);
    const loop =
        coreSha === ''
            ? `${CORE_SHA_ENV}='' ${SKILL_GUARD_ENV}=${shellQuote('on')}`
            : `${CORE_SHA_ENV}=${shellQuote(coreSha)}`;
    return `${loop} ${HOOKS_DATA_ENV}=${shellQuote(data)} node ${shellQuote(hook)}`;
}

/** Исход git-вызова в каталоге: код, stdout, stderr. */
export type TGitInDirFn = (
    dir: string,
    args: string[],
) => { status: number | null; stdout: string; stderr: string };

const gitInDir: TGitInDirFn = (dir, args) => {
    guardSideEffect(`git -C ${dir} ${args.join(' ')}`, 'Подмени gitFn в тесте.');
    // `GIT_DIR` и родня сильнее `-C`: унаследованные, они увели бы вопрос о ревизии ядра
    // в чужой репозиторий, и ответ был бы правдоподобным SHA не той установки.
    const env = stripGitContext(process.env);
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf-8', env, timeout: 10_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr || String(r.error ?? '') };
};

export type TCoreSha = { ok: true; sha: string } | { ok: false; reason: string; why: string };

/**
 * Ревизия установки ядра — значение контракта `RALPH_CORE_SHA`. Хук сверяет себя через
 * `git ls-tree` в своём каталоге, поэтому установка обязана быть git-репозиторием с этой
 * ревизией (клон или worktree), и сверяется это здесь, до первой сессии. Корень
 * репозитория обязан совпасть с каталогом ядра: распакованный `git archive` внутри чужого
 * репозитория (домашний каталог под git) иначе отдал бы HEAD соседа, и отказ всплыл бы
 * блоком каждого вызова в сессии, а не причиной на старте.
 */
export function resolveCoreSha(
    productRoot: string,
    {
        gitFn = gitInDir,
        realpathFn = (p: string) => fs.realpathSync(p),
    }: { gitFn?: TGitInDirFn; realpathFn?: (p: string) => string } = {},
): TCoreSha {
    const refuse = (why: string): TCoreSha => ({
        ok: false,
        why,
        reason:
            `Ревизия ядра ${productRoot} не определена: ${why}. Хуки сессии сверяют себя с ` +
            `ревизией через git (${CORE_SHA_ENV}), поэтому установка ядра обязана быть ` +
            'git-репозиторием (клон или worktree) — старт отменён.',
    });
    const top = gitFn(productRoot, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0) return refuse(`не git-репозиторий (${top.stderr.trim()})`);
    let same: boolean;
    try {
        same = realpathFn(top.stdout.trim()) === realpathFn(productRoot);
    } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error));
    }
    if (!same) return refuse(`корень репозитория — ${top.stdout.trim()}, а не каталог ядра`);
    const head = gitFn(productRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const sha = head.stdout.trim();
    if (head.status !== 0 || !SHA_RE.test(sha)) {
        return refuse(`HEAD не читается (${head.stderr.trim() || sha})`);
    }
    return { ok: true, sha };
}

/**
 * Что делать, если ревизия ядра не определилась. Ядро из УСТАНОВКИ (манифест, lock) обязано
 * быть git-репозиторием — `./ralph install` кладёт его чекаутом, — и там это стоп. Ядро не
 * из установки — копия в дереве потребителя (`.claude/ralph`) или клон — до #132 шло без
 * контракта, и такая раскладка законна (`roots.ts`: продукт внутри потребителя). Для неё
 * отказ — не стоп, а громкая деградация: хуки из ядра без `RALPH_CORE_SHA` (самосверки
 * ревизии нет, как до #132), барьер скиллов — переключателем. Хуки при этом берутся из
 * дерева человека, а не из дерева сессии, которое правит PR (ревью Фазы 12: стоп здесь
 * ронял каждую копию ядра с `roots`, включая песочницу живого цикла).
 */
export function coreShaPolicy(
    resolved: TCoreSha,
    installed: boolean,
):
    | { kind: 'contract'; sha: string }
    | { kind: 'refuse'; reason: string }
    | { kind: 'no-contract'; note: string } {
    if (resolved.ok) return { kind: 'contract', sha: resolved.sha };
    if (installed) return { kind: 'refuse', reason: resolved.reason };
    return {
        kind: 'no-contract',
        note:
            `ядро не из установки и его ревизия не определена (${resolved.why}) — хуки из ` +
            `ядра идут без контракта ${CORE_SHA_ENV} и с ревизией себя не сверяют; барьер ` +
            `скиллов включён переключателем ${SKILL_GUARD_ENV}=on`,
    };
}

/** Строка лога старта о том, откуда сессия получает settings, — у каждой раскладки своя. */
export function describeSessionSettingsStart(
    roots: { productRoot: string; humanRoot: string; coreSha: string } | null,
): string {
    if (roots === null) {
        return (
            '🧷 Settings сессии не собирается: секции roots нет — сессии идут на настройках ' +
            'своего дерева, проба барьера только на старте; контракта RALPH_CORE_SHA ' +
            `нет, барьер скиллов включён переменной ${SKILL_GUARD_ENV}=on в env сессии`
        );
    }
    const contract = roots.coreSha ? `${CORE_SHA_ENV}=${roots.coreSha}` : 'без контракта ревизии';
    return (
        `🧷 Settings сессии: хуки из ядра ${roots.productRoot} (${contract}), контур из ` +
        `${roots.humanRoot}; собирается и проходит пробу перед каждой сессией`
    );
}

/**
 * Строка отчёта `--doctor` о проверке старта вне контракта совместимости. `warn` — старт
 * пройдёт, но с деградацией: маркер ставит `runDoctor`, а не текст строки, иначе выходило
 * «✅ ⚠ …» — галочка и предупреждение разом (ревью Фазы 12).
 */
export type TDoctorLine = { ok: boolean; warn?: boolean; line: string };

/**
 * Те же проверки, которыми старт с `roots` отказывает до первой сессии, — для `--doctor`:
 * ревизия установки (`resolveCoreSha`) и settings дерева человека (`readHumanSettings`).
 * Обе только читают. Без них doctor был зелёным там, где следующий же старт падал на
 * ревизии ядра (ревью Фазы 12), — а проверка, которую doctor показывает зелёной, а старт
 * отвергает, учит человека не верить обеим (`compat.ts`). Пробы барьера здесь нет: она
 * исполняет хуки, а doctor — режим только для чтения; её отказ называет старт.
 */
export function sessionStartChecks({
    productRoot,
    humanRoot,
    installed,
    resolveCoreShaFn = resolveCoreSha,
    readHumanSettingsFn = readHumanSettings,
}: {
    productRoot: string;
    humanRoot: string;
    /** Ядро из установки: ревизия обязательна (`coreShaPolicy`). */
    installed: boolean;
    resolveCoreShaFn?: (productRoot: string) => TCoreSha;
    readHumanSettingsFn?: (humanRoot: string) => Record<string, unknown>;
}): TDoctorLine[] {
    const policy = coreShaPolicy(resolveCoreShaFn(productRoot), installed);
    const lines: TDoctorLine[] = [
        policy.kind === 'contract'
            ? { ok: true, line: `ревизия ядра ${productRoot}: ${policy.sha} (${CORE_SHA_ENV})` }
            : policy.kind === 'refuse'
              ? { ok: false, line: policy.reason }
              : { ok: true, warn: true, line: policy.note },
    ];
    try {
        readHumanSettingsFn(humanRoot);
        lines.push({ ok: true, line: `settings дерева человека ${humanRoot} читаются` });
    } catch (error) {
        lines.push({
            ok: false,
            line:
                `Settings сессии не собран: ${error instanceof Error ? error.message : String(error)} ` +
                '— старт будет отменён.',
        });
    }
    return lines;
}

/**
 * Все проверки старта вне слоёв для `--doctor`: расхождение `roots.productRoot` с исполняемым
 * ядром (`productRootMismatch`, строку отказа считает вызывающий) и, при заданных `roots`,
 * `sessionStartChecks`. Без `roots` settings не собирается, и проверять там нечего.
 */
export function doctorStartChecks({
    productRootDrift,
    productRoot,
    humanRoot,
    installed,
    sessionStartChecksFn = sessionStartChecks,
}: {
    productRootDrift: string | null;
    productRoot: string;
    humanRoot: string | null;
    installed: boolean;
    sessionStartChecksFn?: typeof sessionStartChecks;
}): TDoctorLine[] {
    return [
        ...(productRootDrift ? [{ ok: false, line: productRootDrift }] : []),
        ...(humanRoot === null ? [] : sessionStartChecksFn({ productRoot, humanRoot, installed })),
    ];
}

/**
 * Settings дерева человека. Файла нет — пустой объект: потребитель без своих настроек
 * получает только канонические хуки. Файл есть, но битый или не той формы — исключение:
 * собрать сессии «настройки без хуков потребителя» значило бы молча потерять их барьеры.
 */
export function readHumanSettings(
    humanRoot: string,
    readFileFn: (p: string) => string = (p) => fs.readFileSync(p, 'utf-8'),
): Record<string, unknown> {
    const file = path.join(humanRoot, SETTINGS_REL);
    let text: string;
    try {
        text = readFileFn(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
        throw new Error(
            `${file} не прочитан (${error instanceof Error ? error.message : String(error)})`,
        );
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        throw new Error(
            `${file} — не JSON (${error instanceof Error ? error.message : String(error)})`,
        );
    }
    if (!isPlainObject(raw)) throw new Error(`${file} — не объект`);
    if (raw.hooks !== undefined) {
        if (!isPlainObject(raw.hooks)) throw new Error(`${file}: hooks — не объект`);
        for (const [event, entries] of Object.entries(raw.hooks)) {
            if (!Array.isArray(entries)) throw new Error(`${file}: hooks.${event} — не список`);
        }
    }
    return raw;
}

/**
 * Собранный settings сессии. Чистая функция: тот же вход — тот же объект. Списки хуков
 * потребителя копируются, а не делятся: правка собранного не трогает прочитанного.
 */
export function buildSessionSettings({
    productRoot,
    humanRoot,
    coreSha,
    humanSettings,
}: {
    productRoot: string;
    humanRoot: string;
    coreSha: string;
    humanSettings: Record<string, unknown>;
}): Record<string, unknown> {
    const humanHooks = isPlainObject(humanSettings.hooks) ? humanSettings.hooks : {};
    const hooks: Record<string, unknown[]> = {};
    for (const [event, entries] of Object.entries(humanHooks)) {
        hooks[event] = Array.isArray(entries) ? [...entries] : [];
    }
    hooks.PreToolUse = [
        ...(hooks.PreToolUse ?? []),
        ...CANON_SESSION_HOOKS.map(({ file, matcher, timeout }) => ({
            matcher,
            hooks: [
                {
                    type: 'command',
                    command: canonHookCommand(productRoot, file, humanRoot, coreSha),
                    timeout,
                },
            ],
        })),
    ];
    return { ...humanSettings, hooks, disableAllHooks: false };
}

export type TSessionSettingsDeps = {
    readFileFn?: (p: string) => string;
    writeFileFn?: (p: string, text: string) => void;
    runHookFn?: TRunHookFn;
};

export type TPreparedSettings = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Сборка, запись и проба перед сессией. Отказ — причина строкой, а не исключение: стоп с
 * ней делает вызывающий. Проба идёт на собранном объекте ДО записи: файл, не прошедший
 * пробу, не должен лечь туда, откуда его возьмёт следующая сессия.
 */
export function prepareSessionSettings(
    {
        productRoot,
        humanRoot,
        coreSha,
        sessionTree,
        outPath,
    }: {
        productRoot: string;
        humanRoot: string;
        coreSha: string;
        sessionTree: string;
        outPath: string;
    },
    {
        readFileFn = (p) => fs.readFileSync(p, 'utf-8'),
        writeFileFn = (p, text) => writeFileAtomic(p, text),
        runHookFn = runHook,
    }: TSessionSettingsDeps = {},
): TPreparedSettings {
    let humanSettings: Record<string, unknown>;
    try {
        humanSettings = readHumanSettings(humanRoot, readFileFn);
    } catch (error) {
        return {
            ok: false,
            reason:
                `Settings сессии не собран: ${error instanceof Error ? error.message : String(error)}. ` +
                'Без настроек дерева человека сессия потеряла бы хуки потребителя — старт отменён.',
        };
    }
    const settings = buildSessionSettings({ productRoot, humanRoot, coreSha, humanSettings });
    const problems = probeProblems(settings, sessionTree, { runHookFn });
    if (problems.length > 0) {
        return {
            ok: false,
            reason:
                'Проба барьера перед сессией не прошла — сессия не запущена:\n' +
                problems.map((p) => `  - ${p}`).join('\n') +
                `\nХуки — из ядра ${productRoot} (ревизия ${coreSha || 'без контракта'}), контур и настройки — ` +
                `из ${humanRoot}.`,
        };
    }
    try {
        writeFileFn(outPath, `${JSON.stringify(settings, null, 2)}\n`);
    } catch (error) {
        return {
            ok: false,
            reason: `Settings сессии не записан в ${outPath} (${error instanceof Error ? error.message : String(error)}).`,
        };
    }
    return { ok: true, path: outPath };
}
