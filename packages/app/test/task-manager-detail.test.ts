import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectionSnapshot, ProcessSnapshot } from "@cybersafe/shared-types";
import TaskManagerPage, { ProcessDetailPanel } from "../src/pages/TaskManagerPage";
import { buildProcessDetailFacts, connectionsForPid, deriveChildren, sameInstance } from "../src/lib/processDetail";

// Mesmo padrão do teste da pagina: o `tsx` compila JSX com runtime classico e
// precisa do global React fora do Vite.
(globalThis as Record<string, unknown>).React = React;

/**
 * HORA 2 — painel de detalhe (DADO → SIGNIFICADO → PRIORIDADE → AÇAO) com
 * dados reais do cliente: nada de signer/hash/trusted (nunca preenchidos ou
 * sempre "neutral" em producao), tudo o que falta escreve-se "desconhecido".
 */

function proc(over: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
  return {
    pid: 500,
    ppid: 1000,
    name: "opera.exe",
    path: "C:\\Program Files\\Opera\\opera.exe",
    commandLine: '"C:\\Program Files\\Opera\\opera.exe" --flag',
    cpu: 3.2,
    memoryMb: 412,
    startedAt: "2026-10-07T09:00:00.000Z",
    trusted: "neutral",
    ...over,
  } as ProcessSnapshot;
}

