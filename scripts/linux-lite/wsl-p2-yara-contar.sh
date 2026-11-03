set -u
export PATH="$HOME/.local/node/bin:$PATH"
cd "$HOME/cybersafe-linux-lite/packages/core" || exit 1

echo "--- o ficheiro de teste copiado é o novo?"
grep -c "^suite(" test/yara-classic-engine.test.js
grep -c "yara-classic-posix" test/yara-classic-engine.test.js

echo "--- resolveYaraClassicBinaries() no contexto dos testes (env real do WSL):"
node --input-type=module - "$PWD" <<'NODE'
const [cwd] = process.argv.slice(2);
const mod = await import('file://' + cwd + '/dist/yara-classic.js');
const r = mod.resolveYaraClassicBinaries();
console.log('RESOLVIDO=' + JSON.stringify(r));
if (r) {
  const fs = await import('node:fs');
  console.log('magic_yarac=' + JSON.stringify(fs.readFileSync(r.yarac).subarray(0, 2).toString('latin1')) + ' origem=' + r.origem);
}
NODE

echo "--- contagem real da suite no Linux (repórter tap):"
node --test test/yara-classic-posix.test.js test/yara-classic-engine.test.js 2>&1 | grep -E "^# (tests|suites|pass|fail|skipped|todo) |^not ok" | head -12
