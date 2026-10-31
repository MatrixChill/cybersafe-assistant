import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ScanState } from "@cybersafe/shared-types";
import {
  normalizeScanState,
  scanAnalysisStage,
  scanProgressPercent,
} from "../src/lib/scanSession";

/**
 * P0 SCANNER_728_OF_800 — O PROGRESSO TEM DOIS EIXOS, NAO UM.
 *
 * O sintoma MEDIDO pelo humano no runtime: depois do batch do ClamAV a barra
 * ficava parada em 728/800 durante toda a segunda passagem, e o contador de
 * "ficheiros analisados" nunca se mexia. Porquê: o batch dá 728 veredictos de
 * assinaturas, mas o `ScanManager` só escreve `filesScanned` no ciclo
 * ficheiro-a-ficheiro — e a UI mostrava `max(filesScanned, filesAnalyzed)`.
 * Com `filesAnalyzed` preso em 728 e `filesScanned` a subir de 0, o máximo era
 * 728 até o loop o ultrapassar quase no fim.
 *
 * A resolução não é escolher "o maior dos dois": são DOIS factos diferentes e
 * cada um tem o seu eixo.
 *
 *   - EIXO GLOBAL (a barra): `scanProgressPercent` = ficheiros que fecharam o
 *     pipeline (`filesScanned / filesTotal`). Um veredicto do ClamAV é UMA
 *     etapa, logo NÃO conta aqui. Marcar 728 como pipeline-concluídos era
 *     apresentar conclusão prematura.
 *   - EIXO DA ETAPA (o batch): `scanAnalysisStage`, derivado de
 *     `filesInEngineBatch` (a dimensão do batch) e `filesAnalyzed` (o que o
 *     clamscan já reportou). É trabalho real e tem de continuar visível.
 *
 * ── A ARMADILHA ───────────────────────────────────────────────────────────
 * Um teste que só afirmasse `filesAnalyzed > 0` durante o batch passaria com a
 * barra presa. Por isso aqui as duas asserções são simultâneas no mesmo
 * payload: o eixo global tem de estar a 0 E o eixo da etapa tem de mostrar o
 * trabalho real. Nenhum dos dois é inventado a partir do outro.
 */

/** Payload canónico de um scan a meio do batch do ClamAV (como o serviço o publica). */
const MID_BATCH = {
  id: "scan-two-axis-1",
  type: "full",
  status: "running",
  phase: "scanning",
  progress: 0,
  filesTotal: 800,
  filesDiscovered: 800,
  filesScanned: 0,
  filesAnalyzed: 512,
  filesInEngineBatch: 765,
  filesExcluded: 0,
  filesFailed: 0,
  threatsFound: 0,
  revision: 41,
  updatedAt: "2026-10-08T10:00:20.000Z",
  startTime: "2026-10-08T10:00:00.000Z",
};

function stateOf(overrides: Partial<ScanState> = {}): ScanState {
  const state = normalizeScanState({ ...MID_BATCH, ...overrides });
  assert.ok(state, "o payload canónico tem de normalizar");
  return state;
}

describe("scanner: o pipeline e a etapa de assinaturas são eixos separados", () => {
  test("mid-batch: barra a 0 (nada fechou o pipeline) e etapa a 66% (o motor trabalhou)", () => {
    const state = stateOf();

    assert.equal(
      scanProgressPercent(state),
      0,
      "nenhum ficheiro fechou o pipeline, logo a barra global não pode afirmar 64%",
    );

    assert.deepEqual(
      scanAnalysisStage(state),
      { active: true, done: 512, total: 765, percent: 66 },
      "o trabalho do batch tem de continuar visível, no eixo dele",
    );
  });

  test("segunda passagem: a barra segue filesScanned e já não fica presa em 728/800", () => {
    // O caso exacto do bug: batch terminado (filesInEngineBatch 0), 728
    // ficheiros já cobertos pelas assinaturas, e o ciclo por ficheiro a correr.
    const state = stateOf({
      filesInEngineBatch: 0,
      filesAnalyzed: 728,
      filesScanned: 300,
      filesTotal: 800,
    });

    assert.equal(
      scanProgressPercent(state),
      37,
      "a barra tem de seguir o pipeline (300/800), não a cobertura do batch (728/800)",
    );
    assert.equal(scanAnalysisStage(state).active, false, "não há batch a correr");
  });

  test("terminal: 100% e etapa inactiva", () => {
    const state = stateOf({
      status: "completed",
      progress: 100,
      filesInEngineBatch: 0,
      filesScanned: 800,
      filesAnalyzed: 734,
      filesExcluded: 66,
      endTime: "2026-10-08T10:05:00.000Z",
    });

    assert.equal(scanProgressPercent(state), 100);
    assert.equal(scanAnalysisStage(state).active, false);
  });

  test("nada fechado = nada afirmado (0%, e nunca uma etapa inventada)", () => {
    const state = stateOf({ filesInEngineBatch: 0, filesAnalyzed: 0, filesScanned: 0 });
    assert.equal(scanProgressPercent(state), 0);
    assert.deepEqual(scanAnalysisStage(state), {
      active: false,
      done: 0,
      total: 0,
      percent: null,
    });
  });
});

