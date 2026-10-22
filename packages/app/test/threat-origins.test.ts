import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { classifyThreatOrigin } from "../src/lib/threatOrigins";

/**
 * As estatísticas "Origens Web / Origens Locais" da página Ameaças deixavam
 * de fora as ameaças do Scanner (source "system-scanner") e do serviço
 * ("service") — o scanner diz "Revisa na página Ameaças" e a ameaça não
 * contava em nenhum dos dois cartões. Fonte dos valores: ThreatEvent["source"]
 * em shared-types (union fechada).
 */
describe("classifyThreatOrigin — Local vs Web", () => {
  test("extensão é Web", () => {
    assert.equal(classifyThreatOrigin("extension"), "web");
  });

  test("scanner, serviço, dashboard e download-monitor são Locais", () => {
    assert.equal(classifyThreatOrigin("system-scanner"), "local");
    assert.equal(classifyThreatOrigin("service"), "local");
    assert.equal(classifyThreatOrigin("dashboard"), "local");
    assert.equal(classifyThreatOrigin("download-monitor"), "local");
  });

  test("fonte desconhecida não é contada como local nem web", () => {
    assert.equal(classifyThreatOrigin("bogus-source"), null);
    assert.equal(classifyThreatOrigin(undefined), null);
  });
});
