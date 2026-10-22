import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ScanManager } from "../dist/scan-manager.js";

/**
 * WS-1 — qualidade de runtime do scanner (Análise Profunda).
 *
 * Objectivo desta suite, um teste por invariante:
 *   1. a percentagem de progresso é MONOTÓNICA (nunca recua);
 *   2. os contadores NUNCA recuam no mesmo scan;
 *   3. existe um ÚNICO estado terminal (completed | cancelled | failed);
 *   4. cancelar leva sempre a um estado terminal — nunca fica em "running".
 *
 * Além disso: o scan sobrevive ao renderer ir-se embora (o snapshot continua
 * disponível para ressincronização) e o progresso não escreve um evento por
 * microevento.
 *
 * Sem Analise Profunda real, sem volume, sem zip bomb: árvores pequenas em
 * tmp e um motor simulado. Os testes correm o ScanManager real.
 */

const TERMINAL = new Set(["completed", "cancelled", "failed"]);
const MONOTONE_COUNTERS = [
  "filesScanned",
  "filesProcessed",
  "filesAnalyzed",
  "filesExcluded",
  "filesFailed",
  "threatsFound",
  "filesDiscovered",
];

/** Motor simulado que grava o fluxo completo de eventos de progresso. */
function recordingEngine(opts = {}) {
  const events = [];
  const engine = {
    events,
    scannedFiles: [],
    perFileMs: opts.perFileMs ?? 0,
    threatFiles: opts.threatFiles ?? [],
    async scanArtifact(filePath) {
      engine.scannedFiles.push(filePath);
      if (engine.perFileMs) await new Promise((r) => setTimeout(r, engine.perFileMs));
      if (engine.threatFiles.includes(path.basename(filePath))) {
        return { highRiskCount: 1, overallSeverity: "high" };
      }
      return { highRiskCount: 0, overallSeverity: "safe" };
    },
    emitScanProgress(state) {
      // Cópia: o estado é imutável, mas queremos um histórico independente.
      events.push({ ...state });
    },
  };
  return engine;
}

