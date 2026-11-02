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

echo "--- ligação ao ecrã ---"
# Medir isto por `/proc/<pid>/fd` estava errado: uma ligação X11 é um socket
# (`socket:[inode]`), não um caminho, e a verificação dava falso negativo. Lêem-se
# os sockets unix do processo com `ss`, e procura-se X11 e Wayland — o WSLg expõe
# os dois e o Electron escolhe um.
pids=$(pgrep -f "$PADRAO" 2>/dev/null | tr '\n' ' ')
ligou=0
if command -v ss >/dev/null 2>&1; then
  sockets=$(ss -x -a -p 2>/dev/null | grep -E '\.X11-unix|wayland' || true)
  for p in $pids; do
    if printf '%s\n' "$sockets" | grep -q "pid=$p,"; then
      echo "pid=$p socket_de_servidor_de_janela=sim"; ligou=1
    fi
  done
  [ "$ligou" = 1 ] || echo "socket_de_servidor_de_janela=nao_observado (ss viu 0 sockets destes pids)"
else
  echo "socket_de_servidor_de_janela=DESCONHECIDO (sem ss)"
fi

echo "--- CDP: alvos abertos pelo renderer ---"
# `curl` não existe neste host; a leitura anterior de «sem resposta» era do
# binário em falta, não da aplicação. `fetch` do Node é o meio que aqui há.
node -e 'const p=process.argv[1];fetch("http://127.0.0.1:"+p+"/json/list").then(r=>r.json()).then(a=>{if(!Array.isArray(a)){console.log("CDP_FORMATO_INESPERADO");return}for(const t of a.slice(0,6))console.log(JSON.stringify({type:t.type,title:t.title,url:(t.url||"").slice(0,90)}))}).catch(e=>console.log("CDP_ERRO",String(e&&e.message||e)))' "$PORT" 2>&1 | head -8

echo "--- últimas linhas do log do pacote ---"
grep -c . "$LOG" 2>/dev/null | sed 's/^/linhas_log=/'; tail -20 "$LOG" 2>/dev/null

echo "--- encerramento com SIGTERM ---"
pkill -TERM -f "$PADRAO" 2>/dev/null; sleep 5
echo "apos_SIGTERM_remanescentes=$(pgrep -c -f "$PADRAO" 2>/dev/null || echo 0)"
limpar
echo "POS_SIGTERM_LOG=$(tail -3 "$LOG" 2>/dev/null | tr "\n" " ")"
echo FIM
