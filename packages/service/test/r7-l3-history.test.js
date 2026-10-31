/**
 * R7-L3 — HISTÓRICO PERSISTENTE DE ANÁLISES (`<baseDir>/scans.jsonl`)
 *
 * Contrato:
 *  - Uma linha JSON por análise, NO MÁXIMO UMA VEZ por scanId;
 *  - Registo no estado terminal (completed/cancelled/failed) com os
 *    contadores reais do estado — sem limitação medida, o campo
 *    engineLimitations fica AUSENTE (não se inventa limitação);
 *  - O caminho deriva do baseDir INJETADO (nunca de os.homedir());
 *  - Leitura resiliente (linha corrompida = ignorada, não fatal);
 *  - Retenção com teto (env CYBERSAFE_SCAN_HISTORY_MAX, default 200)
 *    compactada por ficheiro temporário + rename — nunca in-place;
 *  - Consulta paginada (limit + cursor opaco), mais recente primeiro;
 *  - Nunca interfere com um scan em execução (record nunca rejeita).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  ScanHistory,
  toScanHistoryEntry,
  buildScanHistoryPage,
  scanHistoryMaxFromEnv,
  historyTargetOf,
  historyDurationMs,
  DEFAULT_SCAN_HISTORY_MAX,
} from "../dist/scan-history.js";
import { ScanManager } from "../dist/scan-manager.js";
import { ProtectionEngineService } from "../dist/engine.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTerminal(mgr, id, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = mgr.getScan(id);
    if (s && ["completed", "cancelled", "failed"].includes(s.status)) return s;
    await sleep(5);
  }
  throw new Error(`scan ${id} não atingiu estado terminal em ${timeoutMs} ms`);
}

/** Motor que analisa tudo com sucesso (o mesmo padrão de r6-l11). */
function makeOkEngine() {
  return {
    isExcluded: () => false,
    exclusionCategory: () => null,
    emitScanProgress: () => {},
    async scanArtifact() {
      return {
        highRiskCount: 0,
        overallSeverity: "safe",
        results: [{ analysisState: "completed" }],
      };
    },
    clearClamavPrefetch: () => {},
    markScanAborted: () => {},
    abortEngineWork: () => {},
  };
}

function terminalState(overrides = {}) {
  return {
    id: "scan-1",
    type: "quick",
    status: "completed",
    progress: 100,
    filesScanned: 191,
    filesTotal: 191,
    filesAnalyzed: 111,
    filesExcluded: 80,
    filesFailed: 0,
    threatsFound: 2,
    startTime: "2026-10-12T10:00:00.000Z",
    endTime: "2026-10-12T10:00:30.000Z",
    ...overrides,
  };
}

describe("R7-L3 — mapeamento do estado terminal para a entrada", () => {
  it("contadores reais, âmbito e duração; engineLimitations ausente", () => {
    const entry = toScanHistoryEntry(terminalState());
    assert.equal(entry.id, "scan-1");
    assert.equal(entry.type, "quick");
    assert.equal(entry.target, "default");
    assert.equal(entry.status, "completed");
    assert.equal(entry.startedAt, "2026-10-12T10:00:00.000Z");
    assert.equal(entry.endedAt, "2026-10-12T10:00:30.000Z");
    assert.equal(entry.durationMs, 30_000);
    assert.equal(entry.filesConsidered, 191);
    assert.equal(entry.filesAnalyzed, 111);
    assert.equal(entry.filesExcluded, 80);
    assert.equal(entry.filesFailed, 0);
    assert.equal("filesInconclusive" in entry, false, "legacy state sem leitura não deve virar zero");
    assert.equal(entry.threatsFound, 2);
    // Sem limitação medida, o campo não existe — não se inventa.
    assert.equal("engineLimitations" in entry, false);
  });

  it("preserva a contagem de resultados inconclusivos no histórico", () => {
    const entry = toScanHistoryEntry(terminalState({ filesInconclusive: 3 }));
    assert.equal(entry.filesInconclusive, 3);
  });

  it("scan customizado é âmbito 'custom' — nunca o caminho", () => {
    assert.equal(historyTargetOf("custom"), "custom");
    assert.equal(historyTargetOf("quick"), "default");
    assert.equal(historyTargetOf("full"), "default");
    const entry = toScanHistoryEntry(terminalState({ type: "custom" }));
    assert.equal(entry.target, "custom");
  });

  it("filesConsidered usa filesTotal congelado, senão filesScanned", () => {
    assert.equal(
      toScanHistoryEntry(terminalState({ filesTotal: 0, filesScanned: 7 })).filesConsidered,
      7,
    );
    assert.equal(
      toScanHistoryEntry(terminalState({ filesTotal: 42, filesScanned: 99 })).filesConsidered,
      42,
    );
  });

  it("duração inválida (sem fim) é 0, nunca NaN", () => {
    assert.equal(historyDurationMs(undefined, undefined), 0);
    assert.equal(historyDurationMs("não-uma-data", "também-não"), 0);
    assert.equal(historyDurationMs("2026-10-12T10:00:00.000Z", "2026-10-12T09:00:00.000Z"), 0);
  });

  it("teto de retenção a partir do env; inválido = default", () => {
    assert.equal(scanHistoryMaxFromEnv(undefined), DEFAULT_SCAN_HISTORY_MAX);
    assert.equal(scanHistoryMaxFromEnv("5"), 5);
    assert.equal(scanHistoryMaxFromEnv("abc"), DEFAULT_SCAN_HISTORY_MAX);
    assert.equal(scanHistoryMaxFromEnv("0"), DEFAULT_SCAN_HISTORY_MAX);
    assert.equal(scanHistoryMaxFromEnv("-3"), DEFAULT_SCAN_HISTORY_MAX);
  });
});

