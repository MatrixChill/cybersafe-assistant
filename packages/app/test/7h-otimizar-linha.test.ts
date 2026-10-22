import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CircleCheck, Info } from "lucide-react";

/**
 * 7H (13/10) — UX concentrada da Otimizar: confirmação, hierarquia da linha e
 * anúncio de progresso.
 *
 * Os três defeitos que este ficheiro prende, por ordem de gravidade:
 *
 *  1. a confirmação humana era um painel no TOPO da página — quem clicava
 *     «Iniciar análise» numa linha do meio ficava com o texto que explica o
 *     custo fora do ecrã, e havia dois controlos «Confirmar» no mesmo ecrã;
 *  2. a linha mostrava o `motivo` do catálogo (frase fixa, igual para toda a
 *     gente) à frente do resultado medido, e o `resumoEstado` dizia outra vez o
 *     que o chip já dizia — ou, no cartão marcado à mão, afirmava
 *     «Verificado: sem falha» sobre algo que nunca foi medido;
 *  3. o único resumo numérico que se atualiza quando o bloco termina não era
 *     uma região viva, por isso leitor de ecrã não dizia nada.
 *
 * Renderiza `LinhaOtimizar` com cartões em cada estado: é a única forma de
 * testar markup de interação sem DOM, porque a página em markup estático só
 * mostra o estado inicial.
 */

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { default: OtimizarPage, LinhaOtimizar } = await import("../src/pages/OtimizarPage");
const {
  aplicarDesfecho,
  cartoesIniciais,
  marcarRevisaoManual,
} = await import("../src/lib/optimizeModel");
import type { OptimizeCartao } from "../src/lib/optimizeModel";

const fonte = readFileSync(new URL("../src/pages/OtimizarPage.tsx", import.meta.url), "utf8");

const na = (overrides: Partial<OptimizeCartao> = {}): OptimizeCartao => ({
  ...cartoesIniciais()[0],
  ...overrides,
});

/** Linha sozinha, com as defaults de uma página parada. */
function linha(cartao: OptimizeCartao, extra: Partial<React.ComponentProps<typeof LinhaOtimizar>> = {}): string {
  return renderToStaticMarkup(createElement(LinhaOtimizar, {
    cartao,
    indice: null,
    aOcupado: false,
    aCorrer: false,
    emConfirmacao: false,
    onExecutar: () => {},
    onDesfazer: () => {},
    onCancelarConfirmacao: () => {},
    ...extra,
  }));
}

const texto = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("7H — a confirmação vive na linha que a pediu", () => {
  test("o painel de topo desapareceu da página", () => {
    assert.equal(fonte.includes("Esta ação precisa da tua confirmação"), false,
      "voltou o painel fora do contexto da linha");
    assert.equal(/role="alert"/.test(renderToStaticMarkup(createElement(OtimizarPage, {}))), false,
      "há um alerta no arranque, sem nada para confirmar");
  });

  test("em confirmação, a linha mostra o custo, um só Confirmar e um Cancelar", () => {
    const alvo = na({
      id: "analise-profunda",
      titulo: "Análise profunda do computador",
      confirmar: "Arranca uma análise demorada em todas as pastas do teu utilizador.",
    });
    const html = linha(alvo, { emConfirmacao: true });
    assert.match(html, /role="alert"/, "o portão não é anunciado a um leitor de ecrã");
    assert.match(html, /Arranca uma análise demorada/, "o texto que explica o custo não está na linha");
    assert.match(html, />Cancelar</, "não há como sair da confirmação sem a confirmar");
    assert.match(html, /aria-label="Cancelar a confirmação de Análise profunda do computador"/,
      "o Cancelar não diz a que linha pertence");
    assert.equal((html.match(/>Confirmar</g) ?? []).length, 1,
      "dois controlos «Confirmar» na mesma linha");
  });

  test("fora de confirmação não há gate fantasma na linha", () => {
    const html = linha(na({ confirmar: "Isto demora." }), { emConfirmacao: false });
    assert.equal(/role="alert"/.test(html), false, "alerta permanente");
    assert.equal(html.includes(">Cancelar<"), false, "Cancelar sem nada para cancelar");
    assert.equal(html.includes("Isto demora."), false, "o texto do gate mostra-se sem o gate");
  });

  test("o Confirmar da linha é a única tinta cheia enquanto confirma", () => {
    const alvo = na({ confirmar: "Isto demora." });
    const emConfirmacao = linha(alvo, { emConfirmacao: true });
    const normal = linha(alvo);
    assert.match(emConfirmacao, /class="[^"]*bg-primary text-primary-foreground[^"]*"/,
      "o botão de confirmar perdeu a ênfase");
    assert.equal(normal.includes("bg-primary text-primary-foreground"), false,
      "a ação de linha veste a tinta da ação principal fora da confirmação");
  });
});

