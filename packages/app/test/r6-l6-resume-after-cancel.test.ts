import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ScanState } from "@cybersafe/shared-types";
import {
  isResumableScanSession,
  scanProgressPercent,
  shouldAcceptScanState,
  uiStatusForState,
  isTerminalScanStatus,
  scanResultBreakdown,
} from "../src/lib/scanSession";

/** Estado base para testes da UI — como se viesse do serviço. */
function stateOf(overrides: Partial<ScanState> = {}): ScanState {
  return {
    id: "test-scan-id",
    type: "custom",
    status: "running",
    progress: 0,
    filesScanned: 0,
    threatsFound: 0,
    startTime: "2026-10-12T06:00:00.000Z",
    updatedAt: new Date().toISOString(),
    phase: "scanning",
    filesTotal: 100,
    filesAnalyzed: 0,
    filesExcluded: 0,
    filesFailed: 0,
    ...overrides,
  };
}

describe("R6-L6 — retoma pela UI após cancelamento", () => {
  test("estado cancelado NÃO é retomável — UI mostra estado real, não falsifica", () => {
    const cancelled = stateOf({ status: "cancelled", progress: 100, filesTotal: 100 });
    // Cancelled é terminal — nunca deve oferecer "recuperar análise"
    assert.equal(isResumableScanSession(cancelled), false, "cancelled não é retomável");
    assert.equal(isTerminalScanStatus(cancelled.status), true, "cancelled é terminal");
  });

  test("estado completed NÃO é retomável — não há recuperar sobre o que acabou", () => {
    const completed = stateOf({ status: "completed", progress: 100 });
    assert.equal(isResumableScanSession(completed), false, "completed não é retomável");
  });

  test("estado failed NÃO é retomável", () => {
    const failed = stateOf({ status: "failed", progress: 0, phase: "finalizing" });
    assert.equal(isResumableScanSession(failed), false, "failed não é retomável");
  });

  test("cancelamento publica estado terminal correcto — não finge 'running'", async () => {
    // Simula a sequência de eventos do serviço durante cancelamento.
    // O serviço garente que o último evento antes de 'cancelled' tem o
    // estado correto e o terminal é 'cancelled', não 'running'.
    const running = stateOf({ status: "running", progress: 20, filesScanned: 20, phase: "scanning" });
    const cancelled = stateOf({ status: "cancelled", progress: 20, endTime: "2026-10-12T06:01:00.000Z", phase: "scanning" });

    // O merge de estados: running → cancelled
    const merged = shouldAcceptScanState(running, cancelled)
      ? { ...running, ...cancelled, revision: (running.revision ?? 0) + 1 }
      : running;
    assert.equal(merged.status, "cancelled", "o merge respeita o estado terminal");

    // A UI não deve aceitar eventos que tentem reabrir um terminal para running.
    const reopened = shouldAcceptScanState(cancelled, running);
    assert.equal(reopened, false, "não reabre cancelled para running");
  });

  test("progresso durante cancelamento não salta para 100% — honesto", () => {
    // Um scan cancelado a meio deve mostrar o progresso REAL, não 100%.
    const cancelled = stateOf({
      status: "cancelled",
      progress: 35,
      filesScanned: 35,
      filesAnalyzed: 30,
      filesExcluded: 5,
      filesFailed: 0,
      endTime: "2026-10-12T06:01:00.000Z",
    });
    assert.equal(scanProgressPercent(cancelled), 35, "progresso real no cancel");
    assert.equal(cancelled.filesTotal, 100);

    // A breakdown usa filesTotal como 'considered'. Num cancel parcial, a
    // identidade filesAnalyzed + filesExcluded + filesFailed = filesScanned
    // (30+5+0=35) é verdade, mas não = filesTotal (100) — por isso
    // 'reconciled' é false, e a UI avisa que não foi concluída.
    const breakdown = scanResultBreakdown(cancelled);
    assert.ok(breakdown, "breakdown disponível para cancelled");
    assert.equal(breakdown!.reconciled, false, "cancel parcial: não é reconciled (não terminou)");
    // A identidade por-ficheiro ainda fecha: analisados + excluídos + falhados = scanned.
    assert.equal(
      breakdown!.analyzed + breakdown!.excluded + breakdown!.failed,
      cancelled.filesScanned,
      "identidade parcial: analyzed + excluded + failed = filesScanned",
    );
  });

  test("novo scan após cancel: estado 'queued' é retomável → UI pode oferecer recuperação", () => {
    const queued = stateOf({
      status: "queued",
      progress: 0,
      phase: "preparing",
      updatedAt: new Date().toISOString(),
    });
    // Um novo scan está em queued → UI mostra estado real e pode rastrear
    assert.equal(isResumableScanSession(queued), true, "queued é retomável");
    assert.equal(isTerminalScanStatus(queued.status), false, "queued não é terminal");
    assert.equal(scanProgressPercent(queued), null, "durante preparing, barra indeterminada");
  });

  test("simulação: cancelar e retomar — dois scans distintos, estados correctos", () => {
    // Scan 1: cancelado
    const scan1 = stateOf({
      id: "scan-1",
      status: "cancelled",
      progress: 100,
      endTime: "2026-10-12T06:01:00.000Z",
    });
    assert.equal(isResumableScanSession(scan1), false, "scan-1 não é retomável (cancelado)");

    // Scan 2: novo, retomável
    const scan2 = stateOf({
      id: "scan-2",
      status: "running",
      progress: 0,
      phase: "gathering",
      filesTotal: 50,
      filesDiscovered: 12,
      updatedAt: new Date().toISOString(),
    });
    assert.equal(isResumableScanSession(scan2), true, "scan-2 é retomável (running)");
    assert.notEqual(scan1.id, scan2.id, "IDs distintos");

    // A UI não confunde scan1 com scan2 — states são independentes.
    assert.notDeepEqual(scan1, scan2, "estados independentes");
  });
});