async function tree(baseName, count, ext = ".txt") {
  const base = path.join(os.tmpdir(), `cybersafe-ws1-${baseName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(base, { recursive: true });
  for (let i = 0; i < count; i++) {
    await fs.writeFile(path.join(base, `f${i}${ext}`), "x");
  }
  return base;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera o scan chegar a um estado terminal (ou dá timeout). */
async function waitTerminal(mgr, id, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = mgr.getScan(id);
    if (s && TERMINAL.has(s.status)) return s;
    await sleep(20);
  }
  return mgr.getScan(id);
}

describe("WS-1 invariantes de runtime do scan", () => {
  it("1. percentagem de progresso é monotónica — nunca recua", async () => {
    const dir = await tree("progress", 40);
    const engine = recordingEngine({ perFileMs: 2 });
    const mgr = new ScanManager(engine);

    const id = await mgr.startScan("custom", dir);
    const final = await waitTerminal(mgr, id);

    assert.equal(final.status, "completed");
    assert.ok(engine.events.length > 0, "o scan tem de emitir progresso");

    let previous = -1;
    for (const ev of engine.events) {
      assert.equal(
        typeof ev.progress,
        "number",
        `progress tem de ser numérico (evento rev=${ev.revision})`,
      );
      assert.ok(
        ev.progress >= previous,
        `a percentagem recuou: ${previous} -> ${ev.progress} (rev ${ev.revision}, phase ${ev.phase})`,
      );
      assert.ok(ev.progress >= 0 && ev.progress <= 100, `percentagem fora de 0..100: ${ev.progress}`);
      previous = ev.progress;
    }
    assert.equal(final.progress, 100, "um scan concluído acaba a 100%");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("2. os contadores nunca recuam no mesmo scan", async () => {
    const dir = await tree("counters", 30);
    const engine = recordingEngine({ perFileMs: 2, threatFiles: ["f3.txt", "f17.txt"] });
    const mgr = new ScanManager(engine);

    const id = await mgr.startScan("custom", dir);
    const final = await waitTerminal(mgr, id);
    assert.equal(final.status, "completed");

    const seen = {};
    for (const ev of engine.events) {
      for (const key of MONOTONE_COUNTERS) {
        const value = ev[key];
        if (typeof value !== "number") continue;
        const prev = seen[key];
        if (prev !== undefined) {
          assert.ok(
            value >= prev,
            `contador ${key} recuou: ${prev} -> ${value} (rev ${ev.revision}, phase ${ev.phase})`,
          );
        }
        seen[key] = value;
      }
    }

    // O total é o denominador: nunca maior do que o total descoberto.
    for (const ev of engine.events) {
      if (typeof ev.filesTotal === "number" && typeof ev.filesScanned === "number") {
        assert.ok(ev.filesScanned <= ev.filesTotal, `filesScanned ${ev.filesScanned} > filesTotal ${ev.filesTotal}`);
      }
    }

    assert.equal(final.filesTotal, 30, "o denominador é o número real de candidatos");
    assert.equal(final.filesScanned, 30);
    assert.equal(final.threatsFound, 2, "as duas ameaças mock contam uma vez cada");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("3. estado terminal único — só há uma transição para terminal", async () => {
    const dir = await tree("terminal", 12);
    const engine = recordingEngine({ perFileMs: 2 });
    const mgr = new ScanManager(engine);

    const id = await mgr.startScan("custom", dir);
    const final = await waitTerminal(mgr, id);
    assert.ok(TERMINAL.has(final.status), `estado terminal inesperado: ${final.status}`);
    assert.ok(final.endTime, "um estado terminal tem endTime");

    // Depois de terminal, o estado tem de permanecer terminal e imutável.
    const statuses = engine.events.map((e) => e.status);
    const terminalCount = statuses.filter((s) => TERMINAL.has(s)).length;
    assert.ok(terminalCount >= 1, "tem de existir pelo menos uma emissão terminal");

    // A última emissão é a terminal e as anteriores não são terminais-conflict.
    assert.equal(final.status, "completed");
    assert.equal(statuses.at(-1), "completed");
    assert.ok(
      statuses.slice(0, -1).every((s) => s === "running" || s === "queued"),
      `estado voltou a não-terminal depois de terminal: ${statuses.join(" -> ")}`,
    );

    // Nada volta a running depois de terminal.
    mgr.cancelScan(id);
    await sleep(50);
    assert.equal(mgr.getScan(id).status, "completed", "cancelar depois de concluído não muda o estado");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("4. cancelar leva a terminal e nunca fica em running", async () => {
    const dir = await tree("cancel", 60);
    const engine = recordingEngine({ perFileMs: 6 });
    const mgr = new ScanManager(engine);

    const id = await mgr.startScan("custom", dir);
    await sleep(60);
    const before = mgr.getScan(id);
    assert.ok(before.status === "running" || before.status === "queued", `pré-cancel: ${before.status}`);

    mgr.cancelScan(id);
    const final = await waitTerminal(mgr, id);

    assert.ok(
      TERMINAL.has(final.status),
      `cancelar tem de chegar a um estado terminal, ficou em ${final.status}`,
    );
    assert.equal(final.status, "cancelled", `o utilizador cancelou: esperava cancelled, obtive ${final.status}`);
    assert.ok(final.endTime, "cancelado tem de ter endTime");
    assert.equal(mgr.getActiveScan(), null, "um scan cancelado não fica activo para o renderer");

    // Nenhuma emissão posterior pode ressuscitar o scan.
    const after = engine.events.slice(engine.events.findIndex((e) => e.status === "cancelled") + 1);
    assert.ok(
      after.every((e) => !TERMINAL.has(e.status) || e.status === "cancelled"),
      `estado mudou para ${after.map((e) => e.status).join(",")} depois de cancelled`,
    );

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("4b. cancelar um scan sem ficheiros também é cancelled, nunca completed", async () => {
    // Regressão. Cancelar logo no arranque não apanha o bug: `runScanLoop`
    // aborta logo no check de `isCancelled`. O caminho quebrado é o cancel
    // durante o GATHERING: a recolha parte-se, `files` fica vazio, e o ramo
    // "zero ficheiros" escrevia `completed` + `progress: 100` por cima do
    // `cancelled` — dois estados terminais, com o cancel ignorado.
    // Aqui o cancel é disparado de dentro do `emitScanProgress` (síncrono),
    // logo aterra no meio da gathering sem corrida de timing.
    const dir = await tree("empty", 0);
    const engine = recordingEngine();
    const mgr = new ScanManager(engine);

    let cancelFired = false;
    engine.emitScanProgress = (state) => {
      engine.events.push({ ...state });
      if (!cancelFired && state.phase === "gathering") {
        cancelFired = true;
        mgr.cancelScan(state.id);
      }
    };

    const id = await mgr.startScan("custom", dir);
    const final = await waitTerminal(mgr, id);

    assert.ok(cancelFired, "o cancel tem de ter sido disparado durante a gathering");
    assert.equal(
      final.status,
      "cancelled",
      `cancelar durante a gathering tem de dar cancelled, obtive ${final.status}`,
    );
    assert.notEqual(final.progress, 100, "um scan cancelado não pode reportar 100%");
    assert.equal(mgr.getActiveScan(), null, "cancelado não fica activo para o renderer");

    // Nenhum `completed` pode aparecer depois de `cancelled`.
    const cancelledAt = engine.events.findIndex((e) => e.status === "cancelled");
    assert.ok(cancelledAt >= 0, "houve uma emissão cancelled");
    const after = engine.events.slice(cancelledAt + 1);
    assert.equal(
      after.filter((e) => e.status === "completed").length,
      0,
      `estados depois de cancelled: ${after.map((e) => e.status).join(",")}`,
    );

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("5. o scan sobrevive a navegar para fora e voltar (snapshot para resync)", async () => {
    const dir = await tree("resync", 40);
    const engine = recordingEngine({ perFileMs: 8 });
    const mgr = new ScanManager(engine);

    const id = await mgr.startScan("custom", dir);
    await sleep(80);

    // "O renderer foi-se embora": o estado tem de continuar disponível e vivo.
    const snapshotWhileAway = mgr.getActiveScan();
    assert.ok(snapshotWhileAway, "o scan em curso tem de continuar visível para resync");
    assert.equal(snapshotWhileAway.id, id);
    assert.ok(snapshotWhileAway.revision > 0, "o snapshot tem revisão para o renderer descartar eventos atrasados");

    // O snapshot é uma fotografia: não pode mutar por baixo do renderer.
    const revAtSnapshot = snapshotWhileAway.revision;
    const scannedAtSnapshot = snapshotWhileAway.filesScanned;
    await sleep(120);
    assert.equal(snapshotWhileAway.revision, revAtSnapshot, "o snapshot não pode mutar depois de entregue");
    assert.equal(snapshotWhileAway.filesScanned, scannedAtSnapshot, "o snapshot é imutável");

    // "Voltámos": o snapshot actual tem de ser mais recente (monotónico).
    const afterReturn = mgr.getActiveScan();
    assert.ok(afterReturn, "o scan continua activo ao voltar");
    assert.ok(
      afterReturn.revision > revAtSnapshot,
      `a revisão tem de avançar enquanto o scan corre: ${revAtSnapshot} -> ${afterReturn.revision}`,
    );
    assert.ok(
      afterReturn.filesScanned >= scannedAtSnapshot,
      `os contadores recuaram entre snapshots: ${scannedAtSnapshot} -> ${afterReturn.filesScanned}`,
    );

    const final = await waitTerminal(mgr, id);
    assert.equal(final.status, "completed");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("6. o progresso não escreve um evento por microevento", async () => {
    const dir = await tree("throttle", 60);
    const engine = recordingEngine({ perFileMs: 1 });
    const mgr = new ScanManager(engine);

    const id = await mgr.startScan("custom", dir);
    const final = await waitTerminal(mgr, id);
    assert.equal(final.status, "completed");

    // 60 ficheiros não podem gerar 60+ emissões: o loop emite de 4 em 4, no
    // último ficheiro, ou no máximo 1x por segundo.
    assert.ok(
      engine.events.length <= 30,
      `emissões a mais para 60 ficheiros: ${engine.events.length}`,
    );
    assert.ok(
      engine.events.length >= 2,
      `nem tudo foi emitido: ${engine.events.length}`,
    );

    // E o denominador correcto torna a progressão útil mesmo com poucos eventos.
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("7. uma falha no scan dá o terceiro estado terminal — failed, uma só vez", async () => {
    const dir = await tree("failed", 20);
    const engine = recordingEngine({ perFileMs: 2 });
    const mgr = new ScanManager(engine);

    // `emitScanProgress` é chamado de dentro de `updateScan`, dentro do try do
    // scan loop: um throw aqui é o caminho real para o catch externo.
    let thrown = false;
    engine.emitScanProgress = (state) => {
      engine.events.push({ ...state });
      if (!thrown && state.phase === "scanning") {
        thrown = true;
        throw new Error("probe: falha injectada no progresso");
      }
    };

    const id = await mgr.startScan("custom", dir);
    const final = await waitTerminal(mgr, id);

    assert.ok(thrown, "a falha injectada tem de ter acontecido");
    assert.equal(final.status, "failed", `esperava failed, obtive ${final.status}`);
    assert.ok(final.endTime, "failed tem de ter endTime");
    assert.match(final.error ?? "", /falha injectada/, "o erro tem de ser diagnosticado");
    assert.equal(mgr.getActiveScan(), null, "um scan falhado não fica activo");

    // Um único `failed`: sem repetição e sem `completed` atrás.
    const statuses = engine.events.map((e) => e.status);
    assert.equal(statuses.filter((s) => s === "failed").length, 1, `failed emitido ${statuses.join(" -> ")}`);
    assert.equal(statuses.includes("completed"), false, `não pode haver completed: ${statuses.join(" -> ")}`);

    await sleep(80);
    assert.equal(mgr.getScan(id).status, "failed", "o estado terminal é estável");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
