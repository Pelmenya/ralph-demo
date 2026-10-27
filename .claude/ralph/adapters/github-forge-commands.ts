// #55: команды форжа, переехавшие из `core/gate.ts`. Хвост #49: там голова PR ушла в шов
// `pullRequestHeadSha`, и мердж-путь стал проходим на площадке целиком, но GitHub-реализации
// четырёх примитивов остались физически лежать внутри гейта.
//
// Роутинг через шов был и до переезда: `runLoop` берёт их из `adapters.taskSource`, а не из
// замыкания гейта. То есть это гигиена расположения, а не мёртвый путь — но гигиена с ценой:
// пока команды конкретного форжа живут в ядре, «гейт» и «GitHub-адаптер» читаются как один
// модуль, и следующий такой же вызов (как `gh pr view` в #49) снова окажется незамеченным.
// Барьер `MERGE_PATH_BOUND_SEAMS` сторожит подмену швов, а не то, что ядро исполняет само.
//
// Сторожит переезд греп-барьер в `tests/core-purity.test.ts` (#55): в очищенных модулях
// ядра нет команд `gh`/`glab`. Барьер важнее самого переезда — он и есть механизм, не
// дающий классу вернуться.
// Типы коллабораторов — локальные, как в остальных модулях ралфа: общего `shared/types`
// в раскладке нет, а заводить его ради трёх сигнатур значит трогать все модули разом.
type ExecOpts = { env?: NodeJS.ProcessEnv };
type ShFn = (cmd: string, opts?: ExecOpts) => string;
type ShArgvFn = (file: string, args: string[], opts?: ExecOpts) => string;
type LogFn = (msg: string) => void;

export type GithubForgeCommandsEnv = {
    sh: ShFn;
    shArgv: ShArgvFn;
    shq: (s: string) => string;
    log: LogFn;
    ghJson: <T>(cmd: string) => T;
    /** Anti-injection для имени ветки (инв. C3/7) — общий с ядром. */
    safeBranch: (branch: string, opts: { logFn: LogFn; where: string }) => boolean;
    /** Фильтр номера PR перед argv: `--flag`-образное значение gh распарсил бы как флаг. */
    prNumberRe: RegExp;
    /** Проверка sha перед `--match-head-commit`. Инжектится, а не дублируется константой:
     *  своя копия разошлась бы с ядром по флагам (#55-ревью нашёл расхождение по `i`). */
    sha40Re: RegExp;
};

type BlockedLabelOpts = { shFn?: ShFn; runArgvFn?: ShArgvFn; logFn?: LogFn };

/**
 * Четыре примитива форжа для GitHub CLI: мердж PR, две проверки «фаза смерджена» и
 * простановка/снятие метки blocked. Тексты логов и поведение перенесены дословно —
 * переезд не должен менять наблюдаемое поведение петли (критерий #55: сценарные сьюты
 * зелёные без правок ассертов).
 */
