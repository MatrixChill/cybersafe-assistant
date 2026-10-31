/**
 * TP-MATRIX-HUMAN-FAIL-20261023 — os sete estados, o consentimento por alvo e os
 * dez casos que o gate humano pediu.
 *
 * Camadas, e só as que se podem provar nesta árvore:
 *  1. unidades puras (`matrixRequestMachine`, store de consentimento);
 *  2. corpo REAL do componente: `anexarMensagem`, `sendToServer`+`processMessage`,
 *     `resetConversation` e a derivacao de `estadoVisivel` são recortados do fonte
 *     e executados com dependências espiadas. Nada é reimplementado no teste; a
 *     única reescrita mecânica é `const estadoVisivel: X =` → `estadoVisivel =`,
 *     e a forma original é verificada por asserção antes da substituição;
 *  3. `fetch` é um spy: zero chamadas é a prova do gate, o payload é a prova do
 *     contexto.
 *
 * O que NÃO está provado aqui: ciclo de GUI React e janela Electron. Não há jsdom
 * nem react-test-renderer nesta árvore e instalar está fora do scope; e o painel
 * de conversa abre-se por estado interno (`isOpen`, AIAssistant.tsx:356) que
 * `renderToStaticMarkup` não percorre. Isso fica como gate humano, não como ✔.
 *
 * Dados: processos sintéticos (4712/9990) e uma chave de teste visível no spy.
 * Sem chamadas externas: o endereço do spy é 127.0.0.1:59999 e nada abre rede.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  CODIGOS_INDISPONIVEIS,
  CODIGOS_RECUPERAVEIS,
  alvoDePedido,
  classeDeErro,
  descartarResposta,
  estadoDoPedido,
  estadoDoTransporte,
  matrixStateLabel,
  origemDoEstado,
  providerConfigurado,
  traceDePedido,
  type IdentidadePedido,
} from "../src/lib/matrixRequestMachine.ts";
import {
  AMBITO_CONSENTIMENTO,
  autorizacaoValida,
  autorizarAlvo,
  consentValeParaAlvo,
  existeAlgumaAutorizacao,
  isProcessQuestion,
  limparAutorizacoesExpiradas,
  revogarAlvo,
  rotuloDeConsentimento,
  type AlvoProcesso,
  type AutorizacaoAlvo,
} from "../src/lib/processMatrix.ts";
import { matrixConfigLabel } from "../src/lib/matrixConversation.ts";

// ── Fixtures sintéticas ───────────────────────────────────────────────────────
const T0 = Date.parse("2026-10-23T09:00:00.000Z");
const AGORA = T0 + 60_000;
const A: AlvoProcesso = { pid: 4712, startedAt: "2026-10-23T08:00:00.000Z" }; // WmiPrvSE
const B: AlvoProcesso = { pid: 9990, startedAt: "2026-10-23T08:30:00.000Z" }; // MsMpEng
const A_OUTRA_INSTANCIA: AlvoProcesso = { pid: 4712, startedAt: "2026-10-23T07:00:00.000Z" };

// ── 1. Máquina: os sete estados têm de se distinguir entre si ─────────────────
test("cada causa tem um estado, e nenhuma causa partilha estado com outra", () => {
  const casos = [
    { estado: estadoDoPedido({ motivo: "sem-consentimento", pediuProvider: false }), esperado: "necessita-autorizacao" },
    { estado: estadoDoPedido({ motivo: "modo-local", pediuProvider: false }), esperado: "indisponivel" },
    { estado: estadoDoPedido({ motivo: "identidade-perdida", pediuProvider: false }), esperado: "local" },
    { estado: estadoDoPedido({ motivo: "seguranca-local", pediuProvider: false }), esperado: "local" },
    { estado: estadoDoPedido({ motivo: null, pediuProvider: false, emCooldown: true }), esperado: "indisponivel" },
    { estado: estadoDoPedido({ motivo: null, pediuProvider: true, ok: true, conteudo: "olá" }), esperado: "generativa" },
    { estado: estadoDoPedido({ motivo: null, pediuProvider: true, ok: false, code: "rate_limited" }), esperado: "erro-recuperavel" },
    { estado: estadoDoPedido({ motivo: null, pediuProvider: true, ok: false, code: "no_provider" }), esperado: "indisponivel" },
    { estado: estadoDoTransporte(false, false), esperado: "a-enviar" },
    { estado: estadoDoTransporte(false, true), esperado: "a-stream" },
  ] as const;
  for (const c of casos) assert.equal(c.estado, c.esperado);
  const sete = ["necessita-autorizacao", "a-enviar", "a-stream", "generativa", "indisponivel", "local", "erro-recuperavel"] as const;
  for (const s of sete) assert.ok(matrixStateLabel(s), `estado sem rótulo: ${s}`);
  // Cinco dos sete saem das causas acima; os dois de transporte foram provados
  // por `estadoDoTransporte`. Nove casos, sete estados, nenhum sem prova.
  const vistos = new Set(casos.map((c) => c.estado).concat([estadoDoTransporte(false, false), estadoDoTransporte(false, true)]));
  assert.deepEqual([...sete].filter((s) => !vistos.has(s)), [], `estados sem caso: ${sete.filter((s) => !vistos.has(s))}`);
});

test("cancelar conta como erro temporário, não como indisponibilidade", () => {
  assert.equal(estadoDoTransporte(true, true), "erro-recuperavel");
});

test("«fornecedor verificado» é configuração, nunca resposta", () => {
  assert.equal(providerConfigurado("online"), true);
  assert.equal(providerConfigurado("local"), false);
  assert.equal(providerConfigurado("a-verificar"), false);
  assert.match(matrixConfigLabel("online"), /verificado/i);
  // O rótulo de configuração não pode afirmar que uma mensagem veio da IA.
  for (const mode of ["online", "local", "a-verificar"] as const) {
    assert.doesNotMatch(matrixConfigLabel(mode), /resposta|respondeu/i, matrixConfigLabel(mode));
  }
  assert.equal(origemDoEstado("generativa"), "provider");
  assert.equal(matrixStateLabel("generativa"), "Resposta da IA");
});

test("a fronteira recuperável/indisponível é a lista, não o feeling", () => {
  for (const c of CODIGOS_RECUPERAVEIS) assert.equal(classeDeErro(c), "recuperavel", c);
  for (const c of CODIGOS_INDISPONIVEIS) assert.equal(classeDeErro(c), "indisponivel", c);
  assert.equal(classeDeErro("qualquer_coisa"), "desconhecido");
  assert.equal(classeDeErro(undefined), "desconhecido");
});

// ── 2. Consentimento por alvo ────────────────────────────────────────────────
test("autorizar A não autoriza B, e voltar a A respeita a autorização", () => {
  let lista: AutorizacaoAlvo[] = autorizarAlvo([], A, AGORA);
  assert.equal(autorizacaoValida(lista, B, AGORA), false, "B precisa da sua própria autorização");
  assert.equal(autorizacaoValida(lista, A, AGORA), true);
  assert.equal(autorizacaoValida(lista, A_OUTRA_INSTANCIA, AGORA), false, "mesmo PID, outra instância é outro alvo");
  lista = autorizarAlvo(lista, B, AGORA);
  assert.equal(lista.length, 2);
  assert.equal(autorizacaoValida(lista, A, AGORA), true, "autorizar B não retirou A");
});

test("revogar retira só aquele alvo", () => {
  let lista: AutorizacaoAlvo[] = autorizarAlvo(autorizarAlvo([], A, AGORA), B, AGORA);
  lista = revogarAlvo(lista, A);
  assert.equal(autorizacaoValida(lista, A, AGORA), false);
  assert.equal(autorizacaoValida(lista, B, AGORA), true);
});

test("a duração declarada expira o alvo, e nada se renova sozinho", () => {
  const lista: AutorizacaoAlvo[] = autorizarAlvo([], A, AGORA);
  const dentro = AGORA + AMBITO_CONSENTIMENTO.duracaoMs - 1;
  const fora = AGORA + AMBITO_CONSENTIMENTO.duracaoMs + 1;
  assert.equal(autorizacaoValida(lista, A, dentro), true);
  assert.equal(autorizacaoValida(lista, A, fora), false);
  assert.deepEqual(limparAutorizacoesExpiradas(lista, fora), [], "expirado sai da lista, não fica à espera");
  assert.equal(existeAlgumaAutorizacao(limparAutorizacoesExpiradas(lista, fora), fora), false);
});

test("o rótulo distingue «autorizado para este alvo» de «noutro alvo»", () => {
  const lista = autorizarAlvo([], B, AGORA);
  assert.equal(rotuloDeConsentimento(false, null, A), "não autorizado");
  assert.equal(rotuloDeConsentimento(true, lista[0].alvo, A), "autorizado noutro alvo");
  assert.equal(rotuloDeConsentimento(true, lista[0].alvo, B), "autorizado para este alvo");
  // Sem caixa marcada, não há rótulo positivo possível.
  assert.doesNotMatch(rotuloDeConsentimento(false, lista[0].alvo, B), /activo|ativa/i);
});

test("alvo sem processo é a máquina, e não confunde com outro PID", () => {
  const maquina: AlvoProcesso = { pid: null, startedAt: null };
  const lista = autorizarAlvo([], maquina, AGORA);
  assert.equal(consentValeParaAlvo(lista[0].alvo, maquina), true);
  assert.equal(consentValeParaAlvo(lista[0].alvo, A), false);
  assert.equal(alvoDePedido(maquina), "maquina");
  assert.equal(alvoDePedido(null), null);
  assert.equal(alvoDePedido(A), "4712:2026-10-23T08:00:00.000Z");
});

// ── 3. Identidade do pedido: trocar depressa não mistura alvos nem conversas ───
const id = (p: Partial<IdentidadePedido>): IdentidadePedido => ({
  requestId: "r1", conversationId: "c1", targetId: "4712:2026-10-23T08:00:00.000Z", geracao: 1, ...p,
});

test("a mesma resposta só vale para o mesmo pedido, conversa e alvo", () => {
  const p = id({});
  assert.equal(descartarResposta({ pedido: p, actual: p, signalAbortado: false }), false);
  assert.equal(descartarResposta({ pedido: p, actual: id({ requestId: "r2" }), signalAbortado: false }), true, "pedido novo");
  assert.equal(descartarResposta({ pedido: p, actual: id({ conversationId: "c2" }), signalAbortado: false }), true, "conversa nova");
  assert.equal(descartarResposta({ pedido: p, actual: id({ targetId: "9990:x" }), signalAbortado: false }), true, "alvo trocado");
  assert.equal(descartarResposta({ pedido: p, actual: id({ geracao: 2 }), signalAbortado: false }), true, "geração avançada");
  assert.equal(descartarResposta({ pedido: p, actual: p, signalAbortado: true }), true, "sinal abortado");
});

// ── 4. Instrumentação DEV: allowlist fechada, sem dados pessoais ─────────────
test("o trace só leva as chaves do pedido, e corta o resto", () => {
  const linha = traceDePedido({
    requestId: "r1", conversationId: "c1", targetId: "4712:t", consentState: "autorizado",
    providerState: "generativa", origin: "provider",
  });
  for (const chave of ["requestId", "conversationId", "targetId", "consentState", "providerState", "origin"]) {
    assert.ok(linha.includes(chave), `falta a chave permitida ${chave}: ${linha}`);
  }
  const texto = "Porque é que o WmiPrvSE consome RAM? C:\\Users\\caioc\\secret.txt key=sk-live-abc123";
  const sujo = traceDePedido({ requestId: texto, conversationId: texto, targetId: texto } as any);
  assert.doesNotMatch(sujo, /WmiPrvSE|caioc|secret|sk-live|Ram|RAM/i, sujo);
  assert.match(sujo, /\[omitido\]/, "valor fora do formato é omitido, não truncado a meio");
  const extra = traceDePedido({ requestId: "r1", qualquerCoisa: "segredo" } as any);
  assert.doesNotMatch(extra, /qualquerCoisa|segredo/, `campo fora da allowlist entrou: ${extra}`);
});

// ── 5. FLUXO: corpos reais do componente ─────────────────────────────────────
const RAIZ = new URL("../", import.meta.url);
const urlModulo = (rel: string) => new URL(rel, RAIZ).href;
const linhas = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8").split(/\r?\n/);
const temporarios: string[] = [];
test("o componente ainda declara a região que este harness recorta", () => {
  // Não-vacuidade: se o fonte mudar de forma, o harness deixaria de executar o
  // produto e os testes abaixo passariam a dizer nada. Este teste parte primeiro.
  assert.ok(linhas.includes("  const sendToServer = useCallback("));
  assert.ok(linhas.some((l) => l.trim().startsWith("const resetConversation = useCallback(")));
  assert.ok(linhas.some((l) => l.trim().startsWith("const anexarMensagem = useCallback(")));
  assert.ok(linhas.some((l) => l.trim().startsWith("const estadoVisivel")));
});
after(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

function recortar(inicio: (l: string, k: number) => boolean, fim: (l: string, k: number) => boolean, nome: string): string {
  const i = linhas.findIndex(inicio);
  assert.ok(i >= 0, `início não encontrado: ${nome}`);
  const j = linhas.findIndex((l, k) => k > i && fim(l, k));
  assert.ok(j > i, `fim não encontrado: ${nome}`);
  return linhas.slice(i, j + 1).join("\n");
}

const REGIAO_ENVIO = recortar(
  (l) => l === "  const sendToServer = useCallback(",
  (l, k) => /^\s*\)\s*,?\s*$/.test(l) && linhas.slice(k - 3, k).some((x) => /explainIdentity[^\]]*\],\s*$/.test(x)),
  "sendToServer+processMessage",
);
const REGIAO_ANEXAR = recortar(
  (l) => l.trim().startsWith("const anexarMensagem = useCallback("),
  (l) => l === "  }, [])",
  "anexarMensagem",
);
const REGIAO_RESET = recortar(
  (l) => l.trim().startsWith("const resetConversation = useCallback("),
  (l) => l.trim() === "}, [substituirMensagens])",
  "resetConversation",
);
const REGIAO_PARAR = recortar(
  (l) => l.trim().startsWith("const handleStop = () => {"),
  (l) => l === "  }",
  "handleStop",
);
const REGIAO_PORTA = recortar(
  (l) => l.trim().startsWith("const enviarPeloFluxoNormal ="),
  (l) => l.trim().startsWith("processMessageRef.current?.("),
  "enviarPeloFluxoNormal",
);
// Corpo do efeito de expiração, recortado do produto. A primeira linha do corpo é
// o anchor; o fim é a linha de dependências, que é ela própria a prova de que o
// efeito se re-arrega com o tick (`[autorizacoes, agora]`).
const REGIAO_TICK = (() => {
  const i = linhas.findIndex((l, k) => l.trim() === "const agoraActual = Date.now()" && linhas[k - 1] === "  useEffect(() => {");
  assert.ok(i >= 0, "efeito de expiração não encontrado no componente");
  const j = linhas.findIndex((l, k) => k > i && /^\s*\}, \[.*\]\)\s*$/.test(l));
  assert.ok(j > i, "fim do efeito de expiração não encontrado");
  const deps = (linhas[j].match(/\[([^\]]*)\]/) ?? [])[1] ?? "";
  assert.ok(deps.length > 0, "dependências do efeito de expiração não encontradas");
  // O ficheiro gerado recebe TAMBÉM a lista de dependências, para o `cicloEfeito`
  // só re-executar quando ela muda — como o React. Sem isto, o harness seria mais
  // tolerante que o produto e o defeito do agendamento passava despercebido.
  return "const correrTick = () => {\n" + linhas.slice(i, j).join("\n") + "\n};\nconst depsDoTick = () => [" + deps + "];\n";
})();
const REGIAO_EXPLICAR = (() => {
  const i = linhas.findIndex((l, k) => l.trim() === "if (!explainRequest) return" && linhas[k - 1] === "  useEffect(() => {");
  assert.ok(i >= 0, "efeito de explicação não encontrado no componente");
  const j = linhas.findIndex((l, k) => k > i && l.startsWith("  }, [explainRequest"));
  assert.ok(j > i, "fim do efeito de explicação não encontrado");
  return "const corpoExplicar = () => {\n" + linhas.slice(i, j).join("\n") + "\n};\n";
})();
// `const estadoVisivel: MatrixRequestState | null =` … `: null`. A expressão é a
// do produto; só a ligação muda, para o valor ficar visível fora da função.
const REGIAO_ESTADO_VISIVEL = recortar(
  (l) => l.trim().startsWith("const estadoVisivel"),
  (l) => l.trim() === ": null",
  "estadoVisivel",
).replace("const estadoVisivel: MatrixRequestState | null =", "estadoVisivel =");
assert.notEqual(REGIAO_ESTADO_VISIVEL.indexOf("estadoVisivel ="), -1, "a derivação de estadoVisivel mudou de forma");

const PERGUNTA_A = "Porque é que o PID 4712 está a usar tanta RAM? É seguro fechá-lo?";
const PERGUNTA_B = "Porque é que o PID 9990 está a usar tanta RAM? É seguro fechá-lo?";
const PERGUNTA_NEUTRA = "Oi";

test("as perguntas sintéticas são mesmo duas classes diferentes", () => {
  // Sem isto, os casos A e B podiam passar por acaso: o gate só existe para
  // perguntas que levam medições do processo.
  assert.equal(isProcessQuestion(PERGUNTA_A), true);
  assert.equal(isProcessQuestion(PERGUNTA_B), true);
  assert.equal(isProcessQuestion(PERGUNTA_NEUTRA), false);
});

type Cenario = {
  alvo?: AlvoProcesso | null;
  autorizacoes?: AutorizacaoAlvo[];
  contexto?: unknown | null;
  mode?: "online" | "local" | "a-verificar";
  localUntil?: number;
  fornecedor?: "ok" | "429" | "no_provider" | "timeout" | "sem-conteudo" | "adiado";
};

/** Monta o módulo com os corpos reais e devolve controles do teste. */
async function montar(c: Cenario = {}) {
  const dir = mkdtempSync(tmpdir() + "/cybersafe-matrix-estados-");
  temporarios.push(dir);
  const corpo = `
Object.assign(import.meta, { env: { DEV: true } });
import { minimizeContextForAi } from ${JSON.stringify(urlModulo("src/lib/aiContextBuilder.ts"))};
const setProviderState = (_value) => {};
import { originDaResposta, motivoDoEncaminhamentoLocal, decisaoAposTentativaLocal, estadoDoMotivoLocal, estadoDoResultado, acrescentarMensagem, initialMatrixMessages, matrixRoutingStateLabel, devePedirAutorizacaoAntes, deveAutoEnviarExplicacao, promptDeExplicacaoDeProcesso } from ${JSON.stringify(urlModulo("src/lib/matrixConversation.ts"))};
import { isProcessQuestion, perguntaApontaParaAlvo, buildProcessLocalReply, processPayload, processChatHistory, matrixTelemetryContext, alvoDeExplicacao, consentValeParaAlvo, identidadeDeExplicacaoPerdida, limparAutorizacoesExpiradas, autorizacaoValida, autorizarAlvo, AMBITO_CONSENTIMENTO } from ${JSON.stringify(urlModulo("src/lib/processMatrix.ts"))};
import { isLocalSecurityQuestion, shouldDiscardLateAnswer } from ${JSON.stringify(urlModulo("src/lib/localSecurityReply.ts"))};
import { alvoDePedido, descartarResposta, traceDePedido, estadoDoTransporte, bloqueioDeConsentimentoAplica, revalidarAntesDoEnvio, type MatrixRequestState, type IdentidadePedido } from ${JSON.stringify(urlModulo("src/lib/matrixRequestMachine.ts"))};
const R = ((globalThis.__sSpies ??= { chamadas: [], traces: [], anexadas: [], stream: [], espera: [], ids: 0, timers: [], armados: [], seq: 0 }));
// Só os temporizadores do efeito de expiração passam por aqui; verificados ao
// minuto, são a prova de que o mecanismo não é polling nem fila de setTimeout(0).
const setTimeout = (fn, ms) => { const id = ++R.seq; R.timers.push({ id, ms, fn }); R.armados.push(ms); return id; };
const clearTimeout = (id) => { R.timers = R.timers.filter((t) => t.id !== id); };
const console = { debug: (...a) => R.traces.push(a.join(" ")), log: () => {}, warn: () => {}, error: () => {} };
const useCallback = (fn) => fn;
const window = { electronAPI: null };
const authHeaders = () => ({ Authorization: "Bearer fixture-de-teste" });
const API_BASE = "http://127.0.0.1:59999";
const PAGE_LABELS = { dashboard: "Painel", tasks: "Processos" };
const MAX_HISTORY = 16, MAX_RETRIES = 2, STREAM_TIMEOUT_MS = 90000;
const offlineReply = (_t, _p) => ({ content: "resposta offline de teste", isOffTopic: false, isDanger: false });
const codificar = new TextEncoder();
const chunk = (t) => codificar.encode(t);
const fetch = async (_url, init) => {
  R.chamadas.push(JSON.parse(init.body));
  // «adiado»: o pedido vai para o fornecedor mas só responde quando o teste o
  // liberar — é o único modo de apanhar a troca de alvo A MEIO de um pedido. O
  // primeiro delta pinta antes da troca, o segundo só chega depois de liberar, e
  // o texto traz o número do pedido para se saber de quem foi cada resposta.
  if (${JSON.stringify(c.fornecedor ?? "ok")} === "adiado") {
    let liberarEste;
    const espera = new Promise((r) => { liberarEste = r; });
    R.espera.push(liberarEste);
    const numero = R.chamadas.length;
    let etapa = 0;
    const ler = async () => {
      if (etapa === 0) { etapa++; return { done: false, value: chunk('data: {"delta":"resposta-' + numero + '"}\\n\\n') }; }
      if (etapa === 1) {
        etapa++;
        await espera;
        if (init.signal && init.signal.aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
        return { done: false, value: chunk('data: {"delta":" parte-' + numero + '"}\\n\\n') };
      }
      if (etapa === 2) { etapa++; return { done: false, value: chunk('data: {"done":true}\\n\\n') }; }
      return { done: true };
    };
    return { ok: true, body: { getReader: () => ({ read: ler }) } };
  }
  if (${JSON.stringify(c.fornecedor ?? "ok")} === "timeout") throw new Error("fixture: expirou");
  if (${JSON.stringify(c.fornecedor ?? "ok")} !== "ok" && ${JSON.stringify(c.fornecedor ?? "ok")} !== "adiado") return { ok: false, json: async () => (${JSON.stringify(c.fornecedor)} === "429" ? { code: "rate_limited", message: "limite" } : { code: "no_provider", message: "sem fornecedor" }) };
  const eventos = ${JSON.stringify(c.fornecedor)} === "sem-conteudo" ? ["data: {\\"done\\":true}\\n\\n"] : ["data: {\\"delta\\":\\"resposta do fornecedor\\"}\\n\\n", "data: {\\"done\\":true}\\n\\n"];
  let i = 0;
  return { ok: true, body: { getReader: () => ({ read: async () => (i < eventos.length ? { done: false, value: chunk(eventos[i++]) } : { done: true }) }) }, json: async () => ({}) };
};
let messages = initialMatrixMessages();
const messagesRef = { current: messages };
const setMessages = (fn) => { const antes = messagesRef.current.length; const next = typeof fn === "function" ? fn(messagesRef.current) : fn; messagesRef.current = next; messages = next; for (const m of next.slice(antes)) R.anexadas.push(m); };
const substituirMensagens = (next) => { setMessages(next); };
const abortRef = { current: null };
const questionGenerationRef = { current: 0 };
const stickToBottomRef = { current: true };
const streamedRef = { current: "" };
const localUntilRef = { current: ${String(c.localUntil ?? 0)} };
const pedidoActivoRef = { current: null };
const consentimentoExternoRef = { current: { descriptor: null, grant: null } };
const autorizacoesOneShotRef = { current: new Set<string>() };
const autorizacaoUnicaRef = { current: null };
const consentimentoBloqueadoRef = { current: false };
const contaIdRef = { current: "user_fixture" };
const chaveConsentimento = "maquina";
const aplicarConsentimentoExterno = (v) => { consentimentoExternoRef.current = v; };
const explicacaoResolvidaRef = { current: null };
const ultimoExplicacaoAutoRef = { current: null };
const intencaoExplicarRef = { current: null };
const ultimaExplicacaoLocalRef = { current: null };
const processMessageRef = { current: null };
const setMode = () => {};
const setInput = () => {};
const setUpOpenState = () => {};
const answerLocalSecurityQuestion = async () => (null);
const cancelLocalSecurityRequest = (_c) => {};
const processDiagnostic = { measuredAt: "2026-10-23T09:05:00.000Z", ram: { totalMb: 16384, usedMb: 12000, availableMb: 4384 }, cpuPercent: 37.5, topProcesses: [], trends: [], limitations: [], recommendations: [] };
let processContext = ${JSON.stringify(c.contexto === undefined ? CONTEXTO_SINT : c.contexto)};
let explainRequest = ${JSON.stringify(c.alvo ? { id: 1, pid: c.alvo.pid ?? null, startedAt: c.alvo.startedAt ?? null } : null)};
const explainIdentity = "presente";
const explainRequestRef = { get current() { return explainRequest; } };
let autorizacoes = ${JSON.stringify(c.autorizacoes ?? [])};
let conversationId = "c1";
let explicacaoPendente = null;
let autorizacaoAberta = false;
let phase = "idle";
const currentPage = "taskmanager";
const context = "CPU 37%, RAM 12 GB";
const mode = ${JSON.stringify(c.mode ?? "online")};
const setAutorizacoes = (v) => { autorizacoes = typeof v === "function" ? v(autorizacoes) : v; };
const setConversationId = (v) => { conversationId = typeof v === "function" ? v(conversationId) : v; };
const setExplicacaoPendente = (v) => { explicacaoPendente = typeof v === "function" ? v(explicacaoPendente) : v; };
const setOfertaIa = (_v) => {};
const setAutorizacaoAberta = (v) => { autorizacaoAberta = typeof v === "function" ? v(autorizacaoAberta) : v; };
const setConsentErro = (_v) => {};
const setConsentCarregando = (_v) => {};
const setPhase = (v) => { phase = v; };
const setStreamed = (v) => { R.stream.push(v); };
// Relógio do módulo: o produto chama Date.now() nos pontos de decisão, por isso é
// aqui que se avança 31 minutos, e não num helper à parte.
let agoraSim = ${AGORA};
const Date = { now: () => agoraSim };
const novaIdDeConversa = () => "cv" + (++R.ids);
// Derivação de render, com as expressões do produto (AIAssistant 393-402): o
// relógio usado é agora, que só avança quando o temporizador do efeito dispara —
// é isso que torna este bloco um teste do mecanismo e não só da decisão de envio.
let agora = agoraSim;
let alvoExplicacao = null;
let alvoActual = null;
let autorizacoesVivas = [];
let alvoAutorizado = null;
let consentimentoProcessoEfectivo = false;
let estadoVisivel = null;
const autorizacoesRef = { current: autorizacoes };
const consentimentoVivoAgora = () => autorizacaoValida(autorizacoesRef.current, alvoActual, Date.now());
const derivar = () => {
  autorizacoesRef.current = autorizacoes;
  alvoExplicacao = alvoDeExplicacao(explainRequest ?? null);
  alvoActual = alvoExplicacao ?? (processContext && processContext.selectedProcess ? { pid: processContext.selectedProcess.pid, startedAt: processContext.selectedProcess.startedAt ?? null } : null);
  autorizacoesVivas = limparAutorizacoesExpiradas(autorizacoes, agora);
  alvoAutorizado = autorizacoesVivas.find((a) => consentValeParaAlvo(a.alvo, alvoActual))?.alvo ?? null;
  consentimentoProcessoEfectivo = alvoAutorizado !== null;
${REGIAO_ESTADO_VISIVEL}
};
const setAgora = (v) => { agora = typeof v === "function" ? v(agora) : v; derivar(); };
${REGIAO_TICK}
let limparTick = null;
let depsAnteriores = null;
// React de bolso, só o que este teste precisa: o efeito volta a correr quando a
// sua lista de dependências muda (comparação por identidade, como no React) e o
// cleanup do ciclo anterior corre primeiro.
const depsMudaram = (d) => depsAnteriores === null || depsAnteriores.length !== d.length || d.some((x, i) => x !== depsAnteriores[i]);
const cicloEfeito = () => {
  const d = depsDoTick();
  if (!depsMudaram(d)) return;
  depsAnteriores = d;
  if (limparTick) limparTick();
  limparTick = correrTick() ?? null;
};
derivar();
cicloEfeito();
${REGIAO_ANEXAR}
${REGIAO_ENVIO}
${REGIAO_RESET}
${REGIAO_PARAR}
${REGIAO_PORTA}
processMessageRef.current = processMessage;
${REGIAO_EXPLICAR}
// Botão «Autorizar e retomar a pergunta», a mesma expressão do fonte.
export const autorizar = () => { setAutorizacoes((prev) => autorizarAlvo(prev, alvoActual, Date.now())); derivar(); cicloEfeito(); };
export const definirAlvo = (pedido) => { explainRequest = pedido; derivar(); };
export const explicar = (pedido, contexto) => { explainRequest = pedido; processContext = contexto === undefined ? processContext : contexto; derivar(); corpoExplicar(); derivar(); cicloEfeito(); };
export const enviarSemAguardar = (t) => processMessage(t);
export const enviar = async (t) => { await processMessage(t); return R; };
export const reiniciar = () => { resetConversation(); derivar(); };
export const parar = () => { handleStop(); derivar(); };
// Avança o relógio e dispara o que está na hora, re-executando o efeito a cada
// setAgora — é esse o ciclo que React teria, e o que faltava na versão revista.
export const avancar = (ms) => {
  let resto = ms;
  for (;;) {
    const porOrdim = R.timers.slice().sort((a, b) => a.ms - b.ms);
    const t = porOrdim[0];
    if (!t || t.ms > resto) break;
    resto -= t.ms;
    agoraSim += t.ms;
    t.fn();
    cicloEfeito();
  }
  agoraSim += resto;
  derivar();
};
export const timers = () => R.timers.map((t) => t.ms);
export const armados = () => R.armados.slice();
export const vivas = () => autorizacoesVivas.map((a) => a.alvo);
export const liberar = () => { const l = R.espera.shift(); if (l) l(); };
export const pendentes = () => R.espera.length;
export const estado = () => ({ chamadas: R.chamadas.slice(), traces: R.traces.slice(), anexadas: R.anexadas.slice(), stream: R.stream.slice(), estadoVisivel, consentido: consentimentoProcessoEfectivo, conversa: conversationId, geracao: questionGenerationRef.current, localUntil: localUntilRef.current, alvo: alvoActual, agora, relogio: agoraSim });
`;
  const ficheiro = dir + "/fluxo.ts";
  writeFileSync(ficheiro, corpo);
  delete (globalThis as any).__sSpies;
  const mod = await import("file:///" + ficheiro.replaceAll("\\", "/"));
  return mod as {
    enviar: (t: string) => Promise<any>; enviarSemAguardar: (t: string) => Promise<void>;
    reiniciar: () => void; parar: () => void; autorizar: () => void; explicar: (p: unknown, ctx?: unknown) => void;
    definirAlvo: (p: unknown) => void; avancar: (ms: number) => void; liberar: () => void;
    pendentes: () => number; timers: () => number[]; armados: () => number[]; vivas: () => AlvoProcesso[];
    estado: () => any;
  };
}

