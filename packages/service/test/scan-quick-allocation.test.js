import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  QUICK_SCAN_BUDGET,
  allocateQuickScanCandidates,
} from "../dist/scan-manager.js";

/**
 * Regressão do defeito humano: Downloads enchia os 800 candidatos antes de
 * Desktop/Documents/Startup/Temp serem lidos. A distribuição é pura: testa-se
 * sem filesystem, sem motores e sem relógio.
 */
describe("quick scan — distribuição por raiz", () => {
  const downloads = Array.from({ length: 800 }, (_, i) => `C:\\Users\\x\\Downloads\\f${i}.exe`);
  const documents = Array.from({ length: 5 }, (_, i) => `C:\\Users\\x\\Documents\\d${i}.txt`);

  it("uma raiz grande não elimina as outras do orçamento", () => {
    const out = allocateQuickScanCandidates([downloads, [], [], documents, []], QUICK_SCAN_BUDGET);

    assert.equal(out.length, QUICK_SCAN_BUDGET);
    assert.equal(out.filter((p) => p.includes("Documents")).length, documents.length);
    assert.equal(new Set(out).size, out.length, "sem duplicados");
  });

  it("cada raiz não vazia contribui com pelo menos um candidato", () => {
    const raizes = [
      ["C:\\a\\1.exe", "C:\\a\\2.exe", "C:\\a\\3.exe"],
      ["C:\\b\\1.txt"],
      ["C:\\c\\1.ps1"],
      ["C:\\d\\1.doc"],
      ["C:\\e\\1.tmp"],
    ];
    const out = allocateQuickScanCandidates(raizes, 5);

    assert.equal(out.length, 5);
    for (const [indice, raiz] of raizes.entries()) {
      assert.ok(
        out.some((p) => raiz.includes(p)),
        `raiz ${indice} ficou sem representação`,
      );
    }
  });

  it("dentro de cada raiz, o risco vem primeiro", () => {
    const out = allocateQuickScanCandidates(
      [["C:\\x\\documento.txt", "C:\\x\\programa.exe", "C:\\x\\foto.jpg"]],
      2,
    );

    assert.equal(out[0], "C:\\x\\programa.exe");
    assert.equal(out.length, 2);
  });

  it("orçamento inválido devolve vazio e nunca inventa candidatos", () => {
    assert.deepEqual(allocateQuickScanCandidates([["C:\\x\\a.exe"]], 0), []);
    assert.deepEqual(allocateQuickScanCandidates([["C:\\x\\a.exe"]], -10), []);
    assert.deepEqual(allocateQuickScanCandidates([], 800), []);
  });
});

it('small budgets never exceed the cap, even when every root is populated', () => {
  assert.equal(allocateQuickScanCandidates([['C:/a'], ['C:/b'], ['C:/c']], 1).length, 1);
});
it('Windows path aliases cannot consume two selected slots', () => {
  const out = allocateQuickScanCandidates([['C:/Temp/A.exe'], ['c:/temp/a.exe']], 800);
  assert.equal(out.length, 1);
});
