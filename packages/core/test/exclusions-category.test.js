import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ExclusionManager } from "../dist/exclusions.js";
import os from "node:os";
import path from "node:path";

/**
 * `exclusionCategory` é a mesma decisão de `isExcluded`, com o motivo agarrado.
 *
 * A UI explica ao utilizador PORQUE 137 ficheiros não foram analisados; se as
 * duas funções divergissem, o número e a explicação contradiziam-se no mesmo
 * ecrã. Este teste confronta-as numa matriz de entradas — incluindo as que
 * casam MAIS do que uma regra (a primeira regra que exclui tem de ser a que
 * classifica).
 */
describe("ExclusionManager.exclusionCategory concorda com isExcluded", () => {
  const mgr = new ExclusionManager({
    paths: [path.join(os.homedir(), ".cybersafe-service"), path.join(os.homedir(), "isolated-dir")],
    extensions: [".tmp", ".log"],
    files: ["desktop.ini"],
  });

  const matrix = [
    // [caminho, excluído?, categoria esperada]
    [path.join(os.homedir(), "Downloads", "instalador.exe"), false, null],
    [path.join(os.homedir(), "Documents", "notas.tmp"), true, "extension"],
    [path.join(os.homedir(), "Documents", "sessao.log"), true, "extension"],
    [path.join(os.homedir(), "Desktop", "desktop.ini"), true, "filename"],
    [path.join(os.homedir(), ".cybersafe-service", "logs", "service.log"), true, "path"],
    [path.join(os.homedir(), ".cybersafe-service", "notas.tmp"), true, "path"],
    [path.join(os.homedir(), "isolated-dir", "qualquer.txt"), true, "path"],
    // Extensão excluída DENTRO de caminho excluído: a primeira regra (caminho) ganha.
    [path.join(os.homedir(), "isolated-dir", "x.log"), true, "path"],
    ["", true, "path"],
  ];

  for (const [filePath, excluded, reason] of matrix) {
    test(`${filePath || "(caminho vazio)"} -> ${reason ?? "não excluído"}`, () => {
      const category = mgr.exclusionCategory(filePath);
      assert.equal(mgr.isExcluded(filePath), excluded, "isExcluded é a fonte de verdade");
      assert.equal(category?.reason ?? null, reason, "a categoria tem de contar a mesma história");
      if (category) {
        assert.equal(mgr.exclusionCategory(filePath) !== null, true);
        // Nunca sai um caminho do utilizador na categoria.
        if (category.reason === "path") {
          assert.equal(category.detail, undefined);
        }
      }
    });
  }

  test("o detalhe é o token real da política (não uma string inventada)", () => {
    assert.deepEqual(mgr.exclusionCategory(path.join(os.homedir(), "a", "b.tmp")), {
      reason: "extension",
      detail: ".tmp",
    });
    assert.deepEqual(mgr.exclusionCategory(path.join(os.homedir(), "a", "desktop.ini")), {
      reason: "filename",
      detail: "desktop.ini",
    });
  });
});
