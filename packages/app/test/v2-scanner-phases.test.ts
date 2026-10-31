import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScanPhase } from "@cybersafe/shared-types";
import { FASES, ScanPhaseList, faseAtual, percentagemValida } from "../src/v2/scanner/ScanPhaseList";

// Ver o comentário em scanner-page-render.test.ts: o `tsx` compila o JSX dos
// fontes com o runtime clássico e é este global que o satisfaz fora do Vite.
(globalThis as Record<string, unknown>).React = React;

/**
 * TP-V2-SCANNER-QUARANTINE-HISTORY (P0 Scanner) — qoder.
 *
 * O que este ficheiro trava, depois da revisão de 20:30:
 *  1. **nada é inferido**: uma fase só aparece realçada quando o motor a
 *     comunica naquele instante. Um estado terminal (`failed`/`cancelled`/
 *     `completed`) **não** prova que as fases anteriores decorreram — o
 *     `scan-manager` pode emitir `failed` em `finalizing` sem ter começado, e um
 *     cancelamento em fila chega sem fase nenhuma;
 *  2. `phase` ausente + terminal ⇒ **zero** fases realçadas, com a frase a dizer
 *     que nada é concluído (e não «as fases passaram todas»);
 *  3. a percentagem só aparece se chegou válida; com `progress` NaN/Infinity a
 *     frase não pode afirmar «a percentagem recebida» quando não há percentagem;
 *  4. nenhuma string de demonstração do lab entra na página;
 *  5. a folha `.css` local não é importada por componente algum (o que partia o
 *     `node:test`) e vive só dentro de `.cs-v2 .v2-scanner`.
 */

const render = (phase: ScanPhase | undefined, status: string, progress: number) =>
  renderToStaticMarkup(createElement(ScanPhaseList, { phase, status, progress }));

const lidas = (html: string) => (html.match(/data-atual="true"/g) ?? []).length;
const ler = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("Scanner V2 — fases pela palavra do motor, sem inferência", () => {
  test("a lista é o contrato ScanPhase, pela ordem do contrato", () => {
    assert.deepEqual(FASES.map((f) => f.fase), ["preparing", "gathering", "scanning", "finalizing"]);
  });

  test("faseAtual: só a fase comunicada agora; nada além dela", () => {
    for (const { fase } of FASES) assert.equal(faseAtual(fase, undefined), false, `${fase} sem comunicação`);
    assert.equal(faseAtual("scanning", "scanning"), true);
    assert.equal(faseAtual("preparing", "scanning"), false, "a anterior não é afirmada sem histórico");
    assert.equal(faseAtual("finalizing", "scanning"), false, "a seguinte nunca é afirmada");
  });

  test("terminal sem fase realçada: failed/cancelled/completed antes de preparar", () => {
    for (const status of ["failed", "cancelled", "completed"]) {
      const html = render(undefined, status, 0);
      assert.equal(lidas(html), 0, `status ${status} realçou fases não comunicadas`);
      assert.match(html, /data-estado="[^"]*"/);
      assert.doesNotMatch(html, /reached|concluída a fase/, "não existe marca de fase concluída");
    }
    // Frase própria de análise terminada sem fases nem percentagem.
    const falha = render(undefined, "failed", Number.NaN);
    assert.match(falha, /não comunicou as fases desta análise, nem uma percentagem válida/);
    assert.match(falha, /Nada é concluído sobre o que aconteceu/);
  });

  test("`finalizing` sem histórico realça uma fase, não as quatro", () => {
    const html = render("finalizing", "running", 100);
    assert.equal(lidas(html), 1, "as outras três fases foram inferidas");
    assert.match(html, /data-fase-alvo="finalizing" data-atual="true"/);
    assert.match(html, /data-fase-alvo="scanning" data-atual="false"/);
  });

  test("percentagem: mostrada quando válida, ausente quando não é número", () => {
    assert.equal(percentagemValida(40), true);
    assert.equal(percentagemValida(0), true);
    assert.equal(percentagemValida(100), true);
    for (const invalido of [NaN, Infinity, -1, 101]) assert.equal(percentagemValida(invalido), false, `${invalido}`);
    assert.match(render("scanning", "running", 55.4), /class="mono">55%/);
    const semNumero = render("scanning", "running", Number.NaN);
    assert.doesNotMatch(semNumero, /class="mono">/, "percentagem desenhada sem número válido");
    assert.match(semNumero, /Percentagem não recebida/, "a fasecommunicada continua dita, sem inventar percentagem");
  });

  test("sem fase e com percentagem válida: a frase afirma só a percentagem", () => {
    const html = render(undefined, "running", 40);
    assert.match(html, /data-fase="nao-comunicada"/);
    assert.equal(html.includes('class="current"'), false);
    assert.match(html, /role="status"[^>]*>O serviço não comunica em que fase está; apenas a percentagem recebida é afirmada\.</);
    assert.doesNotMatch(html, /percentagem não foi recebida/, "não contradiz a percentagem que está na linha ao lado");
  });

  test("nenhuma string de demonstração do laboratório entra na página", () => {
    const fonte = ler("../src/v2/scanner/ScanPhaseList.tsx");
    for (const proibido of ["ANÁLISE DEMO", "Análise de demonstração", "· DEMO", "248", "fictíc", "Simulação local", "Amostra fictícia"]) {
      assert.equal(fonte.includes(proibido), false, `literal do lab no componente V2: ${proibido}`);
    }
  });
});

