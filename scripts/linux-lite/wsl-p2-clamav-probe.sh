set -u
export PATH="$HOME/.local/node/bin:$PATH"
LITE="$HOME/cybersafe-linux-lite"
cd "$LITE/packages/core" || exit 1

echo "ambiente: $(uname -srm) node=$(node -v) uid=$(id -u)"
echo "--- clamav de sistema:"
for b in clamscan clamdscan freshclam clamconf; do printf '%s: %s\n' "$b" "$(command -v $b || echo AUSENTE)"; done

node --input-type=module - "$LITE" <<'NODE'
const [lite] = process.argv.slice(2);
const core = await import('file://' + lite + '/packages/core/dist/index.js');
const fs = await import('node:fs');
const path = await import('node:path');

console.log('nome_do_binário(linux)=' + core.clamavBinaryName('linux'));
const candidatos = core.clamavBinaryCandidates(process.env, 'linux');
console.log('total_candidatos=' + candidatos.length);
console.log('fontes=' + JSON.stringify([...new Set(candidatos.map((c) => c.source))]));
const sobMonteWindows = candidatos.filter((c) => c.path.startsWith('/mnt/'));
console.log('candidatos_sob_/mnt/c=' + sobMonteWindows.length + ' ' + JSON.stringify(sobMonteWindows.slice(0, 3)));
const escolha = core.firstExistingClamavBinary(candidatos, (p) => fs.existsSync(p));
console.log('ESCOLHIDO=' + JSON.stringify(escolha));

const bridge = new core.ClamavBridge({});
const disponivel = await bridge.isAvailable(true);
console.log('bridge.isAvailable=' + disponivel);
console.log('bridge.health=' + JSON.stringify(bridge.health));
try {
  const alvo = path.join('/tmp', 'cs-clamav-benino.txt');
  fs.writeFileSync(alvo, 'Ficheiro benigno criado só para esta medição.');
  const r = await bridge.scanFile(alvo);
  console.log('scanFile=' + JSON.stringify({ status: r.status, infected: r.infected ?? null, error: r.error ?? null }));
} catch (e) {
  console.log('scanFile_recusou=' + String(e).slice(0, 200));
} finally {
  await bridge.dispose();
}
NODE
