#!/usr/bin/env bash
# Mede o que o Electron 33.4.11 do Linux REAL (WSL2) diz sobre o safeStorage,
# sem descarregar nada: usa o zip já em cache e extrai-o para um diretório
# próprio. Não escreve chaves, não instala pacotes, não toca no Windows.
set -u

VERSAO="33.4.11"
BASE="$HOME/.cache/cybersafe-probe"
APP="$BASE/app"
ZIP=$(ls "$HOME"/.cache/electron/*/electron-v${VERSAO}-linux-x64.zip 2>/dev/null | head -1)
SONDA_SRC=${1:-$(dirname "$0")}/p2-matrix-sonda-safestorage.cjs

if [ -z "${ZIP:-}" ]; then
  echo "SEM_ZIP_ELECTRON: não há electron-v${VERSAO}-linux-x64.zip em ~/.cache/electron"
  exit 2
fi
if [ ! -f "$SONDA_SRC" ]; then
  echo "SEM_SONDA: $SONDA_SRC"
  exit 2
fi

if command -v unzip >/dev/null 2>&1; then
  EXAI="unzip"
elif command -v python3 >/dev/null 2>&1; then
  EXAI="python3"
else
  echo "SEM_UNZIP: nem unzip nem python3 disponíveis"
  exit 2
fi

if [ ! -x "$BASE/electron/electron" ]; then
  mkdir -p "$BASE/electron" || exit 2
  if [ "$EXAI" = "unzip" ]; then
    unzip -q -o "$ZIP" -d "$BASE/electron" || { echo "EXTRACAO_FALHOU"; exit 2; }
  else
    python3 - "$ZIP" "$BASE/electron" <<'PY' || { echo "EXTRACAO_FALHOU"; exit 2; }
import sys, zipfile, os
zip_path, destino = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path) as arquivo:
    arquivo.extractall(destino)
PY
  fi
  chmod +x "$BASE/electron/electron" 2>/dev/null
fi
if [ ! -x "$BASE/electron/electron" ]; then
  echo "SEM_BINARIO_ELECTRON depois de extrair $ZIP"
  exit 2
fi

rm -rf "$APP"
mkdir -p "$APP" || exit 2
printf '{"name":"cybersafe-sonda","main":"probe.cjs"}\n' > "$APP/package.json"
tr -d '\015' < "$SONDA_SRC" > "$APP/probe.cjs" || exit 2

echo "ambiente: $(uname -sr)  DISPLAY=${DISPLAY:-sem}  XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-sem}  uid=$(id -u)"
if command -v busctl >/dev/null 2>&1; then
  echo "secrets-service: $(busctl --user call org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.DBus.Peer Ping 2>&1 | head -1)"
elif command -v gdbus >/dev/null 2>&1; then
  echo "secrets-service: $(gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets --method org.freedesktop.DBus.Peer 2>&1 | head -1)"
else
  echo "secrets-service: SEM_BUSCTL_E_SEM_GDBUS (não verificado por esta via)"
fi

BINARIOS="libnss3 libatk libgbm libasound"
FALTAM=""
for biblioteca in libnss3.so libatk-1.0.so.0 libgbm.so.1 libasound.so.2; do
  ldconfig -p 2>/dev/null | grep -q "$biblioteca" || FALTAM="$FALTAM $biblioteca"
done
if [ -n "${FALTAM# }" ]; then
  echo "FALTAM_BIBLIOTECAS:$FALTAM"
  echo "O Electron não arranca sem elas; instalar pacotes do sistema exige autorização."
  exit 3
fi

timeout 60 "$BASE/electron/electron" --no-sandbox --disable-gpu --disable-dev-shm-usage "$APP" \
  >"$BASE/stdout.log" 2>"$BASE/stderr.log"
ESTADO=$?
grep -o 'SONDA {.*}' "$BASE/stdout.log" | head -1 || true
if [ "$ESTADO" -ne 0 ]; then
  echo "ELECTRON_FALHOU estado=$ESTADO"
  tail -6 "$BASE/stderr.log"
  exit 4
fi
