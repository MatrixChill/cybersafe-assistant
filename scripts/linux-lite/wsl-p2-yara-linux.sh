set -u
export PATH="$HOME/.local/node/bin:$PATH"
MNT="/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo"
LITE="$HOME/cybersafe-linux-lite"

# Só os ficheiros desta alteração. O resto da cópia Linux fica como está.
cp "$MNT/packages/core/src/yara-classic.ts" "$LITE/packages/core/src/yara-classic.ts"
cp "$MNT/packages/core/src/yara.ts"         "$LITE/packages/core/src/yara.ts"
cp "$MNT/packages/core/test/yara-classic-posix.test.js" "$LITE/packages/core/test/" 2>/dev/null
cp "$MNT/packages/core/test/yara-classic-engine.test.js" "$LITE/packages/core/test/"
echo "ambiente: $(uname -srm) node=$(node -v) uid=$(id -u)"

cd "$LITE/packages/core" || exit 1
npm run build >/tmp/yara-linux-build.log 2>&1
echo "build_core_exit=$?"; grep -E "error TS" /tmp/yara-linux-build.log | head -3

echo "--- testes YARA corridos NATIVAMENTE em Linux:"
node --test test/yara-classic-posix.test.js test/yara-classic-engine.test.js >/tmp/yara-linux-test.log 2>&1
echo "test_exit=$?"
grep -E "^ℹ (tests|pass|fail|skipped|todo)" /tmp/yara-linux-test.log
grep -E "^# SKIP|skipped" /tmp/yara-linux-test.log | head -3

echo "--- o que existe em vendor/yara na cópia Linux:"
ls "$LITE/vendor/yara" 2>/dev/null | head -6

echo "--- RESOLVER em Linux (código NOVO):"
node --input-type=module - "$LITE" <<'NODE'
const [lite] = process.argv.slice(2);
const mod = await import('file://' + lite + '/packages/core/dist/yara-classic.js');
const yara = await import('file://' + lite + '/packages/core/dist/yara.js');
const fs = await import('node:fs');
const path = await import('node:path');

console.log('platform=' + process.platform);
console.log('nomes_posix=' + JSON.stringify(mod.nomesExecutaveisYara('linux')));
console.log('RESOLVIDO=' + JSON.stringify(mod.resolveYaraClassicBinaries()));
console.log('PROCURA=' + mod.descricaoProcuraYara());
console.log('DIAGNÓSTICO=' + JSON.stringify(mod.missingBinaryDiagnostic().message));

// Estado real do motor: indisponível tem de ser dito como indisponível, e um
// ficheiro nunca pode sair «limpo» de um motor que não existe.
const regras = path.join(lite, 'packages/core/definitions/yara');
let corpus = null;
try {
  corpus = fs.readdirSync(regras).filter((f) => f.endsWith('.yar')).map((f) => path.join(regras, f))[0] ?? null;
} catch {}
const engine = new yara.YaraEngine(corpus ?? path.join(regras, 'default.yar'));
if (corpus) { try { await engine.load(corpus); } catch (e) { console.log('load_lançou=' + String(e).slice(0, 160)); } }
console.log('corpus_usado=' + (corpus ?? 'AUSENTE'));
console.log('engine.isAvailable=' + engine.isAvailable);
console.log('engine.health=' + JSON.stringify(engine.health));
try {
  const alvo = path.join('/tmp', 'cs-yara-benino.bin');
  fs.writeFileSync(alvo, 'Este ficheiro é benigno e existe só para esta medição.');
  const r = await engine.scanFile(alvo);
  console.log('scanFile=' + JSON.stringify({ status: r.status, matches: r.matches.length, detalhe: r.error ?? null }));
} catch (e) { console.log('scanFile_recusou=' + String(e).slice(0, 200)); }
NODE
