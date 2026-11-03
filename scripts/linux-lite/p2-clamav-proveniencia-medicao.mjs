/**
 * Medição em Linux real (WSL2) da proveniência do binário ClamAV.
 *
 * A pergunta que o fake injectado não responde: num host Linux onde o
 * `clamscan.exe` do Windows ESTÁ no disco (via `/mnt/c`), o resolutor recusa-o
 * mesmo assim? Aqui o leitor é o real — `statSync`, `accessSync(X_OK)` e os dois
 * primeiros bytes lidos do ficheiro — e os candidatos são ficheiros verdadeiros.
 *
 * Nada é executado. O binário Windows é copiado e lido, nunca lançado, e os
 * ficheiros criados pertencem a esta medição e são apagados no fim.
 *
 * Corre a partir da raiz da cópia do repo no Linux, usando o `dist` compilado.
 */
import { chmodSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selecionaClamavBinario,
  diagnoseClamavBinary,
  clamavBinaryCandidates,
  CLAMAV_BINARY_ENV,
} from "@cybersafe/core";

const criados = [];
let proximo = 0;
function caminhoNovo() {
  const caminho = join(tmpdir(), `cs-proveniencia-${process.pid}-${(proximo += 1)}`);
  criados.push(caminho);
  return caminho;
}

const resultados = [];
function caso(nome, candidatos, esperado) {
  const { escolhido, recusados } = selecionaClamavBinario(candidatos, "linux");
  const obtido = escolhido
    ? `escolhido:${escolhido.path}`
    : `recusado:${recusados[0]?.motivo ?? "nada no disco"}`;
  resultados.push({
    caso: nome,
    resultado: obtido,
    recusados: recusados.map((r) => `${r.path} → ${r.motivo}`),
    veredicto: esperado.test(obtido) ? "CONFORME" : "DIVERGENTE",
  });
}

const notepadDoWindows = "/mnt/c/Windows/System32/notepad.exe";
const peComNomePosix = caminhoNovo();
copyFileSync(notepadDoWindows, peComNomePosix);
const semBitDeExecucao = caminhoNovo();
writeFileSync(semBitDeExecucao, "#!/bin/sh\necho ola\n");
chmodSync(semBitDeExecucao, 0o644);

caso("PE de Windows com o nome real (.exe)", [{ path: notepadDoWindows, source: "explicit" }], /\.exe/);
caso(
  "o MESMO PE com nome POSIX: recusado pela assinatura, não pelo nome",
  [{ path: peComNomePosix, source: "explicit" }],
  /PE de Windows/,
);
caso("ficheiro comum sem bit de execução", [{ path: semBitDeExecucao, source: "unix" }], /permissão de execução/);
caso("executável Linux real", [{ path: "/bin/true", source: "unix" }], /^escolhido:\/bin\/true/);
caso(
  "pin recusado não tapa o PATH: nenhum candidato utilizável",
  clamavBinaryCandidates({ [CLAMAV_BINARY_ENV]: notepadDoWindows, PATH: "" }, "linux"),
  /^recusado:/,
);

const diagnostico = diagnoseClamavBinary({
  env: { [CLAMAV_BINARY_ENV]: notepadDoWindows, PATH: "" },
  platform: "linux",
});
resultados.push({
  caso: "diagnóstico lido no disco real",
  resolved: diagnostico.resolved,
  recusados: diagnostico.recusados.map((r) => `${r.path} → ${r.motivo}`),
  existemNoDisco: diagnostico.candidates.filter((c) => c.exists).map((c) => c.path),
  veredicto:
    diagnostico.resolved === null && diagnostico.recusados.length > 0 ? "CONFORME" : "DIVERGENTE",
});

const limpezas = [];
for (const caminho of criados) {
  try {
    rmSync(caminho, { force: true });
    limpezas.push(`${caminho}: apagado`);
  } catch (erro) {
    limpezas.push(`${caminho}: FALHA ${erro?.code ?? erro}`);
  }
}

console.log(
  JSON.stringify(
    {
      ambiente: `${process.platform} ${process.release?.name} ${process.arch}`,
      uid: process.getuid?.(),
      leitor: "real — statSync, accessSync(X_OK), dois bytes do ficheiro",
      casos: resultados,
      limpezas,
    },
    null,
    1,
  ),
);
process.exit(0);
