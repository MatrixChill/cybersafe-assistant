#!/usr/bin/env node
/**
 * `build:all` ORDENADO pelas dependências reais dos workspaces.
 *
 * Porque existe: `npm run build --workspaces` percorre os workspaces por ordem
 * alfabética (`api, app, core, desktop, extension, native-windows, service,
 * shared-types`) e deixa `@cybersafe/shared-types` para ÚLTIMO. Como todos os
 * pacotes resolvem `@cybersafe/*` pelo `dist/` (campo `types`/`main`), um clone
 * limpo — onde `dist/` não existe porque o `.gitignore` o exclui — falha logo no
 * primeiro workspace (`api`) com TS2307, antes de o `shared-types` alguma vez
 * ser construído.
 *
 * Aqui a ordem é topológica e o fail-fast mantém-se: ao primeiro erro para
 * tudo e o exit code é 1 (mesma semântica de falha do `--workspaces`).
 *
 * `packages/native-engine` (C++/CMake) NÃO entra nesta lista: não é workspace
 * npm e tem o seu próprio comando suportado, `npm run build:native`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Ordem canónica. `shared-types` primeiro (folha); `service` só depois de
 * `core` + `native-windows`; `desktop` por último (depende de `core`,
 * `shared-types`, `service` e `api`). `extension` depende apenas de
 * `shared-types`.
 */
export const ORDEM_BUILD = Object.freeze([
  "@cybersafe/shared-types",
  "@cybersafe/core",
  "@cybersafe/native-windows",
  "@cybersafe/service",
  "api",
  "extension",
  "@cybersafe/app",
  "@cybersafe/desktop",
]);

/** Nome de workspace seguro para interpolar num comando (defesa em profundidade). */
const NOME_SEGURO = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

/**
 * Lê o grafo dos workspaces reais (dirs de `packages/*` com `package.json`) e,
 * para cada um, as suas dependências internas (`@cybersafe/*` e nomes locais).
 */
export function lerGrafoWorkspaces(dirPackages = path.join(RAIZ, "packages")) {
  const grafo = new Map();
  for (const entrada of readdirSync(dirPackages, { withFileTypes: true })) {
    if (!entrada.isDirectory()) continue;
    const relativo = path.join("packages", entrada.name, "package.json");
    let dados;
    try {
      dados = JSON.parse(readFileSync(path.join(RAIZ, relativo), "utf8"));
    } catch {
      continue;
    }
    if (typeof dados.name !== "string" || dados.name.length === 0) continue;
    grafo.set(dados.name, { dir: `packages/${entrada.name}`, deps: [] });
  }
  for (const [nome, info] of grafo) {
    const dados = JSON.parse(readFileSync(path.join(RAIZ, info.dir, "package.json"), "utf8"));
    const juntas = { ...dados.dependencies, ...dados.devDependencies, ...dados.peerDependencies };
    info.deps = Object.keys(juntas).filter((dep) => dep !== nome && grafo.has(dep));
  }
  return grafo;
}

/**
 * Devolve a lista de problemas da ordem: `[]` quando é válida.
 * Verifica duplicados, workspaces em falta/desconhecidos e, sobretudo, que cada
 * dependência interna é construída ANTES de quem depende dela.
 */
export function validarOrdemDeBuild(ordem, grafo = lerGrafoWorkspaces()) {
  const problemas = [];
  const posicao = new Map();
  ordem.forEach((nome, indice) => {
    if (posicao.has(nome)) problemas.push(`duplicado na ordem: ${nome}`);
    else posicao.set(nome, indice);
  });
  for (const nome of grafo.keys()) if (!posicao.has(nome)) problemas.push(`em falta na ordem: ${nome}`);
  for (const nome of ordem) if (!grafo.has(nome)) problemas.push(`desconhecido na ordem: ${nome}`);
  for (const [nome, info] of grafo) {
    const alvo = posicao.get(nome);
    if (alvo === undefined) continue;
    for (const dep of info.deps) {
      const origem = posicao.get(dep);
      if (origem !== undefined && origem > alvo) {
        problemas.push(`${nome} seria construído antes da sua dependência ${dep}`);
      }
    }
  }
  return problemas;
}

/** Execução real de um passo: `npm run build -w <nome>`. */
export function correrWorkspace(nome) {
  const resultado = spawnSync(`npm run build -w "${nome}"`, {
    cwd: RAIZ,
    stdio: "inherit",
    shell: true,
  });
  const ok = resultado.status === 0;
  return { ok, erro: ok ? "" : `exit ${resultado.status ?? resultado.signal ?? "desconhecido"}` };
}

/**
 * Corre a ordem com fail-fast. `correr` é injectável para que os testes usem
 * subprocessos mockados e possam afirmar a sequência exata sem correr npm.
 */
export async function correrBuildOrdenado({ ordem = ORDEM_BUILD, correr = correrWorkspace, registar = console.log } = {}) {
  const corridos = [];
  for (const nome of ordem) {
    if (!NOME_SEGURO.test(nome)) {
      return { ok: false, falhou: nome, corridos, erro: `nome de workspace inválido: ${nome}` };
    }
    registar(`> build ${nome}`);
    let resultado;
    try {
      resultado = await correr(nome);
    } catch (erro) {
      const motivo = erro instanceof Error ? erro.message : String(erro);
      return { ok: false, falhou: nome, corridos, erro: `build falhou em ${nome}: ${motivo}` };
    }
    if (!resultado || resultado.ok !== true) {
      const detalhe = resultado && resultado.erro ? `: ${resultado.erro}` : "";
      return { ok: false, falhou: nome, corridos, erro: `build falhou em ${nome}${detalhe}` };
    }
    corridos.push(nome);
  }
  return { ok: true, falhou: null, corridos, erro: null };
}

const invocadoComoScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invocadoComoScript) {
  const problemas = validarOrdemDeBuild(ORDEM_BUILD);
  if (problemas.length > 0) {
    console.error(`Ordem de build inválida:\n- ${problemas.join("\n- ")}`);
    process.exit(1);
  }
  const resultado = await correrBuildOrdenado();
  if (!resultado.ok) {
    console.error(`\nbuild:all ABORTOU (fail-fast) — ${resultado.erro}`);
    process.exit(1);
  }
  console.log(`\nbuild:all concluído: ${resultado.corridos.length} workspaces, por ordem de dependências.`);
}
