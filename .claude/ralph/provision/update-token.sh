#!/usr/bin/env bash
# Ротация headless-токена ralph: перезаписывает CLAUDE_CODE_OAUTH_TOKEN в ralph.env.
# Токен вводится скрыто (read -s) и передаётся через env, а не argv — не виден
# ни в выводе, ни в history, ни в `ps`.
#
# Usage: claude setup-token            # выпустить новый токен (нужен браузер)
#        bash update-token.sh          # вклеить его сюда
#        ENV_FILE=/path/to.env bash update-token.sh
set -euo pipefail

# Дефолт — в домашнем каталоге того, кто запускает: путь конкретной машины в продукте
# означал бы, что у другого потребителя скрипт молча правит не тот файл.
ENV_FILE="${ENV_FILE:-$HOME/ralph.env}"

[ -f "$ENV_FILE" ] || { echo "нет $ENV_FILE" >&2; exit 1; }

read -rsp 'Вставь новый токен (claude setup-token), Enter: ' TOKEN
echo

[[ "$TOKEN" == sk-ant-oat01-* ]] || { echo "не похоже на headless-токен (ожидался префикс sk-ant-oat01-)" >&2; exit 1; }

BACKUP="$ENV_FILE.bak.$(date +%s)"
cp -p "$ENV_FILE" "$BACKUP"
chmod 600 "$BACKUP"

# запись через python — токен не проходит через argv (не виден в ps)
TOKEN="$TOKEN" python3 - "$ENV_FILE" <<'PY'
import os, sys
path = sys.argv[1]
tok = os.environ['TOKEN']
lines = open(path).read().splitlines(keepends=True)
found = False
for i, l in enumerate(lines):
    if l.startswith('CLAUDE_CODE_OAUTH_TOKEN='):
        lines[i] = f'CLAUDE_CODE_OAUTH_TOKEN={tok}\n'
        found = True
if not found:
    lines.append(f'CLAUDE_CODE_OAUTH_TOKEN={tok}\n')
open(path, 'w').write(''.join(lines))
PY

chmod 600 "$ENV_FILE"
echo "записано в $ENV_FILE (бэкап: $BACKUP)"

echo '--- smoke-тест headless-режима через туннель ---'
(
    set -a; . "$ENV_FILE"; set +a
    claude -p 'Ответь одним словом: OK' --max-turns 1
)
