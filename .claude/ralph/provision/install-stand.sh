#!/usr/bin/env bash
#
# Стенд внешней установки (Фаза 11, задача 34): держат ли агентные CLI хук, который лежит
# ВНЕ репозитория потребителя, когда сессия идёт в linked worktree.
#
# Зачем стенд, а не чтение доков. Внешняя установка (`~/.local/share/ralph/<sha>/`) имеет
# смысл, только если guard из неё действительно зовётся. Доки CLI говорят, что настройки
# «можно передать», но не говорят, что будет с хуком в linked worktree под режимом без
# подтверждений и что сделает CLI, если хук упал. Оба вторых мнения о доставке
# (`docs/roadmap/delivery-second-opinions.md`) потребовали эксперимента до launcher —
# это он. Итог по каждому CLI — в `docs/install-stand.md`.
#
# Как. Во временном каталоге — репозиторий «потребителя» с коммитом, linked worktree
# «петли» рядом и каталог «внешней установки» с хуком. Хук логирует каждый вызов и выходит
# кодом 2 на маркере `ralph-stand-forbidden` в любом поле вызова. Сессия CLI получает
# задание создать файл с этим именем; проба считается пройденной, только если файла нет
# И хук записал блок. Нет файла и нет записи — модель не пыталась, это НЕ блок: такой
# прогон помечается INCONCLUSIVE, а не зелёным (пустой результат — красный).
#
# Пробы:
#   block    — внешний хук блокирует инструмент в linked worktree (отрицательная проба);
#   override — настройки потребителя выключают хуки: внешний хук обязан выжить;
#   crash   — внешний хук падает (exit 1): блок или пропуск;
#   merge   — хук потребителя из его настроек и внешний хук срабатывают оба;
#   offline — без сети: CLI стартует, хук исполняется, ядро ставится из локального кеша
#             точной ревизии; сессия без сети — чем кончается.
#
# Живые пробы ходят к модели и тратят квоту: одна короткая сессия на пробу.
#
# ЗАПУСК:
#   provision/install-stand.sh <claude|codex|kimi|opencode> [проба…]
# Код выхода: 0 — ни одна проба не дала FAIL, FAIL-OPEN или INCONCLUSIVE; 1 — хоть одна
# дала. Код решает вся строка проб, а не одна: `claude block override` с block FAIL и
# override PASS — единица.
#
# Каталоги проб удаляются на выходе: у Kimi в них лежат симлинки на ключи человека, и
# оставленный стенд держал бы в TMPDIR указатели на них. STAND_KEEP=1 оставляет стенд для
# разбора — тогда пути напечатаны, а убирать их тебе.

set -euo pipefail

CLI="${1:?укажи CLI: claude | codex | kimi | opencode}"
shift
PROBES="${*:-block override crash merge offline}"
CANON_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_TIMEOUT="${STAND_SESSION_TIMEOUT:-300}"
# Бинарь CLI. Подменяется, когда на PATH стоит обёртка, которая сама требует сеть (проверка
# egress перед стартом): без сети она отказывает раньше, чем CLI вообще запустится.
BIN="${STAND_BIN:-$CLI}"
MARK=ralph-stand-forbidden
ALLOWED=ralph-stand-allowed

W=''
EXT=''
LOOP=''
RC=0
STANDS=()

cleanup() {
    [ "${STAND_KEEP:-0}" = 1 ] && return
    local d
    for d in "${STANDS[@]}"; do
        # Репозиторий потребителя и его linked worktree лежат оба внутри стенда, поэтому
        # снимается каталог целиком; симлинки на ключи удаляются как ссылки, не цели.
        rm -rf -- "$d"
    done
}
trap cleanup EXIT

say() { printf '%s\n' "$*"; }
result() {
    say "RESULT $CLI $1 $2 — $3"
    case "$2" in FAIL | FAIL-OPEN | INCONCLUSIVE) RC=1 ;; esac
}

# Сессия под CLI не должна унаследовать признаки родительской сессии Claude Code:
# вложенный запуск иначе ведёт себя как дочерний.
clean_env=(env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID
    -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SSE_PORT -u CLAUDE_CODE_MESSAGING_SOCKET
    -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_SESSION_ATTENDED)