describe("scanner: a etapa não inventa números", () => {
  test("a dimensão da etapa é o batch (765), nunca o total selecionado (800)", () => {
    const stage = scanAnalysisStage(stateOf());
    assert.equal(stage.total, 765);
    assert.notEqual(stage.total, stateOf().filesTotal);
  });

  test("done nunca ultrapassa o batch, mesmo que filesAnalyzed venha maior", () => {
    // filesAnalyzed é do eixo da cobertura e pode chegar acima do batch (o
    // `analisadosNoBatch` reconcilia para cima). A etapa não pode mostrar >100%.
    const stage = scanAnalysisStage(stateOf({ filesInEngineBatch: 10, filesAnalyzed: 99 }));
    assert.equal(stage.done, 10);
    assert.equal(stage.percent, 100);
  });

  test("sem denominador real a barra fica indeterminada, mas a etapa continua honesta", () => {
    const state = stateOf({ filesTotal: undefined });
    assert.equal(state.filesTotal, undefined);
    assert.equal(scanProgressPercent(state), null, "o denominador é o total selecionado, nunca o batch");
    assert.equal(scanAnalysisStage(state).percent, 66);
  });

  test("sem estado não há percentagem nem etapa", () => {
    assert.equal(scanProgressPercent(null), null);
    assert.deepEqual(scanAnalysisStage(null), {
      active: false,
      done: 0,
      total: 0,
      percent: null,
    });
  });
});

describe("scanner: a barra global é monotónica durante um scan real", () => {
  test("batch 0->765 e depois o ciclo por ficheiro 1->800: nunca recua e termina a 100", () => {
    const sequencia: number[] = [];

    // 1) Batch do ClamAV a crescer. O eixo global NÃO pode mexer-se aqui.
    for (const n of [0, 1, 128, 512, 765]) {
      sequencia.push(scanProgressPercent(stateOf({ filesAnalyzed: n })) ?? -1);
    }

    // 2) Batch terminado; o ciclo por ficheiro fecha os 800.
    for (const n of [1, 4, 100, 300, 728, 799, 800]) {
      sequencia.push(
        scanProgressPercent(
          stateOf({
            filesInEngineBatch: 0,
            filesAnalyzed: 728,
            filesScanned: n,
            progress: Math.floor((n / 800) * 100),
          }),
        ) ?? -1,
      );
    }

    for (let i = 1; i < sequencia.length; i++) {
      assert.ok(
        sequencia[i] >= sequencia[i - 1],
        `a barra global recuou: ${sequencia[i - 1]} -> ${sequencia[i]}`,
      );
    }
    assert.equal(sequencia[sequencia.length - 1], 100, "um scan completo termina a 100%");
  });

  test("o eixo da etapa também nunca recua enquanto o batch corre", () => {
    let anterior = -1;
    for (const n of [0, 1, 64, 256, 512, 765]) {
      const pct = scanAnalysisStage(stateOf({ filesAnalyzed: n })).percent ?? 0;
      assert.ok(pct >= anterior, `a etapa recuou: ${anterior} -> ${pct}`);
      anterior = pct;
    }
    assert.equal(anterior, 100);
  });
});
