// Harness DEV — Testa o EVENT BRIDGE com o ServiceClient REAL
// (o mesmo usado pelo Electron main). Reproduz: ServiceClient → onEvent → (como main)
// Uso: $env:CYBERSAFE_DEBUG_BRIDGE="1"; npx tsx packages/desktop/bridge-test.mjs <scanType? default "quick">
import { ServiceClient } from "./src/service-client.js";

const scanType = process.argv[2] ?? "quick";

async function main() {
  console.log(`[BRIDGE] starting harness for scanType=${scanType} at=${new Date().toISOString()}`);
  const client = new ServiceClient();

  // 1. Listener ANTES do scan.start (como a wiring da UI deveria)
  client.onEvent((event) => {
    if (event.type === "scan.progress") {
      console.log(`[BRIDGE] onEvent scan.progress scanId=${event.data?.id} status=${event.data?.status} progress=${event.data?.progress} files=${event.data?.filesScanned} at=${new Date().toISOString()}`);
    }
  });

  await client.connect();
  console.log(`[BRIDGE] connected at=${new Date().toISOString()}`);

  const state = await client.request("protection.getState", undefined);
  console.log(`[BRIDGE] getState ok=${!!state} degradedReasons=${state?.engine?.degradedReasons?.length ?? "n/a"}`);

  const started = await client.request("scan.start", { type: scanType });
  console.log(`[BRIDGE] scan.start result=${JSON.stringify(started)} at=${new Date().toISOString()}`);
  const scanId = started?.id;
  console.log(`[BRIDGE] activeScanId=${scanId}`);

  // Aguarda eventos até terminal OR 45s timeout
  const deadline = Date.now() + 45_000;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        console.log(`[BRIDGE] TIMEOUT no terminal event within 45s`);
        clearInterval(timer);
        resolve(true);
      }
    }, 500);
    client.onEvent((event) => {
      if (event.type === "scan.progress" && event.data?.id === scanId && ["completed", "failed", "cancelled"].includes(event.data?.status)) {
        console.log(`[BRIDGE] TERMINAL status=${event.data.status} files=${event.data.filesScanned} threats=${event.data.threatsFound}`);
        clearInterval(timer);
        resolve(true);
      }
    });
  });

  await client.requestShutdown().catch(() => {});
  process.exit(0);
}

main().catch((e) => { console.error("[BRIDGE] FAIL", e); process.exit(1); });