set -u
# Prova P1 (Linux Lite): o serviço, em Linux, consegue enumerar processos com
# identidade verificável? Corre o serviço construído, pede `processes.list` pelo
# socket AF_UNIX e mostra os campos que a UI consome — incluindo `startedAt`,
# que é a âncora de identidade da terminação. Não formatar nada: um número sem
# proveniência aqui é exatamente o que este script procura evitar.
export PATH="$HOME/.local/node/bin:$PATH"
cd "$HOME/cybersafe-linux-lite/packages/service" || exit 1

rm -rf "$HOME/.cybersafe-linux-lite"
# Processo benigno e reconhecível: é a linha que a lista tem de descrever.
sleep 600 &
BENIGNO=$!
echo "ambiente: $(uname -srm) | node=$(node -v) | uid=$(id -u) ($(id -un))"

timeout 60 node dist/index.js > /tmp/cs-p1-service.log 2>&1 &
SRV=$!
SOCK="$HOME/.cybersafe-linux-lite/engine.sock"
for _ in $(seq 1 40); do
  [ -S "$SOCK" ] && break
  kill -0 $SRV 2>/dev/null || { echo "SERVICE_EXITED_EARLY"; tail -5 /tmp/cs-p1-service.log; kill $BENIGNO 2>/dev/null; exit 1; }
  sleep 1
done
[ -S "$SOCK" ] || { echo "SOCKET_MISSING"; tail -5 /tmp/cs-p1-service.log; kill $BENIGNO 2>/dev/null; exit 1; }

node - "$SOCK" "$BENIGNO" <<'NODEPROBE'
const net = require('net');
const sock = net.connect(process.argv[2]);
const benigno = Number(process.argv[3]);
let buf = '';
const pedido = { id: 'req-procs', type: 'request', method: 'processes.list' };
const deadline = setTimeout(() => { console.log('PROBE_TIMEOUT'); process.exit(2); }, 25000);
sock.on('error', (e) => { clearTimeout(deadline); console.log('PROBE_ERR ' + e.code); process.exit(1); });
sock.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const linha = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!linha.trim()) continue;
    let m; try { m = JSON.parse(linha); } catch { continue; }
    if (m.id !== 'req-procs') continue;
    clearTimeout(deadline);
    if (!m.ok) { console.log('ERRO ' + JSON.stringify(m.error).slice(0, 300)); process.exit(1); }
    const r = m.result || {};
    const linhas = Array.isArray(r) ? r : (r.processes || r.list || []);
    console.log('ok=1 tipo_resultado=' + (Array.isArray(r) ? 'array' : Object.keys(r).join(',')));
    if (!Array.isArray(r)) console.log('truth=' + JSON.stringify(r.truth));
    console.log('count=' + linhas.length);
    const alvo = linhas.find((p) => p && p.pid === benigno);
    console.log('benigno_pid=' + benigno + ' presente=' + (alvo ? 1 : 0));
    if (alvo) console.log('benigno=' + JSON.stringify(alvo));
    const comInicio = linhas.filter((p) => typeof p.startedAt === 'string' && p.startedAt !== '').length;
    const comCaminho = linhas.filter((p) => typeof p.path === 'string' && p.path !== '').length;
    const comUtilizador = linhas.filter((p) => typeof p.user === 'string' && p.user !== '').length;
    console.log('cobertura: startedAt=' + comInicio + '/' + linhas.length +
      ' path=' + comCaminho + '/' + linhas.length + ' user=' + comUtilizador + '/' + linhas.length);
    const amostra = linhas.filter((p) => p.startedAt).slice(0, 3)
      .map((p) => `${p.name}|pid=${p.pid}|user=${p.user}|cpu=${p.cpu.toFixed(2)}|ram=${p.memoryMb.toFixed(1)}MB|inicio=${p.startedAt}|path=${p.path}`);
    amostra.forEach((s) => console.log('linha: ' + s));
    sock.destroy();
    process.exit(0);
  }
});
sock.on('connect', () => sock.write(JSON.stringify(pedido) + '\n'));
NODEPROBE
PROBE=$?
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
kill $BENIGNO 2>/dev/null
echo "probe_exit=$PROBE"
