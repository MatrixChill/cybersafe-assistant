import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * FASE C — Liquid glass convincente.
 * O bug-raiz era um seletor morto: `[data-theme="cybersafe-liquid"].liquid-bg`
 * exigia atributo e classe no MESMO elemento (o atributo vive no <html>, a
 * classe no wrapper) — a regra nunca aplicou e o fundo Liquid era o plano
 * acinzentado. E as superfícies escuras eram branco 2-4% sobre fundo 10%:
 * indistinguíveis. Este teste fecha as duas portas.
 */
const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

function ruleFor(selector: string): string {
  const idx = css.indexOf(`${selector} {`);
  assert.ok(idx >= 0, `ficheiro CSS nao tem a regra \`${selector}\``);
  const end = css.indexOf("}", idx);
  return css.slice(idx, end);
}

describe("Liquid — o fundo ambiente aplica de facto", () => {
  test("a classe vive sozinha em .liquid-bg (sem exigir data-theme no mesmo elemento)", () => {
    assert.match(css, /^\.liquid-bg \{/m, "regra base .liquid-bg existe");
    assert.match(css, /^\.dark \.liquid-bg \{/m, "variante escura via descendente .dark");
    assert.doesNotMatch(css, /\[data-theme="cybersafe-liquid"\]\.liquid-bg/, "o seletor composto morto nao regressa");
  });

  test("o fundo tem TINTA do tema (primary/cyan/purple), nao so cinza", () => {
    const dark = ruleFor(".dark .liquid-bg");
    for (const token of ["var(--primary)", "var(--cyber-cyan)", "var(--cyber-purple)"]) {
      assert.ok(dark.includes(token), `fundo escuro usa ${token}`);
    }
  });
});

describe("Liquid — superficies de vidro distinguiveis", () => {
  test("stat-card escuro: preenchimento com tinta, borda com primary e profundidade", () => {
    const rule = ruleFor('[data-theme="cybersafe-liquid"].dark .stat-card');
    assert.ok(rule.includes("var(--primary)"), "o vidro escuro e tingido pelo tema, nao branco neutro");
    assert.ok(rule.includes("box-shadow"), "ha sombra — profundidade entre superficies");
    assert.ok(rule.includes("inset 0 1px 0"), "ha highlight interior de vidro");
    assert.doesNotMatch(rule, /oklch\(1 0 0 \/ 0\.0[24]\)(?!,)/, "nada de branco 2-4% como preenchimento unico");
  });

  test("cyber-border escuro idem", () => {
    const rule = ruleFor('[data-theme="cybersafe-liquid"].dark .cyber-border');
    assert.ok(rule.includes("var(--primary)"));
    assert.ok(rule.includes("box-shadow"));
  });

  test("light: bordas usam foreground, nao branco sobre branco", () => {
    const rule = ruleFor('[data-theme="cybersafe-liquid"] .stat-card');
    assert.ok(rule.includes("var(--foreground)"), "borda visivel no modo claro");
    assert.ok(rule.includes("box-shadow"));
  });

  test("o desfoque não vem dos blocos de identidade: vive só no eixo de superfície", () => {
    // FIX freeze (2026-10-09, revisto 2026-10-11): o que congelava a máquina era
    // um passe de backdrop-filter POR CADA .cyber-border (~90 instâncias por
    // ecrã). Isso mantém-se proibido — nas superficies repetidas o vidro continua
    // a vir do enchimento + borda + sombra. O que mudou em 11/10/2026 é que o
    // desfoque voltou a existir, mas como escolha explícita do utilizador
    // (data-surface=glass) e declarado num único sítio: os blocos por identidade
    // não o podem ligar contra a vontade do modo.
    const stat = ruleFor('[data-theme="cybersafe-liquid"].dark .stat-card');
    const border = ruleFor('[data-theme="cybersafe-liquid"].dark .cyber-border');
    assert.doesNotMatch(stat, /backdrop-filter/, "stat-card nao faz backdrop-filter");
    assert.doesNotMatch(border, /backdrop-filter/, "cyber-border nao faz backdrop-filter");

    const semComentarios = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const permitidos = new Set([
      '[data-material="glass"]', '[data-material="liquid"]',
      ...["surface-elevated", "sidebar-surface", "hero-banner", "stat-card", "auth-card", "app-titlebar"]
        .map((name) => '[data-surface="glass"] .' + name),
    ]);
    const verificarDesfoque = (style: string) => {
      const seletoresAtivos: string[] = [];
      for (const block of style.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
        const ativos = [...block[2].matchAll(/(?:^|;)\s*(?:-webkit-)?backdrop-filter\s*:\s*([^;]+);/gm)]
          .filter((d) => d[1].trim().replace(/\s*!important$/, "") !== "none");
        if (ativos.length) seletoresAtivos.push(...block[1].split(",").map((s) => s.trim()));
      }
      assert.ok(seletoresAtivos.length >= 2, "o eixo e os materiais opt-in mantêm o vidro");
      for (const seletor of seletoresAtivos) {
        assert.ok(permitidos.has(seletor), "desfoque fora das superfícies opt-in: " + seletor);
      }
    };
    verificarDesfoque(semComentarios);
    assert.throws(() => verificarDesfoque(semComentarios + '\n[data-theme="cybersafe-liquid"] * { backdrop-filter: blur(4px); }'),
      /desfoque fora/, "o blur universal continua proibido");
    assert.throws(() => verificarDesfoque(semComentarios + '\n.cyber-border { backdrop-filter: blur(4px); }'),
      /desfoque fora/, "cartões repetidos não ganham blur");
    // O teto medido mantém-se: até 20px de raio; acima disso é custo sem ganho.
    const filtros = [...semComentarios.matchAll(/--surface-filter:\s*([^;]+);/g)].map((m) => m[1]);
    const raios = filtros
      .map((f) => Number(/blur\((\d+)px\)/.exec(f)?.[1] ?? 0))
      .filter((r) => r > 0);
    assert.ok(raios.length >= 2, `esperava raio no modo vidro e no de movimento reduzido, obtive ${raios.join(",")}`);
    assert.ok(Math.max(...raios) <= 20, `blur até 20px; obtive ${Math.max(...raios)}px`);
  });
});
