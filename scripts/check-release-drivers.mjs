#!/usr/bin/env node
/**
 * Verificação de drivers antes de publicar um release (CyberSafe Assistant).
 *
 * Motivo: o sidecar `packages/temperature-server` dependia de
 * LibreHardwareMonitorLib 0.9.4, que embute o driver WinRing0 e o extrai em
 * runtime para o disco. O Defender classifica-o como
 * VulnerableDriver:WinNT/Winring0 (CVE-2020-14979). Nenhum artefacto do
 * CyberSafe pode voltar a transportá-lo.
 *
 * Este script NÃO substitui o antivírus: faz a verificação estrutural
 * (nomes/assinaturas/drivers no output). O scan real do Defender está descrito
 * em docs/RELEASE_DRIVER_CHECK.md e tem de ser executado por quem publica.
 *
 * Uso: node scripts/check-release-drivers.mjs [pasta...]
 *      (sem argumentos: varre packages/, dist/, release/ e installer/)
 * Sai com código 1 se encontrar qualquer driver ou assinatura suspeita.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as url from "node:url";

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

/** Nunca podem existir no repositório nem no artefacto de release. */
const FORBIDDEN_NAMES = [/\.sys$/i, /winring/i, /temp-helper/i];
/** Assinatura do driver embutido (ASCII e UTF-16LE). */
const FORBIDDEN_CONTENT = ["WinRing0"];
/**
 * A assinatura de conteúdo só faz sentido em artefactos binários: um driver só
 * carrega em runtime como imagem PE (.sys), mas pode ser transportado dentro de
 * outro recipiente (dll/exe/gz/zip/...). Ficheiros de código-fonte e texto
 * (js/ts/md/json) podem mencionar "WinRing0" nos comentários sem transportar o
 * driver — para esses vale apenas a verificação de nome.
 */
const SCANNED_CONTENT_EXTENSIONS = new Set([
  ".sys", ".dll", ".exe", ".so", ".dylib", ".node", ".wasm",
  ".bin", ".dat", ".res", ".gz", ".zip", ".7z", ".cab", ".msi",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".cache"]);

const DEFAULT_ROOTS = ["packages", "dist", "release", "installer"];
const MAX_SCAN_BYTES = 128 * 1024 * 1024;

function listFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else out.push(full);
  }
  return out;
}

function sha256(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "<ilegível>";
  }
}

function containsForbiddenContent(file, size) {
  if (size > MAX_SCAN_BYTES) return false;
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return false;
  }
  return FORBIDDEN_CONTENT.some(
    (needle) => buffer.includes(needle, 0, "latin1") || buffer.includes(needle, 0, "utf16le"),
  );
}

function main() {
  const roots = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_ROOTS)
    .map((root) => path.resolve(root))
    .filter((root) => fs.existsSync(root));

  if (roots.length === 0) {
    console.error("[drivers] nenhuma pasta para varrer — verifique os caminhos");
    process.exitCode = 1;
    return;
  }

  console.log(`[drivers] raiz do projeto: ${REPO_ROOT}`);
  const findings = [];
  let scanned = 0;

  for (const root of roots) {
    console.log(`[drivers] a varrer: ${path.relative(REPO_ROOT, root) || "."}`);
    for (const file of listFiles(root)) {
      scanned += 1;
      const relative = path.relative(REPO_ROOT, file);
      const name = path.basename(file);

      const nameHit = FORBIDDEN_NAMES.find((pattern) => pattern.test(name));
      if (nameHit) {
        findings.push({ file: relative, reason: `nome proibido (${nameHit})` });
        continue;
      }
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      if (SCANNED_CONTENT_EXTENSIONS.has(path.extname(file).toLowerCase()) && containsForbiddenContent(file, size)) {
        findings.push({ file: relative, reason: "conteúdo com assinatura WinRing0" });
      }
    }
  }

  console.log(`[drivers] ficheiros varridos: ${scanned}`);
  if (findings.length > 0) {
    console.error(`[drivers] FAIL — ${findings.length} artefacto(s) suspeito(s):`);
    for (const finding of findings) {
      console.error(`[drivers]   ${finding.file} — ${finding.reason} — sha256=${sha256(path.join(REPO_ROOT, finding.file))}`);
    }
    console.error("[drivers] remova a dependência que gera estes ficheiros; NÃO use exclusões do Defender");
    process.exitCode = 1;
    return;
  }

  console.log("[drivers] PASS — nenhum driver .sys, helper de temperatura ou assinatura WinRing0 no caminho varrido");
  console.log("[drivers] NOTA: isto não é um atestado de \"Defender clean\".");
  console.log("[drivers] O scan real tem de correr no output final e no installer — ver docs/RELEASE_DRIVER_CHECK.md");
}

main();
