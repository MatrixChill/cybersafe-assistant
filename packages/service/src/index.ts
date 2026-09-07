import * as fs from "node:fs";
import * as path from "node:path";

import * as os from "node:os";

// ── BOOT SURVIVAL LOG ────────────────────────────────────────────────────────
const BASE_DIR = path.join(os.homedir(), ".cybersafe-service");
const DEBUG_LOG = path.join(BASE_DIR, "boot-debug.log");
try {
  fs.mkdirSync(BASE_DIR, { recursive: true });
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

const LOG_DIR = BASE_DIR;
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

async function main() {
  logToFile("INFO", "Service starting...");
  console.log("[Service] Starting init...");

  try {
    await service.init();
    console.log("[Service] Init complete. Starting pipe server...");
    await service.startPipeServer();
    console.log("[Service] Pipe server started!");
    logToFile("INFO", "Service fully initialized. Pipe server listening. Protection remains OFF until monitor.start is called.");

    // Sinaliza para o processo pai (Electron em dev) que está pronto
    process.send?.({ type: "service-ready" });
  } catch (err: any) {
    // Pipe já está em uso: existe outra instância (possivelmente órfã de um
    // boot anterior). Não é um erro fatal — saímos limpo (0) e o processo pai
    // reutiliza o serviço que já está a servir o pipe.
    if (err?.code === "EADDRINUSE") {
      logToFile("WARN", "Pipe já em uso. Outra instância do serviço está ativa; encerrando nova instância.");
      console.log("[Service] Outra instância já ativa no pipe. Encerrando nova instância (0).");
      process.exit(0);
    }
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
    void service.stopProtection().finally(() => {
      void service.dispose().finally(() => {
        logToFile("INFO", "Service stopped.");
        process.exit(0);
      });
    });
  });
}
