import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineHealth } from "@cybersafe/shared-types";

/**
 * FECHO14 — P0 do firewall na PRIMEIRA renderização REAL do componente.
 *
 * `renderToStaticMarkup` não corre efeitos: é exatamente por isso que serve
 * de prova — o que está aqui é a primeira pintura do componente verdadeiro,
 * com e sem bridge, antes de qualquer `useEffect`. O contrato do fecho:
 *  · com bridge, aberto → «A verificar…» (o pedido vai partir do efeito);
 *  · leitura confirmada → ATIVO/DESATIVADO com ressalva quando é renovação;
 *  · falha da CONSULTA → «Não foi possível verificar»;
 *  · «Não verificado» só onde não houve início (ou onde não há ponte).
 *
 * Sem jsdom, sem dependências novas: `globalThis.window` é montado e
 * desmontado à volta de cada render, como o `7h-usb-ssr` já faz.
 */

(globalThis as Record<string, unknown>).React = React;

const ProtectionDetailsMod = await import("../src/components/ProtectionDetails");
const ProtectionDetails = ProtectionDetailsMod.default;

const engine = {
  yara: { status: "active", detail: "Loaded 1 rule(s) from file" },
  hashDb: { status: "active", detail: "Loaded 4 signature(s)" },
  clamav: { status: "degraded", detail: "freshclam" },
  nativeEngine: { status: "active", detail: "scan-engine.exe" },
  firewall: { status: "unavailable", detail: "WFP filter not started" },
} as unknown as EngineHealth;

function renderCom(bridge: unknown): string {
  const g = globalThis as Record<string, unknown>;
  const antes = g.window;
  g.window = bridge === null ? undefined : { electronAPI: bridge };
  try {
    return renderToStaticMarkup(
      createElement(ProtectionDetails, {
        engine,
        level: "degraded",
        open: true,
        onClose: () => {},
        score: 80,
      }),
    );
  } finally {
    if (antes === undefined) delete g.window;
    else g.window = antes;
  }
}

describe("FECHO14 — primeira pintura do chip Windows Firewall", () => {
  test("com bridge, antes do efeito: «A verificar…», nunca «Não verificado»", () => {
    const markup = renderCom({ getWindowsHealth: () => new Promise(() => {}) });
    assert.ok(markup.includes("A verificar…"), `falta «A verificar…»:\n${markup.slice(markup.indexOf("Windows Firewall"), 200)}`);
    const fatia = markup.slice(markup.indexOf("Windows Firewall"));
    assert.equal(fatia.includes("Não verificado"), false, "a primeira pintura com bridge afirmou «Não verificado»");
  });

  test("sem ponte (janela sem electronAPI): pré-efeito é não-iniciado «Não verificado»", () => {
    const markup = renderCom(undefined);
    const fatia = markup.slice(markup.indexOf("Windows Firewall"));
    assert.ok(fatia.includes("Não verificado"), "a janela sem ponte deixou de o dizer");
    assert.match(fatia, /ainda não consultou/, "o não-iniciado pré-efeito tem a frase do packet (ws-b)");
    assert.equal(fatia.includes("A verificar"), false, "sem ponte não há pedido para anunciar");
  });

  test("sem janela (SSR/Node puro): não-iniciado é «Não verificado»", () => {
    const markup = renderCom(null);
    const fatia = markup.slice(markup.indexOf("Windows Firewall"));
    assert.ok(fatia.includes("Não verificado"));
    assert.equal(fatia.includes("A verificar"), false);
  });

  test("fechado não pinta nada do firewall (nem «a verificar» fantasma)", () => {
    const g = globalThis as Record<string, unknown>;
    const antes = g.window;
    g.window = { electronAPI: { getWindowsHealth: () => new Promise(() => {}) } };
    try {
      const markup = renderToStaticMarkup(
        createElement(ProtectionDetails, { engine, level: "degraded", open: false, onClose: () => {}, score: 80 }),
      );
      assert.equal(markup, "", "dialog fechado pintou algo");
    } finally {
      if (antes === undefined) delete g.window;
      else g.window = antes;
    }
  });
});
