#!/usr/bin/env bash
#
# Управляемый запуск ralph в tmux (Issue #103, вариант A — HITL/наблюдаемый прогон).
# Поднимает ОТДЕЛЬНУЮ tmux-сессию `ralph` (не смешивать с рабочей сессией `work` из
# RUNBOOK.md — там окна создаёт/закрывает человек, и индексы плавают) — не зависит от
# SSH-разрыва, живёт пока жив tmux-сервер.
#
# Раскладка: одно окно `ralph`, две панели:
#   верхняя — node ralph.js --profile <profile>
#   нижняя  — node runtime/monitor.js (дашборд; ждёт появления дерева раннера)
#
# Панели адресуются по `pane_id` (`%12`), который tmux выдаёт при создании, а НЕ по
# индексам `.0`/`.1`: индексация зависит от `pane-base-index` в конфиге tmux, и при
# `pane-base-index 1` первый же send-keys ушёл бы в «нет такой панели», оборвав скрипт
# на полусозданной сессии.
#
# Обе панели получают env одинаково — `set -a; . ralph.env; set +a` — и обе внутри
# `bash -c '... exec …'`: секреты петли живут только в процессе ралфа/монитора, а не в
# интерактивном шелле панели после его выхода. Иначе следующая команда, набранная в этой
# же панели, наследовала бы GH_TOKEN/CLAUDE_CODE_OAUTH_TOKEN — на этом уже обжигались
# ложным красным `security:canary` в унаследованном env.
#
# Панель монитора — удобство наблюдения, не обязательное условие: ralph.js поднимает
# СВОЙ detached-monitor.js сам (deadman читает свежесть ralph.log независимо от того,
# attach'нут ли кто-то к tmux). Второй экземпляр в панели не мутирует state и pid-файл,
# но deadman-пуши шлёт свои — см. RUNBOOK.md, «Запуск».
#
# ЗАПУСК (на VDS, под root):
#   .claude/ralph/provision/start-tmux.sh [профиль] [доп. аргументы ралфу…]
#
set -euo pipefail

PROFILE="${1:-prod}"
[ $# -gt 0 ] && shift
RALPH_ARGS=("$@")

SESSION="${RALPH_TMUX_SESSION:-ralph}"
# Дефолт REPO_DIR выводится из места самого скрипта, а не из литерала с путём конкретной
# машины: скрипт лежит в `<repo>/.claude/ralph/provision/`, значит корень проекта — три
# уровня вверх. Так один и тот же файл работает у любого потребителя, а не только у того,
# чей путь однажды вписали. Не сошлось (скрипт скопировали в другое место) — задай REPO_DIR
# явно: проверки ниже честно скажут, чего не хватает.
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
ENV_FILE="${RALPH_ENV_FILE:-$HOME/ralph.env}"
CONFIG_FILE="$REPO_DIR/.claude/ralph/ralph.config.json"
# Ожидание дерева раннера ограничено: без потолка панель молча висела бы вечно, а
# оператор смотрел бы на пустой дашборд, считая, что тот «ещё грузится».
WORKTREE_WAIT_SEC="${RALPH_WORKTREE_WAIT_SEC:-300}"

# node проверяем наравне с tmux: без него молча умерли бы ОБЕ панели, а сообщение об
# этом уехало бы внутрь панели, куда никто не смотрит.
for bin in tmux node; do
    command -v "$bin" >/dev/null 2>&1 || { echo "нет $bin в PATH" >&2; exit 1; }
done
[ -d "$REPO_DIR" ] || { echo "нет $REPO_DIR — сначала provision.sh" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "нет $ENV_FILE — заполни секреты (ralph.env.example), положи туда (chmod 600)" >&2; exit 1; }
[ -f "$CONFIG_FILE" ] || { echo "нет $CONFIG_FILE" >&2; exit 1; }

# Профиль сверяем с конфигом ЗДЕСЬ: опечатка иначе всплыла бы падением ралфа внутри
# панели — скрипт бодро отрапортовал бы «Готово», а прогона не было бы вовсе.
AVAILABLE=$(node -e 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).profiles||{};console.log(Object.keys(p).join(" "))' "$CONFIG_FILE")
case " $AVAILABLE " in
    *" $PROFILE "*) ;;
    *) echo "неизвестный профиль '$PROFILE'. Доступны: $AVAILABLE" >&2; exit 1 ;;
esac

