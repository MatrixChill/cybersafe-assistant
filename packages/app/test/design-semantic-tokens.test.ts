import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineHealth, ThreatEvent } from "@cybersafe/shared-types";
import { PROTECTION_LEVEL_META, type ProtectionLevel } from "../src/lib/protectionHealth";

// `tsx` compila JSX com runtime clássico — mesmo padrão de scanner-page-render.test.ts.
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

/**
 * DESIGN AUDIT 2026-10-04, P0-1.
 * `bg-success` / `text-warning` / `border-danger` não são utilitários gerados:
 * o index.css não define --color-success|warning|danger, logo o Tailwind v4
 * simplesmente não produz essas classes. Os 4 níveis de proteção ficavam
 * visualmente idênticos e o dot do sidebar era invisível. O teste fixa as duas
 * metades: as classes usadas vivem na família cyber-* E o token que as gera
 * existe em index.css.
 */
const cssSource = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
const DEAD = /(?:^|\s)(?:bg|text|border)-(?:success|warning|danger)(?:\/\d+)?(?:\s|$)/;

describe("níveis de proteção usam só tokens cyber-* existentes", () => {
  const expectedColor: Record<ProtectionLevel, string> = {
    protected: "cyber-green",
    attention: "cyber-yellow",
    degraded: "cyber-red",
    critical: "cyber-red",
  };

  for (const level of Object.keys(PROTECTION_LEVEL_META) as ProtectionLevel[]) {
    const meta = PROTECTION_LEVEL_META[level];
    test(`${level}: nenhuma classe morta success/warning/danger`, () => {
      for (const field of ["dotClass", "chipClass", "textClass", "bannerBadgeClass"] as const) {
        assert.equal(
          DEAD.test(` ${meta[field]} `),
          false,
          `${level}.${field} contém um utilitário inexistente: "${meta[field]}"`,
        );
      }
    });

    test(`${level}: cor semântica cyber-* correta em dot, texto, chip e badge`, () => {
      const color = expectedColor[level];
      assert.match(meta.dotClass, new RegExp(`bg-${color}$`), `${level}.dotClass`);
      assert.match(meta.textClass, new RegExp(`text-${color}$`), `${level}.textClass`);
      assert.match(meta.chipClass, new RegExp(`bg-${color}/10`), `${level}.chipClass`);
      assert.match(meta.chipClass, new RegExp(`border-${color}/(?:30|40)`), `${level}.chipClass`);
      assert.match(meta.bannerBadgeClass, new RegExp(`text-${color}$`), `${level}.bannerBadgeClass`);
    });
  }

  test("os três tons distintos existem — protected ≠ attention ≠ degraded", () => {
    assert.notEqual(PROTECTION_LEVEL_META.protected.dotClass, PROTECTION_LEVEL_META.attention.dotClass);
    assert.notEqual(PROTECTION_LEVEL_META.attention.dotClass, PROTECTION_LEVEL_META.degraded.dotClass);
    assert.notEqual(PROTECTION_LEVEL_META.degraded.textClass, PROTECTION_LEVEL_META.protected.textClass);
  });

  test("index.css gera os utilitários usados (o mecanismo que matava bg-success)", () => {
    // Em Tailwind v4 um utilitário bg-<x>/text-<x>/border-<x> só existe se
    // --color-<x> estiver declarado no @theme. É exatamente o que faltava em
    // success/warning/danger. Aqui prova-se que cyber-green/yellow/red têm cor
    // de marca E variante -text de texto (AA nos temas claros).
    for (const name of ["cyan", "green", "red", "yellow"] as const) {
      assert.match(cssSource, new RegExp(`--color-cyber-${name}: var\\(--cyber-${name}-text\\)`));
      assert.match(cssSource, new RegExp(`--cyber-${name}:`), `--cyber-${name} base definida`);
    }
    assert.equal(/--color-(success|warning|danger):/.test(cssSource), false,
      "se alguem definir estes tokens, o teste de classes mortas tem de ser revisto, nao eliminado em silencio");
  });
});

/**
 * ProtectionDetails é o maior consumidor de cores de estado. Renderiza com
 * um EngineHealth cobrindo os quatro estados — nenhum badge pode depender de
 * classe morta, e cada estado tem de chegar ao markup com a cor certa.
 */
const { default: ProtectionDetails } = await import("../src/components/ProtectionDetails");

