// Sonda B3: a sonda de identidade que LANCA dentro de killProcessTree.
// Filho 100% simulado. Nao lanca processo real. Nao escreve na home.
import { EventEmitter } from "node:events";
import { createSpawnClamav } from "../../packages/core/dist/clamav.js";

let unhandled = null;
process.on("unhandledRejection", (e) => { unhandled = e; });

function makeFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.state = { died: false, kills: 0 };
  child.kill = () => { child.state.kills++; return true; };
  return child;
}

let fake = null;
let spawnCount = 0;
const hooks = {
  spawn: () => { spawnCount++; fake = makeFakeChild(4242); return fake; },
  spawnSync: () => { throw new Error("B3: a terminacao NAO pode correr"); },
  captureIdentity: async () => ({ row: null, probeFailed: true, detail: "sem captura" }),
  probeIdentity: () => { throw new Error("B3: a sonda explodiu"); },
};

const handle = createSpawnClamav(hooks)(
  "clamscan",
  ["--database=x", "C:\\scan"],
  { timeoutMs: 60_000, windowsHide: true },
);
handle.killTree();
await new Promise((r) => setTimeout(r, 1000));

console.log("spawn real usado =>", spawnCount, "(1 = so o simulado)");
console.log("kills no filho    =>", fake ? fake.state.kills : "n/a");
console.log("unhandledRejection=>", unhandled ? `SIM (${unhandled.message})` : "NAO");
console.log("VEREDITO B3:", unhandled ? "PRESENTE" : "AUSENTE");
process.exit(0);