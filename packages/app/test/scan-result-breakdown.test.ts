import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ScanState } from "@cybersafe/shared-types";
import {
  excludedReasonsLabel,
  normalizeScanState,
  scanResultBreakdown,
  scanResultBreakdownNote,
} from "../src/lib/scanSession";

/**
 * P0 SCANNER — A PERGUNTA DO UTILIZADOR: "SE SÃO 800 E SÓ 663 SEM DETEÇÕES,
 * O QUE ACONTECEU AOS 137?"
 *
 * MEDIDO no computador do utilizador (probe read-only sobre os alvos reais do
 * Quick Scan, 10/10/2026, 168 s):
 *
 *     selected=800  candidates=640  excluded=151  zip=9
 *     filesScanned=800  filesAnalyzed=649  filesExcluded=151  filesFailed=0
 *     identidade: scanned = analyzed + excluded + failed  ->  TRUE
 *
 * O gap NÃO é uma categoria escondida: são ficheiros ignorados pela política de
 * exclusões (.tmp/.log/.cache/.bak/.dat e as pastas internas do CyberSafe) que
 * nunca chegaram a motor nenhum, e que a UI apresentava como "verificados".
 *
 * Este teste fixa as três propriedades que impedem a repetição do defeito:
 *  1. os números do cartão são categorias distintas (considerados ≠ analisados);
 *  2. a soma FECHA (e, quando não fecha, o produto di-lo em vez de inventar);
 *  3. o PORQUÊ vem do motor e nunca expõe caminhos do utilizador.
 */

/** Payload canónico no fim de uma análise concluída com exclusões. */
const COMPLETED = {
  id: "scan-breakdown-1",
  type: "quick",
  status: "completed",
  phase: "finalizing",
  progress: 100,
  filesTotal: 800,
  filesDiscovered: 800,
  filesScanned: 800,
  filesProcessed: 800,
  filesAnalyzed: 663,
  filesInconclusive: 0,
  filesInEngineBatch: 0,
  filesExcluded: 137,
  filesFailed: 0,
  filesExcludedBy: [
    { reason: "extension", detail: ".log", count: 120 },
    { reason: "extension", detail: ".tmp", count: 15 },
    { reason: "path", count: 2 },
  ],
  threatsFound: 0,
  revision: 90,
  updatedAt: "2026-10-10T20:00:00.000Z",
  startTime: "2026-10-10T19:56:55.000Z",
  endTime: "2026-10-10T20:00:00.000Z",
};

function stateOf(overrides: Partial<ScanState> = {}): ScanState {
  const state = normalizeScanState({ ...COMPLETED, ...overrides });
  assert.ok(state, "payload de teste tem de normalizar");
  return state;
}

