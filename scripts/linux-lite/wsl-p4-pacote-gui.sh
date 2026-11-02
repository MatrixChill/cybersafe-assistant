#!/usr/bin/env bash
# Linux Lite — prova do pacote: o binário que sai do `linux-unpacked` abre
# realmente uma janela, e encerra-se com SIGTERM?
#
# Porque um ficheiro e não uma linha de comando: duas medições morreram pelo
# próprio instrumento. Um `pkill -f cybersafe-…` escrito na linha de comando do
# `bash -lc` apanhou o shell que o corria (`rc=9`, zero output) — os padrões aqui
# usam o truque `[c]`, e o nome do pacote não pode aparecer no comando externo.
#
# Nada disto desativa proteções (§7): nenhuma bandeira `--no-sandbox`,
# `--disable-gpu` ou similar é passada por este script. Se o arranque depender
# disso, é isso que a leitura do log mostra.
#
# Uso: wsl-p4-pacote-gui.sh [--limpar-perfil|--matar]
set -u
export PATH="$HOME/.local/node/bin:$PATH"
D="$HOME/cybersafe-linux-lite"
B="$D/packages/desktop/release-linux/linux-unpacked/cybersafe-assistant-linux-lite"
PORT="${CS_PACOTE_PORT:-9231}"
LOG="/tmp/cybersafe-pacote-gui.log"
PADRAO='[c]ybersafe-assistant-linux-lite'
# Raiz de dados deste pacote (nome definido em `extraMetadata.name` da config
# Linux). A pergunta do §9 é exatamente esta: o artefacto escreve numa raiz só
# dele ou vai ter ao diretório do perfil de desenvolvimento?
PERFIL="$HOME/.config/cybersafe-assistant-linux-lite"

limpar() { pkill -9 -f "$PADRAO" 2>/dev/null; }

if [ "${1:-}" = "--matar" ]; then
  limpar; sleep 1
  echo "remanescentes_apos_kILL=$(pgrep -c -f "$PADRAO" 2>/dev/null || echo 0)"
  exit 0
fi
# `--observar [segundos]`: a pergunta que o SIGTERM não pode responder. Na corrida
# de `f3ee956` o `apos_SIGTERM_remanescentes=0` parecia encerramento limpo, mas o
# log terminava com `FATAL:gpu_data_manager_impl_private.cc GPU process isn't
# usable. Goodbye.` e a shell reportou `Trace/breakpoint trap` no processo
# principal: a janela pode ter morrido SOZINHA antes de qualquer sinal nosso.
# Aqui não é enviado nenhum sinal — só se mede se e quando sobrevive.
if [ "${1:-}" = "--observar" ]; then
  LIMITE="${2:-90}"
  limpar; sleep 1; rm -f "$LOG"
  setsid "$B" --remote-debugging-port="$PORT" </dev/null >"$LOG" 2>&1 &
  P=$!
  t=0; vivos=1
  while [ "$t" -lt "$LIMITE" ]; do
    sleep 5; t=$((t + 5))
    vivos=$(pgrep -c -f "$PADRAO" 2>/dev/null || echo 0)
    echo "t=${t}s vivos=${vivos}"
    [ "$vivos" -gt 0 ] || break
  done
  wait "$P" 2>/dev/null; rc=$?
  echo "observar: limite=${LIMITE}s morreu_antes_de_esgotar=$([ "$vivos" -eq 0 ] && echo SIM || echo NAO) aos=${t}s"
  echo "rc_do_processo_principal=${rc} (128+sinal: 133=SIGTRAP do FATAL do Chromium, 143=SIGTERM; 0 se o setsid fez fork e não exec)"
  echo "--- marcos do log (sem stacks de node) ---"
  grep -vE "^\s+at |node:internal" "$LOG" | tail -30
  limpar
  exit 0
fi
if [ "${1:-}" = "--limpar-perfil" ]; then
  rm -rf "$PERFIL"; echo "perfil_de_teste_removido=$PERFIL"
fi

if [ ! -x "$B" ]; then echo "SEM_BINARIO $B (correr package-linux.mjs primeiro)"; exit 1; fi
limpar; sleep 1
rm -f "$LOG"

