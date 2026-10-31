import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildEventRows,
  eventsCoveredByRows,
  startedGroupLabel,
  startedProcessName,
} from "../src/lib/eventRows";
import type { SecurityEvent } from "@cybersafe/shared-types";

/**
 * Hora 1 — painel de eventos do Monitor: os `process.started` do mesmo nome
 * dobram numa linha de grupo expansivel. Agregacao de APRESENTACAO: nenhum
 * evento desaparece; a fonte raw continua acessivel ao expandir.
 */

function started(id: string, name: string, sequence: number): SecurityEvent {
  return {
    id,
    type: "process.started",
    timestamp: "2026-10-07T10:00:00.000Z",
    sequence,
    severity: "low",
    summary: `Processo iniciado: ${name}`,
    data: { name, pid: 1000 + sequence },
  } as unknown as SecurityEvent;
}

function other(id: string, type: string, summary: string, sequence: number): SecurityEvent {
  return {
    id,
    type,
    timestamp: "2026-10-07T10:00:00.000Z",
    sequence,
    severity: "medium",
    summary,
    data: {},
  } as unknown as SecurityEvent;
}

describe("buildEventRows — agregacao apresentativa", () => {
  const rajada = Array.from({ length: 15 }, (_, i) => started(`o${i}`, "opera.exe", 100 - i));
  const lista = [
    ...rajada,
    other("t1", "threat.detected", "Download critico", 84),
    started("n1", "notepad.exe", 83),
    other("f1", "file.created", "Ficheiro criado", 82),
  ];
  // Ordem do painel: sequence descendente.
  const visivel = [...lista].sort((a, b) => b.sequence - a.sequence);

  const rows = buildEventRows(visivel);

  test("(a) 15 process.started do mesmo nome viram UMA linha de grupo", () => {
    const grupos = rows.filter((r) => r.kind === "started-group");
    assert.equal(grupos.length, 1, "so o opera tem >= 2; notepad fica linha normal");
    const opera = grupos.find((r) => r.kind === "started-group" && r.name === "opera.exe");
    assert.ok(opera && opera.kind === "started-group");
    assert.equal(opera.events.length, 15);
    assert.equal(startedGroupLabel(opera.events.length), "15 processos iniciados");
    // O grupo aparece na posicao da entrada mais recente, como estava.
    assert.equal(rows.indexOf(opera), 0);
    // notepad e caso isolado: linha NORMAL, nao grupo.
    assert.ok(!grupos.some((g) => g.kind === "started-group" && g.name === "notepad.exe"));
    assert.ok(rows.some((r) => r.kind === "single" && r.event.id === "n1"));
  });

  test("(b) expandir revela as N entradas individuais cru, intactas", () => {
    const opera = rows.find((r) => r.kind === "started-group" && r.name === "opera.exe");
    assert.ok(opera && opera.kind === "started-group");
    const idsOriginais = rajada.map((e) => e.id).sort();
    assert.deepEqual(opera.events.map((e) => e.id).sort(), idsOriginais);
    // Cada entrada conserva hora, resumo e sequence proprios.
    for (const event of opera.events) {
      assert.equal(event.type, "process.started");
      assert.ok(event.summary.startsWith("Processo iniciado: opera.exe"));
      assert.ok(event.timestamp.length > 0);
    }
  });

  test("(c) tipos diferentes e nomes diferentes nunca se misturam", () => {
    const cobertos = eventsCoveredByRows(rows);
    const porId = new Map(cobertos.map((e) => [e.id, e]));
    // threat.detected e file.created continuam linhas singulares.
    assert.ok(rows.some((r) => r.kind === "single" && r.event.id === "t1"));
    assert.ok(rows.some((r) => r.kind === "single" && r.event.id === "f1"));
    // Dois process.started do MESMO nome agrupam; nome isolado fica linha normal.
    const dois = buildEventRows([started("a1", "x.exe", 5), started("a2", "x.exe", 4), started("a3", "y.exe", 3)]);
    assert.equal(dois.filter((r) => r.kind === "started-group").length, 1);
    assert.ok(dois.some((r) => r.kind === "single" && r.event.id === "a3"));
    assert.ok(porId.get("t1")!.type === "threat.detected");
  });

  test("(d) nenhum evento se perde: a cobertoria e exatamente a lista visivel", () => {
    const cobertos = eventsCoveredByRows(rows);
    assert.equal(cobertos.length, visivel.length);
    assert.deepEqual(
      cobertos.map((e) => e.id).sort(),
      visivel.map((e) => e.id).sort(),
    );
  });

  test("dois grupos do mesmo nome no meio de outros eventos fundem-se numa linha", () => {
    const lista2 = [
      started("b1", "chrome.exe", 10),
      other("z1", "file.modified", "m", 9),
      started("b2", "chrome.exe", 8),
      other("z2", "threat.detected", "t", 7),
      started("b3", "chrome.exe", 6),
    ];
    const r2 = buildEventRows(lista2);
    const grupos = r2.filter((r) => r.kind === "started-group");
    assert.equal(grupos.length, 1);
    assert.ok(grupos[0].kind === "started-group");
    assert.equal(grupos[0].events.length, 3);
    assert.equal(eventsCoveredByRows(r2).length, 5);
  });

  test("chave do grupo e estavel quando chega uma entrada nova da rajada", () => {
    const antes = buildEventRows([started("c1", "opera.exe", 2), started("c2", "opera.exe", 1)]);
    const depois = buildEventRows([started("c3", "opera.exe", 3), started("c1", "opera.exe", 2), started("c2", "opera.exe", 1)]);
    assert.equal(antes[0].key, depois[0].key, "expandir nao colapsa a cada novo evento");
  });

  test("nome vem de data.name; sem data, fallback le o resumo do servico", () => {
    assert.equal(startedProcessName(started("d1", "winword.exe", 1)), "winword.exe");
    const semData = { ...started("d2", "winword.exe", 2), data: undefined } as unknown as SecurityEvent;
    assert.equal(startedProcessName(semData), "winword.exe");
    assert.equal(startedProcessName(other("d3", "process.blocked", "bloqueado", 4)), null);
  });
});

describe("MonitorPage — fio da apresentacao", () => {
  const page = readFileSync(new URL("../src/pages/MonitorPage.tsx", import.meta.url), "utf8");

  test("a lista visivel usa as rows agregadas e o MetricCard continua a contar os eventos reais", () => {
    assert.match(page, /const rows = buildEventRows\(latestEvents\)/);
    // TP-MONITOR-P0: o rótulo passou a dizer DE QUE histórico se fala (eixos
    // diferentes ao lado do inventário). O que se conta continua a ser eventos
    // reais, nunca linhas agregadas.
    assert.match(page, /<MetricCard label="Eventos de segurança" value=\{events\.length\} \/>/,
      "o contador de Eventos de segurança não pode passar a contar linhas agrupadas");
  });

  test("expandir mostra as entradas individuais (row.events), nao uma copia resumida", () => {
    assert.match(page, /\{expanded && \(/);
    assert.match(page, /row\.events\.map\(\(event\) => \(\s*<EventLine key=\{event\.id\} event=\{event\} \/>/);
  });

  test("copy PT-PT do grupo: expandir/ocultar", () => {
    assert.match(page, /expanded \? "ocultar" : "expandir"/);
    assert.doesNotMatch(page, /expand /i);
  });
});
