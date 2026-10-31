import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardSummary } from "@cybersafe/shared-types";

/**
 * O utilizador viu «36» no círculo e «80/100» ao lado, na mesma captura.
 * A causa era um contador local que subia até ao valor do serviço: durante a
 * animação, os dois números eram a MESMA métrica com valores diferentes.
 * O contrato é: uma única fonte (`dashboard.riskScore`), sem valor intermédio
 * impresso, e ausência de leitura dita por letras — nunca `0`.
 *
 * MIGRADO V2-FIRST: o círculo de V1 saiu por decisão explícita do proprietário.
 * A dona da nota passou a ser `src/v2/dashboard/LabDiagnostics.tsx`; as três
 * obrigações (fonte única, nenhum contador animado, null ≠ 0) passam a ser
 * assertadas lá, e a segunda metade é verificada em MARKUP RENDERIZADO, não só
 * no texto-fonte. Mapa: `out/MAPA-TESTES-V2-FIRST.md`.
 */
// O formato do ficheiro pode mudar a qualquer prettier; o que se trava aqui é a
// FORMA da expressão, não a indentação. Daí o espaço normalizado.
const compactar = (texto: string) => texto.replace(/\s+/g, " ").trim();
const SRC = compactar(readFileSync(new URL("../src/v2/dashboard/LabDiagnostics.tsx", import.meta.url), "utf8"));
const PAINEL = compactar(readFileSync(new URL("../src/v2/dashboard/LabDashboard.tsx", import.meta.url), "utf8"));

const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { default: LabDashboard } = await import("../src/v2/dashboard/LabDashboard");
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const desenha = (riskScore: number | null) =>
  renderToStaticMarkup(
    createElement(
      AppearanceProvider,
      null,
      createElement(LabDashboard as never, {
        dashboard: {
          riskScore,
          totalEvents: 0,
          highSeverityEvents: 0,
          downloadRisk: "low",
          recentThreats: [],
          alerts: [],
          systemStatus: "attention",
        } as unknown as DashboardSummary,
        isLoading: false,
        serviceConnected: true,
        history: { phase: "pronto", entry: null },
      } as never),
    ),
  );

test("não há um segundo número animado a competir com a nota do serviço", () => {
  assert.doesNotMatch(SRC, /displayScore/, "o contador local voltou");
  assert.doesNotMatch(SRC, /setInterval\(|requestAnimationFrame/, "não há animação numérica no Painel");
  assert.doesNotMatch(PAINEL, /displayScore|setInterval\(/, "nem na composição");
});

test("nota e explicação derivam ambas de dashboard.riskScore", () => {
  assert.match(SRC, /const score = typeof p\.dashboard\.riskScore === "number" && Number\.isFinite\(p\.dashboard\.riskScore\) \? p\.dashboard\.riskScore : null;/, "a fonte é a leitura finita do serviço; ausência não é uma pontuação");
  assert.match(SRC, /score !== null && p\.dashboard\.engineHealth \? explainProtectionScore\(score, p\.dashboard\.engineHealth\)/, "a explicação do teto vem dos motores reais, do mesmo instantâneo");
  assert.match(SRC, /score === null \? "Sem leitura" : `\$\{score\}\/100`/, "o número e o denominador são a mesma variável");
  // Uma só ocorrência do par `N/100` na página: não há segunda legenda.
  assert.equal((desenha(78).match(/78\/100/g) ?? []).length, 1, "a nota aparece uma única vez");
});

test("sem leitura não se imprime 0 nem um valor inventado", () => {
  const html = desenha(null);
  assert.match(html, /<h3>Pontuação de proteção<\/h3><p>Sem leitura\./, "a ausência de leitura tem de ser dita");
  assert.doesNotMatch(html, /0\/100/, "zero não é ausência");
  assert.doesNotMatch(html, /100\/100/, "teto não é leitura");
});
