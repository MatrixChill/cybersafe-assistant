/**
 * R7-L3 — GUARDAR RELATÓRIO EM PDF (helpers puros).
 *
 * `report-save.ts` é puro de propósito: `main.ts` é o único que
 * toca o disco, e só depois de `validateReportPath` aceitar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  ensurePdfExtension,
  validateReportPath,
  DEFAULT_REPORT_NAME,
} from "../src/report-save.ts";

describe("R7-L3 — ensurePdfExtension", () => {
  it("garante .pdf sem duplicar (qualquer caixa)", () => {
    assert.equal(ensurePdfExtension("Relatorio-CyberSafe"), "Relatorio-CyberSafe.pdf");
    assert.equal(ensurePdfExtension("rel.pdf"), "rel.pdf");
    assert.equal(ensurePdfExtension("rel.PDF"), "rel.PDF");
    assert.equal(ensurePdfExtension("  spaced  "), "spaced.pdf");
  });

  it("nome vazio fica com o nome sugerido por defeito", () => {
    assert.equal(ensurePdfExtension(""), DEFAULT_REPORT_NAME);
    assert.equal(ensurePdfExtension("   "), DEFAULT_REPORT_NAME);
  });
});

describe("R7-L3 — validateReportPath", () => {
  it("aceita o caminho absoluto com .pdf que o diálogo devolve", () => {
    const chosen = path.resolve("Relatorio-CyberSafe.pdf");
    assert.deepEqual(validateReportPath(chosen), { ok: true });
  });

  it("recusa relativo, vazio, sem extensão e com NUL", () => {
    assert.equal(validateReportPath("relatorio.pdf").ok, false);
    assert.equal(validateReportPath("").ok, false);
    assert.equal(validateReportPath("   ").ok, false);
    assert.equal(validateReportPath(path.resolve("relatorio.txt")).ok, false);
    assert.equal(validateReportPath(`${path.resolve("a")}\0b.pdf`).ok, false);
  });

  it("a recusa tem uma razão em português", () => {
    const rejection = validateReportPath("relatorio.pdf");
    assert.equal(rejection.ok, false);
    assert.equal(typeof rejection.error, "string");
    assert.ok(rejection.error.length > 0);
  });
});