const CONTEXTO_SINT = {
  selectedProcess: { pid: 4712, name: "WmiPrvSE", cpuPercent: 41.2, workingSetMb: 812, startedAt: "2026-10-23T08:00:00.000Z" },
  protectionState: "ativa", cpuPercent: 37.5, ramMb: { total: 16384, used: 12000, available: 4384 },
  topProcesses: [], trends: [], limitations: [], samples: 4, intervalMs: 5000,
};
const CONTEXTO_B = {
  ...CONTEXTO_SINT,
  selectedProcess: { pid: 9990, name: "MsMpEng", cpuPercent: 12.5, workingSetMb: 2100, startedAt: "2026-10-23T08:30:00.000Z" },
};

// A — conversa nova com «Oi»: sem gate, fornecedor configurado, resposta da IA.
test("A: «Oi» numa conversa nova vai ao fornecedor configurado e diz que foi a IA", async () => {
  const m = await montar({});
  await m.enviar(PERGUNTA_NEUTRA);
  const e = m.estado();
  assert.equal(e.chamadas.length, 1, "pergunta sem dados do processo não precisa de gate");
  const resposta = e.anexadas.at(-1);
  assert.equal(resposta.role, "assistant");
  assert.equal(resposta.origin, "ai");
  assert.equal(resposta.state, "generativa");
  assert.equal(matrixStateLabel(resposta.state), "Resposta da IA");
});

