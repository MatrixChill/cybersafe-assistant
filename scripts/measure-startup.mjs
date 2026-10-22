// Mede o tempo até o serviço responder através do named pipe (Fase 16).
// Uso: node scripts/measure-startup.mjs prod | dev
import { spawn, execSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIPE_NAME = "\\\\.\\pipe\\cybersafe-protection-dev-v2";
const mode = process.argv[2] ?? "dev";

function probe(t0) {
  return new Promise((resolve) => {
    const deadline = Date.now();
    const attempt = () => {
      const socket = net.connect(PIPE_NAME);
      socket.setTimeout(250);
      socket.once("connect", () => {
        const id = "perf-probe-" + Math.random().toString(36).slice(2);
        socket.write(`${JSON.stringify({ id, type: "request", method: "protection.getState", payload: undefined })}\n`);
        let buf = "";
        const onData = (chunk) => {
          buf += chunk.toString();
          const lines = buf.split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.id === id && msg.type === "response") {
                socket.destroy();
                resolve({ ms: Date.now() - t0, ok: msg.ok });
                return;
              }
            } catch { /* continua */ }
          }
        };
        socket.on("data", onData);
        socket.on("error", () => resolve({ ms: Date.now() - t0, ok: false }));
      });
      socket.on("timeout", () => { socket.destroy(); schedule(); });
      socket.on("error", schedule);
    };
    const schedule = () => {
      if (Date.now() - deadline > 90000) {
        resolve({ ms: Date.now() - t0, ok: false, timeout: true });
        return;
      }
      setTimeout(attempt, 200);
    };
    schedule();
  });
}

function killTree(pid) {
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); } catch { /* já morreu */ }
}

if (mode === "prod") {
  const exe = path.join(root, "packages", "desktop", "release", "win-unpacked", "CyberSafe Assistant.exe");
  const t0 = Date.now();
  const child = spawn(exe, [], { stdio: "ignore", detached: true, windowsHide: true });
  const r = await probe(t0);
  if (child.pid) killTree(child.pid);
  console.log(`[prod] serviço pronto em ${r.ms} ms (ok=${r.ok}${r.timeout ? " timeout" : ""})`);
} else {
  const t0 = Date.now();
  const child = spawn("npm run dev:service", { cwd: root, stdio: "ignore", detached: true, windowsHide: true, shell: true });
  const r = await probe(t0);
  if (child.pid) killTree(child.pid);
  console.log(`[dev]  serviço pronto em ${r.ms} ms (ok=${r.ok}${r.timeout ? " timeout" : ""})`);
}