describe("R7-L3 — ScanHistory sobre ficheiro real (tmpdir)", () => {
  let tmp;
  let file;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-r7-l3-hist-"));
    file = path.join(tmp, "scans.jsonl");
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const entry = (id, endedAt) =>
    toScanHistoryEntry(
      terminalState({ id, endTime: endedAt ?? "2026-10-12T10:00:00.000Z" }),
    );

  it("append de uma linha por análise, mais recente primeiro", async () => {
    const history = new ScanHistory(file, { max: 200 });
    await history.record(terminalState({ id: "a", endTime: "2026-10-12T10:00:01.000Z" }));
    await history.record(terminalState({ id: "b", endTime: "2026-10-12T10:00:02.000Z" }));
    const page = await history.query();
    assert.equal(page.entries.length, 2);
    assert.equal(page.entries[0].id, "b");
    assert.equal(page.entries[1].id, "a");
    assert.equal(page.nextCursor, null);
  });

  it("idempotente: a mesma scanId não produz uma segunda linha", async () => {
    const history = new ScanHistory(file, { max: 200 });
    await history.record(terminalState({ id: "a" }));
    await history.record(terminalState({ id: "a", threatsFound: 99 }));
    const raw = await fs.readFile(file, "utf8");
    assert.equal(raw.trim().split("\n").length, 2, "a e b: uma linha por scanId");
    const page = await history.query();
    assert.equal(page.entries.find((e) => e.id === "a").threatsFound, 2);
  });

  it("estado não terminal nunca é registado", async () => {
    const history = new ScanHistory(file, { max: 200 });
    await history.record({ ...terminalState({ id: "running-1" }), status: "running" });
    const page = await history.query();
    assert.equal(page.entries.some((e) => e.id === "running-1"), false);
  });

  it("retenção: exceder o teto compacta e mantém as mais recentes", async () => {
    const small = path.join(tmp, "small.jsonl");
    const history = new ScanHistory(small, { max: 3 });
    for (const id of ["1", "2", "3", "4", "5"]) {
      await history.record(
        terminalState({ id, endTime: `2026-10-12T10:00:0${id}.000Z` }),
      );
    }
    const page = await history.query(10);
    assert.deepEqual(
      page.entries.map((e) => e.id),
      ["5", "4", "3"],
    );
    // Compactação foi por ficheiro temporário + rename: não sobrou .tmp.
    assert.equal(await fs.readdir(tmp).then((names) => names.includes("small.jsonl.tmp")), false);
  });

  it("linha corrompida é ignorada — o histórico e o leitor sobrevivem", async () => {
    const corrupted = path.join(tmp, "corrupted.jsonl");
    const good = entry("good-1");
    await fs.writeFile(
      corrupted,
      `não é json de jeito nenhum\n{"id":"incompleto"}\n${JSON.stringify(good)}\n`,
      "utf8",
    );
    const history = new ScanHistory(corrupted, { max: 200 });
    const page = await history.query();
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].id, "good-1");
    // O registo continua a funcionar sobre o ficheiro corrompido.
    await history.record(entry("good-2"));
    const after = await history.query();
    assert.deepEqual(
      after.entries.map((e) => e.id),
      ["good-2", "good-1"],
    );
  });

  it("paginação com cursor opaco: limit, páginas e fim com nextCursor null", async () => {
    const paged = path.join(tmp, "paged.jsonl");
    const history = new ScanHistory(paged, { max: 200 });
    for (const id of ["p1", "p2", "p3", "p4", "p5"]) {
      await history.record(terminalState({ id }));
    }
    const page1 = await history.query(2);
    assert.deepEqual(
      page1.entries.map((e) => e.id),
      ["p5", "p4"],
    );
    assert.notEqual(page1.nextCursor, null);
    const page2 = await history.query(2, page1.nextCursor);
    assert.deepEqual(
      page2.entries.map((e) => e.id),
      ["p3", "p2"],
    );
    const page3 = await history.query(2, page2.nextCursor);
    assert.deepEqual(page3.entries.map((e) => e.id), ["p1"]);
    assert.equal(page3.nextCursor, null);
    // Cursor inválido = começa do início, nunca um erro.
    const invalid = await history.query(2, "!!not-a-cursor!!");
    assert.deepEqual(
      invalid.entries.map((e) => e.id),
      ["p5", "p4"],
    );
  });

  it("buildScanHistoryPage limita o tamanho da página a 1..100", () => {
    const all = Array.from({ length: 250 }, (_, i) => entry(`e${i}`));
    assert.equal(buildScanHistoryPage(all, 0).entries.length, 1);
    assert.equal(buildScanHistoryPage(all, 1000).entries.length, 100);
    assert.equal(buildScanHistoryPage(all).entries.length, 20);
  });
});

