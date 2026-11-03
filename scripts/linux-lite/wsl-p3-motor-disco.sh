#!/usr/bin/env bash
# Mede o MOTOR REAL de hardware em Linux: o snapshot de disco vem agora de
# `/proc/self/mountinfo` + `statfs`, e não de `si.fsSize()`. Não monta nada, não
# escreve fora de /tmp, não precisa de root.
#
# Também responde a uma pergunta que os testes unitários não podem responder:
# `packages/core/dist/hardware.js` CARREGA em Linux? (importa `win-kernel.js` e
# `win-pdh.js`, que tocam em koffi/Windows.) Se não carregar, isso é um defeito
# de arranque Linux, e é aqui que aparece em vez de aparecer no ecrã.
#
# Uso: bash wsl-p3-motor-disco.sh [pasta-do-repo]
set -euo pipefail

REPO="${1:-/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo}"
CORE="$REPO/packages/core"
NODE="${NODE:-$HOME/.local/node/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node)"

if [ ! -f "$CORE/dist/hardware.js" ]; then
  echo "SEM_DIST: falta $CORE/dist/hardware.js (correr antes: npm run build -w @cybersafe/core)"
  exit 2
fi

cat > /tmp/cybersafe-motor-disco.mjs <<'JS'
const { HardwareHealthEngine } = await import(process.argv[2]);
const engine = new HardwareHealthEngine();
const snap = await engine.getSnapshot([]);
const d = snap.disk;
console.log("MOTOR", JSON.stringify({
  plataforma: process.platform,
  leitura: d.readStatus,
  motivo: d.reason,
  primario: d.primary?.mount ?? null,
  usoPrimario: d.usagePercent,
  volumes: d.volumes.map((v) => ({
    mount: v.mount,
    fs: v.fileSystem,
    tipo: v.kind,
    ro: v.readOnly,
    uso: v.usagePercent,
    livreGiB: v.freeGb,
  })),
  alertasDisco: (snap.alerts ?? [])
    .filter((a) => a.category === "disk")
    .map((a) => a.title),
}));
JS

cd "$CORE"
"$NODE" /tmp/cybersafe-motor-disco.mjs "$CORE/dist/hardware.js"
echo "KERNEL $(uname -r)"
