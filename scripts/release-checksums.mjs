#!/usr/bin/env node
/**
 * Sumo e verifico os SHA-256 dos artefactos de uma release.
 *
 * Porque isto existe em vez de um `certutil -hashfile` à mão: as somas têm de
 * ser reproduzíveis (mesma ordem, mesmo formato) e têm de ser **verificáveis**
 * por quem descarrega. Produzir um `.txt` que ninguém consegue conferir com uma
 * só instrução não é uma prova de integridade, é uma anedota.
 *
 * O ficheiro de saída é compatível com `sha256sum -c` (`<hex>  <nome>`), e o
 * modo `--check` diz qual falhou em vez de rebentar no primeiro.
 *
 * Uso:
 *   node scripts/release-checksums.mjs <diretório> [--out SHA256SUMS.txt] [--verify]
 *   node scripts/release-checksums.mjs <diretório> --check [SHA256SUMS.txt]
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SUMS_POR_OMISSAO = "SHA256SUMS.txt";

/** Hash SHA-256 em fluxo: um instalador de ~100 MB não pode viver na RAM toda. */
export function sha256Ficheiro(caminho) {
  return new Promise((resolver, rejeitar) => {
    const hash = createHash("sha256");
    const fluxo = createReadStream(caminho);
    fluxo.on("error", rejeitar);
    fluxo.on("data", (bloco) => hash.update(bloco));
    fluxo.on("end", () => resolver(hash.digest("hex")));
  });
}

/**
 * Ficheiros a incluir: tudo o que estiver no topo do diretório, excluído o
 * próprio ficheiro de somas. Subdiretórios ficam de fora — um instalador é
 * somado como ficheiro, e uma pasta inteira não tem hash único honesto.
 */
async function artefactosDoDiretorio(diretorio, excluir) {
  const nomes = (await fs.readdir(diretorio, { withFileTypes: true }))
    .filter((entrada) => entrada.isFile() && !excluir.includes(entrada.name))
    .map((entrada) => entrada.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return nomes;
}

/** Nome de ficheiro de somas: sem travessia, sem separadores, sem CRLF. */
function nomeSeguro(nome) {
  if (typeof nome !== "string" || nome.length === 0) return "nome ausente";
  if (nome.includes("\0") || nome.includes("/") || nome.includes("\\") || /\s/.test(nome.trimEnd())) {
    return `nome inválido: ${JSON.stringify(nome)}`;
  }
  if (path.isAbsolute(nome)) return `nome absoluto: ${JSON.stringify(nome)}`;
  return null;
}

export async function gerarSomas(diretorio, { saida = SUMS_POR_OMISSAO } = {}) {
  const caminhoSaida = path.resolve(diretorio, saida);
  const nomes = await artefactosDoDiretorio(diretorio, [saida]);
  if (nomes.length === 0) throw new Error(`Nenhum artefacto em ${diretorio} — nada foi somado.`);
  const linhas = [];
  for (const nome of nomes) {
    const hex = await sha256Ficheiro(path.join(diretorio, nome));
    linhas.push(`${hex}  ${nome}`);
  }
  const corpo = `${linhas.join("\n")}\n`;
  await fs.writeFile(caminhoSaida, corpo, "utf8");
  return { ficheiros: nomes.length, corpo, saida: caminhoSaida };
}

/**
 * Verificação: o que está listado é comparado com o que existe. Uma linha
 * ilegível ou um nome que tente sair do diretório é **erro**, não ignorado —
 * ignorar é a forma mais cómoda de aprovar um ficheiro que ninguém leu.
 */
export async function verificarSomas(diretorio, saida = SUMS_POR_OMISSAO) {
  const caminho = path.isAbsolute(saida) ? saida : path.resolve(diretorio, saida);
  const texto = await fs.readFile(caminho, "utf8");
  const resultados = [];
  for (const [indice, linha] of texto.split(/\r?\n/).entries()) {
    if (linha.trim() === "") continue;
    const campos = linha.match(/^([0-9a-fA-F]{64}) [ *](.+)$/);
    if (!campos) {
      resultados.push({ nome: `(linha ${indice + 1})`, estado: "formato", esperado: null, obtido: null });
      continue;
    }
    const esperado = campos[1].toLowerCase();
    const nome = campos[2];
    const motivo = nomeSeguro(nome);
    if (motivo) {
      resultados.push({ nome, estado: "inseguro", esperado, obtido: null });
      continue;
    }
    const caminhoFicheiro = path.join(diretorio, nome);
    let actual;
    try {
      const estatuto = await fs.stat(caminhoFicheiro);
      if (!estatuto.isFile()) throw new Error("não é um ficheiro regular");
      actual = await sha256Ficheiro(caminhoFicheiro);
    } catch (erro) {
      resultados.push({ nome, estado: "em_falta", esperado, obtido: null, causa: erro.message });
      continue;
    }
    resultados.push({ nome, estado: actual === esperado ? "ok" : "divergente", esperado, obtido: actual });
  }
  const listados = resultados.filter((r) => r.estado !== "formato").map((r) => r.nome).sort();
  const noDiretorio = await artefactosDoDiretorio(diretorio, [path.basename(caminho)]);
  const naoListados = noDiretorio.filter((n) => !listados.includes(n));
  return { resultados, ok: resultados.every((r) => r.estado === "ok") && naoListados.length === 0, naoListados };
}

async function main(argv) {
  const [diretorio, ...flags] = argv;
  if (!diretorio) {
    console.error("uso: node scripts/release-checksums.mjs <diretório> [--out FICHEIRO] | --check [FICHEIRO]");
    return 2;
  }
  const valorSeguinte = (nome, predef) => {
    const i = flags.indexOf(nome);
    if (i === -1) return predef;
    const seguinte = flags[i + 1];
    return seguinte && !seguinte.startsWith("--") ? seguinte : predef;
  };
  try {
    if (flags.includes("--check")) {
      const { resultados, ok, naoListados } = await verificarSomas(diretorio, valorSeguinte("--check", SUMS_POR_OMISSAO));
      for (const r of resultados) {
        const nota = r.estado === "ok" ? "" : r.estado === "divergente"
          ? `esperado ${r.esperado?.slice(0, 12)}… obtido ${r.obtido?.slice(0, 12) ?? "—"}`
          : r.estado === "inseguro" ? "nome recusado"
            : r.estado === "formato" ? "linha ilegível"
              : r.causa ?? "sem hash";
        console.log(`${r.estado === "ok" ? "OK  " : "FALHA"} ${r.nome}${nota ? ` — ${nota}` : ""}`);
      }
      for (const nome of naoListados) console.log(`FALHA ${nome} — existe no diretório mas não está no ficheiro de somas`);
      if (!ok) console.error("Verificação falhada.");
      return ok ? 0 : 1;
    }
    const resultado = await gerarSomas(diretorio, { saida: valorSeguinte("--out", SUMS_POR_OMISSAO) });
    console.log(`${resultado.ficheiros} ficheiro(s) sumado(s) → ${resultado.saida}`);
    return 0;
  } catch (erro) {
    console.error(`release-checksums: ${erro.message}`);
    return 1;
  }
}

const argv0 = process.argv[1];
if (argv0 && path.resolve(argv0) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
