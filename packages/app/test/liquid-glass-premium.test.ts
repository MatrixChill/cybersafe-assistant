import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * TP-LG-PREMIUM — o Líquido tem de se distinguir dos outros temas pelo MATERIAL,
 * não só pela cor. Este teste fecha o contrato do que foi acrescentado:
 *
 *  - um reflexo especular estático e um aro duplo (luz em cima, sombra em baixo)
 *    partilhados pelas superfícies do Líquido;
 *  - os três degraus do eixo deixam de diferir só no desfoque: Reduzido fica
 *    plano e Sólido não tem aro nem sombra;
 *  - sem `backdrop-filter`, o vidro sobe o preenchimento em vez de prometer um
 *    desfoque que o motor não faz;
 *  - com `prefers-reduced-motion`, o cartão não salta;
 *  - nada disto acrescenta um passe de `backdrop-filter` novo (o custo medido
 *    continua a ser o do eixo, e só nas superfícies já permitidas).
 *
 * Lê o CSS real, como os restantes testes de material deste repositório.
 */
const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
const decls = css.replace(/\/\*[\s\S]*?\*\//g, "");

const MARKER = "TP-LG-PREMIUM";
// O marcador vive num comentário (é prosa para quem lê o CSS): procura-se no
// texto original e só depois se removem os comentários da secção.
const inicio = css.indexOf(MARKER);
assert.ok(inicio >= 0, "a secção TP-LG-PREMIUM tem de existir no index.css");
const premium = css.slice(inicio).replace(/\/\*[\s\S]*?\*\//g, "");

function regra(seletor: string): string {
  const i = premium.indexOf(`${seletor} {`);
  assert.ok(i >= 0, `falta a regra \`${seletor}\``);
  return premium.slice(i, premium.indexOf("}", i) + 1);
}

/** Para regras agrupadas (o seletor aparece seguido de vírgula, não de `{`). */
function regraQueContem(seletor: string): string {
  const i = premium.indexOf(seletor);
  assert.ok(i >= 0, `falta o seletor \`${seletor}\``);
  const abre = premium.indexOf("{", i);
  return premium.slice(i, premium.indexOf("}", abre) + 1);
}

function alfaDoToken(nome: string, seletor: string): number {
  const valor = new RegExp(`${nome}:\\s*oklch\\(1 0 0 / ([\\d.]+)\\)`).exec(regra(seletor))?.[1];
  assert.ok(valor !== undefined, `${nome} tem de ser branco com alfa em ${seletor}`);
  return Number(valor);
}

describe("Líquido — tokens de acabamento", () => {
  test("claro e escuro têm os dois o seu reflexo, aro e profundidade", () => {
    for (const seletor of [
      '[data-theme="cybersafe-liquid"]:not(.dark)',
      '[data-theme="cybersafe-liquid"].dark',
    ]) {
      const bloco = regra(seletor);
      for (const token of [
        "--glass-sheen",
        "--glass-sheen-soft",
        "--glass-rim-top",
        "--glass-rim-bottom",
        "--glass-rim-side",
        "--glass-depth",
      ]) {
        assert.ok(bloco.includes(`${token}:`), `${seletor} sem ${token}`);
      }
    }
  });

  test("o reflexo do modo claro é mais forte do que no escuro", () => {
    const claro = alfaDoToken("--glass-sheen", '[data-theme="cybersafe-liquid"]:not(.dark)');
    const escuro = alfaDoToken("--glass-sheen", '[data-theme="cybersafe-liquid"].dark');
    assert.ok(claro > escuro, `claro ${claro} devia refletir mais do que escuro ${escuro}`);
    // Um reflexo acima de 0,65 deixa de ser vidro e passa a ser um bloco branco.
    assert.ok(claro <= 0.65, `reflexo claro demasiado opaco: ${claro}`);
  });
});

describe("Líquido — o vidro lê-se como uma placa com espessura", () => {
  test("cyber-border e stat-card levam o reflexo diagonal e o aro duplo", () => {
    for (const seletor of [
      '[data-theme="cybersafe-liquid"][data-surface="glass"] .cyber-border',
      '[data-theme="cybersafe-liquid"][data-surface="glass"] .stat-card',
      '[data-theme="cybersafe-liquid"].dark[data-surface="glass"] .cyber-border',
      '[data-theme="cybersafe-liquid"].dark[data-surface="glass"] .stat-card',
    ]) {
      const bloco = regra(seletor);
      assert.match(bloco, /linear-gradient\(115deg/, `${seletor}: falta o reflexo`);
      assert.match(bloco, /var\(--glass-sheen\)/, `${seletor}: o reflexo não lê o token`);
      assert.match(bloco, /inset 0 1px 0 var\(--glass-rim-top\)/, `${seletor}: falta a luz do aro`);
      assert.match(bloco, /inset 0 -1px 0 var\(--glass-rim-bottom\)/, `${seletor}: falta a sombra do aro`);
      assert.match(bloco, /var\(--glass-depth\)/, `${seletor}: falta a profundidade`);
    }
  });

  test("os painéis flutuantes e a navegação com o mesmo material", () => {
    const painel = regra('[data-theme="cybersafe-liquid"][data-surface="glass"] .surface-elevated');
    assert.match(painel, /linear-gradient\(115deg/, "o painel do assistente/modal lê o mesmo reflexo");
    assert.match(painel, /inset 0 1px 0 var\(--glass-rim-top\)/, "o painel leva o aro de vidro");

    const barra = regra('[data-theme="cybersafe-liquid"][data-surface="glass"] .sidebar-surface');
    assert.match(barra, /inset -1px 0 0 var\(--glass-rim-side\)/, "a barra lateral leva o aro, sem faixa a atravessá-la");
    assert.doesNotMatch(barra, /115deg/, "a barra lateral não recebe o reflexo diagonal");
  });

  test("o reflexo é estático: não há animação contínua numa superfície repetida", () => {
    const secaoDasSuperficies = premium.slice(
      premium.indexOf(".cyber-border"),
      premium.indexOf("prefers-reduced-motion"),
    );
    assert.doesNotMatch(secaoDasSuperficies, /animation:/, "nada de animação perpétua no vidro");
    assert.doesNotMatch(secaoDasSuperficies, /@keyframes/, "nada de keyframes no vidro");
  });
});

describe("Líquido — os três degraus não são o mesmo acabamento", () => {
  test("Reduzido fica plano (sem profundidade) e Sólido não tem sombra", () => {
    const reduzido = regraQueContem('[data-surface="reduced"] .cyber-border');
    assert.match(reduzido, /box-shadow: inset 0 1px 0/, "Reduzido mantém um aro, mas plano");

    const solido = regraQueContem('[data-surface="solid"] .cyber-border');
    assert.match(solido, /box-shadow: none/, "Sólido é opaco e plano");
  });

  test("Reduzido e Sólido não herdam o aro iluminado do Vidro", () => {
    const lista = /\[data-surface="reduced"\] \.cyber-border,[\s\S]*?\{([\s\S]*?)\}/.exec(premium)?.[1];
    assert.ok(lista, "regra do Reduzido não encontrada");
    assert.doesNotMatch(lista, /var\(--primary\)/, "o aro ciano é exclusivo do Vidro");
  });
});

describe("Líquido — robustez e movimento", () => {
  test("o fallback de desempenho é o degrau Reduzido, não um segundo caminho de desfoque", () => {
    // A via suportada para máquinas fracas é `data-surface=reduced`: mantém o
    // pano translúcido e um aro plano, e não acrescenta um passe de compositor.
    assert.doesNotMatch(premium, /backdrop-filter/, "o acabamento não abre outro caminho de desfoque");
    const reduzido = regraQueContem('[data-surface="reduced"] .cyber-border');
    assert.match(reduzido, /box-shadow: inset 0 1px 0/);
  });

  test("com aro premium e movimento reduzido, o cartão não salta", () => {
    const bloco = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(premium)?.[1];
    assert.ok(bloco, "falta o gate de movimento reduzido desta secção");
    assert.match(bloco, /\.stat-card:hover \{[\s\S]*?transform: none/);
  });

  test("o acabamento não acrescenta passes de backdrop-filter", () => {
    assert.doesNotMatch(premium, /backdrop-filter\s*:/, "o custo do desfoque continua no eixo");
  });

  test("a hierarquia do Dashboard continua acima do acabamento", () => {
    const fim = premium.lastIndexOf(".dashboard-page .dash-secondary .stat-card");
    assert.ok(fim > premium.indexOf(".stat-card:hover"), "o override do Dashboard tem de vir depois");
    const bloco = premium.slice(fim);
    assert.match(bloco, /box-shadow: none/, "os secundários do Dashboard não ganham profundidade");
    assert.match(bloco, /transform: none/, "os secundários do Dashboard não saltam");
  });
});
