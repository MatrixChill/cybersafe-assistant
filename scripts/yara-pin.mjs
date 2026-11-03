#!/usr/bin/env node
/**
 * Pin verificado das fontes YARA (decisão D4 do proprietário, 2026-11-01).
 *
 * O modelo anterior era o oposto do que foi aprovado: o updater buscava
 * `.../<repo>/master/<ficheiro>`, ou seja, aceitava automaticamente o que uma
 * branch mutável publicasse, desde que compilasse. Compilar não é revisar.
 *
 * Aqui a fonte passa a ser identificada por **commit** e o conteúdo por
 * **SHA-256**, e nada é aceite sem um passo de revisão humano:
 *
 *   --check     compara o que está pinado em `packages/service/src/updater.ts`
 *               com o que o repositório upstream tem hoje; saída legível, e
 *               `exit 1` quando há derivação (é o que uma verificação periódica
 *               ou o CI correm). Não escreve nada.
 *   --propose   mostra as entradas novas (commit + sha256 + bytes + regras) sem
 *               tocar em código.
 *   --write     aplica as entradas propostas ao ficheiro de código. Só com esta
 *               flag explícita; o pipeline do updater nunca a chama.
 *
 * Rever = um commit. É a única forma de o pin se mover, e fica no histórico.
 * O URL usado em runtime é `raw.githubusercontent.com/<repo>/<commit>/<caminho>`:
 * imutável por construção, mais o digest verificado depois da descarga.
 */
import { createHash } from "node:crypto";
import * as https from "node:https";
import * as fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const UPDATER_FILE = path.resolve(HERE, "..", "packages/service/src/updater.ts");
const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/** As quatro fontes actuais; o `branch` é só para resolver o commit em revisão. */
export const FONTES = [
  { id: "MALW_Eicar.yar", repo: "Yara-Rules/rules", file: "malware/MALW_Eicar.yar", branch: "master", ruleClass: "test" },
  { id: "packer_compiler_signatures.yar", repo: "Yara-Rules/rules", file: "packers/packer_compiler_signatures.yar", branch: "master", ruleClass: "reference" },
  { id: "crypto_signatures.yar", repo: "Yara-Rules/rules", file: "crypto/crypto_signatures.yar", branch: "master", ruleClass: "reference" },
  { id: "RANSOM_MS17-010_Wannacrypt.yar", repo: "Yara-Rules/rules", file: "malware/RANSOM_MS17-010_Wannacrypt.yar", branch: "master", ruleClass: "production" },
];

export const COMMIT = /^[0-9a-f]{40}$/;
export const DIGESTO = /^[0-9a-f]{64}$/;

function obter(url, sinais = {}) {
  return new Promise((resolver, rejeitar) => {
    https.get(url, { headers: { "user-agent": "cybersafe-yara-pin", accept: "application/vnd.github+json", ...sinais }, timeout: 30_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        return obter(res.headers.location, sinais).then(resolver, rejeitar);
      }
      if (res.statusCode !== 200) {
        res.destroy();
        return rejeitar(new Error(`HTTP ${res.statusCode} em ${url.replace(/^https:\/\//, "")}`));
      }
      const partes = [];
      let bytes = 0;
      res.on("data", (p) => { bytes += p.length; if (bytes > 16 * 1024 * 1024) { res.destroy(); rejeitar(new Error("resposta acima de 16 MiB")); } partes.push(p); });
      res.on("error", rejeitar);
      res.on("end", () => resolver({ corpo: Buffer.concat(partes).toString("utf8"), status: res.statusCode }));
    }).on("error", rejeitar).on("timeout", () => rejeitar(new Error(`timeout em ${url}`)));
  });
}

/** Commit que alterou por último este caminho nesta branch — não a ponta da branch. */
export async function resolverCommit(fonte, obterURL = obter) {
  const url = `${API}/repos/${fonte.repo}/commits?path=${encodeURIComponent(fonte.file)}&sha=${fonte.branch}&per_page=1`;
  const { corpo } = await obterURL(url);
  const lista = JSON.parse(corpo);
  if (!Array.isArray(lista) || lista.length === 0 || typeof lista[0]?.sha !== "string") {
    throw new Error(`sem commits para ${fonte.repo}/${fonte.file}`);
  }
  const sha = lista[0].sha.toLowerCase();
  if (!COMMIT.test(sha)) throw new Error(`sha inesperado: ${sha}`);
  return { revision: sha, autor: lista[0].commit?.author?.date ?? null };
}

export function urlPinning(repo, revision, file) {
  return `${RAW}/${repo}/${revision}/${file}`;
}

