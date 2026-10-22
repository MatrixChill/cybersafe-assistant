import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * EIXO DE SUPERFÍCIE (11/10/2026) — o segundo eixo do tema.
 *
 * A queixa do utilizador era "o tema não é global" e "o Liquid não é vidro".
 * As duas causas eram diferentes e este teste fecha as duas:
 *   1. o acabamento das superfícies não tinha controlo nenhum — era decidido
 *      por regra dentro de cada bloco de identidade, e o `backdrop-filter` dos
 *      cartões tinha sido removido por custo medido;
 *   2. o tema base só se escolhia numa página.
 *
 * O que se verifica aqui é o Mecanismo (chave, atributo no <html>, valor por
 * omissão defensivo, controlo global), porque é isso que permite ao utilizador
 * ligar e desligar o vidro sem editar CSS.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => fs.readFileSync(path.join(HERE, ...parts), "utf8");

const css = read("..", "src", "index.css");
/** O CSS sem comentários: as invariantes abaixo falam de DECLARAÇÕES, e as
    notas do ficheiro citam por nome justamente o que está proibido. */
const decls = css.replace(/\/\*[\s\S]*?\*\//g, "");
const app = read("..", "src", "App.tsx");
const sidebar = read("..", "src", "components", "Sidebar.tsx");
const settings = read("..", "src", "pages", "SettingsPage.tsx");
const ctx = read("..", "src", "contexts", "AppearanceContext.tsx");
const mainTsx = read("..", "src", "main.tsx");

// ── módulo puro, com localStorage/document stubs (sem DOM nem Electron) ──
type Store = Record<string, string>;
function withStorage(store: Store, run: () => void): void {
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
  };
  run();
}

type Element = { attributes: Record<string, string>; classes: Set<string> };
const element: Element = { attributes: {}, classes: new Set(["dark"]) };
const html = {
  attributes: element.attributes,
  classes: element.classes,
  className: "",
  setAttribute(name: string, value: string) { element.attributes[name] = value; },
  getAttribute(name: string) { return element.attributes[name] ?? null; },
  classList: {
    toggle(name: string, on: boolean) {
      if (on) element.classes.add(name); else element.classes.delete(name);
      html.className = [...element.classes].join(" ");
      return on;
    },
  },
};
(globalThis as Record<string, unknown>).document = { documentElement: html };

const {
  DEFAULT_SURFACE,
  IDENTITY_LABELS,
  IDENTITY_ORDER,
  LEGACY_ACCENT_KEY,
  applyAppearance,
  isSurfaceStyle,
  loadAccent,
  loadSurface,
  writeAppearance,
} = await import("../src/lib/appearance");

