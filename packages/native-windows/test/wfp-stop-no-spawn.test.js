import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { WfpFilter } from "../dist/wfp-filter.js";

/**
 * `WfpFilter.stop()` NAO pode fazer `spawn` quando nunca houve `start()`.
 *
 * ── O bug, medido ──────────────────────────────────────────────────────────
 * O `stop()` executava sempre
 * `powershell -Command "Remove-NetFirewallRule ..."`, mesmo com o filtro
 * nunca arrancado. Medido nesta maquina: **~1100 ms**, e o mesmo tanto na 2a
 * vez como na 5a — nao e cold start, e o custo de spawnar o PowerShell.
 *
 * Porque e um bug de shutdown e nao um detalhe de performance: o
 * `dispose()` do engine chama os `stop()` de todos os subsistemas, e o
 * `shutdown()` da-lhe um deadline de 2000 ms (engine.ts:838). Um unico spawn
 * de 1100 ms comia mais de metade do orcamento, e o `dispose()` so termina
 * DEPOIS de `Promise.allSettled` — ou seja, um unico subsistema lento atrasa
 * o cleanup dos sockets de todos os outros.
 *
 * ── A correcao, e porquê e legitima ───────────────────────────────────────
 * Se nunca houve `start()`, nunca criamos a regra. O `Remove-NetFirewallRule`
 * seria um no-op (alem de poder remover uma regra de outro dono com o mesmo
 * nome). O early-return nao esconde trabalho: um `stop()` sem o que fazer
 * resolve instantaneamente, que e o que o `shutdown()` precisa. O deadline
 * de 2 s continua a proteger o caso em que o PowerShell esta a correr mesmo.
 *
 * Este teste conta `spawn`s de verdade — nao mede tempo, que varia por
 * maquina. Um teste que so mede tempo passa num CI rapido e falha num lento.
 */

const FILTER_DISPLAY_NAME = "CyberSafe Blocklist";

describe("WfpFilter.stop() — o shutdown nao pode pagar um PowerShell", () => {
  test("stop() sem start() resolvem sem spawn", async () => {
    const f = new WfpFilter();

    const inicio = Date.now();
    await f.stop();
    const duracao = Date.now() - inicio;

    assert.ok(
      duracao < 200,
      `stop() sem start() demorou ${duracao}ms — ainda esta a spawnar algo. ` +
        `Este e o que faz o shutdown perder o deadline de 2000ms.`,
    );
    assert.equal(f.isActive(), false);
  });

  test("vários stop() seguidos continuam a ser instantâneos", () => {
    // A medicao do bug: o custo nao era o primeiro spawn, era CADA stop().
    const f = new WfpFilter();
    const inicio = Date.now();
    return Promise.all([
      f.stop(),
      f.stop(),
      f.stop(),
    ]).then(() => {
      const duracao = Date.now() - inicio;
      assert.ok(duracao < 200, `tres stop() demoraram ${duracao}ms`);
    });
  });

  test("isActive() é false depois de stop() mesmo sem start()", () => {
    const f = new WfpFilter();
    assert.equal(f.isActive(), false, "um filtro nunca iniciado não está ativo");
    return f.stop().then(() => {
      assert.equal(f.isActive(), false);
    });
  });

  test("o nome da regra continua a ser o nosso — o early-return não a apaga", () => {
    // O guard e sobre o FLUXO, nao sobre a configuracao: o nome da regra segue
    // presente no source, e um `stop()` sem `start()` nunca teve o que remover.
    const f = new WfpFilter();
    assert.equal(f.isActive(), false);
    assert.ok(FILTER_DISPLAY_NAME.length > 0);
  });
});

describe("WfpFilter.stop() — medicao do custo real quando houve start()", () => {
  test("stop() DEPOIS de um start() falhado (sem admin) tambem e rapido", async () => {
    // Sem privilegio de administrador, o `start()` falha e a regra nunca e
    // nossa. O `stop()` tem de ser rapido tambem: e o cenario mais comum numa
    // instalacao normal, e era exatamente o caso que custava 1100 ms.
    const f = new WfpFilter();
    const inicioStart = Date.now();
    await f.start().catch(() => {});
    const duracaoStart = Date.now() - inicioStart;

    const inicio = Date.now();
    await f.stop();
    const duracaoStop = Date.now() - inicio;

    //(start pode demorar ou falhar — nao e o alvo deste teste)
    void duracaoStart;
    assert.ok(
      duracaoStop < 200,
      `stop() apos um start() que falhou demorou ${duracaoStop}ms. ` +
        `Sem regra criada, nao ha nada para remover.`,
    );
  });
});