set -u
export PATH="$HOME/.local/node/bin:$PATH"
LITE="$HOME/cybersafe-linux-lite"
echo "ambiente: $(uname -srm) node=$(node -v) uid=$(id -u)"

echo "--- vendor/yara na cópia Linux:"
ls -l "$LITE/vendor/yara" 2>&1 | head -10

echo "--- binários YARA de sistema (Linux):"
for b in yara yarac yara-x; do printf '%s: %s\n' "$b" "$(command -v $b || echo AUSENTE)"; done

echo "--- dist do core presente?"
ls -l "$LITE/packages/core/dist/yara-classic.js" 2>&1 | head -3

# O que o RESOLVER ACTUAL devolve quando corrido no Linux, com a árvore do
# projecto à vista. É isto que decide se um `.exe` de Windows seria espawndado.
echo "--- resolveYaraClassicBinaries() em Linux (código ACTUAL):"
node --input-type=module - "$LITE" <<'NODE'
const [lite] = process.argv.slice(2);
const mod = await import(new URL('file://' + lite + '/packages/core/dist/yara-classic.js').href);
console.log('platform=' + process.platform + ' versao=' + mod.YARA_CLASSIC_VERSION);
const dir = process.env.CS_YARA_DIR;
const res = dir ? mod.resolveYaraClassicBinaries({ CYBERSAFE_YARA_BIN_DIR: dir })
                : mod.resolveYaraClassicBinaries({});
console.log('RESOLVIDO=' + JSON.stringify(res));
if (res) {
  const fs = await import('node:fs');
  for (const [p, caminho] of Object.entries({ yara: res.yara, yarac: res.yarac })) {
    const head = fs.readFileSync(caminho).subarray(0, 2).toString('latin1');
    const st = fs.statSync(caminho);
    console.log(`  ${p}: ${caminho} magic=${JSON.stringify(head)} tam=${st.size} mode=0o${(st.mode & 0o777).toString(8)}`);
  }
}
NODE
