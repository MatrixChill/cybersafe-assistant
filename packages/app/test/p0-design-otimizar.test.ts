import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * P0-DESIGN OTIMIZAR (15/10) — a reformulação pedida pelo titular (4/10 no
 * teste humano), presa em regras verificáveis.
 *
 * O que este ficheiro prende, e que nenhum dos ficheiros das rondas anteriores
 * prendia porque o desenho ainda não existia:
 *
 *   1. SEPARAÇÃO POR NATUREZA — três listas visíveis (o que mede / o que se faz
 *      / o que fazes tu), com a conta REAL de cada uma. O título de uma lista
 *      diz o que ela é: a manutenção recomendada nunca aparece debaixo de um
 *      cabeçalho que afirme um problema comprovado.
 *   2. ZERO NÃO É RESULTADO — 0% nunca aparece isolado: vem com a fase e com a
 *      frase que o define, e não veste o acento do tema.
 *   3. RESUMO COM MÉTRICAS REAIS — a proteção vem do motor (via App), as
 *      verificações do que foi medido, e a telemetria do PC fica fora da faixa
 *      da proteção, sem se somar a ela.
 *   4. MESMOS EFEITOS — o desenho mudou; o que a página chama ao serviço, não.
 *
 * O que NÃO mede: se fica bonito. Isso é o olho do humano na janela real.
 */

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { default: OtimizarPage } = await import("../src/pages/OtimizarPage");
const {
  CARTOES,
  ORDEM_SECOES,
  ROTULO_SECAO,
  aplicarDesfecho,
  cartoesIniciais,
  faseProgresso,
  grupoDe,
  progressoDe,
  secaoDe,
} = await import("../src/lib/optimizeModel");