describe("decomposição do resultado — os 800 e os 663 do utilizador", () => {
  test("considerados, analisados e não analisados são categorias distintas", () => {
    const breakdown = scanResultBreakdown(stateOf());
    assert.ok(breakdown);
    assert.equal(breakdown.considered, 800, "800 candidatos considerados");
    assert.equal(breakdown.analyzed, 663, "663 chegaram aos motores");
    assert.equal(breakdown.notAnalyzed, 137, "137 não foram analisados");
    assert.equal(breakdown.excluded, 137);
    assert.equal(breakdown.failed, 0);
    assert.equal(breakdown.withoutDetections, 663);
    assert.equal(breakdown.reconciled, true, "663 + 137 + 0 = 800");
  });

  test("a nota explica os 137 com o motivo real vindo do motor", () => {
    const note = scanResultBreakdownNote(scanResultBreakdown(stateOf())!, "completed");
    assert.equal(
      note,
      "Dos 800 ficheiros considerados, 663 foram analisados pelos motores e 137 não: 137 ficheiros ignorados por exclusões — extensões de cache/temporários (.log, .tmp), pastas internas do próprio CyberSafe.",
    );
  });

  test("inconclusivos não entram na contagem de ficheiros sem deteções", () => {
    const breakdown = scanResultBreakdown(stateOf({ filesInconclusive: 2 }));
    assert.ok(breakdown);
    assert.equal(breakdown.withoutDetections, 661);
    assert.equal(breakdown.reconciled, true, "inconclusivos são uma subcontagem de analisados");
  });

  test("sem contagem de inconclusivos, o total sem deteções é desconhecido", () => {
    const state = normalizeScanState({ ...COMPLETED, filesInconclusive: undefined });
    assert.ok(state);
    assert.equal(scanResultBreakdown(state)!.withoutDetections, null);
  });

  test("a decomposição medida no probe real (800 = 649 + 151 + 0) também fecha", () => {
    const breakdown = scanResultBreakdown(
      stateOf({ filesAnalyzed: 649, filesExcluded: 151, filesFailed: 0 }),
    )!;
    assert.equal(breakdown.analyzed + breakdown.excluded + breakdown.failed, breakdown.considered);
    assert.equal(breakdown.reconciled, true);
  });

  test("sem nada a explicar, não há nota (não se inventa um resto)", () => {
    const state = stateOf({
      filesAnalyzed: 800,
      filesExcluded: 0,
      filesFailed: 0,
      filesExcludedBy: [],
    });
    const breakdown = scanResultBreakdown(state)!;
    assert.equal(breakdown.notAnalyzed, 0);
    assert.equal(scanResultBreakdownNote(breakdown, "completed"), null);
  });

  test("se a soma não fechar, a UI DIZ isso em vez de tapar o buraco", () => {
    // Cenário detetado pelo teste dois-eixos: o motor de assinaturas reporta um
    // número que o pipeline não fecha (663 + 137 = 800 mas o declarado é 900).
    const state = stateOf({ filesAnalyzed: 663, filesExcluded: 137, filesScanned: 900, filesTotal: 900 });
    const breakdown = scanResultBreakdown(state)!;
    assert.equal(breakdown.reconciled, false);
    const note = scanResultBreakdownNote(breakdown, "completed")!;
    assert.match(note, /decomposição não fecha/);
    assert.match(note, /Reporta isto/);
  });

  test("análise interrompida não afirma uma decomposição completa", () => {
    const state = stateOf({
      status: "cancelled",
      filesTotal: 200,
      filesDiscovered: 200,
      filesScanned: 124,
      filesAnalyzed: 120,
      filesExcluded: 3,
      filesFailed: 1,
      filesExcludedBy: [],
      endTime: "2026-10-10T19:58:00.000Z",
    });
    const breakdown = scanResultBreakdown(state)!;
    assert.equal(breakdown.withoutDetections, null, "cancelada nunca dá 'sem deteções'");
    assert.equal(breakdown.reconciled, false);
    assert.match(
      scanResultBreakdownNote(breakdown, "cancelled")!,
      /não chegou ao fim: 120 ficheiros foram analisados de 200 considerados/,
    );
  });

  test("sem estado do motor não há decomposição a afirmar", () => {
    assert.equal(scanResultBreakdown(null), null);
    assert.equal(scanResultBreakdown(stateOf({ filesTotal: undefined, filesScanned: 0 })), null);
  });
});

describe("motivo das exclusões — simples, verificável e sem caminhos do utilizador", () => {
  test("agrupa extensões, nomes e pastas internas", () => {
    const label = excludedReasonsLabel([
      { reason: "extension", detail: ".log", count: 5 },
      { reason: "extension", detail: ".tmp", count: 2 },
      { reason: "filename", detail: "desktop.ini", count: 1 },
      { reason: "path", count: 3 },
    ]);
    assert.equal(
      label,
      "extensões de cache/temporários (.log, .tmp), nomes excluídos (desktop.ini), pastas internas do próprio CyberSafe",
    );
  });

  test("uma exclusão por caminho nunca transporta o caminho", () => {
    const label = excludedReasonsLabel([{ reason: "path", count: 4 }])!;
    assert.equal(label, "pastas internas do próprio CyberSafe");
    assert.doesNotMatch(label, /[A-Za-z]:\\/, "nenhum caminho absoluto pode aparecer");
    assert.doesNotMatch(label, /Users/i);
  });

  test("sem exclusões não há motivo nenhum a mostrar", () => {
    assert.equal(excludedReasonsLabel([]), null);
  });
});

describe("o cartão não pode voltar a chamar 'verificados' ao que não foi verificado", () => {
  const FORBIDDEN = [/verificad/i, /ficheiros seguros/i, /100% seguro/i];

  test("nem a nota nem o motivo afirmam verificação ou segurança", () => {
    const breakdown = scanResultBreakdown(stateOf())!;
    const texts = [
      scanResultBreakdownNote(breakdown, "completed")!,
      excludedReasonsLabel(breakdown.excludedBy)!,
    ];
    for (const text of texts) {
      for (const forbidden of FORBIDDEN) {
        assert.equal(forbidden.test(text), false, `frase proibida em: ${text}`);
      }
    }
  });
});
