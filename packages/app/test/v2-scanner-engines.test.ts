import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineHealth } from "@cybersafe/shared-types";
import { ScanEngineState } from "../src/v2/scanner/ScanEngineState";
import { engineCards } from "../src/v2/dashboard/model";

// Ver o comentário em scanner-page-render.test.ts: o `tsx` compila o JSX dos
// fontes com o runtime clássico e é este global que o satisfaz fora do Vite.
(globalThis as Record<string, unknown>).React = React;

/**
 * TP-V2-SCANNER-QUARANTINE-HISTORY, evento 3 (P0 Scanner) — qoder.
 *
 * A revisão de 20:30 deu a regra: `EngineHealth` é um **instantâneo de serviço**,
 * não prova de que um motor participou em seja que análise for. Este ficheiro
 * trava três coisas:
 *  1. o que a Scanner mostra é a derivação **canónica** (`engineCards` do modelo
 *     do Painel) — um segundo vocabulário de estados seria duas verdades para o
 *     mesmo facto do serviço;
 *  2. **ausência e offline dizem «não comunicado»**: sem `serviceConnected ===
 *     true` nada aparece como `Ativo`, e sem props ligadas pelo App não se desenha
 *     mesmo nada (um «Sem leitura» inventado seria uma afirmação sobre o serviço);
 *  3. nenhuma string do laboratório (contagem de cenário, amostras fictícias)
 *     entra aqui.
 */

const saude = (parcial: Partial<EngineHealth> = {}): EngineHealth =>
  ({
    serviceRunning: true,
    osLayerHealthy: true,
    degradedReasons: [],
    monitoredPaths: [],
    ...parcial,
  }) as EngineHealth;

const render = (props: { engineHealth?: EngineHealth; serviceConnected?: boolean | null }) =>
  renderToStaticMarkup(createElement(ScanEngineState, props));

const ler = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const CARTOES = (html: string) => [...html.matchAll(/data-engine="([a-zA-Z]+)"[^>]*data-state="([a-z]+)"/g)];

describe("Scanner V2 — estado atual dos motores pela derivação canónica", () => {
  test("com props não ligadas ao App, não se desenha nada", () => {
    assert.equal(render({}), "", "sem instantâneo e sem confirmação de ligação não há estado a afirmar");
    assert.equal(render({ serviceConnected: undefined }), "");
  });

  test("os rótulos e a cobertura são os de `engineCards`, não uma cópia local", () => {
    const health = saude({
      yara: { status: "active", coverage: "normal" },
      clamav: { status: "degraded" },
      hashDb: { status: "unavailable" },
    });
    const html = render({ engineHealth: health, serviceConnected: true });
    const esperado = engineCards(health, true);
    for (const c of esperado) {
      assert.ok(html.includes(`>${c.name}<`), `faltou o motor ${c.name}`);
      assert.ok(html.includes(`>${c.label}<`), `faltou o rótulo canónico de ${c.name} (${c.label})`);
      assert.ok(html.includes(c.coverage), `faltou a cobertura canónica de ${c.name}`);
    }
    // `unavailable` tem nome próprio no contrato: não é «Sem leitura».
    assert.match(html, />Indisponível</);
  });

  test("ligação confirmada sem relatório por motor: «Sem leitura», nunca verde", () => {
    const html = render({ engineHealth: saude(), serviceConnected: true });
    assert.equal(html.includes("Ativo"), false, "sem relatório por motor nada é ativo");
    assert.equal((html.match(/data-state="unavailable"/g) ?? []).length, 4);
    assert.equal((html.match(/Cobertura não confirmada/g) ?? []).length, 4);
    assert.match(html, /data-conexao="confirmada"/);
  });

  test("degradação reportada não vira estado bom; cobertura limitada degrada", () => {
    const html = render({
      engineHealth: saude({
        yara: { status: "active", coverage: "limited" },
        nativeEngine: { status: "error" },
      }),
      serviceConnected: true,
    });
    assert.match(html, /data-engine="yara"[^>]*data-state="degraded"/, "cobertura limitada não se apresenta como ACTIVE");
    assert.match(html, /data-engine="nativeengine"|data-engine="nativeEngine"/);
    assert.equal(html.includes(">Ativo<"), false, "nenhum motor ficou simplesmente «Ativo»");
  });
});

