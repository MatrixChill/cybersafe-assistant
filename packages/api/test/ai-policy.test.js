import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildContextBlock, buildMessages } from "../dist/ai.js";

describe("Matrix — política de respostas (não depende do LLM)", () => {
  const system = buildMessages([{ role: "user", content: "oi" }], "", "").find((m) => m.role === "system")?.content ?? "";

  test("obedece a pedidos explícitos de brevidade/respostas literais", () => {
    assert.match(system, /resumido|\bcurto\b|mais nada/i);
    assert.match(system, /responde À LETRA|à letra/i);
  });

  test("não se apresenta repetidamente", () => {
    assert.match(system, /não te apresentes repetidamente/i);
  });

  test("não despeja o estado do sistema sem pedido", () => {
    assert.match(system, /nunca despejes o estado do sistema/i);
  });

  test("nada de conselhos genéricos não pedidos (sem marketing)", () => {
    assert.match(system, /zero marketing/i);
    assert.match(system, /a não ser que isso responda à pergunta concreta/i);
  });

  test("distingue observação de hipótese", () => {
    assert.match(system, /distingue observação de hipótese/i);
  });

  test("grounding obrigatório: não inventar", () => {
    assert.match(system, /nunca inventar/i);
    assert.match(system, /se a proteção estiver degradada, não digas "está 100% seguro"/i);
    const withCtx = buildMessages([{ role: "user", content: "oi" }], "CPU 50%")[0].content;
    assert.match(withCtx, /não inventes o que não está lá/i);
  });

  test("continua defensiva em pedidos perigosos", () => {
    assert.match(system, /segurança — continua a ser defensiva/i);
    assert.match(system, /não forneças instruções perigosas/i);
  });

  test("contexto é injetado de forma silenciosa (nunca recitado)", () => {
    const { system: sys } = buildMessages(
      [{ role: "user", content: "como está meu pc?" }],
      "Disk usage: 93%",
      "PC Center",
    ).reduce((m, c) => (c.role === "system" ? { system: c.content } : m), { system: "" });
    assert.match(sys, /\[CONTEXTO CYBERSAFE\]/);
    assert.match(sys, /Disk usage: 93%/);
    assert.match(sys, /não os recites na resposta/i);
  });

  test("contexto vazio não injeta bloco", () => {
    const sys = buildMessages([{ role: "user", content: "oi" }])[0].content;
    assert.doesNotMatch(sys, /^\[CONTEXTO CYBERSAFE\]$/m);
  });

  test("buildContextBlock concatena página e contexto apenas quando existem", () => {
    assert.equal(buildContextBlock("", ""), "");
    assert.equal(buildContextBlock("", "Dashboard"), "Página atual do CyberSafe: Dashboard");
    assert.match(buildContextBlock("RAM 80%", "PC Center"), /Página atual do CyberSafe: PC Center\nRAM 80%/);
  });

  test("histórico é limitado e apenas papéis user/assistant", () => {
    const longHistory = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg ${i}`,
    }));
    const msgs = buildMessages(longHistory);
    const nonSystem = msgs.filter((m) => m.role !== "system");
    assert.ok(nonSystem.length <= 16, "histórico limitado a 16");
    for (const m of nonSystem) {
      assert.ok(m.role === "user" || m.role === "assistant", `papel inválido: ${m.role}`);
    }
    assert.equal(nonSystem.at(-1)?.content, "msg 29", "mantém a última mensagem");
  });
});

describe("Matrix — política de brevidade (anti-palestra)", () => {
  const system = buildMessages([{ role: "user", content: "oi" }], "", "").find((m) => m.role === "system")?.content ?? "";

  test("define limite rígido de 1-3 frases por defeito", () => {
    assert.match(system, /MÁXIMO 1 a 3 frases/i);
  });

  test("proíbe listas longas por iniciativa", () => {
    assert.match(system, /NUNCA listes "8 motivos"|"5 dicas"|listas longas/i);
  });

  test("expande apenas com pedido explícito", () => {
    assert.match(system, /expande APENAS quando o utilizador pedir explicitamente/i);
    assert.match(system, /"detalha"|"explica mais"|"passo a passo"|"relatório completo"/i);
  });

  test("proíbe headings/listas em perguntas simples", () => {
    assert.match(system, /NUNCA respondas com tabelas, headings markdown ou listas numeradas em perguntas simples/i);
  });

  test("responde ao caso concreto, não teoria geral", () => {
    assert.match(system, /responde sobre ESSA coisa concreta/i);
    assert.match(system, /nunca listes teoria geral nem dês uma aula/i);
  });
});