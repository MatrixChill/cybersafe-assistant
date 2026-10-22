import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardSummary, EngineHealth } from "@cybersafe/shared-types";

/**
 * TP-V2-INTEGRATION-QA (18/10) — integração REAL (SSR) entre páginas do
 * produto e os contratos que já existem. Este ficheiro cobre apenas lacunas
 * que as suites atuais não fixam:
 *
 *  1. Definições renderizada de facto (nenhum teste existente renderiza a
 *     página): a secção Atualizações sobrevive ao redesign e, sem ponte,
 *     declara-o sem inventar estado; o eixo de superfície marca a preferência
 *     guardada nos botões (aria-pressed) e no preview; os eixos (material,
 *     identidade, destaque) não se contaminam.
 *  2. Dashboard: um estado de proteção desconhecido ou degradado NUNCA é
 *     apresentado como sucesso (a suíte r3c fixa o caminho "enabled: true";
 *     o caminho "enabled não lido" está explicitamente fora dela), e a
 *     preferência de material é ortogonal ao estado de proteção.
 *
 * O que NÃO se repete aqui (já fixado noutras suites):
 *  - protection-health: regras de deriveProtectionLevel/explainProtectionScore;
 *  - ui-evolution-acceptance: GlassSurface e hero para as 3 preferências em
 *    estado "safe";
 *  - theme-surface-axis: módulo de aparência e CSS;
 *  - update-ui-acceptance: painel de atualizações por injeção de estado.
 *
 * SSR não prova cliques, foco nem a aplicação no <html> (efeitos): fica
 * reteste humano. Sem mocks que só comprovem a si próprios — tudo o que se
 * lê abaixo vem dos componentes/constantes reais do produto.
 */

(globalThis as Record<string, unknown>).React = React;

// Storage falsificável com as chaves REAIS do eixo de aparência.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
};

const {
  IDENTITY_LABELS,
  SURFACE_LABELS,
  APPARANCE_IDENTITY_KEY,
  APPARANCE_ACCENT_KEY,
  APPARANCE_SURFACE_KEY,
  APPARANCE_THEME_KEY,
} = await import("../src/lib/appearance");
const { PROTECTION_LEVEL_META } = await import("../src/lib/protectionHealth");
const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { default: DashboardPage } = await import("../src/pages/DashboardPage");
const { default: SettingsPage } = await import("../src/pages/SettingsPage");

/* ── helpers de markup ─────────────────────────────────────────────────── */

const attrOf = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
};

const heroTag = (html: string): string | null => {
  const m = html.match(/<section[^>]*hero-banner[^>]*>/);
  return m ? m[0] : null;
};

const plain = (html: string): string =>
  html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** Botões com aria-pressed, com o texto visível (sem tags) por botão. */
const pressedButtons = (html: string): { pressed: boolean; text: string }[] => {
  const out: { pressed: boolean; text: string }[] = [];
  const re = /<button\b[^>]*aria-pressed="(true|false)"[^>]*>([\s\S]*?)<\/button>/g;
  for (const match of html.matchAll(re)) {
    out.push({
      pressed: match[1] === "true",
      text: plain(match[2]),
    });
  }
  return out;
};

/* ── fixtures reais (formas dos tipos partilhados) ─────────────────────── */

const engine = (overrides: Record<string, unknown> = {}): EngineHealth =>
  ({
    serviceRunning: true,
    anyEngineDegraded: false,
    clamav: { status: "active" },
    yara: { status: "active" },
    hashDb: { status: "active" },
    nativeEngine: { status: "active" },
    ...overrides,
  }) as unknown as EngineHealth;

const dashboard = (overrides: Record<string, unknown> = {}): DashboardSummary =>
  ({
    totalEvents: 0,
    highSeverityEvents: 0,
    downloadRisk: "low",
    recentThreats: [],
    alerts: [],
    systemStatus: "safe",
    riskScore: 55,
    engineHealth: engine(),
    ...overrides,
  }) as unknown as DashboardSummary;

