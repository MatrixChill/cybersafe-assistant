/**
 * CyberSafe Engine — Windows Service Installer/Uninstaller
 *
 * Registra o motor de proteção como um serviço Windows gerenciado pelo SCM.
 * O serviço roda sob SYSTEM, independente do usuário logado ou do Electron.
 *
 * Uso (como Admin):
 *   node windows-service.js install
 *   node windows-service.js uninstall
 *   node windows-service.js status
 */
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// node-windows é CJS, precisamos de createRequire em ESM
const require = createRequire(import.meta.url);
const nodeWindows = require("node-windows");
const { Service } = nodeWindows;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Aponta para o entry point TypeScript
const SERVICE_SCRIPT = path.resolve(__dirname, "index.ts");

const svc = new Service({
  name: "CyberSafe Engine",
  description: "Motor de proteção em tempo real do CyberSafe Antivírus. Monitora arquivos, processos e conexões de rede.",
  script: SERVICE_SCRIPT,
  nodeOptions: [
    "--import=tsx",
    "--max-old-space-size=512",
  ],
  env: [
    {
      name: "NODE_ENV",
      value: "production",
    },
    {
      name: "CYBERSAFE_SERVICE_MODE",
      value: "windows-service",
    },
  ],
  // Política de restart automático
  wait: 2,          // Espera 2s antes de restartar
  grow: 0.5,        // Cresce 0.5s por crash consecutivo
  maxRestarts: 10   // Máximo 10 restarts antes de desistir
});

// ── CLI ──────────────────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case "install": {
    svc.on("install", () => {
      console.log("[CyberSafe Service] Serviço instalado. Iniciando...");
      svc.start();
    });
    svc.on("alreadyinstalled", () => {
      console.log("[CyberSafe Service] Serviço já está instalado.");
    });
    svc.on("start", () => {
      console.log("[CyberSafe Service] ✅ Serviço iniciado com sucesso!");
      console.log("[CyberSafe Service] Verifique em services.msc → 'CyberSafe Engine'");
    });
    svc.on("error", (err: Error) => {
      console.error("[CyberSafe Service] ❌ Erro:", err);
    });
    console.log("[CyberSafe Service] Instalando serviço...");
    console.log(`[CyberSafe Service] Script: ${SERVICE_SCRIPT}`);
    svc.install();
    break;
  }

  case "uninstall": {
    svc.on("uninstall", () => {
      console.log("[CyberSafe Service] ✅ Serviço removido com sucesso.");
    });
    svc.on("alreadyuninstalled", () => {
      console.log("[CyberSafe Service] Serviço já não estava instalado.");
    });
    console.log("[CyberSafe Service] Removendo serviço...");
    svc.uninstall();
    break;
  }

  case "status": {
    // Checa se o serviço está rodando via PowerShell
    const { execSync } = require("node:child_process");
    try {
      const output = execSync(
        'powershell -NoProfile -Command "Get-Service -Name \'CyberSafe Engine\' | Select-Object Status, DisplayName | ConvertTo-Json"',
        { encoding: "utf-8" },
      );
      const info = JSON.parse(output);
      console.log(`[CyberSafe Service] Estado: ${info.Status === 4 ? "✅ Em execução" : "⏹ Parado"}`);
      console.log(`[CyberSafe Service] Nome: ${info.DisplayName}`);
    } catch {
      console.log("[CyberSafe Service] ⚠️ Serviço não encontrado. Execute 'install' primeiro.");
    }
    break;
  }

  default: {
    console.log("CyberSafe Engine — Gerenciador de Serviço Windows");
    console.log("");
    console.log("Uso:");
    console.log("  node windows-service.js install    Instala e inicia o serviço");
    console.log("  node windows-service.js uninstall  Remove o serviço");
    console.log("  node windows-service.js status     Verifica o estado do serviço");
    console.log("");
    console.log("⚠️  Requer execução como Administrador!");
    break;
  }
}
