import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MATRIX_GREETING,
  initialMatrixMessages,
  garantirSaudacao,
  acrescentarMensagem,
  isConversationStart,
  isNearBottom,
} from "../src/lib/matrixConversation";

const SRC = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");

test("conversa nova arranca com a saudação, não com um vazio", () => {
  const inicio = initialMatrixMessages();
  assert.equal(inicio.length, 1);
  assert.equal(inicio[0].role, "assistant");
  assert.equal(inicio[0].content, MATRIX_GREETING);
});

test("a fase de arranque termina na primeira mensagem do utilizador", () => {
  assert.equal(isConversationStart([]), true);
  assert.equal(isConversationStart(initialMatrixMessages()), true);
  assert.equal(
    isConversationStart([{ role: "assistant" }, { role: "user" }]),
    false,
    "as sugestões têm de desaparecer assim que a pessoa escreve",
  );
  assert.equal(isConversationStart([{ role: "assistant" }, { role: "assistant" }]), true);
});

test("o autoscroll só cola ao fundo quando o utilizador lá está", () => {
  const fundo = { scrollTop: 400, scrollHeight: 900, clientHeight: 500 };
  assert.equal(isNearBottom(fundo), true);
  assert.equal(isNearBottom({ ...fundo, scrollTop: 356 }), true, "44 px de folga ainda cola");
  assert.equal(isNearBottom({ ...fundo, scrollTop: 100 }), false, "a ler em cima: não puxar");
  assert.equal(isNearBottom({ scrollTop: Number.NaN, scrollHeight: 900, clientHeight: 500 }), false);
});

// ── Estrutura real do componente ─────────────────────────────────────────────

test("as sugestões vivem dentro da área de mensagens, antes da caixa de escrita", () => {
  const area = SRC.indexOf("data-matrix-messages");
  const sugestoes = SRC.indexOf("data-matrix-starters");
  const escrita = SRC.indexOf("{/* Input Area */}");
  assert.ok(area >= 0, "a área de mensagens não está marcada");
  assert.ok(sugestoes >= 0, "as sugestões iniciais não estão marcadas");
  assert.ok(escrita >= 0, "a caixa de escrita não está marcada");
  assert.ok(area < sugestoes && sugestoes < escrita, "as sugestões ficaram fora do scroll ou depois do input");

  assert.doesNotMatch(
    SRC,
    /shrink-0 px-4 pb-2 flex gap-2 flex-wrap/,
    "a faixa de sugestões separada (que fazia o layout saltar) não pode voltar",
  );
  assert.doesNotMatch(SRC, /messages\.length <= 2/, "a condição antiga mantinha sugestões durante o envio");
});

