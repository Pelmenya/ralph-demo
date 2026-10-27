// Ветка фазы, отставшая от `main`: подтянуть его до чеков гейта либо встать с названными
// файлами (#66).
//
// Симптом: петля держит ветку фазы часами, а в `main` за это время уезжает чужой мердж —
// PR человека, соседняя фаза, автозакрытие. От `main` ветка фазы не обновлялась ни разу.
// Пока встречные правки лежали в разных файлах, площадка сливала сама; как только они
// сходились на одном файле (журнал ядра, `CLAUDE.md`, `package.json` правятся обеими
// сторонами), мердж отвергался конфликтом — при зелёном гейте и пройденном ревью. Человек
// видел только «мердж не удался» и сам выяснял, что дело в отставании, и в каком файле.
//
// Решение — подтягивать `origin/main` в ветку фазы ДО прогона чеков, а не распознавать
// отставание по отказу мерджа:
//   - чеки гейта идут на голове, которая и уедет в `main`. Отстающая голова проверяла код
//     БЕЗ встречной правки, и зелёный гейт ничего не говорил о том, что окажется в `main`
//     после squash — даже там, где площадка сливала сама;
//   - отказ мерджа по тексту форжа узнаётся плохо (у каждой площадки своя формулировка), а
//     `git merge` называет конфликтующие файлы сам, локально и одинаково везде.
//
// Конфликт петля НЕ разбирает. Разрешать встречную правку по смыслу — работа сессии с
// ревью, а не механики гейта; молча взять одну сторону значит потерять другую. Поэтому
// конфликт — стоп с именами файлов, и `git merge --abort` возвращает дерево в чистое
// состояние: следующий рестарт начинает с того же места.
//
// Влитие — merge-коммит, а не rebase: ветка фазы уже на `origin`, PR смотрит в неё, и
// переписывание истории потребовало бы force-push, которого раннер не делает нигде. Пуш
// без `--force`: если ветку за время гейта допушили, он отвергнется, и это честный стоп,
// а не перезапись чужой работы.
//
// Сетевые шаги (`fetch`, `push`) переживают транзиент повтором — правило 4 канона: ночь не
// должна вставать из-за моргнувшей сети. Класс отказа решает тот же классификатор, что у
// мерджа (`merge-retry.ts`): «не резолвится хост», таймаут, 5xx, обрыв — повтор с паузой;
// non-ff отказ пуша и отказ кредов — сразу `failed`, повтор их не лечит. Попыток немного:
// это не предел массового сбоя площадки, а чих, и стоп после них честнее, чем час ожидания.
//
// Модуль знает только git — команд форжа здесь нет, голову PR после пуша форж узнаёт сам,
// а привязку мерджа к проверенной голове держит `--match-head-commit` в гейте.

import {
    gitErrorText,
    gitExitStatus,
    gitNetworkOpts,
    isExecTimeout,
    sleep,
} from '../shared/ralph-util.ts';
import type { ShArgvFn } from '../shared/ralph-util.ts';
import { classifyMergeFailure } from './merge-retry.ts';

type LogFn = (msg: string) => void;

/** Попыток сетевого шага (первая + повторы) и пауза перед повтором N — 15 с, 30 с. */
export const NETWORK_ATTEMPTS = 3;
const NETWORK_PAUSE_MS = 15_000;

export type MainSyncResult =
    /** `origin/main` уже предок головы — подтягивать нечего. */
    | { kind: 'current' }
    /** Влили `origin/main` без конфликта и запушили: чеки идут на `head`. */
    | { kind: 'updated'; head: string; main: string }
    /** Встречная правка тех же файлов: влитие отменено, дерево чистое. */
    | { kind: 'conflict'; main: string; files: string[] }
    /** Не смогли ни проверить, ни влить, ни запушить — причина текстом. */
    | { kind: 'failed'; why: string };

/**
 * Подтянуть `origin/main` в ветку фазы, голова которой `head`. Дерево к моменту вызова
 * обязано стоять detached на `head` и быть чистым: так его оставляет гейт перед чеками.
 * Локальный ref ветки (если он есть) двигается вслед за пушем — сверка «локальный ref ==
 * голова PR» следующего круга иначе приняла бы влитие за расхождение.
 */
