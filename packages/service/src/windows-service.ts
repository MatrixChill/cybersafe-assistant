/**
 * CyberSafe Engine — Windows Service CLI (legacy, diagnóstico apenas)
 *
 * Mutações DESACTIVADAS: este CLI não é usado pelo NSIS nem pelo produto
 * empacotado (o desktop arranca o serviço como processo filho). Instalar ou
 * desinstalar um serviço a partir de uma árvore de código é exactamente a
 * origem provável do registo órfão observado (`cybersafeengine`, wrapper em
 * `<scriptDir>/daemon/`), pelo que `install`/`uninstall` recusam por desenho.
 *
 * `status` consulta o SCM pelo ID real (`cybersafeengine`), classifica
 * absent/present/error (erro nunca é ausência) e interpreta o ImagePath como
 * command line. Não requer elevação.
 *
 * Uso:
 *   node dist/windows-service.js status
 */
import { spawnSync } from "node:child_process";
import {
  WINDOWS_SERVICE_ID,
  WINDOWS_SERVICE_NAME,
  classifyRegQuery,
  legacyMutationPolicy,
  parseWindowsCommandLine,
  type ServiceQuery,
} from "./windows-service-guard.js";

function queryService(): ServiceQuery {
  const key = `HKLM\SYSTEM\CurrentControlSet\Services\${WINDOWS_SERVICE_ID}`;
  const result = spawnSync("reg", ["query", key, "/v", "ImagePath"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return classifyRegQuery({
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  });
}

const command = process.argv[2];

switch (command) {
  case "install":
  case "uninstall": {
    const policy = legacyMutationPolicy();
    console.error(`[CyberSafe Service] ${policy.reason}`);
    console.error(
      `[CyberSafe Service] id=${WINDOWS_SERVICE_ID} display=${WINDOWS_SERVICE_NAME} estado=${queryService().state}`,
    );
    process.exitCode = 2;
    break;
  }

  case "status": {
    const query = queryService();
    const report: Record<string, unknown> = {
      serviceId: WINDOWS_SERVICE_ID,
      displayName: WINDOWS_SERVICE_NAME,
      state: query.state,
    };
    if (query.state === "present") {
      report.imagePath = query.commandLine;
      report.parsed = parseWindowsCommandLine(query.commandLine);
    }
    if (query.state === "error") report.detail = query.detail;
    console.log(JSON.stringify(report, null, 2));
    break;
  }

  default:
    console.log("Uso: node dist/windows-service.js status");
    console.log("install/uninstall estão desactivados neste CLI legacy.");
}
