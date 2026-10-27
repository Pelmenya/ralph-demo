// Опись путей состояния экземпляра (канон, задача 22 → 25).
//
// Отдельным модулем, а не полем оркестратора: этот же состав читает протокол миграции
// (`runtime-migration.ts`), и импортировать ради него весь оркестратор значило бы тянуть
// в переезд состояния всю петлю. Опись — единственный источник состава: перечисление
// файлов во втором месте разъехалось бы с ней на первом же новом файле состояния.

import path from 'node:path';

/**
 * Пути состояния ВНУТРИ заданного `runtimeDir` — чистая функция, чтобы состав переехавших
 * файлов можно было проверить описью, а не чтением. Имена файлов НЕ меняются: их читают
 * монитор, deadman и человек грепом, и переезд каталога — достаточное изменение за раз.
 */
export type TRuntimePaths = {
    state: string;
    log: string;
    dryLog: string;
    lock: string;
    monitorOut: string;
    monitorPid: string;
    lockMarker: string;
    sessions: string;
    requests: string;
    stopRequest: string;
    stages: string;
    keys: string;
    events: string;
    heartbeat: string;
    dryEvents: string;
    dryHeartbeat: string;
    sessionSettings: string;
    activations: string;
};

export function runtimePathsIn(runtimeDir: string): TRuntimePaths {
    return {
        state: path.join(runtimeDir, 'ralph.state.json'),
        log: path.join(runtimeDir, 'ralph.log'),
        dryLog: path.join(runtimeDir, 'ralph.dry.log'),
        lock: path.join(runtimeDir, 'ralph.lock'),
        monitorOut: path.join(runtimeDir, 'monitor.out'),
        monitorPid: path.join(runtimeDir, 'monitor.pid'),
        lockMarker: path.join(runtimeDir, '.deps-lock.sha'),
        sessions: path.join(runtimeDir, 'sessions'),
        requests: path.join(runtimeDir, 'ralph.requests.jsonl'),
        // #88: запрос мягкой остановки — его кладёт человек, снимает раннер на границе шага.
        stopRequest: path.join(runtimeDir, 'ralph.stop'),
        // #92: журнал этапов текущей кодер-попытки — по нему рестарт продолжает с этапа.
        stages: path.join(runtimeDir, 'ralph.stages.jsonl'),
        // Задача 96: ротация ключей подписки — номер активного и сбросы упёршихся, без
        // значений ключей.
        keys: path.join(runtimeDir, 'ralph.keys.json'),
        // Задача 95: спутники лога — журнал событий и heartbeat. Писатель выводит их из пути
        // лога (`companionPaths`), но опись называет их здесь: иначе переезд состояния унёс
        // бы лог и оставил его журнал в старом каталоге. Совпадение имён с `companionPaths`
        // сверяет тест описи.
        events: path.join(runtimeDir, 'ralph.events.jsonl'),
        heartbeat: path.join(runtimeDir, 'ralph.heartbeat'),
        dryEvents: path.join(runtimeDir, 'ralph.dry.events.jsonl'),
        dryHeartbeat: path.join(runtimeDir, 'ralph.dry.heartbeat'),
        // Задача 101: settings сессии, собранный раннером из ядра и дерева человека. Он
        // пересобирается перед каждой сессией, и лежит здесь, а не в дереве сессии: файл в
        // дереве, которое правит PR, снова был бы настройкой, которую правит код под проверкой.
        sessionSettings: path.join(runtimeDir, 'ralph.session-settings.json'),
        // #38: журнал активации ревизий ядра — какая исполнялась, когда, с какой снята.
        activations: path.join(runtimeDir, 'ralph.activations.jsonl'),
    };
}
