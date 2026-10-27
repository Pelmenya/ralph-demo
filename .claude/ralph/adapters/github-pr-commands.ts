// #72 (хвост #55): команды форжа по PULL REQUEST'ам, переехавшие из `core/orchestrator.ts`.
//
// Пара к `github-issue-commands.ts`: там — карточки, здесь — pull request'ы (комментарии
// ревью, голова PR, заведение PR фазы, поиск открытого PR ветки). Примитивы мердж-пути
// (мердж, «фаза смерджена», метка blocked) уехали раньше, в #55, и лежат в
// `github-forge-commands.ts` — файлы остаются раздельными намеренно: у них разные
// потребители и разные режимы отказа, а слияние дало бы модуль, который читают только
// грепом.
//
// Валидация формы остаётся у ЯДРА и приезжает сюда инъекцией (`prNumberRe`, `sha40Re`) —
// тем же приёмом, что в `github-forge-commands.ts`. Своя копия регэкспа разошлась бы с
// ядром по флагам: #55-ревью нашло ровно такое расхождение по `i`.
import type { NewPullRequest, NewReviewComment, PullRequest, ReviewComment } from './adapters.ts';

type ExecOpts = { env?: NodeJS.ProcessEnv };
type ShArgvFn = (file: string, args: string[], opts?: ExecOpts) => string;
type GhJsonFn = <T = unknown>(cmd: string, attempts?: number) => T;
type LogFn = (msg: string) => void;

export type GithubPrCommandsEnv = {
    shArgv: ShArgvFn;
    ghJson: GhJsonFn;
    shq: (value: unknown) => string;
    log: LogFn;
    /** Фильтр номера PR перед argv и шелл-строкой: `--flag`-образное значение форж
     *  распарсил бы как флаг (инв. 7). */
    prNumberRe: RegExp;
    /** Проверка sha головы перед сборкой inline-комментария. */
    sha40Re: RegExp;
};

/**
 * Команды форжа по pull request'ам для GitHub CLI. Тексты сообщений, режимы отказа и
 * DI-каналы перенесены дословно — сценарные сьюты зовут эти функции через ре-экспорт
 * оркестратора и остаются зелёными без правок ассертов.
 */
