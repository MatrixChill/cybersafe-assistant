import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HardwareSnapshot } from "@cybersafe/shared-types";
import type { OptimizeCartao } from "../src/lib/optimizeModel";

/**
 * R6-L1 — o aspeto da Otimizar e os tokens que o produzem.
 *
 * O que o humano mediu: OPTIMIZE_R5_LAYOUT_HUMAN = MELHORIA NECESSÁRIA e
 * OPTIMIZE_R5_CONTRAST_HUMAN = INSUFICIENTE. Este ficheiro não volta a medir
 * o pixel — isso é dele — prende as regras que explicam essa medição e que
 * podem regredir sozinhas na próxima ronda:
 *
 *   1. nada de vermelho onde ainda não houve medição (o defeito era a borda
 *      do grupo «problemas», tinta pelo `tipo` do catálogo);
 *   2. uma só ação cheia no ecrã;
 *   3. corpo de pessoa: sem monoespaçado nem 12px no que se lê;
 *   4. os tokens novos derivam dos por-tema, por isso valem nos 5 temas ×
 *      3 materiais, e o desfoque continua só no eixo de superfície.
 */

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { default: OtimizarPage } = await import("../src/pages/OtimizarPage");
const {
  classificacaoDe,
  cartoesIniciais,
  elegivelParaVerificacaoRapida,
} = await import("../src/lib/optimizeModel");

