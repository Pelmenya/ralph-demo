// Повтор мутации мерджа: что повторять, сколько ждать и до какого предела (#47).
//
// Инцидент: глобальный сбой форжа восстанавливался слоями — REST уже отвечал, GraphQL ещё
// отдавал `HTTP 503`. Мердж-путь шёл через GraphQL и упирался в отказы при исправном PR.
// Фаза сдалась со второй, ПОСЛЕДНЕЙ попытки: та случайно попала в окно, когда GraphQL
// моргнул зелёным. Промахнись она — стоп, а перед мерджем уже отработал весь гейт (с e2e
// это десятки минут), и всё пришлось бы гонять заново плюс терять ночное окно фазы.
//
// Отсюда асимметрия цены: лишний повтор мерджа стоит секунды, стоп — повторный гейт.
// Повтор при этом безопасен по построению, а не по удаче: `--match-head-commit` не даст
// смерджить не ту голову, а между попытками гейт спрашивает форж «уже влит?» (задвоения
// нет). Поэтому транзиент повторяется с растущей паузой до ПРЕДЕЛА ПО ВРЕМЕНИ — при
// массовом сбое площадки два быстрых повтора ничего не меняют, а растущие паузы в течение
// минут дают реальный шанс. Отказ по существу (конфликт, PR закрыт, голова уехала, права)
// повтором не лечится — стоп сразу.
//
// Третий класс — «не узнали» — получает ровно прежнее поведение (один повтор): до #47
// повторялось всё подряд, и узкий список признаков не должен молча отнять повтор у
// сбоя, формулировку которого мы ещё не встречали (боевой случай 2026-07-19: прокси
// оборвал соединение, ночь встала из-за одного чиха).
//
// Модуль чистый — тот же жанр, что api-limit.ts / runtime-availability.ts: детект и
// арифметика паузы здесь, сам цикл повтора — в tryMergePhase (gate.ts).

export type MergeFailureKind = 'transient' | 'refusal' | 'unknown';

// Лимит API проверяется РАНЬШЕ отказа: GitHub отвечает на упор в лимит (и основной, и
// secondary) кодом 403 — `HTTP 403: API rate limit exceeded for user ID …`, — и ветка
// 4xx отказа съела бы его, хотя ради такого окна предел по времени и заведён. Слова о
// лимите — признак сильнее кода: сам по себе 403 без них остаётся отказом (права).
export const MERGE_RATE_LIMIT_RE = /rate limit/i;

// Отказ по существу. Проверяется сразу после лимита API: «голову не удалось верифицировать (HTTP 404)» —
// отказ, хотя в нём есть слово про сеть; повторить отказ по существу значит потратить
// предел впустую и прийти к тому же стопу на десять минут позже.
//
// Признаки только из ОТВЕТА форжа, никогда из текста команды: исключение `execFileSync`
// начинается строкой `Command failed: gh pr merge … --match-head-commit <sha>`, и признак
// вида «match-head-commit» сработал бы на каждом отказе (тот же капкан описан у
// `createIssue` в адаптере GitHub). По той же причине нет голых чисел: номер PR и sha
// в команде есть всегда.
//
// Метки `hold`/`blocked` здесь не ищутся: гейт читает их ДО мерджа и сюда с ними не
// доходит, а подстрока `hold` живёт в `threshold`.
export const MERGE_REFUSAL_RE = new RegExp(
    [
        'not mergeable',
        'mergeable["\']?\\s*:\\s*false',
        'merge conflict',
        'cannot be cleanly created',
        'head branch was modified',
        'base branch was modified',
        'head sha',
        'sha (?:does not|doesn.t) match',
        'pull request (?:#\\d+ )?(?:is|was) (?:already )?closed',
        'protected branch',
        'required status check',
        // 4xx — кроме 408 (таймаут запроса) и 429 (лимит API): это транзиенты, и ради
        // упора в лимит площадки (10 rps на хост) предел по времени и заведён.
        'HTTP 4(?!08|29)\\d\\d',
        'returned error: 4(?!08|29)\\d\\d',
        // Адаптер SourceCraft сверяет голову сам и бросает этим текстом.
        'уехала после прогона чеков',
    ].join('|'),
    'i',
);