describe("R7-L3 — integração ScanManager (registo no terminal)", () => {
  let tmp;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-r7-l3-mgr-"));
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it("scan concluído fica registado uma vez, com os contadores reais", async () => {
    const history = new ScanHistory(path.join(tmp, "scans.jsonl"));
    const mgr = new ScanManager(makeOkEngine(), history);
    const id = await mgr.startScan("quick");
    assert.ok(id);
    const state = await waitTerminal(mgr, id);
    assert.equal(state.status, "completed");

    // Espera o registo assíncrono (o hook é fire-and-forget de propósito).
    let page = await history.query();
    for (let i = 0; i < 200 && page.entries.length === 0; i++) {
      await sleep(10);
      page = await history.query();
    }
    assert.equal(page.entries.length, 1);
    const recorded = page.entries[0];
    assert.equal(recorded.id, id);
    assert.equal(recorded.status, "completed");
    assert.equal(recorded.target, "default");
    assert.equal(recorded.filesConsidered, state.filesTotal ?? state.filesScanned);
    assert.equal(recorded.filesAnalyzed, state.filesAnalyzed ?? 0);
    assert.equal(recorded.filesExcluded, state.filesExcluded ?? 0);
    assert.equal(recorded.filesFailed, state.filesFailed ?? 0);
    assert.equal(recorded.threatsFound, state.threatsFound ?? 0);
    assert.equal(typeof recorded.durationMs === "number", true);
    // Nenhum caminho do utilizador atravessa para o histórico.
    assert.equal(JSON.stringify(page).includes(tmp), false);

    // Exactamente uma vez: o terminal é terminal — nenhum registo novo.
    await sleep(100);
    const again = await history.query();
    assert.equal(again.entries.length, 1);
  });

  it("scan cancelado fica registado como 'cancelled'", async () => {
    const history = new ScanHistory(path.join(tmp, "cancelled.jsonl"));
    const mgr = new ScanManager(makeOkEngine(), history);
    const id = await mgr.startScan("quick");
    mgr.cancelScan(id);
    const state = await waitTerminal(mgr, id);
    assert.equal(state.status, "cancelled");
    let page = await history.query();
    for (let i = 0; i < 200 && page.entries.length === 0; i++) {
      await sleep(10);
      page = await history.query();
    }
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].id, id);
    assert.equal(page.entries[0].status, "cancelled");
  });
});

describe("R7-L3 — engine (baseDir injetado + dispatch)", () => {
  let tmp;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-r7-l3-eng-"));
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  async function disposeQuietly(engine) {
    try {
      if (typeof engine.dispose === "function") await engine.dispose();
      else if (typeof engine.shutdown === "function") await engine.shutdown();
    } catch {
      /* a desmontagem não é o que este teste prova */
    }
  }

  it("scans.jsonl deriva do baseDir injetado e o ScanManager fica ligado a ele", async () => {
    const engine = new ProtectionEngineService(tmp);
    try {
      // Os `private` do TypeScript desaparecem em dist/ (mesmo
      // mecanismo do p0-runtime-isolation.test.js).
      assert.equal(
        engine.scanHistory.filePath,
        path.join(tmp, "scans.jsonl"),
        "scans.jsonl tem de derivar do baseDir injetado, não do homedir",
      );
      assert.equal(engine.scanManager.history, engine.scanHistory);
      await engine.init();
    } finally {
      await disposeQuietly(engine);
    }
  });

  it('dispatch "scan.history" devolve a página (vazia em baseDir novo)', async () => {
    const engine = new ProtectionEngineService(tmp);
    try {
      await engine.init();
      const page = await engine.dispatch("scan.history", undefined);
      assert.deepEqual(page, { entries: [], nextCursor: null });
      // Payload inválido não rebenta: normaliza para a página por defeito.
      const robust = await engine.dispatch("scan.history", { limit: "muito" });
      assert.equal(Array.isArray(robust.entries), true);
      assert.equal(robust.nextCursor, null);
    } finally {
      await disposeQuietly(engine);
    }
  });
});