export function syncPhaseBranchWithMain(
    branch: string,
    head: string,
    {
        runArgvFn,
        logFn,
        sleepFn = sleep,
    }: { runArgvFn: ShArgvFn; logFn: LogFn; sleepFn?: (ms: number) => void },
): MainSyncResult {
    // Сетевой шаг с повтором транзиента; исключение последней попытки уходит наверх.
    const network = (what: string, args: string[]): void => {
        for (let attempt = 1; ; attempt++) {
            try {
                runArgvFn('git', args, gitNetworkOpts());
                return;
            } catch (e: unknown) {
                // Срок не повторяется: он сам уже был ожиданием, и повтор растянул бы стоп
                // втрое. Держит это явная ветка, а не то, что текст отказа по сроку сегодня
                // не похож на транзиент: слово «сеть» в классификаторе молча включило бы повтор.
                if (isExecTimeout(e)) throw e;
                const why = gitErrorText(e);
                if (attempt >= NETWORK_ATTEMPTS || classifyMergeFailure(why) !== 'transient') {
                    throw e;
                }
                const pauseMs = NETWORK_PAUSE_MS * attempt;
                logFn(
                    `⚠ ${what} — транзиентный сбой сети (${why}), повтор через ${Math.round(pauseMs / 1000)}с ` +
                        `(попытка ${attempt} из ${NETWORK_ATTEMPTS}).`,
                );
                sleepFn(pauseMs);
            }
        }
    };
    try {
        network('git fetch origin main', ['fetch', 'origin', 'main']);
    } catch (e: unknown) {
        return { kind: 'failed', why: `git fetch origin main упал — ${gitErrorText(e)}` };
    }
    let main: string;
    try {
        main = runArgvFn('git', ['rev-parse', '--verify', 'origin/main^{commit}']).trim();
    } catch (e: unknown) {
        return { kind: 'failed', why: `origin/main не читается — ${gitErrorText(e)}` };
    }
    // Код 1 у `--is-ancestor` — ответ «нет», любой другой — отказ самой команды. Склеить их
    // значило бы на битом репозитории полезть вливать то, чего не смогли прочитать.
    try {
        runArgvFn('git', ['merge-base', '--is-ancestor', main, head]);
        return { kind: 'current' };
    } catch (e: unknown) {
        if (gitExitStatus(e) !== 1) {
            return {
                kind: 'failed',
                why: `не смог сравнить ветку с origin/main — ${gitErrorText(e)}`,
            };
        }
    }
    logFn(
        `↪ Ветка ${branch} (${head.slice(0, 8)}) отстала от origin/main (${main.slice(0, 8)}) — вливаю main до чеков гейта.`,
    );
    try {
        runArgvFn('git', [
            'merge',
            '--no-ff',
            '--no-edit',
            '-m',
            `chore: влить main в ${branch}`,
            main,
        ]);
    } catch (e: unknown) {
        // Файлы читаются ДО `--abort`: после него индекс чистый, и назвать их уже нечем.
        let files: string[] = [];
        try {
            files = runArgvFn('git', ['diff', '--name-only', '--diff-filter=U'])
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l !== '');
        } catch {}
        let abortWhy = '';
        try {
            runArgvFn('git', ['merge', '--abort']);
        } catch (abortErr: unknown) {
            abortWhy = `; git merge --abort тоже упал (${gitErrorText(abortErr)}) — дерево раннера грязное`;
        }
        if (files.length > 0 && abortWhy === '') return { kind: 'conflict', main, files };
        return {
            kind: 'failed',
            why:
                (files.length > 0
                    ? `конфликт в ${files.join(', ')}`
                    : `git merge origin/main упал без конфликтующих файлов — ${gitErrorText(e)}`) +
                abortWhy,
        };
    }
    let merged: string;
    try {
        merged = runArgvFn('git', ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    } catch (e: unknown) {
        return { kind: 'failed', why: `не смог прочитать коммит влития — ${gitErrorText(e)}` };
    }
    try {
        network(`git push влития main в ${branch}`, [
            'push',
            'origin',
            `${merged}:refs/heads/${branch}`,
        ]);
    } catch (e: unknown) {
        return {
            kind: 'failed',
            why: `влитие main запушить не удалось (ветку могли допушить за время гейта) — ${gitErrorText(e)}`,
        };
    }
    // Ref двигается с проверкой старого значения: пуш уже прошёл, и затереть ref, который за
    // это время сдвинул кто-то другой, хуже, чем оставить его отставшим — отставший гейт
    // следующего круга подтягивает fast-forward сам.
    let localHead: string | null = null;
    try {
        localHead = runArgvFn('git', [
            'rev-parse',
            '--verify',
            '--quiet',
            `refs/heads/${branch}`,
        ]).trim();
    } catch {}
    if (localHead === head) {
        try {
            runArgvFn('git', ['update-ref', `refs/heads/${branch}`, merged, head]);
        } catch (e: unknown) {
            logFn(
                `⚠ Локальный ref ${branch} не подтянут к влитию (${gitErrorText(e)}) — следующий гейт подтянет его fast-forward.`,
            );
        }
    }
    logFn(
        `↪ main влит в ${branch}: ${head.slice(0, 8)} → ${merged.slice(0, 8)}, запушено — чеки идут на новой голове.`,
    );
    return { kind: 'updated', head: merged, main };
}
