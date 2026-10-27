// Общий предохранитель от побочек в тестах (#138, вынесен из ralph.js и
// telegram-notifier.ts — #145). Раньше жил в двух копиях (циклическая зависимость
// мешала telegram-notifier.ts сделать require('../ralph.js')), у каждой свой журнал,
// и test-setup.ts сверял оба в одном afterEach; третий потребитель, security-audit.mjs
// (#239), добавил ещё одну копию поверх — порог "делай общий модуль при третьем
// потребителе" из issue #145 пройден.
//
// TS-модуль без билд-шага: исполняется нативным type stripping Node 24 (erasable-only
// синтаксис — только аннотации типов, ни enum, ни namespace, ни parameter properties).
// Требуется и через require() (ralph.js — CommonJS-entry), и через import
// (telegram-notifier.ts, security-audit.mjs — ESM); Node отдаёт во всех случаях один и тот
// же модуль из кеша, так что sideEffectAttempts — общий массив на все три потребителя.
export const NO_SIDE_EFFECTS: boolean = process.env.RALPH_NO_SIDE_EFFECTS === '1';
export const sideEffectAttempts: string[] = [];

// hint — подсказка, специфичная для потребителя (какой DI-параметр подменить), поэтому
// параметризована, а не захардкожена в модуле: у ralph.js и telegram-notifier.ts разные
// наборы коллабораторов (shFn/saveStateFn/installFn/spawnFn vs execFn).
export function guardSideEffect(what: string, hint: string): void {
    if (!NO_SIDE_EFFECTS) return;
    sideEffectAttempts.push(what);
    throw new Error(`${what} — побочка в тестовом окружении (RALPH_NO_SIDE_EFFECTS=1).\n` + hint);
}
