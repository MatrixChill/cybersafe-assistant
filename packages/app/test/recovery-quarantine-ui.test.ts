import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QuarantinePage from "../src/pages/QuarantinePage";
import type { QuarantineEntry } from "@cybersafe/shared-types";

/**
 * RECOVERY-SECURITY-20261014 (P0, qoder): a quarentena passou a publicar
 * `isolationStatus` — `confirmed` so quando destino/digest/manifest foram
 * verificados; `recovery-required` para pre-move/falha; `undefined` e legado
 * nunca verificado por esta versao. A UI nao pode chamar "em quarentena" ao
 * que nao esta confirmado, nem contar tudo como isolado no resumo.
 *
 * SSR puro (renderToStaticMarkup): sem DOM, sem window, sem cliques. As
 * acoes (Restaurar/Eliminar) permanecem as mesmas — restauro nao bloqueado,
 * eliminar com confirmacao — por isso tambem verificamos o texto-fonte da
 * confirmacao em vez de simular fluxo.
 */

(globalThis as Record<string, unknown>).React = React;

const entry = (overrides: Partial<QuarantineEntry> = {}): QuarantineEntry => ({
  id: "e1",
  originalPath: "C:\\temp\\ameaca.dll",
  quarantinePath: "C:\\quarantine\\e1",
  fileName: "ameaca.dll",
  sha256: "a".repeat(64),
  verdict: "malicious",
  riskScore: 90,
  quarantinedAt: "2026-10-14T10:00:00.000Z",
  ...overrides,
});

const render = (entries: QuarantineEntry[]) =>
  renderToStaticMarkup(
    createElement(QuarantinePage, { entries, onChanged: () => {}, embedded: true }),
  );

describe("quarantine UI — isolationStatus por entrada", () => {
  test("confirmed: a linha normal 'em quarentena desde' mantem-se", () => {
    const html = render([entry({ isolationStatus: "confirmed" })]);
    assert.match(html, /em quarentena desde/);
    assert.doesNotMatch(html, /Isolamento não confirmado/);
    assert.doesNotMatch(html, /Registo anterior/);
  });

  test("recovery-required: NAO escreve 'em quarentena desde'; copy exata de recuperacao", () => {
    const html = render([entry({ isolationStatus: "recovery-required" })]);
    assert.doesNotMatch(html, /em quarentena desde/);
    assert.match(html, /Isolamento não confirmado; recuperação necessária/);
  });

  test("legado (undefined): copy explicita de nao verificado, sem data falsa de isolamento", () => {
    const html = render([entry({})]);
    assert.doesNotMatch(html, /em quarentena desde/);
    assert.match(html, /Registo anterior; isolamento não verificado nesta versão/);
  });

  test("entrada confirmada restaurada mantem a linha de confirmacao", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync(
      new URL("../src/pages/QuarantinePage.tsx", import.meta.url),
      "utf8",
    );
    const html = render([entry({ isolationStatus: "confirmed", restoredAt: "2026-10-14T11:00:00.000Z" })]);
    assert.match(html, /em quarentena desde/);
    assert.match(fonte, /Restaurado/, "o detalhe de restauro continua no painel expandido");
  });
});

describe("quarantine UI — resumo honesto", () => {
  test("mistura de estados: o resumo distingue confirmados, recuperacao e legado", () => {
    const html = render([
      entry({ id: "a", isolationStatus: "confirmed" }),
      entry({ id: "b", isolationStatus: "recovery-required" }),
      entry({ id: "c" }),
    ]);
    assert.match(html, /1 confirmado/);
    assert.match(html, /1 a recuperar/);
    assert.match(html, /1 por verificar/);
  });

  test("com tudo confirmado, ainda assim os numeros sao por estado, nao um 'todos isolados'", () => {
    const html = render([
      entry({ id: "a", isolationStatus: "confirmed" }),
      entry({ id: "b", isolationStatus: "confirmed" }),
    ]);
    assert.match(html, /2 confirmados/);
    assert.doesNotMatch(html, /itens/, "contagem crua sem distinguir estado");
  });

  test("header nao-embedded nao alega que todos estao isolados", () => {
    const html = renderToStaticMarkup(
      createElement(QuarantinePage, { entries: [entry({})], onChanged: () => {} }),
    );
    assert.doesNotMatch(html, /Ficheiros isolados pela proteção\./);
    assert.match(html, /Registo anterior; isolamento não verificado nesta versão/);
  });
});

describe("quarantine UI — acoes intactas", () => {
  test("recovery-required nao bloqueia o restauro existente", () => {
    const html = render([entry({ isolationStatus: "recovery-required" })]);
    assert.match(html, /Restaurar/);
    assert.doesNotMatch(html, /disabled(?:="")?(?=[\s/>])/, "estado inicial nao pode ter botoes desativados");
  });

  test("eliminar continua com confirmacao explicita (texto-fonte)", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync(
      new URL("../src/pages/QuarantinePage.tsx", import.meta.url),
      "utf8",
    );
    assert.match(fonte, /Eliminar permanentemente\? Esta ação é irreversível\./);
    assert.match(fonte, /setPending\(\{ id: entry\.id, action: "delete" \}\)/);
  });

  test("vazio: estado intacto sem contagens inventadas", () => {
    const html = render([]);
    assert.match(html, /A quarentena está vazia\./);
    assert.doesNotMatch(html, /0 confirmados|0 a recuperar|0 por verificar/);
  });
});
