import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardSummary, HardwareSnapshot } from "@cybersafe/shared-types";

/**
 * TP-UI-ACCEPTANCE (17/10) — aceitação do eixo de superfície no produto REAL.
 *
 * 1. `GlassSurface` real: mapping material→atributo que o CSS do eixo lê, e o
 *    caso OMITIDO (o teste antigo dizia "por defeito" mas passava `solid`
 *    explícito — aqui a prop não é passada de todo).
 * 2. Hero do Dashboard: a preferência GUARDADA (`cybersafe_surface`) tem de
 *    chegar ao `data-material` do hero; um literal é um defeito.
 *
 * SSR real (sem DOM/Electron), como os testes existentes da app. Cliques e
 * foco não se provam por SSR — ficam para reteste humano (ver relatório).
 */

(globalThis as Record<string, unknown>).React = React;

// Storage falsificável: o eixo de superfície de V1 e o registo JSON de V2, para
// que o AppearanceProvider real os leia no arranque (como numa instalação com
// essa preferência gravada).
let surfaceSaved: string | null = null;
let v2Saved: string | null = null;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) =>
    key === "cybersafe_surface" ? surfaceSaved : key === "cybersafe_appearance_v2" ? v2Saved : null,
  setItem: () => {},
  removeItem: () => {},
};

const { GlassSurface } = await import("../src/components/visual/GlassSurface");
const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { default: DashboardPage } = await import("../src/pages/DashboardPage");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs
  .readFileSync(path.join(HERE, "..", "src", "index.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const attrOf = (html: string, name: string): string | null => {
  const m = html.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
};

/** Renderiza o GlassSurface real; sem prop `material` no caso omitido. */
const surface = (material?: "solid" | "reduced" | "glass") =>
  renderToStaticMarkup(
    createElement(
      GlassSurface,
      material === undefined ? { children: "marcador" } : { material, children: "marcador" },
    ),
  );

describe("GlassSurface — mapping real solid/reduced/glass + omissão", () => {
  it("material omitido cai no default do componente (e esse default tem bloco CSS real)", () => {
    const html = surface();
    assert.equal(attrOf(html, "data-material"), "solid", "omitido deve resolver para o default do componente");
    assert.ok(html.includes("surface-solid"), "classe do default ausente");
  });

  it("solid, reduced e glass emitem o atributo que o CSS do eixo lê", () => {
    for (const material of ["solid", "reduced", "glass"] as const) {
      const html = surface(material);
      assert.equal(attrOf(html, "data-material"), material, `data-material de "${material}"`);
      assert.match(
        css,
        new RegExp(`\\[data-material="${material}"\\]`),
        `index.css não lê data-material="${material}" — classe espelhada sem CSS`,
      );
    }
  });

  it("glass não volta a ser mapeado para sólido (regressão do defeito antigo)", () => {
    const glass = surface("glass");
    assert.notEqual(attrOf(glass, "data-material"), "solid", "glass a resolver para sólido outra vez");
    assert.notEqual(glass, surface("solid"), "markup de glass igual ao de solid");
  });

  it("glass partilha o bloco do líquido no CSS (alias real, não uma classe inventada)", () => {
    assert.match(css, /\[data-material="glass"\],\s*\[data-material="liquid"\]/);
    assert.ok(css.includes(".surface-liquid"), "classe surface-liquid emitida mas ausente do index.css");
  });
});

// ── Dashboard: preferência guardada → hero ────────────────────────────────

const volume = {
  mount: "C:", fileSystem: "NTFS", totalGb: 953, usedGb: 846, freeGb: 107,
  usagePercent: 88.8, kind: "working", readOnly: false,
};

const hardware = {
  cpu: { usage: 12, model: "", cores: 8, speed: 0, temperature: null },
  ram: { usagePercent: 44, usedGb: 7, totalGb: 16 },
  disk: {
    readStatus: "ok", reason: null, lastGoodAt: new Date().toISOString(),
    volumes: [volume], primary: volume, usagePercent: 88, usedGb: 846, totalGb: 953, fsType: "NTFS",
  },
  network: { rxSec: 0, txSec: 0 },
  gpu: null,
  alerts: [],
  timestamp: new Date().toISOString(),
} as unknown as HardwareSnapshot;

const renderDashboard = () =>
  renderToStaticMarkup(
    createElement(
      AppearanceProvider,
      null,
      createElement(DashboardPage, {
        dashboard: {
          totalEvents: 0, highSeverityEvents: 0, downloadRisk: "low", recentThreats: [], alerts: [],
          systemStatus: "safe", riskScore: 78,
        } as unknown as DashboardSummary,
        isLoading: false,
        hardware,
        realtime: { disponivel: true, enabled: true },
      }),
    ),
  );

describe("Painel V2 — o eixo de matéria é um só e não duplica o de V1", () => {
  /**
   * MIGRADO POR DECISÃO EXPLÍCITA (V2-FIRST): o `section.hero-banner` com
   * `data-material` é geometria de V1 e saiu. O que a causa original protegia
   * continua protegido, e de forma mais forte: a preferência guardada tem de
   * chegar à superfície por UM eixo (o de V2, no `<html>`), e a composição do
   * lab não pode voltar a escrever o atributo de V1 na árvore — foi exatamente
   * assim que `[data-material="solid"|"liquid"]` globais de `index.css` passaram
   * a pintar o contentor do Painel. Mapa: `out/MAPA-TESTES-V2-FIRST.md`.
   */
  const MATERIAS_V2 = ["solid", "light", "frosted", "liquid", "advanced"] as const;
  const bridge = fs
    .readFileSync(path.join(HERE, "..", "src", "v2", "bridge.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const folhaPainel = fs
    .readFileSync(path.join(HERE, "..", "src", "v2", "lab-sidebar.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("cada matéria guardada chega ao eixo de V2, sem atributo de V1 na árvore do Painel", () => {
    for (const material of MATERIAS_V2) {
      v2Saved = JSON.stringify({ version: 1, theme: "core", material, movement: "balanced", performance: "auto", webgl: false });
      const html = renderDashboard();
      assert.equal(/data-material=/.test(html), false, `data-material de V1 voltou ao Painel com "${material}"`);
      assert.equal(/data-surface=/.test(html), false, `data-surface de V1 voltou ao Painel com "${material}"`);
      assert.match(html, /class="v2-dashboard"/, "a composição do lab mantém-se montada");
    }
    v2Saved = null;
  });

  it("as cinco matérias têm regra no eixo de V2 e a casca de V1 não pinta por baixo do Painel", () => {
    for (const material of MATERIAS_V2) {
      assert.match(
        bridge,
        new RegExp(`html\\[data-v2-material="${material}"\\]`),
        `${material}: sem regra no eixo de V2 a preferência não faz nada`,
      );
    }
    assert.match(folhaPainel, /main\[data-presentation="lab-v2"\]\{background:none;?\}/, "o fundo de V1 do <main> tem de ser neutro na página do lab");
  });
});
