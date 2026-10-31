import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { rotuloDeCobertura } from "../src/components/ScanHistoryPanel";

/**
 * O que `filesAnalyzed` NUM REGISTO do histórico significa, e a palavra que a UI
 * tem de usar.
 *
 * MEDIDO nesta manutenção (relatório A5): o serviço publica
 * `filesAnalyzed = max(ciclo por ficheiro, veredictos terminais do batch)` — é
 * cobertura de motores, não conclusão do pipeline, como o próprio
 * `lib/scanSession.ts` declara e `test/scan-batch-terminal-reconcile.test.js`
 * exige (o contador não recua, nunca é soma). Num scan `cancelled` o registo
 * ficou a dizer «Analisados 2003» quando o ciclo por ficheiro fechou 490. O
 * NÚMERO não se mexe (é o contrato aprovado); a ETIQUETA passa a dizer o que a
 * contagem prova e o que não prova.
 *
 * LIMITES: o package não tem jsdom e o painel vai buscar as entradas em efeitos,
 * por isso o `renderToStaticMarkup` não mostra uma linha real — a palavra prova-
 * se na função pura e a ligação aos dois sítios prova-se na estrutura do código,
 * que é o mesmo método de `test/r7-l3-history-ui.test.ts`.
 */
const painel = readFileSync(new URL("../src/components/ScanHistoryPanel.tsx", import.meta.url), "utf8");

describe("histórico — a palavra certa para a contagem de um scan cancelado", () => {
  test("cancelled: rotulagem de cobertura, com nota do que não prova", () => {
    const r = rotuloDeCobertura("cancelled");
    assert.match(r.label, /motores/i, "tem de dizer o que varreu, não «analisados» a secas");
    assert.doesNotMatch(r.label, /^analisados$/i, "o rótulo antigo não pode sobreviver no cancelado");
    assert.ok(r.nota, "o cancelado tem de trazer a nota");
    assert.match(`${r.label} ${r.nota}`, /cobertura/i);
    assert.match(String(r.nota), /cancela/i, "a nota tem de ligar a contagem ao cancelamento");
    assert.doesNotMatch(`${r.label} ${r.nota}`, /clamav|clamd/i, "o número é o máx. dos dois eixos, não só o motor de assinaturas");
    assert.doesNotMatch(r.label, /concluído|complet[oa]|análise completa/i, "a etiqueta não pode afirmar conclusão");
    assert.match(String(r.nota), /não prova/i, "a nota tem de dizer o que a contagem não abrange");
  });

  test("completed: contrato intacto, rótulo e ausência de nota", () => {
    const r = rotuloDeCobertura("completed");
    assert.equal(r.label, "Analisados");
    assert.equal(r.nota, null);
  });

  test("failed: fora do scope desta mudança", () => {
    const r = rotuloDeCobertura("failed");
    assert.equal(r.label, "Analisados");
    assert.equal(r.nota, null);
  });

  test("os dois sítios usam a função — o PDF e a linha do painel", () => {
    assert.match(painel, /contagem\(rotuloDeCobertura\(e\.status\)\.label,\s*e\.filesAnalyzed\)/,
      "o PDF do registo tem de rotular pela função");
    assert.match(painel, /\{rotuloDeCobertura\(e\.status\)\.label\.toLowerCase\(\)\}\s*\{numero\(e\.filesAnalyzed\)/,
      "a linha do painel tem de rotular pela função");
  });

  test("anti-mascaração: nenhum número é recalculado nem trocado por outro campo", () => {
    assert.doesNotMatch(painel, /filesAnalyzed\s*[-+*/]\s*\d/, "a etiqueta não pode mexer na contagem");
    assert.match(painel, /e\.filesAnalyzed/, "o campo exibido continua a ser filesAnalyzed");
  });

  test("a palavra vem da função, não de literals espalhados pelo JSX", () => {
    assert.match(painel, /rotuloDeCobertura\(e\.status\)\.nota/,
      "a nota é lida da mesma função, não escrita à mão no sítio de render");
    assert.doesNotMatch(painel, /contagem\("Analisados"/,
      "o PDF não pode continuar com a etiqueta crua");
    assert.doesNotMatch(painel, />\s*analisados\s*\{/,
      "a linha do painel não pode continuar com a etiqueta crua");
    assert.equal((painel.match(/"Analisados"/g) ?? []).length, 1,
      "a palavra só existe dentro de rotuloDeCobertura");
  });
});
