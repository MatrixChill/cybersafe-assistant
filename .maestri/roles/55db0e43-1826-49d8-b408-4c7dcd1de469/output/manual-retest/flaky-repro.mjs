// Prova da raiz do flake: o teste depende de um ClamavBridge REAL. Quando o
// probe real falha (carga, timeout, base ilegivel), `clamavVerdict` = "error",
// `scanInconclusive` = true, e a confianca e CAPADA a 0.3 pelo codigo de
// PRODUCAO (analysis.ts:200). Nada disto e do canario.
// Nao lanca clamscan real: o bridge e injectado.
import crypto from "node:crypto";
import {
  MalwareAnalyzer,
  SignatureDatabase,
  TrustEngine,
  YaraEngine,
} from "file:///C:/Users/caioc/Desktop/Caio/garoto%20de%20programa/cybersafe-assistant/packages/core/dist/index.js";
import { DEV_CANARY_CONTENT, installDevCanary } from "file:///C:/Users/caioc/Desktop/Caio/garoto%20de%20programa/cybersafe-assistant/packages/core/test/fixtures/dev-canary.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

installDevCanary();
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flaky-proof-"));
const file = path.join(tmp, "canary.txt");
await fs.writeFile(file, DEV_CANARY_CONTENT, "utf8");

function analyzerWith(bridge) {
  return new MalwareAnalyzer({
    signatures: new SignatureDatabase(),
    trust: new TrustEngine(),
    yara: new YaraEngine(path.join(tmp, "a.yar")),
    clamav: bridge,
  });
}

process.env.NODE_ENV = "test";

// CASO A — o motor responde "limpo" (o que o teste ASSUME)
const clean = {
  scanFile: async () => ({ detected: false, verdict: "clean", status: { status: "active", detail: "" } }),
};
const a = await analyzerWith(clean).analyze(file);
console.log("A) motor limpo  => confidence", a.confidence, "verdict", a.verdict, "severity", a.severity);

// CASO B — o motor nao conseguiu avaliar (o que acontece sob carga)
const broken = {
  scanFile: async () => ({
    detected: false,
    verdict: "error",
    detail: "ClamAV indisponivel",
    status: { status: "unavailable", detail: "probe falhou" },
  }),
};
const b = await analyzerWith(broken).analyze(file);
console.log("B) motor error  => confidence", b.confidence, "verdict", b.verdict, "severity", b.severity);

console.log("");
console.log("VEREDITO: o canario e SEMPRE detetado nos dois casos; o que muda e a confianca.");
console.log("A assercao `confidence === 0.99` do teste so e verdade no CASO A.");
console.log("O teste usa um ClamavBridge REAL => depende do estado da maquina => FLAKY.");

await fs.rm(tmp, { recursive: true, force: true });
process.exit(0);