describe("ProtectionDetails — badges de motor com tokens reais", () => {

  const engine = {
    serviceRunning: true,
    anyEngineDegraded: true,
    degradedReasons: ["base de assinaturas ausente"],
    yara: { status: "active" },
    hashDb: { status: "degraded", detail: "Loaded 1 rule(s)" },
    clamav: { status: "error", detail: "clamscan falhou" },
    nativeEngine: { status: "unavailable" },
    firewall: { status: "unavailable", detail: "WFP filter not started" },
  } as unknown as EngineHealth;

  const html = renderToStaticMarkup(
    createElement(ProtectionDetails, {
      engine,
      level: "degraded",
      open: true,
      onClose: () => {},
      score: 40,
    }),
  );

  test("cada estado de motor desenha com a sua cor cyber-*", () => {
    assert.match(html, /text-cyber-green[^"]*"[^>]*>Ativo/, "YARA ativo → verde");
    assert.match(html, /text-cyber-yellow[^"]*"[^>]*>Degradado/, "Hash DB degradado → âmbar");
    assert.match(html, /text-cyber-red[^"]*"[^>]*>Erro/, "ClamAV em erro → vermelho");
  });

  test("motivos de degradação (bloco técnico) usam cyber-red, não a classe morta danger", () => {
    // O bloco só vive com `technical` aberto; o gate é sobre a fonte.
    const src = readFileSync(new URL("../src/components/ProtectionDetails.tsx", import.meta.url), "utf8");
    assert.match(src, /bg-cyber-red\/5 border border-cyber-red\/20/);
    assert.match(src, /text-cyber-red mb-2/);
    assert.equal(/(?:bg|text|border)-(?:success|warning|danger)(?:\/|$)/.test(html), false);
    assert.equal(/(?:bg|text|border)-(?:success|warning|danger)(?:\/|$)/.test(src), false, "source ainda refere utilitários inexistentes");
  });

  test("Indisponível permanece neutro — sem cor de veredicto", () => {
    assert.match(html, /text-muted-foreground[^"]*"[^>]*>Indisponível/);
  });
});

/**
 * DESIGN AUDIT P1-1: o botão do Dashboard prometia "Todo o computador,
 * ficheiro a ficheiro" — o scan profundo NÃO cobre Windows nem Program Files
 * (scanSession.ts:45-58) e o motor trabalha em lote. A promessa vivia na
 * superfície clicável principal da demo.
 */
describe("Dashboard — copy das ações do Scanner é o escopo real", () => {
  const source = readFileSync(new URL("../src/pages/DashboardPage.tsx", import.meta.url), "utf8");

  test("não promete varredura total nem ficheiro a ficheiro", () => {
    assert.equal(/todo o computador/i.test(source), false, "o scan profundo exclui Windows e Program Files");
    assert.equal(/ficheiro a ficheiro/i.test(source), false, "o motor analisa em lote, não ficheiro a ficheiro");
  });

  test("usa o par de termos do Scanner: Análise Rápida / Análise Profunda", () => {
    assert.match(source, /label="Análise Rápida"/);
    assert.match(source, /label="Análise Profunda"/);
    assert.match(source, /label="Analisar uma Pasta"/);
    assert.equal(/Verifi(?:cação|cação)\s+(?:rápida|completa)/i.test(source), false,
      '"Verificação" é o segundo nome para a mesma ação — proibido');
  });

  test("a sub-copy da Análise Profunda descreve o escopo medido", () => {
    assert.match(source, /Análise Profunda"\s+sub="Pastas do seu utilizador e arranques automáticos"/);
  });
});

/**
 * DESIGN AUDIT P1-4: "Baixa" era verde com check-mark — ameaça a parecer
 * estado limpo. Verde é exclusivo de "verificado sem deteções".
 */
const { default: ThreatsPage } = await import("../src/pages/ThreatsPage");

describe("ThreatsPage — severidade nunca se confunde com 'limpo'", () => {

  const threat = (severity: ThreatEvent["severity"]): ThreatEvent => ({
    source: "system-scanner",
    url: "https://exemplo.pt/pagina",
    domain: "exemplo.pt",
    severity,
    confidence: 0.7,
    // Regra presente: sem isto, o badge "Aprovação Procedural" (verde, sobre
    // regras — não sobre severidade) entrava no markup e confundia o asserts.
    rulesTriggered: ["url-encurtada-suspeita"] as unknown as ThreatEvent["rulesTriggered"],
    createdAt: "2026-10-04T10:00:00.000Z",
    riskScore: 50,
  });

  const render = (events: ThreatEvent[]) =>
    renderToStaticMarkup(createElement(ThreatsPage, { events, onClear: () => {}, isClearing: false }));

  test("ameaça Baixa não é pintada com o verde de 'verificado limpo'", () => {
    const html = render([threat("low")]);
    assert.equal(/text-cyber-green/.test(html), false, "low não pode herdar a cor do estado limpo");
    assert.equal(html.includes("lucide-circle-check"), false, "check-mark é ícone de sucesso, não de ameaça baixa");
    assert.match(html, /text-muted-foreground/);
  });

  test("média é âmbar; alta e crítica são vermelhas", () => {
    const medium = render([threat("medium")]);
    assert.match(medium, /text-cyber-yellow/);
    assert.equal(/text-cyber-green/.test(medium), false);

    const high = render([threat("high")]);
    assert.match(high, /text-cyber-red/);
    const critical = render([threat("critical")]);
    assert.match(critical, /text-cyber-red/);
  });

  test("escala completa: as quatro severidades produzem três tons, nenhum verde", () => {
    const html = render([threat("low"), threat("medium"), threat("high"), threat("critical")]);
    assert.equal(/(?:text|bg|border)-cyber-green/.test(html), false,
      "nenhuma linha de ameaça pode usar a cor de 'sem deteções'");
    assert.match(html, /Média/);
    assert.match(html, /Baixa/);
  });
});