const pagina = readFileSync(new URL("../src/pages/OtimizarPage.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

const html = renderToStaticMarkup(createElement(OtimizarPage, {}));
const htmlComHardware = renderToStaticMarkup(createElement(OtimizarPage, {
  hardware: { cpu: { usage: 12 }, ram: { usagePercent: 44, usageStatus: "available", usageUpdatedAt: new Date(Date.now() - 1000).toISOString() }, disk: { primary: null } } as never,
}));

const texto = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** O que está entre dois marcadores do ecrã, na ordem em que se lê. */
const entre = (markup: string, inicio: string, fim: string, aPartirDe = 0): string =>
  markup.slice(markup.indexOf(inicio, aPartirDe), markup.indexOf(fim, markup.indexOf(inicio, aPartirDe)));

/** As três listas, cortadas pelos títulos das secções. */
const listaVerificacoes = entre(html, "Verificações automáticas", "Manutenção recomendada",
  html.lastIndexOf("Verificações automáticas"));
const listaManutencao = entre(html, "Manutenção recomendada", "Ações manuais");
const listaManuais = entre(html, "Ações manuais", "O que cada botão faz realmente");

describe("P0 — separação visível por natureza, com a conta real", () => {
  test("cada cartão do catálogo cai numa secção e só numa", () => {
    const secoes = cartoesIniciais().map(secaoDe);
    assert.equal(secoes.length, 10);
    for (const s of secoes) assert.ok(ORDEM_SECOES.includes(s), `secção desconhecida: ${s}`);
  });

  test("a composição é 3 verificações, 2 manutenção e 5 ações manuais", () => {
    const conta = (s: string) => cartoesIniciais().filter((c) => secaoDe(c) === s).length;
    assert.equal(conta("verificacoes"), 3, "a lista do que mede deixou de ter as três verificações");
    assert.equal(conta("manutencao"), 2);
    assert.equal(conta("manuais"), 5);
    assert.deepEqual([...ORDEM_SECOES], ["verificacoes", "manutencao", "manuais"]);
  });

  test("a secção vem do que a linha FAZ, não do que a lista é no catálogo", () => {
    // Um hipotético cartão de manutenção que passe a medir muda de lista sem
    // tocar no catálogo — e o contrário também.
    const muda = { ...CARTOES.find((c) => c.id === "backup")!, acaoTipo: "verificacao" as const };
    assert.equal(secaoDe(muda), "verificacoes");
    const original = CARTOES.find((c) => c.id === "backup")!;
    assert.equal(secaoDe(original), "manuais");
  });

  test("as três listas existem no ecrã, por esta ordem, e nenhuma se chama «problemas»", () => {
    const v = html.indexOf("Verificações automáticas");
    const m = html.indexOf("Manutenção recomendada");
    const a = html.indexOf("Ações manuais");
    assert.ok(v >= 0 && m > v && a > m, "a ordem de leitura das três listas mudou");
    assert.equal(/Problemas detetados|Boas práticas opcionais/.test(html), false,
      "um título de lista voltou a ser um veredicto");
  });

  test("cada linha aparece na lista da sua natureza — e só nela", () => {
    for (const titulo of ["Firewall do Windows", "Saúde geral do Windows", "Espaço livre em disco"]) {
      assert.ok(listaVerificacoes.includes(titulo), `${titulo}: saiu da lista das verificações`);
    }
    for (const intruso of ["Atualizar definições de ameaças", "Análise profunda do computador"]) {
      assert.equal(listaVerificacoes.includes(intruso), false, `${intruso}: entrou na lista do que mede`);
    }
    assert.ok(listaManutencao.includes("Atualizar definições de ameaças"));
    assert.ok(listaManutencao.includes("Análise profunda do computador"));
    assert.equal(listaManutencao.includes("Firewall do Windows"), false,
      "uma verificação automática apareceu na manutenção");
    for (const titulo of [
      "Programas que arrancam com o Windows", "Navegador atualizado", "Senhas únicas por conta",
      "Extensões do navegador", "Cópia de segurança dos dados",
    ]) {
      assert.ok(listaManuais.includes(titulo), `${titulo}: saiu das ações manuais`);
    }
  });

  test("«manutenção recomendada» diz que não é uma falha medida", () => {
    assert.match(texto(listaManutencao), /Não é uma falha medida/,
      "a lista da manutenção deixou de dizer o que é");
    assert.equal(/problema comprovado/i.test(ROTULO_SECAO.manutencao.descricao), false);
    assert.equal(/problema comprovado/i.test(ROTULO_SECAO.manuais.descricao), false);
  });

  test("um problema MEDIDO sobe a contagem, mas não muda o título de nenhuma lista", () => {
    const falha = aplicarDesfecho(cartoesIniciais()[0], "verificacao", {
      ok: true,
      severidade: "critico",
      evidencia: "desligado nos perfis: Privado",
      mensagem: "Liga-o na Segurança do Windows.",
    });
    assert.equal(grupoDe(falha), "problemas", "a contagem de problemas comprovados não subiu");
    assert.equal(secaoDe(falha), "verificacoes", "a linha mudou de lista em vez de se marcar");
  });
});

describe("P0 — zero não é resultado", () => {
  test("0% aparece com a fase, com a legenda e dentro da região viva", () => {
    const bloco = entre(html, "Progresso", "Estado global da proteção");
    assert.match(bloco, /Por começar/, "a fase desapareceu: 0% voltou a aparecer sozinho");
    assert.match(bloco, /«Vistos» é o que já foi medido ou tentado/, "a legenda do número desapareceu");
    assert.match(bloco, /aria-live="polite">0 de 10 vistos \(0%\)/, "o resumo deixou de ser anunciado");
    assert.match(bloco, /role="progressbar"/, "a barra desapareceu do bloco");
  });

  test("as fases cobrem o começo, o meio e o fim", () => {
    const ini = cartoesIniciais();
    assert.equal(faseProgresso(progressoDe(ini)), "Por começar");
    assert.equal(faseProgresso(progressoDe(ini.map((c, i) => (i < 3 ? { ...c, estado: "verificado" as const } : c)))), "A meio");
    assert.equal(faseProgresso(progressoDe(ini.map((c) => ({ ...c, estado: "verificado" as const })))), "Tudo visto");
  });

  test("verificações e correções continuam com números separados no ecrã", () => {
    assert.match(texto(html), /0 de 3 já com resposta/, "a contagem do que já respondeu desapareceu");
    assert.match(texto(html), /0 correções/, "a conta das correções desapareceu do progresso");
  });
});

describe("P0 — motores e definições têm secção própria", () => {
  test("os quatro motores são mostrados e a ausência de data não é inventada", () => {
    assert.match(html, /Definições e motores/);
    for (const nome of ["YARA", "Base de assinaturas", "ClamAV", "Motor nativo"]) assert.ok(html.includes(nome), nome);
    assert.match(html, /O serviço não reportou a data da última atualização de definições nesta leitura/);
    assert.equal(/pendente de atualização/i.test(html), false);
  });
});

describe("P0 — o resumo traz métricas reais e não as soma", () => {
  test("a proteção vem identificada, com a origem escrita ao lado do valor", () => {
    assert.match(html, /Estado global da proteção/);
    assert.match(html, /Ainda sem leitura do motor de proteção/);
    assert.equal(/Tudo protegido|Tudo em ordem|Sistema Protegido/.test(html), false,
      "saúde afirmada sem medição");
  });

  test("a telemetria do PC fica fora do cartão da proteção", () => {
    const cartaoProtecao = entre(htmlComHardware, "Estado global da proteção", "Ver detalhes da proteção");
    assert.equal(/CPU |RAM /.test(cartaoProtecao), false, "a telemetria entrou no cartão da proteção");
    assert.match(htmlComHardware, /CPU 12% · RAM 44%/, "a telemetria do PC desapareceu do resumo");
    assert.match(htmlComHardware, /Este PC agora/);
  });

  test("sem leitura de hardware o cartão diz que não leu, nunca inventa 0%", () => {
    const cartao = entre(html, "Este PC agora", "Verificações automáticas", html.lastIndexOf("Este PC agora"));
    assert.match(cartao, /Sem leitura/);
    assert.equal(/CPU 0%|RAM 0%/.test(html), false, "zero inventado onde não houve leitura");
  });

  test("«problemas comprovados» é um número, e explica de onde vem", () => {
    assert.match(html, /Problemas comprovados/);
    assert.match(html, /Ainda não há problemas comprovados/);
  });
});

describe("P0 — a página ficou mais curta, e o que é raro saiu da frente", () => {
  test("o cabeçalho cabe em duas linhas", () => {
    const lead = /<p class="mt-2 max-w-\[64ch\][^"]*">([^<]+)<\/p>/.exec(html)?.[1] ?? "";
    assert.ok(lead.length > 0, "o lead desapareceu");
    assert.ok(lead.length <= 110, `o lead voltou a ser um parágrafo: ${lead.length} caracteres`);
    for (const secao of ORDEM_SECOES) {
      assert.ok(ROTULO_SECAO[secao].descricao.length <= 110,
        `${secao}: descrição longa (${ROTULO_SECAO[secao].descricao.length})`);
    }
  });

  test("a auditoria técnica continua atrás de um controlo, não à frente", () => {
    assert.match(html, /<details[^>]*>[\s\S]*O que cada botão faz realmente/,
      "a auditoria dos botões saiu do disclosure progressivo");
  });

  test("uma só ação principal no ecrã", () => {
    assert.equal((html.match(/class="[^"]*\bbg-primary\b[^"]*"/g) ?? []).length, 1);
    assert.match(html, /Verificar tudo agora \(3\)/);
  });

  test("a barra do progresso tem tinta — o preenchimento não é uma barra vazia", () => {
    // P0 UX (15/10): `.progress-bar-fill` só declarava altura, raio, transição e
    // sombra. Sem `background`, a barra mostrava a pista e parecia VAZIA a
    // qualquer percentagem — o glow sozinho não é progresso. A tinta vem da
    // primitiva de identidade (`var(--primary)`), nunca de uma classe nova:
    // `bg-primary` continua a ser só da ação cheia (teste acima).
    const bloco = /\.progress-bar-fill\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
    assert.ok(bloco.length > 0, "a primitiva .progress-bar-fill desapareceu da folha");
    assert.match(bloco, /background:\s*var\(--primary\)/, "o preenchimento voltou a não ter tinta");
    assert.match(pagina, /className="progress-bar-fill" style=\{\{ width: `\$\{progresso\.percentagem\}%` \}\}/);
  });

  test("sem emoji como iconografia e sem PT-BR", () => {
    assert.equal(/\p{Extended_Pictographic}/u.test(html), false, "emoji na interface");
    for (const palavra of ["você", "Você", "usuário", "gerenciar", "salvar", "equipe", "planejamento"]) {
      assert.equal(pagina.includes(palavra), false, `PT-BR: ${palavra}`);
    }
  });

  test("o movimento do ecrã é o do sistema de design, e cai com movimento reduzido", () => {
    assert.equal(/framer-motion|AnimatePresence|motion\./.test(pagina), false, "animação JS na página");
    assert.match(pagina, /animate-in fade-in slide-in-from-bottom-4 duration-500/, "a entrada deixou de ser a do Painel");
    assert.equal(/style=\{\{[^}]*(transition|animation)/.test(pagina), false, "movimento escrito à mão");
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });
});

describe("P0 — desenho novo, os mesmos efeitos", () => {
  test("a página só chama as quatro operações aprovadas", () => {
    const chamadas = [...pagina.matchAll(/window\.electronAPI\.(\w+)\(/g)].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(chamadas)].sort(),
      // `getDefinitionsStatus` entrou em 2026-11-01 com a prioridade das definições:
      // o resultado de `updateDefinitions()` por si só não confirma o estado por fonte,
      // e a página passou a ler o estado do serviço em vez de o inferir do pedido.
      ["getDefinitionsStatus", "getWindowsHealth", "startScan", "updateDefinitions"],
      "o redesign mudou o que a página pede ao serviço",
    );
  });

  test("a página continua a saber estar sem ponte para o serviço", () => {
    assert.match(pagina, /if \(!window\.electronAPI\)/);
    assert.match(pagina, /Sem ligação ao motor de proteção nesta janela/);
  });

  test("as três listas usam as primitivas partilhadas, não classes de ocasião", () => {
    for (const classe of ["row-list", "row-item", "state-chip", "icon-tile", "stat-card", "page-shell"]) {
      assert.ok(css.includes(`.${classe}`), `a primitiva ${classe} desapareceu da folha`);
      assert.ok(html.includes(classe), `a primitiva ${classe} deixou de ser usada no ecrã`);
    }
  });
});
