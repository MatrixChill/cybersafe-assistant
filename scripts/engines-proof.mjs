/**
 * Prova e diagnostico dos motores, para validacao local e na VM.
 *
 * Uso:
 *   node scripts/engines-proof.mjs              # prova com a base da app
 *   node scripts/engines-proof.mjs --diagnose   # so diagnostica, sem analisar
 *   node scripts/engines-proof.mjs --datadir=<dir absoluto>
 *
 * Nao toca em dados do utilizador: escreve um fixture benigno temporario e
 * remove-o. Nao instala, nao eleva, nao altera servicos nem o Defender.
 *
 * Saida: 0 tudo provado; 1 ClamAV indisponivel; 2 ClamAV detetou o fixture
 * benigno (nao deve acontecer); 3 motor nativo sem resultado.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ClamavBridge,
  appClamavDatabaseDir,
  platformClamavDatabaseDir,
  probeDatabaseDir,
} from "../packages/core/dist/clamav.js";
import { NativeEngineBridge } from "../packages/service/dist/native-engine-bridge.js";

const args = process.argv.slice(2);
const diagnoseOnly = args.includes("--diagnose");
const datadirArg = args.find((arg) => arg.startsWith("--datadir="))?.slice("--datadir=".length);

function print(label, value) {
  console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

async function diagnose() {
  const appDir = appClamavDatabaseDir();
  const platformDir = platformClamavDatabaseDir();
  const dirs = [...new Set([...(datadirArg ? [path.resolve(datadirArg)] : []), appDir, ...(platformDir ? [platformDir] : [])])];
  print("plataforma", process.platform);
  print("perfil", process.env.USERPROFILE ?? os.homedir());
  print("pin CYBERSAFE_CLAMSCAN_PATH", process.env.CYBERSAFE_CLAMSCAN_PATH ?? "(ausente)");
  for (const dir of dirs) {
    const candidate = await probeDatabaseDir(dir, "diagnose");
    print(`base ${dir}`, {
      estado: candidate.state,
      assinaturas: candidate.signatureFiles.length,
      mais_recente: candidate.newestMtimeMs ? new Date(candidate.newestMtimeMs).toISOString() : null,
      erro: candidate.error ?? null,
    });
  }
  const bridge = new ClamavBridge(datadirArg ? { datadir: path.resolve(datadirArg) } : {});
  await bridge.isAvailable(true);
  print("binario clamscan", bridge.binaryPath ?? "(nao resolvido)");
  print("base escolhida", bridge.datadir ?? "(nenhuma)");
  print("saude ClamAV", bridge.health);
  await bridge.dispose();
  print("saude Native", await NativeEngineBridge.probe());
  print("filhos nativos pendentes", NativeEngineBridge.pendingChildren);
  NativeEngineBridge.dispose();
}

async function prove() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cybersafe-engines-proof-"));
  const fixture = path.join(dir, "benign.txt");
  await writeFile(fixture, "CyberSafe benign engines proof fixture.\n", "utf8");
  let code = 0;
  try {
    const clam = new ClamavBridge(datadirArg ? { datadir: path.resolve(datadirArg), loadProofEnabled: true } : { loadProofEnabled: true });
    const available = await clam.isAvailable(true);
    const scan = await clam.scanFile(fixture);
    print("ClamAV", {
      disponivel: available,
      base: clam.datadir,
      saude: clam.health,
      scan: { detetado: scan.detected, veredicto: scan.verdict, estado: scan.status.status },
      filhos_vivos: clam.liveChildPids(),
    });
    if (!available) code = 1;
    else if (scan.detected) code = 2;
    await clam.dispose();

    const nativeHealth = await NativeEngineBridge.probe();
    const nativeScan = await NativeEngineBridge.scan(fixture);
    print("Native", {
      saude: nativeHealth,
      scan: { ok: nativeScan.ok, falha: nativeScan.failure ?? null, nivel: nativeScan.result?.level ?? null },
      filhos_pendentes: NativeEngineBridge.pendingChildren,
    });
    if (!nativeScan.ok) code = 3;
    NativeEngineBridge.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  process.exitCode = code;
}

if (diagnoseOnly) await diagnose();
else await prove();
