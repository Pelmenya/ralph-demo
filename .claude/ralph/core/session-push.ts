// Коммиты пишущей сессии, не доехавшие до `origin`: раннер пушит их сам либо встаёт с
// причиной (#85).
//
// Симптом: сессия «разбор blocked» сделала локальный коммит и завершилась без пуша.
// Повторное ревью дало вердикт merge, а гейт отказал fail-closed — локальный ref ветки
// разошёлся с головой PR. Отказ гейта честный, но цена его — стоп петли и ручной пуш
// вахтой, хотя чинить было нечего: работа лежала локально целиком.
//
// Пуш — ответственность раннера, а не просьба промпту: остаток сессии раннер уже коммитит
// сам (`commitLeftovers`), и «запушь в конце» в промпте — тот же абзац вместо барьера,
// который один раз уже не сработал. Модуль знает только git: голову PR форж узнаёт из пуша.
//
// Пуш без `--force`, и это половина решения. Ветку могли допушить с другой стороны —
// тогда локальная работа и удалённая разошлись, и выбрать одну из них значит потерять
// другую. Non-ff отказ git здесь — ровно тот стоп, который нужен: с названной причиной,
// а не перезапись чужой работы.
//
// Отставший локальный ref (он предок `origin`) — не повод пушить и не отказ: так выглядит
// ветка, которую допушили снаружи, и гейт подтягивает его fast-forward сам. Молча он при
// этом не проходит — строка в логе говорит, что пуш пропущен и почему.

import { gitErrorText, gitExitStatus, gitNetworkOpts } from '../shared/ralph-util.ts';
import type { ShArgvFn } from '../shared/ralph-util.ts';

type LogFn = (msg: string) => void;

export type SessionPushResult =
    /** Локальный ref совпадает с `origin` либо его нет вовсе — пушить нечего. */
    | { kind: 'in-sync' }
    /** Локальный ref — предок `origin`: отстал, гейт подтянет его сам. */
    | { kind: 'behind'; local: string; remote: string }
    /** Незапушенные коммиты сессии запушены: `origin` теперь на `local`. */
    | { kind: 'pushed'; local: string; remote: string | null }
    /** Не смогли ни прочитать, ни запушить — причина текстом git. */
    | { kind: 'failed'; why: string; local: string | null; remote: string | null };

/**
 * Сверить локальный ref ветки фазы с `origin` и запушить незапушенные коммиты сессии.
 * Сравнивается ref ветки, а не HEAD дерева: сессия коммитит в ветку, а гейт сверяет с
 * головой PR именно `refs/heads/<branch>`.
 */
export function pushSessionCommits(
    branch: string,
    { runArgvFn, logFn }: { runArgvFn: ShArgvFn; logFn: LogFn },
): SessionPushResult {
    // Код 1 у `rev-parse --verify --quiet` — «ref нет», любой другой — отказ git. Склеить
    // их значило бы на битой ref-базе молча решить, что пушить нечего.
    let local: string;
    try {
        local = runArgvFn('git', [
            'rev-parse',
            '--verify',
            '--quiet',
            `refs/heads/${branch}`,
        ]).trim();
    } catch (e: unknown) {
        if (gitExitStatus(e) === 1) return { kind: 'in-sync' };
        return {
            kind: 'failed',
            why: `локальный ref ${branch} не читается — ${gitErrorText(e)}`,
            local: null,
            remote: null,
        };
    }
    if (!local) return { kind: 'in-sync' };
    // Код 2 у `ls-remote --exit-code` — «ветки на origin нет», и только он: молчащая сеть
    // или отказ кредов за «нет ветки» сойти не должны.
    let remote: string | null = null;
    try {
        const out = runArgvFn(
            'git',
            ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`],
            gitNetworkOpts(),
        );
        remote = out.trim().split(/\s+/)[0] || null;
    } catch (e: unknown) {
        if (gitExitStatus(e) !== 2) {
            return {
                kind: 'failed',
                why: `не смог прочитать ветку ${branch} на origin — ${gitErrorText(e)}`,
                local,
                remote: null,
            };
        }
    }
    if (remote === local) return { kind: 'in-sync' };
    if (remote) {
        // Отставание — `local` предок `remote`. Любой отказ команды (в том числе «объекта
        // remote локально нет») — не отставание: решает пуш, а non-ff он отвергнет сам.
        try {
            runArgvFn('git', ['merge-base', '--is-ancestor', local, remote]);
            // Строка обязательна, хоть исход и штатный: без неё по логу прогона не видно,
            // что пуш пропущен, — а сессия могла коммитить мимо ref.
            logFn(
                `↪ Локальный ref ${branch} (${local.slice(0, 8)}) отстал от origin (${remote.slice(0, 8)}) — пуш не нужен, гейт подтянет ff.`,
            );
            return { kind: 'behind', local, remote };
        } catch {}
    }
    try {
        runArgvFn('git', ['push', 'origin', `${local}:refs/heads/${branch}`], gitNetworkOpts());
    } catch (e: unknown) {
        return {
            kind: 'failed',
            why: `git push отвергнут (ветку могли допушить с другой стороны) — ${gitErrorText(e)}`,
            local,
            remote,
        };
    }
    logFn(
        `⬆ Незапушенные коммиты сессии на ветке ${branch} запушены раннером: ` +
            `${remote ? remote.slice(0, 8) : '(ветки не было)'} → ${local.slice(0, 8)}.`,
    );
    return { kind: 'pushed', local, remote };
}
