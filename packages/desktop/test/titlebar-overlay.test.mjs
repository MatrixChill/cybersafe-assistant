import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TITLEBAR_OVERLAY,
  TITLEBAR_HEIGHT,
  TITLEBAR_HEIGHT_MAX,
  TITLEBAR_HEIGHT_MIN,
  applyTitleBarOverlay,
  normalizeTitleBarOverlayPayload,
  titleBarOverlayWindowOptions,
} from "../src/titlebar-overlay.ts";

/**
 * TITLEBAR (14/10) — a barra de janela premium no Windows.
 *
 * O que se protege aqui não é o desenho (isso é CSS), é o CONTRATO com o
 * Electron, porque é aí que uma alteração destas quebra em silêncio:
 *
 *   1. a faixa tem de caber na janela do produto (40–44 px) e o mesmo número
 *      tem de servir o pedido do renderer e as opções do `BrowserWindow` — dois
 *      valores diferentes dariam botões desalinhados ou conteúdo tapado;
 *   2. fora do Windows nada muda: a janela mantém o frame nativo (uma
 *      regressão em macOS/Linux não é detetável à vista no Windows);
 *   3. o payload do renderer é NÃO CONFÁVEL: uma cor inválida passada ao
 *      `setTitleBarOverlay` faz o Electron lançar dentro do handler de IPC;
 *   4. janela ausente/destruída/método em falta devolvem `{ ok: false }` sem
 *      lançar — a janela não pode deixar de funcionar por causa da cor da barra.
 */