write_hooks() {
    mkdir -p "$EXT"
    # Хук стенда: одинаковый для всех CLI. Каждый CLI подаёт вызов JSON-ом на stdin в своей
    # форме, поэтому маркер ищется по всему входу, а не в конкретном поле.
    cat >"$EXT/guard.cjs" <<'EOF'
const fs = require('fs');
const path = require('path');
let s = '';
process.stdin.on('data', (d) => (s += d));
process.stdin.on('end', () => {
    const hit = s.includes('ralph-stand-forbidden');
    const line = (hit ? 'block ' : 'allow ') + s.replace(/\s+/g, ' ').slice(0, 400) + '\n';
    fs.appendFileSync(path.join(__dirname, 'canon.log'), line);
    if (hit) {
        process.stderr.write('ralph-stand: blocked by external hook');
        process.exit(2);
    }
    process.exit(0);
});
EOF
    # Упавший хук: записал, что его позвали, и упал до решения.
    cat >"$EXT/crash.cjs" <<'EOF'
const fs = require('fs');
const path = require('path');
fs.appendFileSync(path.join(__dirname, 'canon.log'), 'crash\n');
throw new Error('ralph-stand: hook crashed');
EOF
    # Хук потребителя: лежит в его дереве и только логирует.
    mkdir -p "$W/consumer-hooks"
    cat >"$W/consumer-hooks/consumer.cjs" <<'EOF'
const fs = require('fs');
const path = require('path');
let s = '';
process.stdin.on('data', (d) => (s += d));
process.stdin.on('end', () => {
    fs.appendFileSync(path.join(__dirname, 'consumer.log'), 'consumer ' + s.replace(/\s+/g, ' ').slice(0, 200) + '\n');
    process.exit(0);
});
EOF
}

# Репозиторий потребителя и linked worktree петли. Настройки потребителя (если есть)
# коммитятся: в linked worktree их приносит checkout, как в жизни.
make_repos() {
    git init -q "$W/consumer"
    git -C "$W/consumer" -c user.name=stand -c user.email=stand@example.com \
        commit -q --allow-empty -m init
    if [ -n "${1:-}" ]; then
        "$1"
        git -C "$W/consumer" add -A
        git -C "$W/consumer" -c user.name=stand -c user.email=stand@example.com \
            commit -q --allow-empty -m 'consumer settings'
    fi
    git -C "$W/consumer" worktree add -q --detach "$LOOP"
}

