import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProtectionEngineService } from "../dist/engine.js";

// v0.2.3 — no notebook o serviço só ficava pronto depois da prova de carga do
// ClamAV (await no init); a interface esgotava o seu prazo de 20 s. A prova
// passa para segundo plano: o init termina e o ClamAV diz «a verificar».
test("init termina mesmo com a prova do ClamAV pendurada, e o ClamAV nunca aparece active", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cs-v023-startup-"));
  const svc = new ProtectionEngineService(base);
  let chamadas = 0;
  svc.clamav.isAvailable = () => { chamadas++; return new Promise(() => {}); };
  try {
    const t0 = Date.now();
    await Promise.race([
      svc.init(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("init bloqueado pela prova do ClamAV")), 60_000)),
    ]);
    assert.ok(Date.now() - t0 < 60_000);
    // Sem pipe server à frente o estado é «legacy»; o facto testado é o init ter resolvido.
    assert.notEqual(svc.startupState, "starting");
    assert.ok(chamadas >= 1, "a prova foi lançada");
    assert.ok(svc.clamavStartupProbe instanceof Promise, "a prova ficou em segundo plano");
    assert.notEqual(svc.clamav.health.status, "active", "sem prova não há active");
  } finally {
    await svc.dispose().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});