describe("Scanner V2 — cartões de análise e ligação à página", () => {
  const pagina = ler("../src/pages/FileScannerPage.tsx");
  const componente = ler("../src/v2/scanner/ScanPhaseList.tsx");
  const css = ler("../src/v2/scanner/scanner-v2.css");

  test("a página monta o ScanPhaseList dentro do bloco em curso, com dados reais", () => {
    assert.match(pagina, /import \{ ScanPhaseList \} from "@\/v2\/scanner\/ScanPhaseList"/);
    assert.match(pagina, /<ScanPhaseList[\s\S]{0,200}phase=\{scanProgress\.phase\}[\s\S]{0,120}status=\{scanProgress\.status\}[\s\S]{0,120}progress=\{scanProgress\.progress\}/);
    const barra = pagina.indexOf("<ScanProgressBar bar={bar}");
    const lista = pagina.indexOf("<ScanPhaseList");
    assert.ok(barra > 0 && lista > barra, "as fases aparecem antes da barra de progresso");
    assert.ok(lista - barra < 900, "a lista de fases foi empurrada para fora do bloco em curso");
  });

  test("os quatro cartões de análise vivem em `.scan-options`, sem semântica de rádio", () => {
    assert.match(pagina, /className="scan-options/);
    assert.equal((pagina.match(/className="scan-option\b/g) ?? []).length, 1, "os cartões recebem a classe um a um");
    // Os cartões do produto SÃO AÇÕES, não um seletor de modo: copiar
    // `.radio-dot`/`aria-pressed` do lab afirmaria uma seleção que não existe.
    // Fiscaliza-se o código, não a prosa: os comentários saem primeiro.
    const soCodigo = pagina.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(soCodigo, /radio-dot/, "o marcador de rádio do lab não foi copiado à cega");
    assert.doesNotMatch(soCodigo, /<button[\s\S]{0,220}className="[^"]*\bscan-option\b[\s\S]{0,220}?aria-pressed/, "ação com estado de seleção inventado");
  });

  test("nem o componente nem a página importam CSS (o que partia o node:test)", () => {
    assert.doesNotMatch(componente, /import ['"][^'"]*\.css['"]/, "import de CSS num componente V2 quebra os testes SSR");
    assert.doesNotMatch(pagina.slice(0, pagina.indexOf("interface FileScannerPageProps")), /\.css['"]/, "import de CSS na página");
  });

  test("a folha local está ancorada no invólucro V2 e só usa tokens do tema", () => {
    assert.match(pagina, /className="cs-scanner-root v2-scanner/);
    const regras = css
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.endsWith("{") && !l.startsWith("@") && !l.startsWith("/*") && !l.startsWith("*"));
    assert.ok(regras.length >= 8, `esperava várias regras, vi ${regras.length}`);
    for (const linha of regras) {
      assert.match(linha, /^\.cs-v2 \.v2-scanner /, `seletor fora do invólucro: ${linha}`);
    }
    assert.match(css, /var\(--v2-panel\)/, "os cartões usam os tokens do tema");
    assert.match(css, /\.phase-list \.current /, "a fase atual é realçada, não as anteriores");
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, "cor literal na folha local");
  });
});
