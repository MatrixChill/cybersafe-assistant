import { test } from "node:test";
import assert from "node:assert/strict";
import { ClamavBridge } from "../dist/clamav.js";
import { ExclusionManager } from "../dist/exclusions.js";

/**
 * A exclusão do fixture do probe NÃO pode depender do nome.
 *
 * Um ficheiro do utilizador chamado `cybersafe-clamav-load-probe-*.txt` numa
 * pasta monitorizada tem de continuar a ser analisado. Só o caminho exato que
 * a bridge criou e ainda não removeu é ignorado — e essa decisão vive na
 * bridge, não numa regra global de nomes.
 */
test("ficheiro do utilizador com nome parecido continua a ser analisado", () => {
  const userFile = "C:/Users/caioc/Downloads/cybersafe-clamav-load-probe-deadbeef.txt";
  const exclusions = new ExclusionManager();
  assert.equal(exclusions.isExcluded(userFile), false, "nome parecido não pode ser exclusão global");
  const bridge = new ClamavBridge({});
  assert.equal(bridge.isProbeArtifact(userFile), false, "sem probe em voo, nada é o fixture");
});

test("só o caminho registado pela bridge é reconhecido como fixture", () => {
  const bridge = new ClamavBridge({});
  assert.equal(bridge.isProbeArtifact(""), false);
  assert.equal(bridge.isProbeArtifact("C:/Temp/outro.txt"), false);
});
