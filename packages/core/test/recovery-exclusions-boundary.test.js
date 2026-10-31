import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ExclusionManager } from "../dist/exclusions.js";

// D7 (RECOVERY-SECURITY 2026-10-14): a exclusão por caminho era um
// `startsWith` cru, sem fronteira de segmento. Excluir "C:\exroot" excluía
// também "C:\exrootbar" (um irmão com o mesmo prefixo textual). Estes testes
// fixam a fronteira: igual ou descendente exclui; irmão NÃO exclui.
describe("ExclusionManager path boundary (D7)", () => {
  const root = process.platform === "win32" ? "C:\\exroot" : "/exroot";
  const sibling = root + "bar";
  const mgr = new ExclusionManager({ paths: [root], extensions: [], files: [] });

  test("o caminho exato é excluído", () => {
    assert.equal(mgr.isExcluded(root), true);
  });

  test("descendente do caminho excluído é excluído", () => {
    assert.equal(mgr.isExcluded(path.join(root, "sub", "a.bin")), true);
    assert.equal(mgr.isExcluded(path.join(root, "a.bin")), true);
  });

  test("irmão com o mesmo prefixo textual NÃO é excluído (fronteira)", () => {
    assert.equal(mgr.isExcluded(sibling), false);
    assert.equal(mgr.isExcluded(path.join(sibling, "evil.exe")), false);
  });

  test("reason e category concordam com isExcluded na fronteira", () => {
    assert.equal(mgr.exclusionReason(path.join(sibling, "evil.exe")), null);
    assert.equal(mgr.exclusionCategory(path.join(sibling, "evil.exe")), null);
    assert.notEqual(mgr.exclusionReason(path.join(root, "sub", "a.bin")), null);
    assert.deepEqual(mgr.exclusionCategory(path.join(root, "sub", "a.bin")), { reason: "path" });
  });

  test("mesma fronteira para exclusões de ficheiro exato (não prefixo)", () => {
    const fileMgr = new ExclusionManager({ paths: [], extensions: [], files: ["notes.txt"] });
    assert.equal(fileMgr.isExcluded(path.join(os_home(), "notes.txt")), true);
    assert.equal(fileMgr.isExcluded(path.join(os_home(), "notes.txt.bak2")), false);
  });
});

function os_home() {
  // Evita import extra: usa o mesmo homedir que o módulo usa por omissão.
  return process.env.USERPROFILE || process.env.HOME || "";
}
