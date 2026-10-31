import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ScanManager, addExclusionReason } from "../dist/scan-manager.js";

/**
 * P0 SCANNER — PORQUÊ os ficheiros ficaram fora dos motores.
 *
 * MEDIDO no computador do utilizador (probe read-only, 10/10/2026):
 *   selected=800 candidates=640 excluded=151 zip=9
 *   filesScanned=800 filesAnalyzed=649 filesExcluded=151 filesFailed=0
 *
 * O gap de "800 considerados vs 663 sem deteções" que o utilizador viu são
 * exclusões — e a UI só as pode explicar se o serviço publicar o MOTIVO. Estes
 * testes fixam esse contrato: agregação pura, publicação no estado final e a
 * identidade aritmética que sustenta a frase do cartão.
 */

describe("addExclusionReason — agregação pura das categorias de exclusão", () => {
  it("conta por categoria e por detalhe, sem duplicar entradas", () => {
    let list = [];
    list = addExclusionReason(list, { reason: "extension", detail: ".log" });
    list = addExclusionReason(list, { reason: "extension", detail: ".log" });
    list = addExclusionReason(list, { reason: "extension", detail: ".tmp" });
    list = addExclusionReason(list, { reason: "path" });

    assert.deepEqual(list, [
      { reason: "extension", detail: ".log", count: 2 },
      { reason: "extension", detail: ".tmp", count: 1 },
      { reason: "path", detail: undefined, count: 1 },
    ]);
  });

  it("não muta a lista recebida (o estado anterior nunca é reescrito)", () => {
    const before = [];
    const after = addExclusionReason(before, { reason: "extension", detail: ".log" });
    assert.equal(before.length, 0, "a lista de origem tem de ficar intacta");
    assert.equal(after.length, 1);
  });

  it("uma categoria desconhecida nunca vira detalhe livre", () => {
    const list = addExclusionReason([], null);
    assert.deepEqual(list, [{ reason: "path", detail: undefined, count: 1 }]);
  });

  it("exclusão por caminho não transporta caminho nenhum", () => {
    const list = addExclusionReason([], { reason: "path", detail: "C:\\Users\\alguem\\privado" });
    assert.equal(list[0].detail, undefined, "o detalhe de uma exclusão por caminho é descartado");
  });
});

/** Motor mínimo: exclui tudo o que não for .txt e diz porquê. */
function createExcludingEngine() {
  return {
    scanArtifact: async () => ({ highRiskCount: 0, overallSeverity: "safe" }),
    emitScanProgress: () => {},
    isExcluded: (filePath) => path.extname(filePath).toLowerCase() !== ".txt",
    exclusionCategory: (filePath) =>
      path.extname(filePath).toLowerCase() === ".log"
        ? { reason: "extension", detail: ".log" }
        : { reason: "path" },
  };
}

describe("ScanManager publica o motivo das exclusões no estado final", () => {
  it("filesExcludedBy soma exatamente filesExcluded e a identidade fecha", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-excluded-by-"));
    try {
      await fs.writeFile(path.join(dir, "a.txt"), "conteudo");
      await fs.writeFile(path.join(dir, "b.txt"), "conteudo");
      await fs.writeFile(path.join(dir, "c.log"), "conteudo");
      await fs.writeFile(path.join(dir, "d.log"), "conteudo");
      await fs.writeFile(path.join(dir, "e.bin"), "conteudo");

      const mgr = new ScanManager(createExcludingEngine());
      const id = await mgr.startScan("custom", dir);
      assert.ok(id, "startScan tem de devolver um id");

      const deadline = Date.now() + 15_000;
      let state;
      while (Date.now() < deadline) {
        state = mgr.getScan(id);
        if (state && ["completed", "cancelled", "failed"].includes(state.status)) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      assert.equal(state.status, "completed");
      assert.equal(state.filesScanned, 5, "todos os candidatos fecham o pipeline");
      assert.equal(state.filesAnalyzed, 2, "só os .txt chegam aos motores");
      assert.equal(state.filesExcluded, 3);
      assert.equal(state.filesFailed, 0);

      // O MOTIVO publicado (a UI explica com isto, não com uma lista à mão).
      assert.deepEqual(
        [...(state.filesExcludedBy ?? [])].sort((a, b) => a.reason.localeCompare(b.reason)),
        [
          { reason: "extension", detail: ".log", count: 2 },
          { reason: "path", detail: undefined, count: 1 },
        ],
      );
      assert.equal(
        (state.filesExcludedBy ?? []).reduce((total, entry) => total + entry.count, 0),
        state.filesExcluded,
        "a soma das categorias tem de ser igual ao total de excluídos",
      );
      assert.equal(
        state.filesAnalyzed + state.filesExcluded + state.filesFailed,
        state.filesScanned,
        "considerados = analisados + ignorados + falhados",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("sem exclusões, o campo fica vazio (nunca com uma categoria inventada)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-no-exclusions-"));
    try {
      await fs.writeFile(path.join(dir, "a.txt"), "conteudo");
      await fs.writeFile(path.join(dir, "b.txt"), "conteudo");

      const mgr = new ScanManager(createExcludingEngine());
      const id = await mgr.startScan("custom", dir);
      const deadline = Date.now() + 15_000;
      let state;
      while (Date.now() < deadline) {
        state = mgr.getScan(id);
        if (state && ["completed", "cancelled", "failed"].includes(state.status)) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      assert.equal(state.filesExcluded, 0);
      assert.deepEqual(state.filesExcludedBy ?? [], []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