export function createGithubForgeCommands(env: GithubForgeCommandsEnv) {
    const { sh, shArgv, shq, log, ghJson, safeBranch, prNumberRe, sha40Re } = env;

    // Снятие и возврат метки — ЗЕРКАЛЬНЫЕ операции: тот же поиск PR, тот же фильтр номера,
    // тот же anti-injection путь и то же fail-open поведение — различаются лишь gh-флагом и
    // текстами лога. Раньше это были два почти дословных тела (~40 строк каждое): правка
    // общей части требовала синхронного внесения в оба, и их дрейф ничем не ловился.
    const BLOCKED_LABEL_COPY = {
        remove: {
            where: 'removeBlockedLabel',
            ghFlag: '--remove-label',
            noPr: (branch: string) =>
                `⚠ removeBlockedLabel: открытый PR ветки ${branch} не найден — метку не снимаю.`,
            badNum: (branch: string, num: string) =>
                `⚠ removeBlockedLabel: номер PR ветки ${branch} не похож на целое ('${num}') — метку не снимаю.`,
            done: (num: string) =>
                `🏷 Раннер снял label blocked с PR #${num} перед повторным ревью (#217).`,
            fail: (msg: string) =>
                `⚠ removeBlockedLabel не снял метку (гейт подберёт blocked): ${msg}`,
        },
        add: {
            where: 'addBlockedLabel',
            ghFlag: '--add-label',
            noPr: (branch: string) =>
                `⚠ addBlockedLabel: открытый PR ветки ${branch} не найден — метку не вернул.`,
            badNum: (branch: string, num: string) =>
                `⚠ addBlockedLabel: номер PR ветки ${branch} не похож на целое ('${num}') — метку не вернул.`,
            done: (num: string) =>
                `🏷 Раннер вернул label blocked на PR #${num} — повторное ревью не дало вердикта (#223).`,
            fail: (msg: string) => `⚠ addBlockedLabel не вернул метку: ${msg}`,
        },
    } as const;

    // Режим отказа РАЗНЫЙ у двух операций, и это часть контракта, а не мелочь формулировки:
    //  • не смогли СНЯТЬ — метка остаётся, гейт увидит blocked и уведёт круг разбора дальше
    //    (fail-closed: петля не мерджит непроверенное);
    //  • не смогли ВЕРНУТЬ — метки нет, и гейт её не увидит (fail-open: косметика не имеет
    //    права ронять цикл сдачи; страхует сверка раннера, см. `.claude/ralph/CLAUDE.md`).
    // Обе идемпотентны и не бросают наружу.
    // Имя ветки — только через safeBranch и shq (anti-injection, инв. C3/7). #252: сама
    // мутация (`gh pr edit`) — через argv, не строкой через шелл; чтение (`gh pr list`)
    // остаётся на shFn (не мутация, класс риска закрыт shq — #194); DI — предохранитель #138.
    function setBlockedLabel(
        branch: string,
        action: 'add' | 'remove',
        { shFn = sh, runArgvFn = shArgv, logFn = log }: BlockedLabelOpts = {},
    ): void {
        const copy = BLOCKED_LABEL_COPY[action];
        if (!safeBranch(branch, { logFn, where: copy.where })) return;
        try {
            const num = String(
                shFn(
                    `gh pr list --head ${shq(branch)} --state open --json number --jq '.[0].number // empty'`,
                ),
            ).trim();
            if (!num) {
                logFn(copy.noPr(branch));
                return;
            }
            if (!prNumberRe.test(num)) {
                logFn(copy.badNum(branch, num));
                return;
            }
            runArgvFn('gh', ['pr', 'edit', num, copy.ghFlag, 'blocked']);
            logFn(copy.done(num));
        } catch (e: unknown) {
            logFn(copy.fail(String((e as Error)?.message ?? e).split('\n')[0]));
        }
    }

    function removeBlockedLabel(branch: string, opts: BlockedLabelOpts = {}): void {
        setBlockedLabel(branch, 'remove', opts);
    }

    function addBlockedLabel(branch: string, opts: BlockedLabelOpts = {}): void {
        setBlockedLabel(branch, 'add', opts);
    }

    // Фаза уже смерджена (авто-мерджем прошлого прогона ИЛИ вручную человеком)?
    // БРОСАЕТ при недоступности gh (после ретраев ghJson): «не смог проверить» и
    // «не смерджена» — принципиально разные ответы; молчаливый false заставил бы
    // preflight-инвариант C4 падать с ложной причиной, а loop — пересоздавать PR уже
    // смердженной фазы.
    function phaseMerged(phase: { branch: string }): boolean {
        const merged = ghJson<Array<{ number: number }>>(
            `gh pr list --head ${shq(phase.branch)} --base main --state merged --json number --limit 1`,
        );
        return merged.length > 0;
    }

    // Номер смердженного PR фазы (или null) — нужен пути «фаза уже смерджена» (#237):
    // там recordReviewFindings не имеет lastGatePr (гейт не прогонялся), и без номера
    // авто-половина метрики терялась бы молча.
    function mergedPhasePr(phase: { branch: string }): number | null {
        const merged = ghJson<Array<{ number: number }>>(
            `gh pr list --head ${shq(phase.branch)} --base main --state merged --json number --limit 1`,
        );
        return merged.length > 0 ? merged[0].number : null;
    }

    // Squash-мердж одной командой — гранулярная операция форжа, которую tryMergePhase
    // (оркестрация сдачи) зовёт ПОСЛЕ зелёного гейта. argv (#193): номер PR и sha —
    // отдельными элементами, не в шелл-строку. `--match-head-commit` только при валидном
    // sha (#SiaTz, TOCTOU): пусто/невалидно → мердж без привязки (мок checksGreen в тестах
    // sha не выставляет). Ретрай и сверку phaseMerged держит tryMergePhase — это
    // композиция, а не примитив.
    function mergePr(
        prNumber: number,
        headSha?: string | null,
        { runArgvFn = shArgv }: { runArgvFn?: ShArgvFn } = {},
    ): void {
        const mergeArgs = ['pr', 'merge', String(prNumber), '--squash', '--delete-branch'];
        if (sha40Re.test(String(headSha))) {
            mergeArgs.push('--match-head-commit', headSha as string);
        }
        runArgvFn('gh', mergeArgs);
    }

    // #16: заведение карточки и её адрес. `gh issue create` печатает URL созданной
    // карточки — номер берём ИЗ URL, а не из хвоста вывода: он теперь не только для лога,
    // а цель второй команды, и «последние цифры строки» при болтливом выводе указали бы на
    // чужую карточку (ревью правок PR !6). Номер не разобрался — карточка ВСЁ РАВНО
    // создана, поэтому null, а не исключение: откатывать нечего, а падение здесь заставило
    // бы петлю повторить создание и наплодить дубли.
    //
    // Веха ставится ОТДЕЛЬНОЙ командой уже после создания. Флагом создания было нельзя: на
    // неизвестной вехе команда падает целиком, карточку не заведя, а отличить этот отказ от
    // транспортного можно только по тексту ошибки — гонка, которую не выиграть. Узкий матч
    // терял карточку на формулировке `could not add to milestone …`, широкий срабатывал на
    // таймауте (в сообщение попадает сама команда, а в ней флаг есть всегда) и повтор
    // создания давал ДУБЛЬ. Разделение снимает оба режима: создание однозначно, а провал
    // адресации стоит адреса, но не находки.
    function createIssue(
        {
            title,
            body,
            labels: names,
            milestone,
        }: { title: string; body: string; labels: readonly string[]; milestone?: string },
        { runArgvFn = shArgv, logFn = log }: { runArgvFn?: ShArgvFn; logFn?: LogFn } = {},
    ): number | null {
        const args = ['issue', 'create', '--title', title, '--body', body];
        for (const name of names) args.push('--label', name);
        const out = String(runArgvFn('gh', args) ?? '').trim();
        // Номеров в выводе может оказаться несколько (предупреждение форжа со ссылкой на
        // соседнюю карточку — обычное дело), и «взять первый» ничем не лучше «взять
        // последний»: и то и другое угадывает порядок чужого вывода, а ценой ошибки будет
        // `issue edit` по ЧУЖОЙ карточке. Поэтому неоднозначность — отказ разбирать:
        // карточка создана, но её номер мы честно не знаем.
        const found = [...out.matchAll(/\/issues\/(\d+)(?:\D|$)/g)].map((m) => Number(m[1]));
        const unique = [...new Set(found.filter((n) => Number.isInteger(n) && n > 0))];
        const num = unique.length === 1 ? unique[0] : null;
        if (unique.length > 1) {
            logFn(
                `⚠ В выводе форжа несколько номеров карточек (${unique.join(', ')}) — какой из них ` +
                    `у «${title}», неизвестно. Карточка создана; ничего по этому номеру не правлю.`,
            );
        }
        if (!milestone) return num;
        if (num === null) {
            logFn(
                `⚠ Номер новой карточки «${title}» не разобран из вывода форжа — адресовать ` +
                    `её в веху «${milestone}» нечем, карточка осталась без адреса.`,
            );
            return num;
        }
        try {
            runArgvFn('gh', ['issue', 'edit', String(num), '--milestone', milestone]);
        } catch (e: unknown) {
            logFn(
                `⚠ Веха «${milestone}» карточке #${String(num)} не поставлена ` +
                    `(${String((e as Error)?.message ?? '').split('\n')[0]}) — сама карточка заведена.`,
            );
        }
        return num;
    }

    return {
        createIssue,
        mergePr,
        phaseMerged,
        mergedPhasePr,
        addBlockedLabel,
        removeBlockedLabel,
    };
}
