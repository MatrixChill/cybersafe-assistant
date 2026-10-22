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

describe("Dashboard — os três chamadores passam nomes distintos", () => {
  const DASHBOARD = readFileSync(new URL("../src/pages/DashboardPage.tsx", import.meta.url), "utf8");
  const USOS = DASHBOARD.split("\n").filter((linha) => linha.includes("<TelemetrySparkline"));

  test("existem exactamente três gráficos e todos têm accessibleLabel", () => {
    assert.equal(USOS.length, 3, "o âmbito é CPU, RAM e rede — nem mais nem menos");
    for (const linha of USOS) {
      assert.match(linha, /accessibleLabel="/, "cada gráfico tem de ter nome acessível");
    }
    assert.equal((DASHBOARD.match(/accessibleLabel="/g) ?? []).length, 3);
  });

  test("os nomes correspondem às três métricas reais do cartão", () => {
    const porMetrica = [
      { cartao: "CPU", sparkline: "cpuSamples" },
      { cartao: "RAM", sparkline: "ramSamples" },
      { cartao: "Rede", sparkline: "netRxSamples" },
    ];
    for (const { cartao, sparkline } of porMetrica) {
      const linha = USOS.find((l) => l.includes(`samples={${sparkline}}`));
      assert.ok(linha, `${cartao}: o gráfico esperado tem de existir`);
      assert.match(linha as string, /accessibleLabel="Histórico de [^"]+"/);
    }
    assert.match(DASHBOARD, /Histórico de utilização da CPU/);
    assert.match(DASHBOARD, /Histórico de utilização da RAM/);
    assert.match(DASHBOARD, /Histórico de tráfego de rede recebido/);
  });
});
