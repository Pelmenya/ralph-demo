// Примитивы исполнения и лога раннера (#365, трек «Фреймворк ralph», фаза 3).
// Вынесены из ralph.js по тому же приёму, что state-lock.ts/worktree.ts (#359/#360):
// одна связная зона ответственности — «как раннер зовёт внешние процессы и пишет лог»,
// поведение НЕ меняется, это извлечение, а не переписывание.
//
// Что собрано здесь:
// - log/fail/setLogTarget — лог-строка с ISO-временем в консоль + запись в три приёмника
//   (лог, журнал событий, heartbeat — задача 95; цель перенаправляется в worktree раннера
//   ДО chdir, #SiaUB) и fail-closed стоп; emitEvent — событие только для журнала;
//   ветки записи и режим наблюдателя проверяет `exec-sinks.test.ts` (задача 128);
// - sh/shArgv — шелл-строка (только чтения, #133) и argv без шелла (мутации, #193/#252),
//   обе под предохранителем #138;
// - ghJson — gh-чтения с ретраями и backoff (M3);
// - loadJson — чтение JSON с фолбэком (общий помощник конфига/стейта);
// - saveSessionOutput — запись stdout/stderr упавшей кодер-сессии в файл (#390),
//   секреты редактируются тем же приёмом, что TG-токен в telegram-notifier.ts.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
//
// Фабрика, а не standalone-экспорты: sh/shArgv обязаны звать ОБЩИЙ guardSideEffect
// ralph.js (журнал #138 един на все модули), log — знать текущий logTarget, ghJson —
// логировать ретраи тем же log. Фабрика захватывает этот контекст один раз; возвращённые
// функции — те же боевые дефолты-коллабораторы, что раньше жили module-level в ralph.js.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import type { StdioOptions } from 'node:child_process';
import { NO_SIDE_EFFECTS } from '../shared/side-effect-guard.ts';
import { createLogSinks } from './event-journal.ts';
import { DEFAULT_SESSION_LOGS_KEEP, pruneSessionLogs } from './observability.ts';
import {
    ExecTimeoutError,
    execPolicy,
    isExecTimeout,
    redactSecrets,
} from '../shared/ralph-util.ts';

type GuardFn = (what: string) => void;
type SleepFn = (ms: number) => void;
// `input` (только у shArgv) — данные на stdin дочернего процесса. Нужен там, где объём
// не влезает в argv по природе: комментарии PR уходят счётчику находок целиком, а предел
// одного аргумента у ядра ОС жёсткий (128 КБ) — обрезка здесь дала бы тихо заниженную
// метрику вместо отказа. Секрет через argv не гонять — тот же довод, что у TG-токена
// (виден в /proc/<pid>/cmdline), но здесь это про размер, а не про тайну.
// `timeoutMs` — срок процесса (задача 30): по истечении он убивается `SIGKILL`, а отказ
// приходит `ExecTimeoutError` с именем срока. Сетевой git получает срок и без опции —
// см. `execPolicy`.
type ExecOpts = { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number };

export type ExecEnv = {
    guardSideEffect: GuardFn;
    sleep: SleepFn;
    // Начальная цель лога (cwd-относительный LOG_PATH); main() оркестратора репойнтит
    // её на абсолютный путь внутри worktree раннера ещё ДО chdir (#SiaUB).
    initialLogTarget: string;
    // Коллабораторы для тестов (задача 128); боевой вызов их не передаёт. Предохранитель
    // модульный, и без своего флага ветки записи были недостижимы из сьюта вовсе — в том
    // числе предохранитель наблюдателя: снятие `logTarget === null` осталось бы зелёным.
    // Флаг снимают только с целью лога во временном каталоге теста — и это держит
    // `createExec`, а не текст: снятый под RALPH_NO_SIDE_EFFECTS=1 флаг с целью вне
    // `os.tmpdir()` бросает (и в `setLogTarget` тоже).
    noSideEffects?: boolean;
    sinks?: ReturnType<typeof createLogSinks>;
    pruneFn?: typeof pruneSessionLogs;
};

