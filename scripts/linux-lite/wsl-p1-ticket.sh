#!/usr/bin/env bash
# Mede o bilhete de terminação POSIX ponta a ponta no Linux real (WSL2):
# process.termination.prepare -> confirm, com a sessão autenticada pelo
# handshake do pipe, e o veredicto lido no /proc — nunca pela resposta do motor.
#
# Porque o handshake é feito com o `pipe-auth` do próprio produto: reimplementar
# o desafio em bash daria um teste que prova o script, não o protocolo.
set -u
export PATH="$HOME/.local/node/bin:$PATH"
REPO="${REPO:-$HOME/cybersafe-linux-lite}"
SRCDIR="/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo"
SOCK="$HOME/.cybersafe-linux-lite/engine.sock"
LOG=/tmp/cs-ticket-service.log

# ── sincronizar o código do branch para a cópia Linux, a partir do clone isolado ─
# Enumerar ficheiros à mão já rebentou uma vez: o `engine.ts` ganhou imports novos
# (`quarantine-mounts`, `usb-detection-adapter-posix`) e o build do serviço fallhou
# por módulos que existiam no clone mas não na cópia. Um harness que não compila o
# que o branch escreve não mede o branch, por isso vai a árvore toda.
for p in shared-types core service; do
  cp -a "$SRCDIR/packages/$p/src/." "$REPO/packages/$p/src/"
done

( cd "$REPO" && npm run build -w @cybersafe/shared-types -w @cybersafe/core -w @cybersafe/service ) > /tmp/cs-ticket-build.log 2>&1
BUILD=$?
echo "build_exit=$BUILD"
if [ $BUILD -ne 0 ]; then tail -20 /tmp/cs-ticket-build.log; exit 1; fi

# ── processos benignos criados SÓ para este teste ────────────────────────────
sleep 900 & A=$!
sleep 901 & B=$!
echo "benign_a_pid=$A"
echo "benign_b_pid=$B"

export CYBERSAFE_PIPE_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export NODE_ENV=production
rm -rf "$HOME/.cybersafe-linux-lite"
# O prazo tem de cobrir a espera do portão (90 s) mais o resto do percurso; 120 s
# matava o serviço a meio e a falha seria lida como defeito do contrato.
( cd "$REPO/packages/service" && timeout 300 node dist/index.js > "$LOG" 2>&1 ) &
SRV=$!
for i in $(seq 1 30); do
  [ -S "$SOCK" ] && break
  kill -0 $SRV 2>/dev/null || { echo "SERVICE_EXITED_EARLY"; tail -20 "$LOG"; exit 1; }
  sleep 1
done
[ -S "$SOCK" ] || { echo "RESULT sem_socket"; kill $SRV 2>/dev/null; exit 1; }

node - "$SOCK" "$A" "$B" "$REPO" <<'NODEPROBE'
const net = require('net');
const fs = require('fs');
const [sockPath, pidA, pidB, repo] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4]), process.argv[5]];
const token = process.env.CYBERSAFE_PIPE_TOKEN;

const vivo = (pid) => fs.existsSync('/proc/' + pid);
const vivoA = () => vivo(pidA);
const vivoB = () => vivo(pidB);

