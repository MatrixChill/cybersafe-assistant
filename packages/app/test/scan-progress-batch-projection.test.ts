import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ScanState } from "@cybersafe/shared-types";
import {
  mergeScanState,
  normalizeScanState,
  scanAnalysisStage,
  scanProgressPercent,
  scanRateLabel,
  terminalScanLogMessage,
} from "../src/lib/scanSession";

/**
 * Payload CANÓNICO de um scan profundo a meio do batch do ClamAV, tal como o
 * serviço o publica (scan-manager.ts:397-401).
 *
 * O que o motor escreve durante o batch é `filesAnalyzed` (a contagem das
 * linhas que o clamscan vai emitindo) e `filesInEngineBatch`. `filesScanned`
 * só é escrito no ciclo ficheiro-a-ficheiro (scan-manager.ts:476), que ainda
 * não começou — por isso é 0 enquanto 512 ficheiros já foram analisados.
 *
 * ── DOIS EIXOS, NAO UM ────────────────────────────────────────────────────
 * A barra mostra CONCLUSAO DO PIPELINE (`filesScanned / filesTotal`) e a etapa
 * de assinaturas tem o seu proprio eixo (`scanAnalysisStage`, derivado de
 * `filesInEngineBatch` + `filesAnalyzed`). Somar ou maximizar os dois eixos
 * numa so percentagem foi o que prendia a barra em 728/800.
 */
const BATCH_EVENT = {
  id: "scan-batch-1",
  type: "full",
  status: "running",
  phase: "scanning",
  progress: 64,
  filesTotal: 800,
  filesDiscovered: 800,
  filesScanned: 0,
  filesAnalyzed: 512,
  filesInEngineBatch: 765,
  filesExcluded: 35,
  filesFailed: 0,
  threatsFound: 0,
  revision: 41,
  updatedAt: "2026-10-06T10:00:20.000Z",
  startTime: "2026-10-06T10:00:00.000Z",
};

function stateOf(overrides: Partial<ScanState> = {}): ScanState {
  const state = normalizeScanState({ ...BATCH_EVENT, ...overrides });
  assert.ok(state, "o payload canónico tem de normalizar");
  return state;
}

describe("scanner: projeção do progresso real do batch do motor", () => {
  test("não reescreve os contadores brutos do contrato", () => {
    const state = stateOf();
    assert.equal(state.filesScanned, 0);
    assert.equal(state.filesAnalyzed, 512);
    assert.equal(state.filesTotal, 800);
    assert.equal(state.filesInEngineBatch, 765);
  });

  test("a barra NAO mostra o batch: o pipeline tem 0 ficheiros fechados", () => {
    // CONTRATO DE DOIS EIXOS. A versao anterior deste teste exigia 64 aqui, e
    // era essa a mentira: 728 veredictos do motor de assinaturas nao sao 728
    // pipelines concluidos. Apresenta-los na barra fazia-a chegar a ~91% ANTES
    // de o primeiro ficheiro passar pelos restantes motores, e depois ficava
    // presa ai durante toda a segunda passagem (MEDIDO pelo humano: barra
    // parada em 728/800).
    assert.equal(
      scanProgressPercent(stateOf()),
      0,
      "nenhum ficheiro fechou o pipeline, logo a barra global tem de estar a 0",
    );
    // O trabalho real do batch continua visivel, mas no eixo DELE.
    assert.deepEqual(scanAnalysisStage(stateOf()), {
      active: true,
      done: 512,
      total: 765,
      percent: 66,
    });
  });

  test("o denominador é o total selecionado (800), nunca o batch do motor (765)", () => {
    const state = stateOf({ filesTotal: undefined });
    assert.equal(state.filesTotal, undefined);
    assert.equal(state.filesInEngineBatch, 765);
    assert.equal(scanProgressPercent(state), null);
  });

  test("um cancelamento a meio do batch não afirma 0 ficheiros analisados", () => {
    const state = stateOf({ status: "cancelled", endTime: "2026-10-06T10:00:30.000Z" });
    assert.match(terminalScanLogMessage(state), /512 ficheiros analisados/);
  });

  test("o plural honesto quando o batch analisou um único ficheiro", () => {
    const state = stateOf({ status: "cancelled", filesAnalyzed: 1, filesInEngineBatch: 1 });
    assert.match(terminalScanLogMessage(state), /1 ficheiro analisado/);
  });

  test("nada analisado = nada projetado (nem percentagem nem frase inventadas)", () => {
    const state = stateOf({ filesAnalyzed: 0 });
    assert.equal(scanProgressPercent(state), 0);
    assert.match(terminalScanLogMessage(stateOf({ status: "cancelled", filesAnalyzed: 0 })), /^Análise cancelada: 0 ficheiros analisados$/);
  });

  test("gathering continua sem percentagem", () => {
    assert.equal(scanProgressPercent(stateOf({ phase: "gathering", filesAnalyzed: 0 })), null);
  });

  test("concluído: a barra fecha com filesScanned, o LOG diz analisados de considerados", () => {
    const state = stateOf({
      status: "completed",
      progress: 100,
      filesScanned: 800,
      filesAnalyzed: 765,
      filesInEngineBatch: 0,
      endTime: "2026-10-06T10:05:00.000Z",
    });
    // A barra é o PIPELINE (inclui os excluídos) — 800 fecharam o ciclo.
    assert.equal(scanProgressPercent(state), 100);
    // A frase é a COBERTURA DOS MOTORES: 765 chegaram aos motores, 800 foram
    // considerados. Dizer "800 ficheiros analisados" apresentava 35 ficheiros
    // ignorados pelas exclusões como verificados.
    assert.match(terminalScanLogMessage(state), /Análise concluída: 765 de 800 ficheiros analisados, sem ameaças encontradas/);
    // A frase NUNCA pode começar por afirmar 800 analisados (os 35 ignorados
    // pelas exclusões apareciam como verificados). O teste olha para a posição,
    // não para a substring — "765 de 800 ficheiros analisados" contém "800
    // ficheiros analisados" sem o afirmar.
    assert.doesNotMatch(terminalScanLogMessage(state), /Análise concluída: 800 ficheiros analisados/);
  });

  test("a velocidade não é inventada enquanto o motor não a mediu", () => {
    const state = stateOf();
    assert.equal(state.filesPerSecond, undefined);
    assert.equal(scanRateLabel(state), "—");
  });

  test("um estado de outro scan não herda a projeção do anterior", () => {
    const batch = stateOf();
    const outro = stateOf({ id: "scan-batch-2", filesAnalyzed: 3, filesInEngineBatch: 4 });
    assert.notEqual(batch.id, outro.id);
    assert.equal(mergeScanState(batch, outro), outro);
    assert.equal(scanProgressPercent(mergeScanState(batch, outro)), 0);
  });
});
