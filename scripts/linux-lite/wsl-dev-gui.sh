#!/usr/bin/env bash
# Linux Lite — arranque GUI completo (service + api + app + desktop) em WSL2/WSLg.
#
# O perfil dev do desktop deriva `<PIPE_NAME>-matrixdev` quando não existe um
# `CYBERSAFE_DEV_PIPE_NAME` explícito, enquanto `dev:service` escuta no transporte
# default. É o mesmo contrato do Windows: o runner isolado declara o nome e o
# serviço escuta exatamente nesse nome. Este script é esse runner no Linux, por
# isso exporta o par de isolamento para TODA a árvore `npm run dev` — nenhum
# ficheiro partilhado é alterado para o Linux ligar.
set -u
export PATH="$HOME/.local/node/bin:$PATH"
export DISPLAY=:0

CS_DEV_ROOT="${CS_DEV_ROOT:-/tmp/cybersafe-linux-lite-dev}"
CS_SERVICE_DIR="${CS_SERVICE_DIR:-$HOME/.cybersafe-linux-lite-dev}"
CS_SOCKET="$CS_SERVICE_DIR/engine.sock"

export CYBERSAFE_DEV_ISOLATION=1
export CYBERSAFE_DEV_ROOT="$CS_DEV_ROOT"
export CYBERSAFE_DEV_SERVICE_DIR="$CS_SERVICE_DIR"
export CYBERSAFE_DEV_PIPE_NAME="$CS_SOCKET"
export CYBERSAFE_DB_PATH="$CS_DEV_ROOT/data/matrix.db"
export CYBERSAFE_API_PORT=4100
unset CYBERSAFE_DEV_WINDOWS_READONLY CYBERSAFE_PIPE_TOKEN

mkdir -p "$CS_DEV_ROOT/data" "$CS_SERVICE_DIR"

cd "$HOME/cybersafe-linux-lite"

# package-lock gerado em Windows não traz o binding nativo do rolldown para Linux.
RV=$(node -p "require('rolldown/package.json').version" 2>/dev/null || echo "")
if [ -n "$RV" ] && ! node -e "require('@rolldown/binding-linux-x64-gnu')" >/dev/null 2>&1; then
  echo "installing @rolldown/binding-linux-x64-gnu@$RV"
  npm install --no-save --no-audit --no-fund "@rolldown/binding-linux-x64-gnu@$RV" >/dev/null 2>&1
  node -e "require('@rolldown/binding-linux-x64-gnu'); console.log('binding ok')"
fi

rm -f /tmp/cs-dev.log
nohup npm run dev > /tmp/cs-dev.log 2>&1 &
DEVPID=$!

CONECTADO=0
for _ in $(seq 1 40); do
  sleep 5
  if grep -q "Connected to pipe successfully" /tmp/cs-dev.log; then CONECTADO=1; break; fi
  if grep -q "exited with code" /tmp/cs-dev.log; then break; fi
done

echo "=== transporte ==="
echo "socket pedido: $CS_SOCKET"
ls -la "$CS_SOCKET" 2>&1 | head -2
echo "ligacao desktop->motor: $([ "$CONECTADO" = 1 ] && echo SIM || echo NAO)"
grep -c "Pipe not ready" /tmp/cs-dev.log | sed 's/^/retentativas de ligacao: /'
echo "=== processos ==="
pgrep -a electron 2>/dev/null | head -4
pgrep -fa "tsx watch src/index.ts" 2>/dev/null | head -2
sleep 20
mkdir -p /mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/artifacts
maim /tmp/cybersafe-linux-p0.png && echo SHOT_OK
cp /tmp/cybersafe-linux-p0.png /mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/artifacts/cybersafe-linux-p0.png 2>/dev/null && echo COPIED
echo "=== log: marcos de arranque ==="
grep -E "\[Service\]|\[Electron\]|\[ServiceClient\]|isolamento|erro" /tmp/cs-dev.log | tail -n 30
echo "=== log: cauda ==="
grep -vE "^\s+at |node:internal" /tmp/cs-dev.log | tail -n 25
kill "$DEVPID" 2>/dev/null
pkill -f "electron \." 2>/dev/null
pkill -f "tsx watch src/index.ts" 2>/dev/null
pkill -f vite 2>/dev/null
pkill -f concurrently 2>/dev/null
true
