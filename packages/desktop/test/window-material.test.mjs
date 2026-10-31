import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_BACKDROP_MATERIAL_BUILD,
  SOLID_FALLBACK_BACKGROUND,
  VALID_BACKGROUND_MATERIALS,
  isBackdropSupportedBuild,
  parseWindowsBuild,
  resolveWindowMaterial,
} from "../src/window-material.ts";

/**
 * TP-WIN-01 (17/10) — fundo nativo (DWM backdrop) da janela principal.
 *
 * O que se protege aqui é a GADANÇA de segurança/compatibilidade, não o efeito
 * visual (que não dá para provar sem GUI):
 *
 *   1. `transparent: true` NUNCA é emitido — a falha segura é o fundo sólido;
 *   2. o material só é ligado quando o SO o suporta. A fonte (electron.d.ts) é
 *      "Windows 11 22H2 and up" = build 22621. O Windows 11 21H2 (build 22000)
 *      fica no SÓLIDO, não no material (erro que o revisor apanhou);
 *   3. fora do Windows 11 (Windows 10, build ilegível) o resultado é sólido;
 *   4. nada de `backgroundMaterial` sem preferência explícita — o padrão do
 *      produto não muda por si;
 *   5. um `requested` fora da lista do Electron nunca vai para a janela.
 *
 * `applied` = "pedido + SO capaz", NÃO "o utilizador vê o backdrop". Isto não
 * prova runtime: uma superfície opaca do renderer pode ocultar o material, por
 * isso nenhum teste afirma observação visual.
 */

const RELEASE_22H2 = "10.0.22621";
const RELEASE_21H2 = "10.0.22000";
const RELEASE_NEW = "10.0.26100";
const RELEASE_WIN10 = "10.0.19045";
const RELEASE_WIN8 = "6.3.9600";

describe("window-material — parse da build", () => {
  test("lê major.minor.build do Windows", () => {
    assert.equal(parseWindowsBuild(RELEASE_NEW), 26100);
    assert.equal(parseWindowsBuild(RELEASE_22H2), 22621);
    assert.equal(parseWindowsBuild(RELEASE_21H2), 22000);
  });

  test("ilegível ou major < 10 devolve null (decisão segura: não suportado)", () => {
    assert.equal(parseWindowsBuild(RELEASE_WIN8), null, "Windows 8 não tem backdrop");
    assert.equal(parseWindowsBuild("não é versão"), null);
    assert.equal(parseWindowsBuild(""), null);
    assert.equal(parseWindowsBuild(null), null);
    assert.equal(parseWindowsBuild(undefined), null);
    assert.equal(parseWindowsBuild(42), null);
  });
});

describe("window-material — limiar 22H2 (22621), não 21H2 (22000)", () => {
  test("o floor é exatamente 22621", () => {
    assert.equal(MIN_BACKDROP_MATERIAL_BUILD, 22621);
    assert.equal(isBackdropSupportedBuild(22621), true);
    assert.equal(isBackdropSupportedBuild(22620), false);
    assert.equal(isBackdropSupportedBuild(22000), false, "21H2 NÃO suporta o backdrop");
    assert.equal(isBackdropSupportedBuild(26100), true);
    assert.equal(isBackdropSupportedBuild(null), false);
  });
});

describe("window-material — decisão", () => {
  test("Windows 11 22H2 com preferência: aplica o material", () => {
    for (const requested of ["auto", "mica", "acrylic", "tabbed"]) {
      const decision = resolveWindowMaterial({
        platform: "win32",
        osRelease: RELEASE_22H2,
        requested,
      });
      assert.equal(decision.reason, "applied", requested);
      assert.equal(decision.applied, requested);
      assert.equal(decision.options.backgroundMaterial, requested);
      assert.equal(decision.backdropSupported, true);
    }
  });

  test("21H2 (build 22000) com preferência: Fallback sólido, não material", () => {
    const decision = resolveWindowMaterial({
      platform: "win32",
      osRelease: RELEASE_21H2,
      requested: "mica",
    });
    assert.equal(decision.reason, "unsupported-build");
    assert.equal(decision.applied, null);
    assert.equal("backgroundMaterial" in decision.options, false);
    assert.equal(decision.options.backgroundColor, SOLID_FALLBACK_BACKGROUND);
  });

  test("Windows 10 e build ilegível: sólido", () => {
    for (const osRelease of [RELEASE_WIN10, "garbage", null]) {
      const decision = resolveWindowMaterial({ platform: "win32", osRelease, requested: "mica" });
      assert.equal(decision.reason, "unsupported-build", String(osRelease));
      assert.equal("backgroundMaterial" in decision.options, false);
    }
  });

  test("fora do Windows não se toca em nada", () => {
    for (const platform of ["darwin", "linux", "freebsd"]) {
      const decision = resolveWindowMaterial({ platform, osRelease: RELEASE_22H2, requested: "mica" });
      assert.equal(decision.reason, "not-win32", platform);
      assert.equal("backgroundMaterial" in decision.options, false);
    }
  });

  test("sem preferência / 'none' / valor inválido: sólido (o padrão não muda)", () => {
    const base = { platform: "win32", osRelease: RELEASE_NEW };
    assert.equal(resolveWindowMaterial({ ...base, requested: undefined }).reason, "no-preference");
    assert.equal(resolveWindowMaterial({ ...base, requested: null }).reason, "no-preference");
    assert.equal(resolveWindowMaterial({ ...base, requested: "none" }).reason, "explicitly-none");
    assert.equal(resolveWindowMaterial({ ...base, requested: "plasma" }).reason, "invalid-request");
    for (const requested of [undefined, null, "none", "plasma"]) {
      assert.equal("backgroundMaterial" in resolveWindowMaterial({ ...base, requested }).options, false, String(requested));
    }
  });
});

describe("window-material — invariantes de segurança", () => {
  const matrix = [];
  for (const platform of ["win32", "darwin", "linux"]) {
    for (const osRelease of [RELEASE_22H2, RELEASE_21H2, RELEASE_WIN10, "x", null]) {
      for (const requested of [...VALID_BACKGROUND_MATERIALS, "plasma", null, undefined]) {
        matrix.push({ platform, osRelease, requested });
      }
    }
  }

  test("NUNCA emite `transparent` em nenhuma combinação", () => {
    for (const input of matrix) {
      const decision = resolveWindowMaterial(input);
      assert.equal("transparent" in decision.options, false, JSON.stringify(input));
      assert.equal(decision.options.transparent, undefined, JSON.stringify(input));
    }
  });

  test("NUNCA emite material fora de win32 + 22H2+ + valor válido", () => {
    for (const input of matrix) {
      const decision = resolveWindowMaterial(input);
      const legit =
        input.platform === "win32" &&
        isBackdropSupportedBuild(parseWindowsBuild(input.osRelease)) &&
        VALID_BACKGROUND_MATERIALS.includes(input.requested) &&
        input.requested !== "none";
      assert.equal("backgroundMaterial" in decision.options, legit, JSON.stringify({ ...input, decision: decision.reason }));
    }
  });

  test("o fundo sólido é sempre presente e é um hex válido", () => {
    for (const input of matrix) {
      assert.match(resolveWindowMaterial(input).options.backgroundColor, /^#[0-9a-f]{6}$/i);
    }
  });
});
