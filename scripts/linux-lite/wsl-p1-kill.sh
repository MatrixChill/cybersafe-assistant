set -u
export PATH="$HOME/.local/node/bin:$PATH"
cd "$HOME/cybersafe-linux-lite/packages/service"
SOCK="$HOME/.cybersafe-linux-lite/engine.sock"

# ── processos benignos criados SÓ para este teste ────────────────────────────
# Filhos da shell do script: o serviço não os herda e nada os mata excepto o
# próprio pedido de terminação que estamos a medir. `sleep` não aceita um
# argumento-extra de etiqueta (morria com "invalid time interval"), por isso o
# reconhecimento é pelo PID do $! e pelo /proc, nunca pelo nome inventado.
sleep 900 &
A=$!
sleep 901 &
B=$!
echo "benign_a_pid=$A cmdline=$(tr '\0' ' ' < /proc/$A/cmdline)"
echo "benign_b_pid=$B cmdline=$(tr '\0' ' ' < /proc/$B/cmdline)"

rm -rf "$HOME/.cybersafe-linux-lite"
timeout 90 node dist/index.js > /tmp/cs-kill-service.log 2>&1 &
SRV=$!
for i in $(seq 1 25); do
  if [ -S "$SOCK" ]; then break; fi
  if ! kill -0 $SRV 2>/dev/null; then echo "SERVICE_EXITED_EARLY"; break; fi
  sleep 1
done
[ -S "$SOCK" ] || { echo "RESULT sem_socket"; kill $SRV 2>/dev/null; exit 1; }

node - "$SOCK" "$A" "$B" <<'NODEPROBE'
const net = require('net');
const fs = require('fs');
const [sockPath, pidA, pidB] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];

// Vive ou não vive: lê-se o /proc, não se confia na resposta do motor.
const vivo = (pid) => fs.existsSync('/proc/' + pid);
const nomeDe = (pid) => {
  try { return fs.readFileSync('/proc/' + pid + '/comm', 'utf-8').trim(); } catch { return '-'; }
};

const sock = net.connect(sockPath);
let buf = '';
let seq = 0;
const awaitantes = new Map();
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
    }
  }
});
sock.on('error', (e) => { console.log('SOCKET_ERR ' + e.code); process.exit(1); });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const liga = () => new Promise((r) => sock.once('connect', r));
function pedir(metodo, params, timeoutMs = 20000) {
  const id = 'q' + (++seq);
  return new Promise((resolver) => {
    const tempoLimite = setTimeout(() => {
      awaitantes.delete(id);
      resolver({ id, ok: false, tempoLimite: true, metodo });
    }, timeoutMs);
    awaitantes.set(id, { resolver, tempoLimite });
    // O campo do protocolo é `method` (isValidRpcEnvelope rejeita o resto e
    // fecha a ligação com invalid-envelope) — não é o nome interno da função.
    sock.write(JSON.stringify({ id, type: 'request', method: metodo, payload: params }) + '\n');
  });
}
const resumir = (r) => r.ok
  ? 'ok ' + JSON.stringify(r.result).slice(0, 400)
  : 'falha ' + JSON.stringify(r.error || { tempoLimite: true }).slice(0, 400);

(async () => {
  await liga();

  // 1) O motor vê os processos benignos? Sem isto nada mais étestável.
  const lista = await pedir('processes.list');
  const linhas = lista.ok ? (Array.isArray(lista.result) ? lista.result : (lista.result && lista.result.processes) || []) : [];
  const linha = (pid) => linhas.find((l) => l && l.pid === pid);
  const a = linha(pidA);
  const b = linha(pidB);
  console.log('CASE lista ' + JSON.stringify({
    total: linhas.length,
    temA: !!a, temB: !!b,
    nomeA: a && a.name, startedAtA: a && a.startedAt, userA: a && a.user, pathA: a && a.path,
  }));

  // 2) Recusa: PID 1 (crítico) — tem de recusar SEM EFFECTO.
  console.log('CASE pid1_antes ' + vivo(1) + ' ' + nomeDe(1));
  const r1 = await pedir('process.killTree', { pid: 1 }, 30000);
  console.log('CASE pid1_resposta ' + resumir(r1));
  await esperar(500);
  console.log('CASE pid1_depois ' + vivo(1) + ' (esperado true = nenhum sinal chegou ao init)');

  // 3) Recusa: PID inexistente/fora do snapshot — sem efeito, sem sucesso.
  const fantasma = 4000099;
  const r2 = await pedir('process.killTree', { pid: fantasma }, 30000);
  console.log('CASE fantasma_resposta ' + resumir(r2));
  console.log('CASE fantasma_depois ' + vivo(fantasma) + ' (esperado false)');

  // 4) O caminho do GUI: prepare/confirm com identidade (pid + startedAt).
  const prep = await pedir('process.termination.prepare', { pid: pidB, startedAt: (b && b.startedAt) || '' });
  console.log('CASE prepare_resposta ' + resumir(prep));
  const bilhete = prep.ok && prep.result && prep.result.ticket;
  if (bilhete) {
    const conf = await pedir('process.termination.confirm', { ticket: bilhete }, 30000);
    console.log('CASE confirm_resposta ' + resumir(conf));
    await esperar(1000);
    console.log('CASE benigno_b_depois_confirm ' + vivo(pidB));
  } else {
    console.log('CASE benigno_b_depois_prepare ' + vivo(pidB) + ' (sem bilhete: nenhum pedido de confirmação enviado)');
  }

  // 5) Pedido normal sobre o benigno A pelo primitivo do motor.
  const r3 = await pedir('process.killTree', { pid: pidA }, 30000);
  console.log('CASE benigno_a_resposta ' + resumir(r3));
  await esperar(1500);
  console.log('CASE benigno_a_depois ' + vivo(pidA) + ' nome=' + nomeDe(pidA));

  process.exit(0);
})();
NODEPROBE
PROBE=$?

echo "--- alive check no shell (independente do probe) ---"
for P in $A $B 1; do
  if [ -d "/proc/$P" ]; then echo "PID $P VIVO comm=$(cat /proc/$P/comm 2>/dev/null)"; else echo "PID $P MORTO"; fi
done

kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
kill $A 2>/dev/null; kill $B 2>/dev/null
echo "probe_exit=$PROBE"
echo "=== service log (últimas 15) ==="
tail -15 /tmp/cs-kill-service.log
echo "=== acções registadas ==="
tail -20 "$HOME/.cybersafe-linux-lite/logs/actions.log" 2>/dev/null | head -20
