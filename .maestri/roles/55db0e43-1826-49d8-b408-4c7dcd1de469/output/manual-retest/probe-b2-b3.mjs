// Sonda READ-ONLY: confirma B2 (imunidade por nome+caminho depois de PID
// contradito) e B3 (sonda que LANCA dentro de killProcessTree).
// Nao escreve nada na home, nao lanca clamscan, nao faz rede.
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { ProtectionEngineService } from "file:///C:/Users/caioc/Desktop/Caio/garoto%20de%20programa/cybersafe-assistant/packages/service/dist/engine.js";
import { createSpawnClamav } from "file:///C:/Users/caioc/Desktop/Caio/garoto%20de%20programa/cybersafe-assistant/packages/core/dist/clamav.js";

const BASE = mkdtempSync(path.join(os.tmpdir(), "cs-probe-"));
const ENGINE_DIR = "C:\\Program Files\\ClamAV";
const haAtras = (ms) => new Date(Date.now() - ms).toISOString();

// ── B2 ──────────────────────────────────────────────────────────────────────
console.log("=== B2: PID contradito pode recuperar imunidade por nome+caminho? ===");
const svc = new ProtectionEngineService(BASE);
svc.registerOwnChild(4242, haAtras(120_000));
const contradito = { pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: haAtras(60_000) };
console.log("1) classifyOwnChild(contradito) =>", JSON.stringify(svc.classifyOwnChild(contradito)));
console.log("   ownChildCount depois         =>", svc.ownChildCount());
const segunda = svc.shouldScanStartedProcess(contradito);
console.log("2) shouldScanStartedProcess MESMO pid, MESMO nome, MESMO caminho =>", segunda);
console.log("   VEREDITO B2:", segunda === false ? "PRESENTE (imunidade recuperada sem identidade)" : "AUSENTE");
const contraste = svc.shouldScanStartedProcess({
  pid: 4242, name: "clamscan.exe", path: "C:\\Users\\victim\\Downloads\\clamscan.exe", startedAt: haAtras(60_000),
});
console.log("3) contraste (caminho nao-motor) =>", contraste, "(true = sem DEFESA 3)");

// ── B3 ──────────────────────────────────────────────────────────────────────
console.log("");
console.log("=== B3: sonda que LANCA dentro de killProcessTree ===");
let unhandled = null;
process.on("unhandledRejection", (e) => { unhandled = e; });

function makeFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.state = { died: false, kills: 0 };
  child.kill = () => { child.state.kills++; return true; };
  child.die = (code) => { if (child.state.died) return; child.state.died = true; child.emit("close", code); };
  return child;
}

let fake = null;
const hooks = {
  spawn: () => { fake = makeFakeChild(4242); return fake; },
  spawnSync: () => { throw new Error("B3: a terminacao NAO pode correr"); },
  captureIdentity: async () => ({ row: null, probeFailed: true, detail: "sem captura" }),
  probeIdentity: () => { throw new Error("B3: a sonda explodiu"); },
};

const handle = createSpawnClamav(hooks)("clamscan", ["--database=x", "C:\\scan"], { timeoutMs: 60_000, windowsHide: true });
handle.killTree();
await new Promise((r) => setTimeout(r, 800));

console.log("unhandledRejection observado =>", unhandled ? `SIM (${unhandled.message})` : "NAO");
console.log("VEREDITO B3:", unhandled ? "PRESENTE (rejeicao nao tratada no caminho de kill)" : "AUSENTE");

process.exit(0);