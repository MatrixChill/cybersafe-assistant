import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * TP-V2-SCANNER-REMAINING · S1 (resultados) — qoder.
 *
 * Incremento pequeno e congelável da composição original do Scanner: o cartão
 * de resultado passa a usar a geometria e o tipo de letra do `.result-box` do
 * laboratório (`styles.css:1282-1296`), e a grelha de estados dos motores passa
 * a deitar-se para uma coluna abaixo de 760px como o lab faz
 * (`styles.css:2760-2889`).
 *
 * Este ficheiro trava duas recusas, e são a parte importante da entrega:
 *  1. as tintas de aviso do lab (`--warn-edge`/`--warn-bg`) não são copiadas —
 *     no lab a caixa é só o «resultado parcial · demonstração»; no produto o
 *     mesmo cartão diz concluído, parcial e falhado, e a cor vem do `data-ton`
 *     já calculado. Pintar de aviso um resultado limpo seria uma mentira
 *     hérita do design;
 *  2. **não existe radar**. O `<div className="scan-radar">` do lab
 *     (`SecurityPages.tsx:492`) não tem uma única regra CSS em `styles.css`,
 *     `v2.css`, `ultimate.css` ou `design-system/tokens.css` (grep medido a
 *     28/10). Transcrever «o radar do lab» seria inventar o visual, e o label
 *     do lab nessa marcação é «ANÁLISE DEMO», que nunca entraria. O radar fica
 *     HOLD: ou o lab mostra a fonte, ou é decisão de produto com gate do
 *     integrador — não uma invenção minha num cartão de segurança.
 */

const ler = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const pagina = ler("../src/pages/FileScannerPage.tsx");
const codigo = pagina.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const folha = ler("../src/v2/scanner/scanner-v2.css");
const semComentario = folha.replace(/\/\*[\s\S]*?\*\//g, "");

describe("Scanner S1 — cartão de resultado com a escala do lab", () => {
  test("a classe do lab entra no cartão sem apagar o que já lá estava", () => {
    assert.match(
      codigo,
      /"cs-scanner-result result-box cyber-border rounded-xl p-6"/,
      "anatomia acrescentada; os ganchos do produto (cs-scanner-result, cyber-border, p-6) continuam",
    );
    assert.equal((codigo.match(/result-box/g) ?? []).length, 1, "uma só caixa de resultado — não duas âncoras");
    assert.match(pagina, /data-ton=\{tom\}/, "o tom calculado continua no nó raiz do cartão");
    assert.equal(codigo.includes("warn-edge"), false, "a borda de aviso do lab não entra no cartão do produto");
    assert.equal(codigo.includes("warn-bg"), false, "o fundo de aviso do lab não entra no cartão do produto");
  });

  test("a folha transcreve tipo e raio, e diz porque não transcreve a tinta", () => {
    assert.match(semComentario, /\.cs-v2 \.v2-scanner \.result-box \{\s*border-radius: var\(--v2-control-radius\);\s*\}/);
    assert.match(semComentario, /\.cs-v2 \.v2-scanner \.result-box h3 \{\s*font-size: 14px;\s*\}/);
    assert.match(semComentario, /\.cs-v2 \.v2-scanner \.result-box > p \{\s*font-size: 11px;\s*\}/);
    const caixa = /cs-v2 \.v2-scanner \.result-box[^{]*\{([^}]*)\}/g;
    for (const [, corpo] of semComentario.matchAll(caixa)) {
      assert.equal(/background|border(-top|-bottom)?:/.test(corpo), false, `a folha pintaria o cartão: ${corpo.trim()}`);
    }
    assert.match(folha, /--warn-edge/, "a recusa está escrita na folha, não só no teste");
    assert.match(folha, /data-ton/, "a razão: a cor vem do tom calculado do produto");
  });

  test("estreito: a grelha de estados vai a uma coluna, como no lab", () => {
    assert.match(
      semComentario,
      /@media \(max-width: 760px\) \{\s*\.cs-v2 \.v2-scanner \.result-grid \{\s*grid-template-columns: 1fr;\s*\}\s*\}/,
      "styles.css:2760-2889 — o lab deita a `.result-grid` para uma coluna abaixo de 760px",
    );
  });

  test("nada de radar inventado: sem regra, sem marcação, sem rótulo de demo", () => {
    assert.equal(semComentario.includes(".scan-radar"), false, "o lab não tem CSS para o radar; nada é inventado aqui");
    assert.equal(codigo.includes("scan-radar"), false, "e a página não leva marcação sem fonte visual");
    assert.equal(/ANÁLISE DEMO|demo/i.test(codigo), false, "nenhum rótulo de demonstração do lab entra no produto");
  });

  test("contratos do Scanner não foram tocados por esta entrega", () => {
    for (const agulha of [
      "scanSession",
      "cancelButtonState",
      "createFolderConfirmationGate",
      "folderSelectionFromPath",
      "generation",
    ]) {
      assert.ok(pagina.includes(agulha), `faltou ${agulha} — a apresentação não pode levar o controlador`);
    }
    assert.match(pagina, /<ScanPhaseList/);
    assert.match(pagina, /<ScanEngineState engineHealth=\{engineHealth\} serviceConnected=\{serviceConnected\} \/>/);
  });
});
