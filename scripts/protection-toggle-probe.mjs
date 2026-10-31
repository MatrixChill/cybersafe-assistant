#!/usr/bin/env node
/**
 * PROBE DE TOGGLE DA PROTEÇÃO — P1 REALTIME PROTECTION / TRAY.
 *
 * Pergunta única: quando a tray chama `monitor.start`, o MOTOR muda de estado
 * mesmo? E `monitor.pause`/`monitor.resume`/`monitor.stop`?
 *
 * O que faz: arranca o serviço em modo dev (o mesmo `npm run dev:service`), fala
 * com ele pelo named pipe com o MESMO envelope que o Electron usa
 * (`@cybersafe/core` ipc.ts), e imprime a resposta crua de cada método mais o
 * `protection.getState` antes/depois de cada um. Nenhuma UI, nenhuma elevação,
 * nenhum UAC, nenhuma alteração de sistema — só pedidos ao motor local.
 *
 * O stdout do serviço é capturado para que um `Failed to start <motor>` (a causa
 * real de um `{ok:false}`) apareça no fim, em vez de se perder.
 *
 * Uso: node scripts/protection-toggle-probe.mjs
 *      BOOT_TIMEOUT_MS=120000 PAUSE_MS=60000 node scripts/protection-toggle-probe.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIPE_NAME = "\\\\.\\pipe\\cybersafe-protection-dev-v2";
const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT_MS ?? 90_000);
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 60_000);

const serviceLog = [];
let child = null;

function spawnService() {
  child = spawn("npm run dev:service", {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    windowsHide: true,
    shell: true,
  });
  const collect = (chunk) => {
    const text = chunk.toString();
    serviceLog.push(text);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (err) => serviceLog.push(`[spawn error] ${err.message}`));
}

function killServiceTree() {
  if (!child?.pid) return;
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  } catch {
    /* já morreu */
  }
}

/** Espera o pipe aceitar ligação (readiness real, não um sleep fixo). */
function connectPipe() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const attempt = () => {
      const socket = net.connect(PIPE_NAME);
      socket.setTimeout(3000);
      socket.once("connect", () => resolve(socket));
      const fail = () => {
        socket.destroy();
        if (Date.now() - t0 > BOOT_TIMEOUT_MS) {
          reject(new Error(`pipe não respondeu em ${BOOT_TIMEOUT_MS} ms`));
          return;
        }
        setTimeout(attempt, 400);
      };
      socket.on("timeout", fail);
      socket.on("error", fail);
    };
    attempt();
  });
}

/** Um pedido, uma resposta: o mesmo envelope do ServiceClient. */
function request(socket, method, payload) {
  return new Promise((resolve, reject) => {
    const id = `probe-${method}-${Math.random().toString(36).slice(2)}`;
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== id || msg.type !== "response") continue;
        socket.off("data", onData);
        clearTimeout(timer);
        resolve(msg);
        return;
      }
    };
    const timer = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error(`${method}: sem resposta em 20 s`));
    }, 20_000);
    socket.on("data", onData);
    socket.write(`${JSON.stringify({ id, type: "request", method, payload })}\n`);
  });
}

function stateLine(label, res) {
  const r = res?.result ?? {};
  const enabled = r.protectionEnabled;
  const paused = r.protectionPausedUntil ?? null;
  // `engine.anyEngineDegraded` + reasons: é isto que impede dizer "Protegido"
  // por ausência de notícias (trayProtectionLevel só dá "protected" com safe E
  // protectionEnabled===true).
  const degraded = r.engine?.anyEngineDegraded;
  const reasons = r.engine?.degradedReasons ?? [];
  console.log(
    `[${label}] ok=${res?.ok} protectionEnabled=${enabled} status=${r.status ?? "?"} ` +
      `pausedUntil=${paused ?? "null"} anyEngineDegraded=${degraded}` +
      (res?.error ? ` error=${res.error}` : ""),
  );
  for (const why of reasons) console.log(`    degradado: ${why}`);
}

async function main() {
  console.log("=== PROBE DE TOGGLE DA PROTEÇÃO (P1 realtime/tray) ===");
  console.log(`pipe=${PIPE_NAME} bootTimeout=${BOOT_TIMEOUT_MS}ms pauseMs=${PAUSE_MS}`);
  spawnService();

  let socket;
  try {
    socket = await connectPipe();
    console.log("[boot] serviço no pipe.");

    const before = await request(socket, "protection.getState", undefined);
    stateLine("antes", before);

    const start = await request(socket, "monitor.start", undefined);
    console.log(`[monitor.start] -> ${JSON.stringify(start.result ?? start.error)} ok=${start.ok}`);

    const afterStart = await request(socket, "protection.getState", undefined);
    stateLine("depois do start", afterStart);

    const pause = await request(socket, "monitor.pause", { durationMs: PAUSE_MS });
    console.log(`[monitor.pause] -> ${JSON.stringify(pause.result ?? pause.error)} ok=${pause.ok}`);

    const afterPause = await request(socket, "protection.getState", undefined);
    stateLine("depois da pausa", afterPause);

    const resume = await request(socket, "monitor.resume", undefined);
    console.log(`[monitor.resume] -> ${JSON.stringify(resume.result ?? resume.error)} ok=${resume.ok}`);

    const afterResume = await request(socket, "protection.getState", undefined);
    stateLine("depois do resume", afterResume);

    const stop = await request(socket, "monitor.stop", undefined);
    console.log(`[monitor.stop] -> ${JSON.stringify(stop.result ?? stop.error)} ok=${stop.ok}`);

    const afterStop = await request(socket, "protection.getState", undefined);
    stateLine("depois do stop", afterStop);

    // ── Veredicto medido, não inferido ──
    const b = before?.result?.protectionEnabled;
    const a = afterStart?.result?.protectionEnabled;
    console.log("\n=== VEREDICTO ===");
    console.log(`ACTIVATE_REAL = ${b === false && a === true ? "YES" : "NO"} (antes=${b} depois=${a})`);
    console.log(
      `PAUSE_REAL = ${afterPause?.result?.protectionPausedUntil ? "YES" : "NO"} ` +
        `(pausedUntil=${afterPause?.result?.protectionPausedUntil ?? "null"})`,
    );
    console.log(
      `RESUME_REAL = ${afterResume?.result?.protectionEnabled === true && !afterResume?.result?.protectionPausedUntil ? "YES" : "NO"}`,
    );
    console.log(`STOP_REAL = ${afterStop?.result?.protectionEnabled === false ? "YES" : "NO"}`);
    console.log(`START_OK = ${start.ok === true && start.result?.ok === true ? "YES" : "NO"}`);
  } catch (error) {
    console.log(`PROBE_FALHOU = ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      socket?.destroy();
    } catch {
      /* já fechado */
    }
    killServiceTree();
  }

  const log = serviceLog.join("");
  const failures = log
    .split(/\r?\n/)
    .filter((line) => /Failed to start|Failed to load|ERROR|error:/i.test(line))
    .slice(0, 25);
  console.log("\n=== LOG DO SERVIÇO (linhas relevantes) ===");
  console.log(failures.length ? failures.join("\n") : "(nenhuma linha de erro encontrada)");
  console.log(`\nLOG_BYTES=${log.length}`);
}

await main();