describe("TITLEBAR — altura e valores por omissão", () => {
  test("a faixa cai na gama pedida (40–44 px) e os limites têm sentido", () => {
    assert.ok(TITLEBAR_HEIGHT >= 40 && TITLEBAR_HEIGHT <= 44, `altura fora da gama: ${TITLEBAR_HEIGHT}`);
    assert.ok(TITLEBAR_HEIGHT_MIN < TITLEBAR_HEIGHT && TITLEBAR_HEIGHT < TITLEBAR_HEIGHT_MAX);
    assert.match(DEFAULT_TITLEBAR_OVERLAY.color, /^#[0-9a-f]{6}$/i);
    assert.match(DEFAULT_TITLEBAR_OVERLAY.symbolColor, /^#[0-9a-f]{6}$/i);
  });
});

describe("TITLEBAR — payload do renderer", () => {
  test("aceita cores hex e usa a altura por omissão quando ela falta", () => {
    assert.deepEqual(
      normalizeTitleBarOverlayPayload({ color: "#0b0f14", symbolColor: "#eef4f6" }),
      { color: "#0b0f14", symbolColor: "#eef4f6", height: TITLEBAR_HEIGHT },
    );
  });

  test("aceita #RRGGBBAA e normaliza espaços", () => {
    assert.deepEqual(
      normalizeTitleBarOverlayPayload({ color: "  #0b0f14ff ", symbolColor: "#eef4f6", height: 40 }),
      { color: "#0b0f14ff", symbolColor: "#eef4f6", height: 40 },
    );
  });

  test("limita a altura ao intervalo e arredonda", () => {
    const heightOf = (height) =>
      normalizeTitleBarOverlayPayload({ color: "#000000", symbolColor: "#ffffff", height })?.height;
    assert.equal(heightOf(10), TITLEBAR_HEIGHT_MIN);
    assert.equal(heightOf(400), TITLEBAR_HEIGHT_MAX);
    assert.equal(heightOf(41.6), 42);
    assert.equal(heightOf(Number.NaN), TITLEBAR_HEIGHT);
    assert.equal(heightOf("48"), TITLEBAR_HEIGHT, "string não é altura");
  });

  test("recusa tudo o que não seja hex (o Electron lançaria com estes valores)", () => {
    const invalid = [
      { color: "red", symbolColor: "#ffffff" },
      { color: "#12345", symbolColor: "#ffffff" },
      { color: "#zzzzzz", symbolColor: "#ffffff" },
      { color: "", symbolColor: "#ffffff" },
      { color: "var(--background)", symbolColor: "#ffffff" },
      { color: "url(#x)", symbolColor: "#ffffff" },
      { color: "#000000", symbolColor: "oklch(0.2 0 0)" },
      { color: "#000000" },
      { symbolColor: "#ffffff" },
      {},
    ];
    for (const payload of invalid) {
      assert.equal(normalizeTitleBarOverlayPayload(payload), null, JSON.stringify(payload));
    }
    for (const payload of [null, undefined, "o que for", 42, []]) {
      assert.equal(normalizeTitleBarOverlayPayload(payload), null, String(payload));
    }
  });
});

describe("TITLEBAR — opções da janela", () => {
  test("Windows: frame escondido + overlay nativo na altura da faixa", () => {
    const options = titleBarOverlayWindowOptions("win32");
    assert.equal(options.titleBarStyle, "hidden");
    assert.deepEqual(options.titleBarOverlay, {
      color: DEFAULT_TITLEBAR_OVERLAY.color,
      symbolColor: DEFAULT_TITLEBAR_OVERLAY.symbolColor,
      height: TITLEBAR_HEIGHT,
    });
  });

  test("fora do Windows não se toca na janela", () => {
    for (const platform of ["darwin", "linux", "freebsd", ""]) {
      const options = titleBarOverlayWindowOptions(platform);
      assert.deepEqual(options, {}, platform);
      assert.equal("titleBarStyle" in options, false, platform);
      assert.equal("titleBarOverlay" in options, false, platform);
    }
  });
});

describe("TITLEBAR — aplicação do overlay na janela viva", () => {
  function fakeWindow() {
    const calls = [];
    return {
      calls,
      destroyed: false,
      setTitleBarOverlay(options) {
        calls.push(options);
      },
      isDestroyed() {
        return this.destroyed;
      },
    };
  }

  test("aplica e devolve ok:true no Windows", () => {
    const win = fakeWindow();
    const result = applyTitleBarOverlay(win, { color: "#101418", symbolColor: "#ffffff", height: 44 }, "win32");
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(win.calls, [{ color: "#101418", symbolColor: "#ffffff", height: 44 }]);
  });

  test("payload inválido: nada é chamado e não lança", () => {
    const win = fakeWindow();
    assert.deepEqual(applyTitleBarOverlay(win, { color: "banana", symbolColor: "#ffffff" }, "win32"), { ok: false });
    assert.equal(win.calls.length, 0);
  });

  test("janela ausente, destruída ou sem método: ok:false sem tocar em nada", () => {
    assert.deepEqual(applyTitleBarOverlay(null, { color: "#101418", symbolColor: "#ffffff" }, "win32"), { ok: false });
    assert.deepEqual(applyTitleBarOverlay(undefined, { color: "#101418", symbolColor: "#ffffff" }, "win32"), {
      ok: false,
    });

    const destroyed = fakeWindow();
    destroyed.destroyed = true;
    assert.deepEqual(applyTitleBarOverlay(destroyed, { color: "#101418", symbolColor: "#ffffff" }, "win32"), {
      ok: false,
    });
    assert.equal(destroyed.calls.length, 0);

    assert.deepEqual(
      applyTitleBarOverlay({ isDestroyed: () => false }, { color: "#101418", symbolColor: "#ffffff" }, "win32"),
      { ok: false },
    );
  });

  test("fora do Windows o overlay nunca é aplicado", () => {
    const win = fakeWindow();
    assert.deepEqual(applyTitleBarOverlay(win, { color: "#101418", symbolColor: "#ffffff" }, "darwin"), { ok: false });
    assert.equal(win.calls.length, 0);
  });

  test("erro do Electron não se propaga para o IPC", () => {
    const win = {
      isDestroyed: () => false,
      setTitleBarOverlay() {
        throw new Error("overlay rejeitado");
      },
    };
    assert.deepEqual(applyTitleBarOverlay(win, { color: "#101418", symbolColor: "#ffffff" }, "win32"), { ok: false });
  });
});
