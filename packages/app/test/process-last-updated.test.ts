/**
 * P1-PROCESS-TRUTH BUG C — a segunda marca de frescura.
 *
 * O painel «Segurança Empresarial» mostra «Atualizado hh:mm:ss». Antes da
 * correção, `fetchData` fazia `if (quando !== null) setLastUpdated(new Date(quando))`:
 * quando a leitura seguinte deixava de afirmar um instante (serviço reiniciado,
 * boot anterior sem contrato, ou falha sem foto), a marca antiga ficava no ecrã
 * e dizia «isto é actual» sobre linhas cuja idade já ninguém afirmava — o mesmo
 * defeito que o BUG B fechava no Gestor de Tarefas, noutro consumidor.
 *
 * O componente não é carregável por `tsx --test` (hooks, `window`, ícones). Por
 * isso testa-se a DECISÃO que ele aplica (política pura, já usada pelo App) e
 * fixa-se a forma da aplicação no próprio ficheiro: a marca é DERIVADA do
 * instante afirmado pelo serviço, com ausência a mostrar ausência.
 *
 * PAP-PROCESS-OWNERSHIP (26/10/2026): o painel deixou de fazer um `getProcesses`
 * próprio de 5 s em paralelo com o App. A regra não mudou — o que mudou foi o
 * dono da consulta, e com ela a última marca que ainda usava `new Date()` (o
 * caminho das props) desapareceu.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { instanteDeLeituraValida } from "../src/lib/processListState";
import type { ProcessEnumerationTruth } from "@cybersafe/shared-types";

const PAINEL = readFileSync(
  new URL("../src/pages/BusinessSecurityCenter.tsx", import.meta.url),
  "utf8",
);

const FOTO = 1_700_000_000_000;

const verdade = (overrides: Partial<ProcessEnumerationTruth> = {}): ProcessEnumerationTruth => ({
  state: "ok",
  enumeratedAt: FOTO,
  servedFrom: "snapshot",
  attempt: { startedAt: FOTO, finishedAt: FOTO + 1, ok: true },
  asOf: FOTO + 2,
  ...overrides,
});

/** O que a marca «Atualizado …» tem de mostrar para uma dada verdade. */
const marcaDoPainel = (truth: ProcessEnumerationTruth): Date | null => {
  const quando = instanteDeLeituraValida(truth);
  return quando === null ? null : new Date(quando);
};

describe("BUG C — frescura do painel de segurança empresarial", () => {
  it("leitura ok: a marca é o instante da FOTO do Windows", () => {
    const marca = marcaDoPainel(verdade());
    assert.ok(marca);
    assert.equal(marca.getTime(), FOTO, "não é o relógio do cliente");
  });

  it("leitura sem contrato depois de uma ok: a marca é LIMPA", () => {
    assert.equal(
      marcaDoPainel(verdade({ state: "unreported", enumeratedAt: null, servedFrom: "cache", attempt: null })),
      null,
      "conservar a marca anterior afirmaria frescura sobre linhas sem idade",
    );
  });

  it("falha sem foto: a marca é limpa", () => {
    assert.equal(
      marcaDoPainel(verdade({ state: "failed", enumeratedAt: null, servedFrom: "cache" })),
      null,
    );
  });

  it("falha COM foto anterior: a marca é a da foto anterior, não agora", () => {
    const marca = marcaDoPainel(verdade({ state: "failed", servedFrom: "cache" }));
    assert.ok(marca);
    assert.equal(marca.getTime(), FOTO);
  });

  it("o painel mostra só a foto do Windows, sem relógio próprio nem estado que envelheça", () => {
    // Desde o PAP-PROCESS-OWNERSHIP o painel deixou de fazer o seu `getProcesses`:
    // a idade das linhas chega por prop, já validada por `instanteDeLeituraValida`
    // no App. A marca passa a ser DERIVADA dessa prop — não há estado que possa
    // ficar a afirmar frescura de uma leitura anterior, nem relógio do cliente.
    const marcaDerivadaDaFoto = (fonte: string): boolean =>
      /processesObservedAt\?: number \| null;/.test(fonte) &&
      /const marcaDeLeitura =/.test(fonte) &&
      /new Date\(processesObservedAt\)/.test(fonte);

    assert.equal(marcaDerivadaDaFoto(PAINEL), true, "a marca tem de vir do instante afirmado pelo serviço");

    // O meio-BUG-C que faltava fechar: no caminho das props o painel fazia
    // `setLastUpdated(new Date())` — receber linhas do App não é uma leitura
    // acabada de fazer, e carimbá-la como agora afirmava frescura medida.
    assert.doesNotMatch(PAINEL, /setLastUpdated\(new Date\(\)\)/,
      "o painel não pode carimbar a marca com o relógio do cliente");
    assert.doesNotMatch(PAINEL, /setLastUpdated/,
      "sem estado de marca: a única atribuição possível é a foto que chegou");
    assert.doesNotMatch(PAINEL, /electronAPI\.getProcesses\(/,
      "um dono por consulta: a lista vem do poll partilhado do App");

    // Controlo de mutação: a forma PRÉ-correção (guarda que conserva) tem de ser
    // rejeitada pela mesma verificação. Se isto deixar de ser verdade, o teste
    // acima passou a mentir.
    const antigo = PAINEL.replace(
      "new Date(processesObservedAt)",
      "new Date()",
    );
    assert.notEqual(antigo, PAINEL, "a mutação tem de encontrar a marca");
    assert.equal(marcaDerivadaDaFoto(antigo), false, "relógio do cliente não pode passar");
  });
});
