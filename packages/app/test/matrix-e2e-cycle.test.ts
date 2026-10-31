/**
 * TP-MATRIX-FB2-E2E-20261023 — o ciclo que o gate humano reprovou.
 *
 * O que estava errado, em pontos que este ficheiro fixa:
 *   · a barra dizia «Sem processo em causa» com uma autorização pendente da
 *     máquina (o pedido da máquina não tem PID, e o pendente era ignorado);
 *   · o cartão prometia «(esta máquina)», mas a store recebia `null` e recusava
 *     em silêncio — a caixa e o botão ficavam sem efeito;
 *   · a autorização já activa mostrava um botão «retomar» desactivado, sem prova
 *     nenhuma de que uma resposta generativa estava a caminho;
 *   · desmarcar a caixa sem pedido pendente não revogava nada (não havia
 *     revogação alcançável), e o cartão enorme ficava aberto depois da decisão;
 *   · um 401/403/404/503 do nosso serviço chegava sem código e era contado como
 *     falha de rede, com três tentativas e o rótulo errado;
 *   · «Nova conversa» voltava a executar o «Explicar» antigo (pergunta duplicada
 *     dentro da conversa limpa), e um duplo clique enviava a mesma pergunta duas
 *     vezes.
 *
 * Limite declarado: o ciclo de GUI React (clique real) continua a ser gate
 * humano Electron. Aqui provam-se as decisões puras, o markup que as liga e o
 * comportamento dos efeitos que os harnesses já recortam do produto.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  estadoDoMotivoLocal,
  estadoDoResultado,
  deveAutoEnviarExplicacao,
  motivoDoEncaminhamentoLocal,
  devePedirAutorizacaoAntes,
} from "../src/lib/matrixConversation.ts";
import {
  ALVO_MAQUINA,
  alvoParaConsentimento,
  autorizacaoValida,
  autorizarAlvo,
  consentValeParaAlvo,
  deveReenviarExplicacaoAposAutorizacao,
  revogarAlvo,
  rotuloDeConsentimento,
  rotuloDoProcessoEmCausa,
  type AlvoProcesso,
} from "../src/lib/processMatrix.ts";
import { codigoDeStatusHttp } from "../src/lib/matrixRequestMachine.ts";

const SRC = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");

const A: AlvoProcesso = { pid: 4712, startedAt: "2026-10-23T08:00:00.000Z" };
const B: AlvoProcesso = { pid: 9000, startedAt: "2026-10-23T08:10:00.000Z" };
const AGORA = 1_000_000;

test("A/R: sem processo em causa a barra diz «Conversa geral», não nega o que está à vista", () => {
  assert.equal(rotuloDoProcessoEmCausa({ pendente: null, pedido: null, alvo: null }), "Conversa geral");
});

test("R: um pedido da máquina (sem PID) identifica-se como máquina", () => {
  assert.equal(
    rotuloDoProcessoEmCausa({ pendente: null, pedido: { pid: undefined, startedAt: null }, alvo: null }),
    "Esta máquina · medições do PC",
  );
  assert.equal(
    rotuloDoProcessoEmCausa({ pendente: { pid: null, startedAt: null }, pedido: null, alvo: null }),
    "Esta máquina · medições do PC",
    "o pendente manda: era aqui que a barra dizia «sem processo» com autorização à espera",
  );
});

test("M: um PID pedido mantém-se visível mesmo sem amostra, sem inventar início", () => {
  const rotulo = rotuloDoProcessoEmCausa({
    pendente: { pid: 4712, startedAt: "2026-10-23T08:00:00.000Z" },
    pedido: { pid: 4712, startedAt: "2026-10-23T08:00:00.000Z" },
    alvo: null,
    nome: null,
  });
  assert.match(rotulo, /Instância fora das medições/);
  assert.match(rotulo, /PID 4712/);
  assert.match(rotulo, /início 2026-10-23T08:00:00.000Z/);

  const semInicio = rotuloDoProcessoEmCausa({
    pendente: null,
    pedido: { pid: 4712, startedAt: null },
    alvo: null,
    nome: "MsMpEng.exe",
  });
  assert.equal(semInicio, "MsMpEng.exe · PID 4712 · início não confirmado");

  assert.equal(
    rotuloDoProcessoEmCausa({ pendente: null, pedido: null, alvo: A, nome: "chrome.exe" }),
    "chrome.exe · PID 4712 · início 2026-10-23T08:00:00.000Z",
    "uma pergunta manual sobre o processo selecionado também o identifica",
  );
});

test("S: «esta máquina» é um alvo real e autorizável, não um null silencioso", () => {
  assert.deepEqual(alvoParaConsentimento(null), ALVO_MAQUINA);
  assert.deepEqual(alvoParaConsentimento(A), A, "um processo não é substituído pela máquina");
  const lista = autorizarAlvo([], alvoParaConsentimento(null), AGORA);
  assert.equal(autorizacaoValida(lista, ALVO_MAQUINA, AGORA), true);
  assert.equal(autorizacaoValida(lista, A, AGORA), false, "autorizar a máquina não autoriza um PID");
  assert.equal(rotuloDeConsentimento(true, ALVO_MAQUINA, ALVO_MAQUINA), "autorizado para este alvo");
  assert.equal(consentValeParaAlvo(ALVO_MAQUINA, A), false);
});

test("B/C: pergunta de processo sem autorização pede; com a autorização do alvo certo retoma UMA vez", () => {
  assert.equal(
    devePedirAutorizacaoAntes({
      perguntaProcesso: true,
      temContextoProcesso: true,
      consentimentoEfectivo: false,
      identidadePerdida: false,
    }),
    true,
  );
  const rota = {
    texto: "A memória deste processo está a aumentar?",
    perguntaProcesso: true,
    perguntaSegurancaLocal: false,
    identidadePerdida: false,
    perigo: false,
    foraDoTema: false,
    consentimentoProcesso: false,
    temContextoProcesso: true,
    modoLocal: false,
  };
  assert.equal(motivoDoEncaminhamentoLocal(rota), "sem-consentimento");
  assert.equal(estadoDoMotivoLocal("sem-consentimento"), "necessita-autorizacao");

  const pendente = { id: 7, pid: 4712, startedAt: A.startedAt, texto: "x", alvo: A };
  const lista = autorizarAlvo([], A, AGORA);
  assert.equal(
    deveReenviarExplicacaoAposAutorizacao(pendente, {
      consentimentoEfectivo: autorizacaoValida(lista, A, AGORA),
      alvoAutorizado: A,
      identidadePerdida: false,
      jaConsumido: null,
    }),
    true,
  );
  assert.equal(
    deveReenviarExplicacaoAposAutorizacao(pendente, {
      consentimentoEfectivo: true,
      alvoAutorizado: A,
      identidadePerdida: false,
      jaConsumido: 7,
    }),
    false,
    "o mesmo pedido não é retomado duas vezes",
  );
  assert.equal(
    deveReenviarExplicacaoAposAutorizacao(pendente, {
      consentimentoEfectivo: true,
      alvoAutorizado: B,
      identidadePerdida: false,
      jaConsumido: null,
    }),
    false,
    "autorizar B não retoma o pedido de A",
  );
});

test("D/E: trocar de alvo não aproveita a autorização do anterior, e revogar é imediato", () => {
  let lista = autorizarAlvo([], A, AGORA);
  assert.equal(autorizacaoValida(lista, B, AGORA), false);
  lista = autorizarAlvo(lista, B, AGORA);
  assert.equal(autorizacaoValida(lista, A, AGORA), true, "voltar a A respeita o que ainda vale");
  lista = revogarAlvo(lista, A);
  assert.equal(autorizacaoValida(lista, A, AGORA), false);
  assert.equal(autorizacaoValida(lista, B, AGORA), true);
});

test("G: erro e timeout têm classes distintas; o status HTTP é traduzido, não adivinhado", () => {
  assert.equal(estadoDoResultado({ motivo: null, pediuProvider: true, ok: false, code: "timeout" }), "erro-recuperavel");
  assert.equal(estadoDoResultado({ motivo: null, pediuProvider: true, ok: false, code: "network" }), "erro-recuperavel");
  assert.equal(estadoDoResultado({ motivo: null, pediuProvider: true, ok: false, code: "auth" }), "indisponivel");
  assert.equal(estadoDoResultado({ motivo: null, pediuProvider: true, ok: false, code: "no_provider" }), "indisponivel");
  assert.equal(codigoDeStatusHttp(401), "auth");
  assert.equal(codigoDeStatusHttp(403), "auth");
  assert.equal(codigoDeStatusHttp(404), "model_unavailable");
  assert.equal(codigoDeStatusHttp(408), "timeout");
  assert.equal(codigoDeStatusHttp(429), "rate_limited");
  assert.equal(codigoDeStatusHttp(503), "no_provider");
  assert.equal(codigoDeStatusHttp(500), "provider_unavailable", "500 não é inventado como rede — é o fornecedor em baixo, e o adaptador nomeia-o");
});

test("I: «Nova conversa» não reexecuta o «Explicar» antigo", () => {
  assert.match(
    SRC,
    /ultimoExplicacaoAutoRef\.current = explainRequestRef\.current\?\.id \?\? null/,
    "o reset tem de consumir o pedido actual",
  );
  assert.equal(deveAutoEnviarExplicacao(5, { id: 5 }), false);
  assert.equal(deveAutoEnviarExplicacao(5, { id: 6 }), true, "um clique novo continua a funcionar");
});

test("P: duplo clique em «Explicar» não duplica a pergunta em voo", () => {
  assert.match(
    SRC,
    /isRetry && ultimaPergunta\?\.content === trimmed/,
    "repetir não volta a escrever a mesma pergunta na conversa",
  );
  assert.match(
    SRC,
    /const assinatura = `\$\{alvoDePedido\(alvo\) \?\? "sem-alvo"\}::\$\{texto\}`/,
    "a dedup é por alvo+instância+pergunta",
  );
  assert.match(SRC, /if \(intencaoExplicarRef\.current === assinatura\) return/);
  assert.match(
    SRC,
    /const assinatura =[\s\S]{0,200}intencaoExplicarRef\.current = assinatura[\s\S]{0,4000}questionGenerationRef\.current \+= 1/,
    "a guarda tem de vir ANTES de cancelar/gerar",
  );
});

test("N/Q: o cartão é compacto, só abre com pendente/decisão, e há uma só porta de detalhes", () => {
  const cartao = SRC.slice(
    SRC.indexOf("{(explicacaoPendente || autorizacaoAberta) && ("),
    SRC.indexOf("{showThinking && ("),
  );
  assert.equal((cartao.match(/data-matrix-consent-card/g) ?? []).length, 1);
  assert.equal((cartao.match(/<details/g) ?? []).length, 1, "um só bloco de detalhes");
  assert.match(cartao, /<summary[^>]*>Ver detalhes<\/summary>/);
  assert.doesNotMatch(cartao, /<details[^>]*\bopen\b/, "os detalhes começam recolhidos");
  assert.match(cartao, /max-w-\[95%\]/, "o cartão não pode ocupar a largura toda");
  assert.match(
    SRC,
    /const autorizarAlvoEmCausa = async \(modo: MatrixConsentMode\) => \{[\s\S]*?setAutorizacaoAberta\(false\)/,
    "autorizar recolhe o cartão (não fica aberto com um botão inerte)",
  );
  assert.doesNotMatch(cartao, /disabled=\{consentimentoProcessoEfectivo\}/, "o botão não fica inerte depois de autorizar");
  assert.match(SRC, /data-matrix-consent-revoke/, "revogação acessível");
  assert.match(SRC, /revogarConsentimento\(API_BASE, authHeaders\(\)\)/, "revogar chama o DELETE do contrato");
  assert.match(SRC, /setAutorizacoes\(\[\]\)/, "revogar fecha toda a autoridade local, não só uma cópia visual");
});

test("H/T/U: a origem é por resposta; a configuração não ocupa o eixo do pedido", () => {
  const barra = SRC.slice(SRC.indexOf("data-matrix-status-bar"), SRC.indexOf("data-matrix-privacy-bar"));
  assert.match(barra, /matrixRoutingStateLabel\(estadoVisivel\) \?\? "Sem pedido em curso"/);
  assert.doesNotMatch(barra, /matrixConfigLabel/, "configuração no eixo do pedido confundia «verificado» com «respondeu»");
  assert.equal((SRC.match(/matrixConfigLabelHonesto\(mode\)/g) ?? []).length, 1, "a configuração vive só no cabeçalho");
});

test("O/R: a caixa de escrita fica fixa fora do scroll, e o erro oferece nova tentativa", () => {
  const lista = SRC.indexOf('data-matrix-messages=""');
  const input = SRC.indexOf("Pergunta sobre segurança digital", lista);
  assert.ok(lista > 0 && input > lista, "o input tem de estar depois da lista");
  assert.match(SRC, /data-matrix-messages[\s\S]{0,400}overflow-y-auto/, "só a lista tem scroll");
  assert.match(SRC, /shrink-0 p-4 bg-primary\/5 border-t border-primary\/20/, "rodapé fixo");
  assert.match(SRC, /phase === "error" \|\| phase === "rate_limited"/, "o erro tem de oferecer «Tentar novamente»");
  assert.match(SRC, /const lastUser = \[\.\.\.messages\]\.reverse\(\)\.find\(\(m\) => m\.role === "user"\)/, "retry volta à última pergunta");
});
