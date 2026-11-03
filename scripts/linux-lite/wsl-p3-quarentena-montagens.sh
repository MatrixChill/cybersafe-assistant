#!/usr/bin/env bash
# Sonda P3 (Linux Lite) — a quarentena e os PONTOS DE MONTAGEM reais.
#
# O §9 pede que o isolamento respeite «Mount points». §10 acabou de dar ao
# PC Center um botão que analisa um volume montado: o produto passou a ter
# montagens nos seus alvos. Esta sonda mede, na tabela do kernel desta máquina:
#
#   1. se a nossa leitura da tabela é COMPLETA — o número de linhas do kernel
#      contra o número de pontos que o parser devolve e os ilegiveis (um
#      ilegiveis > 0 aqui desligaria o isolamento, por ser fail-closed);
#   2. uma verificação INDEPENDENTE dessa lista com `findmnt`, que lê a mesma
#      tabela por outro caminho (comparação de CONJUNTOS de caminhos: a tabela
#      pode montar o mesmo ponto duas vezes);
#   3. se cada ponto de montagem real é efectivamente recusado pela regra nova;
#   4. se um ficheiro comum NÃO é recusado (a regra não pode virar um botão
#      morto que impede o isolamento de tudo);
#   5. quanto da proteção é NOVA: quantos pontos de montagem reais já eram
#      recusados pelas regras antigas (raízes protegidas / reparse) e quantos
#      passam a sê-lo só por esta regra.
#
# A sonda não move, não copia, não apaga nem desmonta nada, não monta nada, não
# pede root. Escreve apenas em /tmp. Ler /proc/self/mountinfo é a mesma leitura
# que `lerMontagensReais` já faz para o PC Center.
set -u

REPO=/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo
NODE="${NODE:-$HOME/.local/node/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "SEM NODE — definir NODE=/caminho/para/node"; exit 1; fi
echo "KERNEL $(uname -r) | PLATAFORMA $(uname -s) | NODE=$NODE $($NODE -v) | UID $(id -u)"

echo "--- 0. a tabela, antes de qualquer código nosso ---"
echo "LINHAS_MOUNTINFO $(wc -l < /proc/self/mountinfo)"
if command -v findmnt >/dev/null 2>&1; then
  echo "ALVOS_FINDMNT $(findmnt -rno TARGET | wc -l)"
else
  echo "ALVOS_FINDMNT indisponível — a verificação independente não é feita"
fi

if [ ! -f "$REPO/packages/service/dist/quarantine-mounts.js" ] || [ ! -f "$REPO/packages/core/dist/index.js" ]; then
  echo "SEM DIST — correr antes: npm --prefix packages/core build && npm --prefix packages/service build"
  exit 1
fi

MJS=/tmp/rea-p3-quarentena-montagens.mjs
cat > "$MJS" <<'PROGRAMA'
import fs from "node:fs/promises";
import path from "node:path";

const REPO = process.argv[2];
const core = await import(`${REPO}/packages/core/dist/index.js`);
const policy = await import(`${REPO}/packages/service/dist/quarantine-path-policy.js`);
const mounts = await import(`${REPO}/packages/service/dist/quarantine-mounts.js`);

const falhas = [];
const verifica = (nome, condicao, detalhe = "") => {
  console.log(`${condicao ? "OK  " : "FALH"} ${nome}${detalhe ? ` | ${detalhe}` : ""}`);
  if (!condicao) falhas.push(nome);
};

// 1. a tabela lida pelo produto
const tabela = core.lerPontosDeMontagemReais();
console.log(`LEITURA ok=${tabela.ok} pontos=${tabela.montagens.length} ilegiveis=${tabela.ilegiveis} reason=${tabela.reason ?? "—"}`);
verifica("a tabela real é lida", tabela.ok === true);
verifica("a tabela real é completa (sem linhas ilegíveis)", tabela.ilegiveis === 0, `ilegiveis=${tabela.ilegiveis}`);

// 2. verificação independente: findmnt lê a mesma tabela por outro caminho.
// Compara CONJUNTOS de caminhos, não linhas: um ponto de montagem pode ser
// montado por cima de si próprio (medido aqui: `/run/user` e `/tmp/.X11-unix`
// aparecem duas vezes na tabela do WSL2) e o `findmnt` lista as duas ocorrências
// enquanto a nossa lista é de caminhos únicos. Igualdade de linhas seria uma
// asserção sobre como o kernel duplica montagens, não sobre o que lemos.
// Limite desta comparação: um nome com espaço sairia do `findmnt -r` como `\040`
// e de nós como espaço. Nesta máquina não há montagem com espaço, por isso a
// comparação é exercitada; numa que houvesse, um `EM_FALTA` aqui não seria uma
// perda de leitura.
const cp = await import("node:child_process");
const saidaFindmnt = await new Promise((res) =>
  cp.execFile("findmnt", ["-rno", "TARGET"], (err, out) => res(err ? null : out)),
);
if (saidaFindmnt === null) {
  console.log("FINDMNT indisponível — sem verificação independente");
} else {
  const alvos = saidaFindmnt.split("\n").map((linha) => linha.trim()).filter(Boolean);
  const unicos = [...new Set(alvos)].sort();
  const duplicados = alvos.length - unicos.length;
  const nossos = [...tabela.montagens].sort();
  const emFalta = unicos.filter((a) => !nossos.includes(a));
  const aMais = nossos.filter((m) => !unicos.includes(m));
  console.log(`FINDMNT linhas=${alvos.length} unicos=${unicos.length} duplicados=${duplicados} | nossos=${nossos.length}`);
  if (emFalta.length) console.log(`  EM_FALTA ${JSON.stringify(emFalta)}`);
  if (aMais.length) console.log(`  A_MAIS ${JSON.stringify(aMais)}`);
  verifica("os caminhos do findmnt são exatamente os nossos", emFalta.length === 0 && aMais.length === 0);
}

