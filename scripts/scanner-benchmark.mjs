#!/usr/bin/env node
/**
 * Benchmark DEV pequeno do ScanManager (não é um teste).
 *
 * Cria 300 ficheiros benignos (txt/js/json/ps1 + um ZIP benigno) numa pasta
 * temporária, corre uma análise real pelo ScanManager (packages/service/dist)
 * com um motor mínimo e reporta files/s, tempo e contadores.
 *
 * Números reais, medidos — nada inventado. Não deixa artefactos.
 *
 * Uso: node scripts/scanner-benchmark.mjs   (ou npm run scanner:benchmark)
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import AdmZip from "adm-zip";
import { ScanManager } from "../packages/service/dist/scan-manager.js";

const FILE_COUNT = Number(process.env.BENCH_FILES ?? 300);

function benignEngine() {
  const counters = { analyzed: 0, bytes: 0 };
  return {
    counters,
    scanArtifact: async (filePath) => {
      counters.analyzed += 1;
      try {
        const data = await fs.readFile(filePath);
        counters.bytes += data.length;
      } catch { /* ilegível: continua */ }
      return { highRiskCount: 0, overallSeverity: "safe" };
    },
    emitScanProgress: () => {},
  };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-bench-"));
  console.log(`[bench] pasta: ${root} (${FILE_COUNT} ficheiros benignos)`);
  try {
    for (let i = 0; i < FILE_COUNT; i++) {
      const kind = i % 4;
      const name = kind === 0 ? `doc${i}.txt` : kind === 1 ? `app${i}.js` : kind === 2 ? `data${i}.json` : `script${i}.ps1`;
      const body = kind === 0
        ? `Documento de teste ${i}`
        : kind === 1
          ? `export const value${i} = ${i};`
          : kind === 2
            ? JSON.stringify({ index: i, ok: true })
            : `Write-Output 'benign ${i}'`;
      await fs.writeFile(path.join(root, name), body);
    }
    const zip = new AdmZip();
    zip.addFile("hello.txt", Buffer.from("hello world"));
    zip.writeZip(path.join(root, "archive.zip"));

    const engine = benignEngine();
    const manager = new ScanManager(engine);
    const start = Date.now();
    const id = await manager.startScan("custom", root);
    if (!id) throw new Error("scan recusado");

    while (true) {
      const state = manager.getScan(id);
      if (state && ["completed", "cancelled", "failed"].includes(state.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const state = manager.getScan(id);
    const elapsedMs = Date.now() - start;
    const perSec = elapsedMs > 0 ? Math.round((state.filesScanned / (elapsedMs / 1000)) * 10) / 10 : 0;

    console.log(
      `[bench] status=${state.status} filesScanned=${state.filesScanned}/${state.filesTotal} ` +
      `analyzed=${state.filesAnalyzed} excluded=${state.filesExcluded} failed=${state.filesFailed} ` +
      `elapsed=${(elapsedMs / 1000).toFixed(2)}s filesPerSec=${perSec} engineCalls=${engine.counters.analyzed}`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    console.log("[bench] artefactos temporários removidos");
  }
}

void main();
