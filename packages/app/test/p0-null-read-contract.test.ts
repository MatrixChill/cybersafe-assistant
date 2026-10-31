import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/**
 * CONTRATO DE LEITURA NULA (TP-PAP-V2-REAL-FRONTEND-20261028 · pedido pelo Codex
 * na revisão do FAULT-R2).
 *
 * O que aconteceu no DEV: depois de `beginShutdown()` a ponte devolve `null` em
 * vez de rejeitar. `fetchSnapshot` publicava esse `null` diretamente nos estados
 * de lista; a página seguinte rebentava no `ErrorBoundary` («Erro no renderer»)
 * em vez de dizer que a leitura falhou. Só a quarentena validava o formato.
 *
 * A regra que fica: `null` NÃO é um resultado, é a ausência dele. Antes de
 * publicar, cada leitura é validada na forma declarada; o que não valida conta
 * como rejeição, o ciclo de sync rotula a falha, e a última leitura confirmada
 * continua no ecrã. Nada aqui inventa lista vazia nem esconde o ErrorBoundary.
 *
 * O teste extrai `fetchSnapshot` do fonte real (mesma técnica de
 * `p0-snapshot-invalidation.test.ts`) e corre-a num contexto com a ponte
 * falsificada — é comportamento, não regex.
 */

function exported(file: URL): Record<string, unknown> {
  const e: Record<string, unknown> = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { exports: e, Promise },
  );
  return e;
}

const fonte = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const inicio = fonte.indexOf("const fetchSnapshot = useCallback(");
const abre = fonte.indexOf("=> {", inicio) + 4;
const fecha = fonte.indexOf("\n  }, [acceptProcesses]);", abre);
assert.ok(inicio > 0 && fecha > abre, "o extrator de fetchSnapshot perdeu o marcador no App.tsx");
const corpo = fonte.slice(abre, fecha);

type Chamadas = Record<string, unknown[]>;

function correr(api: Record<string, () => Promise<unknown>>, anteriores: Record<string, unknown> = {}) {
  const chamadas: Chamadas = {};
  const registo = (nome: string) => (valor: unknown) => {
    (chamadas[nome] ??= []).push(valor);
  };
  const noop = () => {};
  const contexto: Record<string, unknown> = {
    window: { electronAPI: api },
    isAppShuttingDown: () => false,
    ipcUnlessShuttingDown: (f: () => Promise<unknown>) => f(),
    serviceConnectionRef: { current: true },
    connectionGeneration: { current: 1 },
    snapshotGeneration: { current: 0 },
    snapshotFlightRef: { current: null },
    console,
    setProtection: registo("protection"),
    setEvents: registo("events"),
    setThreats: registo("threats"),
    acceptProcesses: registo("processes"),
    setConnections: registo("connections"),
    setQuarantine: registo("quarantine"),
    setQuarantineReadState: registo("quarantineReadState"),
    setPcState: registo("pcState"),
    setError: registo("error"),
    setIsLoading: registo("isLoading"),
    ...exported(new URL("../src/lib/progressiveRead.ts", import.meta.url)),
    ...exported(new URL("../src/lib/serviceSyncStatus.ts", import.meta.url)),
  };
  vm.createContext(contexto);
  vm.runInContext(
    ts.transpileModule(
      `globalThis.fetchSnapshot = async (invalidate = false) => {${corpo}\n};`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    contexto,
  );
  void anteriores;
  return { executar: () => (contexto as { fetchSnapshot: (i?: boolean) => Promise<void> }).fetchSnapshot(), chamadas };
}

const PONTES_NULA: Record<string, () => Promise<unknown>> = {
  getProtectionState: async () => null,
  getSecurityEvents: async () => null,
  getThreatEvents: async () => null,
  getProcesses: async () => null,
  getConnections: async () => null,
  getQuarantineFiles: async () => null,
  getPCState: async () => null,
};

test("ponte a null em todas as leituras: nada de null publicado, falha rotulada", async () => {
  const { executar, chamadas } = correr(PONTES_NULA);
  await executar();

  // O que rebentava no renderer: listas a null. Têm de ficar FECHADAS, não publicadas.
  assert.equal(chamadas.events, undefined, "setEvents recebeu a leitura nula");
  assert.equal(chamadas.threats, undefined, "setThreats recebeu a leitura nula");
  assert.equal(chamadas.processes, undefined, "acceptProcesses recebeu a leitura nula");
  assert.equal(chamadas.connections, undefined, "setConnections recebeu a leitura nula");
  assert.equal(chamadas.pcState, undefined, "setPcState recebeu a leitura nula");
  assert.equal(chamadas.quarantine, undefined, "setQuarantine recebeu a leitura nula");

  // E o que a página passa a mostrar: falha, não vazio.
  assert.deepEqual(chamadas.quarantineReadState, ["falhou"], "a quarentena tem de marcar a leitura falhada");
  assert.ok(
    (chamadas.error ?? []).some((e) => String(e).length > 0),
    `erro de sync tinha de ser registado, obtido ${JSON.stringify(chamadas.error)}`,
  );
  assert.deepEqual(chamadas.isLoading, [false], "o ciclo acaba e deixa de estar a carregar");
});

test("com leituras confirmadas antes, a leitura nula NÃO apaga o que foi lido", async () => {
  let nulas = false;
  const boa = {
    getSecurityEvents: async () => (nulas ? null : [{ id: "e1", sequence: 1, type: "threat.detected", summary: "s", timestamp: "t", data: {} }]),
    getThreatEvents: async () => (nulas ? null : [{ id: "t1", severity: "high", source: "download-monitor", summary: "s", domain: "d", rulesTriggered: [], createdAt: "t" }]),
    getProcesses: async () => (nulas ? null : []),
    getConnections: async () => (nulas ? null : []),
    getQuarantineFiles: async () => (nulas ? null : []),
    getPCState: async () => (nulas ? null : {}),
    getProtectionState: async () => (nulas ? null : { status: "active", stats: { riskScore: 10, totalEvents: 0, highSeverityEvents: 0 } }),
  };
  const primeiro = correr(boa);
  await primeiro.executar();
  const lidoAntes = {
    events: primeiro.chamadas.events?.length ?? 0,
    threats: primeiro.chamadas.threats?.length ?? 0,
    connections: primeiro.chamadas.connections?.length ?? 0,
  };
  assert.ok(lidoAntes.events === 1 && lidoAntes.threats === 1, "o ciclo bom tinha de publicar as leituras");

  nulas = true;
  const segundo = correr(boa, { ...lidoAntes });
  await segundo.executar();
  assert.equal(segundo.chamadas.events, undefined, "a leitura nula reescreveu a lista confirmada");
  assert.equal(segundo.chamadas.threats, undefined, "a leitura nula reescreveu as ameaças confirmadas");
  assert.equal(segundo.chamadas.connections, undefined, "a leitura nula reescreveu as ligações confirmadas");
  assert.ok(
    (segundo.chamadas.error ?? []).length > 0,
    "sem qualquer leitura confirmada o ciclo tem de reportar a falha",
  );
});

test("os validadores dizem o que a ponte devolveu, sem traduzir o facto", async () => {
  const { exigirLista, exigirPresenca } = exported(new URL("../src/lib/progressiveRead.ts", import.meta.url)) as {
    exigirLista: (l: string, v: unknown) => unknown[];
    exigirPresenca: (l: string, v: unknown) => unknown;
  };
  assert.throws(() => exigirLista("threat.events", null), /não confirmada: a ponte devolveu null/);
  assert.throws(() => exigirLista("connections", {}), /não confirmada: a ponte devolveu object/);
  assert.throws(() => exigirPresenca("pc.state", undefined), /devolveu undefined/);
  assert.deepEqual(exigirLista("connections", []), [], "lista vazia confirmada é um facto, não uma falha");
  assert.equal(exigirPresenca("pc.state", 0), 0, "0 não é ausência");
});