describe("7H — a linha lidera com o que foi medido", () => {
  test("pendente: o motivo é corpo de leitura e o estado diz que ainda não foi visto", () => {
    const html = linha(na());
    assert.match(html, /class="row-note">É a primeira barreira/, "motivo deixado de fora no pendente");
    assert.match(html, /Ainda não foi visto/, "pendente sem estado");
  });

  test("medido: a resposta vem antes do motivo, e o motivo desce um degrau", () => {
    const medido = aplicarDesfecho(na(), "verificacao", {
      ok: true,
      evidencia: "ativo nos perfis: Domínio, Público",
      mensagem: "Nada a fazer: o firewall está ativo.",
    });
    const html = linha(medido);
    const corpo = texto(html);
    assert.ok(corpo.indexOf("Nada a fazer: o firewall está ativo.") >= 0, "a resposta desapareceu");
    assert.ok(
      corpo.indexOf("Nada a fazer: o firewall está ativo.")
        < corpo.indexOf("É a primeira barreira às ligações"),
      "o catálogo voltou à frente do resultado medido",
    );
    assert.match(html, /class="row-meta">É a primeira barreira/, "o motivo não desceu para nota");
    assert.match(html, /evidence-line/, "a evidência perdeu o degrau rebaixado");
  });

  test("medido: o chip e a resposta não dizem a mesma coisa duas vezes", () => {
    const medido = aplicarDesfecho(na(), "verificacao", { ok: true, mensagem: "Nada a fazer." });
    const html = linha(medido);
    assert.equal(html.includes("Verificado: sem falha"), false,
      "resumo redundante (ou falso) por cima da resposta");
    assert.match(html, /Saudável/, "o chip de classificação desapareceu com a mudança");
  });

  test("marcado à mão: nada afirma «sem falha», porque nada foi medido", () => {
    const manual = marcarRevisaoManual(
      na({ id: "senhas", titulo: "Senhas únicas por conta", tipo: "boa-pratica", acaoTipo: "educativa" }),
      "Marcado como revisto por ti às 07:40:00.",
    );
    const html = texto(linha(manual));
    assert.match(html, /Marcado como revisto por ti/, "a afirmação da pessoa desapareceu da linha");
    assert.equal(html.includes("sem falha"), false, "verificação inventada sobre um toggle manual");
    assert.match(html, /Revista/, "o chip diz outra coisa que não «marcado por ti»");
  });

  test("os dez cartões nunca perdem o motivo, com resposta ou sem ela", () => {
    for (const base of cartoesIniciais()) {
      const pendente = linha(base);
      const comResposta = linha(aplicarDesfecho(base, base.acaoTipo === "correcao" ? "correcao" : "verificacao", {
        ok: true,
        mensagem: "Resultado da operação.",
      }));
      assert.ok(pendente.includes(base.motivo), `${base.id}: motivo ausente no pendente`);
      assert.ok(comResposta.includes(base.motivo), `${base.id}: motivo desapareceu com resposta`);
    }
  });

  test("a linha em voo continua a dizer «A consultar…» e a executar tem nome", () => {
    const html = linha(na(), { aCorrer: true, aOcupado: true });
    assert.match(html, /state-chip--proc/, "o carregamento perdeu a tinta de estado");
    assert.match(html, /A consultar…/, "a linha mostra o rótulo do catálogo enquanto pede");
    assert.match(html, /aria-label="A executar — Firewall do Windows"/, "o botão em voo mudou de nome acessível");
  });

  test("tinta de alerta só com severidade medida — nem em voo, nem por catálogo", () => {
    assert.equal(linha(na()).includes("border-l-cyber-red"), false, "vermelho no pendente");
    assert.equal(linha(na(), { aCorrer: true }).includes("border-l-cyber-red"), false, "vermelho em voo");
    const medidoCritico = aplicarDesfecho(na(), "verificacao", {
      ok: true,
      severidade: "critico",
      mensagem: "O firewall está desligado.",
    });
    assert.match(linha(medidoCritico), /border-l-cyber-red/, "a falha medida não tem tinta");
  });

  test("instrução: some onde foi corrigido, fica vermelha onde a medição é crítica", () => {
    const comInstrucao = na({ instrucao: "Liga-o em Definições → Segurança do Windows." });
    assert.match(linha(comInstrucao), /Liga-o em Definições/, "instrução ausente no pendente");
    const corrigido = linha({ ...comInstrucao, estado: "corrigido", mensagem: "Feito." });
    assert.equal(corrigido.includes("Liga-o em Definições"), false, "instrução depois de corrigido");
    const critico = linha({ ...comInstrucao, estado: "verificado", resultado: "problema", severidade: "critico", mensagem: "Desligado." });
    assert.match(critico, /class="row-note text-cyber-red">Liga-o/, "a instrução de uma falha crítica é nota cinzenta");
  });
});

