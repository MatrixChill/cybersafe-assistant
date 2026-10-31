import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TelemetrySparkline,
  getSparklineAccessibleName,
  SPARKLINE_DEFAULT_ACCESSIBLE_NAME,
  SPARKLINE_EMPTY_LABEL,
  SPARKLINE_UNAVAILABLE_LABEL,
} from "../src/components/TelemetrySparkline";

// Andaime de render (o mesmo de `dashboard-engine-gate`): o Painel lê aparência
// no arranque e precisa do provider + de um `localStorage` mínimo no Node.
(globalThis as Record<string, unknown>).React = await import("react");
(globalThis as Record<string, unknown>).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { default: LabDashboardRender } = await import("../src/v2/dashboard/LabDashboard");

/**
 * TP-DELIVERY23-DASHBOARD-TELEMETRY-A11Y.
 *
 * Causa comprovada: os três SVG do Painel (CPU, RAM e rede) não tinham `role`
 * nem nome acessível, e nenhum dos três chamadores passava `label`. Um leitor
 * de ecrã via três gráficos anónimos.
 *
 * O que este ficheiro fixa:
 *   · cada gráfico é `role="img"` com o nome da métrica RECEBIDA;
 *   · sem amostras o nome diz o estado real (a recolher / sem dados) — nunca
 *     um zero nem uma medição inventada;
 *   · o nome não muda com cada amostra e não há `aria-live` (nada de anúncios
 *     por amostra);
 *   · sem nome do chamador há um neutro seguro — nunca uma métrica inventada;
 *   · os três chamadores reais do Dashboard passam nomes distintos.
 */

const NOMES = [
  "Histórico de utilização da CPU",
  "Histórico de utilização da RAM",
  "Histórico de tráfego de rede recebido",
];

function html(props: Parameters<typeof TelemetrySparkline>[0]): string {
  return renderToStaticMarkup(createElement(TelemetrySparkline, props));
}

describe("TelemetrySparkline — nome acessível real", () => {
  test("cada gráfico é role=img e usa o nome que o chamador deu", () => {
    for (const nome of NOMES) {
      const marcacao = html({ samples: [], accessibleLabel: nome });
      assert.match(marcacao, /role="img"/, `${nome}: o SVG tem de ser uma imagem nomeada`);
      assert.match(marcacao, new RegExp(`aria-label="${nome}`), `${nome}: o nome recebido tem de chegar ao aria-label`);
    }
  });

  test("sem amostras diz que está a recolher — nunca 0 nem percentagem", () => {
    const nome = NOMES[0];
    const marcacao = html({ samples: [], accessibleLabel: nome });
    assert.match(marcacao, new RegExp(`aria-label="${nome}: ${SPARKLINE_EMPTY_LABEL}"`));
    const rotulo = getSparklineAccessibleName({
      accessibleLabel: nome,
      hasSamples: false,
      showUnavailable: false,
    });
    assert.doesNotMatch(rotulo, /[0-9%]/, "nenhum número fabricado no estado vazio");
    assert.match(marcacao, new RegExp(SPARKLINE_EMPTY_LABEL), "o texto visível continua o mesmo");
  });

  test("sem dados após o prazo assume indisponível, não espera eterna", () => {
    const rotulo = getSparklineAccessibleName({
      accessibleLabel: NOMES[2],
      hasSamples: false,
      showUnavailable: true,
    });
    assert.equal(rotulo, `${NOMES[2]}: ${SPARKLINE_UNAVAILABLE_LABEL}`);
    assert.doesNotMatch(rotulo, /[0-9%]/);
  });

  test("com amostras o nome é só a métrica e não anuncia valores", () => {
    const nome = NOMES[1];
    const marcacao = html({
      samples: [
        { value: 12, timestamp: 1 },
        { value: 14, timestamp: 2 },
      ],
      accessibleLabel: nome,
    });
    assert.match(marcacao, new RegExp(`aria-label="${nome}"`));
    assert.doesNotMatch(marcacao, /aria-label="[^"]*[0-9]/, "o nome não repete números a cada amostra");
    assert.match(marcacao, /role="img"/);
  });

  test("sem nome do chamador há um neutro seguro — não inventa CPU/RAM/rede", () => {
    const marcacao = html({ samples: [] });
    assert.match(marcacao, /role="img"/);
    assert.match(marcacao, new RegExp(`aria-label="${SPARKLINE_DEFAULT_ACCESSIBLE_NAME}`));
    assert.doesNotMatch(marcacao, /aria-label="[^"]*(CPU|RAM|Rede)/i, "sem nome, nenhuma métrica é afirmada");
  });

  test("o rótulo visível e a unidade continuam a ser desenhados (sem mudar layout)", () => {
    const marcacao = html({ samples: [], label: "CPU", unit: "%", accessibleLabel: NOMES[0] });
    assert.match(marcacao, /uppercase tracking-wider/);
    assert.match(marcacao, />CPU</);
    assert.match(marcacao, /height="48"/, "as dimensões por omissão não mudaram");
    assert.match(marcacao, /width="200"/);
  });

  test("nada é anunciado a cada amostra: sem aria-live nem role=status", () => {
    const marcacao = html({
      samples: [{ value: 5, timestamp: 1 }],
      accessibleLabel: NOMES[0],
    });
    assert.doesNotMatch(marcacao, /aria-live/);
    assert.doesNotMatch(marcacao, /role="status"/);
  });

  test("controlo negativo: sem role, a asserção principal falha", () => {
    const semRole = "<svg aria-label=\"Histórico de utilização da CPU\"></svg>";
    assert.throws(() => assert.match(semRole, /role="img"/), assert.AssertionError);
  });
});

