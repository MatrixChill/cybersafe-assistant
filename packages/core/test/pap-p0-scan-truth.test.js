/**
 * P0 — TP-PAP-P0-SCAN-TRUTH (core/analysis.ts + core/scoring.ts)
 *
 * Contrato fixado aqui: um resultado final NUNCA é "limpo" por omissão quando
 * um motor não conseguiu avaliar o ficheiro, e uma deteção REAL nunca é
 * escondida por uma falha de outro motor.
 *
 *  1. YARA falha + ClamAV "clean"      => "inconclusive" (nunca "safe")
 *  2. YARA falha + ClamAV "detected"   => "malicious" (deteção prevalece),
 *     com a lacuna visível em `scan_inconclusive`
 *  3. ClamAV timeout (reason)          => "inconclusive"
 *  4. ZIP malformado + motores clean   => o veredicto vem dos motores que
 *     examinaram os bytes; a falha do parser de ZIP é uma lacuna de uma
 *     HEURÍSTICA (peso 30), não uma deteção inventada nem um "clean" falso:
 *     mesmo quando o ZIP abre, `archive_with_exe` não muda a classe do
 *     veredicto (30 < monitorMax 70).
 *  5. ZIP válido com .exe              => a heurística aparece como fator e
 *     continua a não ser uma deteção.
 *
 * Fixtures inertes (texto/ZIP local). Nenhum malware, nenhuma rede, nenhum
 * clamscan real: os motores são stubs determinísticos injectados.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { MalwareAnalyzer, SignatureDatabase, TrustEngine } from "../dist/index.js";

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-scan-truth-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function analyzer(yara, clamav) {
  return new MalwareAnalyzer({
    signatures: new SignatureDatabase(),
    trust: new TrustEngine(),
    yara,
    clamav,
  });
}

const yaraOk = { scanFile: async () => [] };
const yaraFails = {
  scanFile: async () => {
    throw new Error("YARA-X indisponível (stub determinístico)");
  },
};
const clamClean = { scanFile: async () => ({ detected: false, verdict: "clean" }) };
const clamTimeout = {
  scanFile: async () => ({
    detected: false,
    verdict: "error",
    reason: "timeout",
    detail: "O motor excedeu o orçamento de tempo",
  }),
};
const clamDetected = {
  scanFile: async () => ({ detected: true, verdict: "detected", signature: "Stub.Test" }),
};

test("falha do YARA com ClamAV clean termina inconclusivo, nunca safe", async (t) => {
  const dir = await tmpDir(t);
  const file = path.join(dir, "benigno.txt");
  await fs.writeFile(file, "conteudo benigno de fixture");

  const result = await analyzer(yaraFails, clamClean).analyze(file);

  assert.notEqual(result.verdict, "safe");
  assert.equal(result.verdict, "inconclusive");
  assert.ok(result.rulesTriggered.includes("scan_inconclusive"));
  assert.ok(result.factors.some((f) => f.id === "yara-inconclusive"));
  assert.ok(result.confidence <= 0.3, `confidence deve refletir a lacuna (foi ${result.confidence})`);
});

test("deteção real prevalece sobre a falha do outro motor", async (t) => {
  const dir = await tmpDir(t);
  const file = path.join(dir, "benigno2.txt");
  await fs.writeFile(file, "conteudo benigno de fixture");

  const result = await analyzer(yaraFails, clamDetected).analyze(file);

  assert.equal(result.verdict, "malicious", "uma deteção não pode ser atenuada por uma falha alheia");
  assert.equal(result.severity, "critical");
  assert.ok(result.rulesTriggered.includes("known_malware"));
  // A lacuna continua declarada: o resultado é honesto sobre a cobertura.
  assert.ok(result.rulesTriggered.includes("scan_inconclusive"));
  assert.ok(result.factors.some((f) => f.id === "yara-inconclusive"));
});

test("timeout do ClamAV é inconclusivo, não clean", async (t) => {
  const dir = await tmpDir(t);
  const file = path.join(dir, "benigno3.txt");
  await fs.writeFile(file, "conteudo benigno de fixture");

  const result = await analyzer(yaraOk, clamTimeout).analyze(file);

  assert.equal(result.verdict, "inconclusive");
  assert.ok(result.rulesTriggered.includes("scan_inconclusive"));
  const factor = result.factors.find((f) => f.id === "clamav-inconclusive");
  assert.ok(factor, "a lacuna tem de ter um fator próprio");
  assert.match(factor.label, /orçamento de tempo/i);
});

test("ZIP malformado: falha do parser não fabrica deteção nem invalida os motores", async (t) => {
  const dir = await tmpDir(t);
  const file = path.join(dir, "malformado.zip");
  // Assinatura ZIP (PK\x03\x04) seguida de lixo: o AdmZip não consegue abrir.
  await fs.writeFile(
    file,
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("lixo truncado sem diretório central")]),
  );

  const result = await analyzer(yaraOk, clamClean).analyze(file);

  // Os dois motores de conteúdo terminaram; o parser de ZIP é heurístico.
  // O resultado é o que os motores mediram — não se inventa uma ameaça.
  assert.equal(result.verdict, "safe");
  assert.ok(!result.rulesTriggered.includes("archive_with_exe"));
  assert.ok(!result.rulesTriggered.includes("scan_inconclusive"));
  assert.notEqual(result.verdict, "malicious");
  assert.notEqual(result.verdict, "suspicious");
});

test("ZIP válido com .exe: heurística presente e ainda não é uma deteção", async (t) => {
  const dir = await tmpDir(t);
  const file = path.join(dir, "com-exe.zip");
  const zip = new AdmZip();
  zip.addFile("nota.txt", Buffer.from("texto inerte"));
  zip.addFile("programa.exe", Buffer.from("MZ conteudo ficticio inerte"));
  await fs.writeFile(file, zip.toBuffer());

  const result = await analyzer(yaraOk, clamClean).analyze(file);

  assert.ok(result.rulesTriggered.includes("archive_with_exe"));
  // Peso 30 < monitorMax (70): continua a não ser uma deteção. Isto mostra
  // que a falha do parser (teste anterior) não mudaria a classe do veredicto.
  assert.equal(result.verdict, "safe");
  assert.notEqual(result.verdict, "malicious");
});
