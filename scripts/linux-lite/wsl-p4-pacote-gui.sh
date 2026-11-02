#!/usr/bin/env bash
# Linux Lite — prova do pacote: o binário que sai do `linux-unpacked` abre
# realmente uma janela, e encerra-se com SIGTERM?
#
# Porque um ficheiro e não uma linha de comando: um `pkill -f cybersafe-…`
# embutido no `bash -c` apanhou o próprio shell que o corria (medido: `rc=9`,
# nenhum output). Os padrões aqui usam o truque `[c]` para que a linha de
# comando deste script não corresponda ao seu próprio padrão.
#
# Nada disto desativa proteções (§7): nenhuma bandeira `--no-sandbox`,
# `--disable-gpu` ou similar é passada. Se o arranque falhar por causa do
# sandbox, é isso que se reporta.
set -u
export PATH="$HOME/.local/node/bin:$PATH"
D="$HOME/cybersafe-linux-lite"
B="$D/packages/desktop/release-linux/linux-unpacked/cybersafe-assistant-linux-lite"
PORT="${CS_PACOTE_PORT:-9231}"
LOG="/tmp/cybersafe-pacote-gui.log"
PADRAO='[c]ybersafe-assistant-linux-lite'

if [ ! -x "$B" ]; then echo "SEM_BINARIO $B (correr package-linux.mjs primeiro)"; exit 1; fi

limpar() { pkill -9 -f "$PADRAO" 2>/dev/null; }
limpar; sleep 1
rm -f "$LOG"

echo "ambiente=WSL2 $(grep -o 'PRETTY_NAME=.*' /etc/os-release | cut -d'"' -f2) display=${DISPLAY:-sem} uid=$(id -u)"
setsid "$B" --remote-debugging-port="$PORT" </dev/null >"$LOG" 2>&1 &
sleep 20

echo "--- processos do pacote ---"
pgrep -a -f "$PADRAO" | head -8 || echo "nenhum (o processo não sobreviveu ao arranque)"
sobreviventes=$(pgrep -c -f "$PADRAO" 2>/dev/null || echo 0)
echo "processos_vivos=$sobreviventes"

echo "--- ligação ao ecrã (fd para /tmp/.X11-unix) ---"
ligou=0
for p in $(pgrep -f "$PADRAO" 2>/dev/null); do
  if ls -l "/proc/$p/fd" 2>/dev/null | grep -q '\.X11-unix'; then
    echo "pid=$p tem_ligacao_ao_servidor_de_janela=sim"; ligou=1
  fi
done
[ "$ligou" = 1 ] || echo "tem_ligacao_ao_servidor_de_janela=nao_ou_indireta"

echo "--- CDP: alvos abertos pelo renderer ---"
curl -s --max-time 6 "http://127.0.0.1:$PORT/json/list" > /tmp/cybersafe-pacote-cdp.json 2>/dev/null
if [ -s /tmp/cybersafe-pacote-cdp.json ]; then
  node -e 'const a=JSON.parse(require("fs").readFileSync("/tmp/cybersafe-pacote-cdp.json","utf8"));for(const t of a.slice(0,6))console.log(JSON.stringify({type:t.type,title:t.title,url:(t.url||"").slice(0,90)}))' 2>&1 | head -8
else
  echo "CDP_SEM_RESPOSTA porta=$PORT"
fi

echo "--- últimas linhas do log do pacote ---"
grep -c . "$LOG" 2>/dev/null | sed 's/^/linhas_log=/'; tail -20 "$LOG" 2>/dev/null

echo "--- encerramento com SIGTERM ---"
pkill -TERM -f "$PADRAO" 2>/dev/null; sleep 5
echo "apos_SIGTERM_remanescentes=$(pgrep -c -f "$PADRAO" 2>/dev/null || echo 0)"
limpar
echo "POS_SIGTERM_LOG=$(tail -3 "$LOG" 2>/dev/null | tr "\n" " ")"
echo FIM
