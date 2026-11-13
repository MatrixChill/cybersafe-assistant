import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ServiceClient } from "./service-client";
import { projectNigorStatus } from "./nigor-status";

async function withClient<T>(
  pipeName: string | undefined, token: string,
  action: (client: ServiceClient) => Promise<T>, timeoutMs = 5000,
): Promise<T> {
  const client = new ServiceClient(pipeName, token, console.error);
  const signal = AbortSignal.timeout(timeoutMs);
  const disconnect = () => client.disconnect();
  signal.addEventListener("abort", disconnect, { once: true });
  try {
    return await action(client);
  } finally {
    signal.removeEventListener("abort", disconnect);
    disconnect();
  }
}

export async function readNigorStatus(pipeName: string | undefined, token: string, timeoutMs = 5000) {
  return withClient(pipeName, token, async (client) => {
    const [protection, scans, events, hardware] = await Promise.all([
      client.request("protection.getState", undefined),
      client.request("scan.history", { limit: 5 }),
      client.request("events.list", { limit: 50 }),
      client.request("hardware.snapshot", undefined),
    ]);
    return projectNigorStatus({ protection, scans, events, hardware });
  }, timeoutMs);
}

export async function startNigorScan(
  pipeName: string | undefined, token: string, targetPath: string, consent: boolean,
) {
  if (consent !== true || !isAbsolute(targetPath) || targetPath.includes("\0")) {
    throw new Error("É necessário consentimento e um destino absoluto.");
  }
  const target = await lstat(targetPath);
  if (target.isSymbolicLink() || (!target.isDirectory() && !target.isFile())) {
    throw new Error("Selecione um ficheiro ou pasta regular.");
  }
  return withClient(pipeName, token, async (client) => {
    const result = await client.request("scan.start", { type: "custom", targetPath });
    if (!result.success || !result.id) throw new Error("Análise recusada pelo serviço.");
    return { version: 1, accepted: true, scanId: result.id };
  });
}

export async function cancelNigorScan(
  pipeName: string | undefined, token: string, scanId: string, consent: boolean,
) {
  if (consent !== true || !/^[a-zA-Z0-9-]{1,128}$/.test(scanId)) {
    throw new Error("É necessário consentimento e um identificador de análise válido.");
  }
  return withClient(pipeName, token, async (client) => {
    const result = await client.request("scan.cancel", { id: scanId });
    return { version: 1, success: result.success === true };
  });
}

if (process.env.CYBERSAFE_NIGOR_STATUS === "1") {
  const token = process.env.CYBERSAFE_PIPE_TOKEN;
  if (process.platform !== "linux" || !token || !/^[a-f0-9]{64}$/.test(token)) {
    process.exitCode = 2;
  } else {
    const args = process.argv.slice(2);
    async function runCommand() {
      if (args.length === 0) return readNigorStatus(undefined, token!);
      if (args.length !== 3 || args[1] !== "--consent") throw new Error("Argumentos inválidos.");
      switch (args[0]) {
        case "scan": return startNigorScan(undefined, token!, args[2], true);
        case "cancel": return cancelNigorScan(undefined, token!, args[2], true);
        default: throw new Error("Operação desconhecida.");
      }
    }
    runCommand().then(
      (snapshot) => console.log(JSON.stringify(snapshot)),
      () => { console.error("Não foi possível concluir a operação CyberSafe. Consulte o estado antes de repetir."); process.exitCode = 1; },
    );
  }
}
