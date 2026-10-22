#!/usr/bin/env node
/**
 * Runtime probe do módulo de análise (CyberSafe Assistant).
 *
 * Corre análises REAIS — por um ScanManager real (packages/service/dist) com um
 * motor de análise mínimo e inofensivo — sobre uma pasta temporária com
 * ficheiros benignos, e verifica o contrato de eventos de ponta a ponta:
 *
 *   UM scan.start → UM scanId → eventos (gathering/scanning) → terminal
 *
 * Casos cobertos: pasta com ZIP, ficheiro único e pasta vazia (0 ficheiros).
 * Nenhum conteúdo malicioso. Não deixa artefactos.
 *
 * Uso: node scripts/scanner-runtime-probe.mjs   (ou npm run scanner:probe)
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import AdmZip from "adm-zip";
import { ScanManager } from "../packages/service/dist/scan-manager.js";

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`[probe]   ok: ${message}`);
  } else {
    failures += 1;
    console.error(`[probe]   FAIL: ${message}`);
  }
}

async function createProbeTree(root) {
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(path.join(root, "test.txt"), "conteudo inofensivo para analise");
  await fs.writeFile(path.join(root, "sample.ps1"), "Write-Output 'script inofensivo'");
  await fs.writeFile(path.join(root, "docs", "notas.txt"), "notas de teste");
  const zip = new AdmZip();
  zip.addFile("hello.txt", Buffer.from("hello world"));
  zip.addFile("notes.txt", Buffer.from("notas dentro do zip"));
  zip.writeZip(path.join(root, "archive.zip"));
}

/** Motor mínimo: lê mesmo os ficheiros, sem ClamAV/YARA e sem conteúdo perigoso. */
function createEngine(events, verbose) {
  return {
    scanArtifact: async (filePath) => {
      try {
        await fs.readFile(filePath);
      } catch {
        /* ficheiro ilegível: continua como limpo neste probe */
      }
      return { highRiskCount: 0, overallSeverity: "safe" };
    },
    emitScanProgress: (state) => {
      events.push({ ...state });
      if (!verbose) return;
      const summary = state.phase === "gathering"
        ? `phase=gathering status=${state.status} discovered=${state.filesDiscovered ?? 0}`
        : `phase=${state.phase ?? "-"} status=${state.status} progress=${state.progress} files=${state.filesScanned} threats=${state.threatsFound}`;
      console.log(`[probe]   event id=${state.id.slice(0, 8)}… ${summary}`);
    },
  };
}

/**
 * Corre uma análise completa e valida o contrato que a UI consome.
 * Devolve os eventos observados.
 */
async function runScan({ label, type, targetPath, expectFiles, expectKind, verbose = true }) {
  console.log(`\n[probe] ${label}\n[probe]   scan.start type=${type} target=${targetPath}`);

  const events = [];
  const engine = createEngine(events, verbose);
  const manager = new ScanManager(engine);

  const scanId = await manager.startScan(type, targetPath);
  if (!scanId) {
    check(false, "o ScanManager aceitou a análise");
    return events;
  }
  console.log(`[probe]   scanId=${scanId}`);
  check(events.length >= 1, "o primeiro evento é emitido antes da resposta de startScan (contrato do renderer)");

  await new Promise((resolve) => {
    const interval = setInterval(() => {
      if (events.some((event) => ["completed", "cancelled", "failed"].includes(event.status))) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
    setTimeout(() => {
      clearInterval(interval);
      resolve();
    }, 30_000);
  });

  const ids = new Set(events.map((event) => event.id));
  const gathering = events.filter((event) => event.phase === "gathering");
  const scanning = events.filter((event) => event.phase === "scanning");
  const terminal = events.at(-1);

  console.log(`[probe]   eventos=${events.length} ids distintos=${ids.size} gathering=${gathering.length} scanning=${scanning.length}`);

  check(ids.size === 1, "um único scanId em todos os eventos");
  check(ids.has(scanId), "o id dos eventos corresponde ao devolvido por startScan");
  check(gathering.length > 0, "houve progresso na fase gathering");
  // Uma análise sem ficheiros termina legitimamente sem fase de scanning.
  if (expectFiles > 0) {
    check(scanning.length > 0, "houve progresso na fase scanning");
  } else {
    console.log("[probe]   (sem ficheiros: não há fase de scanning — termina em finalizing/completed)");
  }
  check(terminal?.status === "completed", `estado terminal concluído (recebido: ${terminal?.status})`);
  check(terminal?.progress === 100, `progresso terminal 100 (recebido: ${terminal?.progress})`);
  check(terminal?.filesScanned === expectFiles, `ficheiros analisados=${expectFiles} (recebido: ${terminal?.filesScanned})`);
  check(terminal?.filesTotal === expectFiles, `denominador = candidatos reais (${expectFiles}) (recebido: ${terminal?.filesTotal})`);
  // Cada evento scanning usa o total real (nunca o cap de 50000).
  const badProgress = scanning.find(
    (event) => typeof event.filesTotal === "number" && event.filesTotal > 0
      && event.progress !== Math.floor((event.filesScanned / event.filesTotal) * 100),
  );
  check(!badProgress, "progresso de scanning = floor(analisados/total*100)");
  check(manager.getActiveScan() === null, "não ficou nenhuma análise ativa no fim");

  if (expectKind) {
    const identified = events.find((event) => event.targetKind);
    check(identified?.targetKind === expectKind, `tipo do alvo=${expectKind} (recebido: ${identified?.targetKind})`);
  }

  return events;
}

async function main() {
  const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "CyberSafeScannerProbe-"));
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "CyberSafeScannerProbeEmpty-"));
  console.log(`[probe] pasta temporária: ${probeRoot}`);

  try {
    await createProbeTree(probeRoot);

    // 1. Pasta com ZIP/scripts benignos (inclui o default do "custom folder").
    await runScan({
      label: "CASO 1 — Análise de uma pasta (com ZIP)",
      type: "custom",
      targetPath: probeRoot,
      expectFiles: 4,
      expectKind: "directory",
    });

    // 2. Ficheiro único: o nome tem de aparecer antes de a análise terminar.
    const singleFilePath = path.join(probeRoot, "test.txt");
    const fileEvents = await runScan({
      label: "CASO 2 — Análise de um ficheiro",
      type: "custom",
      targetPath: singleFilePath,
      expectFiles: 1,
      expectKind: "file",
    });
    const identified = fileEvents.find((event) => event.targetKind === "file");
    check(identified?.currentFile === "test.txt", "o nome do ficheiro é conhecido antes de terminar");
    check(identified?.filesScanned === 0, "nome disponível sem progresso falso (0 ficheiros na altura)");

    // 3. Pasta vazia: termina de forma explícita (nunca fica \"a analisar\").
    await runScan({
      label: "CASO 3 — Pasta vazia",
      type: "custom",
      targetPath: emptyDir,
      expectFiles: 0,
      expectKind: "directory",
    });

    console.log(
      failures === 0
        ? "\n[probe] PASS — um start, um scanId por análise, progresso real e terminal explícito nos 3 casos"
        : `\n[probe] FAIL — ${failures} verificação(ões) falharam`,
    );
    if (failures > 0) process.exitCode = 1;
  } catch (err) {
    console.error(`[probe] FAIL: exceção inesperada: ${err?.stack ?? err}`);
    process.exitCode = 1;
  } finally {
    await fs.rm(probeRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(emptyDir, { recursive: true, force: true }).catch(() => {});
    console.log("[probe] artefactos temporários removidos");
  }
}

void main();