describe("Produto — nenhum gráfico chega ao ecrã sem nome, e o Painel não desenha séries que não tem", () => {
  /**
   * MIGRAÇÃO V2-FIRST: em V1 o Painel tinha três sparklines (CPU, RAM, rede) e
   * a contagem era o contrato. A composição do lab não traz esse cartão — as
   * séries vivem no PC Center — por isso o que se trava deixou de ser «exactamente
   * três no Painel» e passou a ser as duas coisas que a causa original pedia:
   *   · nenhum chamador de `<TelemetrySparkline` omite `accessibleLabel`;
   *   · nenhum gráfico se desenha sem nome acessível, e o Painel diz quando não
   *     há série em vez de desenhar uma linha a partir de nada.
   * Mapa: `out/MAPA-TESTES-V2-FIRST.md`.
   */
  const PCCENTER = readFileSync(new URL("../src/pages/PCCenterPage.tsx", import.meta.url), "utf8");
  const PAINEL = readFileSync(new URL("../src/v2/dashboard/LabDashboard.tsx", import.meta.url), "utf8");

  test("cada <TelemetrySparkline do produto passa um nome acessível", () => {
    const chamadas = (PCCENTER.match(/<TelemetrySparkline/g) ?? []).length;
    assert.ok(chamadas >= 3, `esperava pelo menos três séries no PC Center, vi ${chamadas}`);
    for (const bloco of PCCENTER.split("<TelemetrySparkline").slice(1)) {
      assert.match(bloco.slice(0, 700), /accessibleLabel=?/, "cada gráfico tem de ter nome acessível");
    }
    assert.equal((PCCENTER.match(/accessibleLabel=/g) ?? []).length, chamadas, "um nome por gráfico, nem mais nem menos");
  });

  test("o Painel V2 rotula o gráfico que desenha e não desenha série sem amostras", () => {
    assert.match(PAINEL, /<Chart[\s\S]{0,160}label=/, "todo o Chart do Painel declara a métrica que mostra");
    const html = renderToStaticMarkup(
      createElement(
        AppearanceProvider,
        null,
        createElement(LabDashboardRender as never, {
          dashboard: {
            riskScore: 70, totalEvents: 0, highSeverityEvents: 0, downloadRisk: "low",
            recentThreats: [], alerts: [], systemStatus: "safe",
          },
          isLoading: false,
          serviceConnected: true,
          history: { phase: "pronto", entry: null },
          hardware: { cpu: { usage: 20, model: "" } },
          realtime: { disponivel: true, enabled: true },
        } as never),
      ),
    );
    // Sem série recolhida (o `useTelemetryHistory` não corre em SSR), o Painel
    // tem de dizer isso — nunca desenhar uma linha que ninguém mediu.
    assert.match(html, /ainda sem série suficiente/i);
    assert.equal(/class="chart"/.test(html), false, "nenhum gráfico desenhado sem amostras confirmadas");
    assert.doesNotMatch(html, /role="img"[^>]*aria-label="CPU/, "sem série não há nome de série");
  });
});