const ler = (ficha: string) => readFileSync(new URL(`../src/${ficha}`, import.meta.url), "utf8");
const pagina = ler("pages/OtimizarPage.tsx");
const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
/** O CSS sem comentários: as notas citam por nome justamente o que é proibido. */
const decls = css.replace(/\/\*[\s\S]*?\*\//g, "");
// A região nova corta-se no CSS COM comentários (é neles que vivem os
// marcadores) e só depois se limpam as notas: ao contrário, o `indexOf` do
// marcador dava -1 e todas as asserções abaixo falavam de uma string vazia.
const semNotas = (corpo: string) => corpo.replace(/\/\*[\s\S]*?\*\//g, "");
const inicioTokens = css.indexOf("TOKENS PARTILHADOS DE PRODUTO");
// O fim da região é o primeiro bloco de identidade depois da escada — NÃO um
// `@layer` qualquer: os temas vão todos pelo meio e a régua passava a ler o
// ficheiro inteiro, incluindo o hex que ela própria proíbe.
const fimPrimitivas = css.indexOf('[data-theme="cybersafe-neon"]:not(.dark)', inicioTokens);
assert.ok(inicioTokens >= 0 && fimPrimitivas > inicioTokens, "os marcadores da escada nova têm de existir");
const blocoNovo = semNotas(css.slice(inicioTokens, fimPrimitivas));

const hardware = {
  cpu: { usage: 12 },
  ram: { usagePercent: 44 },
  disk: { primary: null },
} as unknown as HardwareSnapshot;

const htmlInicial = renderToStaticMarkup(createElement(OtimizarPage, {}));
const htmlComHardware = renderToStaticMarkup(createElement(OtimizarPage, { hardware }));

/** Tokens de classe de um elemento: `bg-primary` não se confunde com
    `hover:bg-primary/90`, que é outra coisa a acontecer. */
function elementosComClasse(html: string, alvo: string): number {
  const contas = [...html.matchAll(/class="([^"]*)"/g)]
    .map((m) => m[1].split(/\s+/))
    .filter((lista) => lista.includes(alvo));
  return contas.length;
}

function cartaoCom(overrides: Partial<OptimizeCartao>): OptimizeCartao {
  return { ...cartoesIniciais()[0], ...overrides };
}

describe("R6 — pendente é neutro; a tinta vem da medição", () => {
  test("no arranque não há chip crítico nem chip de aviso no ecrã", () => {
    for (const [nome, html] of [["sem hardware", htmlInicial], ["com hardware", htmlComHardware]] as const) {
      assert.equal((html.match(/state-chip--crit/g) ?? []).length, 0, `${nome}: vermelho sem medição`);
      assert.equal((html.match(/state-chip--warn/g) ?? []).length, 0, `${nome}: âmbar sem medição`);
      assert.equal((html.match(/border-l-cyber-red/g) ?? []).length, 0, `${nome}: contorno vermelho por verificar`);
      assert.equal((html.match(/border-l-cyber-yellow/g) ?? []).length, 0, `${nome}: contorno âmbar por verificar`);
      assert.ok(html.includes("state-chip--na"), `${nome}: o pendente tinha de ler-se neutro`);
    }
  });

  test("a borda colorida do contentor por `tipo` desapareceu do código", () => {
    assert.equal(/BORDA_GRUPO/.test(pagina), false, "voltou a tinta keyed ao catálogo, não à medição");
    assert.equal(pagina.includes("border-cyber-red/30"), false, "borda de grupo vermelha por defeito");
  });

  test("com severidade MEDIDA a linha ganha a tinta, e só então", () => {
    const critico = cartaoCom({ estado: "verificado", resultado: "problema", severidade: "critico" });
    assert.equal(classificacaoDe(critico).tom, "critico");
    assert.ok(pagina.includes('medidoCritico && "border-l-2 border-l-cyber-red"'), "a borda vem de `severidade`");
    // Controlo negativo: um cartão saudável verificado não pode ir ao vermelho.
    const saudavel = cartaoCom({ estado: "verificado", resultado: "sem-problema", severidade: null });
    assert.notEqual(classificacaoDe(saudavel).tom, "critico", "configuração saudável chamada crítica");
    assert.equal(classificacaoDe(saudavel).rotulo, "Saudável");
  });

  test("o chip neutro é uma argola vazia: «ainda não sei» tem forma", () => {
    const regra = blocoNovo.slice(blocoNovo.indexOf(".state-chip--na::before"));
    assert.match(regra.slice(0, 200), /background:\s*transparent/);
    assert.match(regra.slice(0, 200), /box-shadow:\s*inset/);
  });
});

describe("R6 — uma só ação principal, hierarquia de três grupos", () => {
  test("o ecrã tem exatamente um botão cheio, e é a verificação em bloco", () => {
    assert.equal(elementosComClasse(htmlComHardware, "bg-primary"), 1, "mais do que uma ação cheia");
    const rotulo = /Verificar tudo agora \((\d+)\)/.exec(htmlComHardware);
    assert.ok(rotulo, "falta a ação principal com a conta do que vai correr");
    assert.equal(Number(rotulo?.[1]), 3, "três cartões medem esta máquina sem pedir decisão");
  });

  test("as ações de linha não competem com a principal", () => {
    assert.equal(elementosComClasse(htmlInicial, "border-border") >= 10, true, "os botões de linha são contorno");
    assert.equal(/bg-primary text-primary-foreground/.test(pagina.split("LinhaOtimizar")[1] ?? ""), false,
      "a linha voltou a vestir a tinta da ação principal");
  });

  test("primeiro o que a app mede, depois o que se faz, no fim o que é hábito", () => {
    // 15/10 — a separação passou a ser por NATUREZA da linha: o título diz o
    // que a lista É, não um veredicto. Um problema medido marca-se na LINHA
    // (chip + aresta); nunca no cabeçalho da lista.
    const verificacoes = htmlInicial.indexOf("Verificações automáticas");
    const manutencao = htmlInicial.indexOf("Manutenção recomendada");
    const manuais = htmlInicial.indexOf("Ações manuais");
    assert.ok(verificacoes >= 0 && manutencao > verificacoes && manuais > manutencao,
      "a ordem da leitura inverteu-se");
    assert.equal(/Problemas detetados/.test(htmlInicial), false,
      "o cabeçalho de uma lista voltou a afirmar problemas comprovados");
    assert.equal(/Boas práticas opcionais/.test(htmlInicial), false,
      "a prática opcional ficou sem dizer que é manual");
  });

  test("«sem problemas comprovados» diz que ainda não há medição, não «tudo bem»", () => {
    assert.match(htmlInicial, /Ainda não há problemas comprovados/);
    assert.equal(/Tudo protegido|Tudo em ordem/.test(htmlInicial), false, "estado saudável afirmado sem medição");
  });

  test("os três grupos não se vestem todos da mesma caixa", () => {
    assert.match(htmlInicial, /icon-tile/, "manutenção leva mosaico de ícone");
    assert.match(htmlInicial, />01</, "os hábitos lêem-se como lista numerada, não como cartões");
    assert.equal((htmlInicial.match(/row-item/g) ?? []).length, 10, "as dez linhas existem, uma por cartão");
  });
});

describe("R6 — legibilidade: corpo de pessoa, não de terminal", () => {
  test("o monoespaçado fica só no título e nos cabeçalhos de grupo", () => {
    const comMono = [...htmlInicial.matchAll(/class="([^"]*)"/g)]
      .map((m) => m[1].split(/\s+/))
      .filter((lista) => lista.includes("font-mono")).length;
    /* O limite numérico era o proxy de «só título e cabeçalhos de grupo». Em
       2026-11-01 entrou o grupo «Definições de segurança», um cabeçalho de grupo
       como os outros três. A regra passa a dizer-se estruturalmente, e por isso fica
       mais apertada: nenhum elemento com mono fora de h1/h2, além do teto. */
    const monoForaDeCabecalho = [...htmlInicial.matchAll(/<(h1|h2|h3|p|span|div|button)\b[^>]*class="([^"]*)"/g)]
      .filter((m) => m[1] !== "h1" && m[1] !== "h2" && m[2].split(/\s+/).includes("font-mono")).length;
    assert.equal(monoForaDeCabecalho, 0, "monoespaçado usado fora de um cabeçalho de grupo");
    assert.ok(comMono <= 5, `demasiado monoespaçado no ecrã: ${comMono} elementos`);
    assert.equal(/<p class="[^"]*font-mono/.test(htmlInicial), false, "parágrafo de leitura em mono");
  });

  test("sem leitura do serviço, a secção das definições não afirma nada", () => {
    // A renderização inicial corre efeitos nenhuns: é o caso «sem leitura».
    assert.match(htmlInicial, /Definições de segurança/);
    assert.match(htmlInicial, /O serviço não devolveu o estado por fonte/);
    assert.equal(htmlInicial.includes("última tentativa"), false, "linhas por fonte inventadas sem leitura");
  });

  test("nada de 12px como corpo de leitura", () => {
    assert.equal(pagina.includes("text-xs"), false, "text-xs de volta ao corpo do cartão");
    assert.match(blocoNovo, /--text-body:\s*0\.875rem/);
    assert.match(blocoNovo, /\.row-note\s*\{[^}]*font-size:\s*var\(--text-body\)/);
  });

  test("o topo tem olho-de-gato, título e lead: a hierarquia do guia de estilo", () => {
    assert.match(htmlInicial, /eyebrow-label">Segurança do sistema/);
    assert.match(htmlInicial, /<h1 class="[^"]*text-2xl[^"]*font-mono/);
    assert.match(htmlInicial, /max-w-\[64ch\]/, "o lead sem largura de leitura vai ao fim da linha");
  });

  test("o número do progresso é tabular e sem mono; a barra é a primitiva partilhada", () => {
    // 15/10 — o número do progresso nunca aparece sozinho (vem com a fase e com
    // a frase que o define) e não veste o acento do tema enquanto vale zero:
    // 0% não é um resultado, é «ainda não se mediu nada».
    assert.match(htmlInicial, /tabular-nums text-muted-foreground">0/);
    assert.equal(/tabular-nums text-primary/.test(htmlInicial), false, "0% pintado como resultado");
    assert.match(htmlInicial, /state-chip state-chip--na">Por começar/);
    assert.match(htmlInicial, /progress-bar-track/);
    assert.match(htmlInicial, /progress-bar-fill/);
    assert.match(htmlInicial, /role="progressbar"[^>]*aria-valuenow="0"/);
  });

  test("a evidência é um degrau abaixo do cartão, não uma frase mais alta", () => {
    assert.match(blocoNovo, /\.evidence-line\s*\{[^}]*background:\s*var\(--surface-inset\)/);
  });
});

describe("R6 — tokens partilhados: 5 temas × 3 materiais", () => {
  test("existem os cinco estados, cada um com tinta, aresta e texto", () => {
    for (const estado of ["ok", "warn", "crit", "proc", "na"] as const) {
      for (const papel of ["ink", "tint", "edge"] as const) {
        assert.ok(
          blocoNovo.includes(`--state-${estado}-${papel}:`),
          `falta --state-${estado}-${papel}`,
        );
      }
    }
  });

  test("o texto de um estado nunca é a cor de marca crua", () => {
    for (const m of blocoNovo.matchAll(/--state-(ok|warn|crit|proc)-ink:\s*([^;]+);/g)) {
      assert.match(m[2], /-text\)|var\(--foreground\)/, `--state-${m[1]}-ink usa a cor de cheio: ${m[2]}`);
    }
    assert.match(blocoNovo, /--state-na-ink:[^;]*var\(--foreground\)/, "o neutro puxa ao foreground do tema");
  });

  test("a escada de superfícies está definida e tem variante escura", () => {
    for (const token of ["page", "card", "raised", "inset", "translucent"] as const) {
      assert.ok(blocoNovo.includes(`--surface-${token}:`), `falta --surface-${token}`);
    }
    const escura = blocoNovo.slice(blocoNovo.lastIndexOf(".dark {"));
    assert.match(escura, /--surface-raised:/, "em escuro o degrado elevado tem de subir");
    assert.match(escura, /--surface-inset:/, "em escuro o rebaixado não pode ser o do claro");
  });

  test("nada de hex literal nem cor inventada nos tokens novos", () => {
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(blocoNovo), false, "hex literal na escada nova");
    const permitidos = /^(--primary|--border|--card|--background|--foreground|--muted-foreground|--cyber-[a-z-]+|--radius|--shell-radius-card|--state-[a-z]+-(ink|tint|edge)|--surface-[a-z]+|--edge-[a-z]+|--text-[a-z]+|--leading-[a-z]+|--space-\d|--(card|row)-pad[a-z-]*|--hover-tint)$/;
    for (const m of blocoNovo.matchAll(/var\((--[a-z-]+)\)/g)) {
      assert.ok(permitidos.test(m[1]), `token fora do vocabulário do tema: ${m[1]}`);
    }
  });

  test("o desfoque continua só no eixo de superfície", () => {
    assert.equal(/backdrop-filter/.test(blocoNovo), false, "blur fora do eixo data-surface");
    assert.match(decls, /\[data-surface="glass"\] \{ --surface-filter: blur\(\d+px\)/);
  });

  test("o movimento é CSS e cai com prefers-reduced-motion; a página largou o framer-motion", () => {
    assert.equal(/framer-motion|AnimatePresence|motion\./.test(pagina), false, "animação JS fora do guarda de movimento");
    assert.match(blocoNovo, /\.row-item\s*\{[^}]*transition:\s*background-color/);
    assert.match(decls, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,400}transition-property:\s*none/);
  });

  test("controlado: um bloco sem o prefixo de modo não apanha o tema escuro", () => {
    // A escada lê `--card`, que só existe nos blocos por identidade. Se alguém
    // puser o degrado fora do `:root`/`.dark` sem âncora, isto deixa de
    // casar — é o erro que a ronda 2 apanhou uma vez.
    assert.match(blocoNovo, /^:root \{[^}]*--surface-page:/m);
    assert.equal(/:not\(\.dark\)\s+\{/.test(blocoNovo), false, "bloco de modo claro sem âncora no <html>");
  });
});

describe("R6 — «Verificar tudo agora» só toca em quem mede e não decide", () => {
  test("no arranque são três: firewall, saúde do Windows e disco", () => {
    const ids = cartoesIniciais().filter(elegivelParaVerificacaoRapida).map((c) => c.id);
    assert.deepEqual(ids, ["firewall", "saude-windows", "disco"]);
  });

  test("uma operação com confirmação humana fica sempre de fora", () => {
    const alvo = cartaoCom({ acaoTipo: "verificacao", confirmar: "Isto demora." });
    assert.equal(elegivelParaVerificacaoRapida(alvo), false);
  });

  test("correção, hábito e «inexistente» não se disfarçam de verificação", () => {
    for (const acao of ["correcao", "educativa", "inexistente"] as const) {
      assert.equal(elegivelParaVerificacaoRapida(cartaoCom({ acaoTipo: acao })), false, `${acao} elegível`);
    }
  });

  test("o que falhou repete-se; o que já respondeu não se deita fora", () => {
    assert.equal(elegivelParaVerificacaoRapida(cartaoCom({ estado: "falhou", acaoTipo: "verificacao" })), true);
    for (const estado of ["verificado", "corrigido", "a-verificar", "nao-aplicavel"] as const) {
      assert.equal(
        elegivelParaVerificacaoRapida(cartaoCom({ estado, acaoTipo: "verificacao" })),
        false,
        `${estado} voltou a entrar na conta`,
      );
    }
  });

  test("controlado: a regra lê o campo, não uma lista de ids", () => {
    const disfarce = cartaoCom({ id: "backup", acaoTipo: "verificacao", confirmar: undefined });
    assert.equal(elegivelParaVerificacaoRapida(disfarce), true, "se passou a medir, passa a contar");
  });
});

describe("R6 — PT-PT e as honestidades que a ronda 5 ganhou", () => {
  test("sem PT-BR na página", () => {
    for (const palavra of ["você", "Você", "usuário", "gerenciar", "salvar", "equipe", "planejamento"]) {
      assert.equal(pagina.includes(palavra), false, `PT-BR: ${palavra}`);
    }
  });

  test("a firewall sem leitura fiável continua sem afirmar nada", () => {
    assert.match(pagina, /interpretaFirewall\(saude\.firewall\)/);
    const semLeitura = cartaoCom({
      estado: "falhou",
      severidade: null,
      mensagem: "Não foi possível confirmar o estado do firewall do Windows a partir do serviço.",
    });
    assert.equal(classificacaoDe(semLeitura).rotulo, "Falhou", "leitura impossível disfarçada de saudável");
    assert.equal(classificacaoDe(semLeitura).tom, "aviso");
  });

  test("verificar e corrigir continuam com números separados na frase do topo", () => {
    assert.match(htmlInicial, /0 de 10 vistos \(0%\)/);
    assert.match(pagina, /progresso\.corrigidos/);
    assert.equal(/concluidos|Concluídos/.test(pagina), false, "voltou a palavra que misturava os dois");
  });
});
