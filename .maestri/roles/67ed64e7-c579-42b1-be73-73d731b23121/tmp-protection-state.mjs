// Sonda read-only: protection.getState do serviço real via named pipe.
import * as net from "node:net";

const PIPE = "\\\\.\\pipe\\cybersafe-protection-dev-v2";
const req = { id: `probe-${Date.now()}`, type: "request", method: "protection.getState" };

const sock = net.connect(PIPE);
let buf = "";
const deadline = setTimeout(() => { console.log("TIMEOUT: servico nao respondeu"); process.exit(2); }, 10000);

sock.on("connect", () => sock.write(`${JSON.stringify(req)}\n`));
sock.on("data", (chunk) => {
  buf += chunk.toString();
  const parts = buf.split("\n");
  buf = parts.pop() ?? "";
  for (const raw of parts) {
    if (!raw.trim()) continue;
    let msg; try { msg = JSON.parse(raw); } catch { continue; }
    if (msg.id !== req.id) continue;
    clearTimeout(deadline);
    if (!msg.ok) { console.log("ERRO:", msg.error); process.exit(3); }
    const eng = msg.result?.engine ?? {};
    const fmt = (s) => `${(s?.status ?? "?").padEnd(12)} ${String(s?.detail ?? "").slice(0, 100)}`;
    console.log("status geral :", msg.result?.status);
    console.log("anyDegraded  :", eng.anyEngineDegraded);
    console.log("yara         :", fmt(eng.yara));
    console.log("hashDb       :", fmt(eng.hashDb));
    console.log("clamav       :", fmt(eng.clamav));
    console.log("nativeEngine :", fmt(eng.nativeEngine));
    console.log("firewall     :", fmt(eng.firewall));
    console.log("degradedReasons:");
    for (const r of eng.degradedReasons ?? []) console.log("  -", r);
    process.exit(0);
  }
});
sock.on("error", (err) => { clearTimeout(deadline); console.log("ERRO pipe:", err.code || err.message); process.exit(1); });