(async () => {
  const auth = await import('file://' + repo + '/packages/core/dist/pipe-auth.js');
  const sock = net.connect(sockPath);
  let buf = '';
  let seq = 0;
  const awaitantes = new Map();
  const esperaFrame = (cond, ms = 8000) => new Promise((res, rej) => {
    const t = setTimeout(() => {
      const k = pendingFrames.findIndex((x) => x.res === res);
      if (k >= 0) pendingFrames.splice(k, 1);
      rej(new Error('timeout espera de frame'));
    }, ms);
    pendingFrames.push({ cond, res, rej, t });
  });
  // Fila simples: cada frame não-resposta é entregue ao primeiro waiter que o aceita.
  const pendingFrames = [];
  sock.on('data', (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const linha = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!linha.trim()) continue;
      let m; try { m = JSON.parse(linha); } catch { continue; }
      if (m && m.id && awaitantes.has(m.id)) {
        const { resolver, tempoLimite } = awaitantes.get(m.id);
        clearTimeout(tempoLimite); awaitantes.delete(m.id); resolver(m);
        continue;
      }
      const w = pendingFrames.find((x) => x.cond(m));
      if (w) { pendingFrames.splice(pendingFrames.indexOf(w), 1); clearTimeout(w.t); w.res(m); }
    }
  });
  sock.on('error', (e) => { console.log('SOCKET_ERR ' + e.code); process.exit(1); });
  const escrever = (obj) => sock.write(JSON.stringify(obj) + '\n');
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  await new Promise((r) => sock.once('connect', r));

  // 1) Handshake real do pipe: auth-hello → auth-challenge → auth-response → auth.
  const clientNonce = auth.generatePipeNonce();
  const hello = { type: 'auth-hello', v: auth.PIPE_AUTH_VERSION, nonce: clientNonce };
  // Diagnóstico do próprio harness: o que é que estamos a mandar? (sem segredo:
  // só o comprimento do nonce, nunca o valor.)
  console.log('CASE hello_enviado ' + JSON.stringify({ type: hello.type, v: hello.v, tipo_v: typeof hello.v, nonce_len: clientNonce.length }));
  escrever(hello);
  const desafio = await esperaFrame((m) => m && m.type === 'auth-challenge');
  if (desafio.proof !== auth.makePipeProof(token, 'server', clientNonce, desafio.nonce)) {
    console.log('CASE auth_challenge PROVA_SERVIDOR_DIFERE');
  }
  // O `v` vai em AMBOS os frames: o serviço verifica a versão em cada fase do
  // handshake (engine.ts:5089), não só no hello — omiti-lo aqui produzia
  // «Versão do protocolo do pipe não suportada» e fazia um contrato correto
  // parecer incompatível. O cliente real faz o mesmo (service-client.ts:263).
  escrever({ type: 'auth-response', v: auth.PIPE_AUTH_VERSION, proof: auth.makePipeProof(token, 'client', clientNonce, desafio.nonce) });
  const autenticado = await esperaFrame((m) => m && m.type === 'auth');
  console.log('CASE auth ' + JSON.stringify({ ok: !!autenticado.ok, erro: autenticado.error || null }));
  if (!autenticado.ok) process.exit(1);

  function pedir(metodo, payload, timeoutMs = 30000) {
    const ids = 'q' + (++seq);
    return new Promise((resolver) => {
      const tempoLimite = setTimeout(() => { awaitantes.delete(ids); resolver({ id: ids, ok: false, tempoLimite: true, metodo }); }, timeoutMs);
      awaitantes.set(ids, { resolver, tempoLimite });
      escrever({ id: ids, type: 'request', method: metodo, payload });
    });
  }
  const resumo = (r) => JSON.stringify(r.result !== undefined ? r.result : (r.error || { tempoLimite: true })).slice(0, 420);

  // 2) A linha do ecrã tem de trazer o instante no corte do contrato.
  const lista = await pedir('processes.list');
  const linhas = Array.isArray(lista.result) ? lista.result : (lista.result && lista.result.processes) || [];
  const linhaA = linhas.find((l) => l && l.pid === pidA);
  console.log('CASE lista ' + JSON.stringify({
    total: linhas.length, temA: !!linhaA, temB: !!linhas.find((l) => l && l.pid === pidB),
    nomeA: linhaA && linhaA.name, startedAtA: linhaA && linhaA.startedAt,
    seteCasas: !!(linhaA && /\.\d{7}Z$/.test(linhaA.startedAt || '')),
  }));

  // 3) prepare legítimo → bilhete; confirm → killed com identity-reconfirmed.
  // O serviço abre uma atualização de definições ao subir e o portão da
  // terminação fecha-se enquanto ela decorre. Medir o bilhete logo a seguir ao
  // boot mediria o portão, não o contrato; por isso se espera que ele abra, com
  // prazo, e se reporta quanto custou — inclusive o caso de não abrir.
  const erroPrep = (r) => String((r && r.result && r.result.error) || (r && r.error) || '');
  const bloqueadoPorAtualizacao = (r) => /atualiza/i.test(erroPrep(r));
  const pedirPrepareA = () => pedir('process.termination.prepare', { pid: pidA, startedAt: linhaA && linhaA.startedAt });
  const t0 = Date.now();
  let prep = await pedirPrepareA();
  let tentativas = 1;
  while (bloqueadoPorAtualizacao(prep) && Date.now() - t0 < 90000) {
    await esperar(1000);
    prep = await pedirPrepareA();
    tentativas++;
  }
  console.log('CASE gate_aberto ' + JSON.stringify({
    aberto: !bloqueadoPorAtualizacao(prep),
    segundos: Math.round((Date.now() - t0) / 1000),
    tentativas,
  }));
  const ticket = prep.ok && prep.result && prep.result.ok ? prep.result.ticket : null;
  console.log('CASE prepare_A ' + resumo(prep));
  if (ticket) {
    const conf = await pedir('process.termination.confirm', { ticket });
    console.log('CASE confirm_A ' + resumo(conf));
  } else {
    console.log('CASE confirm_A SEM_BILHETE');
  }
  await esperar(400);
  console.log('CASE efeito_A vivo=' + vivoA() + ' esperado=false');
  console.log('CASE efeito_B vivo=' + vivoB() + ' esperado=true');

  // 4) cancel: bilhete emitido e devolvido — o alvo tem de ficar vivo.
  const linhaB = linhas.find((l) => l && l.pid === pidB);
  const prepB = await pedir('process.termination.prepare', { pid: pidB, startedAt: linhaB && linhaB.startedAt });
  const ticketB = prepB.ok && prepB.result && prepB.result.ok ? prepB.result.ticket : null;
  const canc = ticketB ? await pedir('process.termination.cancel', { ticket: ticketB }) : { ok: false, error: 'sem bilhete' };
  console.log('CASE cancel_B ' + resumo(canc) + ' vivo=' + vivoB() + ' esperado=true');

  // 5) PID 1: recusado sem efeito.
  const p1 = await pedir('process.termination.prepare', { pid: 1, startedAt: (linhas.find((l) => l && l.pid === 1) || {}).startedAt || '' });
  console.log('CASE prepare_pid1 ' + resumo(p1) + ' vivo=' + vivo(1));

  // 6) startedAt adulterado noutra casa decimal: o bilhete não pode ser emitido.
  const mau = (linhaA ? linhaA.startedAt : '').replace(/(\d)0000Z$/, (_s, d) => (Number(d) + 1) + '0000Z');
  const tamper = await pedir('process.termination.prepare', { pid: pidB, startedAt: mau });
  console.log('CASE prepare_starttime_adulterado ' + resumo(tamper));

  // 7) PID inexistente: recusa honesta, nunca sucesso.
  const fantasma = await pedir('process.termination.prepare', { pid: 4000099, startedAt: '2020-01-01T00:00:00.0000000Z' });
  console.log('CASE prepare_fantasma ' + resumo(fantasma));

  const log = fs.existsSync(process.env.HOME + '/.cybersafe-linux-lite/logs/actions.log')
    ? fs.readFileSync(process.env.HOME + '/.cybersafe-linux-lite/logs/actions.log', 'utf-8').split('\n').slice(-4)
    : [];
  console.log('CASE audit_log ' + JSON.stringify(log).slice(0, 500));
  sock.destroy();
  process.exit(0);
})().catch((e) => { console.log('PROBE_ERRO ' + e.message); process.exit(1); });
NODEPROBE

PROBE=$?
kill $SRV 2>/dev/null
kill $A $B 2>/dev/null
echo "probe_exit=$PROBE"
echo "--- tail do log do serviço ---"
tail -12 "$LOG"