// Транзиент: 5xx шлюза и сервера, 408/429, таймауты и обрывы соединения. 501
// сюда не входит намеренно — «не реализовано» повтором не появится.
export const MERGE_TRANSIENT_RE = new RegExp(
    [
        'HTTP 50[0234]\\b',
        'returned error: 50[0234]\\b',
        'HTTP 4(?:08|29)\\b',
        'returned error: 4(?:08|29)\\b',
        '\\b429 Too Many Requests',
        '\\b408 Request Time-?out',
        '\\b50[0234] (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)',
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'EAI_AGAIN',
        'EPIPE',
        'socket hang up',
        'connection reset',
        'timed out',
        'i/o timeout',
        'TLS handshake timeout',
        'Could not resolve host',
        'Failed to connect',
    ].join('|'),
    'i',
);

// Строка ответа форжа для лога: первая непустая строка, которая не команда. Исключение
// `execFileSync` начинается `Command failed: <команда>` — в лог тогда ушла бы команда, а
// не то, какой отказ увидели. Ответа нет вовсе — честнее отдать команду, чем пустоту.
export function mergeFailureLine(message: string): string {
    const lines = message
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
    return lines.find((l) => !l.startsWith('Command failed:')) ?? lines[0] ?? message;
}

export function classifyMergeFailure(message: string): MergeFailureKind {
    if (MERGE_RATE_LIMIT_RE.test(message)) return 'transient';
    if (MERGE_REFUSAL_RE.test(message)) return 'refusal';
    if (MERGE_TRANSIENT_RE.test(message)) return 'transient';
    return 'unknown';
}

// Класс отказа мерджа словами — одна формулировка на лог гейта и стоп петли (#123):
// пока каждое место писало свою, тексты расходились при первой правке.
export function describeMergeFailure(
    kind: MergeFailureKind,
    { attempts, retryMaxMs }: { attempts: number; retryMaxMs: number },
): string {
    if (kind === 'refusal') return 'отказ форжа по существу, повтором не лечится';
    if (kind === 'transient') {
        return (
            `транзиентные отказы форжа дольше предела ${String(Math.round(retryMaxMs / 60000))} мин ` +
            `(${String(attempts)} попыток)`
        );
    }
    return 'отказ форжа не распознан и после повтора';
}

// Предел по времени на повторы транзиента — от первого отказа. Десять минут — порядок
// окна, в котором слоистый сбой площадки на памяти проходил, и всё ещё меньше одного
// повторного гейта с e2e.
export const DEFAULT_MERGE_RETRY_MAX_MS = 10 * 60 * 1000;
// Первая пауза — прежние 30 с (столько ждал единственный повтор до #47), дальше удвоение
// с потолком: пауза дольше двух минут при пределе в десять дала бы всего пару попыток.
export const MERGE_RETRY_BASE_MS = 30_000;
export const MERGE_RETRY_MAX_PAUSE_MS = 2 * 60 * 1000;

// Пауза перед повтором после попытки N (1-индексация). Остатком предела её обрезает
// вызывающий — эта функция предела не знает.
export function mergeRetryPauseMs(attempt: number): number {
    return Math.min(MERGE_RETRY_BASE_MS * 2 ** (attempt - 1), MERGE_RETRY_MAX_PAUSE_MS);
}

// Ключ конфига `mergeRetryMaxMs` (рядом с `apiLimitMaxWaits`). Нет — дефолт, сказанный
// здесь. Есть, но не целое положительное — fail-closed: `0` или опечатка в единицах
// молча вернули бы мердж к одной попытке ровно на той ночи, ради которой ключ заведён.
export function resolveMergeRetryMaxMs(
    cfg: { mergeRetryMaxMs?: unknown } | undefined,
    failFn: (msg: string) => unknown,
): number {
    const raw = cfg?.mergeRetryMaxMs;
    if (raw === undefined) return DEFAULT_MERGE_RETRY_MAX_MS;
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
    failFn(
        `ralph.config.json: mergeRetryMaxMs = ${JSON.stringify(raw)} — ожидалось целое ` +
            'положительное число миллисекунд (предел повторов мерджа на транзиентных отказах форжа).',
    );
    return DEFAULT_MERGE_RETRY_MAX_MS;
}
