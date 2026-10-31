/**
 * TASK C (revalidação WAVE C) — buracos de honestidade que a primeira vaga
 * deixou em aberto. Cada teste fixa uma exigência do brief:
 *   1. os 6 estados (preparing / batch / completed / cancelled / failed /
 *      inconclusive) são representados sem mentira;
 *   2. o verde é EXCLUSIVO de "clean": ERROR/inconclusive nunca parecem limpos;
 *   3. "sem ameaças" só em completed + clean — nunca em cancel/failed;
 *   4. nada de progresso inventado por ficheiro;
 *   5. botão cancelar coerente durante o batch e durante o cancel;
 *   6. elapsed/velocidade coerentes com filesAnalyzed=0 durante ~7 s;
 *   7. PT-PT com singular/plural correctos em TODAS as frases.
 *
 * Os helpers vivem em `scanSession.ts` (1 só dono da copy) e o
 * FileScannerPage usa-os — testá-los aqui é testar o que a UI mostra.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const {
  activeScanDetail,
  buildResultSummary,
  cancelButtonState,
  formatScanDurationLabel,
  mergeScanState,
  noDetectionsTone,
  normalizeScanState,
  resultFilesWithoutDetections,
  scanElapsedSeconds,
  scanRateLabel,
  terminalScanLogMessage,
  filesFailedFooterLabel,
  filesExcludedFooterLabel,
} = await import("../src/lib/scanSession");

const ts = (offsetMs: number) => new Date(Date.parse("2026-10-02T12:00:00.000Z") + offsetMs).toISOString();

describe("TASK C.1 — os 6 estados do batch, honestos", () => {
  test("preparing: descreve o contacto com o motor, não verificação de ficheiros", () => {
    const detail = activeScanDetail("computer", "quick", "preparing", undefined, 0);
    assert.match(detail, /A contactar o motor de análise local\./);
    assert.doesNotMatch(detail, /a verificar os ficheiros/i);
  });

  test("batch em curso: nomeia N e diz que é UMA passagem; inconclusivo não surge como progresso", () => {
    const detail = activeScanDetail("computer", "full", "scanning", undefined, 12);
    assert.match(detail, /12 ficheiros/);
    assert.doesNotMatch(detail, /\b\d+\s*\/\s*\d+/);
  });

  test("failed durante o batch: o contador do batch NÃO fica preso no merge", () => {
    const comBatch = normalizeScanState({
      id: "s1", type: "custom", status: "running", phase: "scanning", progress: 0, filesInEngineBatch: 12,
    })!;
    const falhou = normalizeScanState({
      id: "s1", type: "custom", status: "failed", progress: 100, error: "clamscan abortou",
    })!;
    const merged = mergeScanState(comBatch, falhou);
    assert.equal(merged.filesInEngineBatch ?? 0, 0, "após falhar não pode restar '12 ficheiros' no ecrã");
    const detail = activeScanDetail("computer", "full", "scanning", undefined, merged.filesInEngineBatch ?? 0);
    assert.doesNotMatch(detail, /12 ficheiros/);
  });

  test("inconclusive (sem filesAnalyzed): contagem em '—' e NUNCA verde", () => {
    const state = { status: "completed" as const, threatsFound: 0, filesInconclusive: 1 };
    assert.equal(resultFilesWithoutDetections(state), null);
    assert.equal(noDetectionsTone(state), "neutral", "sem base conhecida o cartão não pode parecer 'limpo'");
  });
});

describe("TASK C.2 — verde exclusivo de 'safe'", () => {
  test("completed + zero ameaças + base conhecida → green", () => {
    assert.equal(noDetectionsTone({
      status: "completed",
      threatsFound: 0,
      filesAnalyzed: 10,
      filesFailed: 0,
      filesInconclusive: 0,
    }), "green");
  });

  test("completed COM ameaças → nunca green, mesmo com contagem real", () => {
    assert.equal(noDetectionsTone({
      status: "completed",
      threatsFound: 2,
      filesAnalyzed: 10,
      filesFailed: 0,
      filesInconclusive: 0,
    }), "neutral");
  });

  test("cancelled e failed → nunca green", () => {
    assert.equal(noDetectionsTone({
      status: "cancelled", threatsFound: 0, filesAnalyzed: 10, filesFailed: 0, filesInconclusive: 0,
    }), "neutral");
    assert.equal(noDetectionsTone({
      status: "failed", threatsFound: 0, filesAnalyzed: 10, filesFailed: 0, filesInconclusive: 0,
    }), "neutral");
  });

  test("ficheiros inconclusivos ou falhados nunca ficam verdes", () => {
    assert.equal(noDetectionsTone({
      status: "completed", threatsFound: 0, filesAnalyzed: 10, filesFailed: 0, filesInconclusive: 1,
    }), "neutral");
    assert.equal(noDetectionsTone({
      status: "completed", threatsFound: 0, filesAnalyzed: 10, filesFailed: 1, filesInconclusive: 0,
    }), "neutral");
  });
});

describe("TASK C.3 — 'sem ameaças' só em completed + clean", () => {
  test("resumo cancelado não tranquiliza", () => {
    const s = buildResultSummary({ scope: "computer", type: "quick", status: "cancelled", filesScanned: 40, threatsFound: 0 });
    assert.match(s, /Análise cancelada/);
    assert.doesNotMatch(s, /não foram encontradas ameaças|sem ameaças/i);
  });

  test("resumo falhado não tranquiliza nem parece limpo", () => {
    const s = buildResultSummary({ scope: "computer", type: "quick", status: "failed", filesScanned: 0, threatsFound: 0, error: "motor desligou" });
    assert.doesNotMatch(s, /não foram encontradas ameaças|sem ameaças|concluída/i);
    assert.match(s, /Não foi possível concluir/);
  });
});

describe("TASK C.5 — botão cancelar coerente", () => {
  test("durante o batch (a analisar, com scan id) está ativo", () => {
    const b = cancelButtonState("scanning", true, false);
    assert.equal(b.enabled, true);
    assert.match(b.label, /Cancelar/);
  });

  test("depois do pedido, até o motor confirmar: desativado e diz o que aconteceu", () => {
    const b = cancelButtonState("scanning", true, true);
    assert.equal(b.enabled, false);
    assert.match(b.label, /Cancelamento pedido/);
  });

  test("sem scan id (preparing antes da resposta) não oferece cancel fictício", () => {
    assert.equal(cancelButtonState("preparing", false, false).enabled, false);
  });

  test(" estados terminais nunca permitem cancelar", () => {
    for (const ui of ["idle", "completed", "cancelled", "failed"] as const) {
      assert.equal(cancelButtonState(ui, true, false).enabled, false, `${ui} não cancela`);
    }
  });
});

describe("TASK C.6 — elapsed/velocidade com filesAnalyzed=0 durante ~7 s", () => {
  test("elapsed conta tempo real mesmo sem nenhum ficheiro analisado", () => {
    const state = {
      id: "s1", type: "custom", status: "running", phase: "scanning", progress: 0,
      filesScanned: 0, threatsFound: 0, filesInEngineBatch: 20, startTime: ts(0),
    } as const;
    const now = Date.parse(state.startTime) + 7_600;
    assert.equal(scanElapsedSeconds(state, now), 7, "7,6 s de base load têm de aparecer como 7 s");
  });

  test("velocidade durante o batch sem ficheiros analisados é '—', nunca 0", () => {
    const state = normalizeScanState({
      id: "s1", type: "custom", status: "running", phase: "scanning", progress: 0,
      filesScanned: 0, filesAnalyzed: 0, filesInEngineBatch: 20,
    })!;
    assert.equal(scanRateLabel(state), "—");
  });

  test("duração final: singular/plural e 'menos de 1 segundo' honestos", () => {
    assert.equal(formatScanDurationLabel({ startTime: ts(0), endTime: ts(600) }), "menos de 1 segundo");
    assert.equal(formatScanDurationLabel({ startTime: ts(0), endTime: ts(1_400) }), "1 segundo");
    assert.equal(formatScanDurationLabel({ startTime: ts(0), endTime: ts(2_500) }), "2 segundos");
    assert.equal(formatScanDurationLabel({ startTime: ts(0), endTime: ts(7_600) }), "7 segundos");
    assert.equal(formatScanDurationLabel({}), null, "sem carimbos não se inventa duração");
  });
});

describe("TASK C.7 — PT-PT singular/plural em todas as frases", () => {
  test("log terminal: 1 ficheiro no singular, N no plural", () => {
    const um = terminalScanLogMessage({ status: "completed", filesScanned: 1, filesAnalyzed: 1, threatsFound: 0 });
    assert.match(um, /1 ficheiro analisado\b/);
    assert.doesNotMatch(um, /1 ficheiros/);
    const muitos = terminalScanLogMessage({ status: "completed", filesScanned: 20, filesAnalyzed: 20, threatsFound: 0 });
    assert.match(muitos, /20 ficheiros analisados/);
  });

  test("log terminal: sem cobertura de motores diz 'considerados', nunca 'analisados'", () => {
    // `filesAnalyzed` ausente = o motor não reportou quantos chegaram aos
    // motores. Dizer "1 ficheiro analisado" a partir de `filesScanned` era
    // apresentar os ignorados pelas exclusões como verificados.
    const semCobertura = terminalScanLogMessage({ status: "completed", filesScanned: 1, threatsFound: 0 });
    assert.match(semCobertura, /1 ficheiro considerado\b/);
    assert.doesNotMatch(semCobertura, /analisad/);
    const muitos = terminalScanLogMessage({ status: "completed", filesScanned: 800, threatsFound: 0 });
    assert.match(muitos, /800 ficheiros considerados/);
    assert.doesNotMatch(muitos, /800 ficheiros analisados/);
  });

  test("log terminal: analisados de considerados quando o motor só cobriu parte", () => {
    const parcial = terminalScanLogMessage({
      status: "completed",
      filesScanned: 800,
      filesAnalyzed: 663,
      threatsFound: 0,
    });
    assert.match(parcial, /663 de 800 ficheiros analisados, sem ameaças encontradas/);
  });

  test("log terminal: ameaças com singular/plural correctos", () => {
    assert.match(terminalScanLogMessage({ status: "completed", filesScanned: 5, filesAnalyzed: 5, threatsFound: 1 }), /1 ameaça encontrada\b/);
    assert.doesNotMatch(terminalScanLogMessage({ status: "completed", filesScanned: 5, filesAnalyzed: 5, threatsFound: 1 }), /1 ameaças/);
    assert.match(terminalScanLogMessage({ status: "completed", filesScanned: 5, filesAnalyzed: 5, threatsFound: 3 }), /3 ameaças encontradas/);
    assert.match(terminalScanLogMessage({ status: "completed", filesScanned: 5, filesAnalyzed: 5, threatsFound: 0 }), /sem ameaças encontradas/);
  });

  test("log terminal: cancelado e falhado", () => {
    assert.match(terminalScanLogMessage({ status: "cancelled", filesScanned: 1, filesAnalyzed: 1, threatsFound: 0 }), /Análise cancelada: 1 ficheiro analisado\b/);
    assert.doesNotMatch(terminalScanLogMessage({ status: "cancelled", filesScanned: 1, filesAnalyzed: 1, threatsFound: 0 }), /1 ficheiros/);
    assert.match(terminalScanLogMessage({ status: "failed", filesScanned: 0, threatsFound: 0, error: "x" }), /Análise falhada: x/);
  });

  test("rodapé de falhas/exclusões sem 'ficheiro(s)' e com verbo conjugado", () => {
    assert.equal(filesFailedFooterLabel(1), "1 ficheiro não pôde ser analisado");
    assert.equal(filesFailedFooterLabel(4), "4 ficheiros não puderam ser analisados");
    assert.equal(filesExcludedFooterLabel(1), "1 ficheiro ignorado por exclusões");
    assert.equal(filesExcludedFooterLabel(9), "9 ficheiros ignorados por exclusões");
    assert.doesNotMatch(filesFailedFooterLabel(1), /\(s\)/);
    assert.doesNotMatch(filesExcludedFooterLabel(1), /\(s\)/);
  });
});