export async function medirFonte(fonte, obterURL = obter) {
  const { revision, autor } = await resolverCommit(fonte, obterURL);
  const { corpo } = await obterURL(urlPinning(fonte.repo, revision, fonte.file), { accept: "text/plain" });
  const sha256 = createHash("sha256").update(corpo, "utf8").digest("hex");
  const regras = (corpo.match(/^\s*rule\s+[A-Za-z_]\w*\s*(:|\{)/gm) || []).length;
  return { ...fonte, revision, autor, sha256, bytes: Buffer.byteLength(corpo, "utf8"), regras };
}

/** Bloco de código que este script mantém; a âncora é partilhada com os testes. */
export const ÂNCORA_INÍCIO = "/* yara:pinned-sources:inicio */";
export const ÂNCORA_FIM = "/* yara:pinned-sources:fim */";

export function aRenderizar(medidas) {
  const linhas = medidas.map((m) =>
    `  { id: ${JSON.stringify(m.id)}, repo: ${JSON.stringify(m.repo)}, file: ${JSON.stringify(m.file)}, `
    + `revision: ${JSON.stringify(m.revision)}, sha256: ${JSON.stringify(m.sha256)}, ruleClass: ${JSON.stringify(m.ruleClass)} },`);
  return [
    ÂNCORA_INÍCIO,
    "/* Mantido por `scripts/yara-pin.mjs`. Rever = correr `--write`, o que é um",
    "   commit: nada entra no corpus sem um humano ter aprovado o diff. */",
    "export const YARA_PIN: Array<{ id: string; repo: string; file: string; revision: string; sha256: string; ruleClass: YaraRuleClass }> = [",
    ...linhas,
    "];",
    ÂNCORA_FIM,
  ].join("\n");
}

export function aplicarBloco(código, medidas) {
  const início = código.indexOf(ÂNCORA_INÍCIO);
  const fim = código.indexOf(ÂNCORA_FIM);
  if (início === -1 || fim === -1 || fim < início) throw new Error("âncoras `yara:pinned-sources` não encontradas — não se adivinha onde escrever");
  return `${código.slice(0, início)}${aRenderizar(medidas)}${código.slice(fim + ÂNCORA_FIM.length)}`;
}

/** O que o `updater.ts` tem pinado hoje, lido do mesmo bloco. */
export function lerPins(código) {
  const início = código.indexOf(ÂNCORA_INÍCIO);
  const fim = código.indexOf(ÂNCORA_FIM);
  if (início === -1 || fim === -1) return [];
  const bloco = código.slice(início, fim);
  return [...bloco.matchAll(/\{ id: "([^"]+)", repo: "([^"]+)", file: "([^"]+)", revision: "([0-9a-f]{40})", sha256: "([0-9a-f]{64})", ruleClass: "([^"]+)" \}/g)]
    .map((m) => ({ id: m[1], repo: m[2], file: m[3], revision: m[4], sha256: m[5], ruleClass: m[6] }));
}

async function main(argv) {
  const modo = argv.includes("--write") ? "write" : argv.includes("--propose") ? "propose" : argv.includes("--check") ? "check" : null;
  if (!modo) {
    process.stdout.write("uso: node scripts/yara-pin.mjs --check | --propose | --write\n");
    return 2;
  }
  const código = fs.readFileSync(UPDATER_FILE, "utf8");
  const actuais = lerPins(código);
  const medidas = [];
  const erros = [];
  for (const fonte of FONTES) {
    try {
      medidas.push(await medirFonte(fonte));
    } catch (erro) {
      erros.push(`${fonte.id}: ${erro.message}`);
    }
  }
  if (erros.length > 0) {
    process.stderr.write(`yara-pin: upstream não consultado — ${erros.join("; ")}\n`);
    return 1;
  }
  const deriva = medidas.filter((m) => {
    const pin = actuais.find((a) => a.id === m.id);
    return !pin || pin.revision !== m.revision || pin.sha256 !== m.sha256;
  });

  if (modo === "check") {
    for (const m of medidas) {
      const pin = actuais.find((a) => a.id === m.id);
      const novo = deriva.some((d) => d.id === m.id);
      process.stdout.write(`${novo ? "DERIVA" : "IGUAL "} ${m.id} pin=${pin?.revision?.slice(0, 12) ?? "—"} upstream=${m.revision.slice(0, 12)} regras=${m.regras} bytes=${m.bytes} autor=${m.autor ?? "?"}\n`);
    }
    process.stdout.write(deriva.length === 0
      ? `yara-pin: ${medidas.length} fontes conformes com o pin.\n`
      : `yara-pin: ${deriva.length} fonte(s) com conteúdo novo por rever.\n`);
    return deriva.length === 0 ? 0 : 1;
  }

  for (const m of medidas) {
    process.stdout.write(`  { id: ${JSON.stringify(m.id)}, repo: ${JSON.stringify(m.repo)}, file: ${JSON.stringify(m.file)}, revision: ${JSON.stringify(m.revision)}, sha256: ${JSON.stringify(m.sha256)}, ruleClass: ${JSON.stringify(m.ruleClass)} }, // ${m.regras} regras, ${m.bytes} bytes, ${m.autor ?? "?"}\n`);
  }
  if (modo === "propose") {
    process.stdout.write(`yara-pin: propostas acima; nada foi escrito. ${deriva.length} fonte(s) mudaram desde o último pin.\n`);
    return 0;
  }
  fs.writeFileSync(UPDATER_FILE, aplicarBloco(código, medidas.map((m) => ({ ...m }))), "utf8");
  process.stdout.write(`yara-pin: bloco de pin actualizado em ${path.relative(path.resolve(HERE, ".."), UPDATER_FILE)} — reveja o diff antes de commitar.\n`);
  return 0;
}

const argv0 = process.argv[1];
if (argv0 && path.resolve(argv0) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
