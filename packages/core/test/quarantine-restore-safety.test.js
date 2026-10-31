import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

import { QuarantineManager } from "../dist/response.js";

/**
 * Quarentena — restauro e eliminação com as guardas reais.
 *
 * O defeito que isto impede: uma UI a anunciar "Restaurado" quando o backend
 * devolveu `false`, ou um restauro a substituir em silêncio um ficheiro que já
 * existia no destino. Cada recusa tem de trazer a RAZÃO, e o ficheiro de
 * quarentena não pode sair da sua pasta.
 */

let base;
let targetDir;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "cs-quar-"));
  targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-orig-"));
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
});

async function seedVictim(name = "virus.exe") {
  const p = path.join(targetDir, name);
  await fs.writeFile(p, "malicious-bytes", "utf-8");
  return p;
}

function analysisFor(filePath, extra = {}) {
  return {
    artifactPath: filePath,
    fileName: path.basename(filePath),
    sha256: createHash("sha256").update("malicious-bytes").digest("hex"),
    verdict: "malicious",
    riskScore: 90,
    rulesTriggered: ["known_malware_hash"],
    ...extra,
  };
}

async function newManager() {
  const qm = new QuarantineManager(base);
  await qm.init();
  return qm;
}

describe("Quarentena — restauro com guardas", () => {
  it("restaura para o caminho original e remove a entrada depois de confirmar", async () => {
    const victim = await seedVictim();
    const qm = await newManager();
    const entry = await qm.quarantine(analysisFor(victim));
    assert.ok(entry, "quarentena criada");
    assert.equal(existsSync(victim), false, "o original saiu do lugar");
    assert.equal(entry.detectionReason, "known_malware_hash", "motivo factual guardado");

    const result = await qm.restore(entry.id);
    assert.deepEqual(result, { success: true });
    assert.equal(existsSync(victim), true, "o ficheiro voltou ao original");
    assert.equal(qm.list().length, 0, "a entrada saiu da lista");
  });

  it("recusa restaurar uma entrada inexistente com razão", async () => {
    const qm = await newManager();
    const result = await qm.restore("nao-existe");
    assert.equal(result.success, false);
    assert.ok(result.error && result.error.length > 0, "traz uma razão");
  });

  it("NUNCA substitui um ficheiro que já existe no destino", async () => {
    const victim = await seedVictim();
    const qm = await newManager();
    const entry = await qm.quarantine(analysisFor(victim));

    // Alguém criou um ficheiro novo no mesmo sítio entretanto.
    await fs.writeFile(victim, "conteudo-legitimo-novo", "utf-8");
    const result = await qm.restore(entry.id);

    assert.equal(result.success, false, "restauro recusado");
    assert.match(result.error ?? "", /destino|exist/i);
    assert.equal(qm.list().length, 1, "a entrada continua em quarentena");
    const still = await fs.readFile(victim, "utf-8");
    assert.equal(still, "conteudo-legitimo-novo", "o ficheiro do destino ficou intacto");
  });

  it("recusa restaurar quando o ficheiro de quarentena desapareceu", async () => {
    const victim = await seedVictim();
    const qm = await newManager();
    const entry = await qm.quarantine(analysisFor(victim));
    await fs.rm(entry.quarantinePath, { force: true });

    const result = await qm.restore(entry.id);
    assert.equal(result.success, false);
    assert.ok(result.error && result.error.length > 0);
  });

  it("bloqueia um caminho original relativo (metadados adulterados)", async () => {
    const victim = await seedVictim();
    const qm = await newManager();
    const entry = await qm.quarantine(analysisFor(victim));

    // Adultera o manifesto: caminho relativo, sem raiz.
    const manifestPath = path.join(base, "quarantine", "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    manifest[0].originalPath = path.join("..", "..", "windows", "system32", "evil.dll");
    await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf-8");

    const qm2 = await newManager();
    const result = await qm2.restore(entry.id);
    assert.equal(result.success, false, "caminho relativo recusado");
    assert.ok(result.error && result.error.length > 0);
  });
});

describe("Quarentena — eliminação permanente", () => {
  it("elimina só depois de o sistema de ficheiros confirmar, e reporta razão quando falha", async () => {
    const victim = await seedVictim("alvo.exe");
    const qm = await newManager();
    const entry = await qm.quarantine(analysisFor(victim));

    const result = await qm.delete(entry.id);
    assert.deepEqual(result, { success: true });
    assert.equal(existsSync(entry.quarantinePath), false, "o ficheiro saiu do disco");
    assert.equal(qm.list().length, 0);

    const again = await qm.delete(entry.id);
    assert.equal(again.success, false);
    assert.ok(again.error && again.error.length > 0, "segunda eliminação traz razão");
  });
});
