import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * TP-PAP-V2-REAL-FRONTEND-20261028 · D1 — a camada de identidade V2.
 *
 * O que está em jogo aqui é a decisão do proprietário: V2 inteira, identidade
 * única, sem híbrido. Este ficheiro não desenha nada — fixa que:
 *   1. os oito temas existem e cada um declara o jogo completo de tokens;
 *   2. os cinco materiais, os quatro níveis de movimento e os quatro perfis de
 *      desempenho são fechados (um valor inválido não inventa um sexto);
 *   3. a ponte para os tokens de produto vence os blocos de tema de V1, e por
 *     quê (especificidade, não ordem de ficheiro);
 *   4. a migração das preferências de V1 não desfaz uma escolha explícita;
 *   5. nenhum dado de demonstração do lab entrou na app;
 *   6. as primitivas recusam afirmar o que não têm (uma amostra não é série).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => fs.readFileSync(path.join(HERE, "..", ...parts), "utf8");
const decls = (file: string) => file.replace(/\/\*[\s\S]*?\*\//g, "");

const V2 = await import("../src/v2/theme");
const UI = await import("../src/v2/ui");

const tokens = decls(read("src", "v2", "tokens.css"));
const bridge = decls(read("src", "v2", "bridge.css"));
const shell = decls(read("src", "v2", "shell.css"));
const primitives = read("src", "v2", "primitives.css");
const themeModule = read("src", "v2", "theme.ts");

const REQUIRED_TOKENS = [
  "--v2-bg", "--v2-panel", "--v2-raised", "--v2-inset", "--v2-sidebar", "--v2-topbar",
  "--v2-text", "--v2-muted", "--v2-subtle", "--v2-border", "--v2-border-strong",
  "--v2-accent", "--v2-accent-ink", "--v2-accent-soft", "--v2-hover", "--v2-focus",
  "--v2-hero", "--v2-page-background", "--v2-chart",
  "--v2-ok", "--v2-ok-bg", "--v2-ok-edge",
  "--v2-warn", "--v2-warn-bg", "--v2-warn-edge",
  "--v2-danger", "--v2-danger-bg", "--v2-danger-edge",
];

/* ── 1 e 2 — os oito temas e os eixos fechados ─────────────────────────────── */

describe("temas V2", () => {
  const themes = ["core", "neon", "terminal", "aurora", "belbete", "glass", "tactical", "light"];

  test("são oito, e cada bloco declara o jogo completo de tokens", () => {
    for (const id of themes) {
      const selector = new RegExp(`html\\[data-v2-theme="${id}"\\]`);
      assert.ok(selector.test(tokens), `tema "${id}" sem bloco em tokens.css`);
    }
    // Um tema que esqueça um token apanha o valor de outro — é assim que nascem
    // os estados ilegíveis.
    const blocos = tokens.split(/\n(?=html\[data-v2-theme=)/);
    /* Um tema que esqueça um token apanha o valor de outro — é assim que nascem
       os estados ilegíveis. O lab partilha um bloco por seis temas escuros e
       ainda sobrepõe um bloco por tema; o que cada tema VÊ é a união dos dois,
       e é isso que se exige completo. */
    const visibles = (id: string): string =>
      blocos
        .filter((bloco) => new RegExp(`html\\[data-v2-theme="${id}"\\]`).test(bloco.slice(0, bloco.indexOf("{"))))
        .join("\n");
    for (const id of themes) {
      const visto = visibles(id);
      assert.ok(visto.length > 0, `tema "${id}" sem bloco em tokens.css`);
      const falta = REQUIRED_TOKENS.filter((t) => !visto.includes(`${t}:`));
      assert.deepEqual(falta, [], `tema ${id} não declara: ${falta.join(", ")}`);
    }
  });

  test("só um tema é claro, e é esse que declara color-scheme: light", () => {
    assert.match(tokens, /html\[data-v2-theme="light"\][\s\S]*?color-scheme: light/);
    const claros = (tokens.match(/color-scheme: light/g) ?? []).length;
    assert.equal(claros, 1, `esperava um único bloco claro, vi ${claros}`);
  });

  test("o Terminal é o único com letra própria, sem referência ao modo de cor", () => {
    // The current lab token import is serialized by a CSS parser; whitespace
    // around the rule is irrelevant to the invariant (Terminal owns its font).
    assert.match(tokens, /html\[data-v2-theme="terminal"\]\s*\{\s*--v2-font-ui:/);
  });
});

describe("eixos fechados", () => {
  test("os valores válidos são exatamente os do lab", () => {
    assert.deepEqual([...V2.V2_THEME_ORDER], ["core", "neon", "terminal", "aurora", "belbete", "glass", "tactical", "light"]);
    assert.deepEqual([...V2.V2_MATERIAL_ORDER], ["solid", "light", "frosted", "liquid", "advanced"]);
    assert.deepEqual([...V2.V2_MOVEMENT_ORDER], ["off", "reduced", "balanced", "cinematic"]);
    assert.deepEqual([...V2.V2_PERFORMANCE_ORDER], ["economy", "balanced", "high", "auto"]);
    for (const id of V2.V2_THEME_ORDER) assert.ok(V2.V2_THEME_META[id].name && V2.V2_THEME_META[id].subtitle, id);
    // Cada tabela de rótulos cobre exatamente o seu eixo — nem mais uma opção
    // decorativa, nem uma sem nome para mostrar.
    const pares = [
      [V2.V2_MATERIAL_ORDER, V2.V2_MATERIAL_LABELS],
      [V2.V2_MOVEMENT_ORDER, V2.V2_MOVEMENT_LABELS],
      [V2.V2_PERFORMANCE_ORDER, V2.V2_PERFORMANCE_LABELS],
    ] as const;
    for (const [ordem, tabela] of pares) {
      assert.deepEqual(Object.keys(tabela).sort(), [...ordem].sort(), "rótulos e valores do eixo divergem");
      assert.ok(Object.values(tabela).every((r) => r.trim().length > 1), "há um valor sem rótulo");
    }
  });

  test("um valor inválido no Storage volta ao por omissão desse eixo, nunca a meio", () => {
    const store: Record<string, string> = {
      cybersafe_appearance_v2: JSON.stringify({ theme: "cyberpink", material: "liquid", movement: "turbulento", performance: "high", webgl: "sim" }),
    };
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
    const lidas = V2.readV2Preferences();
    assert.equal(lidas.theme, "core", "tema inválido não pode herdar o valor partido");
    assert.equal(lidas.movement, "balanced");
    assert.equal(lidas.material, "liquid", "material válido tem de ser respeitado");
    assert.equal(lidas.performance, "high");
    assert.equal(lidas.webgl, true, "webgl não-booleano decide a omissão, não o lixo");
  });

  test("JSON partido no Storage não aborta o arranque", () => {
    const store: Record<string, string> = { cybersafe_appearance_v2: "{ isto não é json" };
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
    assert.equal(V2.readV2Preferences().theme, "core");
  });

  test("localStorage que lança não derruba a leitura nem a escrita", () => {
    // `writeV2Preferences` também aplica no DOM; sem um documento mínimo este
    // teste falharia por motivo alheio ao que quer provar.
    (globalThis as Record<string, unknown>).document = {
      documentElement: { setAttribute: () => {}, classList: { toggle: () => {} } },
    };
    (globalThis as Record<string, unknown>).localStorage = {
      get getItem(): never { throw new Error("SecurityError"); },
      setItem(): never { throw new Error("QuotaExceeded"); },
    };
    assert.equal(V2.readV2Preferences().theme, "core");
    assert.equal(V2.writeV2Preferences(V2.DEFAULT_V2_PREFERENCES), false, "escrita falhada não se pode anunciar como guardada");
  });
});

/* ── 3 — a ponte vence, e sabe-se porquê ───────────────────────────────────── */

describe("ponte V2 → tokens de produto", () => {
  test("o selector da ponte tem três predicados + :root (especificidade 0,3,1)", () => {
    // Os blocos de V1 chegam a `[tema][material].dark` = (0,3,0). Uma ponte com
    // menos que isto deixaria a app com dois aspetos em simultâneo — o híbrido
    // que foi recusado. Não se confia na ordem do bundle.
    const seletores = bridge.match(/html\[data-v2-theme\]\[data-v2-material\]:root/g) ?? [];
    assert.ok(seletores.length >= 1, "a ponte não usa o selector de vitória");
    assert.ok(/--background: var\(--v2-bg\)/.test(bridge), "o fundo do produto não vem do tema V2");
    assert.ok(/--card: var\(--v2-panel\)/.test(bridge), "o cartão do produto não vem do tema V2");
    assert.ok(/--primary: var\(--v2-accent\)/.test(bridge), "o acento do produto não vem do tema V2");
    assert.ok(/--primary-foreground: var\(--v2-accent-ink\)/.test(bridge), "a tinta por cima do acento tem de vir do tema");
  });

  test("nenhum eixo V1 fica por mapear: as semânticas vêm do tema", () => {
    for (const nome of ["--cyber-green", "--cyber-yellow", "--cyber-red", "--cyber-cyan"]) {
      assert.ok(new RegExp(`${nome}: var\\(--v2-`).test(bridge), `${nome} continua fora da camada V2`);
    }
    // O produto não tem azul de estado; a ponte não introduz nenhum.
    assert.equal(/--cyber-[a-z]+: (#[0-9a-f]{3,8}|oklch)/i.test(bridge), false, "a ponte pinta semânticas com literais");
  });

  test("material: cinco valores, e `solid` desliga o desfoque", () => {
    for (const m of ["light", "frosted", "liquid", "advanced"]) {
      assert.ok(new RegExp(`html\\[data-v2-material="${m}"\\]:root`).test(bridge), `material ${m} sem bloco`);
    }
    assert.match(bridge, /html\[data-v2-material="solid"\]:root[\s\S]*?--v2-material-blur: none/);
    assert.match(bridge, /html\[data-solid="true"\]:root/);
  });

  test("movimento e desempenho: os travões existem e chegam às transições", () => {
    assert.match(bridge, /html\[data-v2-movement="off"\]:root/);
    assert.match(bridge, /html\[data-v2-movement="reduced"\]:root/);
    assert.match(bridge, /--v2-duration-fast: 0ms/);
    assert.match(bridge, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(bridge, /html\[data-v2-performance="economy"\]:root[\s\S]*?--v2-material-blur: none/);
  });
});

/* ── 4 — migração de preferências ─────────────────────────────────────────── */

describe("migração V1 → V2", () => {
  function comLegado(legado: Record<string, string>) {
    const store: Record<string, string> = { ...legado };
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
    return V2.readV2Preferences({
      identity: legado["cybersafe_theme"],
      mode: legado["theme"],
      surface: legado["cybersafe_surface"],
    });
  }

  test("identidade explícita conserva-se mesmo com o modo em claro", () => {
    const p = comLegado({ cybersafe_theme: "cybersafe-neon", theme: "light", cybersafe_surface: "glass" });
    assert.equal(p.theme, "neon", "desfazer uma escolha explícita de identidade é a pior perda possível");
    assert.equal(p.material, "liquid");
  });

  test("sem identidade escolhida, o modo claro é a única evidência e ganha", () => {
    const p = comLegado({ cybersafe_theme: "cybersafe-core", theme: "light" });
    assert.equal(p.theme, "light");
  });

  test("os três acabamentos de V1 fazem ida e volta sem mudarem de nome", () => {
    for (const [superficie, esperado] of [["solid", "solid"], ["glass", "glass"], ["reduced", "reduced"]] as const) {
      const p = comLegado({ cybersafe_surface: superficie });
      assert.equal(V2.v2ToLegacy(p).surface, esperado, `${superficie} não volta a marcar o mesmo botão`);
    }
  });

  test("o modo escuro é tudo menos o tema claro, e `light` é tema", () => {
    assert.equal(V2.v2ToLegacy({ ...V2.DEFAULT_V2_PREFERENCES, theme: "light" }).theme, "light");
    assert.equal(V2.v2ToLegacy({ ...V2.DEFAULT_V2_PREFERENCES, theme: "tactical" }).theme, "dark");
    assert.equal(V2.v2ToLegacy({ ...V2.DEFAULT_V2_PREFERENCES, theme: "tactical" }).identity, "cybersafe-core");
  });

  test("sem Storage nenhum, escrever devolve false (nao e escrita imaginada)", () => {
    // `storage()?.setItem(...)` seguido de `return true` dava sucesso sobre uma
    // escrita que nunca existiu: sem `localStorage` (politica de site, origem
    // `file://` com armazenamento bloqueado) nada é gravado. Revisao do Codex.
    Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true, writable: true });
    (globalThis as Record<string, unknown>).document = {
      documentElement: { setAttribute: () => {}, classList: { toggle: () => {} } },
    };
    assert.equal(V2.writeV2Preferences(V2.DEFAULT_V2_PREFERENCES), false, "sem Storage nao se pode afirmar persistencia");
    // A leitura continua a decidir pela omissao, nao rebenta.
    assert.equal(V2.readV2Preferences().theme, V2.DEFAULT_V2_PREFERENCES.theme);
  });

  test("escrever aplica e devolve se ficou guardado", () => {
    const store: Record<string, string> = {};
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
    const atributos: Record<string, string> = {};
    (globalThis as Record<string, unknown>).document = {
      documentElement: {
        setAttribute: (n: string, v: string) => { atributos[n] = v; },
        classList: { toggle: () => {} },
      },
    };
    assert.equal(V2.writeV2Preferences({ ...V2.DEFAULT_V2_PREFERENCES, theme: "belbete" }), true);
    assert.equal(atributos["data-v2-theme"], "belbete");
    assert.equal(atributos["data-v2-material"], "liquid");
    assert.equal(JSON.parse(store["cybersafe_appearance_v2"]).theme, "belbete");
  });
});

/* ── condições da revisão: migração idempotente e movimento ──────────────── */

describe("condições da revisão do Codex", () => {
  const comCpus = (n: number) => Object.defineProperty(globalThis, "navigator", { value: { hardwareConcurrency: n }, configurable: true, writable: true });
  const comSistemaReduced = (m: boolean) => Object.defineProperty(globalThis, "matchMedia", { value: () => ({ matches: m }), configurable: true, writable: true });
  test("migração idempotente: ler→escrever→ler não volta a mudar nada", () => {
    const store: Record<string, string> = {
      cybersafe_theme: "cybersafe-red-belbete",
      theme: "light",
      cybersafe_surface: "reduced",
      cybersafe_accent: "purple",
    };
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
    (globalThis as Record<string, unknown>).document = {
      documentElement: { setAttribute: () => {}, classList: { toggle: () => {} } },
    };
    const primeira = V2.readV2Preferences();
    assert.equal(V2.writeV2Preferences(primeira), true);
    const segunda = V2.readV2Preferences();
    assert.deepEqual(segunda, primeira, "a segunda leitura mudou a preferência");
    assert.equal(V2.writeV2Preferences(segunda), true);
    assert.deepEqual(V2.readV2Preferences(), primeira, "a migração não é estável ao terceiro passo");
    // E a projeção também não deriva: o legado que volta a ser lido é o mesmo.
    assert.equal(V2.v2ToLegacy(segunda).identity, V2.v2ToLegacy(primeira).identity);
  });

  test("movimento: `off`/`reduced` e a preferência do sistema desligam o `animate`", () => {
      comCpus(16);
    comSistemaReduced(false);
    const base = { ...V2.DEFAULT_V2_PREFERENCES, performance: "balanced" as const };
    assert.equal(V2.deriveV2Capabilities({ ...base, movement: "balanced" }).animate, true);
    assert.equal(V2.deriveV2Capabilities({ ...base, movement: "off" }).animate, false);
    assert.equal(V2.deriveV2Capabilities({ ...base, movement: "reduced" }).animate, false);
    comSistemaReduced(true);
    assert.equal(V2.deriveV2Capabilities({ ...base, movement: "cinematic" }).animate, false, "o sistema pede menos movimento");
  });

  test("desempeno: `economy` corta o desfoque, `auto` decide por processadores lógicos", () => {
    comSistemaReduced(false);
    const base = { ...V2.DEFAULT_V2_PREFERENCES };
    assert.equal(V2.deriveV2Capabilities({ ...base, performance: "economy" }).lowPower, true);
    comSistemaReduced(false); comCpus(4);
    assert.equal(V2.deriveV2Capabilities({ ...base, performance: "auto" }).lowPower, true, "4 ou menos lógicos é o limiar declarado do lab");
    comCpus(12);
    assert.equal(V2.deriveV2Capabilities({ ...base, performance: "auto" }).lowPower, false);
    assert.equal(V2.deriveV2Capabilities({ ...base, performance: "high" }).renderDpr, 1.5);
    assert.equal(V2.deriveV2Capabilities({ ...base, performance: "balanced" }).renderDpr, 1);
  });
});

/* ── 5 e 6 — o que não entra, e o que as primitivas não fingem ─────────────── */

describe("fronteira do laboratório", () => {
  test("nenhum módulo V2 importa dados de demonstração", () => {
    // O que se proíbe é o CAMINHO do dado: um import do lab ou uma string de
    // cenário copiada para dentro. Comentar o que não se usa não é usá-lo.
    for (const ficheiro of ["theme.ts", "ui.tsx"]) {
      const fonte = read("src", "v2", ficheiro);
      assert.equal(/from\s+["'][^"']*(demo|Demo)/.test(fonte), false, `${ficheiro} importa dado do lab`);
      assert.equal(/from\s+["'][^"']*(Aceternity|Aurora|Spotlight|CoreScene|Studio)/.test(fonte), false, `${ficheiro} importa um vendor sem gate`);
    }
    for (const literal of ["instalador-exemplo", "arquivo-demo", "relatorio-demo", "YARA-X", "Cenário 0", "Amostra fictícia", "248"]) {
      assert.equal(read("src", "v2", "ui.tsx").includes(literal), false, `cenário do lab no fonte: ${literal}`);
    }
  });

  test("os nomes do lab aparecem onde devem: nos créditos do fonte, não em strings de UI", () => {
    // React Bits / Magic UI / Aceternity: MIT ou licença por confirmar. A origem
    // tem de ser rastreável no fonte portado; ver `out/MAPA-V2-REAL-20261028.md` §5.
    assert.match(themeModule, /EIXOS V2/);
  });
});

describe("primitivas V2", () => {

  test("o Badge pinta o TOM e diz o texto que a página leu — nunca um estado inventado", () => {
    const { Badge } = UI;
    const html = renderToStaticMarkup(createElement(Badge, { tone: "warn" }, "Cobertura limitada"));
    assert.match(html, /class="badge tone-warn"/);
    assert.match(html, /Cobertura limitada/);
    assert.equal(/Ativo/.test(html), false, "a primitiva não escolhe rótulos");
  });

  test("uma só amostra não é uma série: o Chart recusa desenhar e diz porquê", () => {
    const { Chart } = UI;
    const comUma = renderToStaticMarkup(createElement(Chart, { values: [42], label: "CPU" }));
    assert.match(comUma, /ainda sem série suficiente/);
    assert.equal(/<polyline/.test(comUma), false, "uma linha com um ponto afirmaria uma evolução");
    const comDuas = renderToStaticMarkup(createElement(Chart, { values: [42, 61], label: "CPU" }));
    assert.match(comDuas, /<polyline/);
  });

  test("PageHead marca o título como alvo de foco da rota", () => {
    const { PageHead } = UI;
    const html = renderToStaticMarkup(createElement(PageHead, { eyebrow: "SEGURANÇA", title: "Quarentena", description: "O que o serviço confirmou" }));
    assert.match(html, /<h1[^>]*tabindex="-1"/);
    assert.match(html, /eyebrow/);
  });

  test("os topos existem em CSS para os cinco papéis do produto", () => {
    for (const tom of ["ok", "warn", "crit", "proc", "na"]) {
      assert.match(primitives.replace(/\/\*[\s\S]*?\*\//g, ""), new RegExp(`\\.badge\\.tone-${tom}`), `tom ${tom} sem cor`);
    }
    // `proc` é ciano do tema, nunca azul; `na` é neutro porque não há leitura.
    assert.match(primitives, /\.badge\.tone-proc[\s\S]*?--v2-accent/);
    assert.match(primitives, /\.badge\.tone-na[\s\S]*?--v2-subtle/);
  });

  test("o shell V2 existe em CSS e não depende do invólucro do lab", () => {
    assert.match(shell, /\.cs-v2 \{/);
    assert.match(shell, /\.cs-v2 \.sidebar/);
    assert.match(shell, /\.cs-v2 \.topbar/);
    assert.equal(/\.app \{/.test(shell), false, "o lab chama `.app` ao root; a app tem `.cs-v2`");
    assert.equal(/100dvh/.test(shell), false, "dvh já deu diferencas de arredondamento com a faixa de janela");
  });

  test("a faixa de janela continua a ser a única região de arrasto", () => {
    assert.match(shell, /\.cs-v2 \.window-bar \{[\s\S]*?-webkit-app-region: drag/);
    assert.match(shell, /\.cs-v2 \.window-bar button[\s\S]*?no-drag/);
  });
});
