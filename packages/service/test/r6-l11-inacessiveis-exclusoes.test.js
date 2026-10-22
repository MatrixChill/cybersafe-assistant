import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ScanManager, addExclusionReason } from "../dist/scan-manager.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTerminal(mgr, id, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = mgr.getScan(id);
    if (s && ["completed", "cancelled", "failed"].includes(s.status)) return s;
    await sleep(5);
  }
  throw new Error(`scan ${id} não atingiu estado terminal em ${timeoutMs} ms`);
}

/**
 * R6-L11 — ficheiros INACESSÍVEIS reportados POR FICHEIRO (não fatais)
 * e EXCLUSÕES POR CAMINHO que NUNCA transportam o caminho.
 *
 * As falhas são simuladas no motor com os códigos de erro de filesystem
 * reais (EACCES/EBUSY/ENOENT) — é o mesmo caminho de código do catch
 * por ficheiro do scan-manager, sem precisar de ACLs de administrador
 * nem de tocar no PC real. As fixtures vivem em os.tmpdir().
 */

/**
 * Motor configurável:
 *  - `failures`: mapa caminho → código de erro (o scanArtifact lança
 *    um erro de filesystem com esse código para esse ficheiro);
 *  - `excludedByPath`: quando presente, os ficheiros que não são .txt
 *    são excluídos — e o motor FAZ FUGIR o caminho no detalhe (motor
 *    com bug), para provar que o serviço sanitiza antes de publicar.
 */
function makeEngine({ failures = new Map(), leakPath = null, events = [] } = {}) {
  return {
    events,
    isExcluded: leakPath
      ? (filePath) => path.extname(filePath).toLowerCase() !== ".txt"
      : () => false,
    exclusionCategory: (filePath) => {
      if (!leakPath) return null;
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".log") return { reason: "extension", detail: ".log" };
      // Motor com fuga: devolve o caminho real no detalhe.
      return { reason: "path", detail: leakPath };
    },
    emitScanProgress: (state) => events.push({ ...state }),
    async scanArtifact(filePath) {
      const code = failures.get(filePath);
      if (code) {
        throw Object.assign(new Error("simulated filesystem error"), { code });
      }
      return { highRiskCount: 0, overallSeverity: "safe" };
    },
    clearClamavPrefetch: () => {},
    markScanAborted: () => {},
    abortEngineWork: () => {},
  };
}

function startOverTemp(mgr, tmp, files) {
  mgr.gatherFiles = async (_root, output) => {
    for (const f of files) output.push(path.join(tmp, f));
  };
  mgr.looksLikeZip = async () => false;
  return mgr.startScan("custom", tmp);
}

describe("R6-L11 — ficheiro inacessível é reportado POR FICHEIRO e não é fatal", () => {
  let tmp;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-r6-l11-ie-"));
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(tmp, `file-${i}.bin`), `conteudo-${i}`);
    }
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("1 de 5 com EACCES: scan concluído, filesFailed=1, motivo 'permissões'", async () => {
    const failures = new Map();
    failures.set(path.join(tmp, "file-2.bin"), "EACCES");
    const events = [];
    const mgr = new ScanManager(makeEngine({ failures, events }));

    const id = await startOverTemp(mgr, tmp, [
      "file-0.bin", "file-1.bin", "file-2.bin", "file-3.bin", "file-4.bin",
    ]);
    const state = await waitTerminal(mgr, id);

    // NÃO é fatal: o scan concluiu, não ficou "failed".
    assert.equal(state.status, "completed", "falha por ficheiro não é fatal");
    // O ficheiro inacessível fecha o ciclo como falhado — não desaparece.
    assert.equal(state.filesScanned, 5, "os 5 candidatos fecham o pipeline");
    assert.equal(state.filesAnalyzed, 4, "só os 4 acessíveis chegaram aos motores");
    assert.equal(state.filesExcluded, 0);
    assert.equal(state.filesFailed, 1, "exactamente 1 ficheiro falhado");
    // Reportado POR FICHEIRO: a causa fica categorizada, sem caminhos.
    assert.deepEqual(
      { ...state.failedByReason },
      { permissions_denied: 1 },
      "EACCES classificado como permissões, contagem por ficheiro",
    );
    // A identidade aritmética do cartão fecha.
    assert.equal(
      state.filesAnalyzed + state.filesExcluded + state.filesFailed,
      state.filesScanned,
      "considerados = analisados + excluídos + falhados",
    );
    // Nenhuma saída publicada contém o caminho do ficheiro.
    for (const event of events) {
      assert.equal(
        JSON.stringify(event.failedByReason ?? {}).includes(tmp),
        false,
        "failedByReason nunca transporta caminhos",
      );
    }
  });

  it("ficheiros diferentes falham em categorias diferentes (atribuição por ficheiro)", async () => {
    const failures = new Map();
    failures.set(path.join(tmp, "file-0.bin"), "EACCES");
    failures.set(path.join(tmp, "file-1.bin"), "EBUSY");
    failures.set(path.join(tmp, "file-2.bin"), "ENOENT");
    const mgr = new ScanManager(makeEngine({ failures }));

    const id = await startOverTemp(mgr, tmp, [
      "file-0.bin", "file-1.bin", "file-2.bin", "file-3.bin", "file-4.bin",
    ]);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "completed");
    assert.equal(state.filesFailed, 3, "3 ficheiros falhados — contados um a um");
    assert.equal(state.filesAnalyzed, 2);
    assert.deepEqual(
      { ...state.failedByReason },
      { permissions_denied: 1, locked_or_busy: 1, not_found: 1 },
      "cada ficheiro contribui com a SUA categoria",
    );
    assert.equal(
      state.filesAnalyzed + state.filesExcluded + state.filesFailed,
      state.filesScanned,
    );
  });

  it("ficheiro que desapareceu durante o scanning (ENOENT) não é fatal nem ameaça", async () => {
    const failures = new Map();
    failures.set(path.join(tmp, "file-4.bin"), "ENOENT");
    const mgr = new ScanManager(makeEngine({ failures }));

    const id = await startOverTemp(mgr, tmp, [
      "file-0.bin", "file-1.bin", "file-2.bin", "file-3.bin", "file-4.bin",
    ]);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "completed", "ficheiro desaparecido não derruba o scan");
    assert.equal(state.filesFailed, 1);
    assert.deepEqual({ ...state.failedByReason }, { not_found: 1 });
    assert.equal(state.threatsFound, 0, "falha de leitura nunca vira ameaça");
  });
});