describe("eixo de superfície — o valor é sempre um dos três", () => {
  test("sem chave gravada, o valor é o valor por omissão", () => {
    withStorage({}, () => {
      assert.equal(loadSurface(), DEFAULT_SURFACE);
      assert.equal(DEFAULT_SURFACE, "glass");
    });
  });

  test("valor inválido ou corrompido nunca chega ao CSS", () => {
    for (const bogus of ["vidro", "", "GLASS", "blur(999px)", "constructor"]) {
      withStorage({ cybersafe_surface: bogus }, () => {
        assert.equal(loadSurface(), DEFAULT_SURFACE, `"${bogus}" não pode chegar ao atributo`);
      });
    }
    for (const valid of ["solid", "glass", "reduced"]) {
      assert.equal(isSurfaceStyle(valid), true, `${valid} tem de ser um valor do eixo`);
    }
  });

  test("o arranque aplica os dois eixos no <html> antes do React", () => {
    const store: Store = { cybersafe_surface: "solid", cybersafe_theme: "matrix-terminal" };
    withStorage(store, () => applyAppearance());
    assert.equal(html.attributes["data-surface"], "solid", "data-surface no arranque");
    assert.equal(html.attributes["data-theme"], "matrix-terminal", "data-theme no arranque");
    // main.tsx chama applyAppearance antes de createRoot — sem isto, o primeiro
    // frame apanhava o valor por omissão e o utilizador via um flash de estilo.
    assert.ok(
      mainTsx.indexOf("applyAppearance()") < mainTsx.indexOf("createRoot("),
      "applyAppearance tem de correr antes de createRoot",
    );
  });

  test("o contexto delega no módulo (um só sítio a tocar o <html>)", () => {
    assert.match(ctx, /writeAppearance\(\{ theme, identity, accent, surface \}\)/);
    assert.equal(/documentElement\.className\s*=/.test(ctx), false, "atribuição a className apaga classes alheias");
    assert.equal(/localStorage\./.test(ctx), false, "o contexto não fala diretamente com o Storage");
  });

  test("F8: o modo entra por classList e não por className", () => {
    const store: Store = { theme: "light" };
    element.classes.add("alguma-classe-de-outra-parte");
    withStorage(store, () => applyAppearance({ theme: "light", identity: "cybersafe-core", accent: "cyan", surface: "glass" }));
    assert.ok(element.classes.has("alguma-classe-de-outra-parte"), "classes independentas têm de sobreviver");
    assert.equal(element.classes.has("dark"), false, "sair do escuro tira só `dark`");
    assert.equal(element.classes.has("light"), true);
    withStorage({ theme: "dark" }, () => applyAppearance({ theme: "dark", identity: "cybersafe-core", accent: "cyan", surface: "glass" }));
    assert.equal(element.classes.has("light"), false);
    assert.equal(element.classes.has("dark"), true);
  });

  test("F5: o destaque escolhido volta igual no arranque seguinte", () => {
    // O bug: a migração "blue"→"cyan" corria SEMPRE, por isso escolher Azul
    // dava Ciano ao reabrir. A migração passou a ser só do registo legado.
    for (const accent of ["cyan", "matrix-green", "blue", "purple", "pink", "amber", "red-wine"]) {
      const store: Store = { cybersafe_accent: accent };
      withStorage(store, () => {
        assert.equal(loadAccent(), accent, `escolha atual "${accent}" tem de sobreviver ao reload`);
      });
    }
    // Herança: quem ficou no registo antigo com "blue" continua a migrar.
    withStorage({ [LEGACY_ACCENT_KEY]: "blue" }, () => assert.equal(loadAccent(), "cyan"));
    withStorage({ [LEGACY_ACCENT_KEY]: "pink" }, () => assert.equal(loadAccent(), "pink"));
    withStorage({}, () => assert.equal(loadAccent(), "cyan", "sem registo decide o valor por omissão"));
  });

  test("F7: Storage que lança não derruba a app", () => {
    const exploding = {
      getItem() { throw new Error("SecurityError"); },
      setItem() { throw new Error("QuotaExceededError"); },
      removeItem() { throw new Error("SecurityError"); },
    };
    (globalThis as Record<string, unknown>).localStorage = exploding;
    assert.doesNotThrow(() => loadAccent(), "ler um destaque não pode abortar o arranque");
    assert.doesNotThrow(() => loadSurface());
    assert.doesNotThrow(() => applyAppearance({ theme: "dark", identity: "cybersafe-liquid", accent: "cyan", surface: "glass" }));
    // Escrita que falha é devolvida como falha — nunca como sucesso.
    assert.equal(
      writeAppearance({ theme: "dark", identity: "cybersafe-liquid", accent: "cyan", surface: "glass" }),
      false,
      "persistência best-effort não pode afirmar que guardou",
    );
    // E os valores por omissão continuam a decidir a leitura.
    assert.equal(loadSurface(), DEFAULT_SURFACE);
  });
});

