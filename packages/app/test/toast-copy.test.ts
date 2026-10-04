import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as toastCopy from "../src/lib/toastCopy";
import { toastTypeLabel } from "../src/lib/toastCopy";

/**
 * O `toastTypeLabel` mapeia a CHAVE TECNICA do evento (`threat.detected`) para
 * o rotulo pt-PT que o utilizador le. Isto nao e traducao de copy: o service
 * nunca mandou um rotulo legivel para este campo, mandou um identificador de
 * evento. A distincao importa — e a razao de este ficheiro se manter.
 *
 * O `translateToastSummary` foi REMOVIDO. Traduzia tres strings em ingles
 * ("Threat detected in X", "Blocked malicious script execution (app)",
 * "Blocked process by path: X") que o engine ja nao emite: passou a publicar
 * PT-PT em engine.ts:652, :758 e :1114, e o `service-copy.test.js` proibe
 * explicitamente que voltem. Um ficheiro de testes que provava a traducao de
 * texto que nao existe e um teste verde sobre uma maquina sem motor: passa,
 * e nao prova nada.
 *
 * O guard que substitui essa prova e o `toast-engine-contract.test.ts`: le o
 * engine.ts real e falha se alguma vez um summary voltar a precisar de traducao.
 * A correcao, nesse dia, e no service — nunca nesta camada.
 *
 * Ver tambem: `packages/service/test/service-copy.test.js` (proibicoes no
 * emissor) e `packages/app/test/task-kill-flow.test.ts` (tipos que disparam
 * toast).
 */
describe("toastTypeLabel — rotulos pt-PT das chaves de evento", () => {
  test("os tipos que disparam toast têm rotulo portugues", () => {
    assert.equal(toastTypeLabel("threat.detected"), "Ameaça detetada");
    assert.equal(toastTypeLabel("process.blocked"), "Processo bloqueado");
  });

  test("nenhum rotulo contem brasileiro proibido", () => {
    for (const label of [toastTypeLabel("threat.detected"), toastTypeLabel("process.blocked")]) {
      assert.equal(/detectada/i.test(label), false, `grafia pt-BR/AO90 antiga: ${label}`);
      assert.equal(/registrad/i.test(label), false, label);
    }
  });

  test("tipo desconhecido nao e traduzido a forca", () => {
    // Um evento que a UI nao conhece mostra a chave tecnica, nao um rotulo
    // inventado. Inventar um rotulo para um evento que nao conhecemos seria
    // fabricar um diagnostico — o mesmo erro de que `engineStatusText` foi
    // absolvido.
    assert.equal(toastTypeLabel("weird.event"), "weird.event");
  });

  test("a camada de traducao de summary nao existe mais", () => {
    // Este teste e o que impede a traducao de voltar a ser re-introduzida em
    // silencio. Sem ele, reintroduzir os padroes em src/lib/toastCopy.ts seria
    // um diff de dez linhas que ninguem notaria — e voltavamos a duplicar a
    // copy do service. Ver toast-engine-contract.test.ts para a prova viva de
    // que a copy ja vem certa do outro lado.
    assert.equal(
      Object.hasOwn(toastCopy, "translateToastSummary"),
      false,
      "translateToastSummary voltou: o service ja fala PT-PT e a copy duplica-se",
    );
  });
});