function conn(over: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot {
  return {
    processPid: 500,
    remoteAddress: "93.184.216.34",
    remotePort: 443,
    protocol: "tcp",
    state: "established",
    direction: "outbound",
    observedAt: "2026-10-07T09:30:00.000Z",
    ...over,
  } as ConnectionSnapshot;
}

const LISTA = [
  proc(),
  proc({ pid: 1000, name: "explorer.exe", ppid: 900 }),
  proc({ pid: 501, name: "opera_helper.exe", ppid: 500 }),
  proc({ pid: 502, name: "opera_crashpad.exe", ppid: 500 }),
];

describe("ProcessDetailPanel — dados reais", () => {
  test("com dados completos: caminho, pai por nome, filhos derivados da lista", () => {
    const html = renderToStaticMarkup(createElement(ProcessDetailPanel, {
      process: LISTA[0],
      allProcesses: LISTA,
      connections: { status: "ready", connections: [conn(), conn({ remoteAddress: "140.82.121.4", remotePort: 80 })] },
    }));
    assert.match(html, /Caminho: <span[^>]*>C:\\Program Files\\Opera\\opera\.exe/);
    assert.match(html, /Processo pai: <span[^>]*>PID 1000 · explorer.exe/);
    // Filhos derivados DO CLIENTE dos ppid da lista atual.
    assert.match(html, /opera_helper.exe \(501\)/);
    assert.match(html, /opera_crashpad.exe \(502\)/);
    // Conexoes pelo join real por processPid.
    assert.match(html, /→ saída 93\.184\.216\.34:443 · established/);
    assert.match(html, /140\.82\.121\.4:80/);
    assert.match(html, /2 associadas/);
  });

  test("com dados em falta: path vazio, ppid 0, sem filhos, sem conexoes — tudo escrito como desconhecido", () => {
    const html = renderToStaticMarkup(createElement(ProcessDetailPanel, {
      process: proc({ path: "", ppid: 0 }),
      allProcesses: [proc({ path: "", ppid: 0 })],
      connections: { status: "ready", connections: [] },
    }));
    assert.match(html, /Caminho não disponível/);
    assert.match(html, /Processo pai: <span[^>]*>desconhecido/);
    assert.match(html, /nenhum filho visível/);
    assert.match(html, /sem ligações TCP associadas/);
  });

  test("estado das ligações é honesto: a ler e indisponíveis nunca viram 'sem ligações'", () => {
    const loading = renderToStaticMarkup(createElement(ProcessDetailPanel, {
      process: LISTA[0], allProcesses: LISTA, connections: { status: "loading" },
    }));
    assert.match(loading, /a ler…/);
    assert.doesNotMatch(loading, /sem ligações TCP associadas/);
    const unavail = renderToStaticMarkup(createElement(ProcessDetailPanel, {
      process: LISTA[0], allProcesses: LISTA, connections: { status: "unavailable" },
    }));
    assert.match(unavail, /indisponíveis \(sem leitura do serviço\)/);
    assert.doesNotMatch(unavail, /sem ligações TCP associadas/);
  });

  test("os factos novos NUNCA leem signer/hash/trusted; so a classificacao protegida real", () => {
    const comCamposVazios = proc({ signer: "Qualquer Assinante", hash: "deadbeefcafe", trusted: "neutral" as ProcessSnapshot["trusted"] });
    const facts = buildProcessDetailFacts(comCamposVazios, LISTA);
    // So os TEXTOS de facto (os objetos snapshot dos filhos ficam para o
    // chamador usar pid/nome — o painel nunca mostra trusted deles).
    const blob = `${facts.pathText} ${facts.parentText} ${facts.childrenText} ${facts.protectionText}`;
    assert.doesNotMatch(blob, /Qualquer Assinante|deadbeefcafe|neutral/, "nenhum campo sem dados reais entra nos factos do painel");
    // O bloco novo mostra apenas "Protegido"/"Não protegido" — nunca badge de confianca.
    const html = renderToStaticMarkup(createElement(ProcessDetailPanel, {
      process: comCamposVazios, allProcesses: LISTA, connections: { status: "ready", connections: [] },
    }));
    const estado = html.match(/Estado: <span[^>]*>([^<]*)</);
    assert.ok(estado && /Não protegido/.test(estado[1]));
    assert.doesNotMatch(estado![1], /untrusted|neutral/, "a linha Estado nao mostra o valor crudo de trusted");
    const protegido = renderToStaticMarkup(createElement(ProcessDetailPanel, {
      process: proc({ pid: 60, name: "csrss.exe" }), allProcesses: LISTA, connections: { status: "ready", connections: [] },
    }));
    assert.match(protegido, /Protegido — o Windows precisa dele/);
  });

  test("pai fora da lista: mostra o PID sem inventar nome", () => {
    const html = renderToStaticMarkup(createElement(ProcessDetailPanel, {
      process: proc({ ppid: 9999 }),
      allProcesses: [proc({ ppid: 9999 })],
      connections: { status: "ready", connections: [] },
    }));
    assert.match(html, /PID 9999 \(fora da lista atual\)/);
  });
});

describe("F1 — sameInstance: identidade e a instancia, nao o PID", () => {
  test("PID igual com startedAt diferente e OUTRO processo", () => {
    assert.equal(sameInstance({ pid: 500, startedAt: "2026-10-07T09:00:00Z" }, { pid: 500, startedAt: "2026-10-07T10:30:00Z" }), false);
    assert.equal(sameInstance({ pid: 500, startedAt: "2026-10-07T09:00:00Z" }, { pid: 500, startedAt: "2026-10-07T09:00:00Z" }), true);
    assert.equal(sameInstance({ pid: 500, startedAt: "a" }, { pid: 501, startedAt: "a" }), false);
    // Nada aberto = nada correspondido: null nunca iguala uma instancia.
    assert.equal(sameInstance(null, { pid: 500, startedAt: "a" }), false);
    assert.equal(sameInstance({ pid: 500, startedAt: "a" }, null), false);
  });

  test("o snapshot do cliente e usavel como instancia diretamente", () => {
    // `proc()` tem startedAt real: sameInstance aceita o ProcessSnapshot todo.
    assert.equal(sameInstance(proc(), { pid: 500, startedAt: "2026-10-07T09:00:00.000Z" }), true);
    assert.equal(sameInstance(proc(), { pid: 500, startedAt: "2026-10-07T11:00:00.000Z" }), false,
      "PID reutilizado: o detalhe do processo antigo NAO se abre para o novo");
  });
});

describe("F2 — o snapshot de ligacoes diz desde quando fala", () => {
  test("com hora de leitura: 'sem ligacoes' e contagens surgem com '(leitura das <hora>)'", () => {
    const html = renderToStaticMarkup(createElement(ProcessDetailPanel, {
      process: proc(), allProcesses: LISTA,
      connections: { status: "ready", connections: [], readAt: "14:32:07" },
    }));
    assert.match(html, /sem ligações TCP associadas \(leitura das 14:32:07\)/);
    const comConexoes = renderToStaticMarkup(createElement(ProcessDetailPanel, {
      process: proc(), allProcesses: LISTA,
      connections: { status: "ready", connections: [conn()], readAt: "14:35:00" },
    }));
    assert.match(comConexoes, /1 associada \(leitura das 14:35:00\)/);
  });

  test("sem hora conhecida nao se afirma uma hora (o texto fica como antes)", () => {
    const html = renderToStaticMarkup(createElement(ProcessDetailPanel, {
      process: proc(), allProcesses: LISTA,
      connections: { status: "ready", connections: [] },
    }));
    assert.match(html, /sem ligações TCP associadas</);
    assert.doesNotMatch(html, /leitura das/, "readAt ausente nao pode inventar hora");
  });
});

describe("join e derivacao — unidades puras", () => {
  test("connectionsForPid so aceita processPid igual; undefined nunca entra", () => {
    const lista = [conn(), conn({ processPid: 501 }), conn({ processPid: undefined }), conn({ processPid: 500, remoteAddress: "1.1.1.1" })];
    const proprias = connectionsForPid(lista, 500);
    assert.equal(proprias.length, 2);
    assert.ok(proprias.every((c) => c.processPid === 500));
  });

  test("deriveChildren exclui o proprio PID e so apanha ppid iguais", () => {
    const filhos = deriveChildren(proc({ pid: 500 }), LISTA);
    assert.deepEqual(filhos.map((f) => f.pid).sort(), [501, 502]);
  });
});

describe("TaskManagerPage — estabilidade de selecao e copy do botao", () => {
  const page = readFileSync(new URL("../src/pages/TaskManagerPage.tsx", import.meta.url), "utf8");

  test("o botao de acao e 'Encerrar processo' com icone semanticamente correto, guardas intactas", () => {
    assert.match(page, /"Encerrar processo"/);
    assert.match(page, /CircleStop/);
    assert.doesNotMatch(page, /Trash2/, "a lixeira saiu — nao ficou nenhum Trash2 nesta pagina");
    // Guardas que tem de manter: disabled por protecao, data-row-action, seletor do modal.
    assert.match(page, /disabled=\{isProtected\}/);
    assert.match(page, /data-row-action=\{process\.pid\}/);
    assert.match(page, /selectKillTarget\(process\)/);
    assert.match(page, /KillConfirmModal/);
  });

  test("selecao nao re-aponta: o detalhe fecha quando a INSTANCIA (pid+startedAt) sai da lista", () => {
    assert.match(page, /if \(detail && !processes\.some\(\(p\) => sameInstance\(p, detail\)\)\) \{\s*setDetail\(null\);/);
    assert.doesNotMatch(page, /detailPid/, "a identidade por PID puro nao pode voltar (F1)");
  });

  test("resultado velho de ligacoes nunca se cola: o estado guarda a INSTANCIA e a leitura e cancelada", () => {
    assert.match(page, /const \[detailConnections, setDetailConnections\] = useState<\{ instance: ProcessInstance; data: DetailConnections \} \| null>/);
    assert.match(page, /detailConnections && sameInstance\(detailConnections\.instance, detail\) && sameInstance\(detail, process\)/);
    assert.match(page, /let cancelled = false;[\s\S]{0,800}cancelled = true;/);
    // F2: o snapshot de ligacoes guarda a hora da leitura factual.
    assert.match(page, /readAt: new Date\(\)\.toLocaleTimeString\("pt-PT"\)/);
  });

  test("pesquisa nao desaparece com o refresh nem a linha muda de identidade", () => {
    // searchTerm e estado do proprio componente — nenhuma leitura de `processes`
    // o escreve; e as linhas tem chave por PID (ordem pode mudar, identidade nao).
    assert.match(page, /const \[searchTerm, setSearchTerm\] = useState\(""\);/);
    assert.doesNotMatch(page, /setSearchTerm\([^)]*processes/);
    assert.match(page, /<Fragment key=\{process\.pid\}>/);
  });

  test("a pagina nao inventa dados: o painel e renderizado por PID, nunca por indice", () => {
    // Indice com fila a mudar sob refresh re-apontaria o detalhe para outro
    // processo; `key={process.pid}` + `detailPid` dao identidade estavel.
    assert.match(page, /<ProcessDetailPanel/);
    assert.doesNotMatch(page, /ProcessDetailPanel[\s\S]{0,200}index/);
    // O modal de confirmacao nao perdeu nenhuma das guardas do fluxo antigo.
    assert.match(page, /runKillSequence/);
    assert.match(page, /killRequestGate\.current/);
  });

  test("TaskManagerPage renderiza sem window.electronAPI (efeitos fora do SSR nao rebentam)", () => {
    const html = renderToStaticMarkup(createElement(TaskManagerPage, { processes: LISTA }));
    assert.match(html, /opera\.exe/);
    assert.doesNotMatch(html, /data-row-detail-panel/, "detalhe comecado fechado: nada apontado sem selecao");
  });
});
