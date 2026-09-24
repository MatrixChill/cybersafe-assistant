// Reproduz o comportamento CORRIGIDO do FileScannerPage:
// - listener aceita scan.progress SEM filtrar por id até que scanIdRef seja setado
// - após setar, filtra por id (proteção contra duplicados)
import { ServiceClient } from "./src/service-client.js";

const scanType = process.argv[2] ?? "quick";
const targetPath = process.argv[3];

let scanIdRef = null;
const events = [];

function handleScanProgress(state) {
  if (scanIdRef && state.id !== scanIdRef) return;
  events.push({ status: state.status, progress: state.progress, files: state.filesScanned, id: state.id });
}

const client = new ServiceClient();
client.onEvent((event) => {
  if (event.type === "scan.progress") handleScanProgress(event.data);
});

async function main() {
  await client.connect();
  const started = await client.request("scan.start", { type: scanType, targetPath });
  const id = started?.id;
  scanIdRef = id;
  console.log(`[SIM-FIX] scanIdRef set to ${id}`);

  const deadline = Date.now() + 25_000;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (Date.now() > deadline) { clearInterval(timer); resolve(true); }
    }, 300);
    client.onEvent((event) => {
      if (event.type === "scan.progress" && ["completed", "failed", "cancelled"].includes(event.data?.status)) {
        clearInterval(timer); resolve(true);
      }
    });
  });

  console.log(`[SIM-FIX] events accepted: ${events.length}`);
  for (const e of events.slice(0, 15)) console.log(`  ${JSON.stringify(e)}`);
  const hasRunning = events.some(e => e.status === "running");
  const hasTerminal = events.some(e => ["completed", "failed", "cancelled"].includes(e.status));
  console.log(`[SIM-FIX] running=${hasRunning} terminal=${hasTerminal}`);
  console.log(hasRunning && hasTerminal ? "[SIM-FIX] ✅ BRIDGE FIXED" : "[SIM-FIX] ❌ ainda falha");
  process.exit(0);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });