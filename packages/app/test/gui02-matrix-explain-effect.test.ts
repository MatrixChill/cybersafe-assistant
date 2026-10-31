import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * TP-GUI02 — «Explicar na MATRIX» com o mesmo pedido.
 *
 * O efeito real é recortado do componente e executado com spies. Uma reexecução
 * do efeito (é o que acontece quando `setUpOpenState` muda de identidade ao
 * alternar floating/docked) tem de parar na guarda ANTES de incrementar a
 * geração, cancelar o pedido em curso, mudar a fase ou abrir/reabrir o painel.
 */

const SRC = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");
const marcador = "if (!explainRequest) return";
const iMarcador = SRC.indexOf(marcador);
const inicio = SRC.lastIndexOf("useEffect", iMarcador);
// Fim pelo prefixo da lista de dependências, não pela lista inteira: este efeito
// passou a depender do contexto e do consentimento, e encravatar a lista antiga
// fazia este corte rebentar sem qualquer perda de comportamento.
const fim = SRC.indexOf("}, [explainRequest", iMarcador);
assert.ok(inicio >= 0 && fim > inicio, "o efeito de Explicar deixou de ter a forma esperada");
const bloco = SRC.slice(inicio, fim);
const corpo = bloco.slice(bloco.indexOf("{") + 1);

const urlModulo = (rel: string) => new URL(rel, new URL("../", import.meta.url)).href;
const temporarios: string[] = [];
after(() => {
  for (const dir of temporarios) rmSync(dir, { recursive: true, force: true });
});

async function correr() {
  const dir = mkdtempSync(tmpdir() + "/cybersafe-gui02-explain-");
  temporarios.push(dir);
  const prelude = `
import { deveAutoEnviarExplicacao, promptDeExplicacaoDeProcesso, devePedirAutorizacaoAntes } from ${JSON.stringify(urlModulo("src/lib/matrixConversation.ts"))};
import { alvoDeExplicacao, consentValeParaAlvo, autorizacaoValida, isProcessQuestion, identidadeDeExplicacaoPerdida, buildProcessLocalReply } from ${JSON.stringify(urlModulo("src/lib/processMatrix.ts"))};
const estado = { cancelamentos: 0, fases: 0, aberturas: 0, inputs: 0, envios: 0, forcar: null as boolean | null, pendentes: 0, locais: 0, ofertas: 0 };
const setStreamed = (_v: string) => {};
const streamedRef = { current: "" };
const anexarMensagem = (_m: any) => { estado.locais += 1; };
const setOfertaIa = (_v: any) => { estado.ofertas += 1; };
const processDiagnostic: any = { measuredAt: "2026-10-23T09:05:00.000Z", ram: { totalMb: 16000, usedMb: 8000, availableMb: 8000 }, cpuPercent: 5, topProcesses: [{ pid: 4712, name: "MsMpEng.exe", startedAt: "2026-10-23T01:00:00.000Z", cpuPercent: 1, workingSetMb: 10 }], trends: [], limitations: [], observations: [], recommendations: [] };
let explainRequest: { id: number; pid?: number; startedAt?: string | null } | null = { id: 7, pid: 4712, startedAt: "2026-10-23T01:00:00.000Z" };
// O alvo deste fixture está AUTORIALIZADO: o que este teste prova é a GUARDA e a
// deduplicação por id no caminho de envio. O gate de autorização (que segura o
// envio quando falta consentimento) é provado em matrix-consent-pipeline.test.ts.
const processContext: any = { selectedProcess: { pid: 4712, name: "MsMpEng.exe", startedAt: "2026-10-23T01:00:00.000Z" } };
const explainIdentity = "presente";
const processConsent = true;
const consentAlvo: any = alvoDeExplicacao(explainRequest);
const alvoExplicacao = alvoDeExplicacao(explainRequest ?? null);
const consentimentoProcessoEfectivo = processConsent && consentValeParaAlvo(consentAlvo, alvoExplicacao);
import { alvoDePedido, descartarResposta, traceDePedido } from ${JSON.stringify(urlModulo("src/lib/matrixRequestMachine.ts"))};
const conversationId = "cnv-fixture";
const alvoActual = alvoDeExplicacao(explainRequest ?? null) ?? (processContext && processContext.selectedProcess ? { pid: processContext.selectedProcess.pid, startedAt: processContext.selectedProcess.startedAt ?? null } : null);
const autorizacoes = processConsent && consentAlvo ? [{ alvo: consentAlvo, concedidoEm: Date.now() }] : [];
const consentimentoVivoAgora = () => autorizacaoValida(autorizacoes, alvoActual, Date.now());
const pedidoActivoRef = { current: null };
let explicacaoPendente: any = null;
const setExplicacaoPendente = (v: any) => { explicacaoPendente = typeof v === "function" ? v(explicacaoPendente) : v; if (explicacaoPendente) estado.pendentes += 1; };
const setAutorizacaoAberta = (_v: any) => {};
const ultimoExplicacaoAutoRef: { current: number | null } = { current: null };
const intencaoExplicarRef: { current: string | null } = { current: null };
const ultimaExplicacaoLocalRef = { current: null };
const questionGenerationRef = { current: 0 };
const abortRef: { current: AbortController | null } = { current: null };
const processMessageRef: { current: ((texto: string, isRetry?: boolean, forcar?: boolean) => Promise<void>) | null } = {
  current: (_texto, _retry, forcar) => { estado.envios += 1; estado.forcar = forcar ?? null; return Promise.resolve(); },
};
const enviarPeloFluxoNormal = (t: string) => processMessageRef.current?.(t, false, true);
const cancelLocalSecurityRequest = (_c: AbortController | null) => { estado.cancelamentos += 1; };
const setPhase = (_p: string) => { estado.fases += 1; };
const setUpOpenState = (_v: boolean) => { estado.aberturas += 1; };
const setInput = (_t: string) => { estado.inputs += 1; };

export function correrEfeito() {${corpo}}

export function mudarPedido(id: number) { explainRequest = { ...explainRequest, id }; }
// Uma resposta chegou: a intenção em voo fecha e o mesmo botão volta a poder ser usado.
export function respostaChegou() { intencaoExplicarRef.current = null; }
export function resultado() {
  return { ...estado, geracao: questionGenerationRef.current, ultimoId: ultimoExplicacaoAutoRef.current };
}
`;
  const ficheiro = dir + "/efeito.ts";
  writeFileSync(ficheiro, prelude);
  return import("file:///" + ficheiro.replaceAll("\\", "/"));
}

test("o mesmo id reexecutado (mudança de modo) não cancela, invalida nem envia outra vez", async () => {
  const m = await correr();
  m.correrEfeito();
  assert.deepEqual(m.resultado(), {
    cancelamentos: 0,
    fases: 1,
    aberturas: 1,
    inputs: 0,
    envios: 0,
    forcar: null,
    pendentes: 0,
    geracao: 1,
    ultimoId: 7,
    locais: 1,
    ofertas: 1,
  }, "o clique responde localmente, sem envio ao fornecedor");

  // Reexecução do efeito com o MESMO pedido — é o caminho de floating ↔ docked.
  m.correrEfeito();
  assert.deepEqual(m.resultado(), {
    cancelamentos: 0,
    fases: 1,
    aberturas: 1,
    inputs: 0,
    envios: 0,
    forcar: null,
    pendentes: 0,
    geracao: 1,
    ultimoId: 7,
    locais: 1,
    ofertas: 1,
  }, "a guarda tem de estar antes dos efeitos destrutivos");
});

test("segundo clique no MESMO alvo e pergunta, antes de resposta: uma só resposta local", async () => {
  const m = await correr();
  m.correrEfeito();
  m.mudarPedido(8);
  m.correrEfeito();
  const r = m.resultado();
  assert.equal(r.locais, 1, "a mesma intenção não pode responder duas vezes");
  assert.equal(r.envios, 0, "e não pode ir ao fornecedor sem um pedido explícito de IA");
  assert.equal(r.cancelamentos, 0, "sem pedido em voo não há nada para cancelar");
  assert.equal(r.geracao, 1);
  assert.equal(r.ultimoId, 8, "o segundo id fica consumido (sem novo ciclo)");
});

test("um pedido novo depois de uma resposta continua a processar uma única vez", async () => {
  const m = await correr();
  m.correrEfeito();
  m.respostaChegou();
  m.mudarPedido(8);
  m.correrEfeito();
  m.correrEfeito();
  const r = m.resultado();
  assert.equal(r.locais, 1, "com os MESMOS dados não se duplica o diagnóstico");
  assert.equal(r.envios, 0);
  assert.equal(r.cancelamentos, 0);
  assert.equal(r.geracao, 1, "e não invalida a explicação já dada");
  assert.equal(r.aberturas, 1);
  assert.equal(r.ultimoId, 8);
});
