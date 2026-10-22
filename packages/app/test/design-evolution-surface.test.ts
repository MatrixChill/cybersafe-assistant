import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * TP-QA-02 (17/10) — eixo de SUPERFÍCIE (material) nos helpers REAIS.
 *
 * Cobre o que o teste do componente `GlassSurface` (glass-material.test.ts) não
 * cobre: o estado/persistência do acabamento, do lado do produto (`appearance.ts`).
 * Não é GUI: são funções puras + um `localStorage`/`document` falsificados para
 * observar o contrato. Não espelha strings arbitrárias — importa os símbolos e
 * usa os valores que o próprio módulo exporta.
 */

// Storage falsificável: a aparênc ia lê/escreve por `localStorage` em runtime.
type Store = Map<string, string>;
let backing: Store;
let throwOnGet: boolean;
let throwOnSet: boolean;

function installFakeStorage(): void {
  backing = new Map<string, string>();
  throwOnGet = false;
  throwOnSet = false;
  (globalThis as Record<string, unknown>).localStorage = {
    getItem(key: string) {
      if (throwOnGet) throw new Error("storage bloqueado");
      return backing.has(key) ? (backing.get(key) as string) : null;
    },
    setItem(key: string, value: string) {
      if (throwOnSet) throw new Error("quota cheia");
      backing.set(key, value);
    },
    removeItem(key: string) {
      backing.delete(key);
    },
  };
}

// `document` mínimo para `applyAppearance` (classList + setAttribute), observado.
const appliedAttrs: Record<string, string> = {};
const toggledClasses: Array<[string, boolean]> = [];
function installFakeDocument(): void {
  for (const k of Object.keys(appliedAttrs)) delete appliedAttrs[k];
  toggledClasses.length = 0;
  (globalThis as Record<string, unknown>).document = {
    documentElement: {
      classList: {
        toggle(name: string, force: boolean) {
          toggledClasses.push([name, force]);
          return force;
        },
      },
      setAttribute(name: string, value: string) {
        appliedAttrs[name] = value;
      },
    },
  };
}

const appearance = await import("../src/lib/appearance");
const {
  DEFAULT_SURFACE,
  SURFACE_LABELS,
  isSurfaceStyle,
  loadSurface,
  readAppearance,
  applyAppearance,
  writeAppearance,
  APPARANCE_SURFACE_KEY,
} = appearance;

beforeEach(() => {
  installFakeStorage();
  installFakeDocument();
});

describe("surface — vocabulário e rótulos (valores do próprio módulo)", () => {
  it("só aceita os três materiais efetivos; rejeita nomes de outro eixo", () => {
    for (const value of ["solid", "glass", "reduced"]) {
      assert.equal(isSurfaceStyle(value), true, value);
    }
    // "liquid"/"showcase" são do componente GlassSurface, NÃO deste eixo.
    for (const value of ["liquid", "showcase", "showcase-glare", "", "Glas", 42, null, undefined, {}]) {
      assert.equal(isSurfaceStyle(value), false, JSON.stringify(value));
    }
  });

  it("o valor por omissão é 'glass' e pertence ao conjunto válido", () => {
    assert.equal(DEFAULT_SURFACE, "glass");
    assert.equal(isSurfaceStyle(DEFAULT_SURFACE), true);
  });

  it("os rótulos cobrem cada material e mostram PT-PT, nunca o id interno", () => {
    const keys = Object.keys(SURFACE_LABELS).sort();
    assert.deepEqual(keys, ["glass", "reduced", "solid"].sort());
    for (const [id, label] of Object.entries(SURFACE_LABELS)) {
      assert.notEqual(label, id, `rótulo igual ao id interno (${id})`);
      assert.equal(typeof label, "string");
      assert.ok(label.length > 0);
    }
  });
});

describe("surface — loadSurface: resolução e fallback", () => {
  it("sem valor guardado devolve o por omissão (glass)", () => {
    assert.equal(loadSurface(), DEFAULT_SURFACE);
  });

  it("respeita cada material válido persistido sob a chave do produto", () => {
    for (const value of ["solid", "glass", "reduced"]) {
      installFakeStorage();
      backing.set(APPARANCE_SURFACE_KEY, value);
      assert.equal(loadSurface(), value);
    }
  });

  it("valor inválido não é ignorado: resolve para o por omissão", () => {
    backing.set(APPARANCE_SURFACE_KEY, "liquid");
    assert.equal(loadSurface(), DEFAULT_SURFACE);
  });

  it("storage que LANÇA no arranque não rebenta: cai no por omissão", () => {
    throwOnGet = true;
    assert.equal(loadSurface(), DEFAULT_SURFACE);
  });
});

describe("surface — readAppearance inclui o eixo de superfície", () => {
  it("lê o material persistido junto dos outros eixos", () => {
    backing.set(APPARANCE_SURFACE_KEY, "solid");
    const state = readAppearance();
    assert.equal(state.surface, "solid");
    assert.ok("theme" in state && "identity" in state && "accent" in state);
  });
});

describe("surface — aplicar e persistir (com honestidade sobre a escrita)", () => {
  const full = {
    theme: "dark" as const,
    identity: "cybersafe-core" as const,
    accent: "cyan" as const,
    surface: "reduced" as const,
  };

  it("applyAppearance escreve data-surface e NAO substitui className do <html>", () => {
    applyAppearance(full);
    assert.equal(appliedAttrs["data-surface"], "reduced");
    assert.equal(appliedAttrs["data-theme"], "cybersafe-core");
    assert.equal(appliedAttrs["data-accent"], "cyan");
    // O modo entra por classList (toggle), nunca por className = theme.
    assert.deepEqual(toggledClasses, [
      ["dark", true],
      ["light", false],
    ]);
  });

  it("writeAppearance devolve true quando ficou gravado", () => {
    assert.equal(writeAppearance(full), true);
    assert.equal(backing.get(APPARANCE_SURFACE_KEY), "reduced");
  });

  it("storage que falha a escrita: aplica nesta sessão mas devolve false (nunca afirma persistência)", () => {
    throwOnSet = true;
    const persisted = writeAppearance(full);
    assert.equal(persisted, false, "não se pode afirmar persistência sobre uma escrita que falhou");
    // Ainda assim a app funciona nesta sessão: o material foi aplicado ao DOM.
    assert.equal(appliedAttrs["data-surface"], "reduced");
  });
});