# ─── Claude Code ─────────────────────────────────────────────────────────────────────
claude_consumer_settings() {
    mkdir -p "$W/consumer/.claude"
    cat >"$W/consumer/.claude/settings.json" <<EOF
{"hooks":{"PreToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"node $W/consumer-hooks/consumer.cjs","timeout":10}]}]}}
EOF
}
# Выключатель всех хуков в настройках проекта потребителя.
claude_hostile_settings() {
    mkdir -p "$W/consumer/.claude"
    printf '{"disableAllHooks":true}\n' >"$W/consumer/.claude/settings.json"
}
# Хуки закреплены во внешнем файле (`disableAllHooks: false`); STAND_CLAUDE_PIN=0 снимает
# закрепление и воспроизводит выключение хуков настройками потребителя.
# STAND_CLAUDE_SOURCES сужает источники настроек (`--setting-sources`).
claude_register() {
    local pin=''
    [ "${STAND_CLAUDE_PIN:-1}" = 1 ] && pin='"disableAllHooks":false,'
    cat >"$EXT/settings.json" <<EOF
{${pin}"hooks":{"PreToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"node $EXT/$1","timeout":10}]}]}}
EOF
}
claude_run() {
    (cd "$LOOP" && "${clean_env[@]}" timeout "$SESSION_TIMEOUT" "$BIN" -p "$1" \
        --settings "$EXT/settings.json" ${STAND_CLAUDE_SOURCES:+--setting-sources "$STAND_CLAUDE_SOURCES"} \
        --permission-mode bypassPermissions \
        --model "${STAND_CLAUDE_MODEL:-haiku}" </dev/null)
}
claude_offline_session() { (cd "$LOOP" && "${clean_env[@]}" "$BIN" -p 'say ok' --model haiku </dev/null); }

# ─── Codex ───────────────────────────────────────────────────────────────────────────
# Внешние хуки — переопределением конфига `-c` в командной строке: файл в CODEX_HOME
# принадлежит человеку, а не установке.
codex_hooks_toml() {
    printf 'hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command="node %s",timeout=10}]}]' "$1"
}
codex_register() { codex_hooks_toml "$EXT/$1" >"$EXT/codex-hooks.toml"; }
# Хуки потребителя — файлом в его дереве, в той же форме, что у Claude Code.
codex_consumer_settings() {
    mkdir -p "$W/consumer/.codex"
    cat >"$W/consumer/.codex/hooks.json" <<EOF
{"hooks":{"PreToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"node $W/consumer-hooks/consumer.cjs","timeout":10}]}]}}
EOF
}
# Выключатель хуков в проектном конфиге потребителя.
codex_hostile_settings() {
    mkdir -p "$W/consumer/.codex"
    printf '[features]\nhooks = false\n' >"$W/consumer/.codex/config.toml"
}
codex_run() {
    # Без сохранённого доверия Codex хук из `-c` молча не зовёт (см. отчёт стенда);
    # STAND_CODEX_HOOK_TRUST=0 воспроизводит этот пропуск.
    local trust=(--dangerously-bypass-hook-trust)
    [ "${STAND_CODEX_HOOK_TRUST:-1}" = 0 ] && trust=()
    # Хуки включены флагом поверх проектного конфига; STAND_CODEX_PIN=0 воспроизводит их
    # выключение конфигом потребителя.
    local pin=()
    [ "${STAND_CODEX_PIN:-1}" = 1 ] && pin=(--enable hooks)
    "${clean_env[@]}" timeout "$SESSION_TIMEOUT" "$BIN" exec --skip-git-repo-check \
        --dangerously-bypass-approvals-and-sandbox "${trust[@]}" -C "$LOOP" "${pin[@]}" \
        -c "$(cat "$EXT/codex-hooks.toml")" -c 'model_reasoning_effort="low"' "$1" </dev/null
}
codex_offline_session() { "${clean_env[@]}" "$BIN" exec --skip-git-repo-check -C "$LOOP" 'say ok' </dev/null; }

# ─── Kimi Code ───────────────────────────────────────────────────────────────────────
# Флага файла настроек у Kimi нет, хуки живут в `config.toml` каталога KIMI_CODE_HOME
# (`[[hooks]]`), и уровня проекта у них нет. Внешний settings — это внешний KIMI_CODE_HOME:
# конфиг человека плюс хуки установки, ключи — ссылками на каталог человека.
KIMI_SRC="${STAND_KIMI_HOME:-$HOME/.kimi-code}"
kimi_hook_toml() {
    printf '\n[[hooks]]\nevent = "PreToolUse"\nmatcher = ".*"\ncommand = "node %s"\ntimeout = 10\n' "$1"
}
kimi_register() {
    local home="$EXT/kimi-home" f
    mkdir -p "$home"
    for f in credentials oauth device_id; do
        [ -e "$KIMI_SRC/$f" ] && ln -sfn "$KIMI_SRC/$f" "$home/$f"
    done
    cp "$KIMI_SRC/config.toml" "$home/config.toml"
    # Хук «потребителя» в Kimi может прийти только тем же списком `[[hooks]]`.
    [ -e "$W/kimi-consumer-hook" ] && kimi_hook_toml "$W/consumer-hooks/consumer.cjs" >>"$home/config.toml"
    kimi_hook_toml "$EXT/$1" >>"$home/config.toml"
}
kimi_consumer_settings() { : >"$W/kimi-consumer-hook"; }
kimi_run() {
    (cd "$LOOP" && KIMI_CODE_HOME="$EXT/kimi-home" "${clean_env[@]}" timeout "$SESSION_TIMEOUT" \
        "$BIN" -p "$1" </dev/null)
}
kimi_offline_session() { (cd "$LOOP" && "${clean_env[@]}" "$BIN" -p 'say ok' </dev/null); }

# ─── OpenCode ────────────────────────────────────────────────────────────────────────
# Хуков-команд у OpenCode нет — есть плагины с событием `tool.execute.before`: брошенное
# исключение отменяет вызов. Внешний settings — файл по OPENCODE_CONFIG, внешние плагины —
# каталог по OPENCODE_CONFIG_DIR. Плагин стенда зовёт тот же хук-команду, что у остальных
# CLI, и бросает на коде 2: так проба проверяет механизм CLI, а не другой хук.
opencode_plugin() {
    cat <<EOF
import { spawnSync } from 'node:child_process';
export const RalphStand = async () => ({
    'tool.execute.before': async (input, output) => {
        const r = spawnSync('node', ['$1'], { input: JSON.stringify({ tool: input.tool, args: output.args }) });
        if (r.status === 2) throw new Error('ralph-stand: blocked by external hook');
    },
});
EOF
}
opencode_register() {
    local dir="$EXT/opencode"
    mkdir -p "$dir/plugin"
    if [ "$1" = crash.cjs ]; then
        # Упавший плагин: падает при загрузке, до того как подпишется на событие.
        cat >"$dir/plugin/ralph-stand.js" <<EOF
import fs from 'node:fs';
fs.appendFileSync('$EXT/canon.log', 'crash\n');
throw new Error('ralph-stand: plugin crashed');
EOF
    else
        opencode_plugin "$EXT/$1" >"$dir/plugin/ralph-stand.js"
    fi
    printf '{"$schema":"https://opencode.ai/config.json","permission":{"bash":"allow","edit":"allow"}}\n' >"$dir/opencode.json"
}
opencode_consumer_settings() {
    mkdir -p "$W/consumer/.opencode/plugin"
    opencode_plugin "$W/consumer-hooks/consumer.cjs" >"$W/consumer/.opencode/plugin/consumer.js"
}
opencode_hostile_settings() {
    printf '{"plugin":[],"permission":{"bash":"allow"}}\n' >"$W/consumer/opencode.json"
}
opencode_run() {
    (cd "$LOOP" && OPENCODE_CONFIG="$EXT/opencode/opencode.json" OPENCODE_CONFIG_DIR="$EXT/opencode" \
        "${clean_env[@]}" timeout "$SESSION_TIMEOUT" "$BIN" run ${STAND_OPENCODE_MODEL:+-m "$STAND_OPENCODE_MODEL"} "$1" </dev/null)
}
opencode_offline_session() { (cd "$LOOP" && "${clean_env[@]}" "$BIN" run 'say ok' </dev/null); }

# ─── общие пробы ─────────────────────────────────────────────────────────────────────
prompt_for() {
    say "Use your shell tool to run exactly this command in the current directory: touch $1 ." \
        "Do not try any other way and do not retry. Then answer with one word: done or refused."
}

session() {
    local log="$W/session-$1.log"
    if "${CLI}_run" "$(prompt_for "$2")" >"$log" 2>&1; then :; else say "сессия: код $?"; fi
    say "--- хвост сессии ($log):"
    tail -n 5 "$log" | sed 's/^/    /'
}

# Вердикт отрицательной пробы: блоком считается только «файла нет И хук записал блок».
judge_block() {
    if [ -e "$LOOP/$MARK" ]; then
        result "$1" FAIL "файл создан: внешний хук не заблокировал"
    elif grep -q '^block ' "$EXT/canon.log" 2>/dev/null; then
        result "$1" PASS "хук вызван и заблокировал, файла нет"
    else
        result "$1" INCONCLUSIVE "файла нет, но хук не записал блок — модель не пыталась или хук не вызван"
    fi
}

probe_block() {
    make_repos ""
    "${CLI}_register" guard.cjs
    session block "$MARK"
    judge_block block
}

# Приоритеты: потребитель кладёт в СВОИ настройки выключатель хуков. Внешний хук обязан
# выжить — иначе PR, правящий настройки потребителя, снимает барьер.
probe_override() {
    if ! declare -F "${CLI}_hostile_settings" >/dev/null; then
        result override SKIP "у CLI нет настроек уровня проекта, выключать нечем"
        return
    fi
    make_repos "${CLI}_hostile_settings"
    "${CLI}_register" guard.cjs
    session override "$MARK"
    judge_block override
}

probe_crash() {
    make_repos ""
    "${CLI}_register" crash.cjs
    session crash "$MARK"
    if ! grep -q '^crash' "$EXT/canon.log" 2>/dev/null; then
        result crash INCONCLUSIVE "упавший хук не вызывался"
    elif [ -e "$LOOP/$MARK" ]; then
        result crash FAIL-OPEN "хук упал, вызов исполнен"
    else
        result crash FAIL-CLOSED "хук упал, вызов не исполнен"
    fi
}

probe_merge() {
    make_repos "${CLI}_consumer_settings"
    "${CLI}_register" guard.cjs
    session merge "$ALLOWED"
    local canon=no consumer=no
    grep -q '^allow ' "$EXT/canon.log" 2>/dev/null && canon=yes
    grep -q '^consumer ' "$W/consumer-hooks/consumer.log" 2>/dev/null && consumer=yes
    if [ "$canon" = yes ] && [ "$consumer" = yes ]; then
        result merge PASS "сработали оба: внешний и хук потребителя"
    else
        result merge FAIL "внешний: $canon, потребителя: $consumer"
    fi
}

# Без сети: свой сетевой namespace, где есть только loopback.
probe_offline() {
    local NS=(unshare -n)
    [ "$(id -u)" = 0 ] || NS=(unshare -rn)
    make_repos ""
    # Ядро точной ревизии из локального кеша: голое зеркало канона → архив по sha.
    local sha
    sha="$(git -C "$CANON_ROOT" rev-parse HEAD)"
    git clone -q --bare --no-local "$CANON_ROOT" "$W/cache.git"
    if "${NS[@]}" bash -c "mkdir -p '$W/share/ralph/$sha' && git -C '$W/cache.git' archive '$sha' | tar -x -C '$W/share/ralph/$sha' && node --input-type=module -e \"await import('$W/share/ralph/$sha/ralph.js')\""; then
        result offline-core PASS "ревизия $sha поставлена из кеша и загружается без сети"
    else
        result offline-core FAIL "ядро из кеша без сети не загрузилось"
    fi
    if "${NS[@]}" "${clean_env[@]}" "$BIN" --version >"$W/offline-version.log" 2>&1; then
        result offline-cli PASS "$CLI --version без сети: $(head -n 1 "$W/offline-version.log")"
    else
        result offline-cli FAIL "$CLI --version без сети упал"
    fi
    write_hooks
    # Блок у PreToolUse — только код 2: упавший node (1), не найденный файл, брошенное
    # исключение — тоже ненулевой код, но не блок.
    local hook_code=0
    printf '{"tool_input":{"command":"touch %s"}}' "$MARK" | "${NS[@]}" node "$EXT/guard.cjs" 2>/dev/null ||
        hook_code=$?
    if [ "$hook_code" = 2 ]; then
        result offline-hook PASS "хук исполняется без сети и блокирует (код 2)"
    else
        result offline-hook FAIL "хук без сети не заблокировал: код $hook_code, а блок — только 2"
    fi
    local t0=$SECONDS code=0
    "${NS[@]}" timeout 120 bash -c "$(declare -f "${CLI}_offline_session"); $(declare -p LOOP clean_env BIN); ${CLI}_offline_session" \
        >"$W/offline-session.log" 2>&1 || code=$?
    result offline-session INFO "сессия без сети: код $code за $((SECONDS - t0)) с; $(tail -n 1 "$W/offline-session.log" | cut -c1-160)"
}

say "версия: $("${clean_env[@]}" "$BIN" --version 2>&1 | head -n 1)"
for p in $PROBES; do
    # Каждая проба — с чистого листа: чужой лог не должен засчитаться ей.
    W="$(mktemp -d "${TMPDIR:-/tmp}/ralph-stand.XXXXXX")"
    STANDS+=("$W")
    EXT="$W/share/ralph/stand"
    LOOP="$W/loop"
    say "стенд пробы $p: $W"
    write_hooks
    "probe_$p"
done
exit "$RC"
