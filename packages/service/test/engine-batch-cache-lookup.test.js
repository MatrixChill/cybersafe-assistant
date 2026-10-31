import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ProtectionEngineService } from "../dist/engine.js";

/**
 * P0 SCANNER_728_OF_800 — A IDENTIDADE DO FICHEIRO NO CACHE DO BATCH.
 *
 * O cache do prefetch é o que impede o Quick Scan de voltar a correr o ClamAV
 * para os 728 ficheiros que o batch já avaliou. Isso só é verdade se o lookup
 * encontrar, para cada ficheiro pedido, o veredicto que o batch guardou — e o
 * batch guarda-o por uma chave NORMALIZADA (`prefetchKey`), porque o mesmo
 * ficheiro chega escrito de formas diferentes conforme a origem: o gather do
 * ScanManager devolve separadores do sistema, e o caminho pode voltar com
 * barras à frente ou com maiúsculas diferentes.
 *
 * ── A ARMADILHA ───────────────────────────────────────────────────────────
 * Um teste que fizesse `prefetchClamav(files)` e depois
 * `clamavOutcomeFor(files[0], scanId)` com a MESMA string passaria mesmo com a
 * normalização partida: comparava a string consigo própria. Aqui o pedido e o
 * lookup usam grafias DIFERENTES do mesmo caminho, que é o que o runtime faz
 * de verdade.
 *
 * NOTA DE FIXTURE: os caminhos são compostos com `BS` (`String.fromCharCode(92)`)
 * em vez de barras invertidas literais. Uma barra invertida dentro de um
 * literal de string atravessa camadas de quoting (shell, heredoc, editor) e
 * chega ao ficheiro já colapsada — o fixture passaria a ser `C:QuarentenaAmostra.exe`,
 * que não é um caminho, e o teste media outra coisa sem avisar.
 *
 * ── SEM CLAMSCAN E SEM init() ─────────────────────────────────────────────
 * O bridge é injectado (só o `scanFiles` do batch é chamado) e o motor NUNCA
 * faz `init()`: nenhum watcher/ETW/WFP arranca, nenhum clamscan é lançado, e o
 * teste é determinístico.
 */

/** Barra invertida sem literal: sobrevive a qualquer camada de quoting. */
const BS = String.fromCharCode(92);
const cam = (...partes) => `C:${BS}${partes.join(BS)}`;

/** Bridge mínimo: devolve um veredicto terminal por ficheiro pedido, sem tocar no disco. */
function bridgeFalso() {
  const calls = [];
  return {
    calls,
    async scanFiles(filePaths) {
      calls.push([...filePaths]);
      return {
        files: filePaths.map((file) => ({ file, verdict: "clean", detail: "bridge de teste" })),
        status: { status: "ok", detail: "" },
      };
    },
    async scanFile() {
      throw new Error("o cache devia ter evitado este scanFile — nenhum clamscan real pode correr aqui");
    },
  };
}

function novoMotor(bridge) {
  // baseDir num tmpdir isolado: nada é escrito no runtime do utilizador.
  const engine = new ProtectionEngineService(process.env.TEMP ?? process.env.TMP);
  engine.clamav = bridge;
  return engine;
}

describe("engine: o cache do batch resolve o ficheiro por identidade normalizada", () => {
  it("um caminho escrito de outra forma continua a encontrar o veredicto do batch", async () => {
    const bridge = bridgeFalso();
    const engine = novoMotor(bridge);

    const guardado = cam("Quarentena", "Amostra.EXE");
    await engine.prefetchClamav([guardado], "scan-1");
    assert.equal(bridge.calls.length, 1, "o batch tem de ter corrido uma só vez");

    const grafias = [
      guardado, // igual
      cam("Quarentena", "Amostra.EXE"), // igual, segunda instância
      "C:/Quarentena/Amostra.EXE", // separadores à frente
      "c:/quarentena/amostra.exe", // separadores + minúsculas
      cam("quarentena", "AMOSTRA.exe"), // maiúsculas trocadas
    ];

    for (const grafia of grafias) {
      const cached = engine.clamavOutcomeFor(grafia, "scan-1");
      assert.ok(
        cached,
        `a grafia ${JSON.stringify(grafia)} não encontrou o veredicto de ${JSON.stringify(guardado)}`,
      );
      assert.equal(cached.verdict, "clean");
    }

    // A pré-condição que separa este teste de um falso positivo: as grafias
    // NÃO são todas a mesma string.
    assert.notEqual(grafias[0], grafias[2], "o fixture perdeu os separadores: o teste media igualdade exacta");
  });

  it("o veredicto pertence a UM dono: outro scanId e a ausência de scanId não o vêem", async () => {
    const bridge = bridgeFalso();
    const engine = novoMotor(bridge);
    const b = cam("tmp", "b.txt");
    await engine.prefetchClamav([b], "scan-1");

    assert.ok(engine.clamavOutcomeFor(b, "scan-1"), "o dono tem de ver o veredicto");
    assert.equal(engine.clamavOutcomeFor(b, "scan-2"), undefined, "outro scan não herda o batch");
    assert.equal(
      engine.clamavOutcomeFor(b, undefined),
      undefined,
      "sem scanId não há dono a nomear: nunca se adivinha",
    );
    assert.equal(engine.clamavOutcomeFor(cam("tmp", "outro.txt"), "scan-1"), undefined, "ficheiro fora do batch");

    assert.equal(engine.isAlreadyCachedScanArtifact(b, "dashboard", { scanId: "scan-1" }), true);
    assert.equal(engine.isAlreadyCachedScanArtifact(b, "dashboard", { scanId: "scan-2" }), false);
    assert.equal(engine.isAlreadyCachedScanArtifact(b, "dashboard", undefined), false);
  });

  it("limpar só liberta o dono nomeado; sem id limpa todos", async () => {
    const bridge = bridgeFalso();
    const engine = novoMotor(bridge);
    const a = cam("tmp", "a.txt");
    const c = cam("tmp", "c.txt");
    await engine.prefetchClamav([a], "scan-1");
    await engine.prefetchClamav([c], "scan-2");

    engine.clearClamavPrefetch("scan-1");
    assert.equal(engine.clamavOutcomeFor(a, "scan-1"), undefined, "o dono limpo ficou vivo");
    assert.ok(engine.clamavOutcomeFor(c, "scan-2"), "limpar um scan tocou no outro");

    engine.clearClamavPrefetch();
    assert.equal(engine.clamavOutcomeFor(c, "scan-2"), undefined);
  });

  it("um batch vazio não instala dono nenhum", async () => {
    const bridge = bridgeFalso();
    const engine = novoMotor(bridge);
    const r = await engine.prefetchClamav([], "scan-1");
    assert.equal(r.spawned, false);
    assert.equal(bridge.calls.length, 0, "um batch sem ficheiros não pode lançar clamscan");
    assert.equal(engine.clamavPrefetches.get("scan-1"), undefined);
  });
});
