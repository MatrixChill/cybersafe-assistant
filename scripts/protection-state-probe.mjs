#!/usr/bin/env node
/**
 * Live probe do estado real de proteção via named pipe (método protection.getState).
 * Arranca o serviço em modo dev, espera o pipe, pede o estado, imprime os 5
 * componentes + reasons, e termina o serviço. Um único pedido — sem ciclos,
 * sem stress de disco.
 *
 * Uso: node scripts/protection-state-probe.mjs   (timeout de boot env BOOT_TIMEOUT_MS, default 60000)
 */
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIPE_NAME = "\\\\.\\pipe\\cybersafe-protection-dev-v2";
const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT_MS ?? 60_000);

function getState() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const attempt = () => {
      const socket = net.connect(PIPE_NAME);
      socket.setTimeout(3000);
      socket.once("connect", () => {
        const id = "probe-" + Math.random().toString(36).slice(2);
        socket.write(`${JSON.stringify({ id, type: "request", method: "protection.getState", payload: undefined })}\n`);
        let buf = "";
        socket.on("data", (chunk) => {
          buf += chunk.toString();
          for (const line of buf.split("\n")) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.id === id && msg.type === "response") {
                socket.destroy();
                resolve(msg);
                return;
              }
            } catch { /* linha parcial */ }
          }
        });
      });
      const fail = () => {
        socket.destroy();
        if (Date.now() - t0 > BOOT_TIMEOUT_MS) reject(new Error(`pipe não respondeu em ${BOOT_TIMEOUT_MS} ms`));
        else setTimeout(attempt, 400);
      };
      socket.on("timeout", fail);
      socket.on("error", fail);
    };
    attempt();
  });
}

function killTree(pid) {
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }); } catch { /* já morreu */ }
}

const child = spawn("npm run dev:service", { cwd: root, stdio: "ignore", detached: true, windowsHide: true, shell: true });
try {
  const res = await getState();
  const st = res.payload ?? res.result ?? res;
  const engine = st.engine ?? st.protection?.engine ?? st;
  console.log(`[probe] ok=${res.ok} status=${st.status ?? "?"}`);
  for (const key of ["yara", "hashDb", "clamav", "nativeEngine", "firewall"]) {
    const sub = engine[key];
    console.log(`[probe] ${key}=${sub?.status ?? "?"} — ${sub?.detail ?? "sem detail"}`);
  }
  if (engine.degradedReasons?.length) console.log(`[probe] degradedReasons: ${JSON.stringify(engine.degradedReasons)}`);
} finally {
  if (child.pid) killTree(child.pid);
}