test("a área de mensagens é a única com scroll; cabeçalho e input ficam fixos", () => {
  assert.match(SRC, /flex-1 min-h-0 overflow-y-auto[^\"]*overscroll-contain/, "scroll interno da conversa");
  assert.match(SRC, /onScroll=\{trackScroll\}/, "a posição do scroll não é observada");
  assert.match(SRC, /if \(!stickToBottomRef\.current\) return/, "o streaming puxa a vista mesmo com o utilizador em cima");
  assert.match(SRC, /scrollRef\.current\.scrollTop = scrollRef\.current\.scrollHeight/, "autoscroll removido");
  assert.doesNotMatch(SRC, /bg-dot-pattern/, "o fundo pontilhado separava as mensagens do resto do painel");
});

test("«Nova conversa» está no cabeçalho e reinicia só a conversa", () => {
  assert.match(SRC, /aria-label=\"Nova conversa\"/, "botão em falta no cabeçalho");
  assert.match(SRC, /onClick=\{resetConversation\}/, "o botão não chama o reset");

  const i = SRC.indexOf("const resetConversation = useCallback");
  assert.ok(i >= 0, "resetConversation não existe");
  const corpo = SRC.slice(i, SRC.indexOf("}, [substituirMensagens])", i));

  assert.match(corpo, /questionGenerationRef\.current \+= 1/, "respostas atrasadas não são descartadas");
  assert.match(corpo, /cancelLocalSecurityRequest\(abortRef\.current\)/, "o pedido em curso não é cancelado");
  assert.match(corpo, /setStreamed\(\"\"\)/, "o texto do streaming fica pendurado");
  assert.match(corpo, /setInput\(\"\"\)/, "o rascunho da conversa anterior fica no campo");
  assert.match(corpo, /substituirMensagens\(initialMatrixMessages\(\)\)/, "a conversa não volta à saudação");
  assert.doesNotMatch(corpo, /persistLauncherMode|setLauncherModeState|localStorage/, "o reset não pode mexer no modo/posição");
});

// ── Saudação única e preservação das mensagens reais (GUI02) ────────────────

test("a saudação existe no máximo uma vez e não apaga um «Oi» já enviado", () => {
  let conversa: Array<{ role: "user" | "assistant"; content: string }> = [];
  conversa = acrescentarMensagem(conversa, { role: "user", content: "Oi" });
  assert.equal(
    conversa.filter((m) => m.role === "assistant" && m.content === MATRIX_GREETING).length,
    1,
    "o primeiro envio ganha a saudação, não uma segunda cópia",
  );
  assert.deepEqual(conversa.map((m) => m.role), ["assistant", "user"], "a ordem preserva a saudação antes do «Oi»");

  conversa = acrescentarMensagem(conversa, { role: "assistant", content: "Olá! Em que posso ajudar?" });
  assert.equal(conversa.filter((m) => m.content === MATRIX_GREETING).length, 1, "a resposta não duplica a saudação");
  assert.deepEqual(conversa.map((m) => m.content), [MATRIX_GREETING, "Oi", "Olá! Em que posso ajudar?"]);

  // Um segundo arranque/remoção não substitui a conversa por uma saudação.
  const depois = garantirSaudacao(conversa);
  assert.equal(depois.length, 3, "garantirSaudacao não pode apagar mensagens reais");
  assert.equal(depois.filter((m) => m.content === MATRIX_GREETING).length, 1);
});

test("um callback atrasado não repõe a saudação por cima da conversa", () => {
  // Reproduz o caminho antigo: a sonda /status resolvia depois de a pessoa já
  // ter escrito «Oi» e chamava setMessages(initialMatrixMessages()). A conversa
  // desaparecia. A regra nova é idempotente e conserva o histórico.
  const comMensagens = [
    { role: "assistant" as const, content: MATRIX_GREETING },
    { role: "user" as const, content: "Oi" },
    { role: "assistant" as const, content: "Olá! Em que posso ajudar?" },
  ];
  const depoisDoCallback = garantirSaudacao(comMensagens);
  assert.deepEqual(depoisDoCallback, comMensagens);
  assert.equal(depoisDoCallback.length, 3, "nenhuma mensagem real pode ser eliminada como atalho");
  assert.doesNotMatch(SRC, /fetcher\(API_BASE, "\/api\/ai\/status"\)\.status\(\)\.then[\s\S]{0,900}setMessages\(initialMatrixMessages\(\)\)/);
});

// ── Estrutura visual dos balões (GUI02) ────────────────────────────────────

test("utilizador à direita, assistente à esquerda, com quebra de palavras", () => {
  assert.match(SRC, /msg\.role === "user" \? "justify-end" : "justify-start"/);
  assert.match(SRC, /max-w-\[85%\]/);
  assert.match(SRC, /break-words \[overflow-wrap:anywhere\] whitespace-pre-wrap/);
  assert.match(SRC, /data-matrix-message-role=\{msg\.role\}/);
  assert.doesNotMatch(SRC, /min-h-2/, "blocos vazios não podem impor altura mínima");
  const lista = SRC.slice(SRC.indexOf("{messages.map((msg, i) => ("), SRC.indexOf("{showThinking && ("));
  assert.match(lista, /key=\{`\$\{msg\.role\}-\$\{i\}`\}/, "a key tem de mudar com o papel da mensagem");
});

test("«Explicar» responde localmente antes de qualquer envio e a IA é opt-in", () => {
  const i = SRC.indexOf("if (!explainRequest) return");
  assert.ok(i >= 0);
  const fim = SRC.indexOf("}, [explainRequest", i);
  assert.ok(fim > i, "o efeito de «Explicar» deixou de ter o fim reconhecível");
  const bloco = SRC.slice(i, fim);
  const guarda = bloco.indexOf("deveAutoEnviarExplicacao");
  const local = bloco.indexOf("anexarMensagem({");
  assert.ok(guarda >= 0 && local > guarda, "a resposta local nasce depois da guarda de duplicação");
  assert.doesNotMatch(bloco, /setInput\(/, "o clique já não escreve no campo de texto");
  assert.doesNotMatch(bloco, /enviarPeloFluxoNormal\(/, "o clique NUNCA envia ao fornecedor");
  assert.match(bloco, /setOfertaIa\(/, "a opção de IA nasce depois da resposta local, como segundo passo");
  assert.match(SRC, /data-matrix-ask-ai/, "o botão separado de IA tem de existir na interface");
  assert.match(SRC, /setExplicacaoPendente\(ofertaIa\)/, "só carregar no botão de IA abre o pedido de autorização");
  // A porta única do envio continua a existir para a IA opt-in e para a recusa.
  assert.match(
    SRC,
    /processMessageRef\.current\?\.\(texto, false, true, forcarLocal, modoConversa\)/,
    "o phase antigo não pode recusar o envio pedido pela pessoa",
  );
  assert.match(SRC, /const enviarPeloFluxoNormal = \(texto: string, forcarLocal = false\) =>/);
});
