#!/usr/bin/env bash
# Copia o `dist` compilado no host para a cópia Linux do repo e corre a medição
# dos dois sinais. Nada é instalado, formatado ou apagado; o único sinal enviado
# vai para o PID benigno que o próprio probe criou.
set -uo pipefail
SRC=/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo
DST="$HOME/cybersafe-linux-lite"

# Runtime Linux nativo: um `node` no PATH ou o interpretador instalado pelo
# wsl-bootstrap em ~/.local/node. Um node do Windows (interop) não serve: não vê
# os PIDs nem o /proc de Linux.
NODE="$(command -v node || true)"
[ -x "$NODE" ] || NODE="$HOME/.local/node/bin/node"
if [ ! -x "$NODE" ]; then
  echo "SEM_NODE_LINUX: nem PATH nem $HOME/.local/node; nada foi medido"
  exit 2
fi
echo "AMBIENTE: $(uname -srm) | node $("$NODE" -v) | $NODE | uid=$(id -u)"
if [ ! -d "$DST/node_modules" ]; then
  echo "SEM_COPIA_LINUX: $DST não tem node_modules; nada foi medido"
  exit 3
fi

mkdir -p "$DST/scripts/linux-lite"
cp -r "$SRC/packages/core/dist/." "$DST/packages/core/dist/" || { echo "FALHA_COPY_CORE"; exit 4; }
cp -r "$SRC/packages/shared-types/dist/." "$DST/packages/shared-types/dist/" || { echo "FALHA_COPY_TYPES"; exit 4; }
tr -d '\015' < "$SRC/scripts/linux-lite/p1-sigkill-medicao.mjs" > "$DST/scripts/linux-lite/p1-sigkill-medicao.mjs" || exit 4

cd "$DST" || exit 5
"$NODE" scripts/linux-lite/p1-sigkill-medicao.mjs