# Путь дерева раннера — у самого раннера (resolve-worktree-path.mts), а не выведенный
# здесь второй копией правила: приоритет конфига над env и `runnerWorktreeDirname` мимо
# такой копии проходят, и монитор ждал бы дерево, которого по угаданному пути не будет.
RUNNER_DIR=$(node "$REPO_DIR/.claude/ralph/provision/resolve-worktree-path.mts" "$PROFILE" "$REPO_DIR") || {
    echo "не удалось определить путь дерева раннера (профиль $PROFILE)" >&2
    exit 1
}

# Живая сессия и живой раннер — разные вещи: после fail-closed стопа ралф выходит, а
# шелл панели остаётся, и «сессия существует» превращается в отказ стартовать там, где
# на деле нужен kill-session.
if tmux has-session -t "$SESSION" 2>/dev/null; then
    if pgrep -f 'ralph\.js' >/dev/null 2>&1; then
        echo "сессия '$SESSION' жива и раннер работает — смотреть: tmux attach -t $SESSION" >&2
    else
        echo "сессия '$SESSION' есть, но раннера в ней нет (прогон завершился, шелл остался)." >&2
        echo "убрать и запустить заново: tmux kill-session -t $SESSION" >&2
    fi
    exit 1
fi

q() { printf '%q' "$1"; }

RALPH_CMD="set -a; . $(q "$ENV_FILE"); set +a; exec node .claude/ralph/ralph.js --profile $(q "$PROFILE")"
for arg in ${RALPH_ARGS[@]+"${RALPH_ARGS[@]}"}; do RALPH_CMD="$RALPH_CMD $(q "$arg")"; done

MON_WAIT="deadline=\$((SECONDS + ${WORKTREE_WAIT_SEC})); until [ -d $(q "$RUNNER_DIR") ]; do [ \$SECONDS -lt \$deadline ] || { echo \"дерево раннера ${RUNNER_DIR} не появилось за ${WORKTREE_WAIT_SEC}s — дашборд не запущен (сам прогон в верхней панели это не трогает)\" >&2; exit 1; }; sleep 2; done"
# Каталог состояния наблюдаемого экземпляра. Раннер, запущенный с секцией `roots`, пишет
# state и лог туда, а панель без этого флага читала бы файлы рядом с ядром и показывала бы
# «раннер молчит» при живом прогоне. Значение берём из того же конфига, по которому идёт
# раннер; секции нет — флаг не добавляем (прежняя раскладка).
RUNTIME_DIR=$(node -e '
const fs = require("node:fs");
try {
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
    const profile = process.argv[2];
    // Профиль НЕ дублирует общие поля, он их дополняет: `runtimeDir` может лежать в
    // common, а профиль переопределять другой корень. Взяв блок профиля целиком, мы
    // получили бы пустой runtimeDir на исправном конфиге — и панель молча ушла бы
    // смотреть в прежний каталог (ревью !20).
    const roots = { ...(cfg.common?.roots ?? {}), ...(cfg.profiles?.[profile]?.roots ?? {}) };
    process.stdout.write(roots.runtimeDir ?? "");
} catch {
    process.stdout.write("");
}
' "$CONFIG_FILE" "$PROFILE")
MON_RUNTIME_ARG=""
if [ -n "$RUNTIME_DIR" ]; then MON_RUNTIME_ARG=" --runtime-dir $(q "$RUNTIME_DIR")"; fi

MON_CMD="set -a; . $(q "$ENV_FILE"); set +a; ${MON_WAIT}; cd $(q "$RUNNER_DIR"); exec node .claude/ralph/runtime/monitor.js --profile $(q "$PROFILE") --interval 60 --config $(q "$CONFIG_FILE")${MON_RUNTIME_ARG}"

pane_ralph=$(tmux new-session -d -s "$SESSION" -n ralph -c "$REPO_DIR" -P -F '#{pane_id}')
tmux send-keys -t "$pane_ralph" "bash -c $(q "$RALPH_CMD")" Enter

pane_monitor=$(tmux split-window -v -t "$pane_ralph" -c "$REPO_DIR" -P -F '#{pane_id}')
tmux send-keys -t "$pane_monitor" "bash -c $(q "$MON_CMD")" Enter

tmux select-pane -t "$pane_ralph"

cat <<EOF
Готово: tmux attach -t $SESSION
  верхняя панель ($pane_ralph) — ralph.js (профиль $PROFILE)
  нижняя панель  ($pane_monitor) — monitor.js (ждёт дерево раннера $RUNNER_DIR, до ${WORKTREE_WAIT_SEC}s)
Остановить: tmux kill-session -t $SESSION
EOF
