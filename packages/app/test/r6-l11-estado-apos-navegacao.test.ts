import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ScanState } from "@cybersafe/shared-types";
import {
  decideScanRecovery,
  isResumableScanSession,
  uiStatusForState,
  shouldAcceptScanState,
  mergeScanState,
  shouldShowHydration,
  isTerminalScanStatus,
  terminalResultLabels,
} from "../src/lib/scanSession";

/**
 * R6-L11 — ESTADO após NAVEGAÇÃO.
 *
 * O reader (renderer) volta à página do Scanner a meio de uma análise
 * ou depois de ela ter fechado. O serviço é a fonte de verdade
 * (`scan.getActive` / eventos `scan.progress`); o reader tem de
 * RECONHECER o estado real:
 *   - scan em curso  → sessão retomável, ecrã de recuperação justificado;
 *   - scan concluído → resultado final, NUNCA um "a recuperar..." falso;
 *   - evento atrasado → contadores não recuam; terminal nunca reabre.
 *
 * Só usa o contrato puro de scanSession.ts — sem produto alterado.
 */

const FRESH = new Date().toISOString();

/** Snapshot como o serviço o publica (scan.progress / scan.getActive). */
function snapshotOf(overrides: Partial<ScanState> = {}): ScanState {
  return {
    id: "scan-navegacao",
    type: "custom",
    status: "running",
    progress: 0,
    filesScanned: 0,
    threatsFound: 0,
    startTime: "2026-10-12T12:00:00.000Z",
    updatedAt: FRESH,
    phase: "scanning",
    filesTotal: 100,
    filesAnalyzed: 0,
    filesExcluded: 0,
    filesFailed: 0,
    filesInconclusive: 0,
    ...overrides,
  };
}

describe("R6-L11 — reader volta à página a meio do scan: reconhece a análise em curso", () => {
  test("snapshot running+scanning com carimbo fresco é uma sessão retomável", () => {
    const running = snapshotOf({
      status: "running",
      phase: "scanning",
      progress: 40,
      filesScanned: 40,
      filesAnalyzed: 38,
      filesTotal: 100,
    });

    const recovered = decideScanRecovery(running);
    assert.ok(recovered, "um scan VIVO é reconhecido como recuperável");
    assert.equal(recovered!.id, "scan-navegacao");
    assert.equal(recovered!.status, "running");
    assert.equal(isResumableScanSession(recovered!), true, "sessão viva com dados e carimbo fresco");
    assert.equal(uiStatusForState(recovered!), "scanning", "a UI mostra a fase real, não um spinner genérico");
  });

  test("ecrã de recuperação só aparece com prova de sessão viva", () => {
    const running = snapshotOf({ status: "running", phase: "scanning", filesScanned: 40 });
    const recovered = decideScanRecovery(running);
    assert.equal(
      shouldShowHydration(true, "idle", recovered !== null),
      true,
      "hydration é legítimo: há sessão viva comprovada",
    );
  });

  test("scan em preparação (queued) também é reconhecido como em curso", () => {
    const queued = snapshotOf({ status: "queued", phase: "preparing", filesTotal: 0 });
    assert.equal(isResumableScanSession(queued), true, "queued é vida");
    assert.equal(uiStatusForState(queued), "preparing");
  });

  test("carimbo velho (> 20 s de silêncio) não é sessão retomável", () => {
    const stale = snapshotOf({
      status: "running",
      phase: "scanning",
      updatedAt: new Date(Date.now() - 25_000).toISOString(),
    });
    assert.equal(isResumableScanSession(stale), false, "motor emudecido: não oferecer recuperação");
    assert.equal(decideScanRecovery(stale), null);
  });

  test("ressincronização do serviço é aceite e não faz os contadores recuar", () => {
    const local = snapshotOf({ filesScanned: 20, revision: 3 });
    const resync = snapshotOf({ filesScanned: 45, filesAnalyzed: 44, revision: 7 });

    assert.equal(shouldAcceptScanState(local, resync), true, "revisão maior é aceite");
    const merged = mergeScanState(local, resync);
    assert.equal(merged.filesScanned, 45, "o reader adopta o estado mais recente do serviço");
    assert.equal(merged.filesAnalyzed, 44);
    assert.equal(merged.filesTotal, 100);
  });
});

