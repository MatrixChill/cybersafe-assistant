#!/usr/bin/env bash
# Sonda P3 (Linux Lite) — o alvo «volume montado» no caminho real de Linux.
#
# Mede o que nenhum teste em Windows pode medir:
#   1. o tamanho que o kernel DECLARA para /proc/kcore — o motivo de a poda ter
#      de acontecer antes de qualquer leitura (o hash é feito antes do portão de
#      tamanho);
#   2. se o `dist` do serviço importado no Node de Linux traz o corte (a rede do
#      serviço inclui binários nativos; se falhar, é aqui que se vê);
#   3. se o walk recolhe ficheiros de um alvo POSIX real, poda as raizes do
#      kernel ANTES de tocar no disco, e mantém as exclusões de sempre.
#
# /proc, /sys, /dev e /run são podados por decisão, por isso o `readdir` nunca é
# feito lá. Não há alvo «/» nesta sonda: andar por / seria percorrer a máquina.
# Não analisa ficheiros, não monta nada, escreve apenas em /tmp.
set -u

REPO=/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo
# O Node de Linux vive em $HOME/.local/node (instalação manual, não no PATH de
# uma shell não interativa). Sem aqui, a sonda pararia — é o arranque das outras
# sondas deste directório, não uma invenção.
NODE="${NODE:-$HOME/.local/node/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "SEM NODE — definir NODE=/caminho/para/node"; exit 1; fi
echo "KERNEL $(uname -r) | PLATAFORMA $(uname -s) | NODE=$NODE $($NODE -v) | UID $(id -u)"

echo "--- 1. o que o kernel declara sobre /proc/kcore ---"
stat -c 'STAT %n tamanhoDeclarado=%s bytes | blocosFisicos=%b x %B' /proc/kcore 2>&1 | head -1

echo "--- 2. o dist do serviço importa em Linux, e traz o corte? ---"
if [ ! -f "$REPO/packages/service/dist/scan-manager.js" ]; then
  echo "SEM DIST — correr antes: npm --prefix packages/service build"
else
  "$NODE" -e '
    try {
      const m = require(process.argv[1]);
      console.log("IMPORT ok | exportacoesDoCorte=" +
        JSON.stringify(["eRaizDoKernelPosix", "RAIZES_DO_KERNEL_POSIX"].filter((n) => n in m)) +
        "| ScanManager=" + ("ScanManager" in m));
    } catch (e) {
      console.log("IMPORT falhou | " + String(e && e.message).split("\n")[0].slice(0, 220));
    }
  ' "$REPO/packages/service/dist/scan-manager.js" 2>&1 | tail -3
fi

echo "--- 3. walk real: alvo POSIX vs raizes do kernel ---"
rm -rf /tmp/p3alvo
mkdir -p /tmp/p3alvo/subpasta /tmp/p3alvo/node_modules /tmp/p3alvo/.git /tmp/p3alvo/proc
printf 'um\n'  > /tmp/p3alvo/a.txt
printf 'dois\n' > /tmp/p3alvo/subpasta/b.txt
printf 'tres\n' > /tmp/p3alvo/c.dat
printf 'x\n'    > /tmp/p3alvo/node_modules/d.txt
printf 'x\n'    > /tmp/p3alvo/.git/e.txt
printf 'x\n'    > /tmp/p3alvo/proc/f.txt
ln -s /tmp/p3alvo/a.txt /tmp/p3alvo/elo.txt

"$NODE" -e '
  const espera = async (fn) => {
    const d = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try { return await fn(); } finally { Object.defineProperty(process, "platform", d); }
  };
  let m;
  try { m = require(process.argv[1]); }
  catch (e) { console.log("WALK indisponivel — " + String(e && e.message).split("\n")[0].slice(0, 140)); process.exit(0); }
  const SM = m.ScanManager;
  if (!SM) { console.log("WALK indisponivel — sem ScanManager"); process.exit(0); }
  // `this` tem de herdar do protótipo: o walk recursa com `this.gatherFiles`.
  const este = () => Object.create(SM.prototype, { isCancelled: { value: new Set() } });
  const alvos = ["/tmp/p3alvo", "/tmp/p3alvo/proc", "/proc", "/sys", "/dev", "/run"];
  // `node -e` corre como CommonJS: sem este `async` à volta, o `await` do laço
  // seria um erro de sintaxe e a sonda não diria nada.
  (async () => {
    for (const nome of ["gatherFiles", "gatherFilesQuick"]) {
      for (const alvo of alvos) {
        const linha = await espera(async () => {
          const files = [];
          const stats = { failed: 0, failedByReason: {} };
          const t0 = Date.now();
          if (nome === "gatherFiles") await SM.prototype.gatherFiles.call(este(), alvo, files, "s1", 50000, stats);
          else await SM.prototype.gatherFilesQuick.call(este(), alvo, files, "s1", 0, 3, 800, stats);
          return { alvo, ficheiros: files.length, exemplar: files[0] || null, falhos: stats.failed, ms: Date.now() - t0 };
        });
        console.log("WALK " + nome + " " + JSON.stringify(linha));
      }
    }
  })();
' "$REPO/packages/service/dist/scan-manager.js" 2>&1 | tail -20

rm -rf /tmp/p3alvo
echo "FIM"
