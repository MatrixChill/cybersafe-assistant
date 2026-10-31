/**
 * TP-MATRIX-FB2-E2E-20261023 (revisão) — ciclo REAL de deduplicação.
 *
 * O defeito encontrado na revisão: a guarda de dedup estava DENTRO de
 * `processMessage`, depois de o efeito de «Explicar» já ter feito
 * `questionGenerationRef++`, abortado o controlador e mudado a fase. Um segundo
 * clique no mesmo alvo cancelava a primeira resposta e depois o envio era
 * recusado — zero respostas. A guarda passou a ser por INTENÇÃO (alvo/instância +
 * texto), no início do efeito, antes de qualquer efeito destrutivo.
 *
 * Este ficheiro não se contenta com regex: recorta do produto o efeito de
 * «Explicar», a porta `enviarPeloFluxoNormal` e `sendToServer+processMessage`,
 * liga-os e corre com um fornecedor ADIADO (SSE preso até `libertar()`), para
 * poder observar o que acontece entre o primeiro e o segundo clique.
 *
 * Limite: continua a não haver DOM/Electron. O clique real é gate humano; aqui
 * prova-se o corpo que o clique executa.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const SRC = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");
const LINHAS = SRC.split(/\r?\n/);

/** sendToServer + processMessage, como em matrix-origin-routing. */
const iEnvio = LINHAS.findIndex((l) => l === "  const sendToServer = useCallback(");
const iDeps = LINHAS.findIndex((l) => /explainIdentity[^\]]*\],\s*$/.test(l));
const iFimEnvio = LINHAS.findIndex((l, i) => i > iDeps && l === "  )");
assert.ok(iEnvio >= 0 && iDeps > iEnvio && iFimEnvio > iDeps, "região sendToServer/processMessage mudou de forma");
const REGIAO_ENVIO = LINHAS.slice(iEnvio, iFimEnvio + 1).join("\n");

/** efeito de «Explicar», como em gui02. */
const iMarcadorEfeito = SRC.indexOf("if (!explainRequest) return");
const iFimEfeito = SRC.indexOf("}, [explainRequest", iMarcadorEfeito);
assert.ok(iMarcadorEfeito > 0 && iFimEfeito > iMarcadorEfeito, "efeito de Explicar mudou de forma");
const iLinhaEfeito = SRC.lastIndexOf("\n", iMarcadorEfeito) + 1;
const REGIAO_EFEITO = SRC.slice(iLinhaEfeito, iFimEfeito);

const urlModulo = (rel: string) => new URL(rel, new URL("../", import.meta.url)).href;
const temporarios: string[] = [];
after(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

const A = { pid: 4712, startedAt: "2026-10-23T08:00:00.000Z" };
const A_OUTRA = { pid: 4712, startedAt: "2026-10-23T09:30:00.000Z" };
const B = { pid: 9000, startedAt: "2026-10-23T08:10:00.000Z" };

async function criar() {
  const dir = mkdtempSync(tmpdir() + "/cybersafe-matrix-dedup-");
  temporarios.push(dir);
  const prelude = `
import { originDaResposta, motivoDoEncaminhamentoLocal, decisaoAposTentativaLocal, estadoDoMotivoLocal, estadoDoResultado, deveAutoEnviarExplicacao, promptDeExplicacaoDeProcesso, devePedirAutorizacaoAntes, acrescentarMensagem } from ${JSON.stringify(urlModulo("src/lib/matrixConversation.ts"))};
import { isProcessQuestion, perguntaApontaParaAlvo, buildProcessLocalReply, processPayload, processChatHistory, matrixTelemetryContext, alvoDeExplicacao, consentValeParaAlvo, autorizacaoValida, identidadeDeExplicacaoPerdida } from ${JSON.stringify(urlModulo("src/lib/processMatrix.ts"))};
import { alvoDePedido, descartarResposta, bloqueioDeConsentimentoAplica, revalidarAntesDoEnvio } from ${JSON.stringify(urlModulo("src/lib/matrixRequestMachine.ts"))};
import { isLocalSecurityQuestion } from ${JSON.stringify(urlModulo("src/lib/localSecurityReply.ts"))};

const R: any = { pedidos: [] as any[], abortos: 0, anexadas: [] as any[], envios: 0, gates: [] as any[], promessa: null as Promise<void> | null };
const useCallback = (fn: any) => fn;
const window = { electronAPI: null };
const API_BASE = "http://127.0.0.1:4100";
const PAGE_LABELS: any = { taskmanager: "Task Manager" };
const MAX_HISTORY = 16, MAX_RETRIES = 2, STREAM_TIMEOUT_MS = 5_000;
const authHeaders = () => ({ Authorization: "Bearer fixture-sem-segredo" });
const offlineReply = (_t: string, _p: any) => ({ content: "offline", isOffTopic: false, isDanger: false });
const shouldDiscardLateAnswer = (_i: any) => false;
const answerLocalSecurityQuestion = async () => null;
const cancelLocalSecurityRequest = (c: any) => { c?.abort(); };
const setInput = (_t: string) => {};
const setStreamed = (_v: string) => {};
const streamedRef = { current: "" };
const stickToBottomRef = { current: true };
const abortRef: any = { current: null };
const questionGenerationRef = { current: 0 };
const pedidoActivoRef: any = { current: null };
const explainIdentity = "presente";
const processDiagnostic: any = { measuredAt: "2026-10-23T09:05:00.000Z", ram: { totalMb: 16384, usedMb: 12000, availableMb: 4384 }, cpuPercent: 37.5, topProcesses: [], trends: [], limitations: [], recommendations: [] };
const currentPage: any = "taskmanager";
const context = "";
const mode = "online";
const localUntilRef = { current: 0 };
const conversationId = "cnv-fixture";
const explicacaoResolvidaRef = { current: null };
const ultimoExplicacaoAutoRef: any = { current: null };
const intencaoExplicarRef: any = { current: null };
const ultimaExplicacaoLocalRef = { current: null };
const setAutorizacaoAberta = (_v: any) => {};
const setOfertaIa = (_v: any) => { R.ofertas = (R.ofertas ?? 0) + 1; };
const setUpOpenState = (_v: boolean) => {};
let explicacaoPendente: any = null;
const setExplicacaoPendente = (v: any) => { explicacaoPendente = typeof v === "function" ? v(explicacaoPendente) : v; };

let phase = "idle";
const setPhase = (v: any) => { phase = v; };
const setMode = (_v: string) => {};
let messages: any[] = [{ role: "assistant", content: "Oi! Tudo bem? Em que posso ajudar?" }];
const messagesRef = { current: messages };
const substituirMensagens = (next: any) => { messages = next; messagesRef.current = next; };
const anexarMensagem = (msg: any) => {
  if (msg.role === "assistant") intencaoExplicarRef.current = null;
  messages = [...messagesRef.current, msg];
  messagesRef.current = messages;
  R.anexadas.push(msg);
};

let explainRequest: any = null;
let processContext: any = null;
let alvoActual: any = null;
const consentimentoVivoAgora = () => alvoActual !== null;
const consentimentoExternoRef = { current: { descriptor: null, grant: null } };
const autorizacoesOneShotRef = { current: new Set<string>() };
const consentimentoBloqueadoRef = { current: false };
const contaIdRef = { current: "user_fixture" };
const chaveConsentimento = "maquina";
const aplicarConsentimentoExterno = (v: any) => { consentimentoExternoRef.current = v; };

const enc = new TextEncoder();
const eventos = ["data: {\\"delta\\":\\"resposta \\"}\\n\\n", "data: {\\"delta\\":\\"do fornecedor\\"}\\n\\n", "data: {\\"done\\":true}\\n\\n"];
const fetch = (_url: any, init: any) => {
  R.pedidos.push(JSON.parse(init.body));
  const gate: any = {};
  gate.promise = new Promise((res) => { gate.res = res; });
  R.gates.push(gate);
  return new Promise((resolve, reject) => {
    if (init.signal.aborted) { reject(Object.assign(new Error("aborted"), { name: "AbortError" })); return; }
    init.signal.addEventListener("abort", () => {
      R.abortos += 1;
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
    resolve({
      ok: true,
      body: { getReader: () => { let i = 0; return { read: async () => { await gate.promise; return i < eventos.length ? { done: false, value: enc.encode(eventos[i++]) } : { done: true }; } }; } },
      json: async () => ({}),
    });
  });
};

const processMessageRef: any = { current: null };
const enviarPeloFluxoNormal = (texto: string, forcarLocal = false) => {
  R.envios += 1;
  R.promessa = processMessageRef.current?.(texto, false, true, forcarLocal) ?? null;
};

export function definirPedido(id: number, pid: number | null, startedAt: string | null) {
  explainRequest = { id, pid: pid === null ? undefined : pid, startedAt };
  alvoActual = alvoDeExplicacao(explainRequest);
  processContext = {
    selectedProcess: {
      pid,
      name: "MsMpEng.exe",
      startedAt,
      cpuPercent: 1,
      workingSetMb: 10,
    },
    topProcesses: [],
    version: 1,
    measuredAt: "2026-10-23T09:05:00.000Z",
    ram: { totalMb: 1, usedMb: 1, availableMb: 0 },
    cpuPercent: 1,
    trends: [],
    limitations: [],
  };
}

export function correrEfeito() { ${REGIAO_EFEITO} }

${REGIAO_ENVIO}
processMessageRef.current = processMessage;

export const libertar = () => { for (const g of R.gates) g.res(); };
export const gates = () => R.gates.length;
export const temPromessa = () => R.promessa !== null;
export const promessa = () => R.promessa as unknown as Promise<void>;
export const estado = () => ({
  pedidos: R.pedidos.length,
  abortos: R.abortos,
  envios: R.envios,
  anexadas: R.anexadas.map((m: any) => ({ role: m.role, origin: m.origin, state: m.state, content: m.content })),
  geracao: questionGenerationRef.current,
  fase: phase,
  pendente: explicacaoPendente,
  mensagensUtilizador: messagesRef.current.filter((m: any) => m.role === "user").length,
});
`;
  const ficheiro = dir + "/ciclo.ts";
  writeFileSync(ficheiro, prelude);
  return import("file:///" + ficheiro.replaceAll("\\", "/"));
}

test("A: «Explicar» responde localmente e o segundo clique do mesmo alvo/pergunta não duplica", async () => {
  const m = await criar();
  m.definirPedido(1, A.pid, A.startedAt);
  m.correrEfeito();
  assert.equal(m.estado().pedidos, 0, "o clique NÃO contacta o fornecedor");
  assert.equal(m.estado().envios, 0);
  assert.equal(m.estado().anexadas.length, 1, "resposta local imediata");
  assert.equal(m.estado().anexadas[0].origin, "local");
  assert.equal(m.estado().anexadas[0].state, "local");
  const geracaoLocal = m.estado().geracao;

  m.definirPedido(2, A.pid, A.startedAt);
  m.correrEfeito();

  const antes = m.estado();
  assert.equal(antes.anexadas.length, 1, "o segundo clique não responde outra vez");
  assert.equal(antes.pedidos, 0);
  assert.equal(antes.abortos, 0, "e não aborta nada do mesmo pedido");
  assert.equal(antes.geracao, geracaoLocal, "nem invalida a resposta já dada");
});

test("duplo clique antes de qualquer commit: uma só resposta local", async () => {
  const m = await criar();
  m.definirPedido(1, A.pid, A.startedAt);
  m.correrEfeito();
  m.definirPedido(2, A.pid, A.startedAt);
  m.correrEfeito();
  m.definirPedido(3, A.pid, A.startedAt);
  m.correrEfeito();
  assert.equal(m.estado().anexadas.length, 1);
  assert.equal(m.estado().pedidos, 0);
});

test("mesmo PID com OUTRA instância não é suprimido: é outro alvo", async () => {
  const m = await criar();
  m.definirPedido(1, A.pid, A.startedAt);
  m.correrEfeito();
  const geracaoAntes = m.estado().geracao;
  m.definirPedido(2, A_OUTRA.pid, A_OUTRA.startedAt);
  m.correrEfeito();
  const e = m.estado();
  assert.equal(e.anexadas.length, 2, "outra instância do mesmo PID é outra intenção");
  assert.equal(e.envios, 0);
  assert.equal(e.geracao, geracaoAntes + 1, "o pedido novo abre a sua própria geração");
  assert.equal(e.abortos, 0, "sem envio em voo, nada para abortar");
});

test("outro processo com o MESMO texto não é suprimido", async () => {
  const m = await criar();
  m.definirPedido(1, A.pid, A.startedAt);
  m.correrEfeito();
  m.definirPedido(2, B.pid, B.startedAt);
  m.correrEfeito();
  assert.equal(m.estado().anexadas.length, 2);
  assert.equal(m.estado().pedidos, 0);
});

test("re-clicar com os MESMOS dados não duplica o diagnóstico local", async () => {
  const m = await criar();
  m.definirPedido(1, A.pid, A.startedAt);
  m.correrEfeito();
  assert.equal(m.estado().anexadas.length, 1);

  m.definirPedido(2, A.pid, A.startedAt);
  m.correrEfeito();
  assert.equal(m.estado().anexadas.length, 1, "dados iguais = o mesmo diagnóstico");
  assert.equal(m.estado().pedidos, 0);
});
