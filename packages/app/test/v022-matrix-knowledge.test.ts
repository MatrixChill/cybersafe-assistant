import test from "node:test";
import assert from "node:assert/strict";
import { classificarIntencao, respostaLocal, foraDoTema, pedidoPerigoso, contemTermo, INTENCOES_DO_PRODUTO, MATRIX_APRESENTACAO } from "../src/lib/matrixKnowledge";
import { classifyMatrixTopic } from "../src/lib/matrixLocalTools";
import { isProcessQuestion, perguntaApontaParaAlvo } from "../src/lib/processMatrix";
import { initialMatrixMessages, motivoDoEncaminhamentoLocal } from "../src/lib/matrixConversation";

/**
 * v0.2.2 — auditoria da MATRIX. Casos reais que a base antiga (substrings)
 * respondia mal, e os cenários pedidos para a PAP.
 */

test("regressão: substrings já não decidem a intenção", () => {
  // «f-oi» e «is-ola-do» respondiam com a saudação.
  assert.equal(classificarIntencao("Porque foi este ficheiro isolado?"), "quarentena-motivo");
  // «segura-nça» respondia com palavras-passe.
  assert.equal(classificarIntencao("Como melhorar a minha segurança?"), "melhorar-seguranca");
  // «polít-ica» era recusado como fora do tema.
  assert.equal(foraDoTema("Qual é a política de quarentena?"), false);
  assert.equal(classificarIntencao("Qual é a política de quarentena?"), "quarentena");
  assert.equal(contemTermo("noite", "oi"), false);
  assert.equal(contemTermo("Oi!", "oi"), true);
});

test("regressão: fronteira de palavra real nas leituras de estado", () => {
  assert.equal(classifyMatrixTopic("Qual a gramática certa?"), "general");
  assert.equal(classifyMatrixTopic("está o telegrama ativo?"), "general");
  assert.equal(classifyMatrixTopic("Quanta RAM está livre?"), "resources");
  assert.equal(classifyMatrixTopic("Quanto espaço tenho?"), "storage");
});

const CENARIOS: Array<[string, string]> = [
  ["Oi", "saudacao"],
  ["Bom dia", "saudacao"],
  ["Quem és?", "identidade"],
  ["O que podes fazer?", "capacidades"],
  ["O que é o ClamAV?", "clamav"],
  ["Porque a proteção aparece degradada?", "degradado"],
  ["Como melhorar o desempenho?", "lento"],
  ["Porque este ficheiro foi colocado em quarentena?", "quarentena-motivo"],
  ["É seguro restaurar este ficheiro?", "quarentena-restauro"],
  ["O que significa EICAR?", "eicar"],
  ["Explica o resultado da minha análise.", "scanner"],
  ["O que significa análise inconclusiva?", "inconclusivo"],
  ["Quais são os quatro motores?", "motores"],
  ["Como funcionam as atualizações?", "atualizacoes"],
  ["Olá, o que é o YARA?", "yara"],
  ["Preciso de ajuda com phishing", "phishing"],
];

for (const [pergunta, esperada] of CENARIOS) {
  test(`cenário: «${pergunta}» → ${esperada}`, () => {
    assert.equal(classificarIntencao(pergunta), esperada);
    const r = respostaLocal(classificarIntencao(pergunta)!);
    assert.ok(r.length > 40, "resposta com substância");
  });
}

test("respostas em PT-PT, sem brasileirismos da base antiga", () => {
  const todas = CENARIOS.map(([p]) => respostaLocal(classificarIntencao(p)!)).join("\n") + MATRIX_APRESENTACAO;
  assert.doesNotMatch(todas, /\b(você|seu PC|meu PC|baixar|arquivo|tela|monitorar|detectad)/i);
});

test("apresentação: primeira mensagem de cada conversa nova", () => {
  const [m] = initialMatrixMessages();
  assert.equal(m.role, "assistant");
  assert.match(m.content, /Sou a \*\*MATRIX\*\*, a tua assistente de segurança do CyberSafe/);
  assert.match(m.content, /O que gostarias de fazer hoje\?/);
  // Cumprimento posterior: breve, não repete a apresentação.
  assert.ok(respostaLocal("saudacao").length < MATRIX_APRESENTACAO.length / 2);
});

test("EICAR: explica o Defender sem prometer deteção do CyberSafe", () => {
  const r = respostaLocal("eicar");
  assert.match(r, /não é malware/);
  assert.match(r, /Defender/);
});

