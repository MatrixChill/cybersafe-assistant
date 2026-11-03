set -u
export PATH="$HOME/.local/node/bin:$PATH"
cd "$HOME/cybersafe-linux-lite/packages/service"
rm -rf "$HOME/.cybersafe-linux-lite"
timeout 40 node dist/index.js > /tmp/cs-service.log 2>&1 &
SRV=$!
SOCK="$HOME/.cybersafe-linux-lite/engine.sock"
for i in $(seq 1 25); do
  if [ -S "$SOCK" ]; then break; fi
  if ! kill -0 $SRV 2>/dev/null; then echo "SERVICE_EXITED_EARLY"; break; fi
  sleep 1
done
if [ -S "$SOCK" ]; then echo SOCKET_PRESENT; else echo SOCKET_MISSING; fi
node - "$SOCK" <<'NODEPROBE'
const net = require('net');
const sock = net.connect(process.argv[2]);
let buf = '';
const pending = {
  'req-state': ['protection.getState', (r) => 'ok=' + (r.ok ? 1 : 0)],
  'req-procs': ['processes.list', (r) => r.ok ? 'count=' + (Array.isArray(r.result) ? r.result.length : typeof r.result) : 'err=' + JSON.stringify(r.error || '').slice(0, 120)],
  'req-pcstate': ['pcstate.get', (r) => r.ok ? 'engines=' + Object.keys(r.result && r.result.engines || {}).join(',') : 'err=' + JSON.stringify(r.error || '').slice(0, 120)],
};
let open = Object.keys(pending).length;
const deadline = setTimeout(() => { console.log('PROBE_TIMEOUT open=' + open); process.exit(2); }, 15000);
const finishOne = () => { open -= 1; if (open <= 0) { clearTimeout(deadline); sock.destroy(); process.exit(0); } };
sock.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m && pending[m.id]) {
      console.log('RPC ' + m.id + ' ' + pending[m.id][1](m));
      delete pending[m.id];
      finishOne();
    }
  }
});
sock.on('error', (e) => { clearTimeout(deadline); console.log('PROBE_ERR ' + e.code); process.exit(1); });
sock.on('connect', () => {
  for (const [id, [method]] of Object.entries(pending)) {
    sock.write(JSON.stringify({ id, type: 'request', method }) + '\n');
  }
});
NODEPROBE
PROBE=$?
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
echo "probe_exit=$PROBE"
echo "=== persistence layout ==="
find "$HOME/.cybersafe-linux-lite" -maxdepth 2 | head -20