describe("R6-L11 — reader volta à página após o scan fechar: reconhece o resultado", () => {
  test("completed não é retomável — mostra o resultado, sem 'recuperar' falso", () => {
    const completed = snapshotOf({
      status: "completed",
      phase: "finalizing",
      progress: 100,
      filesScanned: 100,
      filesAnalyzed: 100,
      threatsFound: 0,
      endTime: "2026-10-12T12:05:00.000Z",
    });

    assert.equal(decideScanRecovery(completed), null, "nada a recuperar: a análise já terminou");
    assert.equal(isResumableScanSession(completed), false);
    assert.equal(uiStatusForState(completed), "completed");
    assert.equal(
      shouldShowHydration(true, "idle", false),
      false,
      "sem sessão viva: abre em idle, não promete recuperação",
    );
    assert.equal(isTerminalScanStatus(completed.status), true);
    assert.deepEqual(terminalResultLabels("completed", completed), {
      titulo: "Análise concluída",
      chip: "Concluída",
      tom: "green",
    });
  });

  test("completed COM ameaças não fica verde — o facto é a ameaça", () => {
    assert.deepEqual(terminalResultLabels("completed", snapshotOf({
      status: "completed",
      filesAnalyzed: 2,
      threatsFound: 2,
    })), {
      titulo: "Análise concluída — ameaças encontradas",
      chip: "Ameaças encontradas",
      tom: "red",
    });
  });

  test("cancelled e failed após navegação: terminais honestos, nunca 'running'", () => {
    const cancelled = snapshotOf({
      status: "cancelled",
      progress: 40,
      filesScanned: 40,
      endTime: "2026-10-12T12:02:00.000Z",
    });
    assert.equal(decideScanRecovery(cancelled), null);
    assert.equal(isResumableScanSession(cancelled), false);
    assert.equal(uiStatusForState(cancelled), "cancelled");
    assert.deepEqual(terminalResultLabels("cancelled", cancelled), {
      titulo: "Análise cancelada",
      chip: "Cancelada",
      tom: "yellow",
    });

    const failed = snapshotOf({
      status: "failed",
      error: "o motor não respondeu",
      endTime: "2026-10-12T12:02:00.000Z",
    });
    assert.equal(decideScanRecovery(failed), null);
    assert.equal(uiStatusForState(failed), "failed");
    assert.deepEqual(terminalResultLabels("failed", failed), {
      titulo: "Análise falhada",
      chip: "Falhada",
      tom: "red",
    });
  });
});

describe("R6-L11 — eventos atrasados depois de voltar à página", () => {
  test("evento com revisão menor é rejeitado: os contadores não recuam", () => {
    const actual = snapshotOf({ filesScanned: 40, filesAnalyzed: 38, revision: 5 });
    const stale = snapshotOf({ filesScanned: 10, filesAnalyzed: 10, revision: 3 });

    assert.equal(shouldAcceptScanState(actual, stale), false, "revisão 3 < 5 é atrasada");
    // Fluxo do reader: só faz merge do que aceita.
    const next = shouldAcceptScanState(actual, stale) ? mergeScanState(actual, stale) : actual;
    assert.equal(next.filesScanned, 40, "o reader mantém o estado mais avançado");
  });

  test("um scan terminal nunca reabre — nem com um evento 'running' atrasado", () => {
    const completed = snapshotOf({ status: "completed", progress: 100, revision: 9 });
    const lateRunning = snapshotOf({ status: "running", phase: "scanning", filesScanned: 40, revision: 10 });

    assert.equal(shouldAcceptScanState(completed, lateRunning), false, "terminal não reabre");
    const next = shouldAcceptScanState(completed, lateRunning) ? mergeScanState(completed, lateRunning) : completed;
    assert.equal(next.status, "completed");
    assert.equal(uiStatusForState(next), "completed");
  });

  test("evento do mesmo scan com revisão maior é aceite e avança o estado", () => {
    const current = snapshotOf({ filesScanned: 40, revision: 5 });
    const newer = snapshotOf({ filesScanned: 60, filesAnalyzed: 58, revision: 6 });
    assert.equal(shouldAcceptScanState(current, newer), true);
    const merged = mergeScanState(current, newer);
    assert.equal(merged.filesScanned, 60);
  });
});
