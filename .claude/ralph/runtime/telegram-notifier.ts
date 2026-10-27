// Node-модуль отправки уведомлений в Telegram (бот → человек), issue #85.
//
// Односторонний канал: только исходящий sendMessage, без обработки апдейтов от
// бота. Токен и chat_id — СТРОГО из env (RALPH_TG_BOT_TOKEN / RALPH_TG_CHAT_ID),
// не из ralph.config.json и не из репозитория: конфиг коммитится в гит, история
// которого публичная и необратимая — секрету там не место (см. provision/ralph.env.example,
// тот же паттерн, что и GH_TOKEN/CLAUDE_CODE_OAUTH_TOKEN).
//
// Вызов Telegram Bot API — curl через execFileSync (argv-массив), тот же anti-RCE
// паттерн, что и probeEgress/restartTunnel в tunnel-check.ts (#92/#98): текст сообщения
// приходит из данных, которые пишет кто угодно (заголовок issue с публичного
// GitHub), --data-urlencode кодирует его без участия шелла. parse_mode сознательно
// не задаём: Markdown/HTML-режимы Telegram требуют экранирования спецсимволов в
// тексте — без этого сообщение с "непарной" звёздочкой или скобкой просто не
// отправится (400 Bad Request), а разбирать это экранирование ради уведомлений не
// стоит своих рисков.
//
// Fail-open: sendTelegramMessage никогда не бросает наружу — сбой (нет токена/
// chat_id, сеть, rate-limit или отказ Telegram API) не должен ронять loop раннера,
// только не долетает уведомление. Возвращает boolean успеха.
//
// Ретраи (#224): один транзиентный сетевой чих не должен терять громкое событие
// (API-лимит, blocked, breaker, красный деплой). Паттерн — как у `ghJson` в
// core/exec.ts: нарастающая пауза `retryBaseMs × номер попытки`, дефолт 3 попытки.
// sleepFn инжектируется (как sleepFn у checkProdHealth/ensureTunnel) — тесты не
// ждут реальные секунды. Если все попытки исчерпаны — fail-open сохраняется
// (возвращаем false, не бросаем), но в лог уходит заметная строка с полным
// текстом события, чтобы его можно было найти при разборе постфактум.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
// Модуль самостоятелен (не require/import ядро — ralph.js/orchestrator.ts): требуется
// одинаково через require() из CJS-entry (ralph.js) и через createRequire из
// .mjs-скриптов гейта (security-audit.mjs) — циклической
// зависимости на ядро тут нет, предохранитель и журнал берутся из
// shared/side-effect-guard.ts (#145).

import { execFileSync } from 'node:child_process';
import { positiveIntOrDefault, sleep as realSleep } from '../shared/ralph-util.ts';
import {
    sideEffectAttempts,
    guardSideEffect as sharedGuardSideEffect,
} from '../shared/side-effect-guard.ts';

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

// Telegram режет sendMessage на 4096 символах: более длинный текст вернёт 400, и
// fail-open молча съест уведомление. Обрезаем заранее — заголовок issue в событии
// вполне может однажды перевалить лимит.
const TELEGRAM_MAX_TEXT = 4096;

export const TELEGRAM_DEFAULT_ATTEMPTS = 3;
export const TELEGRAM_RETRY_BASE_MS = 5000;

export { sideEffectAttempts };

type ExecFn = (file: string, args: string[], opts?: Record<string, unknown>) => string;
type LogFn = (msg: string) => void;
type SleepFn = (ms: number) => void;

type TelegramConfig = {
    token: string;
    chatId: string;
};

type AttemptSendResult = {
    ok: boolean;
    reason: string;
    retryAfterMs?: number;
    retriable?: boolean;
};

type SendOptions = {
    token?: string;
    chatId?: string;
    execFn?: ExecFn;
    logFn?: LogFn;
    sleepFn?: SleepFn;
    attempts?: number;
    retryBaseMs?: number;
};

function guardSideEffect(what: string): void {
    sharedGuardSideEffect(what, 'Подмени execFn в опциях sendTelegramMessage.');
}

