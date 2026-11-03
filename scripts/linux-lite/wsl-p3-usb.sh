#!/usr/bin/env bash
# §10 Linux Lite — mede a deteção de USB em Linux real (sysfs + mountinfo).
#
# Corre DENTRO de WSL2/Linux. A máquina da medição não tem pen ligada: por isso
# o script imprime o FATO por disco (`SYSBLOCK`) e a resposta independente de
# `/dev/disk/by-id`, em vez de imprimir apenas «0 dispositivos». Zero sem esses
# factos não distinguiria «não há pen» de «não sei ler o sysfs».
#
# Reproduzir (do Windows):
#   wsl -e bash -lc 'S=/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo/scripts/linux-lite; \
#     tr -d "\015" < $S/wsl-p3-usb.sh > /tmp/usb.sh && bash /tmp/usb.sh'
set -euo pipefail

NODE="${NODE:-$HOME/.local/node/bin/node}"
REPO="${REPO:-/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo}"
BASE="$(mktemp -d)"
trap 'rm -rf "$BASE"' EXIT

cat > "$BASE/sonda.mjs" <<'JS'
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = process.env.REPO;
const { detetarUsbReais, temTransporteUsb } = await import(
  `${REPO}/packages/core/dist/usb-posix.js`
);
const { criarDeteccaoUsbPosix } = await import(
  `${REPO}/packages/service/dist/usb-detection-adapter-posix.js`
);

// 1) O que o sysfs realmente declara por disco — a matéria-prima da decisão.
for (const nome of fs.readdirSync("/sys/block").sort()) {
  const dir = path.join("/sys/block", nome);
  const alvo = fs.readlinkSync(dir);
  const texto = (f) => {
    try { return fs.readFileSync(path.join(dir, f), "utf-8").trim(); } catch { return null; }
  };
  console.log("SYSBLOCK", JSON.stringify({
    nome,
    dev: texto("dev"),
    removivel: texto("removable"),
    gib: Math.round(Number(texto("size") ?? "0") * 512 / 1024 ** 3 * 10) / 10,
    usb: temTransporteUsb(alvo),
    serie: texto("device/serial"),
  }));
}

// 2) A deteção do módulo, com todas as listas que ele devolve.
const r = detetarUsbReais();
console.log("USB", JSON.stringify({
  ok: r.ok,
  motivo: r.motivo,
  dispositivos: r.dispositivos.map((d) => ({
    id: d.id, proveniencia: d.identityProvenance, rootPath: d.rootPath,
    rootPaths: d.rootPaths, disco: d.nomeBloco, dev: d.dispositivo, amovivel: d.amovivel,
  })),
  semVolume: r.semVolume,
  naoAtribuidos: r.naoAtribuidos,
  ilegiveis: r.ilegiveis,
  observados: r.observados,
}));

// 3) A porta do monitor, instanciada como o engine faz em Linux.
const porta = criarDeteccaoUsbPosix();
try {
  const lista = await porta.listar();
  console.log("PORTA", JSON.stringify({ ok: true, semEstadoEspera: porta.listarPendentes === undefined, dispositivos: lista }));
} catch (erro) {
  console.log("PORTA", JSON.stringify({ ok: false, motivo: String(erro instanceof Error ? erro.message : erro) }));
}

// 4) Verificação independente: o udev chama-lhes `usb-*` quando há USB storage.
let byId = [];
try { byId = fs.readdirSync("/dev/disk/by-id"); } catch { byId = ["<sem /dev/disk/by-id>"]; }
console.log("BYID", JSON.stringify({ usb: byId.filter((n) => n.toLowerCase().includes("usb")), total: byId.length }));
JS

cd "$REPO"
REPO="$REPO" "$NODE" "$BASE/sonda.mjs"
echo "KERNEL $(uname -r) | PLATAFORMA $(uname -s) | UID $(id -u)"
