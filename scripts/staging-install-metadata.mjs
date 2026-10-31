/**
 * Metadados de INSTALAÇÃO do staging que não são usados em runtime.
 *
 * CAUSA MEDIDA (candidata QA1, 2026-10-25): o `npm install` da árvore de
 * staging escreve `package-lock.json` e `node_modules/.package-lock.json` com
 * `file:C:/Users/<user>/AppData/Local/Temp/cybersafe-package-<id>/tarballs/<pacote>.tgz`.
 * O `node_modules/**` é empacotado, por isso `.package-lock.json` viajaria com
 * o caminho absoluto do build; e a verificação de staging recusa (e bem) esse
 * marcador. Os dois ficheiros só servem para repetir a instalação — coisa que
 * dentro do pacote nunca acontece.
 *
 * A correção NÃO alarga a remoção a metadados arbitrários: apaga exactamente
 * estes dois caminhos, exige que sejam ficheiros regulares, e PROVA antes/depois
 * que todo o recurso de runtime (manifestos instalados, addons `.node`) se
 * mantém. Os documentos de `assets/licenses` viajam por `extraResources`, não
 * entram nesta decisão. O lockfile do REPOSITÓRIO não é tocado.
 */

import fs from "node:fs";
import path from "node:path";

/** Os únicos dois caminhos que este passo pode remover (relativos a `appDir`). */
export const STAGING_INSTALL_METADATA = Object.freeze([
  "package-lock.json",
  "node_modules/.package-lock.json",
]);

const MAX_DEPTH = 6;

function walk(dir, depth, { manifests, addons }) {
  if (depth > MAX_DEPTH || !fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // a verificação de staging trata dos links
    if (entry.isDirectory()) {
      if (fs.existsSync(path.join(file, "package.json"))) manifests.push(path.join(file, "package.json"));
      walk(file, depth + 1, { manifests, addons });
      continue;
    }
    if (entry.name.endsWith(".node")) addons.push(file);
  }
}

/**
 * Fotografia dos recursos que o pacote usa em runtime: manifesto raiz,
 * manifestos instalados (profundidade limitada como em `collectInstalledManifests`)
 * e todos os addons `.node`.
 */
export function snapshotRuntimeResources(appDir) {
  if (!appDir) throw new Error("snapshotRuntimeResources: appDir obrigatório");
  const manifests = [];
  const addons = [];
  const rootManifest = path.join(appDir, "package.json");
  if (fs.existsSync(rootManifest)) manifests.push(rootManifest);
  walk(path.join(appDir, "node_modules"), 0, { manifests, addons });
  return { manifests, addons };
}

function relative(appDir, file) {
  return path.relative(appDir, file).split(path.sep).join("/");
}

/**
 * Remove exactamente os lockfiles de instalação do staging e devolve o que fez.
 * Lança se um alvo não for um ficheiro regular ou se algum recurso de runtime
 * desaparecer — falha fechada, nunca "best effort".
 */
export function stripStagingInstallMetadata({ appDir } = {}) {
  if (!appDir) throw new Error("stripStagingInstallMetadata: appDir obrigatório");
  if (!fs.existsSync(path.join(appDir, "package.json"))) {
    throw new Error(`stripStagingInstallMetadata: ${appDir} não parece uma árvore de app (sem package.json)`);
  }
  const before = snapshotRuntimeResources(appDir);
  const removed = [];
  for (const relativePath of STAGING_INSTALL_METADATA) {
    const file = path.join(appDir, ...relativePath.split("/"));
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`metadado de instalação não é um ficheiro regular: ${relativePath}`);
    }
    fs.unlinkSync(file);
    removed.push(relativePath);
  }
  const after = snapshotRuntimeResources(appDir);
  const afterManifests = new Set(after.manifests);
  const afterAddons = new Set(after.addons);
  const lostManifests = before.manifests.filter((file) => !afterManifests.has(file));
  const lostAddons = before.addons.filter((file) => !afterAddons.has(file));
  if (lostManifests.length > 0 || lostAddons.length > 0) {
    const lost = [...lostManifests, ...lostAddons].map((file) => relative(appDir, file));
    throw new Error(`recursos de runtime desapareceram ao remover metadados de instalação: ${lost.join(", ")}`);
  }
  return {
    removed,
    preserved: { manifests: before.manifests.length, addons: before.addons.length },
    claims: "Remove só os dois lockfiles de instalação do staging; manifesto raiz, manifestos instalados e addons .node foram re-medidos depois.",
  };
}
