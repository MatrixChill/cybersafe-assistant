import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R6-L5 2 — o preview de MATERIAIS nas Configurações.
 *
 * A amostra é uma PLACA opaca (não uma superficie de vidro do eixo) e vive no
 * fluxo da página. A versão anterior deste teste fixava o painel como `sticky`
 * com teto de altura e scroll próprio; o feedback humano de 22/10 inverteu
 * essa decisão: o painel acompanhava o scroll e ficava preso a meio caminho.
 * Agora rola com o conteúdo, ocupa a largura toda e não tem scroll interno.
 *
 * Verifica-se o MECANISMO em fonte e na folha, porque é isso que pode regredir
 * sem que ninguém dê por ela. O pixel fica para a medição humana.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, "..", "src", "index.css"), "utf8");
const settings = fs.readFileSync(path.join(HERE, "..", "src", "pages", "SettingsPage.tsx"), "utf8");
const decls = css.replace(/\/\*[\s\S]*?\*\//g, "");

const PREVIEW = "[data-theme][data-surface] .appearance-preview {";
const bloco = (inicio: number): string => decls.slice(inicio, decls.indexOf("}", inicio) + 1);

describe("R6-L5 2 — o contentor da amostra é uma placa, não uma superficie de vidro", () => {
  test("a regra existe e é âncorada no <html> (0-3-0), por isso ganha às do eixo", () => {
    const inicio = decls.indexOf(PREVIEW);
    assert.ok(inicio >= 0, "falta a regra .appearance-preview");
    // O mesmo âncora que as regras por identidade e que o enchimento do vidro:
    // sem `[data-theme]` perdia para `.surface-elevated` e o painel voltava a
    // ser translúcido.
    assert.match(PREVIEW, /^\[data-theme\]\[data-surface\] \.appearance-preview \{$/, "seletor sem âncora no <html>");
    assert.ok(inicio > decls.indexOf('[data-theme][data-surface="glass"] .surface-elevated,'),
      "a placa tem de ser POSTERIOR ao enchimento do vidro, ou perde na cascata");
  });

  test("a placa é opaca e incondicional — em todos os temas, materiais e larguras", () => {
    const corpo = bloco(decls.indexOf(PREVIEW));
    assert.match(corpo, /background-color: var\(--background\)/);
    assert.match(corpo, /border-color: var\(--border\)/);
    // Nenhum valor por tema: a placa lê um token, não uma cor.
    assert.equal(/#[0-9a-fA-F]{3,8}/.test(corpo), false, "hex literal na placa da amostra");
    assert.equal(/var\(--surface-translucent\)|color-mix\(/.test(corpo), false, "placa voltou a translúcida");
  });

  test("a placa não tem teto de altura nem scroll próprio", () => {
    // O teto existia só para o sticky não sair do ecrã. Sem sticky, um teto
    // voltaria a esconder a cauda da amostra atrás de uma barra interna.
    assert.equal(decls.includes("max-height: calc(100vh - 2rem)"), false, "voltou o teto em vh");
    assert.equal(decls.includes("max-height: calc(100dvh - 2rem)"), false, "voltou o teto em dvh");
    assert.equal(/\.appearance-preview[^{]*\{[^}]*overflow-y: auto/.test(decls), false, "a amostra voltou a ter scroll próprio");
    assert.equal(/\.appearance-preview[^{]*\{[^}]*scrollbar-gutter/.test(decls), false, "calha de scroll na amostra");
  });

  test("o painel rola com a página — sem sticky, sem fixed, sem scroll interno", () => {
    const classes = [...settings.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
    const sticky = classes.filter((c) => /(^|\s)(lg:)?sticky(?!["\w-])/.test(c));
    assert.deepEqual(sticky, [], `sticky de volta em: ${sticky.join(" | ")}`);
    assert.equal(/position:\s*(sticky|fixed)/.test(decls.slice(decls.indexOf(PREVIEW), decls.indexOf(PREVIEW) + 400)), false,
      "a folha também prende a amostra");
    assert.match(settings, /<aside className="surface-elevated cyber-border appearance-preview[^"]*">/,
      "o aside perdeu a marca da placa");
  });
});

describe("R6-L5 2b — a amostra lê os tokens do eixo, não números próprios", () => {
  const palco = settings.slice(settings.indexOf("Os três materiais, no mesmo fundo"));

  test("os três cartões vêm dos tokens que o eixo aplica", () => {
    assert.match(palco, /"var\(--surface-translucent\)"/, "Vidro e Reduzido partilham o pano do eixo");
    assert.match(palco, /"var\(--material-glass-edge\)"/, "o aro do vidro é o token do eixo");
    assert.match(palco, /option\.id === "solid"\s*\?\s*"var\(--surface-card\)"/, "Sólido é o card do eixo");
    // O 76% que existia aqui não era o valor de lado nenhum (o eixo mede 74%
    // em escuro e 80% em claro): a amostra mostrava um material inventado.
    assert.equal(palco.includes("var(--card) 76%"), false, "voltou o número próprio da amostra");
  });

  test("o raio de desfoque da amostra é o raio do eixo", () => {
    // A amostra já não repete o raio: lê o mesmo token que o eixo aplica, e por
    // isso não pode divergir. Um literal aqui voltaria a ser um número próprio.
    assert.ok(/--surface-filter: blur\(\d+px\)/.test(decls), "o eixo tem de declarar o raio");
    assert.equal((palco.match(/"var\(--surface-filter\)"/g) ?? []).length, 2,
      "backdropFilter e -webkit- ambos leem o token");
    assert.equal(/blur\(\d+px\)/.test(palco), false, "a amostra voltou a ter um raio literal");
  });

  test("o travão do eixo não apaga o desfoque da amostra", () => {
    // O `[data-surface-preview]` é a exceção no travão universal dos modos
    // Reduzido e Sólido; sem ele, quem estivesse em Sólido veria três cartões
    // iguais.
    assert.equal((palco.match(/data-surface-preview=""/g) ?? []).length >= 2, true,
      "palco e cartões têm de estar marcados como amostra");
    assert.match(decls, /\[data-surface="solid"\] \*:not\(\[data-surface-preview\]\)/);
  });

  test("a amostra não é mais transparente do que o painel que representa", () => {
    // A placa é opaca (`--background`); se algum dia voltar a ser o pano do
    // material, o defeito da sobreposição regressa e isto passa a falhar.
    const corpo = bloco(decls.indexOf(PREVIEW));
    assert.equal(/color-mix\([^)]*transparent/.test(corpo), false, "a placa voltou a ser translúcida");
    assert.equal(/var\(--surface-translucent\)/.test(corpo), false, "a placa usou o pano do material");
  });
});

/* ═══ R6-L5-UX B — a amostra vive no fluxo e ocupa a largura ═══════════════ */

describe("R6-L5-UX B — a amostra vive no fluxo da página, não presa ao topo", () => {
  const app = fs.readFileSync(path.join(HERE, "..", "src", "App.tsx"), "utf8");
  const classes = [...settings.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);

  test("o `<main>` continua a ser o scrollport da aplicação", () => {
    // P1 (22/10): o <main> ganhou `data-cs-main` para o painel lateral da
    // Matrix reservar largura. Continua a ser o MESMO scrollport.
    assert.match(app, /<main ref=\{mainScrollRef\} data-cs-main="" className=\{cn\("flex-1 overflow-y-auto relative min-w-0"/);
    // O invólucro da app não faz scroll: `h-screen` + `overflow-hidden`.
    assert.match(app, /bg-background[\s\S]{0,120}overflow-hidden/);
    // Nada dentro das Configurações corta: um `overflow-hidden` aqui voltaria a
    // criar um scrollport próprio entre o <main> e a amostra.
    assert.equal(/overflow-(hidden|auto|scroll)/.test(settings), false,
      "as Configurações têm um contentor cortado entre o <main> e a amostra");
  });

  test("os controlos vêm primeiro e a amostra flui depois deles", () => {
    const tema = settings.indexOf(">Tema base<");
    const modo = settings.indexOf(">Modo<");
    const material = settings.indexOf(">Material da interface<");
    const destaque = settings.indexOf(">Cor de destaque<");
    const aside = settings.indexOf("<aside");
    assert.ok(tema >= 0 && modo > tema && material > modo && destaque > material && aside > destaque,
      "a amostra deixou de estar depois dos quatro controlos");
    const fechoGrelha = settings.indexOf("</div>", settings.indexOf("</aside>"));
    assert.ok(fechoGrelha > aside, "o aside tem de fechar dentro da grelha do contentor");
  });

  test("a composição usa a largura e mantém a amostra compacta", () => {
    // Grelha de uma coluna: os controlos ocupam a largura toda e a amostra
    // assenta por baixo, sem coluna lateral que a obrigue a ser estreita.
    assert.match(settings, /grid grid-cols-1 gap-6 items-start/, "contentor da Aparência sem coluna única");
    assert.match(settings, /mt-3 grid gap-4 lg:grid-cols-\[minmax\(0,1\.55fr\)_minmax\(0,1fr\)\] lg:items-start/,
      "a amostra não se divide em materiais + hero lado a lado");
    assert.match(settings, /grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 rounded-xl/,
      "os três materiais deixaram de ficar lado a lado");
    assert.equal(classes.some((c) => /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(260px,320px\)\]/.test(c)), false,
      "voltou a coluna lateral estreita com a amostra presa ao lado");
  });

  test("a descrição da secção já não fala em dois controlos", () => {
    assert.equal(settings.includes("Dois controlos independentes"), false, "ficou a copy antiga de dois controlos");
    assert.match(settings, /Quatro escolhas que se combinam: tema base, modo claro ou escuro, material das superfícies e cor de destaque\./);
  });
});