describe("7H — topo: números, definição e anúncio", () => {
  const html = renderToStaticMarkup(createElement(OtimizarPage, {}));

  test("a frase de progresso é uma região viva e bate com a barra", () => {
    assert.match(html, /aria-live="polite">0 de 10 vistos \(0%\)/,
      "o resumo que muda com as operações não é anunciado");
    const barra = /aria-valuenow="(\d+)"/.exec(html)?.[1];
    const naFrase = /aria-live="polite">(\d+) de \d+ vistos/.exec(html)?.[1];
    assert.equal(barra, naFrase, "a barra e a frase dizem números diferentes");
  });

  test("a página declara quando está ocupada", () => {
    assert.match(html, /aria-busy="false"/, "sem estado de ocupação no arranque");
    assert.match(fonte, /aria-busy=\{aExecutar !== null\}/, "o ocupação não está ligada ao pedido em voo");
  });

  test("a definição de «Vistos» vive junto do número que define", () => {
    // 15/10: a nota deixou de ser um parágrafo no meio do ecrã e passou a viver
    // DENTRO do bloco do progresso — o número que ela define fica ao lado dela.
    const bloco = html.slice(html.indexOf("Progresso"), html.indexOf("Estado global da proteção"));
    assert.match(bloco, /class="row-meta">«Vistos» é o que já foi medido ou tentado/,
      "a nota saiu do bloco do número que define");
    assert.match(bloco, /tabular-nums/, "o bloco do progresso perdeu o número");
    assert.match(bloco, /state-chip state-chip--na">Por começar/, "o número voltou a aparecer sem fase");
    assert.equal(html.includes('class="max-w-[82ch] text-sm leading-relaxed text-muted-foreground"'), false,
      "o parágrafo solto regressou");
    assert.equal(bloco.includes("Estado global"), false, "a nota transbordou para o resumo");
  });

  test("o que falta se diz uma vez só, junto do número que define", () => {
    assert.match(html, /aria-live="polite">0 de 10 vistos \(0%\) · faltam 10/);
    assert.equal(/\d+ por ver\b/.test(html), false,
      "a mesma contagem em dois sítios: duas oportunidades de divergir");
  });

  test("lista de problemas vazia não se disfarça de boa notícia", () => {
    /** O glifo compara-se por assinatura de SVG, não por nome: é o que estava a
        aparecer no ecrã que interessa, e o nome `lucide` não sai no markup. */
    const assinatura = (icone: React.ElementType) =>
      renderToStaticMarkup(createElement(icone, { className: "h-4 w-4" })).replace(/<\/?svg[^>]*>/g, "");
    assert.equal(html.includes(assinatura(CircleCheck)), false,
      "check de «sem problemas» mostrado antes de qualquer medição");
    assert.equal(html.includes(assinatura(Info)), true, "o vazio por medir não tem o Info de «a fazer»");
    assert.match(fonte, /progresso\.vistos > 0 \? <CircleCheck className="h-4 w-4" \/> : <Info className="h-4 w-4" \/>/,
      "o ícone do vazio deixou de depender de haver medição");
  });

  test("o resumo não corta em janela estreita", () => {
    assert.match(html, /class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"/,
      "o resumo deixou de embrulhar por largura");
    assert.match(html, /class="min-w-0"/, "a coluna do resumo pode transbordar o pai");
    assert.match(html, /class="mt-auto space-y-1.5"/,
      "a ação principal deixou de acompanhar o fundo do cartão");
  });

  test("o número de cada lista diz o que é, e as três somam o total", () => {
    const contagens = [...html.matchAll(/>(\d+)\s+linhas?\s*</g)].map((m) => Number(m[1]));
    assert.equal(contagens.length, 3, "as três listas não mostram a sua conta");
    assert.equal(contagens.reduce((a, b) => a + b, 0), 10, "a conta das listas não bate com os cartões");
    // A composição por natureza faz parte do desenho: mexer-lhe sem querer
    // (mudar `acaoTipo` de um cartão, por exemplo) muda a promessa do ecrã.
    assert.deepEqual(contagens, [3, 2, 5], "as listas por natureza mudaram de composição");
  });

  test("sem nada para correr, a ação diz «Nada por verificar» e explica porquê", () => {
    assert.match(fonte, /porVerificar\.length === 0 \? "Nada por verificar"/,
      "o botão continua a chamar-se «Verificar tudo agora (0)» estando desativado");
    assert.match(fonte, /\{!aExecutar && porVerificar\.length === 0 && \(/,
      "a razão do desativar não é dita junto do botão");
    // No arranque há três elegíveis: o rótulo com a conta mantém-se.
    assert.match(html, /Verificar tudo agora \(3\)/);
  });
});
