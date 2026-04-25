import "dotenv/config";
import { ProtectionEngineService } from "./engine.js";

const service = new ProtectionEngineService();

async function main() {
  console.log("[Service] Starting init...");
  try {
    await service.init();
    console.log("[Service] Init complete. Starting pipe server...");
    await service.startPipeServer();
    console.log("[Service] Pipe server started!");
    process.send?.({ type: "service-ready" });
  } catch (err) {
    console.error("[Service] Fatal error during startup:", err);
    process.exit(1);
  }
}

void main();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void service.dispose().finally(() => process.exit(0));
  });
}
