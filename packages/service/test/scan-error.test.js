import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTransientFsError, TRANSIENT_SCAN_ERROR_WINDOW_MS } from "../dist/scan-error.js";

/**
 * O scan-on-arrival do serviço reagia a entradas do watcher que não são
 * ficheiros de leitura válidos: junctions/reparse points (Documents\Meus Vídeos)
 * e ficheiros temporários voláteis. O resultado era "Scan error EPERM" com stack
 * trace no arranque. Estes erros são esperados e têm de ser classificados como
 * transitórios (tolerados + agregados), sem silenciar erros reais.
 */
describe("scan transient filesystem errors", () => {
  it("classifica EPERM/ENOENT/EACCES/EBUSY/EISDIR como esperados", () => {
    for (const code of ["EPERM", "ENOENT", "EACCES", "EBUSY", "EISDIR"]) {
      assert.equal(isTransientFsError({ code }), true, code + " deve ser transitório");
    }
  });

  it("não classifica erros desconhecidos como transitórios", () => {
    assert.equal(isTransientFsError({ code: "EIO" }), false);
    assert.equal(isTransientFsError(new Error("boom")), false);
    assert.equal(isTransientFsError(null), false);
    assert.equal(isTransientFsError(undefined), false);
  });

  it("expõe uma janela de agregação positiva", () => {
    assert.ok(TRANSIENT_SCAN_ERROR_WINDOW_MS > 0);
  });
});