export function createGithubPrCommands(env: GithubPrCommandsEnv) {
    const { shArgv, ghJson, shq, log, prNumberRe, sha40Re } = env;

    /**
     * Годность номера PR — ОДНО правило на модуль (#72-ревью). До этого их было два:
     * `prComments` проверял `Number.isInteger && > 0` своей копией, а `prHeadSha` —
     * инъектированным `prNumberRe`, и оба приехали из оркестратора дословно. В общем
     * файле расхождение читается как случайность, а докблок модуля обещает обратное:
     * правило ФОРМЫ приходит инъекцией, чтобы не разойтись с ядром по флагам.
     *
     * Строгость взята по максимуму из двух: форма — инъекцией, положительность — здесь.
     * `prNumberRe` (`^\d+$`) пропускает ноль, а номера PR #0 не бывает; ослабить проверку
     * ради единообразия значило бы пустить в argv значение, которого форж не знает.
     */
    function assertPrNumber(prNumber: number, what: string): void {
        if (!prNumberRe.test(String(prNumber)) || !(Number(prNumber) > 0)) {
            throw new Error(
                `${what}: некорректный номер PR ('${String(prNumber)}') — ` +
                    'не похож на целое положительное, в форж его не пускаем.',
            );
        }
    }

    // #37: комментарии PR — раньше за ними ходил сам счётчик находок
    // (`scripts/review-findings.mjs`) через `gh api`. Считалка severity не имеет причин
    // знать про форж, а на площадке без `gh` тот вызов падал бы и обнулял метрику
    // молча — fail-open вызов «не смог посчитать» неотличим от честного «находок нет».
    //
    // Поверхностей у GitHub три, и промпт ревью размечает меткой severity все:
    // реплики треда (`issues/comments`), inline-комментарии ревью (`pulls/comments`) и
    // сводное тело каждого прохода (`pulls/reviews[].body`). Последнее помечается
    // `isSummary`: оно ДУБЛИРУЕТ находки inline-комментариев того же прохода.
    //
    // `{owner}/{repo}` — плейсхолдеры `gh api`, подставляет сам gh по текущему репозиторию
    // (тот же приём, что у остальных `gh api`-чтений). `--paginate` на ответе-массиве
    // конкатенирует страницы в один JSON-массив.
    //
    // Fail-closed: ghJson бросает при сбое `gh` и невалидном JSON, ответ неожиданной формы
    // (не массив) — тоже отказ. Мягкое «пропустим и посчитаем как пусто» здесь означало бы
    // тихо заниженную метрику от одного транзиентного чиха.
    function prComments(
        prNumber: number,
        { ghJsonFn = ghJson }: { ghJsonFn?: GhJsonFn } = {},
    ): ReviewComment[] {
        assertPrNumber(prNumber, 'Комментарии PR');
        const surfaces: Array<{ endpoint: string; isSummary: boolean }> = [
            {
                endpoint: `repos/{owner}/{repo}/issues/${String(prNumber)}/comments`,
                isSummary: false,
            },
            {
                endpoint: `repos/{owner}/{repo}/pulls/${String(prNumber)}/comments`,
                isSummary: false,
            },
            { endpoint: `repos/{owner}/{repo}/pulls/${String(prNumber)}/reviews`, isSummary: true },
        ];
        const out: ReviewComment[] = [];
        for (const { endpoint, isSummary } of surfaces) {
            const items = ghJsonFn<unknown>(`gh api ${endpoint} --paginate`);
            if (!Array.isArray(items)) {
                throw new Error(
                    `gh api ${endpoint} вернул не массив — формат ответа неожиданный ` +
                        `(получено: ${JSON.stringify(items).slice(0, 200)}).`,
                );
            }
            for (const raw of items) {
                const item = raw as { body?: unknown; user?: { login?: unknown } };
                const body = typeof item.body === 'string' ? item.body : '';
                // Пустое тело — обычное дело у прохода ревью без сводного текста.
                if (!body.trim()) continue;
                out.push({ body, isSummary, author: String(item.user?.login ?? '') });
            }
        }
        return out;
    }

    // #49: sha головы PR — GitHub-реализация шва `pullRequestHeadSha`. Живёт ЗДЕСЬ, рядом с
    // прочими чтениями форжа, а не в gate.ts: гейт спрашивает голову у шва, потому что
    // команда `gh` внутри гейта делала мердж-путь непроходимым на любой площадке без
    // GitHub CLI (три ретрая → 'not-merged' навсегда).
    //
    // Fail-closed по контракту шва: `ghJson` бросает на сбое `gh` и битом JSON, а ответ без
    // `headRefOid` — тоже отказ. Пустая строка вместо исключения увела бы гейт в ветку
    // «голова не похожа на sha»: тот же отказ мерджа, но с неверной причиной в логе.
    // Формат sha проверяет вызывающий (sha40Re) — значение уходит в argv git-команд.
    function prHeadSha(
        prNumber: number,
        { ghJsonFn = ghJson }: { ghJsonFn?: GhJsonFn } = {},
    ): string {
        // Номер уходит в ШЕЛЛ-строку чтения (ghJson), поэтому фильтруется здесь, а не только
        // у поставщика: в gate.ts это место закрывал `shq(prNumber)`, и при переезде канал
        // остался бы без замка. Оба сегодняшних поставщика номер валидируют (`prNumberRe`
        // в findOpenPr, разбор slug у площадки) — фильтр стоит одну строку и закрывает канал
        // структурно, не полагаясь на добросовестность вызывающего (инв. 7).
        assertPrNumber(prNumber, 'Голова PR');
        const head = ghJsonFn<{ headRefOid?: unknown }>(
            `gh pr view ${String(prNumber)} --json headRefOid`,
        );
        const sha = String(head.headRefOid ?? '').trim();
        if (!sha) {
            throw new Error(
                `Голову PR #${String(prNumber)} прочитать не удалось: в ответе форжа нет headRefOid.`,
            );
        }
        return sha;
    }

    // #45: комментарий в PR от имени раннера. Мутация — через argv (`shArgv`), не строкой
    // в шелл: тело пишет модель, читавшая чужой дифф (C3), и интерпретатора в этом пути
    // быть не должно.
    //
    // Поверхность зависит от якоря, и это не оптимизация: без него у GitHub нет способа
    // положить комментарий к строке, а с ним — обязателен `commit_id`. Sha головы берём
    // сами (тем же `prHeadSha`, что отдан гейту через шов): требовать его от вызывающего
    // значило бы протащить деталь GitHub в контракт шва, где второй реализации она не
    // нужна вовсе.
    function commentOnPr(
        prNumber: number,
        input: NewReviewComment,
        {
            runArgvFn = shArgv,
            ghJsonFn = ghJson,
        }: { runArgvFn?: ShArgvFn; ghJsonFn?: GhJsonFn } = {},
    ): void {
        const anchor = input.anchor;
        if (!anchor) {
            runArgvFn('gh', [
                'api',
                `repos/{owner}/{repo}/issues/${String(prNumber)}/comments`,
                '-f',
                `body=${input.body}`,
            ]);
            return;
        }
        const where =
            anchor.line === undefined ? anchor.path : `${anchor.path}:${String(anchor.line)}`;
        let sha = '';
        let headErr = '';
        try {
            sha = prHeadSha(prNumber, { ghJsonFn });
        } catch (e: unknown) {
            // Причину НЕСЁМ дальше, а не схлопываем: «форж недоступен» и «в ответе нет
            // headRefOid» чинятся по-разному, и до вынесения чтения в отдельную функцию
            // сетевой отказ долетал сюда со своим текстом.
            headErr = (e as Error).message;
        }
        if (!sha40Re.test(sha)) {
            // Комментарий к строке без sha головы GitHub не примет, а «положим тогда общим
            // комментарием» — тихая подмена: у площадки именно якорь отличает находку от
            // сводки, и находка молча ушла бы в unmarked.
            throw new Error(
                `Комментарий к ${where} в PR #${String(prNumber)}: ` +
                    `не удалось получить sha головы${headErr ? ` (${headErr})` : ''}, ` +
                    'без неё inline-комментарий невозможен.',
            );
        }
        // #41: сторона — из якоря. Прошитый `RIGHT` вешал замечание к удалённой строке на
        // строку с тем же номером в НОВОЙ версии файла, то есть на чужой код.
        // #575: якорь без строки — комментарий уровня ФАЙЛА, тот же эндпоинт с
        // `subject_type=file`. `line`/`side` в него не кладём вовсе: с ними GitHub снова
        // ждёт строку в изменённом ханке и снова отвечает 422 — то есть ступень отката
        // была бы декоративной.
        const place =
            anchor.line === undefined
                ? ['-f', 'subject_type=file']
                : ['-F', `line=${String(anchor.line)}`, '-f', `side=${anchor.side ?? 'RIGHT'}`];
        runArgvFn('gh', [
            'api',
            `repos/{owner}/{repo}/pulls/${String(prNumber)}/comments`,
            '-f',
            `body=${input.body}`,
            '-f',
            `commit_id=${sha}`,
            '-f',
            `path=${anchor.path}`,
            ...place,
        ]);
    }

    // #46: PR фазы на стороне GitHub. Мутация через argv (заголовок и тело собирает
    // раннер, но канал шелла тут не нужен как класс). `gh pr create` печатает URL
    // созданного PR — номер берём из хвоста, тем же приёмом, что у createIssue.
    function createPr(
        { branch, title, body }: NewPullRequest,
        { runArgvFn = shArgv }: { runArgvFn?: ShArgvFn } = {},
    ): number | null {
        const out = String(
            runArgvFn('gh', [
                'pr',
                'create',
                '--base',
                'main',
                '--head',
                branch,
                '--title',
                title,
                '--body',
                body,
            ]) ?? '',
        ).trim();
        const num = Number(/(\d+)\s*$/.exec(out)?.[1] ?? '');
        return Number.isInteger(num) && num > 0 ? num : null;
    }

    // #127: сбой чтения БРОСАЕТ, а не отдаёт null. Раньше `catch` здесь писал лог и
    // возвращал null — «PR нет» для петли и панели, тогда как SourceCraft на том же сбое
    // бросал. Две реализации одного шва разошлись по режиму отказа, и на GitHub ветка
    // «PR нет» после сбоя форжа заводила бы второй PR вместо стопа. null остаётся ответом
    // форжа: PR нет, их больше одного, номер не похож на целое.
    function findOpenPr(
        branch: string,
        { ghJsonFn = ghJson, logFn = log }: { ghJsonFn?: GhJsonFn; logFn?: LogFn } = {},
    ): PullRequest | null {
        // --base main (M5): PR из этой же ветки в ДРУГУЮ базу мерджить нельзя —
        // фаза «сдалась» бы мимо main, а следующая строилась бы без неё.
        const prs = ghJsonFn<PullRequest[]>(
            `gh pr list --head ${shq(branch)} --base main --state open --json number,labels`,
        );
        if (!Array.isArray(prs)) {
            // Ответ не список — форж ответил не то, что спрашивали. Это сбой чтения, а не
            // «PR нет»: `[]` и мусор обязаны быть различимы.
            throw new Error(`список PR ветки ${branch} от форжа — не массив`);
        }
        if (prs.length > 1) {
            // M5: несколько открытых PR на одну ветку — prs[0] был бы произвольным
            // выбором с непредсказуемым результатом. Fail-closed: разберёт человек.
            logFn(
                `⛔ Несколько открытых PR из ветки ${branch} в main: ${prs.map((p) => `#${p.number}`).join(', ')} — неоднозначно, авто-мердж отменён.`,
            );
            return null;
        }
        const pr = prs[0] || null;
        if (pr && !prNumberRe.test(String(pr.number))) {
            // Fail-closed: номер не похож на целое → в argv/шелл его не пускаем.
            logFn(
                `⛔ Номер PR ветки ${branch} не похож на целое ('${pr.number}') — авто-мердж отменён.`,
            );
            return null;
        }
        return pr;
    }

    return { prComments, prHeadSha, commentOnPr, createPr, findOpenPr };
}