// 3. cada ponto de montagem real é recusado, com o motivo certo
const recusas = tabela.montagens.map((m) => [m, mounts.quarantineMountRefusal(m, "linux")]);
const naoRecusados = recusas.filter(([, motivo]) => motivo !== "mount-point");
verifica("todos os pontos de montagem reais são recusados", naoRecusados.length === 0,
  `recusados=${recusas.length - naoRecusados.length}/${recusas.length}`);
if (naoRecusados.length) console.log(`  NAO_RECUSADOS ${JSON.stringify(naoRecusados.slice(0, 8))}`);

// 4. ficheiros reais NÃO são recusados (a regra não pode ser um botão morto)
const ficheirosReais = [];
for (const candidato of ["/etc/hostname", "/usr/bin/true", "/bin/sh"]) {
  try { await fs.stat(candidato); ficheirosReais.push(candidato); } catch { /* não existe aqui */ }
}
const tmpFicheiro = "/tmp/rea-p3-quarentena-montagens.bin";
await fs.writeFile(tmpFicheiro, "sonda");
ficheirosReais.push(tmpFicheiro);
for (const ficheiro of ficheirosReais) {
  const motivo = mounts.quarantineMountRefusal(ficheiro, "linux");
  verifica(`ficheiro real não é recusado: ${ficheiro}`, motivo === null, `motivo=${motivo ?? "null"}`);
}
// e o filho directo de uma montagem também não: é isso que a igualdade garante
const dentroDeUmaMontagem = tabela.montagens.find((m) => m !== "/") ?? "/";
const filho = path.posix.join(dentroDeUmaMontagem, "qualquer-coisa.txt");
verifica(`ficheiro dentro da montagem ${dentroDeUmaMontagem} não é a montagem`,
  mounts.quarantineMountRefusal(filho, "linux") === null, filho);

// 5. quanto da proteção é NOVA
let soPorEstaRegra = 0;
const exemplosNovos = [];
for (const m of tabela.montagens) {
  const protegido = policy.isProtectedQuarantinePath(m, { baseDir: REPO, execPath: process.execPath });
  let reparseOk = true;
  try { reparseOk = await policy.hasReparseFreePath(m); } catch { reparseOk = false; }
  if (!protegido && reparseOk) {
    soPorEstaRegra += 1;
    if (exemplosNovos.length < 6) exemplosNovos.push(m);
  }
}
verifica("há montagens reais que SÓ esta regra protege", soPorEstaRegra > 0,
  `${soPorEstaRegra} de ${tabela.montagens.length}`);
console.log(`  EXEMPLOS_SO_NOVA ${JSON.stringify(exemplosNovos)}`);

// 6. em Windows a tabela nem é aberta
let aberta = 0;
const lerContando = () => { aberta += 1; return tabela; };
verifica("win32 não abre a tabela de montagens",
  mounts.quarantineMountRefusal("/mnt/c", "win32", lerContando) === null && aberta === 0);

// 7. sem tabela, a recusa é conservadora
verifica("tabela ilegível recusa (fail-closed)",
  mounts.quarantineMountRefusal("/home/u/a.bin", "linux", () => ({ ok: false, montagens: [], ilegiveis: 0, reason: "x" }))
    === "mount-table-unreadable");
verifica("tabela incompleta recusa (fail-closed)",
  mounts.quarantineMountRefusal("/home/u/a.bin", "linux", () => ({ ok: true, montagens: tabela.montagens, ilegiveis: 1, reason: "x" }))
    === "mount-table-incomplete");

await fs.rm(tmpFicheiro, { force: true }).catch(() => {});
console.log(falhas.length ? `RESULTADO FALHAS=${falhas.length} ${JSON.stringify(falhas)}` : "RESULTADO SEM FALHAS");
process.exit(falhas.length ? 1 : 0);
PROGRAMA

"$NODE" "$MJS" "$REPO"
codigo=$?
echo "CODIGO_SAIDA $codigo"
exit $codigo
