import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COMMIT,
  DIGESTO,
  UPDATER_FILE,
  aRenderizar,
  aplicarBloco,
  lerPins,
  urlPinning,
} from "../yara-pin.mjs";

/**
 * A ferramenta de revisão tem de ser tão verificável como o que revê: estes casos
 * são todos offline (a rede pertence a `--check`/`--propose`/`--write`), e o que
 * afirmam é que o bloco de pin se lê, escreve e volta a ler sem derivação, que o
 * URL construído é o do commit, e que as âncoras não se adivinham.
 */

const MEDIDA = {
  id: "a.yar", repo: "d/p", file: "rules/a.yar",
  revision: "1edbe8e0ddc32dc47b76e370beb51db16c07f487",
  sha256: "1ba3175cebe28fc5d4d25c1caf604beda152766db268a3f159e4bf61c2eddf54",
  ruleClass: "production",
};

describe("ferramenta de pin YARA", () => {
  it("o URL da fonte é sempre o do commit, nunca uma branch", () => {
    const url = urlPinning(MEDIDA.repo, MEDIDA.revision, MEDIDA.file);
    assert.equal(url, `https://raw.githubusercontent.com/d/p/${MEDIDA.revision}/rules/a.yar`);
    assert.equal(/\/(master|main|develop)\//.test(url), false);
  });

  it("escrever e reler é idempotente", () => {
    const código = ["antes", "/* yara:pinned-sources:inicio */", "export const YARA_PIN = [];", "/* yara:pinned-sources:fim */", "depois"].join("\n");
    const aplicado = aplicarBloco(código, [MEDIDA]);
    assert.deepEqual(lerPins(aplicado), [{
      id: MEDIDA.id, repo: MEDIDA.repo, file: MEDIDA.file,
      revision: MEDIDA.revision, sha256: MEDIDA.sha256, ruleClass: MEDIDA.ruleClass,
    }]);
    assert.ok(aplicado.startsWith("antes\n") && aplicado.endsWith("/* yara:pinned-sources:fim */\ndepois"), "o resto do ficheiro não é tocado");
    assert.equal(aplicarBloco(aplicado, [MEDIDA]), aplicado, "segunda aplicação não altera nada");
  });

  it("sem âncoras não se escreve nada", () => {
    assert.throws(() => aplicarBloco("export const x = 1;", [MEDIDA]), /âncoras/);
  });

  it("só aceita commit e digesto bem formados, e o bloco vazio lê-se como vazio", () => {
    assert.match(MEDIDA.revision, COMMIT);
    assert.match(MEDIDA.sha256, DIGESTO);
    assert.equal(COMMIT.test("deadbeef"), false);
    assert.equal(DIGESTO.test("deadbeef"), false);
    assert.deepEqual(lerPins("nada"), []);
    assert.match(aRenderizar([]), /YARA_PIN: Array<[\s\S]*= \[\r?\n\];/);
  });

  it("o alvo da ferramenta é o updater do serviço, não um ficheiro paralelo", () => {
    assert.ok(UPDATER_FILE.replaceAll("\\", "/").endsWith("packages/service/src/updater.ts"), UPDATER_FILE);
  });
});