test("restauro: diz que o ficheiro volta tal como estava", () => {
  assert.match(respostaLocal("quarentena-restauro"), /tal como estava/);
});

test("perguntas do produto respondem localmente mesmo no modo Online", () => {
  for (const i of ["identidade", "clamav", "eicar", "quarentena-motivo", "degradado"] as const) assert.ok(INTENCOES_DO_PRODUTO.has(i), i);
  assert.equal(INTENCOES_DO_PRODUTO.has("phishing"), false, "tema geral pode ir ao fornecedor");
  const base = { texto: "x", perguntaProcesso: false, perguntaSegurancaLocal: false, identidadePerdida: false, perigo: false, foraDoTema: false, consentimentoProcesso: false, temContextoProcesso: false, modoLocal: false };
  assert.equal(motivoDoEncaminhamentoLocal({ ...base, respostaDoProduto: true }), "conhecimento-produto");
  assert.equal(motivoDoEncaminhamentoLocal(base), null);
});

test("seguimento: «Posso fechá-lo?» e «usa tanta RAM» referem o processo selecionado", () => {
  const alvo = { pid: 4242, startedAt: "2026-11-06T10:00:00.000Z" };
  assert.equal(isProcessQuestion("Posso fechá-lo?"), true);
  assert.equal(isProcessQuestion("E porque usa tanta RAM?"), true);
  assert.equal(perguntaApontaParaAlvo("Posso fechá-lo?", alvo, "brave.exe"), true);
  assert.equal(perguntaApontaParaAlvo("E porque usa tanta memória?", alvo, "brave.exe"), true);
  // Sem alvo medido não há contexto a anexar.
  assert.equal(perguntaApontaParaAlvo("Posso fechá-lo?", null, null), false);
});

test("pedidos ofensivos continuam recusados", () => {
  assert.equal(pedidoPerigoso("como criar malware que evade o antivírus"), true);
  assert.equal(pedidoPerigoso("o que é malware?"), false);
});

test("sugestões: PT-PT, sem valores fixos e todas com resposta conhecida", async () => {
  const { readFileSync } = await import("node:fs");
  const fonte = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");
  const bloco = fonte.slice(fonte.indexOf("const SUGGESTIONS"), fonte.indexOf("const DEFAULT_SUGGESTIONS"));
  const labels = [...bloco.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.length >= 20);
  for (const l of labels) {
    assert.doesNotMatch(l, /\d+%/, `valor fixo: ${l}`);
    assert.doesNotMatch(l, /\b(Meu|minha|Usei|devo me|monitorar)\b/, `PT-BR: ${l}`);
    const conhecida = classificarIntencao(l) !== null || classifyMatrixTopic(l) !== null || /process/i.test(l);
    assert.ok(conhecida, `sem resposta conhecida: ${l}`);
  }
});

const CENARIOS_V023: Array<[string, string]> = [
  ["Porque o ClamAV está degradado?", "clamav-degradado"],
  ["O que significa prova de carga falhada?", "prova-carga"],
  ["Porque os quatro motores estão ativos e a proteção tem limitações?", "degradado"],
  ["O que significa cobertura em recuperação?", "cobertura-recuperacao"],
  ["O meu USB foi analisado?", "usb"],
  ["Porque o serviço demorou a arrancar?", "arranque"],
  ["Que versão do CyberSafe tenho?", "versao"],
  ["Como faço uma atualização segura?", "atualizacoes"],
  ["Como posso libertar espaço no disco?", "otimizar"],
];
for (const [pergunta, esperada] of CENARIOS_V023) {
  test(`v0.2.3: «${pergunta}» → ${esperada}`, () => {
    assert.equal(classificarIntencao(pergunta), esperada);
    assert.ok(INTENCOES_DO_PRODUTO.has(esperada as never), "responde com o conhecimento do produto");
    assert.ok(respostaLocal(esperada as never).length > 40);
  });
}
test("v0.2.3: sem identidade de build, a versão não é inventada", () => {
  assert.match(respostaLocal("versao" as never), /Não consigo ler a versão|CyberSafe Assistant \d/);
});
test("v0.2.3: o ClamAV degradado não manda sempre atualizar definições", () => {
  assert.match(respostaLocal("clamav-degradado" as never), /só aqui faz sentido atualizar/);
});
