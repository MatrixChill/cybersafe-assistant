/**
 * TP-MONITOR-P0-EVENT-FLOW-20261022 — o Monitor distingue, ou não, as duas
 * coisas que mostra.
 *
 * O ecrã que motivou o lote: 496 processos na lista e «Sem dados de telemetria» a
 * piscar no histórico. As duas frases juntas lêem-se «o Monitor está partido».
 * Não estava: `processes` é o inventário lido ao sistema a pedido; `events` é o
 * histórico de segurança do serviço (memória de 500, alimentado por análise,
 * observação ou bloqueio). Com a proteção parada, histórico vazio é o estado
 * VERDADEIRO — o defeito era dizê-lo como se fosse carregamento eterno.
 *
 * Renderiza-se a página com `react-dom/server` (sem jsdom, sem browser, sem
 * rede): o que se prova é o TEXTO que o utilizador lê, obtido do componente
 * real da lane. A decisão de conteúdo vive em `estadoVazioEventos`, também ela
 * testada isoladamente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import MonitorPage, { estadoVazioEventos } from "@/pages/MonitorPage";
import type { ProtectionState, ProcessSnapshot, SecurityEvent } from "@cybersafe/shared-types";

/** Inventário plausível: 496 processos sintéticos. Nenhum foi lido desta máquina. */
function inventario(n: number): ProcessSnapshot[] {
  return Array.from({ length: n }, (_, i) => ({
    pid: 1000 + i,
    ppid: 4,
    name: `proc-${i}.exe`,
    path: "",
    commandLine: `proc-${i}.exe`,
    cpu: 0.5,
    memoryMb: 12,
    startedAt: "2026-10-22T20:00:00.000Z",
    trusted: "neutral" as const,
  })) as unknown as ProcessSnapshot[];
}

function estado(protectionEnabled?: boolean): ProtectionState {
  return {
    status: "safe",
    stats: {},
    engine: {},
    protectionEnabled,
  } as unknown as ProtectionState;
}

function render(props: { events?: SecurityEvent[]; processes?: ProcessSnapshot[]; protection: ProtectionState | null }) {
  return renderToStaticMarkup(
    createElement(MonitorPage, {
      events: props.events ?? [],
      processes: props.processes ?? [],
      connections: [],
      protection: props.protection,
      quarantine: [],
    }),
  );
}

describe("estado vazio — dito pelo estado confirmado da proteção", () => {
  it("proteção confirmada a correr: fala do replay retido, nunca de um arquivo completo", () => {
    const vazio = estadoVazioEventos(estado(true));
    assert.equal(vazio.titulo, "Sem eventos no replay recente");
    assert.match(vazio.detalhe, /analisado, observado ou bloqueado/);
    // `events.list` é replay de 500. «vazio desde que o serviço iniciou» era uma
    // afirmação sobre o passado inteiro com uma prova de 500 eventos.
    assert.doesNotMatch(vazio.detalhe, /desde que o servi/);
    assert.match(vazio.detalhe, /até 500|não um arquivo completo/);
  });

  it("proteção desligada NÃO é apresentado como «não há eventos»", () => {
    const vazio = estadoVazioEventos(estado(false));
    assert.equal(vazio.titulo, "A proteção contínua está desligada");
    // A afirmação absoluta é a asneira que este teste fecha: com a proteção
    // contínua desligada, `scan.fullSystem` publica `scan.progress` e
    // `artifact.analyzed`, e `engine.health`/quarentena também chegam ao bus —
    // a própria página lista esses tipos no EVENT_LABELS.
    assert.doesNotMatch(vazio.detalhe, /não há eventos|sem proteção ativa não há|nunca há eventos/i);
    assert.match(vazio.detalhe, /análises manuais, estado dos motores e quarentena também publicam/);
    assert.match(vazio.detalhe, /lista de processos em baixo é uma leitura separada/);
  });

  it("sem estado lido (undefined) NUNCA é apresentado como «parado»", () => {
    // O tipo documenta-o: `undefined` = não foi lido. Uma UI que o traduzisse em
    // "desligado" estaria a afirmar o contrário do que sabe.
    assert.equal(estadoVazioEventos(estado(undefined)).titulo, "Estado da proteção não confirmado");
    assert.equal(estadoVazioEventos(null).titulo, "Estado da proteção não confirmado");
    assert.match(estadoVazioEventos(null).detalhe, /não se sabe/);
    assert.doesNotMatch(estadoVazioEventos(estado(undefined)).detalhe, /está desligada|não está a correr/);
  });

  it("os três estados continuam distintos entre si (nenhum colapsa noutro)", () => {
    const titulos = [estado(true), estado(false), null].map((p) => estadoVazioEventos(p).titulo);
    assert.equal(new Set(titulos).size, 3, `títulos colapsados: ${JSON.stringify(titulos)}`);
  });
});