const realExecFn: ExecFn = (...args) => {
    guardSideEffect(`telegram execFileSync(${args[0]})`);
    return (execFileSync as ExecFn)(...args);
};

// Читает секреты строго из env — ralph.config.json коммитится в гит, там
// токену/chat_id не место.
export function telegramConfigFromEnv(): TelegramConfig {
    return {
        token: (process.env.RALPH_TG_BOT_TOKEN || '').trim(),
        chatId: (process.env.RALPH_TG_CHAT_ID || '').trim(),
    };
}

// Коды curl, которые различают «сеть моргнула» и «канал перекрыт» (#48). Остальные
// называются числом: выдуманная расшифровка хуже честного номера.
const CURL_EXIT_MEANINGS: Record<number, string> = {
    6: 'DNS не резолвится',
    7: 'не соединился',
    28: 'таймаут',
    35: 'оборвался TLS',
};

const CURL_STDERR_MAX = 200;

// Причина отказа curl для лога (#48). Раньше в лог шла первая строка e.message —
// у execFileSync это `Command failed: <вся команда>`: без кода возврата, зато с
// chat_id и текстом уведомления в открытом виде. Четыре разных отказа (6/7/28/35)
// выглядели одинаково, и разбор «все три попытки упали» начинался бы с нуля. Теперь
// берём status и stderr из полей ошибки, а команду не берём вовсе. Секреты
// (токен, chat_id) маскируются и в stderr: curl их туда не пишет, но лог тейлится
// монитором и копируется в чат — надеяться на формат чужой утилиты здесь нельзя.
function describeCurlFailure(e: unknown, secrets: string[]): string {
    const err = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    const mask = (s: string): string => {
        let out = s;
        // Пустой секрет сюда не доходит (ранний return в sendTelegramMessage), но
        // пустой шаблон вставил бы маску между каждой буквой — страхуемся. Маска — по
        // границе числа, а не подстрокой, и код отказа `curl: (N)` она не трогает:
        // короткий числовой chat_id (`28`, `1`) иначе съел бы цифры внутри текста curl,
        // и причина стала бы нечитаемой.
        for (const secret of secrets.filter((x) => x !== '')) {
            const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(curl: \\(\\d+\\))|(?<!\\d)${escaped}(?!\\d)`, 'g');
            out = out.replace(re, (_m, code: string | undefined) => code ?? '***');
        }
        return out;
    };
    const clip = (s: string): string => {
        const oneLine = s.replace(/\s+/g, ' ').trim();
        const chars = [...oneLine];
        return chars.length > CURL_STDERR_MAX
            ? `${chars.slice(0, CURL_STDERR_MAX).join('')}…`
            : oneLine;
    };
    const stderr = clip(mask(err.stderr == null ? '' : String(err.stderr)));
    const withStderr = (head: string): string => (stderr ? `${head} — ${stderr}` : head);

    if (typeof err.status === 'number') {
        const meaning = CURL_EXIT_MEANINGS[err.status];
        return withStderr(`код curl ${err.status}${meaning ? ` (${meaning})` : ''}`);
    }
    if (typeof err.signal === 'string' && err.signal) {
        return withStderr(`curl убит сигналом ${err.signal}`);
    }
    if (typeof err.code === 'string' && err.code) {
        return withStderr(`curl не запустился (${err.code})`);
    }
    // Ни кода, ни сигнала: ошибка не от execFileSync (подменённый исполнитель,
    // неожиданный бросок). Первая строка message — всё, что есть; маскируем и режем.
    const message = err.message == null ? String(e) : String(err.message);
    return clip(mask(message.split('\n')[0]));
}

// Один HTTP-запрос к Bot API. Не бросает — возвращает {ok, reason}, reason
// заполнен только при ok=false (для лога попытки/финального отказа).
function attemptSend({
    execFn,
    curlConfig,
    finalChatId,
    finalToken,
    safeText,
}: {
    execFn: ExecFn;
    curlConfig: string;
    finalChatId: string;
    finalToken: string;
    safeText: string;
}): AttemptSendResult {
    try {
        const raw = execFn(
            'curl',
            [
                '-s',
                // -S возвращает в stderr строку ошибки `curl: (N) …`, которую -s глушит:
                // без неё разбор отказа (#48) знал бы только код, без слов curl.
                '-S',
                '--max-time',
                '10',
                // api.telegram.org из РФ доступен напрямую (разблокирован с 2020) —
                // ходить к нему через SS-туннель нельзя: событие «туннель красный»
                // стреляет ровно тогда, когда этот маршрут мёртв, и единственный пуш,
                // ради которого канал заведён, гарантированно не долетел бы. --noproxy
                // делает обход прокси безусловным, не завися от NO_PROXY в env.
                '--noproxy',
                'api.telegram.org',
                // -X POST не нужен: curl сам шлёт POST при любом --data-* (в т.ч.
                // --data-urlencode). Явный -X ещё и вреден при появлении редиректа —
                // заставил бы слать POST после 30x, где curl сам переключился бы верно.
                '--config',
                '-',
                '--data-urlencode',
                `chat_id=${finalChatId}`,
                '--data-urlencode',
                `text=${safeText}`,
            ],
            { encoding: 'utf-8', input: curlConfig, stdio: ['pipe', 'pipe', 'pipe'] },
        );

        // Ответ Telegram — недоверенные данные из сети: JSON.parse даёт `any`, поэтому
        // держим его как unknown и сужаем ПО МЕСТУ (как `cfg: unknown` в deadman.ts), а не
        // утверждаем форму, которую рантайм не проверял. Все обращения ниже толерантны к
        // мусору (Number()/typeof), так что поведение не меняется — вопрос честности типа.
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return {
                ok: false,
                reason: `не удалось разобрать ответ API — ${String(raw).slice(0, 200)}`,
            };
        }
        const res: Record<string, unknown> =
            parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
        if (!res.ok) {
            const code = Number(res.error_code);
            const desc = (typeof res.description === 'string' && res.description) || 'без описания';
            // 429 (rate-limit) — транзиентно, но Telegram сам подсказывает паузу в
            // parameters.retry_after (сек). Уважаем её: фиксированные 5с могли бы повторно
            // упереться в лимит. retryAfterMs !== undefined перекрывает нарастающую паузу.
            if (code === 429) {
                const params = res.parameters;
                const ra =
                    params && typeof params === 'object'
                        ? Number((params as Record<string, unknown>).retry_after)
                        : NaN;
                return {
                    ok: false,
                    reason: `API rate-limit (429) — ${desc}`,
                    retryAfterMs: Number.isInteger(ra) && ra > 0 ? ra * 1000 : undefined,
                };
            }
            // Прочие 4xx (chat not found, bad request, unauthorized) — ПОСТОЯННЫЙ отказ:
            // вторая попытка тем же телом успехом не станет, а раннер синхронно спит
            // секунды на каждом пуше. retriable:false → цикл прекращает ретраи сразу.
            if (Number.isInteger(code) && code >= 400 && code < 500) {
                return {
                    ok: false,
                    reason: `API отклонил сообщение (${code}) — ${desc}`,
                    retriable: false,
                };
            }
            // 5xx / неизвестный код — транзиентно, ретраим (retriable по умолчанию).
            return { ok: false, reason: `API отклонил сообщение — ${desc}` };
        }
        return { ok: true, reason: '' };
    } catch (e: unknown) {
        return {
            ok: false,
            reason: `отправка не удалась — ${describeCurlFailure(e, [finalToken, finalChatId])}`,
        };
    }
}

// execFn инжектируется (как probeEgress/restartTunnel в tunnel-check.ts) — юнит-тесты
// мокают сам вызов curl, не реальную сеть/токен. logFn — куда пишутся
// предупреждения о недоставке; по умолчанию no-op, модуль не обязан знать про
// ralph.log (вызывающий код передаёт свой log()). sleepFn/attempts/retryBaseMs —
// ретраи с нарастающей паузой (#224), см. докблок модуля.
export function sendTelegramMessage(
    text: string,
    {
        token,
        chatId,
        execFn = realExecFn,
        logFn = () => {},
        sleepFn = realSleep,
        attempts = TELEGRAM_DEFAULT_ATTEMPTS,
        retryBaseMs = TELEGRAM_RETRY_BASE_MS,
    }: SendOptions = {},
): boolean {
    const envCfg = telegramConfigFromEnv();
    const finalToken = token ?? envCfg.token;
    const finalChatId = chatId ?? envCfg.chatId;

    if (!finalToken || !finalChatId) {
        logFn(
            '⚠ Telegram-нотифаер: не заданы RALPH_TG_BOT_TOKEN/RALPH_TG_CHAT_ID — сообщение не отправлено.',
        );
        return false;
    }

    // Токен — секрет, а в argv он виден в `ps`/`/proc/*/cmdline` всё время запроса.
    // Прячем URL с токеном в curl-конфиг, который curl читает со stdin (--config -):
    // в argv остаются только флаги. chat_id/text — не секреты, оставляем их там же
    // через --data-urlencode (шелл не участвует, argv-массив). Токен бота имеет вид
    // `\d+:[A-Za-z0-9_-]+` — ни кавычек, ни бэкслэшей, поэтому значение в конфиге
    // безопасно взять в кавычки, а untrusted-текст в конфиг НЕ попадает (иначе `"`
    // из заголовка issue закрыл бы строку раньше времени).
    const url = `${TELEGRAM_API_BASE}/bot${finalToken}/sendMessage`;
    const curlConfig = `url = "${url}"\n`;
    // Режем по code points, а не по UTF-16-единицам: граница TELEGRAM_MAX_TEXT
    // может попасть в середину суррогатной пары (эмодзи 🔔/⛔/✅ в текстах пушей —
    // как раз пары), тогда в argv уехал бы одинокий суррогат → U+FFFD `�` в UTF-8.
    const safeText = [...String(text)].slice(0, TELEGRAM_MAX_TEXT).join('');

    const totalAttempts = Math.max(1, positiveIntOrDefault(attempts, TELEGRAM_DEFAULT_ATTEMPTS));
    // retryBaseMs валидируем так же, как attempts выше: мусор (NaN, строка) дал бы
    // waitMs=NaN, а Atomics.wait трактует NaN-таймаут как +∞ — realSleep(NaN) повесил бы
    // раннер НАВСЕГДА посреди пуша. Сегодня параметр передают только тесты, но асимметрия
    // валидации приглашает однажды прокинуть его из конфига.
    const base = positiveIntOrDefault(retryBaseMs, TELEGRAM_RETRY_BASE_MS);
    let lastReason = '';
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
        const result = attemptSend({ execFn, curlConfig, finalChatId, finalToken, safeText });
        if (result.ok) return true;
        lastReason = result.reason;
        // Постоянный отказ (4xx, кроме 429): ретрай тем же телом бесполезен — прекращаем
        // сразу, не тратя синхронные паузы раннера на каждом пуше.
        if (result.retriable === false) {
            logFn(
                `⚠ Telegram-нотифаер: постоянный отказ API — ${result.reason} — ретрай бесполезен, прекращаю.`,
            );
            break;
        }
        if (attempt < totalAttempts) {
            // 429 диктует свою паузу (retry_after); иначе — нарастающая base × номер попытки.
            const waitMs = result.retryAfterMs != null ? result.retryAfterMs : base * attempt;
            logFn(
                `⚠ Telegram-нотифаер: попытка ${attempt}/${totalAttempts} не удалась — ${result.reason} — повтор через ${waitMs / 1000}с`,
            );
            sleepFn(waitMs);
        }
    }
    // Последняя попытка исчерпана: fail-open (не бросаем), но громкая строка с
    // ПОЛНЫМ (необрезанным) текстом события — чтобы его можно было найти при
    // разборе лога постфактум, а не только усечённый вариант, ушедший в API.
    logFn(`⚠ Telegram-нотифаер: отправка не удалась — ${lastReason}`);
    logFn(`⚠ ПУШ НЕ ДОСТАВЛЕН: ${String(text)}`);
    return false;
}
