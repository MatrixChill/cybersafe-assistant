import { ServiceClient } from "./service-client";
import { projectNigorStatus } from "./nigor-status";

export async function readNigorStatus(client: ServiceClient, timeoutMs = 5000) {
  const signal = AbortSignal.timeout(timeoutMs);
  const disconnect = () => client.disconnect();
  signal.addEventListener("abort", disconnect, { once: true });
  try {
    const [protection, scans, events, hardware] = await Promise.all([
      client.request("protection.getState", undefined),
      client.request("scan.history", { limit: 5 }),
      client.request("events.list", { limit: 50 }),
      client.request("hardware.snapshot", undefined),
    ]);
    return projectNigorStatus({ protection, scans, events, hardware });
  } finally {
    signal.removeEventListener("abort", disconnect);
    disconnect();
  }
}

if (process.env.CYBERSAFE_NIGOR_STATUS === "1") {
  const token = process.env.CYBERSAFE_PIPE_TOKEN;
  if (process.platform !== "linux" || !/^[a-f0-9]{64}$/.test(token ?? "")) {
    process.exitCode = 2;
  } else {
    readNigorStatus(new ServiceClient(undefined, token, console.error)).then(
      (snapshot) => console.log(JSON.stringify(snapshot)),
      () => { console.error("Serviço CyberSafe indisponível ou autenticação recusada."); process.exitCode = 1; },
    );
  }
}
