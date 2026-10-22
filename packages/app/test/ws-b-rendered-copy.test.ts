import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineHealth, Finding, PcState } from "@cybersafe/shared-types";
import ProtectionDetails from "../src/components/ProtectionDetails";
import { PcStateAttention } from "../src/pages/DashboardPage";

// Ver o task-manager-page.test.ts: o `tsx` compila o JSX dos fontes com o
// runtime classico e e este global que o satisfaz fora do Vite.
(globalThis as Record<string, unknown>).React = React;

/**
 * WS-B ADDENDUM — a copy so conta se estiver RENDERIZADA.
 * Render a serio (react-dom/server) com a telemetria REAL medida live via
 * pipe protection.getState: o HTML do componente e que tem de conter as
 * frases; comentarios e constantes mortas nao contam.
 */

const LIVE_ENGINE = {
  serviceRunning: true,
  anyEngineDegraded: true,
  degradedReasons: [
    "ClamAV: degraded — ClamAV instalado mas sem base de assinaturas — C:\\ClamAV\\db nao tem ficheiros .cvd/.cld; corre freshclam",
    "Filtro WFP do CyberSafe: unavailable — WFP filter not started",
  ],
  yara: { status: "active", detail: "Loaded 1 rule(s) from file" },
  hashDb: { status: "active", detail: "Loaded 4 signature(s) from C:\\ProgramData\\CyberSafe\\definitions\\default.json" },
  nativeEngine: { status: "active", detail: "packages\\native-engine\\build\\Release\\scan-engine.exe" },
  clamav: { status: "degraded", detail: "ClamAV instalado mas sem base de assinaturas — C:\\ClamAV\\db nao tem ficheiros .cvd/.cld; corre freshclam" },
  wfp: { status: "unavailable", detail: "WFP filter not started" },
  firewall: { status: "unavailable", detail: "WFP filter not started" },
} as unknown as EngineHealth;

const engineFinding: Finding = {
  id: "security:engine-unavailable",
  category: "security",
  severity: "attention",
  title: "Proteção parcialmente indisponível",
  summary: "2 componentes de proteção precisam de atenção.",
  source: "protection-engine",
  firstSeen: "2026-09-30T19:00:00.000Z",
  lastSeen: "2026-09-30T19:20:00.000Z",
  actionable: false,
  evidence: {
    engine: "ClamAV, Filtro WFP do CyberSafe",
    engineStatus: "degraded, unavailable",
  },
};

const pcState = {
  findings: [engineFinding],
  principalFinding: engineFinding,
  counts: { urgent: 0, attention: 1, recommended: 0, informative: 0 },
  overall: "attention",
  security: "attention",
} as unknown as PcState;

describe("WS-B addendum — ProtectionDetails renderizado", () => {
  const markup = renderToStaticMarkup(
    createElement(ProtectionDetails, { engine: LIVE_ENGINE, level: "degraded", open: true, onClose: () => {}, score: 80 }),
  );

  for (const frase of [
    "Motor de análise por regras ativo",
    "1 regra carregada",
    // Contrato YARA P1: a cobertura passou a ser um CAMPO medido pelo
    // serviço (`coverage`), não uma frase fixa. Com coverage ausente
    // (serviço antigo) a UI diz que não foi comunicada — nunca que é boa.
    "Cobertura não comunicada por este serviço",
    "Base local ativa",
    "4 assinaturas carregadas",
    "Motor instalado, mas a base",
    "As assinaturas precisam de ser instaladas ou atualizadas",
    "Motor nativo de análise disponível",
    "estão ativos",
    "O filtro de rede próprio do CyberSafe não está ativo",
    "Isto não significa que o Firewall do Windows esteja desligado",
    "Não verificado",
    "O CyberSafe ainda não consultou o estado do Firewall do Windows nesta vista",
  ]) {
    test(`renderiza "${frase}"`, () => {
      assert.ok(markup.includes(frase), `falta no HTML: "${frase}"\n${markup.slice(0, 400)}`);
    });
  }

  for (const proibido of [
    "(degraded)", "(unavailable)",
    "Loaded 1 rule(s) from file",
    "scan-engine.exe", "freshclam", "WFP filter not started",
    "C:\\", "\\.cvd",
    "estão a funcionar",
    "Arranca quando ligado",
  ]) {
    test(`nao renderiza "${proibido}"`, () => {
      assert.ok(!markup.includes(proibido), `nao pode estar no HTML: "${proibido}"`);
    });
  }
});

describe("WS-B addendum — DADO do Dashboard renderizado", () => {
  const markup = renderToStaticMarkup(createElement(PcStateAttention, { pcState, engine: LIVE_ENGINE }));

  test("DADO com nomes + estados PT-PT, sem tokens nem paths", () => {
    assert.ok(markup.includes("ClamAV: Degradado"), markup.slice(0, 600));
    assert.ok(markup.includes("Filtro WFP do CyberSafe: Indisponível"), markup.slice(0, 600));
    assert.ok(markup.includes("2 componentes de proteção precisam de atenção"), "SIGNIFICADO (summary do motor)");
    for (const proibido of ["(degraded)", "(unavailable)", "Loaded", "freshclam", "WFP filter", "scan-engine.exe", "C:\\"]) {
      assert.ok(!markup.includes(proibido), `nao pode estar no DADO: "${proibido}"`);
    }
  });

  test("ClamAV explica a base ausente logo no bloco", () => {
    assert.ok(markup.includes("Motor instalado, mas a base de assinaturas antivírus ainda não está disponível"), markup.slice(0, 600));
  });
});