export function loadJson<T>(p: string, fallback: T): T {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
    } catch {
        return fallback;
    }
}

// #386: выбор пути лога по режиму прогона. Свежесть ralph.log — признак жизни БОЕВОЙ
// петли (инвариант №12); чужой прогон (--dry-run и/или профиль ≠ prod — обычный
// ритуал кодер-сессии, проверяющей правки самого раннера: playground/dry-run) не имеет
// права писать в тот же файл — его штатные маркеры остановки (⏸/✋/🎉) переводят
// deadman в режим stopped (порог тишины Infinity) и ослепляют сторож боевой петли
// навсегда. Чистая функция без побочек — тестируется отдельно от main().
export function chooseLogPath(
    run: { dry: boolean; profileName?: string },
    paths: { battle: string; sideline: string },
): string {
    const isBattle = !run.dry && run.profileName === 'prod';
    return isBattle ? paths.battle : paths.sideline;
}

export function createExec(env: ExecEnv) {
    const {
        guardSideEffect,
        sleep,
        initialLogTarget,
        noSideEffects = NO_SIDE_EFFECTS,
        pruneFn = pruneSessionLogs,
    } = env;

    // Куда log() дописывает строки. По умолчанию — cwd-относительный LOG_PATH, но main()
    // репойнтит на АБСОЛЮТНЫЙ путь внутри worktree раннера ещё ДО chdir (#SiaUB): иначе
    // строки создания worktree (🌳/📦) ушли бы в ralph.log дерева человека, а монитор
    // тейлит только worktree-лог — ранние события на панели пропадали бы.
    //
    // `null` — лог без файла, только консоль (#58). Нужен процессу-НАБЛЮДАТЕЛЮ: панель
    // монитора спрашивает трекер через шов, а адаптер пишет свои предупреждения этим же
    // log(). Файлом здесь был бы ralph.log рядом с ядром — а свежесть ralph.log и есть
    // признак жизни петли: строка наблюдателя оживила бы мёртвый раннер.
    // Задача 128: предохранитель модульный, а параметр снимает его с любого экземпляра.
    // Правило «снимают только с целью во временном каталоге» — барьер, а не абзац: тест,
    // снявший флаг с боевой целью, писал бы в живой лог петли (а свежесть лога — признак
    // её жизни для deadman).
    const assertSafeTarget = (p: string | null): void => {
        if (!NO_SIDE_EFFECTS || noSideEffects || p === null) return;
        const rel = path.relative(os.tmpdir(), path.resolve(p));
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel))
            throw new Error(
                `createExec: noSideEffects снят под RALPH_NO_SIDE_EFFECTS=1, а цель лога ${p} ` +
                    `не во временном каталоге (${os.tmpdir()}) — запись ушла бы в живое дерево.`,
            );
    };
    assertSafeTarget(initialLogTarget);
    let logTarget: string | null = initialLogTarget;

    function setLogTarget(p: string | null): void {
        assertSafeTarget(p);
        logTarget = p;
    }

    // Сколько выводов сессий держит каталог `sessions/` (задача 95). Ставит main() из
    // конфига, как и цель лога: фабрика собирается раньше, чем конфиг прочитан.
    let sessionLogsKeep = DEFAULT_SESSION_LOGS_KEEP;

    function setSessionLogsKeep(n: number): void {
        sessionLogsKeep = n;
    }

    // Задача 95: строка уходит в три независимых приёмника — лог, журнал событий и
    // heartbeat (`event-journal.ts`). Прежний `catch {}` вокруг одной записи делал отказ
    // диска невидимым, а deadman — слепым: свежесть одного файла и была признаком жизни.
    const sinks = env.sinks ?? createLogSinks();

    function log(msg: string): void {
        const ts = new Date().toISOString();
        console.log(`[${ts}] ${msg}`);
        if (noSideEffects || logTarget === null) return;
        sinks.write(logTarget, msg, ts);
    }

    // Событие только для журнала — без строки в человеческом логе (стоимость попытки).
    // Тот же предохранитель, что у log(): в тестах и у наблюдателя журнала нет.
    function emitEvent(kind: string, data: Record<string, unknown>): void {
        if (noSideEffects || logTarget === null) return;
        sinks.emit(logTarget, kind, data, new Date().toISOString());
    }

    function fail(msg: string): never {
        console.error(`❌ ${msg}`);
        process.exit(1);
    }

    // env (#189): по умолчанию дочерний процесс наследует полный env раннера — так гонятся
    // git-команды хореографии гейта, которым нужны секреты (GH_TOKEN для fetch). Но команды
    // ЧЕКОВ (build/lint/test) и `npm ci` — это код из проверяемого PR, ему секреты петли
    // видеть нельзя; checksGreen/installFn передают сюда санированный env (см. gate-env.mts).
    // Общие опции exec для sh()/shArgv(): один объект, чтобы урок maxBuffer 16 МБ (L4:
    // многословный вывод npm/vitest переполнял дефолтный 1 МБ и ронял даже ЗЕЛЁНЫЕ чеки)
    // не пришлось помнить в двух местах — при правке значения расхождение между строковым
    // и argv-вариантом станет структурно невозможным. env спредим по месту вызова (передан
    // → используем, undefined → наследуем process.env как раньше).
    // Явный тип вместо `as const`: encoding обязан читаться как BufferEncoding (иначе
    // exec*Sync уходит в Buffer-overload и .trim() не типизируется), а readonly-tuple
    // stdio не влезает в мутабельный StdioOptions.
    const EXEC_OPTS: { encoding: BufferEncoding; stdio: StdioOptions; maxBuffer: number } = {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
    };

    // #133: sh() исполняет СТРОКУ через /bin/sh, поэтому любое значение, попадающее в неё,
    // обязано быть заквотировано (shq) либо идти строгим фильтром (SHA40_RE). Мутации на
    // пути к автодеплою прода ушли на argv-вариант shArgv (#193/#252) — sh() остался
    // каналом чтений.
    function sh(cmd: string, { env: cmdEnv }: ExecOpts = {}): string {
        // #138: см. guardSideEffect — в тестах реальный шелл запрещён. Команду
        // печатаем целиком: по ней сразу видно, какой именно дефолт не подменили.
        guardSideEffect(`sh(${cmd})`);
        return execSync(cmd, {
            ...EXEC_OPTS,
            ...(cmdEnv ? { env: cmdEnv } : {}),
        }).trim();
    }

    // argv-вариант sh() для МУТАЦИЙ на пути к автодеплою прода (#193): git fetch/checkout
    // в гейте (checksGreen/парковка/обновление дерева) и gh pr merge. Значения (имя ветки,
    // sha PR-головы, номер PR) уходят ОТДЕЛЬНЫМИ элементами argv — execFileSync не поднимает
    // шелл вообще, поэтому пробелы и спецсимволы в них не раскрываются: класс shell-инъекции
    // закрыт СТРУКТУРНО, а не квотированием shq(). env — как в sh(): по умолчанию наследуем
    // полный env раннера (git-мутациям и gh нужен GH_TOKEN).
    function shArgv(file: string, args: string[], opts: ExecOpts = {}): string {
        // #138: реальный процесс в тестах запрещён — тот же предохранитель, что в sh().
        // Печатаем file+argv: по строке видно, какой дефолт-коллаборатор не подменили.
        // Содержимое stdin в журнал НЕ пишем: это данные (комментарии PR), а не команда.
        guardSideEffect(`shArgv(${file} ${args.join(' ')})`);
        const { input } = opts;
        // Задача 30: сетевой git идёт с запретом промпта кредов и сроком, даже если место
        // вызова их забыло, — путь исполнения один, и закрыт он здесь.
        const { env: cmdEnv, timeoutMs } = execPolicy(file, args, opts);
        try {
            return execFileSync(file, args, {
                ...EXEC_OPTS,
                ...(cmdEnv ? { env: cmdEnv } : {}),
                // SIGKILL, а не дефолтный SIGTERM: процесс, ждущий сеть, обязан умереть
                // наверняка — срок, который можно проигнорировать, сроком не является.
                ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: 'SIGKILL' }),
                // `input` перекрывает stdio[0] (документированное поведение execFileSync), но
                // ставим 'pipe' явно: молчаливая зависимость от перекрытия — ровно то место,
                // где следующая правка EXEC_OPTS тихо оборвёт stdin.
                ...(input === undefined ? {} : { input, stdio: ['pipe', 'pipe', 'pipe'] }),
            }).trim();
        } catch (e: unknown) {
            if (timeoutMs !== undefined && isExecTimeout(e)) {
                throw new ExecTimeoutError(file, args, timeoutMs);
            }
            throw e;
        }
    }

    // M3: все ЧТЕНИЯ форжа — с ретраями и backoff. AFK-прогон идёт часами без
    // человека; один транзиентный сетевой чих не должен убивать ночную сессию.
    // Ретраим только чтения — они идемпотентны; мутации (merge, PATCH) не ретраим.
    //
    // #72: в тексте предупреждения имени CLI больше нет. Команду сюда передаёт адаптер, и
    // назвать её чужим именем значило соврать оператору на площадке, где этого CLI нет, —
    // тот же класс, что сторожит барьер чистоты ядра. Прежняя формулировка («gh-чтение»)
    // мимо него и проходила: дефис в хвосте гасил проверку словом.
    function ghJson<T = unknown>(cmd: string, attempts = 3): T {
        let lastErr: unknown;
        for (let i = 1; i <= attempts; i++) {
            try {
                return JSON.parse(sh(cmd)) as T;
            } catch (e) {
                lastErr = e;
                if (i < attempts) {
                    log(
                        `⚠ Чтение форжа не удалось (попытка ${i}/${attempts}): ${String((e as Error).message).split('\n')[0]} — повтор через ${5 * i}с`,
                    );
                    sleep(5000 * i);
                }
            }
        }
        throw lastErr;
    }

    // #390: единственная точка записи вывода упавшей кодер-сессии на диск. writeFn —
    // инжектируемая точка (как saveState/writeLock в state-lock.ts) под guardSideEffect
    // #138: забытый мок в тесте иначе создал бы файлы прямо в дереве, где идут тесты.
    // Секреты редактируются ДО записи (redactSecrets), не после — на диске никогда не
    // появляется незаредактированная версия, даже промежуточно.
    function saveSessionOutput(
        filePath: string,
        output: string,
        secrets: Array<string | undefined> = [],
        writeFn: (p: string, data: string) => void = (p, data) => {
            guardSideEffect(`saveSessionOutput(${p})`);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, data);
            // Задача 95: ротация `sessions/` сразу после записи. Выводы раньше не убирались
            // никогда, и каталог рос, пока сам не становился причиной полного диска. Только
            // что записанный вывод — самый свежий и под ротацию не попадает. Отказ уборки —
            // строка в лог, а не исключение: разбор падения важнее чистоты каталога.
            const { errors } = pruneFn(path.dirname(p), sessionLogsKeep);
            if (errors.length > 0) {
                log(`⚠ Ротация логов сессий не удалась частично: ${errors.join('; ')}`);
            }
        },
    ): void {
        writeFn(filePath, redactSecrets(output, secrets));
    }

    return {
        log,
        emitEvent,
        fail,
        setLogTarget,
        setSessionLogsKeep,
        sh,
        shArgv,
        ghJson,
        saveSessionOutput,
    };
}