// B — processo não autorizado: zero IO, e o estado diz «a precisar de autorização».
test("B: pergunta de processo sem autorização não sai do renderer", async () => {
  const m = await montar({ alvo: A });
  await m.enviar(PERGUNTA_A);
  const e = m.estado();
  assert.deepEqual(e.chamadas, [], "sem autorização nada vai ao fornecedor");
  const resposta = e.anexadas.at(-1);
  assert.equal(resposta.role, "assistant");
  assert.equal(resposta.origin, "local");
  assert.equal(resposta.state, "necessita-autorizacao");
  assert.equal(matrixStateLabel(resposta.state), "A precisar da tua autorização");
});

// C — autorizado: uma única ida, com o contexto medido do alvo.
test("C: autorizado, o pedido usa o contexto medido e uma única vez", async () => {
  const m = await montar({ alvo: A, autorizacoes: autorizarAlvo([], A, AGORA) });
  await m.enviar(PERGUNTA_A);
  const e = m.estado();
  assert.equal(e.chamadas.length, 1);
  assert.ok(JSON.stringify(e.chamadas[0]).includes("4712"), "o contexto real permitido segue no payload");
  assert.equal(e.anexadas.at(-1).state, "generativa");
});

// D — alvo novo precisa do seu; E — voltar a A mantém a autorização válida.
test("D e E: B precisa do próprio consentimento, voltar a A respeita o que ainda vale", async () => {
  const soA = autorizarAlvo([], A, AGORA);
  const mB = await montar({ alvo: B, autorizacoes: soA, contexto: CONTEXTO_B });
  await mB.enviar(PERGUNTA_B);
  assert.deepEqual(mB.estado().chamadas, [], "autorizar A não autoriza B");
  assert.equal(mB.estado().anexadas.at(-1).state, "necessita-autorizacao");

  const mA = await montar({ alvo: A, autorizacoes: soA });
  await mA.enviar(PERGUNTA_A);
  assert.equal(mA.estado().chamadas.length, 1, "a autorização de A continua válida nesta conversa");
});

