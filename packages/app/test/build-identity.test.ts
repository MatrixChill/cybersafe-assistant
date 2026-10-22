import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { aboutIdentityLines, electronVersionFromUserAgent, formatBuildBadge, resolveIdentity, technicalInfoText, type BuildIdentity } from "../src/lib/buildIdentity";

/**
 * P0-7: a aplicacao passa a mostrar versao e build ID REAIS. Estas funcoes sao
 * o contrato copy; em ambiente sem carimbo (tsx/dev) NADA pode ser inventado —
 * os placeholders honestos sao o resultado esperado, nunca um numero falso.
 */
describe("buildIdentity — chip e Sobre (PT-PT, sem valores fingidos)", () => {
  const real: BuildIdentity = { version: "0.1.1", buildId: "20261016-094512", commit: "abc1234" };

  test("formatBuildBadge mostra versao e build separados por ponteiro", () => {
    assert.equal(formatBuildBadge(real), "v0.1.1 · build 20261016-094512");
  });

  test("aboutIdentityLines devolve Versao/Compilacao/Codigo com prefixo v", () => {
    const rows = aboutIdentityLines(real);
    assert.deepEqual(rows.map((r) => r.label), ["Versão", "Compilação", "Código (commit)"]);
    assert.equal(rows[0].value, "v0.1.1");
    assert.equal(rows[2].value, "abc1234");
  });

  test("sem carimbo de build: valores declarados, jamais inventados", () => {
    const i = resolveIdentity();
    assert.ok(i.version === "desconhecida" || /^\d+\.\d+\.\d+/.test(i.version), `versao declarada ou semantica: ${i.version}`);
    if (i.version === "desconhecida") {
      assert.equal(i.buildId, "desenvolvimento");
      assert.equal(i.commit, "desconhecido");
    }
  });

  test("badge nunca fica vazio nem com 'undefined'", () => {
    const s = formatBuildBadge(resolveIdentity());
    assert.ok(s.length > 0 && !s.includes("undefined") && !s.includes("null"));
  });

  test("electron do user-agent real; fora do Electron NAO inventa", () => {
    assert.equal(electronVersionFromUserAgent("Mozilla/5.0 (...) Chrome/126.0.0.0 Electron/32.1.2 Safari/537.36"), "32.1.2");
    assert.equal(electronVersionFromUserAgent("Mozilla/5.0 (Windows NT 10.0) Chrome/120"), "não aplicável");
  });

  test("texto tecnico para copiar: so identidade, sem caminhos pessoais", () => {
    const t = technicalInfoText(real, "32.1.2");
    assert.match(t, /CyberSafe Assistant v0\.1\.1/);
    assert.match(t, /Electron: 32\.1\.2/);
    assert.equal(/C:\\|Users|caioc/.test(t), false);
  });
});
