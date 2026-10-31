import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ScanManager } from "../dist/scan-manager.js";

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

async function waitWorkerDrained(engine, id, timeoutMs = 3_000) {
  const start = Date.now();
  while (!engine.clearCalls.includes(id) && Date.now() - start < timeoutMs) {
    await sleep(5);
  }
  return engine.clearCalls.includes(id);
}

/**
 * Motor que SIMULA um ficheiro bloqueado: `scanArtifact` só avança quando
 * o AbortController do scan dispara (o mesmo que um clamscan preso a quem
 * `abortEngineWork` mata a árvore de processos). Sem o abort, o scan
 * fica preso para sempre — é o caso "timeout" que o L11 quer provar.
 */
function makeHangEngine() {
  const events = [];
  const clearCalls = [];
  const abortCalls = [];
  const controllers = new Map();
  return {
    events,
    clearCalls,
    abortCalls,
    isExcluded: () => false,
    emitScanProgress: (state) => events.push({ ...state }),
    abortEngineWork(scanId) {
      abortCalls.push(scanId);
      const ctrl = controllers.get(scanId);
      if (ctrl) ctrl.abort();
    },
    markScanAborted() {},
    clearClamavPrefetch(scanId) {
      clearCalls.push(scanId);
    },
    async scanArtifact(filePath, _source, options) {
      const scanId = options?.scanId;
      let ctrl = controllers.get(scanId);
      if (!ctrl) {
        ctrl = new AbortController();
        controllers.set(scanId, ctrl);
      }
      // Ficheiro bloqueado: só avança quando o abort chega.
      if (!ctrl.signal.aborted) {
        await new Promise((resolve) => {
          ctrl.signal.addEventListener("abort", resolve, { once: true });
        });
      }
      throw Object.assign(new Error("scan abortado"), { code: "ABORTED" });
    },
  };
}

describe("R6-L11 — tratamento de timeouts / hang do motor", () => {
  let tmp;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-r6-l11-to-"));
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(tmp, `file-${i}.bin`), `x${i}`);
    }
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("sem cancel, um ficheiro bloqueado NÃO fabrica um terminal falso", async () => {
    const engine = makeHangEngine();
    const mgr = new ScanManager(engine);

    mgr.gatherFiles = async (_root, output) => {
      for (let i = 0; i < 5; i++) output.push(path.join(tmp, `file-${i}.bin`));
    };
    mgr.looksLikeZip = async () => false;

    const id = await mgr.startScan("custom", tmp);
    assert.ok(id);

    // Esperar até o scan estar running e preso no primeiro ficheiro.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const st = mgr.getScan(id);
      if (st?.status === "running" && st?.phase === "scanning") break;
      await sleep(5);
    }
    assert.equal(mgr.getScan(id)?.status, "running", "pré-condição: running");

    // Sem cancel: após 1,5 s o scan continua running (não completou nem falhou).
    await sleep(1_500);
    const st = mgr.getScan(id);
    assert.equal(
      st?.status, "running",
      "um hang NÃO deve fabricar completed/failed — só o cancel decide o terminal",
    );
    assert.equal(st?.progress, 0, "progresso honesto: 0 (nenhum ficheiro fechou)");

    // Limpar: cancel para o worker não ficar pendurado no teste.
    mgr.cancelScan(id);
    await waitTerminal(mgr, id, 5_000).catch(() => {});
    await waitWorkerDrained(engine, id, 3_000).catch(() => {});
  });

  it("cancel durante um hang: 'cancelled' síncrono + abort mata o trabalho + drain", async () => {
    const engine = makeHangEngine();
    const mgr = new ScanManager(engine);

    mgr.gatherFiles = async (_root, output) => {
      for (let i = 0; i < 5; i++) output.push(path.join(tmp, `file-${i}.bin`));
    };
    mgr.looksLikeZip = async () => false;

    const id = await mgr.startScan("custom", tmp);

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const st = mgr.getScan(id);
      if (st?.status === "running" && st?.phase === "scanning") break;
      await sleep(5);
    }
    assert.equal(mgr.getScan(id)?.status, "running", "pré-condição: running e preso");

    // O heartbeat continua a publicar durante o hang (o serviço está vivo).
    const eventsBefore = engine.events.length;
    await sleep(1_100);
    assert.ok(
      engine.events.length > eventsBefore,
      "heartbeat publica durante o hang — a UI distingue 'ocupado' de 'incontactável'",
    );

    const t0 = Date.now();
    mgr.cancelScan(id);
    const latency = Date.now() - t0;
    assert.equal(mgr.getScan(id)?.status, "cancelled", "cancel publica 'cancelled' síncrono");
    assert.ok(latency < 500, `latência cancel→cancelled < 500ms (medido: ${latency}ms)`);
    assert.ok(
      engine.abortCalls.includes(id),
      "abortEngineWork chamado — mata o trabalho preso",
    );

    // O worker drena (o abort liberta o scanArtifact preso).
    const drained = await waitWorkerDrained(engine, id, 3_000);
    assert.ok(drained, "worker drenou após o abort (clearClamavPrefetch chamado)");

    const final = mgr.getScan(id);
    assert.equal(final?.status, "cancelled", "estado final é 'cancelled' (não completed)");
    assert.equal(final?.filesInEngineBatch ?? 0, 0, "sem batch residual após cancel");
  });

  it("heartbeat não publica um segundo 'cancelled' após o terminal (P1-4 intacto)", async () => {
    const engine = makeHangEngine();
    const mgr = new ScanManager(engine);

    mgr.gatherFiles = async (_root, output) => {
      for (let i = 0; i < 5; i++) output.push(path.join(tmp, `file-${i}.bin`));
    };
    mgr.looksLikeZip = async () => false;

    const id = await mgr.startScan("custom", tmp);

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const st = mgr.getScan(id);
      if (st?.status === "running" && st?.phase === "scanning") break;
      await sleep(5);
    }

    mgr.cancelScan(id);
    await waitTerminal(mgr, id, 5_000);
    await waitWorkerDrained(engine, id, 3_000);

    // Dar tempo ao heartbeat (1 s) para tentar publicar sobre o terminal.
    const countAtTerminal = engine.events.filter(
      (e) => e.id === id && e.status === "cancelled",
    ).length;
    await sleep(1_200);
    const countAfter = engine.events.filter(
      (e) => e.id === id && e.status === "cancelled",
    ).length;
    assert.equal(
      countAfter, countAtTerminal,
      `evento 'cancelled' publicado 1 vez (antes=${countAtTerminal}, depois=${countAfter})`,
    );
  });
});