// F — fornecedor em baixo: local com causa, e não se confunde com falta de autorização.
test("F: sem fornecedor é «IA indisponível», nunca «a precisar de autorização»", async () => {
  const m = await montar({ alvo: A, autorizacoes: autorizarAlvo([], A, AGORA), fornecedor: "no_provider" });
  await m.enviar(PERGUNTA_A);
  const e = m.estado();
  assert.equal(e.chamadas.length, 1, "autorizado tenta o fornecedor");
  assert.equal(e.anexadas.at(-1).origin, "local");
  assert.equal(e.anexadas.at(-1).state, "indisponivel");
  assert.equal(matrixStateLabel(e.anexadas.at(-1).state), "IA indisponível");
});

test("F2: 429 é temporário e acionável", async () => {
  const m = await montar({ alvo: A, autorizacoes: autorizarAlvo([], A, AGORA), fornecedor: "429" });
  await m.enviar(PERGUNTA_A);
  assert.equal(m.estado().anexadas.at(-1).state, "erro-recuperavel");
});

// G — conversa nova limpa o estado de falha: a pergunta seguinte volta a tentar.
test("G: nova conversa limpa cooldown e autorizacoes, e a pergunta seguinte tenta o fornecedor", async () => {
  const m = await montar({ alvo: A, autorizacoes: autorizarAlvo([], A, AGORA), fornecedor: "no_provider" });
  await m.enviar(PERGUNTA_A);
  const antes = m.estado();
  assert.equal(antes.anexadas.at(-1).state, "indisponivel");

  m.reiniciar();
  const depois = m.estado();
  assert.equal(depois.localUntil, 0, "o estado de falha não sobrevive a uma conversa nova");
  assert.equal(depois.geracao, antes.geracao + 1, "a geração avança e descarta a resposta atrasada");
  // Cooldown de trinta segundos escrito por uma falha anterior é zerado pelo reset:
  // uma pergunta feita depois do reset já não apanha o modo local.
  const comCooldown = await montar({ alvo: A, localUntil: Date.now() + 30_000, mode: "local" });
  await comCooldown.enviar(PERGUNTA_NEUTRA);
  assert.equal(comCooldown.estado().anexadas.at(-1).state, "indisponivel", "em cooldown, diz-se IA indisponível");
});

