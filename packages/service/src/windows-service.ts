/**
 * CyberSafe Engine — Windows Service Installer/Uninstaller (dev-only)
 *
 * REGRA (corrigida na R7): este CLI não pode registar um serviço que aponta
 * para uma árvore de código. Exige uma raiz instalada válida
 * (`CYBERSAFE_SERVICE_INSTALL_ROOT`), um entry point `dist/index.js` existente
 * e recusa conflitos de identidade/registo. A desinstalação só remove o
 * serviço quando o ImagePath pertence a essa raiz.
 *
 * O produto empacotado NÃO usa isto: o desktop arranca o serviço como processo
 * filho (`packages/desktop/src/main.ts`). O instalador NSIS stock também não
 * cria nem remove serviços Windows.
 *
 * Uso (como Admin, apenas numa instalação real):
 *   CYBERSAFE_SERVICE_INSTALL_ROOT="C:\Program Files\CyberSafe Assistant" \
 *     node dist/windows-service.js install|uninstall|status
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import {
  WINDOWS_SERVICE_NAME,
  decideInstall,
  decideUninstall,
  resolvePackagedServiceScript,
  type ExistingService,
} from "./windows-service-guard.js";

const require = createRequire(import.meta.url);

function loadService(scriptPath: string) {
  const { Service } = require("node-windows");
  return new Service({
    name: WINDOWS_SERVICE_NAME,
    description: "Motor de proteção em tempo real do CyberSafe Assistant.",
    script: scriptPath,
    nodeOptions: ["--max-old-space-size=512"],
    env: [
      { name: "NODE_ENV", value: "production" },
      { name: "CYBERSAFE_SERVICE_MODE", value: "windows-service" },
    ],
    wait: 2,
    grow: 0.5,
    maxRestarts: 10,
  });
}

/** Leitura apenas: imagem registada do serviço, se existir. */
function queryExistingService(): ExistingService | null {
  try {
    const out = execFileSync(
      "reg",
      ["query", `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${WINDOWS_SERVICE_NAME}`, "/v", "ImagePath"],
      { encoding: "utf8", windowsHide: true },
    );
    const match = out.match(/ImagePath\s+REG_[A-Z_]+\s+(.+)/);
    const raw = match?.[1]?.trim() ?? null;
    const imagePath = raw ? raw.replace(/^"(.*)"$/, "$1") : null;
    return { name: WINDOWS_SERVICE_NAME, imagePath };
  } catch {
    return null;
  }
}

function installRoot(): string | undefined {
  return process.env.CYBERSAFE_SERVICE_INSTALL_ROOT?.trim();
}

function refuse(reason: string): void {
  console.error(`[CyberSafe Service] Recusado: ${reason}`);
  process.exitCode = 1;
}

const command = process.argv[2];

switch (command) {
  case "install": {
    const root = installRoot();
    const plan = resolvePackagedServiceScript(root, (file) => fs.existsSync(file));
    if (!plan.ok) {
      refuse(plan.reason);
      break;
    }
    const decision = decideInstall({
      platform: process.platform,
      installRoot: root,
      scriptPath: plan.scriptPath,
      exists: (file) => fs.existsSync(file),
      existing: queryExistingService(),
    });
    if (!decision.ok) {
      refuse(decision.reason);
      break;
    }

    const svc = loadService(plan.scriptPath);
    svc.on("install", () => {
      console.log("[CyberSafe Service] Serviço instalado. Iniciando...");
      svc.start();
    });
    svc.on("alreadyinstalled", () => console.log("[CyberSafe Service] Serviço já está instalado."));
    svc.on("start", () => console.log("[CyberSafe Service] Serviço iniciado."));
    svc.on("error", (err: Error) => console.error("[CyberSafe Service] Erro:", err));
    console.log(`[CyberSafe Service] Entry point: ${plan.scriptPath}`);
    svc.install();
    break;
  }

  case "uninstall": {
    const root = installRoot();
    const existing = queryExistingService();
    const decision = decideUninstall({ platform: process.platform, installRoot: root, existing });
    if (!decision.ok) {
      refuse(decision.reason);
      break;
    }
    if (decision.alreadyAbsent) {
      console.log("[CyberSafe Service] Serviço já não estava instalado.");
      break;
    }
    const plan = resolvePackagedServiceScript(root, (file) => fs.existsSync(file));
    if (!plan.ok) {
      refuse(plan.reason);
      break;
    }
    const svc = loadService(plan.scriptPath);
    svc.on("uninstall", () => console.log("[CyberSafe Service] Serviço removido."));
    svc.on("alreadyuninstalled", () => console.log("[CyberSafe Service] Serviço já não estava instalado."));
    svc.uninstall();
    break;
  }

  case "status": {
    try {
      const output = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `Get-Service -Name '${WINDOWS_SERVICE_NAME}' | Select-Object Status,DisplayName | ConvertTo-Json`],
        { encoding: "utf-8", windowsHide: true },
      );
      console.log(JSON.parse(output));
    } catch {
      console.log("[CyberSafe Service] Serviço não encontrado.");
    }
    break;
  }

  default:
    console.log("Uso: node dist/windows-service.js install|uninstall|status");
    console.log("Requer CYBERSAFE_SERVICE_INSTALL_ROOT absoluto e uma instalação real.");
}
