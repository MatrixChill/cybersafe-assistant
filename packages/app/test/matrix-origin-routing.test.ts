/**
 * TP-MATRIX-P0-ORIGIN-ROUTING-20261022 — origem da resposta por resultado REAL,
 * não por configuração, e consentimento específico antes de qualquer dado de
 * processo sair do renderer.
 *
 * Causa que este ficheiro reproduz (checkpoint P0.1, medida no fonte):
 *  1. `AIAssistant.tsx` interceptava perguntas de segurança e de processo e
 *     devolvia texto determinístico SEM ir ao provider — e a UI não tinha nenhuma
 *     forma de dizer «isto não veio da IA»;
 *  2. o rótulo do painel (`IA ONLINE` / `DIAGNÓSTICO BÁSICO OFFLINE`) vem de
 *     `/api/ai/status`, ou seja de CONFIGURAÇÃO: uma pergunta específica pode ter
 *     sido respondida localmente num painel etiquetado «online», e uma resposta do
 *     provider pode aparecer depois de um cooldown. A etiqueta do painel não prova
 *     a origem daquela mensagem;
 *  3. «Explicar na MATRIX» preenchia a caixa mas não acionava o fluxo.
 *
 * Regras provadas aqui, pelas oito situações do pedido:
 *  manual · sugestão inicial · contextual · processo COM consentimento · processo
 *  SEM consentimento · erro de API · recuperação/nova conversa · origens.
 *
 * Sem IA externa: tudo fixtures puras. Os imports são lane-relativos (`../src/…`)
 * para não resolverem por engano no `@cybersafe/*` de outra árvore.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

import {
  initialMatrixMessages,
  isConversationStart,
  matrixOriginLabel,
  originDaResposta,
  destinoDaMensagem,
  motivoDoEncaminhamentoLocal,
  promptDeExplicacaoDeProcesso,
  deveAutoEnviarExplicacao,
  type MatrixRotaInput,
} from "../src/lib/matrixConversation.ts";
import {
  buildProcessMatrixContext,
  isProcessQuestion,
  matrixTelemetryContext,
  processChatHistory,
  processPayload,
} from "../src/lib/processMatrix.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const contextoProcesso = buildProcessMatrixContext(
  {
    measuredAt: "2026-10-22T20:00:00.000Z",
    ram: { totalMb: 16384, usedMb: 12000, availableMb: 4384 },
    cpuPercent: 37.5,
    topProcesses: [
      { pid: 4712, name: "C:\\Windows\\System32\\MsMpEng.exe", startedAt: "2026-10-22T19:00:00.000Z", cpuPercent: 9.1, workingSetMb: 1780 },
    ],
    trends: [],
    limitations: [],
    recommendations: ["Guardar o trabalho e observar."],
  } as never,
  4712,
  { pid: 4712, name: "MsMpEng.exe", startedAt: "2026-10-22T19:00:00.000Z", cpu: 9.1, memoryMb: 1780 } as never,
);

const semConsentimento: MatrixRotaInput = {
  texto: "A memória deste processo está a aumentar? É seguro fechá-lo?",
  perguntaProcesso: true,
  perguntaSegurancaLocal: false,
  identidadePerdida: false,
  perigo: false,
  foraDoTema: false,
  consentimentoProcesso: false,
  temContextoProcesso: true,
  modoLocal: false,
};

const base = (sob: Partial<MatrixRotaInput> = {}): MatrixRotaInput => ({ ...semConsentimento, ...sob });

// ── 1 e 2: manual e sugestão inicial no mesmo pipeline ─────────────────────────

describe("caso manual e sugestão inicial: mesmo pipeline, origem pelo resultado", () => {
  test("pergunta geral sem motivo de intercepção vai ao provider", () => {
    assert.equal(
      destinoDaMensagem(
        base({
          texto: "Como organizo os meus favoritos do navegador?",
          perguntaProcesso: isProcessQuestion("Como organizo os meus favoritos do navegador?"),
        }),
      ),
      "provider",
    );
  });

  test("sugestão inicial usa a MESMA função de decisão que a mensagem escrita à mão", () => {
    // A sugestão é apenas texto: a decisão não pode ter um ramo próprio, senão a
    // origem passa a depender de por onde a pergunta entrou.
    const sugestao = "O que está a consumir mais memória agora?";
    const escrita = sugestao;
    const inputSugestao = base({ texto: sugestao, perguntaProcesso: isProcessQuestion(sugestao) });
    const inputEscrita = base({ texto: escrita, perguntaProcesso: isProcessQuestion(escrita) });
    assert.equal(destinoDaMensagem(inputSugestao), destinoDaMensagem(inputEscrita));
    assert.equal(isProcessQuestion(sugestao), true, "esta sugestão é de processo; o seu destino é decidido pelo consentimento");
  });

  test("resposta concluída do provider é «ai» — e só essa", () => {
    assert.equal(originDaResposta({ pediuProvider: true, ok: true, content: "Aqui está a explicação." }), "ai");
    assert.equal(matrixOriginLabel("ai"), "IA online");
  });
});

// ── 3 e 4: processo com e sem consentimento específico ─────────────────────────

describe("consentimento específico ao processo/contexto actual", () => {
  test("com consentimento e contexto validos, a explicação do processo pode ir ao provider", () => {
    assert.equal(
      destinoDaMensagem(base({ consentimentoProcesso: true, temContextoProcesso: true })),
      "provider",
    );
    const payload = processPayload(contextoProcesso, true);
    assert.equal(payload.processConsent, true);
    assert.ok(payload.processIntelligence, "com consentimento o contexto medido segue no pedido");
  });

  test("SEM consentimento: fica local, e nada do processo sai do renderer", () => {
    assert.equal(destinoDaMensagem(semConsentimento), "local");
    assert.equal(motivoDoEncaminhamentoLocal(semConsentimento), "sem-consentimento");
    assert.deepEqual(processPayload(contextoProcesso, false), {});
    assert.equal(matrixTelemetryContext("RAM 12 GB usada", false), "");
    assert.equal(originDaResposta({ pediuProvider: false }), "local");
    assert.equal(matrixOriginLabel("local"), "Diagnóstico local");
  });

  test("negativo de privacidade: sem consentimento, nem PID, nome, caminho ou RAM saem do renderer", () => {
    // É assim que o componente marca: a MENSAGEM DO UTILIZADOR também é privada
    // quando `isProcessQuestion` a apanha. Sem essa marca, o texto digitado pela
    // pessoa — que é precisamente onde vivem o nome do processo e os números —
    // ia para o fornecedor mesmo sem consentimento.
    const pergunta = promptDeExplicacaoDeProcesso(4712)
    const historico = [
      { role: "user" as const, content: "Porque está o MsMpEng a gastar 1780 MB?", privateProcessData: true },
      { role: "assistant" as const, content: "Medição local: RAM 12000/16384 MB.", privateProcessData: true },
    ];
    assert.equal(isProcessQuestion(pergunta), true, "o auto-envio da explicação é pergunta de processo: tem de estar marcada");
    const enviado = processChatHistory(historico, false);
    const serializado = JSON.stringify({
      messages: enviado,
      context: matrixTelemetryContext("RAM utilizada: 12000 MB", false),
      ...processPayload(contextoProcesso, false),
    });
    for (const fuga of ["MsMpEng", "1780", "12000", "16384", "C:\\", "pid"]) {
      assert.ok(!serializado.includes(fuga), `sem consentimento não pode sair ${JSON.stringify(fuga)}: ${serializado}`);
    }
    assert.deepEqual(enviado, [], "pergunta e resposta de processo não têm nada para enviar sem consentimento");
    // E o histórico fica completo quando o consentimento foi dado (o filtro não é
    // um apagador silencioso: com consentimento, a conversa segue).
    assert.equal(processChatHistory(historico, true).length, 2);
  });

  test("revogar consentimento retira as medições já mostradas do histórico enviado", () => {
    const historico = [
      { role: "user" as const, content: "ola" },
      { role: "assistant" as const, content: "medição", privateProcessData: true },
    ];
    assert.equal(processChatHistory(historico, true).length, 2);
    assert.equal(processChatHistory(historico, false).length, 1);
  });
});

// ── 5: identidade perdida, perigo, fora de tema e estado do PC ────────────────

describe("intercepções locais continuam locais (e ditas como locais)", () => {
  const casos: [string, MatrixRotaInput, string][] = [
    ["PID reutilizado/sumido", base({ identidadePerdida: true, consentimentoProcesso: true }), "identidade-perdida"],
    ["pedido perigoso", base({ perigo: true, consentimentoProcesso: true }), "perigo"],
    ["fora do tema", base({ foraDoTema: true, consentimentoProcesso: true }), "fora-do-tema"],
    ["estado do PC", base({ perguntaSegurancaLocal: true, texto: "O meu PC está seguro?", consentimentoProcesso: true }), "seguranca-local"],
    ["cooldown local", base({ modoLocal: true, consentimentoProcesso: true }), "modo-local"],
  ];
  for (const [nome, input, motivo] of casos) {
    test(`${nome} → local, com o motivo nomeado`, () => {
      assert.equal(destinoDaMensagem(input), "local");
      assert.equal(motivoDoEncaminhamentoLocal(input), motivo);
      assert.equal(originDaResposta({ pediuProvider: false }), "local");
    });
  }
  test("um encaminhamento ao provider não tem motivo de recusa", () => {
    const enviado = base({ consentimentoProcesso: true, temContextoProcesso: true });
    assert.equal(destinoDaMensagem(enviado), "provider");
    assert.equal(motivoDoEncaminhamentoLocal(enviado), null);
  });
});

// ── 6 e 7: erro de API e stream incompleto ─────────────────────────────────────

describe("erro do provider nunca se disfarça de resposta de IA", () => {
  for (const code of ["rate_limited", "no_provider", "auth", "model_unavailable", undefined]) {
    test(`falha (${String(code)}) → origem local`, () => {
      assert.equal(originDaResposta({ pediuProvider: true, ok: false, code }), "local");
    });
  }

  test("stream que abriu mas não concluiu (sem conteúdo) → local, não «ai»", () => {
    assert.equal(originDaResposta({ pediuProvider: true, ok: true, content: "   " }), "local");
    assert.equal(originDaResposta({ pediuProvider: true, ok: true, content: undefined }), "local");
  });

  test("a sonda de configuração (/status) não dá origem: só o resultado do pedido", () => {
    // Reproduz a causa: `mode === "online"` vindo de /api/ai/status não prova que
    // ESTA mensagem veio do provider.
    assert.equal(originDaResposta({ pediuProvider: false }), "local");
    assert.equal(matrixOriginLabel(undefined), null, "sem origem declarada não há etiqueta");
  });
});

// ── 8: nova conversa / recuperação de sessão ──────────────────────────────────

describe("nova conversa e recuperação de sessão", () => {
  test("a saudação não declara origem nenhuma: não é IA nem diagnóstico", () => {
    const mensagens = initialMatrixMessages();
    assert.equal(mensagens.length, 1);
    assert.equal("origin" in mensagens[0], false, "a saudação não pode vir rotulada");
    assert.equal(matrixOriginLabel(mensagens[0].origin), null);
    assert.ok(isConversationStart(mensagens));
  });

  test("o auto-envio dispara uma única vez por pedido de explicação", () => {
    assert.equal(deveAutoEnviarExplicacao(null, { id: 7 }), true);
    assert.equal(deveAutoEnviarExplicacao(7, { id: 7 }), false, "o mesmo id não reenvia (sem bucle)");
    assert.equal(deveAutoEnviarExplicacao(7, { id: 8 }), true);
    assert.equal(deveAutoEnviarExplicacao(8, null), false);
    assert.equal(deveAutoEnviarExplicacao(8, undefined), false);
  });

  test("o texto da explicação é o mesmo do fluxo normal, por processo ou por máquina", () => {
    assert.equal(promptDeExplicacaoDeProcesso(4712), "A memória deste processo está a aumentar? É seguro fechá-lo?");
    assert.equal(promptDeExplicacaoDeProcesso(null), "Porque está o meu PC a usar tanta RAM ou CPU?");
    assert.equal(isProcessQuestion(promptDeExplicacaoDeProcesso(4712)), true);
    // Sem consentimento, o auto-envio não abre caminho a dados privados: vai local.
    assert.equal(
      destinoDaMensagem(
        base({ texto: promptDeExplicacaoDeProcesso(4712), consentimentoProcesso: false, temContextoProcesso: true }),
      ),
      "local",
    );
  });
});

// ── Origens: as três etiquetas possíveis e nada mais ───────────────────────────

describe("origens", () => {
  test("só existem duas origens declaráveis e uma delas é a ausência", () => {
    assert.deepEqual(["ai", "local"].map(matrixOriginLabel), ["IA online", "Diagnóstico local"]);
    assert.equal(matrixOriginLabel(undefined), null);
    for (const rotulo of ["IA online", "Diagnóstico local"]) {
      assert.ok(rotulo.length <= 18, `rótulo longo para badge discreto: ${rotulo}`);
      assert.doesNotMatch(rotulo, /groq|openai|http|\.exe|\\/i, "a etiqueta não nomeia fornecedor nem caminhos");
    }
  });
});

// ── Fio do componente: o lib é mesmo usado por AIAssistant.tsx ─────────────────
// Prova de LIGAUÇÃO, não de comportamento: o teste de cima prova as regras; este
// garante que o componente não ficou com uma segunda cópia da lógica (o pedido
// proíbe uma segunda implementação de chat).
describe("ligação ao componente", () => {
  test("AIAssistant usa as funções partilhadas em vez de reimplementar a decisão", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");
    for (const simbolo of ["originDaResposta", "motivoDoEncaminhamentoLocal", "decisaoAposTentativaLocal", "matrixOriginLabel", "matrixConfigLabel", "deveAutoEnviarExplicacao", "promptDeExplicacaoDeProcesso", "consentValeParaAlvo", "rotuloDeConsentimento"]) {
      assert.ok(fonte.includes(simbolo), `AIAssistant não usa ${simbolo} — decisão duplicada ou falta de ligação`);
    }
    // O chip do cabeçalho deixou de poder afirmar «IA ONLINE»: isso era a
    // configuração, não a resposta.
    assert.ok(!/"IA ONLINE"/.test(fonte), "o cabeçalho não pode voltar a prometer IA");
    const importações = fonte.slice(0, fonte.indexOf("const ") > 0 ? fonte.indexOf("const ") : 4000);
    assert.match(importações, /from "@\/lib\/matrixConversation/, "as helpers têm de vir do módulo partilhado");
  });
});

// ── FLUXO EFETIVO: o corpo real de `sendToServer` + `processMessage` com spies ──
// As regras puras foram provadas acima. Faltava o caminho completo: que payload é
// REALMENTE enviado, quantas vezes o fornecedor é chamado e que origem fica na
// mensagem. Recorta-se do fonte o corpo real dos dois `useCallback` (sem
// reimplementar nada) e corre-se com dependências espiadas:
//  - `fetch` é um spy — regista o payload tal como sairia e devolve SSE ou erro
//    conforme o caso; nenhuma porta é aberta (o URL é um fixture morto);
//  - `answerLocalSecurityQuestion` é controlado (snapshot válido / indisponível);
//  - `setMessages` regista o que foi anexado, incluindo `origin`.
// As decisões vêm dos MÓDULOS REAIS da lane, não de cópias do teste.
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const RAIZ_TESTE = new URL("../", import.meta.url);
const urlModulo = (rel: string) => new URL(rel, RAIZ_TESTE).href;
const temporarios: string[] = [];
after(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

const fonteComponente = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8").split(/\r?\n/);
const inicio = fonteComponente.findIndex((l) => l === "  const sendToServer = useCallback(");
const linhaDeps = fonteComponente.findIndex((l) => /explainIdentity[^\]]*\],\s*$/.test(l));
const fim = fonteComponente.findIndex((l, i) => i > linhaDeps && l === "  )");
assert.ok(inicio >= 0 && linhaDeps > inicio && fim > linhaDeps, "o corpo real de sendToServer/processMessage deixou de ter a forma esperada");
const corpoReal = fonteComponente.slice(inicio, fim + 1).join("\n");

type Cenario = {
  texto: string;
  respostaLocal?: { reply: string } | null;
  processConsent?: boolean;
  consentAlvo?: { pid: number | null; startedAt: string | null } | null;
  explainRequest?: { id: number; pid?: number; startedAt?: string | null } | null;
  processContext?: unknown | null;
  /** Repete o envio pelo mesmo fluxo, como faz o reenvio interno. */
  isRetry?: boolean;
  /** `ok` = SSE concluído; `429`/`500` = erro do fornecedor. */
  fornecedor?: "ok" | "429" | "sem-conteudo";
};

