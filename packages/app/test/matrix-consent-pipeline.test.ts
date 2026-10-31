/**
 * TP-MATRIX-TAKEOVER-20261023 — pipeline de consentimento ponta a ponta.
 *
 * Quatro factos medidos no fonte de U (2026-10-23) que este ficheiro fecha:
 *  1. `AIAssistant.tsx:455-473` autoenviava o pedido de explicacao SEM qualquer
 *     gate de consentimento: a pessoa nunca tinha sido autorizada e ja tinha uma
 *     resposta na tela;
 *  2. `motivoDoEncaminhamentoLocal` devolvia `sem-consentimento` e o componente
 *     respondia localmente com a etiqueta `Diagnóstico local` — o painel dizia
 *     «Fornecedor verificado», a resposta era local, e nada no ecrã distinguia
 *     «nao autorizaste» de «a IA nao esta disponivel»;
 *  3. nao existia mecanismo de pedido pendente: marcar a caixa depois de receber
 *     essa resposta local era inerte, a pessoa tinha de repetir a pergunta;
 *  4. `MatrixAnswerOrigin` e `local | ai` apenas: indisponibilidade, erro,
 *     cooldown e falta de autorização colapsavam todos na mesma palavra.
 *
 * O que esta ficha prova, por ordem:
 *  - o gate puro (quando vale pedir autorização ANTES de enviar, e quando nao);
 *  - o reenvio unico apos autorizar, com alvo, instancia e deduplicacao;
 *  - o eixo de estado por resposta, separido de origem;
 *  - o FLUXO REAL: os dois efeitos sao recortados do componente e executados com
 *    dependencias espiadas. Zero importacao de texto copiado para o teste.
 *
 * Sem IA externa, sem rede, sem provider real: o `fetch` e um spy que regista o
 * payload tal como sairia. Zero chamadas e a unica prova que interessa num gate.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  devePedirAutorizacaoAntes,
  estadoDoMotivoLocal,
  estadoDoResultado,
  matrixRoutingStateLabel,
  matrixOriginLabel,
  motivoDoEncaminhamentoLocal,
  originDaResposta,
  promptDeExplicacaoDeProcesso,
  type MatrixRequestState,
} from "../src/lib/matrixConversation.ts";
import {
  CODIGOS_RECUPERAVEIS,
  matrixStateLabel,
  origemDoEstado,
} from "../src/lib/matrixRequestMachine.ts";
import {
  deveReenviarExplicacaoAposAutorizacao,
  alvoDeExplicacao,
  consentValeParaAlvo,
  mesmoAlvo,
  isProcessQuestion,
  buildProcessMatrixContext,
  processPayload,
  type PendenteExplicacao,
  type AlvoProcesso,
} from "../src/lib/processMatrix.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ALVO_A: AlvoProcesso = { pid: 4712, startedAt: "2026-10-23T09:00:00.000Z" };
const ALVO_B: AlvoProcesso = { pid: 9990, startedAt: "2026-10-23T09:00:00.000Z" };
// Mesmo PID, outra instancia: o Windows reatribuiu o numero.
const ALVO_A_OUTRA_INSTANCIA: AlvoProcesso = { pid: 4712, startedAt: "2026-10-23T11:30:00.000Z" };

const pendente = (sob: Partial<PendenteExplicacao> = {}): PendenteExplicacao => ({
  id: 1,
  pid: 4712,
  startedAt: "2026-10-23T09:00:00.000Z",
  texto: "A memória deste processo está a aumentar? É seguro fechá-lo?",
  alvo: ALVO_A,
  ...sob,
});

const estadoAutorizado = {
  consentimentoEfectivo: true,
  alvoAutorizado: ALVO_A,
  identidadePerdida: false,
  jaConsumido: null as number | null,
};

// ── 1. O gate: quando se pede autorização ANTES de enviar ─────────────────────

describe("gate de autorização antes do envio", () => {
  test("pergunta de processo com medições e sem autorização: pedir primeiro", () => {
    assert.equal(
      devePedirAutorizacaoAntes({
        perguntaProcesso: true,
        temContextoProcesso: true,
        consentimentoEfectivo: false,
        identidadePerdida: false,
      }),
      true,
    );
  });

  test("já autorizado para este alvo: não se volta a pedir", () => {
    assert.equal(
      devePedirAutorizacaoAntes({
        perguntaProcesso: true,
        temContextoProcesso: true,
        consentimentoEfectivo: true,
        identidadePerdida: false,
      }),
      false,
    );
  });

  test("sem medições de processo: pedir seria mentir sobre o efeito", () => {
    // Autorizar não criaria contexto; a resposta já é local por falta de dados.
    assert.equal(
      devePedirAutorizacaoAntes({
        perguntaProcesso: true,
        temContextoProcesso: false,
        consentimentoEfectivo: false,
        identidadePerdida: false,
      }),
      false,
    );
  });

  test("instância perdida: não se pede autorização pelo que já não existe", () => {
    assert.equal(
      devePedirAutorizacaoAntes({
        perguntaProcesso: true,
        temContextoProcesso: true,
        consentimentoEfectivo: false,
        identidadePerdida: true,
      }),
      false,
    );
  });

  test("pergunta da máquina (não é de processo): vai direto", () => {
    assert.equal(
      devePedirAutorizacaoAntes({
        perguntaProcesso: false,
        temContextoProcesso: true,
        consentimentoEfectivo: false,
        identidadePerdida: false,
      }),
      false,
    );
  });

  test("o gate e o encaminhamento local dizem a mesma coisa", () => {
    // Relacao que tem de valer sempre: pedir autorizacao antes == o envio seria
    // travado por `sem-consentimento`. Duas respostas para a mesma pergunta e
    // onde comeca a divergir.
    for (const cenario of [
      { perguntaProcesso: true, temContextoProcesso: true, consentimentoEfectivo: false },
      { perguntaProcesso: true, temContextoProcesso: true, consentimentoEfectivo: true },
      { perguntaProcesso: true, temContextoProcesso: false, consentimentoEfectivo: false },
      { perguntaProcesso: false, temContextoProcesso: false, consentimentoEfectivo: false },
    ]) {
      const rota = {
        texto: "x",
        perguntaProcesso: cenario.perguntaProcesso,
        perguntaSegurancaLocal: false,
        identidadePerdida: false,
        perigo: false,
        foraDoTema: false,
        consentimentoProcesso: cenario.consentimentoEfectivo,
        temContextoProcesso: cenario.temContextoProcesso,
        modoLocal: false,
      };
      const trava = motivoDoEncaminhamentoLocal(rota) === "sem-consentimento";
      const pede = devePedirAutorizacaoAntes({ ...cenario, identidadePerdida: false });
      assert.equal(pede, trava && cenario.temContextoProcesso, JSON.stringify(cenario));
    }
  });
});

// ── 2. Reenvio unico depois de autorizar ──────────────────────────────────────

describe("reenvio único após autorizar", () => {
  test("autorizar o MESMO alvo retoma o pedido que estava pendente", () => {
    assert.equal(deveReenviarExplicacaoAposAutorizacao(pendente(), estadoAutorizado), true);
  });

  test("explicação da MÁQUINA pendente: autorizar a máquina retoma uma só vez", async () => {
    const texto = promptDeExplicacaoDeProcesso(null);
    const maquina = { pid: null, startedAt: null };
    const r = await correr({
      explainRequest: { id: 11 },
      explicacaoPendente: { id: 11, pid: null, startedAt: null, texto, alvo: maquina },
      processConsent: true,
      consentAlvo: maquina,
      ultimoAutoId: 11,
    });
    assert.deepEqual(r.send, [[texto, false, true]], "a máquina é um alvo real: o pendente tem de ser retomado");
    assert.equal(r.pendente, null, "o pendente é limpo depois do reenvio");
  });

  test("sem pedido pendente não há reenvio", () => {
    assert.equal(deveReenviarExplicacaoAposAutorizacao(null, estadoAutorizado), false);
    assert.equal(deveReenviarExplicacaoAposAutorizacao(undefined, estadoAutorizado), false);
  });

  test("autorizar sem consentimento efectivo não dispara nada", () => {
    assert.equal(
      deveReenviarExplicacaoAposAutorizacao(pendente(), { ...estadoAutorizado, consentimentoEfectivo: false }),
      false,
    );
  });

  test("PID trocado entretanto: o alvo autorizado não é o do pedido", () => {
    assert.equal(deveReenviarExplicacaoAposAutorizacao(pendente(), { ...estadoAutorizado, alvoAutorizado: ALVO_B }), false);
  });

  test("mesmo PID mas outra instância: startedAt manda", () => {
    assert.equal(mesmoAlvo(ALVO_A, ALVO_A_OUTRA_INSTANCIA), false, "o teste-pergunta assenta em startedAt");
    assert.equal(
      deveReenviarExplicacaoAposAutorizacao(pendente(), { ...estadoAutorizado, alvoAutorizado: ALVO_A_OUTRA_INSTANCIA }),
      false,
    );
  });

  test("já consumido para este pedido: zero duplicação", () => {
    assert.equal(deveReenviarExplicacaoAposAutorizacao(pendente(), { ...estadoAutorizado, jaConsumido: 1 }), false);
  });

  test("outro pedido consumido não impede este", () => {
    assert.equal(deveReenviarExplicacaoAposAutorizacao(pendente({ id: 2 }), { ...estadoAutorizado, jaConsumido: 1 }), true);
  });

  test("identidade perdida ao autorizar: não se envia pelo que já não está medido", () => {
    assert.equal(
      deveReenviarExplicacaoAposAutorizacao(pendente(), { ...estadoAutorizado, identidadePerdida: true }),
      false,
    );
  });

  test("o alvo do pendente é o mesmo cálculo que a UI usa para autorizar", () => {
    const pedido = { id: 7, pid: 4712, startedAt: "2026-10-23T09:00:00.000Z" };
    const alvo = alvoDeExplicacao(pedido);
    assert.ok(alvo);
    // A linha da UI guarda `alvoDeExplicacao(explainRequest)`; o pendente tem de
    // guardar o MESMO valor, senão autorizar nunca coincide com o pedido.
    assert.deepEqual(pendente({ id: 7, alvo: alvo! }).alvo, alvo);
    assert.equal(consentValeParaAlvo(alvo, ALVO_A), true);
  });
});

// ── 3. Eixo de estado por resposta ────────────────────────────────────────────

describe("estado por resposta: causa honesta, não uma palavra só", () => {
  test("faltam de eixos diferentes: origem diz de onde veio, estado diz porquê", () => {
    assert.equal(matrixOriginLabel("local"), "Diagnóstico local");
    assert.equal(estadoDoMotivoLocal("sem-consentimento"), "necessita-autorizacao");
    assert.equal(estadoDoMotivoLocal("modo-local"), "indisponivel");
  });

  test("sem consentimento não é indisponibilidade", () => {
    assert.notEqual(estadoDoMotivoLocal("sem-consentimento"), estadoDoMotivoLocal("modo-local"));
  });

  test("identidade perdida é local, e nunca se confunde com falta de autorização", () => {
    // Os sete estados do pedido não têm oitava para «a instância já não existe»:
    // o que a pessoa pode fazer com ela é a mesma coisa que com uma resposta da
    // máquina. O que a distingue não é a etiqueta, é a resposta nunca chegar ao
    // alvo errado — provado em «descartarResposta».
    assert.equal(estadoDoMotivoLocal("identidade-perdida"), "local");
    assert.notEqual(estadoDoMotivoLocal("identidade-perdida"), "necessita-autorizacao");
    assert.notEqual(estadoDoMotivoLocal("identidade-perdida"), "indisponivel");
  });

  test("resposta de prioridade local (segurança/perigo/fora do tema)", () => {
    for (const motivo of ["seguranca-local", "perigo", "fora-do-tema"] as const) {
      assert.equal(estadoDoMotivoLocal(motivo), "local", motivo);
    }
  });

  test("provider concluído é «generativa»", () => {
    assert.equal(
      estadoDoResultado({ motivo: null, pediuProvider: true, ok: true, content: "resposta" }),
      "generativa",
    );
  });

  test("erro 429 é temporário e acionável, nunca «resposta da IA»", () => {
    assert.ok((CODIGOS_RECUPERAVEIS as readonly string[]).includes("rate_limited"));
    assert.equal(
      estadoDoResultado({ motivo: null, pediuProvider: true, ok: false, code: "rate_limited" }),
      "erro-recuperavel",
    );
  });

  test("o que o fornecedor não tem não é culpa de quem pergunta", () => {
    for (const code of ["no_provider", "model_unavailable", "auth"]) {
      assert.equal(estadoDoResultado({ motivo: null, pediuProvider: true, ok: false, code }), "indisponivel", code);
    }
  });

  test("stream que abriu e não concluiu é indisponibilidade", () => {
    assert.equal(estadoDoResultado({ motivo: null, pediuProvider: true, ok: true, content: "   " }), "indisponivel");
    assert.equal(estadoDoResultado({ motivo: null, pediuProvider: true, ok: true }), "indisponivel");
  });

  test("sem ida ao provider nunca produze «generativa»", () => {
    const casos: MatrixRequestState[] = [
      estadoDoResultado({ motivo: null, pediuProvider: false }),
      estadoDoResultado({ motivo: null, pediuProvider: false, ok: true, content: "x" }),
    ];
    for (const c of casos) assert.notEqual(c, "generativa");
  });

  test("o motivo local tem prioridade sobre o resultado", () => {
    assert.equal(
      estadoDoResultado({ motivo: "sem-consentimento", pediuProvider: false, ok: true, content: "x" }),
      "necessita-autorizacao",
    );
  });

  test("origem e estado não podem discordar: «IA» só no estado generativo", () => {
    const estados: MatrixRequestState[] = [
      "necessita-autorizacao", "a-enviar", "a-stream", "generativa", "indisponivel", "local", "erro-recuperavel",
    ];
    for (const e of estados) assert.equal(origemDoEstado(e) === "provider", e === "generativa", e);
    const r: { pediuProvider: boolean; ok?: boolean; content?: string; code?: string } = {
      pediuProvider: true, ok: false, code: "rate_limited",
    };
    assert.equal(estadoDoResultado({ motivo: null, ...r }), "erro-recuperavel");
    assert.equal(matrixOriginLabel(originDaResposta(r)), "Diagnóstico local");
  });

  test("rótulos: nenhum afirma IA quando não foi IA", () => {
    const rotulos = (["necessita-autorizacao", "a-enviar", "a-stream", "generativa", "indisponivel", "local", "erro-recuperavel"] as const).map(
      (e) => [e, matrixRoutingStateLabel(e)] as const,
    );
    for (const [estado, rotulo] of rotulos) {
      assert.ok(rotulo && rotulo.length > 0, `sem rótulo para ${estado}`);
      assert.ok(rotulo.length <= 34, `rótulo longo demais: ${rotulo}`);
      assert.doesNotMatch(rotulo, /groq|openai|http|\.exe|\\/i, `etiqueta nomeia fornecedor/caminho: ${rotulo}`);
      if (estado !== "generativa") {
        assert.doesNotMatch(rotulo, /resposta da IA/i, `estado não-generativo não pode dizer «Resposta da IA»: ${rotulo}`);
      } else {
        assert.match(rotulo, /resposta da IA/i, `o único estado que respondeu pela IA tem de o dizer: ${rotulo}`);
      }
    }
    assert.equal(matrixRoutingStateLabel(undefined), null);
  });

  test("os sete estados são todos distintos entre si", () => {
    const estados: MatrixRequestState[] = [
      "necessita-autorizacao", "a-enviar", "a-stream", "generativa", "indisponivel", "local", "erro-recuperavel",
    ];
    assert.equal(estados.length, 7);
    const rotulos = estados.map((e) => matrixStateLabel(e));
    assert.equal(new Set(rotulos).size, estados.length, JSON.stringify(rotulos));
    // A conversa e a máquina têm de responder a mesma palavra — senão o eixo
    // separava-se outra vez por caminho, que foi precisamente o bug original.
    for (const e of estados) assert.equal(matrixRoutingStateLabel(e), matrixStateLabel(e), e);
  });
});

// ── 4. FLUXO REAL dos dois efeitos do componente ──────────────────────────────
// Recorta do fonte de AIAssistant.tsx os corpos dos dois efeitos implicados
// (pedido de explicação e reenvio após autorizar) e corre-os com dependências
// espiadas. Nada é reimplementado no teste: as linhas executadas são as do
// produto. Cada caso declara as variáveis do componente, como uma renderização.

const RAIZ = new URL("../", import.meta.url);
const urlModulo = (rel: string) => new URL(rel, RAIZ).href;
const temporarios: string[] = [];
after(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

const fonteCompleta = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");
const linhas = fonteCompleta.split(/\r?\n/);

/**
 * Corpo de um `useEffect(() => { … }, [deps])`. A 1ª linha do corpo não chega para
 * identificar: `if (!explicacaoPendente) return` é também a 1ª linha do handler de
 * recusa, que aparece ANTES do efeito no ficheiro. Exige-se portanto a linha
 * `useEffect(() => {` por cima, o que distingue os dois sem ambiguidade.
 */
function extrairEfeito(primeiraLinha: string, marcadorFim: string): string {
  const i = linhas.findIndex((l, k) => l.trim() === primeiraLinha && linhas[k - 1] === "  useEffect(() => {");
  assert.ok(i >= 0, `efeito não encontrado no componente: ${primeiraLinha}`);
  const j = linhas.findIndex((l, k) => k > i && l.startsWith(marcadorFim));
  assert.ok(j > i, `fim de efeito não encontrado após ${primeiraLinha}`);
  return linhas.slice(i + 1, j).join("\n");
}

/** Callback local (`useCallback`) entre a declaração e o fecho exacto. */
function extrairCallback(declaracao: string, fecho: string): string {
  const i = linhas.findIndex((l) => l.trim().startsWith(declaracao));
  assert.ok(i >= 0, `callback não encontrado: ${declaracao}`);
  const j = linhas.findIndex((l, k) => k > i && l.trim() === fecho);
  assert.ok(j > i, `fecho do callback não encontrado: ${fecho}`);
  return linhas.slice(i, j + 1).join("\n");
}

/** Função local do componente declarada por `const nome = (…) => …`, até ao `}`. */
function extrairAssinaturaDeRevogacao(): string {
  const i = linhas.findIndex((l) => l.trim().startsWith(DECLARACAO_ASSINATURA_REVOGACAO));
  assert.ok(i >= 0, "efeito de revogação não encontrado no componente");
  const j = linhas.findIndex((l, k) => k > i && l.trim() === "}), [contaId, invalidarConsentimentoLocal])");
  assert.ok(j > i, "fim do efeito de revogação não encontrado");
  return linhas.slice(i, j + 1).join("\n");
}

function extrairFuncao(declaracao: string): string {
  const i = linhas.findIndex((l) => l.trim().startsWith(declaracao));
  assert.ok(i >= 0, `função não encontrada no componente: ${declaracao}`);
  if (linhas[i].trim().endsWith("{")) {
    const j = linhas.findIndex((l, k) => k > i && l === "  }");
    assert.ok(j > i, `fim não encontrado para ${declaracao}`);
    return linhas.slice(i, j + 1).join("\n");
  }
  // Seta em corpo-expression: pode ocupar mais do que uma linha.
  let j = i;
  while (j + 1 < linhas.length && !linhas[j].trim().endsWith(")")) j++;
  return linhas.slice(i, j + 1).join("\n");
}

// Preguica deliberada: as regras puras deste ficheiro têm de correr (e passar)
// mesmo quando o componente ainda não tem o efeito — foi exactamente assim que o
// RED ficou granular em vez de ser um erro de carga do módulo inteiro.
let _corpos: { explicar: string; reenvio: string } | null = null;
const corpos = () => (_corpos ??= {
  explicar: extrairEfeito("if (!explainRequest) return", "  }, [explainRequest"),
  reenvio: extrairEfeito("if (!explicacaoPendente) return", "  }, [explicacaoPendente"),
});

type Cenario = {
  explainRequest?: { id: number; pid?: number; startedAt?: string | null } | null;
  explainIdentity?: string;
  processConsent?: boolean;
  consentAlvo?: AlvoProcesso | null;
  processContext?: unknown | null;
  /** Estado do pendente tal como ficou na renderização anterior. */
  explicacaoPendente?: PendenteExplicacao | null;
  ultimoAutoId?: number | null;
  resolvidoId?: number | null;
  /** O que o spy do fornecedor devolve. */
  fornecedor?: "ok" | "429" | "sem-conteudo";
};

async function correr(c: Cenario, { correrReenvio = true }: { correrReenvio?: boolean } = {}) {
  const dir = mkdtempSync(tmpdir() + "/cybersafe-matrix-consent-");
  temporarios.push(dir);
  const contexto = c.processContext === undefined ? CONTEXTO : c.processContext;
  const pendenteRender = c.explicacaoPendente === undefined ? null : c.explicacaoPendente;
  // Semantica React: os efeitos desta renderizacao leem o valor de `explicacaoPendente`
  // DESTA passagem; o que `setExplicacaoPendente` escrever so e visível na seguinte.
  // Sem isto, o reenvio veria o pendente criado no efeito anterior, no mesmo commit,
  // e o teste provava uma coisa que o React nao faz.
  const prelude = `
import { deveAutoEnviarExplicacao, promptDeExplicacaoDeProcesso, devePedirAutorizacaoAntes } from ${JSON.stringify(urlModulo("src/lib/matrixConversation.ts"))};
import { alvoDeExplicacao, consentValeParaAlvo, autorizacaoValida, isProcessQuestion, deveReenviarExplicacaoAposAutorizacao, identidadeDeExplicacaoPerdida, buildProcessLocalReply, buildIdentityLostReply } from ${JSON.stringify(urlModulo("src/lib/processMatrix.ts"))};
const R = ((globalThis.__mSpies ??= { abertos: [] as boolean[], locais: [] as any[], ofertas: [] as any[] }));
const cancelLocalSecurityRequest = (_c: any) => {};
const abortRef: any = { current: null };
const questionGenerationRef = { current: 0 };
const ultimoExplicacaoAutoRef: any = { current: ${JSON.stringify(c.ultimoAutoId ?? null)} };
const intencaoExplicarRef: any = { current: null };
const ultimaExplicacaoLocalRef = { current: null };
const explicacaoResolvidaRef: any = { current: ${JSON.stringify(c.resolvidoId ?? null)} };
const setPhase = (_v: any) => {};
const setStreamed = (_v: string) => {};
const streamedRef = { current: "" };
const setUpOpenState = (_v: boolean) => {};
const setInput = (_v: string) => {};
const setOfertaIa = (v: any) => { R.ofertas.push(v); };
const anexarMensagem = (m: any) => { R.locais.push(m); };
const processDiagnostic: any = { measuredAt: "2026-10-23T09:05:00.000Z", ram: { totalMb: 16384, usedMb: 12000, availableMb: 4384 }, cpuPercent: 37.5, topProcesses: [], trends: [], limitations: [], recommendations: [], observations: [] };
const processMessageChamadas: Array<[string, boolean, boolean]> = [];
const processMessageRef: any = { current: (t: string, r?: boolean, f?: boolean) => { processMessageChamadas.push([t, !!r, !!f]); return Promise.resolve(); } };
const enviarPeloFluxoNormal = (t: string) => processMessageRef.current?.(t, false, true);
const explainRequest: any = ${JSON.stringify(c.explainRequest === undefined ? null : c.explainRequest)};
const explainIdentity = ${JSON.stringify(c.explainIdentity ?? "presente")};
const processContext: any = ${JSON.stringify(contexto)};
const identityLost = identidadeDeExplicacaoPerdida(explainRequest, explainIdentity);
const alvoExplicacao = alvoDeExplicacao(explainRequest ?? null);
const processConsent = ${String(c.processConsent ?? false)};
const consentAlvo: any = ${JSON.stringify(c.consentAlvo ?? null)};
const consentimentoProcessoEfectivo = processConsent && consentValeParaAlvo(consentAlvo, alvoExplicacao);
import { alvoDePedido, descartarResposta, traceDePedido, bloqueioDeConsentimentoAplica, revalidarAntesDoEnvio } from ${JSON.stringify(urlModulo("src/lib/matrixRequestMachine.ts"))};
const conversationId = "cnv-fixture";
const alvoActual = alvoDeExplicacao(explainRequest ?? null) ?? (processContext && processContext.selectedProcess ? { pid: processContext.selectedProcess.pid, startedAt: processContext.selectedProcess.startedAt ?? null } : null);
const autorizacoes = processConsent && consentAlvo ? [{ alvo: consentAlvo, concedidoEm: Date.now() }] : [];
const consentimentoVivoAgora = () => autorizacaoValida(autorizacoes, alvoActual, Date.now());
const pedidoActivoRef = { current: null };
const consentimentoExternoRef = { current: { descriptor: null, grant: null } };
const autorizacoesOneShotRef = { current: new Set<string>() };
const chaveConsentimento = "maquina";
const aplicarConsentimentoExterno = (v: any) => { consentimentoExternoRef.current = v; };
const explicacaoPendente: any = ${JSON.stringify(pendenteRender)};
let proximoPendente: any = explicacaoPendente;
const setExplicacaoPendente = (v: any) => { proximoPendente = typeof v === "function" ? v(explicacaoPendente) : v; };
let autorizacaoAberta = false;
let proximaAutorizacao = false;
const setAutorizacaoAberta = (v: any) => { proximaAutorizacao = typeof v === "function" ? v(autorizacaoAberta) : v; R.abertos.push(proximaAutorizacao); };
export const estadoFinal = () => ({ pendente: proximoPendente, aberto: proximaAutorizacao });
`;
  const rodar = `
const corpoExplicar = () => {
${corpos().explicar}
};
const corpoReenvio = () => {
${corpos().reenvio}
};
corpoExplicar();
if (${String(correrReenvio)}) corpoReenvio();
export const spies = () => globalThis.__mSpies;
export const chamadasSend = () => processMessageChamadas;
`;
  const ficheiro = dir + "/efeito.ts";
  writeFileSync(ficheiro, prelude + rodar);
  delete (globalThis as any).__mSpies;
  const mod = await import("file:///" + ficheiro.replaceAll("\\", "/"));
  return {
    send: mod.chamadasSend() as Array<[string, boolean, boolean]>,
    pendente: mod.estadoFinal().pendente as PendenteExplicacao | null,
    aberto: mod.estadoFinal().aberto as boolean,
    abertos: mod.spies().abertos as boolean[],
    locais: mod.spies().locais as Array<{ content: string; origin?: string; state?: string; privateProcessData?: boolean }>,
    ofertas: mod.spies().ofertas as Array<PendenteExplicacao | null>,
  };
}

const CONTEXTO = {
  version: 1,
  measuredAt: "2026-10-23T09:05:00.000Z",
  ram: { totalMb: 16384, usedMb: 12000, availableMb: 4384 },
  cpuPercent: 37.5,
  topProcesses: [],
  selectedProcess: { pid: 4712, name: "MsMpEng.exe", startedAt: "2026-10-23T09:00:00.000Z", cpuPercent: 9.1, workingSetMb: 1780 },
  trends: [],
  limitations: [],
};

describe("fluxo real: clique «Explicar» sem autorização", () => {
  test("responde localmente, sem envio e sem abrir autorização", async () => {
    const r = await correr({ explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt } });
    assert.deepEqual(r.send, [], "o clique não pode acionar o fluxo de envio");
    assert.equal(r.locais.length, 1, "tem de haver uma resposta local imediata");
    assert.equal(r.locais[0].origin, "local");
    assert.equal(r.locais[0].state, "local");
    assert.match(r.locais[0].content, /DIAGNÓSTICO LOCAL/);
    assert.equal(r.pendente, null, "já não há pedido à espera: a resposta não depende de autorização");
    assert.equal(r.aberto, false, "não abre o cartão sozinho: a IA é opt-in");
  });

  test("a oferta de IA guarda o alvo exacto (pid + instância)", async () => {
    const r = await correr({ explainRequest: { id: 3, pid: 4712, startedAt: ALVO_A.startedAt } });
    const oferta = r.ofertas[0];
    assert.equal(oferta?.alvo?.pid, 4712);
    assert.equal(oferta?.alvo?.startedAt, ALVO_A.startedAt);
    assert.equal(oferta?.id, 3);
  });

  test("explicação da máquina TAMBÉM leva RAM/CPU: o gate aplica-se", () => {
    // Medido no fonte, não assumido: `isProcessQuestion` apanha «RAM ou CPU», por
    // isso a pergunta da máquina cai na mesma regra de privacidade. Dizer que ela
    // «vai direta» seria inventar um caminho sem consentimento para dados que o
    // texto da própria linha autoriza.
    assert.equal(isProcessQuestion(promptDeExplicacaoDeProcesso(null)), true);
  });

  test("pergunta que não é de processo não é travada pelo gate", () => {
    assert.equal(
      devePedirAutorizacaoAntes({
        perguntaProcesso: isProcessQuestion("Qual é a melhor forma de organizar os favoritos?"),
        temContextoProcesso: true,
        consentimentoEfectivo: false,
        identidadePerdida: false,
      }),
      false,
    );
  });

  test("explicação da máquina responde localmente e oferece a máquina", async () => {
    const r = await correr({ explainRequest: { id: 1 } });
    assert.deepEqual(r.send, [], "leva CPU/RAM: não se envia sem um pedido explícito de IA");
    assert.equal(r.locais.length, 1);
    assert.equal(r.ofertas[0]?.alvo.pid, null);
    assert.equal(r.ofertas[0]?.alvo.startedAt, null);
  });

  test("sem medições não há oferta ilusória, mas há resposta local honesta", async () => {
    const r = await correr({ explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt }, processContext: null });
    assert.equal(r.locais.length, 1);
    assert.match(r.locais[0].content, /não está nas medições/);
    assert.equal(r.ofertas[0], null, "sem contexto medido não se promete envio");
  });

  test("instância perdida responde localmente e não oferece envio", async () => {
    const r = await correr({
      explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt },
      explainIdentity: "sumido",
    });
    assert.equal(r.locais.length, 1);
    assert.match(r.locais[0].content, /INSTÂNCIA FORA DAS MEDIÇÕES/);
    assert.equal(r.ofertas[0], null);
    assert.equal(r.pendente, null);
  });

  test("o mesmo pedido não reabre nem reenvia em re-render", async () => {
    const primeiro = await correr({ explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt } });
    const depois = await correr({
      explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt },
      ultimoAutoId: 1,
      explicacaoPendente: primeiro.pendente ?? undefined,
    });
    assert.deepEqual(depois.send, []);
    assert.equal(depois.locais.length, 0, "re-render do mesmo pedido não responde outra vez");
    assert.equal(depois.abertos.length, 0, "re-render do mesmo pedido não volta a abrir a superfície");
  });
});

describe("fluxo real: autorizar retoma o pedido, UMA vez", () => {
  const autorizado = {
    explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt },
    processConsent: true,
    consentAlvo: ALVO_A,
  };

  test("envia exatamente uma vez com o texto do pedido original", async () => {
    const pend = pendente();
    const r = await correr({ ...autorizado, explicacaoPendente: pend, ultimoAutoId: 1 });
    assert.equal(r.send.length, 1, `esperava um único envio, vieram ${r.send.length}`);
    assert.equal(r.send[0][0], pend.texto);
  });

  test("o pendente é limpo depois do reenvio", async () => {
    const r = await correr({ ...autorizado, explicacaoPendente: pendente(), ultimoAutoId: 1 });
    assert.equal(r.pendente, null);
  });

  test("segunda renderização com o mesmo pendente já enviado: zero envios", async () => {
    const r = await correr({
      ...autorizado,
      explicacaoPendente: pendente(),
      ultimoAutoId: 1,
      resolvidoId: 1,
    });
    assert.deepEqual(r.send, [], "duplicação: o reenvio tem de ficar marcado como consumido");
  });

  test("autorizar OUTRO alvo não retoma o pedido do alvo anterior", async () => {
    const r = await correr({
      ...autorizado,
      consentAlvo: ALVO_B,
      explainRequest: { id: 1, pid: 9990, startedAt: ALVO_B.startedAt },
      explicacaoPendente: pendente(),
      ultimoAutoId: 1,
    });
    assert.deepEqual(r.send, [], "o consentimento do processo B não pode enviar as medições de A");
  });

  test("mesmo PID com outra instância autorizada não retoma", async () => {
    const r = await correr({
      explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A_OUTRA_INSTANCIA.startedAt },
      processConsent: true,
      consentAlvo: ALVO_A_OUTRA_INSTANCIA,
      explicacaoPendente: pendente(),
      ultimoAutoId: 1,
    });
    assert.deepEqual(r.send, []);
  });

  test("identidade perdida entre o clique e a autorização: não reenvia", async () => {
    const r = await correr({
      explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt },
      explainIdentity: "reutilizado",
      processConsent: true,
      consentAlvo: ALVO_A,
      explicacaoPendente: pendente(),
      ultimoAutoId: 1,
    });
    assert.deepEqual(r.send, []);
  });
});

describe("payload real de um reenvio autorizado", () => {
  test("processPayload só inclui o contexto quando o alvo autoriza", () => {
    const comConsentimento = processPayload(CONTEXTO as never, true);
    const semConsentimento = processPayload(CONTEXTO as never, false);
    assert.ok(JSON.stringify(comConsentimento).includes("4712"), "o contexto medido tem de sair quando autorizado");
    assert.equal(JSON.stringify(semConsentimento).includes("4712"), false, "nada de processo sem autorização");
  });

  test("a allowlist do contexto corta caminhos, comandos e utilizador", () => {
    // A garantia de privacidade mora em `buildProcessMatrixContext` (allowlist
    //explicita), nao em `processPayload`, que so decide SE leva o contexto ja
    // filtrado. Testar o sitio errado daria verde a uma promesa falsa.
    const diagnosticoSujo = {
      measuredAt: "2026-10-23T09:05:00.000Z",
      ram: { totalMb: 16384, usedMb: 12000, availableMb: 4384 },
      cpuPercent: 37.5,
      topProcesses: [
        {
          pid: 4712,
          name: "C:\\Users\\caioc\\recursos\\MsMpEng.exe",
          startedAt: ALVO_A.startedAt,
          cpuPercent: 9.1,
          workingSetMb: 1780,
          commandLine: "C:\\Windows\\System32\\MsMpEng.exe -p C:\\Users\\caioc\\secret.txt",
          cwd: "C:\\Users\\caioc",
          user: "caioc",
        },
      ],
      trends: [],
      limitations: [],
      recommendations: [],
    };
    const snapshotSujo = {
      pid: 4712,
      name: "C:\\Windows\\System32\\MsMpEng.exe",
      startedAt: ALVO_A.startedAt,
      cpu: 9.1,
      memoryMb: 1780,
      commandLine: "C:\\Windows\\System32\\MsMpEng.exe -p C:\\Users\\caioc\\secret.txt",
      exe: "C:\\Windows\\System32\\MsMpEng.exe",
      user: "caioc",
    };
    const contextoFiltrado = buildProcessMatrixContext(diagnosticoSujo as never, 4712, snapshotSujo as never);
    const saida = JSON.stringify(processPayload(contextoFiltrado, true)).toLowerCase();
    for (const proibido of ["commandline", "c:\\", "secret", "cwd", "caioc", "users", "system32"]) {
      assert.equal(saida.includes(proibido), false, `o payload levou «${proibido}»`);
    }
    // O nome sobrevive so como nome curto de processo, nao como caminho.
    assert.ok(saida.includes("msmpeng.exe"), "o nome do processo e permitido e esperado");
  });
});

// ── 5. FLUXO REAL de envio: origem e estado por RESULTADO ────────────────────
// Os casos acima provam QUANDO se envia. Este prova o que fica na mensagem
// quando se envia: `origin` (de onde veio) e `state` (porquê) têm de ser
// verdadeiros em cada desfecho — autorizado, recusado, 429, timeout, stream
// incompleto e resposta atrasada. Mesma técnica: o corpo real é recortado do
// componente; nada de reimplementar a decisão no teste.

const corpoEnvio = (): string => {
  const i = linhas.findIndex((l) => l === "  const sendToServer = useCallback(");
  assert.ok(i >= 0, "sendToServer não encontrado");
  const d = linhas.findIndex((l, k) => k > i && /explainIdentity[^\]]*\],\s*$/.test(l));
  const j = linhas.findIndex((l, k) => k > d && l === "  )");
  assert.ok(d > i && j > d, "corpo de sendToServer/processMessage mudou de forma");
  return linhas.slice(i, j + 1).join("\n");
};

type CasoEnvio = {
  texto: string;
  processConsent?: boolean;
  consentAlvo?: AlvoProcesso | null;
  explainRequest?: { id: number; pid?: number; startedAt?: string | null } | null;
  explainIdentity?: string;
  processContext?: unknown | null;
  respostaLocal?: { reply: string } | null;
  fornecedor?: "ok" | "429" | "no_provider" | "sem-conteudo" | "timeout";
  /** Geraçao actual à chegada da resposta: simula uma resposta atrasada. */
  geracaoAvancada?: boolean;
  /** A porta única chama `processMessage(..., forcar=true)`; testar as duas. */
  forcar?: boolean;
  /** `mode` começa em local por omissão no produto (sem sonda inicial). */
  mode?: "local" | "online";
  /** Cooldown local activo, em ms a contar de agora. */
  cooldownMs?: number;
  /** Diagnóstico local que já estava na conversa antes do opt-in. */
  mensagemLocal?: string | null;
};

async function correrEnvio(c: CasoEnvio) {
  const dir = mkdtempSync(tmpdir() + "/cybersafe-matrix-envio-");
  temporarios.push(dir);
  const fornecedor = c.fornecedor ?? "ok";
  const prelude = `
import { originDaResposta, motivoDoEncaminhamentoLocal, decisaoAposTentativaLocal, estadoDoMotivoLocal, estadoDoResultado, acrescentarMensagem, promptDeExplicacaoDeProcesso } from ${JSON.stringify(urlModulo("src/lib/matrixConversation.ts"))};
import { isProcessQuestion, perguntaApontaParaAlvo, buildProcessLocalReply, buildIdentityLostReply, processPayload, processChatHistory, matrixTelemetryContext, alvoDeExplicacao, consentValeParaAlvo, autorizacaoValida, identidadeDeExplicacaoPerdida } from ${JSON.stringify(urlModulo("src/lib/processMatrix.ts"))};
import { isLocalSecurityQuestion, shouldDiscardLateAnswer } from ${JSON.stringify(urlModulo("src/lib/localSecurityReply.ts"))};
const R = ((globalThis.__eSpies ??= { chamadas: [] as any[], anexadas: [] as any[] }));
const useCallback = (fn: any) => fn;
const window = { electronAPI: null };
const cancelLocalSecurityRequest = (_c: any) => {};
const answerLocalSecurityQuestion = async () => (${JSON.stringify(c.respostaLocal ?? null)});
const authHeaders = () => ({ Authorization: "Bearer fixture-de-teste" });
const API_BASE = "http://127.0.0.1:59999";
const PAGE_LABELS: any = { dashboard: "Painel", tasks: "Processos" };
const MAX_HISTORY = 16, MAX_RETRIES = 2, STREAM_TIMEOUT_MS = 90_000;
const offlineReply = (_t: string, _p: any) => ({ content: "resposta offline de teste", isOffTopic: false, isDanger: false });
const codificar = new TextEncoder();
const chunk = (t: string) => codificar.encode(t);
const fetch = async (_url: any, init: any) => {
  R.chamadas.push(JSON.parse(init.body));
  if (${JSON.stringify(fornecedor)} === "timeout") throw new Error("fixture: expirou o prazo do fornecedor");
  if (${JSON.stringify(fornecedor)} !== "ok") return { ok: false, json: async () => (${JSON.stringify(fornecedor)} === "429" ? { code: "rate_limited", message: "limite" } : { code: "no_provider", message: "sem fornecedor" }) };
  const eventos = ${JSON.stringify(fornecedor)} === "sem-conteudo"
    ? ["data: {\\"done\\":true}\\n\\n"]
    : ["data: {\\"delta\\":\\"resposta \\"}\\n\\n", "data: {\\"done\\":true}\\n\\n"];
  let i = 0;
  return { ok: true, body: { getReader: () => ({ read: async () => (i < eventos.length ? { done: false, value: chunk(eventos[i++]) } : { done: true }) }) }, json: async () => ({}) };
};
let messages: any[] = ${JSON.stringify([
    { role: "assistant", content: "Oi!" },
    ...(c.mensagemLocal
      ? [{ role: "assistant", content: c.mensagemLocal, origin: "local", state: "local" }]
      : []),
  ])};
const phase = "idle";
const currentPage: any = "tasks";
const context = "CPU 37%, RAM 12 GB";
const mode = ${JSON.stringify(c.mode ?? "online")};
const modoConversa = "online";
const localUntilRef = { current: ${(c.cooldownMs ?? 0) > 0 ? `Date.now() + ${c.cooldownMs}` : "0"} };
const questionGenerationRef = { current: 0 };
const abortRef: any = { current: null };
const stickToBottomRef = { current: true };
const streamedRef = { current: "" };
const setStreamed = (_v: string) => {};
const setInput = (_v: string) => {};
const setOfertaIa = (_v: any) => {};
const setPhase = (_v: string) => {};
import { minimizeContextForAi } from ${JSON.stringify(urlModulo("src/lib/aiContextBuilder.ts"))};
const setProviderState = (_v: string) => {};
const setMode = (_v: string) => {};
const processDiagnostic: any = { measuredAt: "2026-10-23T09:05:00.000Z", ram: { totalMb: 16384, usedMb: 12000, availableMb: 4384 }, cpuPercent: 37.5, topProcesses: [], trends: [], limitations: [], recommendations: [] };
const processContext: any = ${JSON.stringify(c.processContext === undefined ? CONTEXTO : c.processContext)};
const explainRequest: any = ${JSON.stringify(c.explainRequest ?? null)};
const explainIdentity = ${JSON.stringify(c.explainIdentity ?? "presente")};
const processConsent = ${String(c.processConsent ?? false)};
const consentAlvo: any = ${JSON.stringify(c.consentAlvo ?? null)};
const consentimentoProcessoEfectivo = processConsent && consentValeParaAlvo(consentAlvo, alvoDeExplicacao(explainRequest ?? null));
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
  // «Resposta atrasada» em produção não é um contador que avança sozinho: é uma
  // pergunta nova, que instala uma identidade nova no componente (o `++` e o
  // `pedidoActivoRef.current = identidade` antes de qualquer await). O avanço
  // simula exactamente essas duas linhas — só o `questionGenerationRef` não
  // chega, porque a decisão passou a ser por pedido, conversa e alvo.
  const avanço = c.geracaoAvancada
    ? "questionGenerationRef.current += 1;\n" +
      "pedidoActivoRef.current = { requestId: 'r' + questionGenerationRef.current, conversationId, targetId: alvoDePedido(alvoActual) ?? 'sem-alvo', geracao: questionGenerationRef.current };\n"
    : "";
  const ficheiro = dir + "/envio.ts";
  writeFileSync(
    ficheiro,
    prelude +
      "\n" +
      corpoEnvio() +
      `\nexport const enviar = async (t: string, r?: boolean) => { const p = processMessage(t, r, ${String(c.forcar === true)}); ` +
      avanço +
      "await p; return { ...globalThis.__eSpies, historico: messages }; };\n",
  );
  delete (globalThis as any).__eSpies;
  const mod = await import("file:///" + ficheiro.replaceAll("\\", "/"));
  const spies = await mod.enviar(c.texto);
  return {
    payload: spies.chamadas as any[],
    historico: spies.historico as Array<{ role: string; content: string; origin?: string; state?: MatrixRequestState }>,
    anexadas: spies.anexadas as Array<{ role: string; content: string; origin?: string; state?: MatrixRequestState }>,
    anexada: spies.anexadas.at(-1) as
      | { role: string; content: string; origin?: string; state?: MatrixRequestState; privateProcessData?: boolean }
      | undefined,
  };
}

describe("fluxo real de envio: estado honesto por desfecho", () => {
  test("autorizado e concluído: origem «ai», estado «generativa», contexto medido no payload", async () => {
    const r = await correrEnvio({
      texto: promptDeExplicacaoDeProcesso(4712),
      processConsent: true,
      consentAlvo: ALVO_A,
      explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt },
    });
    assert.equal(r.payload.length, 1, "autorizado tem de usar o provider configurado");
    assert.equal(r.anexada?.origin, "ai");
    assert.equal(r.anexada?.state, "generativa");
    assert.ok(JSON.stringify(r.payload[0]).includes("4712"), "o contexto real permitido tem de seguir no pedido");
  });

  test("recusa explícita: origem local, estado «necessita-autorizacao», zero chamadas", async () => {
    const r = await correrEnvio({
      texto: promptDeExplicacaoDeProcesso(4712),
      processConsent: false,
      explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt },
    });
    assert.deepEqual(r.payload, [], "sem autorização nada sai do renderer");
    assert.equal(r.anexada?.origin, "local");
    assert.equal(r.anexada?.state, "necessita-autorizacao");
  });

  test("429 depois de autorizar: origem local, estado «erro-recuperavel»", async () => {
    const r = await correrEnvio({
      texto: promptDeExplicacaoDeProcesso(4712),
      processConsent: true,
      consentAlvo: ALVO_A,
      explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt },
      fornecedor: "429",
    });
    assert.equal(r.anexada?.origin, "local", "limite de pedidos nunca é «IA»");
    assert.equal(r.anexada?.state, "erro-recuperavel");
  });

  test("sem fornecedor: estado «indisponivel», nunca «necessita-autorizacao»", async () => {
    const r = await correrEnvio({
      texto: promptDeExplicacaoDeProcesso(4712),
      processConsent: true,
      consentAlvo: ALVO_A,
      explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt },
      fornecedor: "no_provider",
    });
    assert.equal(r.anexada?.state, "indisponivel", "a causa é o fornecedor, não a pessoa");
  });

  test("falha de rede/timeout: continua local com estado, sem fingir IA", async () => {
    const r = await correrEnvio({
      texto: promptDeExplicacaoDeProcesso(4712),
      processConsent: true,
      consentAlvo: ALVO_A,
      explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt },
      fornecedor: "timeout",
    });
    assert.equal(r.anexada?.origin, "local");
    assert.equal(r.anexada?.state, "erro-recuperavel");
  });

  test("stream que abre e não conclui: «indisponivel», não «generativa»", async () => {
    const r = await correrEnvio({
      texto: promptDeExplicacaoDeProcesso(4712),
      processConsent: true,
      consentAlvo: ALVO_A,
      explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt },
      fornecedor: "sem-conteudo",
    });
    assert.equal(r.anexada?.origin, "local");
    assert.equal(r.anexada?.state, "indisponivel");
  });

  test("resposta atrasada é descartada: nada é anexado depois de uma nova pergunta", async () => {
    const r = await correrEnvio({
      texto: promptDeExplicacaoDeProcesso(4712),
      processConsent: true,
      consentAlvo: ALVO_A,
      explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt },
      geracaoAvancada: true,
    });
    assert.equal(r.payload.length, 1, "o pedido chegou a sair");
    // O que se anexa é a pergunta da pessoa (antes do envio). A resposta que
    // chega depois de a geração ter avançado NÃO pode ser anexada: se o último
    // registo fosse da assistente, a conversa mostrava uma resposta obsoleta.
    assert.equal(r.anexada?.role, "user", "a resposta atrasada não pode aparecer na conversa");
    assert.equal(r.anexadas.filter((m) => m.role === "assistant").length, 0, "nenhuma resposta da assistente pode entrar");
    assert.equal(r.anexada?.content, promptDeExplicacaoDeProcesso(4712));
  });

  test("opt-in explícito com consentimento válido vence «mode local» e o cooldown", async () => {
    // Reviewflow: já não há sonda inicial a `/api/ai/status`, por isso `mode`
    // começa em local; uma falha antiga também deixa cooldown. A escolha explícita
    // e autorizada tem de chegar ao chat na mesma.
    const r = await correrEnvio({
      texto: promptDeExplicacaoDeProcesso(4712),
      processConsent: true,
      consentAlvo: ALVO_A,
      explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt },
      mode: "local",
      cooldownMs: 10 * 60_000,
      forcar: true,
    });
    assert.equal(r.payload.length, 1, "o opt-in explícito e autorizado tem de chamar o chat");
    assert.equal(r.anexada?.origin, "ai");
    assert.equal(r.anexada?.state, "generativa");
  });

  test("sem opt-in explícito, «mode local» + cooldown continua a responder localmente", async () => {
    const r = await correrEnvio({
      texto: promptDeExplicacaoDeProcesso(4712),
      processConsent: true,
      consentAlvo: ALVO_A,
      explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt },
      mode: "local",
      cooldownMs: 10 * 60_000,
      forcar: false,
    });
    assert.deepEqual(r.payload, [], "sem a escolha explícita, o cooldown continua a valer");
    assert.equal(r.anexada?.origin, "local");
    assert.equal(r.anexada?.state, "indisponivel");
  });

  test("falha do fornecedor no opt-in mantém o diagnóstico local já mostrado", async () => {
    const diagnostico = "DIAGNÓSTICO LOCAL fixture: MsMpEng, 1780 MB";
    const r = await correrEnvio({
      texto: promptDeExplicacaoDeProcesso(4712),
      processConsent: true,
      consentAlvo: ALVO_A,
      explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt },
      mode: "local",
      cooldownMs: 10 * 60_000,
      forcar: true,
      fornecedor: "no_provider",
      mensagemLocal: diagnostico,
    });
    assert.equal(r.payload.length, 1, "o opt-in tentou o fornecedor uma vez");
    assert.equal(r.historico[1]?.content, diagnostico, "a explicação local continua na conversa, intacta");
    assert.equal(r.anexada?.origin, "local");
    assert.equal(r.anexada?.state, "indisponivel");
  });

  test("contexto em falta partilha o estado da autorização (limitação registada)", async () => {
    // Medido, não desejado: `motivoDoEncaminhamentoLocal` devolve o mesmo
    // `sem-consentimento` para «não autorizaste» e para «não há medições». O gate
    // já não promete um reenvio no segundo caso (`devePedirAutorizacaoAntes` exige
    // `temContextoProcesso`), mas separar os dois motivos é mudança de contrato
    // com testes próprios — fica declarado como resíduo, não escondido aqui.
    const r = await correrEnvio({
      texto: promptDeExplicacaoDeProcesso(4712),
      processConsent: true,
      consentAlvo: ALVO_A,
      explainRequest: { id: 1, pid: 4712, startedAt: ALVO_A.startedAt },
      processContext: null,
    });
    assert.deepEqual(r.payload, []);
    assert.equal(r.anexada?.state, "necessita-autorizacao", "motivo partilhado: consentimento OU contexto em falta");
  });
});

describe("conteúdo do pedido: nada inventado", () => {
  test("tendências só seguem as medidas", () => {
    const dito = { ...CONTEXTO, trends: [], limitations: ["tendência indisponível"] };
    const saida = processPayload(dito as never, true) as { processIntelligence?: { trends?: unknown[] } };
    assert.deepEqual(saida.processIntelligence?.trends ?? [], [], "nenhuma tendência entra sem amostra medida");
    assert.doesNotMatch(JSON.stringify(saida).toLowerCase(), /vai explodir|provavelmente vai|vai aumentar nos proximos/);
  });

  test("sem amostras de tendência, `buildProcessMatrixContext` não cria série", () => {
    const dito = {
      measuredAt: "2026-10-23T09:05:00.000Z",
      ram: { totalMb: 16384, usedMb: 12000, availableMb: 4384 },
      cpuPercent: 37.5,
      topProcesses: [
        { pid: 4712, name: "MsMpEng.exe", startedAt: ALVO_A.startedAt, cpuPercent: 9.1, workingSetMb: 1780 },
      ],
      trends: [{ pid: 9999, startedAt: "2026-01-01T00:00:00.000Z", previousMb: 1, currentMb: 2, deltaMb: 1, intervalMs: 1000, samples: 2 }],
      limitations: [],
      recommendations: [],
    };
    const contexto = buildProcessMatrixContext(dito as never, 4712, undefined as never);
    assert.deepEqual(contexto.trends, [], "tendência de outro processo não entra na amostra deste");
  });
});

// ── 6. FLUXO COMPLETO: o handler REAL de recusa, do clique ao resultado ─────
//
// Motivado pela revisao de Codex Lead: o pedido de autorizacao nascia com a caixa
// desmarcada e a unica recusa vivia no `onChange` de `!checked` — a partir de
// «desmarcado» esse evento nao se dispara, pelo que o pendente nao tinha saida.
// Regex nao apanha isso; so executar o handler comeca a apanhar.
//
// Aqui vive o componente todo junto, recortado do mesmo fonte: os dois efeitos, a
// porta unica de envio, o handler de recusa e o `sendToServer`/`processMessage`
// reais. O `fetch` e um spy. Cada `render()` e uma passagem de renderizacao com o
// estado que o React lhe daria; os `set*` preparam o estado da SEGUINTE passagem.

const DECLARACAO_PORTA = "const enviarPeloFluxoNormal = (texto: string, forcarLocal = false) =>";
const DECLARACAO_RECUSA = "const recusarExplicacaoPendente = () => {";
const DECLARACAO_AUTORIZAR = "const autorizarAlvoEmCausa = async (modo";
const DECLARACAO_INVALIDAR = "const invalidarConsentimentoLocal = useCallback";
const DECLARACAO_ASSINATURA_REVOGACAO = "useEffect(() => subscreverRevogacaoDeConsentimento";

/** O handler REAL de autorização, recortado do componente: sem segunda cópia da regra. */
const corpoAutorizar = (): string => extrairFuncao(DECLARACAO_AUTORIZAR);
/** A invalidação REAL, a mesma que o evento de Configurações executa. */
const corpoInvalidar = (): string => extrairCallback(DECLARACAO_INVALIDAR, "}, [aplicarConsentimentoExterno])");

const CONTEXTO_FIXO = {
  version: 1,
  measuredAt: "2026-10-23T09:05:00.000Z",
  ram: { totalMb: 16384, usedMb: 12000, availableMb: 4384 },
  cpuPercent: 37.5,
  topProcesses: [],
  selectedProcess: { pid: 4712, name: "MsMpEng.exe", startedAt: "2026-10-23T09:00:00.000Z", cpuPercent: 9.1, workingSetMb: 1780 },
  trends: [],
  limitations: [],
};

const PEDIDO_A = { id: 1, pid: 4712, startedAt: "2026-10-23T09:00:00.000Z" };
const PEDIDO_B = { id: 2, pid: 9990, startedAt: "2026-10-23T09:20:00.000Z" };
const ALVO_A_STR = { pid: 4712, startedAt: "2026-10-23T09:00:00.000Z" };
const ALVO_B_STR = { pid: 9990, startedAt: "2026-10-23T09:20:00.000Z" };
// Instante fixo da «renderização»: a duração do consentimento é tempo de relógio
// real, e um teste que depende dele não pode depender de quando corre.
const AGORA_FIXO = Date.parse("2026-10-23T09:30:00.000Z");

async function montarFluxo() {
  const dir = mkdtempSync(tmpdir() + "/cybersafe-matrix-fluxo-");
  temporarios.push(dir);
  const corpo = `
import { minimizeContextForAi } from ${JSON.stringify(urlModulo("src/lib/aiContextBuilder.ts"))};
const setProviderState = (_v: string) => {};
import { deveAutoEnviarExplicacao, promptDeExplicacaoDeProcesso, devePedirAutorizacaoAntes, originDaResposta, motivoDoEncaminhamentoLocal, decisaoAposTentativaLocal, estadoDoMotivoLocal, estadoDoResultado, acrescentarMensagem } from ${JSON.stringify(urlModulo("src/lib/matrixConversation.ts"))};
import { isProcessQuestion, perguntaApontaParaAlvo, buildProcessLocalReply, buildIdentityLostReply, processPayload, processChatHistory, matrixTelemetryContext, alvoDeExplicacao, alvoParaConsentimento, consentValeParaAlvo, autorizacaoValida, identidadeDeExplicacaoPerdida, deveReenviarExplicacaoAposAutorizacao, revogarAlvo, autorizarAlvo, limparAutorizacoesExpiradas } from ${JSON.stringify(urlModulo("src/lib/processMatrix.ts"))};
import { isLocalSecurityQuestion, shouldDiscardLateAnswer } from ${JSON.stringify(urlModulo("src/lib/localSecurityReply.ts"))};
import { alvoDePedido, descartarResposta, traceDePedido, bloqueioDeConsentimentoAplica, revalidarAntesDoEnvio } from ${JSON.stringify(urlModulo("src/lib/matrixRequestMachine.ts"))};
import { decidirConsentimentoDeEnvio, mesmosCamposDeConsentimento, camposDeConsentimentoNoChat, codigoDeConsentimentoRecusado, mensagemDeConsentimento, subscreverRevogacaoDeConsentimento, notificarRevogacaoDeConsentimento, alvoUnicoCanonico, autorizacaoUnicaValida, camposDeAutorizacaoUnicaNoChat, pedirAutorizacaoUnica as pedirAutorizacaoUnicaReal } from ${JSON.stringify(urlModulo("src/lib/matrixExternalConsent.ts"))};
const R = ((globalThis.__fSpies ??= { fetches: [], anexadas: [], abertos: [] }));
const useCallback = (fn) => fn;
const window = { electronAPI: null };
const cancelLocalSecurityRequest = (_c) => {};
const answerLocalSecurityQuestion = async () => (null);
const authHeaders = () => ({ Authorization: "Bearer fixture-de-teste" });
const API_BASE = "http://127.0.0.1:59999";
type MatrixConsentMode = "uma-vez" | "persistente";
const PAGE_LABELS = { dashboard: "Painel", tasks: "Processos" };
const MAX_HISTORY = 16, MAX_RETRIES = 2, STREAM_TIMEOUT_MS = 90000;
const offlineReply = (_t, _p) => ({ content: "resposta offline de teste", isOffTopic: false, isDanger: false });
const codificar = new TextEncoder();
const chunk = (t) => codificar.encode(t);
const fetch = async (_url, init) => {
  R.fetches.push(JSON.parse(init.body));
  if (R.falharProxima) {
    R.falharProxima = false;
    return { ok: false, json: async () => ({ code: "rate_limited", message: "limite" }) };
  }
  const eventos = ["data: {\\"delta\\":\\"resposta do fornecedor\\"}\\n\\n", "data: {\\"done\\":true}\\n\\n"];
  let i = 0;
  return { ok: true, body: { getReader: () => ({ read: async () => (i < eventos.length ? { done: false, value: chunk(eventos[i++]) } : { done: true }) }) }, json: async () => ({}) };
};
let messages = [{ role: "assistant", content: "Oi!" }];
const setMessages = (fn) => { const proximas = typeof fn === "function" ? fn(messages) : fn; for (const m of proximas.slice(messages.length)) R.anexadas.push(m); messages = proximas; };
const messagesRef = { current: messages };
const substituirMensagens = (next) => { messagesRef.current = next; setMessages(next); };
const anexarMensagem = (msg) => { const next = [...messagesRef.current, msg]; messagesRef.current = next; setMessages(next); };
const abortRef = { current: null };
const questionGenerationRef = { current: 0 };
const ultimoExplicacaoAutoRef = { current: null };
const intencaoExplicarRef = { current: null };
const ultimaExplicacaoLocalRef = { current: null };
const explicacaoResolvidaRef = { current: null };
const localUntilRef = { current: 0 };
const streamedRef = { current: "" };
const stickToBottomRef = { current: true };
const phase = "idle";
const mode = "online";
const modoConversa = "online";
const currentPage = "tasks";
const context = "CPU 37%, RAM 12 GB";
const processDiagnostic = { measuredAt: "2026-10-23T09:05:00.000Z", ram: { totalMb: 16384, usedMb: 12000, availableMb: 4384 }, cpuPercent: 37.5, topProcesses: [], trends: [], limitations: [], recommendations: [] };
const setPhase = () => {};
const setMode = () => {};
const setStreamed = () => {};
let consentCarregando = false;
const setConsentCarregando = (v) => { consentCarregando = v; };
const setConsentErro = (_v) => {};
const setUpOpenState = () => {};
let setInputUltimo = null;
const setInput = (v) => { setInputUltimo = v; };

let explainRequest = null;
let explainIdentity = "presente";
let processContext = CONTEXTO_FIXO;
let explicacaoPendente = null;
let autorizacaoAberta = false;
// O estado do produto é uma LISTA de alvos autorizados, não um booleano global.
// O fixture antigo (processConsent + consentAlvo) traduz-se para essa forma
// real, e é a store de produção (revogarAlvo, limparAutorizacoesExpiradas,
// consentValeParaAlvo) que decide — o harness não reimplementa a regra.
let processConsent = false;
let consentAlvo = null;
let autorizacoes = [];
let agora = ${AGORA_FIXO};
let alvoExplicacao = null;
let alvoActual = null;
let alvoAutorizado = null;
let autorizacoesVivas = [];
let consentimentoProcessoEfectivo = false;
const consentimentoVivoAgora = () => {
  if (consentimentoBloqueadoRef.current) return false;
  if (autorizacaoValida(autorizacoes, alvoActual, Date.now())) return true;
  const externo = consentimentoExternoRef.current;
  return externo.descriptor !== null && externo.grant !== null
    && decidirConsentimentoDeEnvio({ descriptor: externo.descriptor, grant: externo.grant }, "persistente", externo.grant.userId, Date.now()).ok;
};
const conversationId = "cnv-fluxo-fixture";
const pedidoActivoRef = { current: null };
const contaId = "user_fixture";
const DESCRIPTOR_FIXTURE = { providerKey: "a".repeat(64), providerLabel: "Fornecedor fixture", purpose: "matrix-process-explanation:v1", fields: ["version", "measuredAt", "ram", "cpuPercent", "topProcesses", "selectedProcess", "trends", "limitations"], installationId: "inst_fixture", validityDays: 30 };
const GRANT_FIXTURE = { id: "grant_fixture", userId: "user_fixture", installationId: "inst_fixture", providerKey: "a".repeat(64), purpose: "matrix-process-explanation:v1", fields: ["version", "measuredAt", "ram", "cpuPercent", "topProcesses", "selectedProcess", "trends", "limitations"], allowFutureProcesses: true, persistent: true, createdAt: "2026-10-23T10:00:00.000Z", expiresAt: "2026-11-22T10:00:00.000Z", revokedAt: null, revision: 1 };
const consentimentoExternoRef = { current: { descriptor: null, grant: null } };
const autorizacoesOneShotRef = { current: new Set<string>() };
const autorizacaoUnicaRef = { current: null };
const consentimentoBloqueadoRef = { current: false };
const contaIdRef = { current: "user_fixture" };
let consentimentoBloqueado = false;
const setConsentimentoBloqueado = (v) => { consentimentoBloqueado = !!v; };
let chaveConsentimento = "maquina";
let postsConsentimento = 0;
let postsUnicos = 0;
const pedirAutorizacaoUnica = async (base, descriptor, target, headers) => {
  postsUnicos += 1;
  return pedirAutorizacaoUnicaReal(base, descriptor, target, headers, async (_url, init) => {
    const body = JSON.parse(init.body);
    if (!body.target || body.target.pid !== target.pid || body.target.startedAt !== target.startedAt) throw new Error("wrong one-shot target");
    return new Response(JSON.stringify({descriptor, authorization: {
      token: "3f0c1a44-9f0e-4a3b-8f1d-2b6c5d7e8f90", providerKey: descriptor.providerKey,
      purpose: descriptor.purpose, fields: descriptor.fields, target,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+120000).toISOString(), ttlSeconds:120
    }}), {status:200});
  });
};
const lerConsentimento = async () => ({ descriptor: DESCRIPTOR_FIXTURE, grant: consentimentoExternoRef.current.grant });
const criarConsentimento = async () => { postsConsentimento += 1; return { ok: true, state: { descriptor: DESCRIPTOR_FIXTURE, grant: GRANT_FIXTURE } }; };
const revogarConsentimento = async () => ({ ok: true });
let alvoConsentimento = alvoParaConsentimento(alvoActual);
const aplicarConsentimentoExterno = (v: any) => { consentimentoExternoRef.current = v; };
const setAutorizacoes = (v) => { autorizacoes = typeof v === "function" ? v(autorizacoes) : v; };
${corpoInvalidar()}
let cancelarAvisoDeRevogacao;
const useEffect = (fn) => { cancelarAvisoDeRevogacao = fn(); };
${extrairAssinaturaDeRevogacao()}
export const invalidar = (bloquear = true) => invalidarConsentimentoLocal(bloquear);
export const revogarViaConfiguracoes = (aviso) => notificarRevogacaoDeConsentimento(aviso);
export const pararAvisoDeRevogacao = () => cancelarAvisoDeRevogacao?.();

let nxt = { pendente: null, aberto: false };
const setExplicacaoPendente = (v) => { nxt.pendente = typeof v === "function" ? v(explicacaoPendente) : v; };
let ofertaRender: any = null;
const setOfertaIa = (v: any) => { ofertaRender = v; };
const setAutorizacaoAberta = (v) => { nxt.aberto = typeof v === "function" ? v(autorizacaoAberta) : v; R.abertos.push(nxt.aberto); };
const processMessageRef = { current: null };

${corpoEnvio()}
processMessageRef.current = processMessage;
${corpoAutorizar()}
export const autorizar = async (modo) => { await autorizarAlvoEmCausa(modo); return { autorizacoes: autorizacoes.slice(), oneShot: [...autorizacoesOneShotRef.current], posts: postsConsentimento, oneShotPosts: postsUnicos, grant: consentimentoExternoRef.current.grant?.id ?? null }; };
export const enviar = (texto, retry = false) => processMessageRef.current(texto, retry, false, false);
export const falharProxima = () => { R.falharProxima = true; };

${extrairFuncao(DECLARACAO_PORTA)}

${extrairFuncao(DECLARACAO_RECUSA)}

const corpoExplicar = () => {
${extrairEfeito("if (!explainRequest) return", "  }, [explainRequest")}
};
const corpoReenvio = () => {
${extrairEfeito("if (!explicacaoPendente) return", "  }, [explicacaoPendente")}
};

export async function render(e) {
  explainRequest = e.explainRequest ?? null;
  explainIdentity = e.explainIdentity ?? "presente";
  processContext = e.processContext === undefined ? CONTEXTO_FIXO : e.processContext;
  processConsent = !!e.processConsent;
  consentAlvo = e.consentAlvo ?? null;
  explicacaoPendente = e.explicacaoPendente === undefined ? null : e.explicacaoPendente;
  autorizacaoAberta = !!e.autorizacaoAberta;
  nxt = { pendente: explicacaoPendente, aberto: autorizacaoAberta };
  // Autorizacao expressa no fixture, na forma que o produto guarda: lista de
  // alvos com instante de concessao (a duracao vive na store, nao aqui).
  autorizacoes = processConsent && consentAlvo ? [{ alvo: consentAlvo, concedidoEm: Date.now() }] : [];
  agora = AGORA_FIXO;
  // Derivacao igual à do componente (AIAssistant.tsx:381-393): alvo do clique,
  // senão o do processo mostrado; depois expiração, depois coincidência.
  alvoExplicacao = alvoDeExplicacao(explainRequest ?? null);
  alvoActual = alvoExplicacao ?? (processContext && processContext.selectedProcess
    ? { pid: processContext.selectedProcess.pid, startedAt: processContext.selectedProcess.startedAt ?? null }
    : null);
  alvoConsentimento = alvoParaConsentimento(alvoActual);
  chaveConsentimento = alvoDePedido(alvoConsentimento) ?? "maquina";
  autorizacoesVivas = limparAutorizacoesExpiradas(autorizacoes, agora);
  alvoAutorizado = autorizacoesVivas.find((a) => consentValeParaAlvo(a.alvo, alvoActual))?.alvo ?? null;
  const externo = consentimentoExternoRef.current;
  const grantPersistenteActivo = externo.descriptor !== null && externo.grant !== null
    && decidirConsentimentoDeEnvio({ descriptor: externo.descriptor, grant: externo.grant }, "persistente", externo.grant.userId, agora).ok;
  consentimentoProcessoEfectivo = !consentimentoBloqueado && (alvoAutorizado !== null || grantPersistenteActivo);
  corpoExplicar();
  corpoReenvio();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  return { pendente: nxt.pendente, aberto: nxt.aberto, oferta: ofertaRender };
}
export async function recusar() { recusarExplicacaoPendente(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
export const iniciarPedidoEmVoo = () => { const controlador = new AbortController(); abortRef.current = controlador; return controlador; };
export const estado = () => ({ fetches: R.fetches.slice(), anexadas: R.anexadas.slice(), abertos: R.abertos.slice(), input: setInputUltimo, posts: postsConsentimento, grant: consentimentoExternoRef.current.grant?.id ?? null, bloqueado: consentimentoBloqueado, oneShot: [...autorizacoesOneShotRef.current], pendente: nxt.pendente, geracao: questionGenerationRef.current, pedidoActivo: pedidoActivoRef.current });
`;
  // `.ts` e obrigatorio: o corpo recortado do produto traz sintaxe de tipos
  // (`as const` em cada mensagem local), que so o pipeline TS do tsx digesta.
  const ficheiro = dir + "/fluxo.ts";
  const cabecalho = "const CONTEXTO_FIXO = " + JSON.stringify(CONTEXTO_FIXO) + ";\n" +
    // O instante fixo tem de existir DENTRO do módulo gerado: `render` corre lá,
    // e o consentimento compara-se a ele para expirar.
    "const AGORA_FIXO = " + AGORA_FIXO + ";\n";
  writeFileSync(ficheiro, cabecalho + corpo);
  delete globalThis.__fSpies;
  // O efeito real de revogação usa o `window` por omissão do helper, que em
  // Node não existe. O alvo fica disponível antes do import para o listener
  // ser registado no EventTarget desta sessão — não é um segundo listener.
  const alvoEventos = new EventTarget();
  (globalThis as unknown as { window: EventTarget }).window = alvoEventos;
  const mod = await import("file:///" + ficheiro.replaceAll("\\", "/"));
  return Object.assign(mod, { alvoEventos });
}

describe("fluxo completo: diagnóstico local primeiro, IA opt-in", () => {
  test("clique responde localmente, sem pedido pendente e sem tocar o fornecedor", async () => {
    const m = await montarFluxo();
    const r = await m.render({ explainRequest: PEDIDO_A });
    assert.equal(r.pendente, null, "a resposta deixou de depender de autorização");
    assert.equal(r.aberto, false, "o cartão não abre sozinho");
    const e = m.estado();
    assert.equal(e.fetches.length, 0, "o clique não pode tocar o fornecedor");
    assert.equal(e.anexadas.length, 1, "uma resposta local imediata");
    assert.equal(e.anexadas[0].role, "assistant");
    assert.equal(e.anexadas[0].origin, "local");
    assert.equal(e.anexadas[0].state, "local");
    assert.match(e.anexadas[0].content, /DIAGNÓSTICO LOCAL/);
    assert.equal(r.oferta?.alvo?.pid, PEDIDO_A.pid, "a opção de IA fica disponível, sem pedir nada");
  });

  test("clique real com fornecedor indisponível e sem consentimento: responde local e faz zero fetch de chat", async () => {
    const m = await montarFluxo();
    const r = await m.render({ explainRequest: PEDIDO_A, processConsent: false });
    const e = m.estado();
    assert.equal(e.fetches.length, 0, "sem rede, o diagnóstico local continua");
    assert.equal(e.anexadas.length, 1);
    assert.equal(e.anexadas[0].origin, "local");
    assert.equal(e.anexadas[0].state, "local");
    assert.equal(r.pendente, null);
    assert.equal(r.aberto, false);
  });

  test("reexecução do mesmo pedido com os mesmos dados não duplica a resposta", async () => {
    const m = await montarFluxo();
    await m.render({ explainRequest: PEDIDO_A });
    await m.render({ explainRequest: PEDIDO_A });
    await m.render({ explainRequest: PEDIDO_A });
    const e = m.estado();
    assert.equal(e.anexadas.length, 1, `três renderizações produziram ${e.anexadas.length}`);
    assert.equal(e.fetches.length, 0);
  });

  test("trocar de processo produz o diagnóstico do NOVO alvo, sem misturar", async () => {
    const m = await montarFluxo();
    await m.render({ explainRequest: PEDIDO_A });
    await m.render({ explainRequest: PEDIDO_B });
    const e = m.estado();
    assert.equal(e.anexadas.length, 2);
    assert.equal(e.anexadas.at(-1)?.state, "local");
    const ultimo = String(e.anexadas.at(-1)?.content);
    assert.match(ultimo, /não está nas medições/, "B não está no fixture: diz-se, não se substitui por A");
    assert.doesNotMatch(ultimo, /MsMpEng|1780/, "as medições de A não podem aparecer como se fossem de B");
    assert.equal(e.fetches.length, 0, "nenhum dos dois vai ao fornecedor sem opt-in");
  });

  test("autorizar a oferta de IA envia uma única vez com o contexto medido", async () => {
    const m = await montarFluxo();
    await m.render({ explainRequest: PEDIDO_A, explicacaoPendente: pendente(), processConsent: true, consentAlvo: ALVO_A_STR });
    await m.render({ explainRequest: PEDIDO_A, explicacaoPendente: null, processConsent: true, consentAlvo: ALVO_A_STR });
    const e = m.estado();
    assert.equal(e.fetches.length, 1, `o opt-in tem de enviar uma única vez, vieram ${e.fetches.length}`);
    assert.equal(e.anexadas.at(-1)?.state, "generativa");
    assert.ok(JSON.stringify(e.fetches[0]).includes("4712"), "o contexto medido do alvo autorizado segue no pedido");
  });

  test("recusa explícita (Continuar localmente) responde local e não envia", async () => {
    const m = await montarFluxo();
    await m.render({ explainRequest: null, explicacaoPendente: pendente() });
    await m.recusar();
    await m.recusar();
    const e = m.estado();
    assert.equal(e.fetches.length, 0, "recusar não pode enviar ao fornecedor");
    assert.equal(e.anexadas.length, 2, `uma pergunta e uma resposta, não mais (vieram ${e.anexadas.length})`);
    assert.equal(e.anexadas[1].role, "assistant");
    assert.equal(e.anexadas[1].origin, "local");
    assert.equal(e.anexadas[1].state, "necessita-autorizacao");
  });

  test("oferta A: autoriza um envio, zero POST persistente e não sobrevive à primeira utilização", async () => {
    const m = await montarFluxo();
    await m.render({ explainRequest: PEDIDO_A, processConsent: false });
    const a = await m.autorizar("uma-vez");
    assert.equal(a.posts, 0, "A nunca cria grant no servidor");
    assert.equal(a.oneShotPosts, 1, "A pede uma capacidade ao servidor no clique explicito");
    assert.equal(a.grant, null, "A não guarda consentimento persistente");
    assert.equal(a.oneShot.length, 1, "A fica marcada para UM envio");
    assert.equal(a.autorizacoes.length, 1, "A é uma autorização local do alvo em causa");

    await m.enviar(promptDeExplicacaoDeProcesso(4712));
    const e = m.estado();
    assert.equal(e.fetches.length, 1, "A autoriza exactamente um envio");
    const corpo = e.fetches[0] as any;
    assert.equal(corpo.processConsent, undefined, "a flag do cliente deixou de autorizar");
    assert.equal(corpo.consentAuthorization, "3f0c1a44-9f0e-4a3b-8f1d-2b6c5d7e8f90", "A viaja com a capacidade do servidor");
    assert.equal(corpo.consentGrantId, undefined, "A não leva id de grant");

    await m.enviar(promptDeExplicacaoDeProcesso(4712));
    assert.equal(m.estado().fetches.length, 1, "consumida uma vez, a segunda pergunta responde localmente");
  });

  test("oferta A é consumida mesmo quando o fornecedor falha; o retry não a reutiliza", async () => {
    const m = await montarFluxo();
    await m.render({ explainRequest: PEDIDO_A, processConsent: false });
    const a = await m.autorizar("uma-vez");
    assert.equal(a.oneShot.length, 1);

    m.falharProxima();
    await m.enviar(promptDeExplicacaoDeProcesso(4712));
    const falhou = m.estado();
    assert.equal(falhou.fetches.length, 1, "A tentou uma vez e falhou");
    assert.equal(falhou.anexadas.at(-1)?.state, "erro-recuperavel");

    await m.enviar(promptDeExplicacaoDeProcesso(4712), true);
    const retry = m.estado();
    assert.equal(retry.fetches.length, 1, "o retry não volta a usar A");
    assert.equal(retry.anexadas.at(-1)?.origin, "local");
  });

  test("revogação local limpa grant/oneShot e bloqueia o envio seguinte", async () => {
    const m = await montarFluxo();
    await m.render({ explainRequest: PEDIDO_A, processConsent: false });
    const b = await m.autorizar("persistente");
    assert.equal(b.grant, "grant_fixture");
    assert.equal(m.estado().bloqueado, false);

    m.invalidar(true);
    const limpo = m.estado();
    assert.equal(limpo.grant, null, "o grant local fecha");
    assert.deepEqual(limpo.oneShot, [], "nenhuma oferta A sobrevive");
    assert.equal(limpo.bloqueado, true, "o envio fica bloqueado");

    const antes = limpo.fetches.length;
    await m.enviar(promptDeExplicacaoDeProcesso(4712));
    assert.equal(m.estado().fetches.length, antes, "bloqueado não volta a contactar o fornecedor");
    assert.equal(m.estado().anexadas.at(-1)?.origin, "local");
  });

  test("revogação iniciada nas Configurações fecha a MATRIX na MESMA sessão", async () => {
    const m = await montarFluxo();
    // Pendente criado antes de autorizar: o evento das Configurações tem de o
    // limpar mesmo sem haver uma renderização nova entre o clique e o evento.
    await m.render({ explainRequest: null, explicacaoPendente: pendente(), processConsent: false });
    assert.equal((await m.autorizar("persistente")).grant, "grant_fixture");
    assert.equal((await m.autorizar("uma-vez")).oneShot.length, 1);
    assert.equal(m.estado().pendente?.id, 1);
    const controlador = m.iniciarPedidoEmVoo();
    const geracaoAntes = m.estado().geracao;

    // Metadata de conta errada não toca nesta sessão.
    m.revogarViaConfiguracoes({ accountId: "outra_conta", phase: "started", serverConfirmed: false });
    await new Promise((r) => setTimeout(r, 0));
    const alheio = m.estado();
    assert.equal(alheio.grant, "grant_fixture", "aviso de outra conta não apaga o grant desta");
    assert.equal(alheio.pendente?.id, 1);
    assert.equal(alheio.bloqueado, false);

    // `started` é a revogação já INICIADA, antes da resposta do DELETE.
    m.revogarViaConfiguracoes({ accountId: "user_fixture", phase: "started", serverConfirmed: false });
    await new Promise((r) => setTimeout(r, 0));
    const durante = m.estado();
    assert.equal(durante.grant, null, "o grant local fecha no início da revogação");
    assert.deepEqual(durante.oneShot, [], "nenhuma oferta A sobrevive");
    assert.equal(durante.pendente, null, "o pedido pendente é cancelado");
    assert.equal(durante.bloqueado, true, "novos envios ficam bloqueados até confirmação");
    assert.equal(durante.pedidoActivo, null, "o pedido em voo deixa de ter dono");
    assert.equal(controlador.signal.aborted, true, "a resposta em voo é abortada");
    assert.ok(durante.geracao > geracaoAntes, "a geração invalida qualquer resposta atrasada");

    const antes = durante.fetches.length;
    await m.enviar(promptDeExplicacaoDeProcesso(4712));
    assert.equal(m.estado().fetches.length, antes, "bloqueado não contacta o fornecedor");
    assert.equal(m.estado().anexadas.at(-1)?.origin, "local");

    // Confirmado sem grant: o bloqueio levanta, mas não há autoridade nova.
    m.revogarViaConfiguracoes({ accountId: "user_fixture", phase: "confirmed", serverConfirmed: true });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(m.estado().bloqueado, false);
    const depoisDeConfirmar = m.estado().fetches.length;
    await m.enviar(promptDeExplicacaoDeProcesso(4712));
    assert.equal(m.estado().fetches.length, depoisDeConfirmar, "confirmar a revogação não reabre o envio sem grant");

    // Falha do DELETE: o servidor não confirmou e o cliente continua bloqueado.
    m.revogarViaConfiguracoes({ accountId: "user_fixture", phase: "started", serverConfirmed: false });
    m.revogarViaConfiguracoes({ accountId: "user_fixture", phase: "failed", serverConfirmed: false });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(m.estado().bloqueado, true, "falha não vira autorização");

    // O cleanup do efeito remove o listener: um aviso posterior já não mexe.
    m.pararAvisoDeRevogacao();
    m.revogarViaConfiguracoes({ accountId: "user_fixture", phase: "confirmed", serverConfirmed: true });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(m.estado().bloqueado, true, "sem listener não há reabertura implícita");
  });

  test("oferta B: POST só quando escolhida e o grant cobre um PID novo sem caixa por PID", async () => {
    const m = await montarFluxo();
    await m.render({ explainRequest: PEDIDO_A, explicacaoPendente: pendente(), processConsent: false });
    assert.equal(m.estado().fetches.length, 0, "sem escolha, nada sai");
    assert.equal(m.estado().posts, 0, "sem escolha, nenhum grant é criado");

    const b = await m.autorizar("persistente");
    assert.equal(b.posts, 1, "B é o único caminho que faz POST");
    assert.equal(b.grant, "grant_fixture");
    assert.equal(b.autorizacoes.length, 0, "B não cria uma autorização local presa ao PID");
    assert.equal(b.oneShot.length, 0, "B não é uma oferta de um só envio");

    const outra = await m.autorizar("persistente");
    assert.equal(outra.posts, 1, "com grant válido, escolher B outra vez não duplica o POST");

    // O pedido que estava à espera é retomado pelo grant, sem a caixa do PID.
    await m.render({ explainRequest: PEDIDO_A, explicacaoPendente: pendente(), processConsent: false });
    await new Promise((r) => setTimeout(r, 10));
    const depoisDoPendente = m.estado();
    assert.equal(depoisDoPendente.fetches.length, 1, "B retoma o pedido pendente");
    assert.equal((depoisDoPendente.fetches[0] as any).consentGrantId, "grant_fixture");
    assert.equal((depoisDoPendente.fetches[0] as any).processConsent, undefined, "B não desce para one-shot");

    // PID NOVO: o grant autoriza sem repetir a escolha e sem autorização local.
    const contextoB = {
      ...CONTEXTO_FIXO,
      selectedProcess: { pid: 9990, name: "chrome.exe", startedAt: "2026-10-23T09:20:00.000Z", cpuPercent: 4.2, workingSetMb: 640 },
      topProcesses: [{ pid: 9990, name: "chrome.exe", startedAt: "2026-10-23T09:20:00.000Z", cpuPercent: 4.2, workingSetMb: 640 }],
    };
    await m.render({ explainRequest: PEDIDO_B, processContext: contextoB, processConsent: false });
    const antesDoNovoPid = m.estado();
    await m.enviar(promptDeExplicacaoDeProcesso(9990));
    const e = m.estado();
    assert.equal(e.fetches.length, 2, "o PID novo segue com o grant já guardado");
    const corpo = e.fetches[1] as any;
    assert.equal(corpo.consentGrantId, "grant_fixture");
    assert.equal(corpo.processConsent, undefined);
    assert.ok(JSON.stringify(corpo).includes("9990"), "o contexto medido é o do PID novo");
    assert.doesNotMatch(JSON.stringify(corpo), /4712|MsMpEng/, "o histórico privado do alvo anterior não segue no pedido do PID novo");
    assert.equal(antesDoNovoPid.fetches.length, 1, "autorizar o PID novo não fez outro POST");
  });
});