describe("Scanner V2 — offline e ausência não comunicam estado", () => {
  test("serviceConnected false: nenhum motor comunica, e isso está escrito", () => {
    const html = render({
      engineHealth: saude({ yara: { status: "active", coverage: "normal" } }),
      serviceConnected: false,
    });
    assert.match(html, /data-conexao="nao-confirmada"/);
    assert.equal(html.includes("Ativo"), false, "instantâneo velho não pode aparecer como estado atual");
    assert.equal(html.includes("Sem ligação confirmada ao serviço: nenhum motor comunica"), true);
    assert.equal((html.match(/data-comunicado="false"/g) ?? []).length, 4);
  });

  test("serviceConnected null não é verdadeiro: mesma recusa", () => {
    const html = render({
      engineHealth: saude({ yara: { status: "active" } }),
      serviceConnected: null,
    });
    assert.match(html, /data-conexao="nao-confirmada"/);
    assert.equal(html.includes("Ativo"), false);
  });

  test("o rótulo é ESTADO ATUAL; a participação na sessão nunca é afirmada", () => {
    const html = render({ engineHealth: saude(), serviceConnected: true });
    assert.match(html, /Estado atual dos motores/);
    assert.match(html, /Não prova que estes motores participaram em nenhuma análise/);
    assert.equal(/participa[çc][ãa]o nesta/.test(html), false, "não há frase que afirme participação nesta sessão");
    assert.equal(/Cobertura do cen|COBERTURA DO CEN/i.test(html), false, "a contagem de cenário do lab não é dado do produto");
  });

  test("nenhuma string de demonstração do lab", () => {
    const html = render({ engineHealth: saude({ clamav: { status: "active" } }), serviceConnected: true });
    for (const demo of ["/ 4 motores", "amostra", "fictíci", "demo", "Sample"]) {
      assert.equal(html.toLowerCase().includes(demo.toLowerCase()), false, `entrou material de demo: ${demo}`);
    }
    assert.equal(CARTOES(html).length, 4, "são os quatro motores do contrato, nem mais nem menos");
  });
});

describe("Scanner V2 — ligação na página e folha", () => {
  const pagina = ler("../src/pages/FileScannerPage.tsx");
  const fonte = ler("../src/v2/scanner/ScanEngineState.tsx");
  const folha = ler("../src/v2/scanner/scanner-v2.css").replace(/\/\*[\s\S]*?\*\//g, "");

  test("a página recebe o instantâneo do App e passa-o sem o reinterpretar", () => {
    assert.match(pagina, /import { ScanEngineState } from "@\/v2\/scanner\/ScanEngineState"/);
    assert.match(pagina, /engineHealth\?: EngineHealth;/);
    assert.match(pagina, /serviceConnected\?: boolean \| null;/);
    assert.match(
      pagina,
      /export default function FileScannerPage\(\{[^}]*\bengineHealth\b[^}]*\bserviceConnected\b[^}]*\}/,
      "as props são destruturadas, não lidas de um contexto paralelo",
    );
    assert.match(
      pagina,
      /<ScanEngineState engineHealth=\{engineHealth\} serviceConnected=\{serviceConnected\} \/>/,
      "a página encaminha, não inventa valores",
    );
  });

  test("o componente não reimplementa a derivação", () => {
    assert.match(fonte, /import \{ engineCards \} from "@\/v2\/dashboard\/model"/);
    assert.equal(/status === "active"/.test(fonte), false, "nenhum if próprio sobre `status`: quem decide é o modelo");
    assert.equal(/\.css/.test(fonte), false, "importar CSS por componente partia o node:test");
  });

  test("a folha tem a quebra de linha que o caption exige e a grelha do lab", () => {
    assert.match(folha, /\.cs-v2 \.v2-scanner \.phase-list \{[\s\S]{0,240}flex-wrap: wrap;/, "flex-basis:100% sem wrap não quebra: a linha de proveniência desaparecia em largura estreita");
    assert.match(folha, /\.cs-v2 \.v2-scanner \.result-grid \{[\s\S]{0,160}grid-template-columns: 1fr 1fr;/);
    assert.match(folha, /\.cs-v2 \.v2-scanner \.engine-state em \{/);
    for (const bloco of folha.match(/\.cs-v2 \.v2-scanner \.engine-state[^}]*\}/g) ?? []) {
      assert.equal(/cyber-(green|red|yellow)/.test(bloco), false, `cor de veredicto no estado de um motor: ${bloco}`);
    }
  });

  test("o espelho de `model.ts` é mesmo o da DEV, não uma variante local", () => {
    const espelho = readFileSync(new URL("../src/v2/dashboard/model.ts", import.meta.url), "utf8");
    assert.equal(
      espelho.includes('export const STATE_LABEL: Record<VisualState, string> = {'),
      true,
      "o ficheiro em lane é o modelo do Painel; a Scanner só o consome",
    );
    assert.equal(pagina.includes("@/v2/dashboard/LabDashboard"), false, "a Scanner não puxa o Painel para dentro");
  });
});
