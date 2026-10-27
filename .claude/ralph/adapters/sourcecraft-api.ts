// Синхронный HTTP-транспорт к API SourceCraft для TaskSourceAdapter.
//
// Почему отдельный модуль, а не функция в orchestrator.ts: ядру не место знать про HTTP,
// заголовки и токены — оно оркестрирует петлю. Транспорт живёт рядом с адаптером, который
// его единственный потребитель.
//
// Почему синхронный: синхронно всё ядро (`sh`/`ghJson` поверх execSync), и асинхронный
// клиент потребовал бы переписать петлю целиком.
import { spawnSync } from 'node:child_process';
import { guardSideEffect } from '../shared/side-effect-guard.ts';
import type { SourcecraftApi } from './sourcecraft-task-source.ts';

type SpawnFn = typeof spawnSync;

// Предохранитель #138 висит на БОЕВОМ ДЕФОЛТЕ, а не в теле запроса — как у
// `telegram-notifier.ts`. Раньше он стоял в теле, и подменённый в тесте `spawnFn` всё
// равно упирался в него: транспорт был непроверяем ни одним тестом, а инвариант №2
// требует ровно обратного — боевая побочка сторожится, подменённая свободно проходит.
const realSpawnFn: SpawnFn = ((file, args, opts) => {
    guardSideEffect(`SourceCraft curl ${String(file)}`, 'Подмени spawnFn/api в тесте.');
    return spawnSync(file as string, args as string[], opts as never);
}) as SpawnFn;

export type SourcecraftApiDeps = {
    org: string;
    repo: string;
    // Имя переменной окружения с токеном, а не сам токен: секрет не должен проходить
    // через конфиг в гите (инвариант №11).
    tokenEnv?: string;
    baseUrl?: string;
    spawnFn?: SpawnFn;
    envSource?: NodeJS.ProcessEnv;
};

export const SOURCECRAFT_BASE_URL = 'https://api.sourcecraft.tech';

// Имя переменной с токеном по умолчанию. Экспортировано, потому что его же называет шов
// задач как свой секрет (#56): разойдись эти два места — редакция вырезала бы не ту
// переменную, из которой транспорт на самом деле берёт токен.
export const SOURCECRAFT_TOKEN_ENV = 'SOURCECRAFT_TOKEN';

export function createSourcecraftApi(deps: SourcecraftApiDeps): SourcecraftApi {
    const {
        org,
        repo,
        tokenEnv = SOURCECRAFT_TOKEN_ENV,
        baseUrl = SOURCECRAFT_BASE_URL,
        spawnFn = realSpawnFn,
        envSource = process.env,
    } = deps;

    return (method, path, body) => {
        // Fail-closed на незаполненных координатах и токене. Молча вернуть пустой ответ
        // здесь нельзя: петля прочитала бы это как «очередь фазы пуста» и ушла сдавать
        // недоделанную работу (C2).
        if (!org || !repo) {
            throw new Error(
                'SourceCraft: не заданы org/repo (RALPH_SOURCECRAFT_ORG / RALPH_SOURCECRAFT_REPO).',
            );
        }
        const token = String(envSource[tokenEnv] ?? '');
        if (!token)
            throw new Error(`SourceCraft: переменная ${tokenEnv} пуста — запросы невозможны.`);

        // Токен уходит curl'у через `--config -` со stdin, а НЕ в argv: argv процесса
        // виден в /proc/<pid>/cmdline любому пользователю машины. Тот же приём, что в
        // telegram-notifier.ts. Путь и метод — обычные аргументы, они не секрет.
        const args = [
            '--config',
            '-',
            '-sS',
            '--fail-with-body',
            '-X',
            method,
            `${baseUrl}${path}`,
        ];
        if (body !== undefined) {
            args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
        }
        const res = spawnFn('curl', args, {
            encoding: 'utf-8',
            input: `header = "Authorization: Bearer ${token}"\n`,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (res.status !== 0) {
            const why = String(res.stderr || res.stdout || '').split('\n')[0];
            throw new Error(
                `SourceCraft ${method} ${path}: curl вернул ${String(res.status)} — ${why}`,
            );
        }
        const text = String(res.stdout ?? '').trim();
        if (!text) return {};
        try {
            return JSON.parse(text) as unknown;
        } catch {
            // Не-JSON — это отказ площадки (HTML-страница ошибки, ответ прокси). Бросаем:
            // вернуть {} значило бы показать петле пустую очередь вместо сбоя.
            throw new Error(`SourceCraft ${method} ${path}: ответ не JSON — ${text.slice(0, 200)}`);
        }
    };
}
