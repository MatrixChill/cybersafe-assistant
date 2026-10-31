import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R3-E — a distância entre Vidro, Reduzido e Sólido tem de ser REAL.
 *
 * O resultado humano da ronda 2 foi honesto: «Vidro e Sólido funcionam, mas
 * visualmente parecem quase iguais». Havia duas causas, e as duas são
 * verificáveis em fonte — por isso este teste verifica MECANISMO, não gosto:
 *   1. não havia nada para desfocar: o fundo era um gradiente liso, e desfocar
 *      uma coisa sem arestas não se vê;
 *   2. os três materiais só diferiam no `backdrop-filter`, que é o atributo que
 *      ninguém repara ter mudado quando o resto é igual.
 *
 * Contrato atual: o fundo ganha malha (alta-frequência), o vidro ganha aro
 * iluminado, o sólido continua achatado e o reduzido continua translúcido sem
 * desfoque. E as Configurações mostram os três no MESMO fundo, ao lado dos
 * controlos, para a comparação não depender de boa vontade.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, "..", "src", "index.css"), "utf8");
const settings = fs.readFileSync(path.join(HERE, "..", "src", "pages", "SettingsPage.tsx"), "utf8");
/** Sem comentários: as invariantes falam de declarações, não de prosa. */
const decls = css.replace(/\/\*[\s\S]*?\*\//g, "");

const bloco = (seletor: string) => {
  const i = decls.indexOf(`${seletor} {`);
  assert.ok(i >= 0, `falta a regra \`${seletor}\``);
  return decls.slice(i, decls.indexOf("}", i) + 1);
};

describe("R3-E 1 — o fundo tem de ter com o que o desfoque se mostre", () => {
  test("as duas variantes do fundo ambiente trazem malha de alta-frequência", () => {
    for (const seletor of [".liquid-bg", ".dark .liquid-bg"]) {
      const regra = bloco(seletor);
      assert.match(regra, /repeating-linear-gradient\(0deg/, `${seletor}: linhas finas`);
      assert.match(regra, /repeating-linear-gradient\(90deg/, `${seletor}: colunas finas`);
    }
  });

  test("a malha é discreta (não é padrão novo a competir com o conteúdo)", () => {
    const alfas = [...decls.matchAll(/repeating-linear-gradient\(\d+deg, color-mix\(in oklch, var\(--foreground\) (\d+)%/g)]
      .map((m) => Number(m[1]));
    assert.ok(alfas.length >= 4, `esperava 4 malhas (2 por variante), obtive ${alfas.length}`);
    assert.ok(Math.max(...alfas) <= 8, `malha acima de 8% de tinta passava a ser ruído: ${Math.max(...alfas)}%`);
  });

  test("o fundo continua a usar os tokens do tema, não cor crua", () => {
    const escuro = bloco(".dark .liquid-bg");
    for (const token of ["var(--primary)", "var(--cyber-cyan)", "var(--cyber-purple)"]) {
      assert.ok(escuro.includes(token), `fundo escuro usa ${token}`);
    }
    assert.doesNotMatch(escuro, /#[0-9a-f]{3,6}/i, "hex literal no fundo");
  });
});

describe("R3-E 2 — os três materiais são três coisas diferentes", () => {
  test("vidro desfoca; reduzido e sólido não desfocam", () => {
    assert.match(bloco('[data-surface="glass"]'), /--surface-filter: blur\((\d+)px\)/);
    assert.match(bloco('[data-surface="reduced"]'), /--surface-filter: none/);
    assert.match(bloco('[data-surface="solid"]'), /--surface-filter: none/);
  });

  test("o aro iluminado é exclusivo do vidro", () => {
    for (const modo of [".dark", ":not(.dark)"]) {
      const i = decls.indexOf(`[data-surface="glass"]${modo} .surface-elevated`);
      assert.ok(i >= 0, `falta o aro de vidro no modo ${modo}`);
      assert.match(decls.slice(i, decls.indexOf("}", i)), /border-color: color-mix\(in oklch, var\(--primary\) \d+%, transparent\)/);
    }
    // Reduzido e sólido não podem herdar o aro, senão a diferença passa a ser
    // só o desfoque outra vez.
    assert.equal(/data-surface="(reduced|solid)"[\s\S]{0,400}border-color: color-mix\(in oklch, var\(--primary\)/.test(decls), false);
  });

  test("sólido é opaco; reduzido mantém a transparência", () => {
    const solido = decls.slice(
      decls.indexOf('[data-surface="solid"].dark .surface-elevated') >= 0
        ? decls.indexOf('[data-surface="solid"].dark .surface-elevated')
        : decls.indexOf('[data-surface="solid"].dark .cyber-border'),
    );
    assert.match(solido, /background-color: var\(--background\)/, "sólido achatado contra o fundo");
    assert.equal(decls.includes('[data-surface="reduced"].dark .cyber-border'), false,
      "reduzido não pode achatar: é o translúcido sem desfoque");
  });

  test("a lista desfocada continua curta e sem .cyber-border", () => {
    const i = decls.search(/\[data-surface="glass"\] \.surface-elevated,\s/);
    const lista = decls.slice(i, decls.indexOf("{", i));
    const membros = lista.split(",").map((l) => l.trim()).filter(Boolean);
    assert.deepEqual(membros, ["surface-elevated", "sidebar-surface", "hero-banner", "stat-card", "auth-card"].map((name) => '[data-surface="glass"] .' + name), "as superficies elevadas do eixo de vidro (membros, nao contagem)");
    assert.equal(lista.includes(".cyber-border"), false, "~90 instâncias por ecrã");
  });

  test("controlo: igualar vidro e sólido rebenta este guarda", () => {
    // Mutação só em memória: se alguém puser o filtro do vidro a `none`, a
    // diferença deixa de existir e o contrato tinha de falhar.
    const mutado = decls.replace('[data-surface="glass"] { --surface-filter: blur(16px) saturate(150%); }', '[data-surface="glass"] { --surface-filter: none; }');
    assert.notEqual(mutado, decls, "a mutação tem de acontecer");
    const regra = mutado.slice(mutado.indexOf('[data-surface="glass"] {'), mutado.indexOf("}", mutado.indexOf('[data-surface="glass"] {')));
    assert.equal(/blur\(\d+px\)/.test(regra), false, "o teste acima exige blur no vidro");
  });
});

describe("R3-E 3 — a comparação nas Configurações é uma comparação", () => {
  test("um só pano de fundo, três cartões, os três materiais", () => {
    const inicio = settings.indexOf("Os três materiais, no mesmo fundo");
    assert.ok(inicio >= 0, "o título da comparação tem de existir");
    // Até ao fim do painel: uma janela de caracteres fixa cortava o desfoque
    // do cartão assim que os comentários cresciam.
    const palco = settings.slice(inicio, settings.indexOf("</aside>", inicio));
    assert.match(palco, /SURFACE_OPTIONS\.map/, "os três cartões vêm da mesma lista das opções");
    assert.match(palco, /repeating-linear-gradient/, "o palco tem malha, senão o desfoque não se vê");
    assert.match(palco, /option\.id === "glass" \? "var\(--surface-filter\)"/, "o vidro da amostra desfoca");
    // O Sólido da amostra escolhe o token da superfície (`--surface-card`), não o
    // fundo da página (`--background`): é uma superfície elevada que ele mostra.
    // Isto não afirma igualdade pixel-perfeita com a raiz `globalSolid`, que usa
    // `--background` nas superfícies elevadas; essa nuance é de feedback visual.
    assert.match(palco, /option\.id === "solid"\s*\?\s*"var\(--surface-card\)"/, "o sólido da amostra é opaco");
  });

  test("a amostra não pode ser anulada pelo travão do eixo", () => {
    // Sem este atributo, `[data-surface="solid"] * { backdrop-filter: none
    // !important }` apagava o desfoque da amostra de Vidro em quem está em
    // Sólido — e a pré-visualização mostraria três cartões iguais.
    const inicio = settings.indexOf("Os três materiais, no mesmo fundo");
    const palco = settings.slice(inicio, inicio + 3000);
    assert.equal((palco.match(/data-surface-preview=""/g) ?? []).length >= 2, true,
      "palco e cartões têm de estar marcados como amostra");
  });

  test("layout: controlos primeiro, amostra em seguida, ambas na mesma grelha", () => {
    // Feedback humano de 22/10: a amostra deixou de ser uma coluna `sticky` ao
    // lado dos controlos. Passa a placa no fluxo, a seguir aos quatro eixos, e
    // dentro da mesma grelha (nunca fora do contentor, no fim da página).
    assert.match(settings, /grid grid-cols-1 gap-6 items-start/);
    assert.match(settings, /<aside className="surface-elevated/);
    const destaque = settings.indexOf(">Cor de destaque<");
    const aside = settings.indexOf("<aside className=\"surface-elevated");
    assert.ok(destaque >= 0 && aside > destaque, "a amostra tem de vir depois dos controlos");
    assert.ok(settings.indexOf("grid grid-cols-1 gap-6 items-start") < aside, "o aside saiu da grelha");
  });

  test("a amostra não apresenta métricas como se fossem reais", () => {
    const inicio = settings.indexOf("Os três materiais, no mesmo fundo");
    const palco = settings.slice(inicio, inicio + 3200);
    assert.equal(/\/100/.test(palco), false, "nada de nota de proteção inventada na amostra");
    // O palco lê só `SURFACE_OPTIONS` e o material escolhido: não toca em
    // telemetria nenhuma, por isso não pode mostrar um número que pareça medido.
    for (const fonte of ["pcState", "hardware", "dashboard", "riskScore", "protection"]) {
      assert.equal(palco.includes(fonte), false, `a amostra não pode ler ${fonte}`);
    }
    assert.match(settings, /Não há números/, "a razão de não haver números fica escrita no fonte");
  });
});
