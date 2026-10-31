import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NativeEngineBridge } from "../dist/native-engine-bridge.js";

/**
 * Regressao do motor nativo (scan-engine.exe real, sem mocks).
 * Fixtures benignas numa pasta temporaria propria; nenhum ficheiro de teste
 * de deteccao e criado em disco.
 */
describe("RC22 regressao do motor nativo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-native-reg-"));

  it("ficheiro inexistente: falha (level=error), nunca safe", async () => {
    const out = await NativeEngineBridge.scan(path.join(dir, "nao-existe.bin"), { timeoutMs: 15_000 });
    assert.equal(out.ok, false, "um ficheiro inexistente nao pode ser resultado valido");
    assert.equal(out.result, null);
    assert.equal(out.failure, "output");
  });

  it("ficheiro benigno: resultado integro com SHA-256 e level safe", async () => {
    const f = path.join(dir, "benigno.txt");
    fs.writeFileSync(f, "hello cybersafe");
    const out = await NativeEngineBridge.scan(f, { timeoutMs: 15_000 });
    assert.equal(out.ok, true);
    assert.equal(out.result.level, "safe");
    assert.equal(out.result.sha256, "50640c70d14d0d1f095134ba5a08d4bc6379ac0b93bcc33921f9a67ca59c5efd");
  });

  it("extensao dupla: heuristica soma 20 e mantem level safe (abaixo do limiar)", async () => {
    const f = path.join(dir, "relatorio.pdf.exe");
    fs.writeFileSync(f, "texto inofensivo");
    const out = await NativeEngineBridge.scan(f, { timeoutMs: 15_000 });
    assert.equal(out.ok, true);
    assert.equal(out.result.score, 20);
    assert.ok(out.result.reasons.includes("double_extension"));
    assert.equal(out.result.level, "safe");
  });

  it("active so apos invocacao comprovada: depois de scan ok o estado passa a active", async () => {
    // Nota: o estado e por processo. Os casos anteriores ja fizeram invocacoes;
    // este caso prova a transicao com uma invocacao bem-sucedida explicita.
    const f = path.join(dir, "prova-ativa.txt");
    fs.writeFileSync(f, "hello cybersafe");
    const out = await NativeEngineBridge.scan(f, { timeoutMs: 15_000 });
    assert.equal(out.ok, true, "a invocacao real tem de ter sucesso");
    const health = NativeEngineBridge.checkAvailability();
    assert.equal(health.status, "active", "com invocacao comprovada o estado e active");
  });

  it("alvo sem ficheiros: falha (failed), nunca completed", { timeout: 60_000 }, async () => {
    const vazia = path.join(dir, "pasta-vazia");
    fs.mkdirSync(vazia);
    const svcDir = fs.mkdtempSync(path.join(dir, "svc-"));
    const { ProtectionEngineService } = await import("../dist/engine.js");
    const e = new ProtectionEngineService(svcDir);
    try {
      const id = await e.scanManager.startScan("custom", vazia, { readOnly: true });
      assert.ok(id, "o scan tem de arrancar");
      let last = null;
      for (let i = 0; i < 120 && !last; i++) {
        await new Promise((r) => setTimeout(r, 500));
        last = e.scanManager.getLastScan(id);
      }
      assert.ok(last, "o scan tem de chegar a estado terminal");
      assert.equal(last.status, "failed", "alvo sem ficheiros nao pode ser completed");
      assert.ok(last.error && last.error.length > 0, "o erro tem de ser explicito");
    } finally {
      await e.dispose();
    }
  });

  it("limpeza das fixtures temporarias", () => {
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(fs.existsSync(dir), false);
  });
});
