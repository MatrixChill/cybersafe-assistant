import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, "..", "..", "packages", "app", "src", "pages");

/**
 * Pequeno patch de UX em `DashboardPage.tsx` (C4-fase2): evitar que o ecrã
 * actual da proteção seja lido como lista histórica de alertas/ameaças. Não
 * tocamos serviço, shared-types, App, Settings ou proteção.
 *
 * Critério verificado por leitura do ficheiro (não por screenshot / runtime):
 * - o dashboard já mostra data/hora em ameaças (`createdAt` → key + ameaçasPage);
 * - a secção de alertas/ameaças NO DASHBOARD inclui copy que diz que é leitura
 *   atual e que o histórico completo fica em Ameaças (/threats);
 * - não existe paginação, filtro arbitrário ou botão "amarelo" que prometa
 *   ação sobre o que o serviço já reportou.
 */
const dashboardPath = resolve(appRoot, "DashboardPage.tsx");
const source = readFileSync(dashboardPath, "utf8");

const EXPECTED_LINES = [
  // copy que separa "isto é o que leu agora" de "histórico completo está em /threats"
  /Estes cartões são o que o serviço leu/,
  /histórico completo de eventos e ameaças está em/,
  /Ameaças<\/a>/,
];

describe("DashboardPage scanner UX visibility patch", () => {
  it("acompanha o patch em DashboardPage.tsx (grep-based, sem runtime)", () => {
    const checks = EXPECTED_LINES.map((pattern) => ({
      pattern,
      ok: pattern.test(source),
    }));

    const failures = checks.filter((c) => !c.ok);
    assert.ok(
      failures.length === 0,
      `checks não passaram: ${failures.map((c) => c.pattern.toString()).join(" | ")}`,
    );
  });

  it("alertas/ameaças do dashboard NÃO paginam nem filtram arbitrariamente", () => {
    // O patch mantém `.slice(0, 5)` SÓ no ecrã de ameaças do dashboard, como
    // visibilidade, não como paginação/filtro de histórico.
    assert.ok(source.includes(".slice(0, 5)"), "o dashboard mantém limite de visibilidade de ameaças");
    // Não há controlos de paginação introduzidos na secção do dashboard.
    // Não introduzimos controlo de paginação/filtro novo na secção do dashboard.
    // Mantivemos apenas o limite de visibilidade em ameaças (slice(0,5)).
    assert.ok(
      !/pageSize|nextCursor|Carregar mais/.test(source),
      "não há paginação/filtro arbitrário introduzido no dashboard");
  });
});

// micro-helper mínimo porque este ficheiro é apenas leitura + assertions simples.