describe("a página renderizada — o que o utilizador lê", () => {
  it("496 processos com zero eventos: os dois números aparecem com nomes de eixos diferentes", () => {
    const html = render({ processes: inventario(496), protection: estado(false) });
    assert.match(html, /Eventos de segurança/);
    assert.match(html, /Processos no sistema/);
    assert.match(html, /496 processos no inventário recebido/, "o vazio explica-se com a contagem real");
    assert.match(html, /zero eventos de segurança em memória/);
    assert.match(html, /A proteção contínua está desligada/);
  });

  it("já não há «telemetria a carregar»: o texto antigo e o pulso desaparecem", () => {
    const html = render({ processes: inventario(496), protection: estado(false) });
    assert.doesNotMatch(html, /Sem dados de telemetria/);
    assert.doesNotMatch(html, /animate-pulse/, "um vazio a piscar lê-se como carregamento eterno");
    assert.doesNotMatch(html, /opacity-20/);
  });

  it("com proteção a correr, o vazio não insinua que a proteção está parada", () => {
    const html = render({ processes: inventario(12), protection: estado(true) });
    assert.match(html, /Sem eventos no replay recente/);
    assert.doesNotMatch(html, /contínua está desligada|não está a correr/);
  });

  it("sem estado confirmado, a página diz que não sabe", () => {
    const html = render({ processes: inventario(3), protection: null });
    assert.match(html, /Estado da proteção não confirmado/);
    // O cabeçalho continua honesto: sem proteção lida não se inventa estado.
    assert.match(html, /Sem dados do serviço/);
  });

  it("com eventos, o histórico mostra-os e o subtítulo separa os dois eixos", () => {
    const evento: SecurityEvent = {
      id: "evt-1",
      type: "process.started",
      timestamp: "2026-10-22T20:00:00.000Z",
      sequence: 1,
      severity: "low",
      summary: "Processo iniciado: benign.exe",
      data: { pid: 4242, name: "benign.exe" },
    } as SecurityEvent;
    const html = render({ events: [evento], processes: inventario(496), protection: estado(true) });
    assert.match(html, /Processo iniciado: benign\.exe/);
    assert.doesNotMatch(html, /contínua está desligada|Sem eventos no replay/);
    assert.match(html, /Histórico de segurança em direto/);
    assert.match(html, /inventário de processos é uma leitura separada/);
    // A legenda tem de descrever o que a tabela MOSTRA, não o inventário inteiro:
    // 496 lidos, 20 em ecrã. PAP-PROCESS-OWNERSHIP.
    assert.match(html, /20 de 496/, "o inventário já não se anuncia como vigilância");
    assert.match(html, /a lista completa e ordenada está no Gestor de Tarefas/,
      "a amostra diz onde está o resto");
    assert.doesNotMatch(html, /496 processos lidos ao sistema/,
      "afirmava os 496 sobre as 20 linhas desenhadas");
  });

  it("a leitura do histórico é a memória do serviço: 500 eventos, não uma base", () => {
    const Muitos = Array.from({ length: 120 }, (_, i) => ({
      id: `evt-${i}`,
      type: "process.started",
      timestamp: "2026-10-22T20:00:00.000Z",
      sequence: i + 1,
      severity: "low",
      summary: `Processo iniciado: p${i}.exe`,
      data: { pid: 5000 + i, name: `p${i}.exe` },
    })) as unknown as SecurityEvent[];
    const html = render({ events: Muitos, processes: [], protection: estado(true) });
    // 50 mais recentes, agregados por nome em grupos de `process.started`.
    assert.match(html, /últimos 50/);
    assert.match(html, /Histórico de eventos/);
  });
});