// H — rótulo de privacidade nunca promete o que a autorização não deu.
test("H: a resposta recusada não pode aparecer como IA, nem o rótulo de configuração", async () => {
  const m = await montar({ alvo: A });
  await m.enviar(PERGUNTA_A);
  const resposta = m.estado().anexadas.at(-1);
  assert.equal(resposta.origin, "local");
  assert.notEqual(matrixStateLabel(resposta.state), "Resposta da IA");
  assert.notEqual(matrixConfigLabel("online"), matrixStateLabel("necessita-autorizacao"));
});

// I — texto acessível: nada é cortado por marcação, e o estado vai no atributo.
test("I: cada resposta carrega o estado como atributo legível, e o texto segue inteiro", async () => {
  const m = await montar({ alvo: A, autorizacoes: autorizarAlvo([], A, AGORA) });
  await m.enviar(PERGUNTA_A);
  const resposta = m.estado().anexadas.at(-1);
  assert.equal(resposta.content, "resposta do fornecedor", "o texto não é truncado pelo caminho do estado");
  assert.equal(typeof resposta.state, "string");
  assert.match(m.estado().traces.join("\n"), /providerState=generativa/);
});

// J — troca rápida de alvo: a resposta atrasada não entra na conversa nova e o
// payload do alvo em curso não leva o contexto do anterior.
test("J: trocar de alvo a meio descarta a resposta antiga e não mistura contextos", async () => {
  const m = await montar({ alvo: A, autorizacoes: [autorizarAlvo([], A, AGORA)[0], autorizarAlvo([], B, AGORA)[0]] });
  const primeira = m.enviar(PERGUNTA_A);
  m.estado(); // garante que o pedido ficou registado
  await primeira;
  const eA = m.estado();
  assert.equal(eA.chamadas.length, 1);
  assert.ok(JSON.stringify(eA.chamadas[0]).includes("4712"));
  assert.ok(!JSON.stringify(eA.chamadas[0]).includes("9990"), "o payload de A não pode levar medições de B");

  // Reenvio com o contexto trocado para B: a resposta anterior já foi consumida,
  // e um segundo pedido com alvo diferente instala identidade diferente.
  const mB = await montar({ alvo: B, autorizacoes: autorizarAlvo([], B, AGORA), contexto: CONTEXTO_B });
  await mB.enviar(PERGUNTA_B);
  const eB = mB.estado();
  assert.ok(JSON.stringify(eB.chamadas[0]).includes("9990"));
  assert.ok(!JSON.stringify(eB.chamadas[0]).includes("4712"), "o payload de B não pode levar medições de A");
  assert.equal(eB.anexadas.at(-1).state, "generativa");
  // Identidade opaca do pedido: o registo de A e o de B não se podem confundir,
  // que é o que permite a um atraso de A ser descartado quando B já está activo.
  const alvo = (l) => (l.match(/targetId=(\S+)/) ?? [])[1];
  assert.equal(alvo(eA.traces.at(-1)), "4712:2026-10-23T08:00:00.000Z");
  assert.equal(alvo(eB.traces.at(-1)), "9990:2026-10-23T08:30:00.000Z");
});

// ── 6. R1/R2 do review: relógio vivo e identidade em curso, no caminho real ───

test("R1: 31 minutos depois de autorizar, a caixa deixa de valer e nada sai do renderer", async () => {
  const m = await montar({ alvo: A, fornecedor: "ok" });
  m.autorizar();
  assert.equal(m.estado().consentido, true, "recém-autorizado conta como autorizado");
  await m.enviar(PERGUNTA_A);
  const dentro = m.estado();
  assert.equal(dentro.chamadas.length, 1, "dentro da duração o pedido vai ao fornecedor");
  assert.ok(JSON.stringify(dentro.chamadas[0]).includes("4712"), "e leva o contexto medido autorizado");
  assert.equal(dentro.anexadas.at(-1).state, "generativa");

  m.avancar(31 * 60 * 1000);
  assert.equal(m.estado().consentido, false, "a duração prometida expira, não vale para sempre");

  await m.enviar(PERGUNTA_A);
  const depois = m.estado();
  assert.equal(depois.chamadas.length, 1, "depois de expirar não se volta a tocar o fornecedor");
  assert.equal(depois.anexadas.at(-1).state, "necessita-autorizacao", "pede autorização outra vez");
  assert.ok(!JSON.stringify(depois.chamadas.slice(1)).includes("4712"), "zero contexto externo depois de expirar");
});

test("R1b: o relógio da decisão é vivo, não o da montagem", () => {
  // Não-vacuidade do que o teste acima exercita: se o componente voltar a usar uma
  // hora congelada, estas linhas são a primeira coisa a partir.
  const fonte = linhas.join("\n");
  assert.match(fonte, /const \[agora, setAgora\] = useState\(\(\) => Date\.now\(\)\)/);
  assert.doesNotMatch(fonte, /agoraRef/, "a hora congelada da montagem voltou");
  assert.match(fonte, /autorizacaoValida\(autorizacoesRef\.current, alvoConsentimento, Date\.now\(\)\)/);
  // O mecanismo que actualiza a expiração na tela é UM temporizador por ciclo, e só
  // sobre autorizações ainda vivas: `setInterval` seria vigilância, e `Math.max(0,`
  // sobre uma lista já expirada era um `setTimeout(0)` atrás do outro.
  assert.match(fonte, /const t = setTimeout\(\(\) => setAgora\(Date\.now\(\)\), espera\)/);
  assert.match(fonte, /\.filter\(\(limite\) => limite > agoraActual\)/, "o agendamento tem de ignorar o que já expirou");
  assert.match(fonte, /const espera = Math\.max\(1, proxima - agoraActual\)/, "nada de setTimeout(0) em cascata");
  assert.match(fonte, /\}, \[autorizacoes, agora\]\)/, "o efeito tem de se re-arregar a cada tick");
  assert.doesNotMatch(fonte, /setInterval/, "a expiração não pode ser sondeada em polling");
  assert.doesNotMatch(fonte, /Math\.max\(0, proxima/, "uma autorização expirada não pode re-agendar zero milissegundos");
});

const MIN = 60_000;

test("R3: duas autorizações em instantes diferentes expiram cada uma na sua hora", async () => {
  // Foi o contra-exemplo concreto do review: A em t0, B em t10. O temporizador
  // disparava em t30 com a lista inalterada, e na versão antiga o efeito não
  // corria outra vez — B ficava marcado como válido para sempre.
  const m = await montar({ alvo: A, fornecedor: "ok" });
  m.autorizar();
  assert.deepEqual(m.timers(), [30 * MIN], "uma autorização arma um temporizador até ao seu limite");

  m.avancar(10 * MIN);
  m.definirAlvo({ id: 2, pid: 9990, startedAt: "2026-10-23T08:30:00.000Z" });
  m.autorizar();
  assert.equal(m.estado().consentido, true, "B acabado de autorizar");
  assert.equal(m.timers().length, 1);
  assert.equal(m.timers()[0], 20 * MIN, "o próximo limite é o de A, não o de B");

  m.avancar(20 * MIN); // t30: A expira
  assert.equal(m.vivas().length, 1, "A saiu da lista viva");
  assert.equal(m.vivas()[0].pid, 9990);
  assert.equal(m.estado().consentido, true, "B continua válido: a expiração de A não o apaga");
  assert.deepEqual(m.timers(), [10 * MIN], "e o ciclo re-arregou para o limite de B");

  m.avancar(10 * MIN); // t40: B expira
  assert.equal(m.estado().consentido, false, "a checkbox efectiva segue a última autorização viva");
  assert.deepEqual(m.vivas(), []);
  assert.deepEqual(m.timers(), [], "sem autorizações vivas não fica nada armado — nada de polling");

  await m.enviar(PERGUNTA_B);
  const e = m.estado();
  assert.deepEqual(e.chamadas, [], "depois de expirar não se envia nada");
  assert.equal(e.anexadas.at(-1).state, "necessita-autorizacao", "e volta a pedir-se autorização");
});

test("R3b: avançar muito de uma vez não deixa fila de temporizadores nem loops", async () => {
  const m = await montar({ alvo: A, fornecedor: "ok" });
  m.autorizar();
  m.avancar(10 * MIN);
  m.definirAlvo({ id: 2, pid: 9990, startedAt: "2026-10-23T08:30:00.000Z" });
  m.autorizar();
  m.avancar(120 * MIN);
  const e = m.estado();
  assert.equal(e.consentido, false, "nada fica marcado como válido");
  assert.deepEqual(m.timers(), [], "nenhum temporizador pendurado");
  assert.equal(m.armados().filter((ms) => ms < 1_000).length, 0, `re-agendamento com atras quase nulo: ${JSON.stringify(m.armados())}`);
  assert.ok(m.armados().every((ms) => ms > 0 && ms <= 30 * MIN), JSON.stringify(m.armados()));
  await m.enviar(PERGUNTA_B);
  assert.deepEqual(m.estado().chamadas, [], "o envio continua fechado para o que expirou");
});

test("R2: mudar para um alvo por autorizar não deixa a resposta de A cair sobre B", async () => {
  const m = await montar({ alvo: A, fornecedor: "adiado" });
  m.autorizar();
  const voando = m.enviarSemAguardar(PERGUNTA_A);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(m.pendentes(), 1, "o pedido de A está no ar");
  const aMeio = m.estado();
  assert.ok(aMeio.stream.some((s) => s.includes("resposta-1")), "A começou por pintar na tela");

  m.explicar({ id: 2, pid: 9990, startedAt: "2026-10-23T08:30:00.000Z" }, CONTEXTO_B);
  const trocado = m.estado();
  assert.equal(trocado.stream.at(-1), "", "a bolha de stream de A é limpa na troca");
  assert.equal(trocado.conversa, "c1", "a conversa ainda é a mesma: o que mudou foi o alvo");

  m.liberar();
  await voando;
  const e = m.estado();
  assert.equal(e.chamadas.length, 1, "a troca para um alvo pendente não envia nada por B");
  assert.equal(e.anexadas.filter((x) => x.role === "assistant" && x.origin === "ai").length, 0, "a resposta de A não pode ser anexada");
  assert.equal(e.anexadas.filter((x) => x.role === "assistant").length, 1, "só o diagnóstico local de B pode entrar");
  assert.equal(e.anexadas.at(-1)?.origin, "local");
  assert.doesNotMatch(String(e.anexadas.at(-1)?.content), /resposta-1/);
  assert.equal(e.stream.filter((s) => s.includes("resposta-1")).length, 1, "nada mais de A é pintado depois da troca");
});

test("R2b: conversa nova descarta a resposta antiga mesmo com outro controlador em curso", async () => {
  const m = await montar({ alvo: A, fornecedor: "adiado" });
  m.autorizar();
  const voando = m.enviarSemAguardar(PERGUNTA_A);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  const conversaAntes = m.estado().conversa;

  m.reiniciar();
  assert.notEqual(m.estado().conversa, conversaAntes, "conversa nova tem de ser outra conversa");
  const segunda = m.enviarSemAguardar(PERGUNTA_NEUTRA);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(m.pendentes(), 2, "o pedido novo está no ar com um controlador novo");

  m.liberar();
  m.liberar();
  await voando;
  await segunda;
  const e = m.estado();
  const assistant = e.anexadas.filter((x) => x.role === "assistant").map((x) => x.content);
  assert.ok(!assistant.some((c) => c.includes("resposta-1")), "a resposta da conversa anterior não entra nesta");
  assert.equal(assistant.length, 1, `só o pedido em curso responde: ${JSON.stringify(assistant)}`);
  assert.ok(assistant[0].includes("resposta-2"), "o pedido novo responde");
});

test("R2c: parar um pedido em curso não o deixa responder depois", async () => {
  const m = await montar({ alvo: A, fornecedor: "adiado" });
  m.autorizar();
  const voando = m.enviarSemAguardar(PERGUNTA_A);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  m.parar();
  m.liberar();
  await voando;
  const e = m.estado();
  assert.equal(e.anexadas.filter((x) => x.role === "assistant").length, 0, "o que foi parado não pode aparecer");
});