const renderDashboard = (props: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(
    createElement(
      AppearanceProvider,
      null,
      createElement(DashboardPage, {
        dashboard: dashboard(),
        isLoading: false,
        realtime: { disponivel: true, enabled: true },
        ...props,
      } as never),
    ),
  );

const renderSettings = (): string =>
  renderToStaticMarkup(
    createElement(AppearanceProvider, null, createElement(SettingsPage as never, {} as never)),
  );

/* ── Definições: Atualizações preservadas e honestas ───────────────────── */

describe("Definições — a secção Atualizações sobrevive ao redesign", () => {
  it("sem ponte de atualizações, o painel existe e declara a indisponibilidade (não inventa estado)", () => {
    const html = renderSettings();

    assert.ok(
      html.includes('data-testid="app-update-panel"'),
      "a secção Atualizações desapareceu de Definições (o redesign removeu o componente real)",
    );
    assert.ok(
      html.includes('data-status="no-bridge"'),
      "o painel não se identificou como sem ponte em ambiente sem Electron/preload",
    );
    assert.ok(
      html.includes('data-testid="app-update-no-bridge"'),
      "a mensagem honesta de ponte indisponível não está renderizada",
    );
    assert.equal(
      html.includes('data-testid="app-update-status-text"'),
      false,
      "sem ponte não pode aparecer um estado de atualização como se tivesse sido lido",
    );
  });

  it("a secção de atualizações é a MESMA página das preferências (uma página, não uma rota nova)", () => {
    const html = renderSettings();
    assert.ok(html.includes('data-testid="app-update-panel"'), "painel ausente");
    assert.ok(html.includes('data-surface-preview=""'), "preview de materiais ausente na mesma página");
    assert.ok(
      pressedButtons(html).some((b) => b.text.includes(SURFACE_LABELS.glass)),
      "controlos de material ausentes na mesma página do painel",
    );
  });
});

/* ── Definições: preferência de material e independência dos eixos ─────── */

describe("Definições — o eixo de superfície marca a preferência guardada", () => {
  const surfaces = ["solid", "reduced", "glass"] as const;

  it("cada preferência guardada marca exatamente um botão e o preview usa o rótulo real", () => {
    for (const saved of surfaces) {
      store.set(APPARANCE_SURFACE_KEY, saved);
      const html = renderSettings();

      const surfaceStates = Object.fromEntries(
        surfaces.map((s) => {
          const hits = pressedButtons(html).filter((b) => b.text.includes(SURFACE_LABELS[s]));
          assert.equal(hits.length, 1, `esperava exatamente um botão de material para "${s}"`);
          return [s, hits[0].pressed];
        }),
      ) as Record<(typeof surfaces)[number], boolean>;

      assert.equal(surfaceStates[saved], true, `"${saved}" guardado mas o botão não está marcado`);
      for (const other of surfaces.filter((s) => s !== saved)) {
        assert.equal(surfaceStates[other], false, `"${other}" aparece marcado com "${saved}" guardado`);
      }

      assert.ok(
        plain(html).includes(`Material em uso: ${SURFACE_LABELS[saved]}`),
        `o preview não diz o material em uso real ("${SURFACE_LABELS[saved]}")`,
      );
    }
  });

  it("trocar o material não mexe na identidade nem no destaque (eixos independentes)", () => {
    store.set(APPARANCE_IDENTITY_KEY, "cybersafe-neon");
    store.set(APPARANCE_ACCENT_KEY, "purple");
    store.set(APPARANCE_THEME_KEY, "light");

    const identityLine = `Identidade: ${IDENTITY_LABELS["cybersafe-neon"]}`;
    const readings: { material: string; identity: boolean; accent: boolean }[] = [];

    for (const saved of surfaces) {
      store.set(APPARANCE_SURFACE_KEY, saved);
      const html = renderSettings();
      const text = plain(html);
      const accentPressed = pressedButtons(html).filter((b) => b.text.startsWith("Roxo"));

      readings.push({
        material: text.includes(`Material em uso: ${SURFACE_LABELS[saved]}`) ? saved : "errado",
        identity: text.includes(identityLine),
        accent: accentPressed.length === 1 && accentPressed[0].pressed,
      });
    }

    for (const reading of readings) {
      assert.equal(reading.identity, true, "a identidade guardada desapareceu ao trocar o material");
      assert.equal(reading.accent, true, "o destaque guardado desapareceu ao trocar o material");
    }
    assert.deepEqual(
      readings.map((r) => r.material),
      [...surfaces],
      "o material em uso não acompanhou a preferência guardada",
    );
  });
});

/* ── Dashboard: desconhecido/degradado nunca vira sucesso ──────────────── */

describe("Dashboard — honestidade do estado de proteção", () => {
  it("tempo real por verificar (enabled não lido) não é apresentado como sucesso", () => {
    const html = renderDashboard({ realtime: { disponivel: true } });

    assert.ok(
      html.includes("Monitorização não verificada"),
      "o hero devia declarar que a monitorização não foi verificada",
    );
    assert.equal(
      html.includes("Monitorização ligada"),
      false,
      "sem leitura de `enabled` o hero não pode afirmar monitorização ligada",
    );
    assert.equal(
      html.includes(PROTECTION_LEVEL_META.protected.answer),
      false,
      "a resposta de sucesso (nível protected) não pode ser apresentada a partir de um estado não lido",
    );
  });

  it("motores degradados nunca aparecem como protegidos, e o material guardado mantém-se", () => {
    store.set(APPARANCE_SURFACE_KEY, "solid");
    const html = renderDashboard({
      dashboard: dashboard({
        engineHealth: engine({ anyEngineDegraded: true, clamav: { status: "degraded" } }),
      }),
      realtime: { disponivel: true, enabled: true },
    });

    assert.ok(
      html.includes(PROTECTION_LEVEL_META.degraded.answer),
      "o hero devia responder com o texto do nível degraded",
    );
    assert.equal(
      html.includes(PROTECTION_LEVEL_META.protected.answer),
      false,
      "motores degradados não podem produzir a resposta de proteção total",
    );
    assert.equal(html.includes("Monitorização ligada"), false, "motores degradados com o rótulo de sucesso");

    const hero = heroTag(html);
    assert.ok(hero !== null, "hero-banner não encontrado");
    assert.equal(
      attrOf(hero!, "data-material"),
      "solid",
      "a preferência de material (eixo ortogonal) deixou de ser respeitada no estado degradado",
    );
  });
});
