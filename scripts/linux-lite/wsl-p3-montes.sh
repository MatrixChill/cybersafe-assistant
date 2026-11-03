#!/usr/bin/env bash
# Mede a descoberta REAL de volumes montados com o código shipped
# (packages/core/dist/mounts-posix.js), em Linux. Não instala nada, não monta
# nada, não escreve fora de /tmp. Uso: bash wsl-p3-montes.sh [pasta-do-repo]
set -euo pipefail

REPO="${1:-/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo}"
DIST="$REPO/packages/core/dist"
NODE="${NODE:-$HOME/.local/node/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node)"

for f in mounts-posix.js disk.js; do
  if [ ! -f "$DIST/$f" ]; then
    echo "SEM_DIST: falta $DIST/$f (correr antes: npm run build -w @cybersafe/core)"
    exit 2
  fi
done

BASE="$(mktemp -d /tmp/cybersafe-p3-montes.XXXXXX)"
cp "$DIST/mounts-posix.js" "$DIST/disk.js" "$BASE/"
tr -d '\015' < "$BASE/mounts-posix.js" > "$BASE/m.js" && mv "$BASE/m.js" "$BASE/mounts-posix.js"

cat > "$BASE/sonda.js" <<'JS'
const fs = require("node:fs");
const { lerMontagensPosix, escolheMontagemPrincipal } = require("./mounts-posix.js");
const { describeDiskRead, pickPrimaryVolume } = require("./disk.js");
const texto = fs.readFileSync("/proc/self/mountinfo", "utf-8");
const leitor = { readFileSync: () => texto, statfsSync: (p) => { try { return fs.statfsSync(p); } catch { return null; } } };
const r = lerMontagensPosix(leitor);
console.log("MONTES", JSON.stringify({
  plataforma: process.platform,
  ok: r.ok,
  motivo: r.reason,
  linhasMountinfo: texto.trim().split("\n").length,
  ilegiveis: r.ilegiveis,
  excluidos: r.excluidos,
  naoMedidos: r.naoMedidos,
  semCapacidadeUtil: r.semCapacidadeUtil,
  volumes: r.volumes.map((v) => ({ mount: v.mount, fs: v.fileSystem, source: v.source, dev: v.dispositivo, ro: v.readOnly, totalGiB: Math.round(v.size / 1024 ** 3), disponivelGiB: Math.round(v.available / 1024 ** 3), montagens: v.montagens })),
}));
const snapshot = describeDiskRead(r.volumes);
console.log("DISCO", JSON.stringify({
  ok: snapshot.ok,
  motivo: snapshot.reason,
  volumes: snapshot.volumes.map((v) => ({ mount: v.mount, kind: v.kind, fs: v.fileSystem, uso: v.usagePercent, livreGiB: v.freeGb })),
  primarioDiskTs: snapshot.ok ? (pickPrimaryVolume(snapshot.volumes) || {}).mount ?? null : null,
  primarioLinux: escolheMontagemPrincipal(r.volumes)?.mount ?? null,
}));
JS

# Terceira medição, e a que decide: a fonte que o PC Center usa HOJE
# (`systeminformation.fsSize()`) funciona realmente em Linux, ou não? Sem esta
# linha a escolha de `mountinfo` seria uma suposição. Não instala nada; usa a
# dependência já declarada no `packages/core/package.json`.
cat > "$BASE/si.js" <<'JS'
const caminhoSi = process.argv[2];
(async () => {
  const t0 = Date.now();
  try {
    const si = require(caminhoSi);
    const r = await si.fsSize();
    console.log("SI", JSON.stringify({
      ok: true,
      ms: Date.now() - t0,
      entradas: r.length,
      volumes: r.map((e) => ({
        mount: e.mount,
        fs: e.type,
        totalGiB: Math.round(e.size / 1024 ** 3),
        usadoPct: e.use,
      })),
    }));
  } catch (error) {
    console.log("SI", JSON.stringify({
      ok: false,
      ms: Date.now() - t0,
      motivo: String(error && error.code ? error.code : "") + " " + String(error && error.message ? error.message : error).split("\n")[0],
    }));
  }
})();
JS

cd "$BASE"
"$NODE" sonda.js
"$NODE" si.js "$REPO/node_modules/systeminformation"
rm -rf "$BASE"