echo "ambiente=WSL2 $(grep -o 'PRETTY_NAME=.*' /etc/os-release | cut -d'"' -f2) display=${DISPLAY:-sem} uid=$(id -u)"
setsid "$B" --remote-debugging-port="$PORT" </dev/null >"$LOG" 2>&1 &
sleep 20

echo "--- processos do pacote ---"
pgrep -a -f "$PADRAO" | head -8 || echo "nenhum (o processo não sobreviveu ao arranque)"
echo "processos_vivos=$(pgrep -c -f "$PADRAO" 2>/dev/null || echo 0)"
echo "--- onde o pacote escreveu ---"
if [ -d "$PERFIL" ]; then
  echo "perfil_do_pacote=$PERFIL"
  stat -c '  secrets nlink=%h %n' "$PERFIL/secrets" 2>/dev/null || echo "  sem secrets/ (credência não foi criada)"
else
  echo "perfil_do_pacote=não_foi_criado ($PERFIL)"
fi
echo "--- o que o pacote contou sobre si (log primeiro: uma leitura que pendure não pode apagar isto) ---"
grep -c . "$LOG" 2>/dev/null | sed 's/^/linhas_log=/'
tail -22 "$LOG" 2>/dev/null

echo "--- CDP: alvos do renderer ---"
# `http.get` com prazo, não `fetch`: o `fetch` do undici ligou-se e pendurou
# (a corrida morreu no `timeout` com rc=124 sem imprimir alvo nenhum), e um
# timeout é parte da medição — sem ele a sonda não termina.
timeout 12 node -e '
const http=require("http"), p=process.argv[1];
http.get({host:"127.0.0.1",port:p,path:"/json/list",timeout:8000},(r)=>{
  let b="";r.on("data",(c)=>b+=c);r.on("end",()=>{
    let a;try{a=JSON.parse(b)}catch(e){console.log("CDP_RESPOSTA_NAO_JSON",b.slice(0,120));return}
    for(const t of (a||[]).slice(0,6))console.log(JSON.stringify({type:t.type,title:t.title,url:(t.url||"").slice(0,90)}));
  });
}).on("timeout",()=>{console.log("CDP_TIMEOUT");process.exit(0)})
.on("error",(e)=>console.log("CDP_ERRO",String(e&&e.message||e)));
' "$PORT" 2>&1 | head -8
echo "rc_no_de_erro_acima=ok_se_imprimiu_alvos"

echo "--- encerramento com SIGTERM APENAS no processo principal ---"
# `pkill -TERM -f` apanhava TODA a família, incluindo o filho GPU do Chromium.
# Matado o filho, o pai não encerra: aborta com `FATAL: GPU process isn't
# usable. Goodbye.` e a shell reporta `Trace/breakpoint trap`. O
# `remanescentes=0` dessa corrida media o colapso, não o encerramento (§15).
# O pedido de sair é uma coisa por processo: SIGTERM no navegador, que é o que
# o `app.quit()`/fechar a janela representa para o sinal.
PRINCIPAL=""
for p in $(pgrep -f "$PADRAO" 2>/dev/null); do
  if ! tr -d '\0' < "/proc/$p/cmdline" 2>/dev/null | grep -q -- "--type="; then PRINCIPAL="$p"; break; fi
done
echo "processo_principal=${PRINCIPAL:-nenhum_encontrado}"
if [ -n "$PRINCIPAL" ]; then
  kill -TERM "$PRINCIPAL" 2>/dev/null
  espera=0
  while [ -d "/proc/$PRINCIPAL" ] && [ "$espera" -lt 15 ]; do sleep 1; espera=$((espera + 1)); done
  echo "principal_saiu_em=${espera}s"
  sleep 3
  echo "apos_SIGTERM_remanescentes=$(pgrep -c -f "$PADRAO" 2>/dev/null || echo 0)"
  echo "termo_do_log=$(tail -3 "$LOG" 2>/dev/null | tr "\n" " ")"
fi
limpar
echo "apos_KILL_remanescentes=$(pgrep -c -f "$PADRAO" 2>/dev/null || echo 0)"
echo FIM
