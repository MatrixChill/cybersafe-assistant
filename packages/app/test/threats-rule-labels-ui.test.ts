import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreatEvent } from "@cybersafe/shared-types";

// `tsx` compila JSX com runtime clássico — mesmo padrão dos testes de SSR existentes.
(globalThis as Record<string, unknown>).React = React;

const { default: ThreatsPage } = await import("../src/pages/ThreatsPage");

const threat = {
  source: "system-scanner",
  url: "file:///C:/Temp/amostra.exe",
  domain: "ficheiro local",
  severity: "high",
  confidence: 0.9,
  rulesTriggered: ["yara_match", "known_bad_hash", "archive_with_exe", "suspicious_location"],
  createdAt: "2026-11-05T10:00:00.000Z",
  riskScore: 95,
  filePath: "C:\\Temp\\amostra.exe",
  sha256: "a".repeat(64),
} as ThreatEvent;

describe("Ameaças — regras legíveis, identificador técnico preservado", () => {
  const html = renderToStaticMarkup(
    createElement(ThreatsPage, { events: [threat], onClear: () => {}, isClearing: false }),
  );

  test("as quatro regras aparecem em português", () => {
    assert.match(html, /Correspondência de regra YARA/);
    assert.match(html, /Hash conhecido como malicioso/);
    assert.match(html, /Ficheiro comprimido que contém um executável/);
    assert.match(html, /Localização suspeita/);
  });

  test("o identificador cru não é o texto principal", () => {
    assert.doesNotMatch(html, />\s*yara_match\s*</);
    assert.doesNotMatch(html, />\s*known_bad_hash\s*</);
  });

  test("o identificador continua disponível no detalhe técnico", () => {
    assert.match(html, /title="Correspondência de regra YARA \(yara_match\)"/);
    assert.match(html, /title="Hash conhecido como malicioso \(known_bad_hash\)"/);
  });
});
