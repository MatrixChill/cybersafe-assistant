import * as fs from "node:fs";
import * as path from "node:path";

// ── BOOT SURVIVAL LOG ────────────────────────────────────────────────────────
const DEBUG_LOG = "C:\\ProgramData\\CyberSafe\\boot-debug.log";
try {
  fs.mkdirSync("C:\\ProgramData\\CyberSafe", { recursive: true });
  fs.appendFileSync(DEBUG_LOG, `\n\n[${new Date().toISOString()}] BOOT INICIADO EM: ${process.cwd()}\n`, "utf-8");
} catch (e) {
  // Ignorar falha inicial se não tiver permissão
}

import "dotenv/config";
import { ProtectionEngineService } from "./engine.js";
import { DefinitionUpdater } from "./updater.js";

// ── Crash Resilience ─────────────────────────────────────────────────────────
// Quando rodando como serviço Windows (SYSTEM), não há UI nem console.
// Capturamos erros fatais para log e tentamos manter o processo vivo.

const LOG_DIR = "C:\\ProgramData\\CyberSafe";
fs.mkdirSync(LOG_DIR, { recursive: true });

function logToFile(level: string, message: string, error?: unknown) {
  const timestamp = new Date().toISOString();
  const errorStr = error instanceof Error ? `\n  Stack: ${error.stack}` : "";
  const line = `[${timestamp}] [${level}] ${message}${errorStr}\n`;
  try {
    fs.appendFileSync(path.join(LOG_DIR, "error.log"), line, "utf-8");
  } catch (e) {
    console.error("Failed to write to log file", e);
  }
}

process.on("uncaughtException", (err) => {
  try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] CRITICAL uncaught exception: ${err.stack || err}\n`, "utf-8"); } catch {}
  logToFile("CRITICAL", "Uncaught exception — tentando manter serviço vivo", err);
  console.error("[Service] CRITICAL uncaught exception:", err);
  // NÃO chamamos process.exit() — o serviço deve sobreviver
});

process.on("unhandledRejection", (reason) => {
  try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] Unhandled rejection: ${reason}\n`, "utf-8"); } catch {}
  logToFile("ERROR", "Unhandled promise rejection", reason as Error);
  console.error("[Service] Unhandled rejection:", reason);
});

// ── Service Bootstrap ────────────────────────────────────────────────────────

const service = new ProtectionEngineService();
const updater = new DefinitionUpdater(path.join(process.cwd(), "definitions"));

async function main() {
  logToFile("INFO", "Service starting...");
  console.log("[Service] Starting init...");

  try {
    await service.init();
    console.log("[Service] Init complete. Starting pipe server...");
    await service.startPipeServer();
    console.log("[Service] Pipe server started!");
    logToFile("INFO", "Service fully initialized. Pipe server listening.");

    // Sinaliza para o processo pai (Electron em dev) que está pronto
    process.send?.({ type: "service-ready" });

    // ── Pilar 4: Inicia o scheduler de atualizações ──
    updater.startScheduler();
    logToFile("INFO", "Definition updater scheduler started.");

  } catch (err) {
    logToFile("CRITICAL", "Fatal error during startup", err as Error);
    console.error("[Service] Fatal error during startup:", err);
    process.exit(1);
  }
}

void main();

// ── Graceful Shutdown ────────────────────────────────────────────────────────

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logToFile("INFO", `Received ${signal}, shutting down...`);
    updater.stopScheduler();
    void service.dispose().finally(() => {
      logToFile("INFO", "Service stopped.");
      process.exit(0);
    });
  });
}
