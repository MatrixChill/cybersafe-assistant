import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R6-L5 2 — o preview de MATERIAIS nas Configurações.
 *
 * Os dois defeitos relatados eram o mesmo painel a ser duas coisas: uma
 * superficie elevada do eixo (portanto translúcida, com o fundo a passar-lhe
 * por dentro quando fica colada ao topo com `sticky`) e uma caixa mais alta que
 * o ecrã (portanto com a cauda fora de alcance, que é o «não acompanha o
 * scroll»). A correção é separar os papéis: o contentor é uma placa opaca com
 * altura limitada e scroll próprio; o material continua a ser mostrado pelos
 * três cartões dentro do palco.
 *
 * Verifica-se o MECANISMO em fonte, porque é isso que pode regredir sem que
 * ninguém dê por ela. O que fica por confirmar é o pixel — a palavra final é a
 * medição humana.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, "..", "src", "index.css"), "utf8");
const settings = fs.readFileSync(path.join(HERE, "..", "src", "pages", "SettingsPage.tsx"), "utf8");
const decls = css.replace(/\/\*[\s\S]*?\*\//g, "");

const PREVIEW = '[data-theme][data-surface] .appearance-preview {';
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

  test("o teto de altura e o scroll próprio só existem onde há sticky", () => {
    const primeiro = decls.indexOf(PREVIEW);
    const segundo = decls.indexOf(PREVIEW, primeiro + 1);
    assert.ok(segundo > primeiro, "esperava dois blocos: a placa (sempre) e o teto (só em lg)");
    // O bloco incondicional não pode limitar altura: abaixo de `lg` o painel
    // volta ao fluxo normal e uma barra interna só trocava o defeito em miúdos.
    assert.equal(bloco(primeiro).includes("max-height"), false, "o bloco incondicional limita a altura");
    assert.match(bloco(primeiro), /background-color: var\(--background\)/);
    // Entre os dois blocos tem de estar a abertura da média de `lg`.
    assert.match(decls.slice(primeiro, segundo), /@media \(min-width: 1024px\) \{/);
    const corpo = bloco(segundo);
    assert.match(corpo, /max-height: calc\(100vh - 2rem\)/, "a reserva em `vh` para motores sem `dvh`");
    assert.match(corpo, /max-height: calc\(100dvh - 2rem\)/, "a variante dinâmica vem depois, e é a que ganha");
    assert.ok(corpo.indexOf("100vh") < corpo.indexOf("100dvh"), "ordem das duas declarações");
    for (const declaracao of ["overflow-y: auto", "overscroll-behavior: contain", "scrollbar-gutter: stable"]) {
      assert.ok(corpo.includes(declaracao), `falta \`${declaracao}\` no bloco de lg`);
    }
    // `top-4` = 16 px acima + 16 px de folga em baixo = 2rem.
    assert.match(settings, /lg:top-4/);
  });

  test("o painel continua sticky e dentro do fluxo — sem fixed, sem overlay", () => {
    assert.match(settings, /lg:sticky lg:top-4/);
    // `self-start` é o que impede a esticar até à altura da linha da grelha,
    // caso alguém troque o `items-start` do contentor: sem espaço para correr,
    // o sticky fica colado e é exatamente o «não acompanha o scroll» relatado.
    assert.match(settings, /lg:self-start/);
    assert.match(settings, /<aside className="surface-elevated cyber-border appearance-preview/);
    assert.equal(/position:\s*fixed|fixed inset-0/.test(settings), false, "nada cobre a página");
  });
});

describe("R6-L5 2b — a amostra lê os tokens do eixo, não números próprios", () => {
  const palco = settings.slice(settings.indexOf("Os três materiais, no mesmo fundo"));

  test("os três cartões vêm dos tokens que o eixo aplica", () => {
    assert.match(palco, /"var\(--surface-translucent\)"/, "Vidro e Reduzido partilham o pano do eixo");
    assert.match(palco, /"var\(--material-glass-edge\)"/, "o aro do vidro é o token do eixo");
    assert.match(palco, /option\.id === "solid"\s*\?\s*"var\(--background\)"/, "Sólido é o fundo do tema");
    // O 76% que existia aqui não era o valor de lado nenhum (o eixo mede 74%
    // em escuro e 80% em claro): a amostra mostrava um material inventado.
    assert.equal(palco.includes("var(--card) 76%"), false, "voltou o número próprio da amostra");
  });

  test("o raio de desfoque da amostra é o raio do eixo", () => {
    const doEixo = Number(/--surface-filter: blur\((\d+)px\)/.exec(decls)?.[1]);
    const daAmostra = [...palco.matchAll(/blur\((\d+)px\)/g)].map((m) => Number(m[1]));
    assert.ok(daAmostra.length >= 2, "backdropFilter e -webkit- ambos com raio");
    assert.equal(daAmostra[0], doEixo, `a amostra desfoca ${daAmostra[0]}px e a app ${doEixo}px`);
    assert.ok(daAmostra.every((v) => v === daAmostra[0]), "as duas escritas da amostra divergem");
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

/* ═══ R6-L5-UX B — o contentor de scroll real ═════════════════════════════ */

describe("R6-L5-UX B — o sticky mede-se contra o contentor que faz scroll, não contra a janela", () => {
  const app = fs.readFileSync(path.join(HERE, "..", "src", "App.tsx"), "utf8");

  test("o `<main>` é o scrollport, e é o único entre a janela e a amostra", () => {
    assert.match(app, /<main ref=\{mainScrollRef\} className=\{cn\("flex-1 overflow-y-auto relative"/);
    // O invólucro da app não faz scroll: `h-screen` + `overflow-hidden`. Se
    // alguma vez passar a ser o `body` a rolar, o `top-4` do painel passa a
    // medir-se contra outro retângulo e é aqui que se vê.
    assert.match(app, /flex h-screen bg-background[\s\S]{0,80}overflow-hidden/);
    // Nada entre o aside e o <main> corta: um `overflow-hidden` num ancestral
    // transformava o sticky num painel parado, que foi o sintoma relatado.
    assert.equal(/overflow-(hidden|auto|scroll)/.test(settings), false,
      "as Configurações têm um contentor cortado entre o <main> e a amostra");
  });

  test("abaixo de lg o painel empilha e volta ao fluxo — sem sticky, sem scroll interno", () => {
    // Os três controlos e a amostra partilham a grelha; só em `lg` há coluna
    // dupla e sticky.
    assert.match(settings, /grid gap-6 lg:grid-cols-\[minmax\(0,1fr\)_minmax\(260px,320px\)\] items-start/);
    // Só nas classes: a palavra «sticky» também aparece em prosa no fonte.
    const classes = [...settings.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
    const semBreakpoint = classes.filter((c) => /(^|\s)sticky(?![-\w])/.test(c));
    assert.equal(semBreakpoint.length, 0, `sticky sem breakpoint em: ${semBreakpoint.join(" | ")}`);
    assert.ok(classes.some((c) => /lg:sticky/.test(c)), "não há sticky em lg lado nenhum");
    assert.equal(/position: sticky/.test(decls.slice(decls.indexOf(PREVIEW), decls.indexOf(PREVIEW) + 400)), false,
      "a folha também põe sticky — passa a haver dois donos do comportamento");
  });

  test("o curso do painel é a coluna dos controlos inteira (não desaparece antes)", () => {
    const tema = settings.indexOf(">Tema base<");
    const material = settings.indexOf(">Material da interface<");
    const destaque = settings.indexOf(">Cor de destaque<");
    const aside = settings.indexOf("<aside");
    assert.ok(tema >= 0 && material > tema && destaque > material && aside > destaque,
      "a amostra deixou de estar no fim da coluna que acompanha");
    // O sticky liberta-se no fim do contentor contido (a grelha). Se a nota
    // final passasse para dentro da grelha, o painel viveria mais do que os
    // controlos; se os grupos saíssem da grelha, morria antes.
    const fechoGrelha = settings.indexOf("</div>", settings.indexOf("</aside>"));
    assert.ok(fechoGrelha > aside, "o aside tem de fechar dentro da grelha");
  });

  test("o painel não pode ficar mais alto do que o teto sem scroll visível", () => {
    // Contra-regra do `scrollbar-gutter: stable`: se alguém tirar o
    // `overflow-y`, o `max-height` passa a cortar conteúdo a sério.
    const segundo = decls.indexOf(PREVIEW, decls.indexOf(PREVIEW) + 1);
    const corpo = bloco(segundo);
    assert.ok(corpo.includes("overflow-y: auto") === corpo.includes("max-height"),
      "max-height sem scroll próprio corta o que não cabe");
  });
});