describe("R6-L11 — exclusões por caminho NUNCA transportam o caminho", () => {
  let tmp;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-r6-l11-ex-"));
    // 2 analisados (.txt) + 1 excluído por extensão (.log) + 2 excluídos por caminho.
    await fs.writeFile(path.join(tmp, "a.txt"), "conteudo");
    await fs.writeFile(path.join(tmp, "b.txt"), "conteudo");
    await fs.writeFile(path.join(tmp, "c.log"), "log");
    await fs.writeFile(path.join(tmp, "d.bin"), "bin");
    await fs.writeFile(path.join(tmp, "e.bin"), "bin");
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("motor COM FUGA de caminho: o serviço publica detail undefined", async () => {
    const LEAKED = "C:\\Users\\alguem\\privado\\CyberSafe";
    const events = [];
    const mgr = new ScanManager(makeEngine({ leakPath: LEAKED, events }));

    const id = await startOverTemp(mgr, tmp, ["a.txt", "b.txt", "c.log", "d.bin", "e.bin"]);
    const state = await waitTerminal(mgr, id);

    assert.equal(state.status, "completed");
    assert.equal(state.filesScanned, 5);
    assert.equal(state.filesAnalyzed, 2, "só os .txt chegam aos motores");
    assert.equal(state.filesExcluded, 3, "1 .log + 2 por caminho");
    assert.equal(
      state.filesAnalyzed + state.filesExcluded + state.filesFailed,
      state.filesScanned,
    );

    const excludedBy = state.filesExcludedBy ?? [];
    const pathEntry = excludedBy.find((e) => e.reason === "path");
    assert.ok(pathEntry, "motivo 'path' publicado");
    assert.equal(
      pathEntry.detail, undefined,
      "o caminho que o motor tentou vazar é descartado pelo serviço",
    );
    assert.equal(pathEntry.count, 2, "as 2 exclusões por caminho agregam-se");

    // Detalhes seguros (extensão) sobrevivem — só caminhos são descartados.
    const logEntry = excludedBy.find((e) => e.reason === "extension");
    assert.ok(logEntry, "motivo por extensão publicado");
    assert.equal(logEntry.detail, ".log", "detalhe seguro de extensão preservado");

    // Nenhuma saída publicada — estado nem eventos — contém o caminho.
    const serialized = JSON.stringify(state.filesExcludedBy);
    assert.equal(serialized.includes(LEAKED), false, "estado final não contém o caminho");
    for (const event of events) {
      assert.equal(
        JSON.stringify(event.filesExcludedBy ?? []).includes(LEAKED),
        false,
        "nenhum evento publicado contém o caminho",
      );
    }
    assert.equal(
      excludedBy.reduce((total, e) => total + e.count, 0),
      state.filesExcluded,
      "soma dos motivos == total de excluídos",
    );
  });

  it("addExclusionReason (puro): detalhe de caminho descartado, agregação sem fuga", () => {
    const list = addExclusionReason(
      addExclusionReason([], { reason: "path", detail: "C:\\Users\\secreto" }),
      { reason: "path", detail: "C:\\Users\\secreto\\outro" },
    );
    assert.deepEqual(
      list,
      [{ reason: "path", detail: undefined, count: 2 }],
      "duas exclusões por caminho agregam-se SEM o caminho",
    );
  });
});