async function correrCaso(c: Cenario) {
  const dir = mkdtempSync(tmpdir() + "/cybersafe-matrix-harness-");
  temporarios.push(dir);
  const fornecedor = c.fornecedor ?? "ok";
  const prelude = `
import { minimizeContextForAi } from ${JSON.stringify(urlModulo("src/lib/aiContextBuilder.ts"))};
const setProviderState = (_value: string) => {};
import { originDaResposta, motivoDoEncaminhamentoLocal, decisaoAposTentativaLocal, estadoDoMotivoLocal, estadoDoResultado, promptDeExplicacaoDeProcesso } from ${JSON.stringify(urlModulo("src/lib/matrixConversation.ts"))};
import { isProcessQuestion, perguntaApontaParaAlvo, buildProcessLocalReply, processPayload, processChatHistory, matrixTelemetryContext, alvoDeExplicacao, consentValeParaAlvo, autorizacaoValida, identidadeDeExplicacaoPerdida } from ${JSON.stringify(urlModulo("src/lib/processMatrix.ts"))};
import { acrescentarMensagem } from ${JSON.stringify(urlModulo("src/lib/matrixConversation.ts"))};
import { isLocalSecurityQuestion } from ${JSON.stringify(urlModulo("src/lib/localSecurityReply.ts"))};
const R = ((globalThis.__matrixSpies ??= { chamadas: [] as any[], anexadas: [] as any[] }));
const useCallback = (fn: any) => fn;
const window = { electronAPI: null };
const cancelLocalSecurityRequest = (_c: any) => {};
const shouldDiscardLateAnswer = (_i: any) => false;
const answerLocalSecurityQuestion = async () => (${JSON.stringify(c.respostaLocal ?? null)});
const authHeaders = () => ({ Authorization: "Bearer fixture-de-teste" });
const API_BASE = "http://127.0.0.1:59999";
const PAGE_LABELS: any = { dashboard: "Painel", tasks: "Processos" };
const MAX_HISTORY = 16, MAX_RETRIES = 2, STREAM_TIMEOUT_MS = 90_000;
const offlineReply = (_t: string, _p: any) => ({ content: "resposta offline de teste", isOffTopic: false, isDanger: false });
const codificar = new TextEncoder();
function chunk(texto: string) { return codificar.encode(texto); }
const fetch = async (_url: any, init: any) => {
  R.chamadas.push(JSON.parse(init.body));
  if (${JSON.stringify(fornecedor)} !== "ok") return { ok: false, json: async () => (${JSON.stringify(fornecedor)} === "429" ? { code: "rate_limited", message: "limite" } : { code: "no_provider", message: "sem fornecedor" }) };
  const eventos = ${JSON.stringify(fornecedor)} === "sem-conteudo"
    ? ["data: {\\"done\\":true}\\n\\n"]
    : ["data: {\\"delta\\":\\"resposta \\"}\\n\\n", "data: {\\"delta\\":\\"do fornecedor\\"}\\n\\n", "data: {\\"done\\":true}\\n\\n"];
  let i = 0;
  return { ok: true, body: { getReader: () => ({ read: async () => (i < eventos.length ? { done: false, value: chunk(eventos[i++]) } : { done: true }) }) }, json: async () => ({}) };
};
let messages: any[] = [{ role: "assistant", content: "Oi!" }];
const phase = "idle";
const currentPage: any = ${JSON.stringify(c.explainRequest?.pid !== undefined ? "tasks" : "dashboard")};
const context = "CPU 37%, RAM 12 GB";
const mode = "online";
const localUntilRef = { current: 0 };
const questionGenerationRef = { current: 0 };
const abortRef: any = { current: null };
const stickToBottomRef = { current: true };
const streamedRef = { current: "" };
const setStreamed = (_v: string) => {};
const setOfertaIa = (_v: any) => {};
const setInput = (_v: string) => {};
const setPhase = (_v: string) => {};
const setMode = (_v: string) => {};
const processDiagnostic: any = { measuredAt: "2026-10-22T20:00:00.000Z", ram: { totalMb: 16384, usedMb: 12000, availableMb: 4384 }, cpuPercent: 37.5, topProcesses: [], trends: [], limitations: [], recommendations: [] };
const processContext: any = ${JSON.stringify(c.processContext === undefined ? contextoProcesso : c.processContext)};
const explainRequest: any = ${JSON.stringify(c.explainRequest ?? null)};
const explainIdentity = "presente";
const processConsent = ${String(c.processConsent ?? false)};
const consentAlvo: any = ${JSON.stringify(c.consentAlvo ?? null)};
const consentimentoProcessoEfectivo = processConsent && consentValeParaAlvo(consentAlvo, alvoDeExplicacao(explainRequest));
import { alvoDePedido, descartarResposta, traceDePedido, bloqueioDeConsentimentoAplica, revalidarAntesDoEnvio } from ${JSON.stringify(urlModulo("src/lib/matrixRequestMachine.ts"))};
const conversationId = "cnv-fixture";
const alvoActual = alvoDeExplicacao(explainRequest ?? null) ?? (processContext && processContext.selectedProcess ? { pid: processContext.selectedProcess.pid, startedAt: processContext.selectedProcess.startedAt ?? null } : null);
const autorizacoes = processConsent && consentAlvo ? [{ alvo: consentAlvo, concedidoEm: Date.now() }] : [];
const consentimentoVivoAgora = () => autorizacaoValida(autorizacoes, alvoActual, Date.now());
const pedidoActivoRef = { current: null };
const consentimentoExternoRef = { current: { descriptor: null, grant: null } };
const autorizacoesOneShotRef = { current: new Set<string>() };
const consentimentoBloqueadoRef = { current: false };
const contaIdRef = { current: "user_fixture" };
const chaveConsentimento = "maquina";
const aplicarConsentimentoExterno = (v: any) => { consentimentoExternoRef.current = v; };
const setMessages = (fn: any) => { const proximas = typeof fn === "function" ? fn(messages) : fn; R.anexadas.push(proximas[proximas.length - 1]); messages = proximas; };
const messagesRef = { current: messages };
const substituirMensagens = (next: any) => { messagesRef.current = next; setMessages(next); };
const anexarMensagem = (msg: any) => { const next = [...messagesRef.current, msg]; messagesRef.current = next; setMessages(next); };
`;
  const ficheiro = dir + "/corpo-real.ts";
  writeFileSync(ficheiro, prelude + "\n" + corpoReal + "\nexport const fluxo = (t: string, r: boolean) => processMessage(t, r);\nexport const anexadas = () => globalThis.__matrixSpies.anexadas;\n");
  delete (globalThis as any).__matrixSpies;
  const modulo = await import("file:///" + ficheiro.replaceAll("\\", "/"));
  await modulo.fluxo(c.texto, c.isRetry ?? false);
  return {
    payload: (globalThis as any).__matrixSpies.chamadas.slice(),
    anexadas: modulo.anexadas() as Array<{ role: string; content: string; origin?: string; privateProcessData?: boolean }>,
  };
}

test("snapshot local válido → zero chamadas ao fornecedor e origem «local»", async () => {
  const r = await correrCaso({ texto: "O meu PC está seguro?", respostaLocal: { reply: "Segundo as leituras do serviço: atenção." } });
  assert.equal(r.payload.length, 0, "pergunta de estado com snapshot válido não pode tocar o provider");
  assert.equal(r.anexadas.at(-1)?.origin, "local");
  assert.equal(r.anexadas.at(-1)?.content, "Segundo as leituras do serviço: atenção.");
});

test("sem snapshot local: a mesma pergunta vai ao fornecedor e a origem passa a «ai»", async () => {
  const r = await correrCaso({ texto: "O meu PC está seguro?", respostaLocal: null });
  assert.equal(r.payload.length, 1, "sem snapshot a pergunta fica presa no local — foi o bloqueio da revisão");
  assert.equal(r.anexadas.at(-1)?.origin, "ai");
  assert.equal(r.anexadas.at(-1)?.content, "resposta do fornecedor");
});

test("erro do fornecedor (429): uma chamada, origem «local», nunca «ai»", async () => {
  const r = await correrCaso({ texto: "O meu PC está seguro?", respostaLocal: null, fornecedor: "429" });
  assert.equal(r.payload.length, 1);
  assert.equal(r.anexadas.at(-1)?.origin, "local");
});

test("stream que não conclui: origem «local» mesmo com HTTP 200", async () => {
  const r = await correrCaso({ texto: "O meu PC está seguro?", respostaLocal: null, fornecedor: "sem-conteudo" });
  assert.equal(r.payload.length >= 1, true);
  assert.equal(r.anexadas.at(-1)?.origin, "local");
});

test("consentimento dado para OUTRO processo não envia as medições deste", async () => {
  const alvoAnterior = { pid: 111, startedAt: "2026-10-22T19:00:00.000Z" };
  const r = await correrCaso({
    texto: promptDeExplicacaoDeProcesso(4712),
    processConsent: true,
    consentAlvo: alvoAnterior,
    explainRequest: { id: 1, pid: 4712, startedAt: "2026-10-22T19:30:00.000Z" },
  });
  // A fuga era POSSÍVEL: havia contexto medido para enviar e o interruptor geral de
  // consentimento estava ligado. O que falta é a autorização PARA ESTE alvo, e é
  // isso que o fluxo efetivo respeita — nada fica no payload, nem parcial.
  assert.equal(r.payload.length, 0, "autorizar um processo não autoriza o seguinte");
  assert.equal(JSON.stringify(r.payload), "[]", "nem um pedido sem o bloco de processo escapa");
  assert.equal(r.anexadas.at(-1)?.origin, "local");
  assert.equal(r.anexadas.at(-1)?.privateProcessData, true);
});

test("consentimento para o alvo certo: o payload REAL leva o contexto medido", async () => {
  const alvo = { pid: 4712, startedAt: "2026-10-22T19:00:00.000Z" };
  const r = await correrCaso({
    texto: promptDeExplicacaoDeProcesso(4712),
    processConsent: true,
    consentAlvo: alvo,
    explainRequest: { id: 1, pid: 4712, startedAt: "2026-10-22T19:00:00.000Z" },
  });
  assert.equal(r.payload.length, 1);
  const enviado = r.payload[0];
  assert.equal(enviado.processConsent, true);
  assert.ok(enviado.processIntelligence, "com consentimento do alvo certo o contexto medido segue");
  assert.equal(enviado.stream, true);
  assert.equal(enviado.context, "CPU 37%, RAM 12 GB", "com consentimento a telemetria autorizada segue");
  // Minimização MESMO com consentimento: só as duas chaves do contrato de processo.
  assert.deepEqual(
    Object.keys(enviado).sort(),
    ["context", "messages", "page", "processConsent", "processIntelligence", "stream"],
  );
  assert.equal(r.anexadas.at(-1)?.origin, "ai");
  assert.equal(r.anexadas.at(-1)?.privateProcessData, true);
});

test("pergunta de processo sem qualquer consentimento: nada de processo no payload", async () => {
  const r = await correrCaso({ texto: promptDeExplicacaoDeProcesso(4712), explainRequest: { id: 1, pid: 4712, startedAt: "x" } });
  assert.equal(r.payload.length, 0);
  assert.equal(r.anexadas.at(-1)?.origin, "local");
  assert.equal(r.anexadas.at(-1)?.privateProcessData, true);
});

test("sugestão elegível e pergunta escrita usam o MESMO fluxo: um único ponto de envio, payload idêntico", async () => {
  // Não há segunda implementação de chat: o único ponto que contacta o fornecedor
  // é `sendToServer`, chamado dentro de `processMessage` — a sugestão automática
  // («Explicar na MATRIX») entra por esse `processMessage`, não por outro caminho.
  const chamadasSend = fonteComponente.filter((l) => /await sendToServer\(/.test(l)).length;
  assert.equal(chamadasSend, 1, "mais de um ponto de envio ao fornecedor = segunda implementação de chat");
  const autoEnvio = fonteComponente.filter((l) => /processMessageRef\.current\?\.\(/.test(l)).length;
  assert.equal(autoEnvio, 1, "a sugestão automática tem de entrar pelo mesmo processMessage");

  const escrita = await correrCaso({ texto: "Como organizo os favoritos?" });
  const reenvio = await correrCaso({ texto: "Como organizo os favoritos?", isRetry: true });
  assert.equal(escrita.payload.length, 1);
  assert.deepEqual(reenvio.payload, escrita.payload, "o reenvio não altera a forma do pedido");
  assert.equal(escrita.anexadas.at(-1)?.origin, "ai");
  // O payload REAL só leva as chaves do contrato existente — nada de identidade de
  // host, caminhos ou commandLine «por acidente».
  const enviado = escrita.payload[0];
  assert.deepEqual(Object.keys(enviado).sort(), ["context", "messages", "page", "stream"]);
  const serializado = JSON.stringify(enviado);
  assert.ok(!/C:\\\\|commandLine|executablePath|\bprocesses\b/i.test(serializado), `payload com campos de host: ${serializado}`);
  // Minimização provada no payload REAL: sem consentimento, nem o contexto de
  // telemetria da página sai; com consentimento do alvo, sai o contrato integral.
  assert.equal(enviado.context, "", "telemetria da página não segue sem consentimento");
});
