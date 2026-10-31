/**
 * PAP-PROCESS-OWNERSHIP — um dono por consulta, uma conta por lista.
 *
 * §2 problema 4 («contagens incorretas ou duplicadas») e §3 («evitar que
 * diferentes páginas façam a mesma consulta independentemente») têm a mesma
 * causa medida, não duas causas:
 *
 *   1. o painel «Segurança Empresarial» fazia `getProcesses` próprio de 5 em 5 s
 *      em paralelo com o poll do App, e mantinha uma cópia local da lista;
 *   2. a legenda do Monitor dizia «N processos lidos ao sistema» sobre 20 linhas.
 *
 * A duplicação de PIDs foi excluída por leitura, não por suposição: em
 * `service/src/engine.ts` o merge é `new Map(fresh.map((e) => [e.pid, e]))`, que
 * não pode produzir duas linhas com o mesmo PID. O que estava errado era a
 * apresentação e o número de caminhos de consulta.
 *
 * O componente não é carregável por `tsx --test` (hooks, `window`, ícones), por
 * isso a forma de aplicação é verificada no próprio ficheiro — o mesmo método de
 * `process-last-updated.test.ts`. As decisões puras vivem em `processActions`.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { processosPollMs, PROCESSES_POLL_MS, PROCESSES_ENRICHMENT_POLL_MS } from "../src/lib/processActions";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const painel = readFileSync(new URL("../src/pages/BusinessSecurityCenter.tsx", import.meta.url), "utf8");
const monitor = readFileSync(new URL("../src/pages/MonitorPage.tsx", import.meta.url), "utf8");

describe("cadência por função da página, num só sítio", () => {
  test("a lista é produto no Gestor de Tarefas e no Monitor", () => {
    assert.equal(processosPollMs("taskmanager"), PROCESSES_POLL_MS);
    assert.equal(processosPollMs("monitor"), PROCESSES_POLL_MS);
  });

  test("a lista é só tradução de PID no painel empresarial: ritmo próprio, mais lento", () => {
    assert.equal(processosPollMs("business"), PROCESSES_ENRICHMENT_POLL_MS);
    assert.ok(
      PROCESSES_ENRICHMENT_POLL_MS > PROCESSES_POLL_MS,
      "aqui a lista não é o produto; pedir ao ritmo do produtor publicava as mesmas linhas",
    );
  });

  test("página sem lista não pede lista", () => {
    for (const pagina of ["dashboard", "settings", "reports", "otimizar", "login"]) {
      assert.equal(processosPollMs(pagina), null, `${pagina} não mostra processos`);
    }
  });

  test("o App pergunta a cadência, não a escreve", () => {
    assert.match(app, /processosPollMs\(page\)/, "o App tem de perguntar à tabela");
    assert.match(app, /setInterval\(\(\) => \{[\s\S]{0,220}\}, cadencia\);/,
      "o intervalo do poll usa o valor devolvido pela tabela");
    assert.doesNotMatch(app, /page === "taskmanager" \|\| page === "monitor"/,
      "a lista de páginas não pode voltar a estar escrita no App");
  });
});

describe("um dono para a lista de processos", () => {
  test("o painel empresarial deixou de pedir processos", () => {
    // A chamada é que tem de desaparecer — o comentário histórico diz porque é
    // que existiu, e continuar a chamá-lo não é o mesmo que voltar a fazê-lo.
    assert.doesNotMatch(painel, /electronAPI\.getProcesses\(/, "a lista vem do poll partilhado do App");
    assert.doesNotMatch(painel, /normalizeProcessListResult/,
      "quem normaliza é o dono da consulta, não cada consumidor");
    assert.doesNotMatch(painel, /setProcesses\(/, "sem cópia local da lista");
  });

  test("o painel continua dono das suas ligações, com ritmo próprio", () => {
    assert.match(painel, /await window\.electronAPI\.getConnections\(\)/);
    assert.match(painel, /CONNECTIONS_POLL_MS\);/, "o número vive no módulo");
    assert.match(painel, /fetchConnections/, "uma função, uma consulta");
    assert.doesNotMatch(painel, /fetchData/, "não sobra um pedido genérico que já pediu as duas coisas");
  });

  test("a frescura do painel é a foto do Windows, nunca o relógio do cliente", () => {
    assert.match(painel, /processesObservedAt\?: number \| null;/, "a idade entra por prop");
    assert.match(painel, /const marcaDeLeitura =/);
    assert.doesNotMatch(painel, /setLastUpdated\(new Date\(\)\)/,
      "o caminho das props carimbava a marca com o relógio do cliente: a meia mentira que faltava");
    assert.doesNotMatch(painel, /setLastUpdated/, "marca derivada, não estado que pode envelhecer");
  });
});

describe("contagens que descrevem o que está em ecrã", () => {
  test("o Monitor tem UMA amostra, partilhada pela legenda e pelas linhas", () => {
    assert.match(monitor, /const mostrados = processes\.slice\(0, 20\);/);
    assert.match(monitor, /\{mostrados\.map\(\(process\) => \(/, "as linhas vêm da mesma conta");
    assert.doesNotMatch(monitor, /processes\.slice\(0, 20\)\.map/,
      "a legenda e a tabela não podem cortar cada uma por sua conta");
    assert.doesNotMatch(monitor, /\{processes\.length\} processos/,
      "a legenda não pode afirmar o inventário inteiro sobre 20 linhas");
  });

  test("a legenda diz X de Y e aponta para a lista completa", () => {
    assert.match(monitor, /\$\{mostrados\.length\} de \$\{processes\.length\}/, "X de Y");
    assert.match(monitor, /a lista completa e ordenada está no Gestor de Tarefas/);
  });

  test("lista vazia não é contada como amostra de zero em zero", () => {
    assert.match(monitor, /processes\.length === 0\n?\s*\?\s*"Nenhum processo no inventário recebido"/,
      "sem linhas não há «X de Y» a mostrar");
  });

  test("o texto do inventário deixou de afirmar que é actual", () => {
    assert.doesNotMatch(monitor, /no inventário actual/,
      "a página não recebe o instante da foto; «recebido» é o que pode afirmar");
  });
});
