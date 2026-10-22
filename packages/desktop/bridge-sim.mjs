// Reproduz o comportamento EXATO do FileScannerPage:
// - listener ativo, mas descarta eventos cujo state.id !== scanIdRef.current
// - scanIdRef.current é null até a resposta do scan.start chegar
// Isto simula a perda do primeiro evento (running) e revela se os seguintes também se perdem.
import { ServiceClient } from "./src/service-client.js";

const scanType = process.argv[2] ?? "quick";

let scanIdRef = null;
let receivedFirst = false;
let receivedAny = false;
let receivedRunningAfterId = false;
const events = [];

function handleScanProgress(state) {
  receivedAny = true;
  if (state.id !== scanIdRef) return; // descarta como o renderer faz
  receivedFirst = true;
  events.push({ status: state.status, progress: state.progress, files: state.filesScanned, id: state.id });
  if (state.status === "running") receivedRunningAfterId = true;
}

const client = new ServiceClient();
client.onEvent((event) => {
  if (event.type === "scan.progress") handleScanProgress(event.data);
});

const t0 = Date.now();
async function main() {
  await client.connect();
  const started = await client.request("scan.start", { type: scanType });
  const id = started?.id;
  scanIdRef = id; // o renderer seta SÓ DEPOIS da resposta
  console.log(`[SIM] scanIdRef set to ${id} at t+${Date.now() - t0}ms`);

  // espera 30s ou terminal
  const deadline = Date.now() + 30_000;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (Date.now() > deadline) { clearInterval(timer); resolve(true); }
    }, 300);
    client.onEvent((event) => {
      if (event.type === "scan.progress" && event.data?.id === id && ["completed", "failed", "cancelled"].includes(event.data?.status)) {
        clearInterval(timer); resolve(true);
      }
    });
  });

  console.log(`[SIM] receivedAny=${receivedAny}`);
  console.log(`[SIM] acceptedAfterScanIdRef=${receivedFirst}`);
  console.log(`[SIM] events (accepted after id known):`);
  for (const e of events.slice(0, 20)) console.log(`  ${JSON.stringify(e)}`);
  if (events.length === 0) {
    console.log(`[SIM] ⚠️ BUG REPRODUCED: nenhum evento aceite — a UI fica presa.`);
  } else {
    console.log(`[SIM] bridge OK: renderer receberia eventos após o id.`);
  }
  process.exit(0);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });