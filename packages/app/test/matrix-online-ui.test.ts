/**
 * TP-MATRIX-ONLINE-UI-20261024 — escolha visível Local/Online sobre o R4.
 *
 * O que este ficheiro fixa, sem DOM e sem fornecedor:
 *  1. a escolha Local/Online tem rótulos e descrições PT-PT distintos;
 *  2. «Local» é uma decisão de encaminhamento, não decoração: nada sai para o
 *     fornecedor e o estado diz «Resposta local», não «IA indisponível»;
 *  3. «Online» permite chat geral sem consentimento de telemetria — o pedido
 *     geral não leva grant, providerKey nem contexto de processo;
 *  4. o contexto medido só segue quando a pergunta aponta ao alvo em causa;
 *  5. a resposta do fornecedor é preservada tal como veio, sem prefixo local;
 *  6. os erros continuam em PT-PT e nunca se disfarçam de resposta da IA;
 *  7. trocar de modo aborta o pedido em voo mas NÃO cria/revoga consentimento.
 *
 * Os testes de ligação ao componente são de fonte porque esta árvore não tem
 * jsdom nem react-test-renderer; o comportamento puro é testado a sério.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  decisaoAposTentativaLocal,
  destinoDaMensagem,
  estadoDoMotivoLocal,
  motivoDoEncaminhamentoLocal,
  matrixRoutingStateLabel,
  type MatrixRotaInput,
} from "../src/lib/matrixConversation.ts";
import { matrixStateLabel } from "../src/lib/matrixRequestMachine.ts";
import * as conversa from "../src/lib/matrixConversation.ts";
import * as processo from "../src/lib/processMatrix.ts";
import {
  matrixTelemetryContext,
  processChatHistory,
  processPayload,
  type AlvoProcesso,
} from "../src/lib/processMatrix.ts";

const AI = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");

const modoApi = conversa as unknown as {
  matrixChatModeLabel?: (mode: "local" | "online") => string;
  matrixChatModeDescription?: (mode: "local" | "online") => string;
};

const processoApi = processo as unknown as {
  perguntaApontaParaAlvo?: (
    texto: string,
    alvo: AlvoProcesso | null,
    nome?: string | null,
  ) => boolean;
};

const ALVO: AlvoProcesso = { pid: 4712, startedAt: "2026-10-23T08:00:00.000Z" };

const rota = (sob: Partial<MatrixRotaInput> = {}): MatrixRotaInput => ({
  texto: "Como funciona o phishing?",
  perguntaProcesso: false,
  perguntaSegurancaLocal: false,
  identidadePerdida: false,
  perigo: false,
  foraDoTema: false,
  consentimentoProcesso: false,
  temContextoProcesso: true,
  modoLocal: false,
  ...sob,
});

describe("escolha visível Local vs Online", () => {
  test("os dois modos têm rótulos distintos e PT-PT", () => {
    assert.equal(modoApi.matrixChatModeLabel?.("local"), "Local");
    assert.equal(modoApi.matrixChatModeLabel?.("online"), "Online");
    const local = modoApi.matrixChatModeDescription?.("local") ?? "";
    const online = modoApi.matrixChatModeDescription?.("online") ?? "";
    assert.ok(local.length > 0 && online.length > 0);
    assert.notEqual(local, online, "a descrição não pode ser a mesma para os dois modos");
    assert.match(local, /sem enviar|no PC/i);
    assert.match(online, /fornecedor/i);
    assert.doesNotMatch(`${local} ${online}`, /offline mode|online mode/i);
  });

  test("o controlo no componente é visível, acessível e com os dois valores", () => {
    fonteTem(/data-matrix-chat-mode-switch/, "falta o grupo visível do modo");
    fonteTem(/role="group"[^>]*aria-label="Modo da conversa"/, "o grupo precisa de nome acessível");
    fonteTem(/data-matrix-chat-mode=\{m\}/);
    fonteTem(/\(\["local", "online"\] as const\)/, "os dois valores da escolha");
    fonteTem(/aria-pressed=\{modoConversa === /, "os botões têm de anunciar o modo escolhido");
    fonteTem(/onClick=\{\(\) => mudarModoConversa\(/, "o controlo tem de mudar o modo");
  });
});

describe("modo Local escolhido é encaminhamento, não decoração", () => {
  test("pergunta geral em modo local fica local, com motivo próprio", () => {
    const local = rota({ modoConversaLocal: true });
    assert.equal(motivoDoEncaminhamentoLocal(local), "modo-local-escolhido");
    assert.equal(destinoDaMensagem(local), "local");
  });

  test("o estado local escolhido diz «Resposta local», não «IA indisponível»", () => {
    assert.equal(estadoDoMotivoLocal("modo-local-escolhido"), "local");
    assert.equal(matrixStateLabel("local"), "Resposta local");
    assert.notEqual(matrixStateLabel(estadoDoMotivoLocal("modo-local-escolhido")), "IA indisponível");
    assert.notEqual(matrixStateLabel(estadoDoMotivoLocal("modo-local-escolhido")), "Resposta da IA");
  });

  test("o modo local vence o pedido de consentimento: não se pede telemetria que não vai sair", () => {
    const perguntaProcesso = rota({
      texto: "A memória deste processo está a aumentar?",
      perguntaProcesso: true,
      modoConversaLocal: true,
      consentimentoProcesso: false,
    });
    assert.equal(motivoDoEncaminhamentoLocal(perguntaProcesso), "modo-local-escolhido");
    assert.equal(estadoDoMotivoLocal("modo-local-escolhido"), "local");
  });

  test("pergunta de estado do PC tenta o snapshot local antes de cair no modo local", () => {
    const seguranca = rota({
      texto: "O meu PC está seguro?",
      perguntaSegurancaLocal: true,
      modoConversaLocal: true,
    });
    assert.equal(motivoDoEncaminhamentoLocal(seguranca), "seguranca-local", "o snapshot local continua a ser tentado");
    assert.deepEqual(
      decisaoAposTentativaLocal(seguranca, false),
      { destino: "local", motivo: "modo-local-escolhido" },
      "sem snapshot, o modo local responde localmente (nunca ao fornecedor)",
    );
  });

  test("identidade perdida continua a ter prioridade sobre o modo", () => {
    const perdida = rota({ identidadePerdida: true, modoConversaLocal: true });
    assert.equal(motivoDoEncaminhamentoLocal(perdida), "identidade-perdida");
  });

  test("sem escolha local, uma pergunta geral continua elegível para o fornecedor", () => {
    const online = rota({ modoConversaLocal: false });
    assert.equal(motivoDoEncaminhamentoLocal(online), null);
    assert.equal(destinoDaMensagem(online), "provider");
  });

  test("o componente passa o modo escolhido ao fluxo de envio", () => {
    fonteTem(/const \[modoConversa, setModoConversa\] = useState<MatrixChatMode>\("local"\)/);
    fonteTem(/modoConversaLocal: modoDoPedido === "local"/);
    fonteTem(/processMessage\(input, false, false, false, modoConversa\)/);
    fonteTem(/processMessage\(label, false, false, false, modoConversa\)/);
    fonteTem(/processMessageRef\.current\?\.\(texto, false, true, forcarLocal, modoConversa\)/);
  });

  test("sem resposta pronta, o modo escolhido não inventa uma avaria", () => {
    const escolhido = conversa.respostaSemConhecimentoLocal("local", "pergunta sobre phishing");
    assert.match(escolhido, /por escolha tua/);
    assert.doesNotMatch(escolhido, /não está disponível/, "escolher Local não é uma falha de ligação");
    assert.match(
      conversa.respostaSemConhecimentoLocal("online", "pergunta sobre phishing"),
      /não está disponível/,
      "a indisponibilidade real continua a ser dita",
    );
    fonteTem(/offlineReply\(trimmed, currentPage, modoDoPedido\)/, "a resposta local tem de saber o modo escolhido");
  });
});

describe("chat geral online sem consentimento de telemetria", () => {
  test("pergunta geral não leva contexto medido nem telemetria", () => {
    const contexto = { version: 1, selectedProcess: { pid: 4712 } } as never;
    assert.deepEqual(processPayload(contexto, false), {});
    assert.equal(matrixTelemetryContext("RAM 12 GB", false), "");
  });

  test("histórico privado não viaja numa pergunta geral sem consentimento", () => {
    const historico = [
      { role: "user" as const, content: "Como funciona o phishing?" },
      { role: "user" as const, content: "A memória deste processo?", privateProcessData: true },
      { role: "assistant" as const, content: "Medição local: 900 MB", privateProcessData: true },
    ];
    assert.deepEqual(processChatHistory(historico, false, null), [
      { role: "user", content: "Como funciona o phishing?" },
    ]);
  });

  test("a pergunta atual não é apagada do histórico só por dizer «processo»", () => {
    fonteTem(/const perguntaPrivada = processQuestion && anexarContexto/);
    fonteTem(/privateProcessData: perguntaPrivada/, "a marca privada segue o contexto, não a palavra");
  });

  test("o envio sem consentimento não transporta grant nem consentProviderKey", () => {
    // A região real de sendToServer: o único ramo que preenche `camposEnvio` é o
    // que exige `consentimento`. Um `else` com descriptor punha o grant num chat
    // geral e fazia um 403 de consentimento parecer uma falha do fornecedor.
    const inicio = AI.indexOf("let camposEnvio: MatrixConsentChatFields = {}");
    const fim = AI.indexOf("const payloadProcesso = processPayload(", inicio);
    assert.ok(inicio >= 0 && fim > inicio, "a cablagem de consentimento do envio mudou de forma");
    const regiao = AI.slice(inicio, fim);
    assert.match(regiao, /if \(consentimentoDoPedido && externo\.descriptor\)/);
    assert.doesNotMatch(regiao, /else if \(externo\?\.descriptor\)/, "sem consentimento não há campos externos");
    assert.doesNotMatch(regiao, /camposDeConsentimentoNoChat/, "o chat geral não pode ser coberto por um grant");
  });
});

describe("contexto de processo só quando a pergunta aponta ao alvo", () => {
  test("PID explícito aponta ao alvo", () => {
    assert.equal(processoApi.perguntaApontaParaAlvo?.("Porque é que o PID 4712 usa tanta RAM?", ALVO, "MsMpEng.exe"), true);
  });

  test("nome do processo em causa aponta ao alvo, sem distinguir maiúsculas", () => {
    assert.equal(processoApi.perguntaApontaParaAlvo?.("O msmpeng está a consumir muito?", ALVO, "MsMpEng.exe"), true);
    assert.equal(processoAponta("C:\\\\Windows\\\\System32\\\\MsMpEng.exe está lento", ALVO, "MsMpEng.exe"), true);
  });

  test("«este processo» e «esta instância» apontam ao alvo", () => {
    assert.equal(processoApi.perguntaApontaParaAlvo?.("A memória deste processo está a aumentar?", ALVO, null), true);
    assert.equal(processoApi.perguntaApontaParaAlvo?.("Esta instância é segura de fechar?", ALVO, null), true);
  });

  test("uma pergunta geral sobre processos NÃO herda o alvo selecionado", () => {
    assert.equal(
      processoApi.perguntaApontaParaAlvo?.("O Chrome tem vários processos?", ALVO, "WmiPrvSE.exe"),
      false,
      "o contexto do WmiPrvSE não pode seguir numa pergunta sobre o Chrome",
    );
    assert.equal(processoApi.perguntaApontaParaAlvo?.("O que é um processo?", ALVO, "chrome.exe"), false);
  });

  test("sem alvo medido não há contexto acidental", () => {
    assert.equal(processoApi.perguntaApontaParaAlvo?.("A memória deste processo?", null, "chrome.exe"), false);
    assert.equal(processoApi.perguntaApontaParaAlvo?.("A memória deste processo?", { pid: null, startedAt: null }, null), false);
  });

  test("o caminho de envio usa a decisão e só envia processContext quando ela é verdadeira", () => {
    fonteTem(/const perguntaDaExplicacao = explainRequest !== null\s*&& trimmed === promptDeExplicacaoDeProcesso\(explainRequest\.pid\)/);
    fonteTem(/const anexarContexto = perguntaDaExplicacao\s*\|\| perguntaApontaParaAlvo\(/);
    fonteTem(/processPayload\(\s*anexarContexto \? processContext : null,/);
    fonteTem(/anexarContexto,/, "sendToServer tem de receber a decisão deste pedido");
  });
});

describe("resposta do fornecedor preservada, sem prefixo nem repetição", () => {
  test("o texto entra na conversa tal como o fornecedor o devolveu", () => {
    fonteTem(/const content = result\.content/);
    fonteTem(/content,\s*\n\s*privateProcessData: anexarContexto && \(processQuestion \|\| consentimentoProcesso\),/);
    fonteNaoTem(/Resposta da IA:\s*\$\{content\}/, "não se prefixa a resposta do fornecedor");
    fonteNaoTem(/content\.replace\(/, "não se reescreve o texto do fornecedor");
  });

  test("a origem só é «ai» com conteúdo concluído, e as etiquetas são PT-PT", () => {
    assert.equal(matrixRoutingStateLabel("generativa"), "Resposta da IA");
    assert.equal(matrixRoutingStateLabel("local"), "Resposta local");
    assert.equal(matrixRoutingStateLabel("indisponivel"), "IA indisponível");
    assert.equal(matrixRoutingStateLabel("erro-recuperavel"), "Erro temporário, podes tentar");
    assert.equal(matrixRoutingStateLabel("pedido-recusado"), "Pedido recusado — nada foi enviado ao fornecedor");
  });

  test("os erros de rede/fornecedor continuam ditos em PT-PT e como locais", () => {
    fonteTem(/Não foi possível contactar o fornecedor de IA neste momento\. Tenta novamente\./);
    fonteTem(/O serviço de IA está temporariamente indisponível\. Podes tentar novamente\./);
    fonteTem(/origin: originDaResposta\(\{ pediuProvider: true, ok: false, code: "network" \}\)/);
  });
});

describe("trocar de modo não cria nem revoga autoridade", () => {
  const bloco = (() => {
    const i = AI.indexOf("const mudarModoConversa = ");
    assert.ok(i >= 0, "falta a única porta de mudança de modo");
    const j = AI.indexOf("\n  }", i);
    return AI.slice(i, j);
  })();

  test("aborta o pedido em voo e descarta uma resposta tardia", () => {
    assert.match(bloco, /questionGenerationRef\.current \+= 1/);
    assert.match(bloco, /abortRef\.current\?\.abort\(\)/);
    assert.match(bloco, /pedidoActivoRef\.current = null/);
    assert.match(bloco, /setPhase\("idle"\)/);
  });

  test("não faz POST/DELETE de consentimento nem levanta um bloqueio de revogação", () => {
    assert.doesNotMatch(bloco, /criarConsentimento|lerConsentimento|revogarConsentimento/);
    assert.doesNotMatch(bloco, /aplicarConsentimentoExterno|setConsentimentoBloqueado/);
    assert.doesNotMatch(bloco, /consentimentoBloqueadoRef\.current =/);
  });

  test("ao escolher Local, a oferta de IA e o cartão pendente deixam de estar à vista", () => {
    assert.match(bloco, /if \(novo === "local"\)/);
    assert.match(bloco, /setOfertaIa\(null\)/);
    assert.match(bloco, /setExplicacaoPendente\(null\)/);
  });

  test("uma conversa nova não muda a escolha do utilizador", () => {
    const i = AI.indexOf("const resetConversation = useCallback");
    const j = AI.indexOf("\n  }, [substituirMensagens])", i);
    assert.ok(i >= 0 && j > i);
    assert.doesNotMatch(AI.slice(i, j), /setModoConversa/);
  });
});

function processoAponta(texto: string, alvo: AlvoProcesso, nome: string): boolean {
  return processoApi.perguntaApontaParaAlvo?.(texto, alvo, nome) ?? false;
}

function fonteTem(padrao: RegExp, mensagem = String(padrao)): void {
  assert.ok(padrao.test(AI), `AIAssistant não contém ${mensagem}`);
}

function fonteNaoTem(padrao: RegExp, mensagem = String(padrao)): void {
  assert.ok(!padrao.test(AI), `AIAssistant contém ${mensagem}`);
}
