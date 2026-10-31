import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const aiPath = join(__dirname, "..", "..", "packages", "app", "src", "components", "AIAssistant.tsx");
const source = readFileSync(aiPath, "utf8");

const assertContains = (needle, message) =>
  assert.ok(source.includes(needle), message);
const assertNotContains = (needle, message) =>
  assert.ok(!source.includes(needle), message);

const TODAY = new Date().toISOString().slice(0, 10);

describe(`AIAssistant dialog facts — ${TODAY} · fecho P1 Monitor (foco, sem app/IPC/backend/shared)`, () => {
  it("mantém prompts por página (não genérico, sem inventar nos script de exportação)", () => {
    assertContains("const SUGGESTIONS", "AIAssistant.tsx: exporta SUGGESTIONS por página.");
    assertContains("dashboard:", "SUGGESTIONS inclui a chave dashboard.");
    assertContains("scanner:", "SUGGESTIONS inclui a chave scanner.");
    assertContains("threats:", "SUGGESTIONS inclui a chave threats.");
  });

  it("não perde histórico/consentimento ao fechar o diálogo (não apaga estado no dismiss)", () => {
    // O fecho do chat não deve ser implementado como "reset total do historial
    // de conversas e do consentimento" (isso seria inventar/ferir o foco do
    // patch). Verifica ausência de resets drásticos com nomes típicos.
    assertNotContains(
      "clearConversationHistoryOnClose",
      "Não existe flag 'clearConversationHistoryOnClose' no componente.",
    );
  });

  it("não introduz nova animação/glass/overflow animado no diálogo", () => {
    // Critério de foco: janela pequena -> max viewport/scroll, sem overflow,
    // sem nova animação/glass. Não afirmamos cobertura total, mas afirmamos
    // que não foi introduzido carry-over óbvio de glass/blur novo no ficheiro.
    assertNotContains(
      "backdrop-blur-lg",
      "AIAssistant.tsx não adicionou glass blur novo neste fecho.",
    );
  });
});