describe("eixo de superfície — os três acabamentos existem em CSS", () => {
  const body = (selector: string) => {
    const idx = decls.indexOf(`${selector} {`);
    assert.ok(idx >= 0, `falta a regra \`${selector}\``);
    return decls.slice(idx, decls.indexOf("}", idx));
  };

  test("vidro borra; reduzido e sólido não borram; sem atributo também não", () => {
    assert.match(body('[data-surface="glass"]'), /blur\(\d+px\)/);
    assert.match(body('[data-surface="reduced"]'), /--surface-filter: none/);
    assert.match(body('[data-surface="solid"]'), /--surface-filter: none/);
    // O valor de reserva do eixo vive num bloco :root próprio (o :root dos
    // tokens do shell não tem nada a ver com este eixo).
    assert.match(decls, /:root \{\s*--surface-filter: none;/);
  });

  test("o vidro só se aplica a superficies elevadas, nunca a `.cyber-border`", () => {
    const inicio = decls.indexOf('[data-surface="glass"] .surface-elevated');
    assert.ok(inicio >= 0, "falta a lista de superficies elevadas");
    const lista = decls.slice(inicio, decls.indexOf("{", inicio));
    for (const alvo of [".surface-elevated", ".sidebar-surface", ".hero-banner", ".stat-card", ".auth-card"]) {
      assert.ok(lista.includes(alvo), `falta ${alvo} na lista de superficies elevadas`);
    }
    assert.equal(lista.includes(".cyber-border"), false, "~90 instâncias por ecrã — é o congelador medido");
  });

  test("sólido é opaco de facto, não apenas sem desfoque", () => {
    const inicio = decls.indexOf('[data-surface="solid"].dark .cyber-border');
    assert.ok(inicio >= 0, "falta o achatamento opaco do modo sólido");
    const seletores = decls
      .slice(inicio, decls.indexOf("{", inicio))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    assert.ok(seletores.length >= 8, `esperava as variantes de modo, obtive ${seletores.length}`);
    // Cada seletor tem de nomear o modo. Os blocos por identidade valem 0-3-0
    // (`[data-theme=...].dark` / `:not(.dark)`); um seletor só com
    // `[data-surface="solid"]` perdia e o modo sólido deixaria transparência.
    for (const sel of seletores) {
      assert.match(sel, /\.dark|:not\(\.dark\)/, `seletor sólido sem variante de modo: ${sel}`);
    }
    assert.match(decls.slice(inicio, decls.indexOf("}", inicio) + 1), /background-color: var\(--background\)/);
  });

  test("reduzido e sólido desligam o desfoque do Tailwind também", () => {
    // O markup usa `backdrop-blur-*` em páginas que não pertencem a este eixo;
    // sem este travão ficava desfoque residual, que é exatamente o que o modo
    // promete que não há.
    assert.match(
      decls,
      /\[data-surface="solid"\] \*:not\(\[data-surface-preview\]\)[\s\S]{0,260}backdrop-filter: none !important/,
    );
  });

  test("movimento reduzido aligera sem remover o modo escolhido", () => {
    const dentro = decls.slice(decls.indexOf("@media (prefers-reduced-motion: reduce)"));
    assert.match(dentro, /\[data-surface="glass"\] \{ --surface-filter: blur\((\d+)px\)/);
    const raio = Number(/\[data-surface="glass"\] \{ --surface-filter: blur\((\d+)px\)/.exec(dentro)?.[1]);
    const normal = Number(/\[data-surface="glass"\] \{ --surface-filter: blur\((\d+)px\)/.exec(decls)?.[1]);
    assert.ok(raio <= normal, `reduzido (${raio}px) não pode ser mais caro que o normal (${normal}px)`);
  });

  // ── Guarda semântico do desfoque (TP-MATERIAL-GUARD) ──────────────────────
  // A POSIÇÃO deixou de ser o critério: o eixo por-elemento `data-material`
  // declara `backdrop-filter` legitimamente antes da âncora do eixo global, e
  // contar declarações antes da âncora era frágil. O que se verifica é o par
  // EXATO seletor→valor. A posição de cada declaração vem do `match.index` do
  // próprio match (nunca `indexOf` de um texto que se repete) e o bloco
  // envolvente é resolvido por pilha de chavetas (robusto a `@media`).
  //
  // Allowlist ESTRITA — nada de isenções genéricas por atributo: um seletor que
  // não conste aqui é violação, mesmo com valor `none`; um blur literal nunca é
  // sancionado (o desfoque só entra por `var(--surface-filter)`, para seguir o
  // travão de movimento reduzido e a preferência global).
  const DESFOQUE_SANCIONADO: Array<{ seletores: string[]; valores: string[] }> = [
    { seletores: ['[data-material="solid"]'], valores: ["none"] },
    { seletores: ['[data-material="reduced"]'], valores: ["none"] },
    { seletores: ['[data-material="glass"]', '[data-material="liquid"]'], valores: ["var(--surface-filter)"] },
    { seletores: ['[data-material="showcase"]'], valores: ["none"] },
    { seletores: ['[data-pause-visual=""]'], valores: ["none", "none !important"] },
    {
      seletores: [
        '[data-surface="glass"] .surface-elevated',
        '[data-surface="glass"] .sidebar-surface',
        '[data-surface="glass"] .hero-banner',
        '[data-surface="glass"] .stat-card',
        '[data-surface="glass"] .auth-card',
      ],
      valores: ["var(--surface-filter)"],
    },
    {
      seletores: [
        '[data-surface="reduced"] *:not([data-surface-preview])',
        '[data-surface="reduced"] *::before',
        '[data-surface="reduced"] *::after',
        '[data-surface="solid"] *:not([data-surface-preview])',
        '[data-surface="solid"] *::before',
        '[data-surface="solid"] *::after',
      ],
      valores: ["none !important"],
    },
  ];

  function violacoesDeDesfoque(fonte: string): string[] {
    const blocos: Array<{ abre: number; fecha: number }> = [];
    const pilha: number[] = [];
    for (let i = 0; i < fonte.length; i++) {
      if (fonte[i] === "{") pilha.push(i);
      else if (fonte[i] === "}") {
        const abre = pilha.pop();
        if (abre !== undefined) blocos.push({ abre, fecha: i });
      }
    }
    const seletorDe = (pos: number): string => {
      let abre = -1;
      for (const b of blocos) if (b.abre < pos && pos < b.fecha && b.abre > abre) abre = b.abre;
      if (abre < 0) return "";
      const fronteira = Math.max(fonte.lastIndexOf("}", abre - 1), fonte.lastIndexOf("{", abre - 1));
      return fonte.slice(fronteira + 1, abre).replace(/\s+/g, " ").trim();
    };
    const violacoes: string[] = [];
    for (const m of fonte.matchAll(/(-webkit-)?backdrop-filter:([^;]+);/g)) {
      const valor = m[2].trim().replace(/\s+/g, " ");
      const seletores = seletorDe(m.index ?? 0).split(",").map((s) => s.trim()).filter(Boolean);
      const motivos: string[] = [];
      for (const sel of seletores) {
        const grupo = DESFOQUE_SANCIONADO.find((g) => g.seletores.includes(sel));
        if (!grupo) motivos.push(`seletor não sancionado: ${sel}`);
        else if (!grupo.valores.includes(valor)) motivos.push(`valor não sancionado: ${sel} → ${valor}`);
      }
      if (/blur\(/.test(valor)) motivos.push(`blur literal fora do token: ${valor}`);
      if (motivos.length) violacoes.push(`${seletores.join(", ") || "(sem seletor)"} — ${motivos.join(" | ")}`);
    }
    return violacoes;
  }

  test("controlo: só seletores sancionados declaram desfoque (zero fora do sistema)", () => {
    const fora = violacoesDeDesfoque(decls);
    assert.equal(fora.length, 0, `desfoque fora do sistema:\n${fora.join("\n")}`);
  });

  test("controlo: o scanner vê as declarações do ficheiro e o vidro pelo token", () => {
    // Sem isto, um scanner que não visse nada passava sempre.
    const total = [...decls.matchAll(/(-webkit-)?backdrop-filter:[^;]+;/g)].length;
    assert.ok(total >= 14, `o scanner tem de ver as declarações do ficheiro, viu ${total}`);
    assert.match(
      decls,
      /\[data-material="glass"\],\s*\[data-material="liquid"\] \{\s*background: var\(--surface-translucent\);\s*backdrop-filter: var\(--surface-filter\);/,
    );
  });

  test("controlo: mutações fora do sistema são apanhadas (8 famílias, em memória)", () => {
    const mutacoes: Array<[string, string]> = [
      ["identidade com blur", decls.replace(
        '[data-theme="cybersafe-liquid"] .cyber-border {',
        '[data-theme="cybersafe-liquid"] .cyber-border {\n  backdrop-filter: blur(18px);',
      )],
      ["classe arbitrária", `${decls}\n.arbitrary-evil { backdrop-filter: blur(9px); }\n`],
      ["material inventado", `${decls}\n[data-material="bogus"] { backdrop-filter: blur(9px); }\n`],
      ["sólido com blur", `${decls}\n[data-material="solid"] { backdrop-filter: blur(9px); }\n`],
      ["reduzido com blur", `${decls}\n[data-material="reduced"] { backdrop-filter: blur(9px); }\n`],
      ["showcase com blur", `${decls}\n[data-material="showcase"] { backdrop-filter: blur(9px); }\n`],
      ["descendente de material conhecido com o token", `${decls}\n[data-material="glass"] .evil-descendant { backdrop-filter: var(--surface-filter); }\n`],
      ["vidro sem o token", decls.replace("backdrop-filter: var(--surface-filter);", "backdrop-filter: none;")],
    ];
    for (const [nome, mutado] of mutacoes) {
      assert.notEqual(mutado, decls, `a mutação "${nome}" tem de alterar o texto em memória`);
      assert.equal(violacoesDeDesfoque(mutado).length, 1, `não detetou: ${nome}`);
    }
  });

  test("F10: as superficies deste scope não afinam texto com alfa", () => {
    // O risco do glass é a luminância do fundo variar por trás da tinta. Nas
    // superficies que aqui se controlam o texto fica nos tokens do tema
    // (`--foreground`, `--muted-foreground`, `--sidebar-foreground`) e nenhum
    // opacity de cor vem atenuá-lo.
    for (const [nome, fonte] of [["Sidebar", sidebar], ["SettingsPage", settings], ["App", app]] as const) {
      const alfa = [...fonte.matchAll(/text-(?:muted-)?foreground\/(\d+)/g)].map((m) => Number(m[1]));
      const fracas = alfa.filter((v) => v < 70);
      assert.equal(fracas.length, 0, `${nome}: texto atenuado por alfa (${fracas.join(",")}%)`);
    }
  });

  test("F2: nenhuma regra de modo claro fica sem âncora no <html>", () => {
    // `:not(.dark)` a só é um seletor de descendente: num caminho
    // html.dark > body > div, o body e o div também não têm `.dark`, logo
    // casava e as regras «de modo claro» aplicavam-se no escuro — com
    // `!important`, dava fundo claro a máscaras de escurecimento.
    for (const m of decls.matchAll(/(^|,|\{|\n)\s*(:not\(\.dark\))/g)) {
      assert.fail(`seletor sem âncora: ${m[2]} em ${decls.slice(m.index ?? 0, (m.index ?? 0) + 60)}`);
    }
    assert.match(decls, /:root:not\(\.dark\) \[class\*="bg-black/);
  });

  test("F3: não há color-mix com três cores (a gramática só aceita duas)", () => {
    // `color-mix(in oklch, A 5%, B 58%, transparent)` é inválido e o browser
    // descarta a DECLARAÇÃO inteira — com `!important` incluído. A sidebar e o
    // hero do Líquido tinham justamente isto e ficavam sem preenchimento.
    const mixes = [...decls.matchAll(/color-mix\(/g)];
    assert.ok(mixes.length > 20, `o parser tem de ver os color-mix do ficheiro, viu ${mixes.length}`);
    for (const m of mixes) {
      let i = (m.index ?? 0) + "color-mix(".length;
      let profundidade = 1;
      let virgulas = 0;
      while (i < decls.length && profundidade > 0) {
        const c = decls[i];
        if (c === "(") profundidade++;
        else if (c === ")") profundidade--;
        else if (c === "," && profundidade === 1) virgulas++;
        i++;
      }
      // `in <espaço>, cor, cor` = 2 vírgulas ao nível próprio.
      assert.ok(virgulas <= 2, `color-mix com ${virgulas} vírgulas: ${decls.slice(m.index ?? 0, i).slice(0, 110)}`);
    }
  });

  test("F9: cada identidade tem uma só regra de hero por modo", () => {
    const seletores = [...decls.matchAll(/^[^@}\n]*\.hero-banner(?![\w-])[^{\n]*\{/gm)].map((m) => m[0].trim());
    const porAssinatura = new Map<string, number>();
    for (const s of seletores) {
      const chave = s.replace(/\s+/g, " ");
      porAssinatura.set(chave, (porAssinatura.get(chave) ?? 0) + 1);
    }
    for (const [chave, n] of porAssinatura) {
      assert.equal(n, 1, `regra duplicada de .hero-banner (${n}x): ${chave}`);
    }
    assert.ok(seletores.length >= 5, `esperava as regras de hero por identidade, obtive ${seletores.length}`);
  });

  test("F1: a barra lateral está ligada ao eixo, sem repor as regras .sidebar", () => {
    // A política é explícita: uma classe nova, só para o acabamento. Repor
    // `.sidebar` ativaria de uma vez os fundos e gradientes de Core, Líquido e
    // Belbete que estiveram sempre dormentes e nunca foram medidos.
    assert.match(sidebar, /"sidebar-surface /);
    assert.match(decls, /\[data-surface="glass"\] \.sidebar-surface/);
    assert.match(decls, /\[data-surface="solid"\]\.dark \.sidebar-surface/);
  });

  test("F2 ponte: os bg-black das páginas lêem o token de superfície rebaixada", () => {
    assert.match(decls, /--surface-sunken:/);
    assert.match(decls, /\.surface-sunken \{[^}]*background: var\(--surface-sunken\)/);
  });

  test("não há regras de superfície dormentes por identidade", () => {
    // `.sidebar`, `.liquid-panel` e `.glass-panel` não eram usadas por elemento
    // nenhum — era código morto, com desfoque caro lá dentro, que confundia a
    // leitura do que o tema realmente faz.
    assert.equal(/\[data-theme=[^\]]*\] \.sidebar(?![\w-])/.test(decls), false, "regras .sidebar por identidade");
    assert.equal(/\.liquid-panel/.test(decls), false, ".liquid-panel sem consumidor");
    assert.equal(/\.glass-panel/.test(decls), false, ".glass-panel sem consumidor");
    assert.equal(/height: 38%/.test(decls), false, "a película por cima do conteúdo");
  });
});

describe("tema base — controlo global", () => {
  test("as cinco identidades têm rótulo PT-PT e ordem fixa", () => {
    assert.deepEqual([...IDENTITY_ORDER], [
      "cybersafe-core", "cybersafe-neon", "matrix-terminal", "cybersafe-liquid", "cybersafe-red-belbete",
    ]);
    for (const id of IDENTITY_ORDER) {
      assert.ok(IDENTITY_LABELS[id], `${id} precisa de rótulo`);
      assert.doesNotMatch(IDENTITY_LABELS[id], /CyberSafe|Matrix Terminal|Red Belbete/, "o id interno não é o rótulo");
    }
  });

  test("a barra lateral reserva-se à navegação e não expõe personalização", () => {
    assert.match(sidebar, /sidebar-surface/, "a barra mantém a superfície do eixo");
    assert.doesNotMatch(sidebar, /useAppearance\s*\(/);
    assert.doesNotMatch(sidebar, /aria-label="Tema base"/);
    const props = sidebar.match(/interface SidebarProps\s*\{([\s\S]*?)\}/)?.[1];
    assert.ok(props, "contrato de props da Sidebar presente");
    assert.doesNotMatch(props, /\b(theme|accent|identity|surface|mode|onIdentityChange|onThemeChange|onAccentChange)\b/);
  });

  test("as Configurações ligam os controlos ao contexto real de aparência", () => {
    assert.match(settings, /useAppearance\s*\(/);
    assert.match(settings, /onClick=\{\(\) => setIdentity\(option\.id\)\}/);
    assert.match(settings, /onClick=\{\(\) => setSurface\(option\.id\)\}/);
    assert.match(settings, /onClick=\{\(\) => setAccent\(option\.id\)\}/);
    assert.match(settings, /from "\.\.\/lib\/appearance"/);
  });
  test("as Configurações explicam os dois eixos, em PT-PT", () => {
    assert.match(settings, /Tema base/);
    // R3-E: o grupo passou a chamar-se «Material da interface», que é o nome
    // que o produto usa na comparação ao vivo. O eixo não mudou.
    assert.match(settings, /Material da interface/);
    assert.match(settings, /Cor de destaque/);
    assert.doesNotMatch(settings, /DESTQUE/, "comentário com gralha");
    // O bug real da barra de acento: uma classe do Tailwind ia para var().
    assert.doesNotMatch(settings, /var\(\$\{option\.swatch/, "var() de uma classe não é uma cor");
    assert.match(settings, /var\(\$\{option\.token\}\)/);
    assert.doesNotMatch(settings, /text-primary-absolute/, "classe inventada");
    assert.doesNotMatch(settings, /glass UI|blur suave|cards sólidos/, "jargão em copy do utilizador");
  });

  test("o fundo ambiente tem uma só fonte de realces", () => {
    assert.match(css, /^\.liquid-bg \{/m);
    // As três camadas fixas do App duplicavam os radiais de `.liquid-bg`.
    assert.equal(/isLiquid && \(\s*<>/.test(app), false, "camadas de fundo duplicadas no App");
  });
});
