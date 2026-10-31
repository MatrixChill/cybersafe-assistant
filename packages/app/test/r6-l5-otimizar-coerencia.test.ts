import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * R6-L5 4 — coerência de casca e vocabulário fechado.
 *
 * A medição humana da ronda anterior foi OPTIMIZE_R5_LAYOUT_HUMAN =
 * MELHORIA NECESSÁRIA, e a causa mais concreta era de ritmo, não de gosto: a
 * app tinha três cascas de página diferentes — o Painel com 16 px de margem, a
 * Otimizar com 20/32 px, e as Configurações com 24/32 px. Isto prende a régua
 * única e, ao mesmo tempo, fecha a porta que abre classe inventada: nenhuma
 * primitiva de produto é usada por uma página sem existir na folha.
 *
 * O que NÃO mede: se o ritmo fica bom ao olho. Isso é o humano.
 */

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => fs.readFileSync(path.join(HERE, "..", ...parts), "utf8");
const css = read("src", "index.css");
const decls = css.replace(/\/\*[\s\S]*?\*\//g, "");

const { default: OtimizarPage } = await import("../src/pages/OtimizarPage");
const html = renderToStaticMarkup(createElement(OtimizarPage, {}));
const htmlComHardware = renderToStaticMarkup(createElement(OtimizarPage, {
  hardware: { cpu: { usage: 12, usageStatus: "available", usageUpdatedAt: new Date(Date.now() - 1000).toISOString() }, ram: { usagePercent: 44, usageStatus: "available", usageUpdatedAt: new Date(Date.now() - 1000).toISOString() }, disk: { primary: null } } as never,
}));

/** Com a fonte única a responder: é o que o App passa quando o serviço devolve
    estado. Os testes de ORIGEM e SEMÂNTICA lêem este markup; os de
    APRESENTAÇÃO lêem o `html` sem prop, que é o caso «sem leitura». */
const htmlProtegido = renderToStaticMarkup(createElement(OtimizarPage, {
  protecao: {
    nivel: "protected",
    estado: "safe",
    pontuacao: 92,
    tempoReal: { enabled: true, pausedUntil: null },
    servicoLigado: true,
    aCarregar: false,
    motores: {
      serviceRunning: true,
      osLayerHealthy: true,
      degradedReasons: [],
      monitoredPaths: [],
      yara: { status: "active" },
      hashDb: { status: "active" },
      clamav: { status: "degraded", detail: "sem base de assinaturas" },
      nativeEngine: { status: "active" },
    },
  },
}));

/** As réguas que a casca usa, lidas da própria folha. */
const token = (nome: string): string | null => {
  const m = new RegExp(`--${nome}:\\s*([^;]+);`).exec(decls);
  return m ? m[1].trim() : null;
};

describe("R6-L5 4 — uma só casca de página", () => {
  test("`.page-shell` existe e é feita de réguas, não de literais soltos", () => {
    const inicio = decls.indexOf(".page-shell {");
    assert.ok(inicio >= 0, "falta a regra .page-shell");
    const corpo = decls.slice(inicio, decls.indexOf("}", inicio));
    assert.match(corpo, /padding: var\(--space-4\)/);
    assert.match(corpo, /gap: var\(--space-4\)/);
    assert.equal(/padding: \d/.test(corpo), false, "literal de padding fora da escala");
    const larga = decls.slice(decls.indexOf("@media (min-width: 1024px)"));
    assert.match(larga.slice(0, 400), /\.page-shell \{\s*padding: var\(--space-6\);\s*gap: var\(--space-5\);/);
  });

  test("a régua do Painel é uma só, declarada na folha do lab — não as utilities de V1", () => {
    assert.equal(token("space-4"), "1rem");
    assert.equal(token("space-5"), "1.25rem");
    assert.equal(token("space-6"), "1.5rem");
    // Migração V2-FIRST (mapa em `out/MAPA-TESTES-V2-FIRST.md`): `p-4 lg:p-6
    // space-y-4` era a raiz de V1. A página passou a ser a composição do lab,
    // com régua própria declarada uma vez. Isto é uma DIVERGÊNCIA ASSUMIDA entre
    // o Painel e as páginas que ficaram em V1 — por isso a régua fica escrita
    // aqui: se alguém mudar 30/34 em silêncio, este teste falha.
    const painel = read("src", "v2", "dashboard", "LabDashboard.tsx");
    assert.match(painel, /className="v2-dashboard"/, "a raiz do Painel está identificada");
    const fonte = read("src", "v2", "dashboard", "LabDashboard.tsx");
    const folha = read("src", "v2", "dashboard", "lab-dashboard.css").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.equal(/p-4|lg:p-6|space-y-4/.test(fonte), false, "as utilities de V1 não coexistem com a folha do lab");
    // O que vale é a última declaração para o seletor (cascade), e é isso que se
    // fixa aqui. QUE a folha do lab traz três camadas transcritas e sete
    // declarações de padding para esta raiz — quatro delas já não chegam ao
    // ecrã; vai no handoff como item por consolidar.
    const paddingRaiz = [...folha.matchAll(/\.cs-v2 \.v2-dashboard\s*\{[^}]*padding:\s*([^;}]+)/g)].map((m) => m[1].trim());
    assert.ok(paddingRaiz.length > 0, "a raiz do Painel não declara padding em lado nenhum");
    assert.equal(paddingRaiz[paddingRaiz.length - 1], "26px 24px 0", "a régua efetiva do Painel mudou sem declaração");
    assert.equal(/30px 34px/.test(paddingRaiz[paddingRaiz.length - 1]), false, "a régua base de V1 do lab não é a que vence");
  });

  test("Otimizar e Configurações lêem a casca; nenhuma ficou com ritmo próprio", () => {
    for (const [nome, fonte] of [["OtimizarPage", read("src", "pages", "OtimizarPage.tsx")], ["SettingsPage", read("src", "pages", "SettingsPage.tsx")]] as const) {
      // A RAIZ, não um divisor qualquer: o que pode ter ritmo próprio é a
      // casca da página; por dentro, `space-y-*` é assunto de cada secção.
      const raiz = /<div className="([^"]*page-shell[^"]*)"/.exec(fonte);
      assert.ok(raiz, `${nome}: sem a casca partilhada na raiz`);
      assert.equal(/space-y-\d/.test(raiz[1]), false, `${nome}: espaçamento próprio na raiz: ${raiz[1]}`);
      assert.equal(/(^|\s)p-\d|lg:p-\d/.test(raiz[1]), false, `${nome}: margem própria na raiz: ${raiz[1]}`);
    }
  });

  test("a entrada do Painel é a do lab e cai com o travão de movimento", () => {
    const otimizar = read("src", "pages", "OtimizarPage.tsx");
    const fonte = read("src", "v2", "dashboard", "LabDashboard.tsx");
    // O `animate-in` de V1 saiu com a página; a animação do lab é governada
    // pelo eixo, e o travão de sistema continua a ser o de sempre.
    assert.equal(fonte.includes("animate-in"), false, "a utility de entrada de V1 não volta ao Painel");
    assert.match(fonte, /data-reduced=/, "o Painel publica o estado de movimento no nó raiz");
    assert.match(otimizar, /animate-in/, "as páginas V1 mantêm a entrada que lhes é própria");
    assert.match(decls, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,400}animation-duration: 0\.01ms !important/);
    const ponte = read("src", "v2", "bridge.css").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(ponte, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,400}--v2-motion: 0/, "o eixo V2 obedece à preferência do sistema");
    const casca = read("src", "v2", "shell.css").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(casca, /html\[data-reduced="true"\][\s\S]{0,320}transition-duration: 0ms !important/, "com movimento a 0 nada se anima no shell");
  });
});

describe("R6-L5 4b — o vocabulário de produto está fechado", () => {
  /** Só as primitivas do sistema de design; os utilitários do Tailwind ficam
      fora, porque esses são gerados. `sec-dot` entrou a 15/10 (feedback humano
      da C4: organização e legibilidade melhores, mas página monocromática) e
      entrou PORQUE foi admitido aqui — é esse o propósito desta lista: nenhuma
      classe nova chega ao ecrã sem que alguém a tenha assumido. */
  const PREFIXOS = /^(state-chip|icon-tile|sec-dot|row-|eyebrow-label|evidence-line|panel-translucent|page-shell|surface-elevated|surface-sunken|stat-card|hero-banner|cyber-|liquid-bg|scanlines|progress-bar-)/;

  test("toda a primitiva usada no ecrã existe na folha", () => {
    const usadas = new Set<string>();
    for (const m of html.matchAll(/class="([^"]*)"/g)) {
      for (const classe of m[1].split(/\s+/)) if (PREFIXOS.test(classe)) usadas.add(classe);
    }
    const dormentes = [...usadas].filter((c) => !decls.includes(`.${c}`));
    assert.ok(usadas.size >= 8, `esperava ver as primitivas todas, vi ${usadas.size}`);
    assert.equal(dormentes.length, 0, `classes sem regra: ${dormentes.join(", ")}`);
  });

  test("o estado neutro tem argola no chip e NENHUMA tinta de estado no mosaico", () => {
    assert.match(decls, /\.state-chip--na::before \{[^}]*background: transparent/);
    // O mosaico neutro não inventa modificador: se alguém criar `.icon-tile--na`
    // sem regra, a linha fica sem cor nenhuma por engano.
    assert.equal(decls.includes(".icon-tile--na"), false, "modificador sem regra");
    assert.match(decls, /^\.icon-tile \{/m, "a forma base do mosaico desapareceu da folha");

    /* 15/10 — a regra que este teste prendia era `class="icon-tile"` nu. Ela
       confundia duas coisas: a AUSÊNCIA de tinta de estado com a ausência de
       cor toda. Desde o feedback da C4, uma linha pendente pode levar tinta de
       SECCÃO (verificação/manutenção) porque isso não é um resultado — o que
       continua proibido, e agora assertado diretamente, é tinta de ESTADO sem
       medição. A distinção é a do sistema: chip = estado medido; mosaico =
       natureza da linha. */
    assert.equal(/icon-tile--(ok|warn|crit)/.test(html), false, "tinta de estado num ecrã sem medição");
    assert.match(html, /icon-tile--sec-/, "a identidade de secção não está a ser usada");
    for (const variante of ["sec-check", "sec-maint", "sec-manual"]) {
      assert.ok(decls.includes(`.icon-tile--${variante}`), `falta a regra .icon-tile--${variante}`);
    }
  });

  test("as tintas de estado do ecrã vêm dos tokens medidos, não de cores da página", () => {
    // O neutro é a regra BASE `.state-chip`, por isso não tem modificador de cor.
    for (const estado of ["ok", "warn", "crit", "proc"]) {
      assert.ok(decls.includes(`--state-${estado}-ink:`), `falta --state-${estado}-ink`);
      assert.ok(decls.includes("--state-na-ink:"));
      const regra = decls.slice(decls.indexOf(`.state-chip--${estado}`));
      assert.match(regra.slice(0, 220), new RegExp(`color: var\\(--state-${estado}-ink\\)`), `.state-chip--${estado} não lê a tinta medida`);
    }
    // Nada de vermelho nem âmbar no ecrã antes de haver medição (o defeito que
    // a ronda 5 apanhou) — reconfirmado aqui pelo markup renderizado.
    assert.equal(/state-chip--(crit|warn)/.test(html), false, "tinta de estado sem medição");
  });
});

/* ═══ R6-L5-UX A — destaque do tema, ícones e rótulos ═════════════════════ */

describe("R6-L5-UX A — o destaque vem do tema e o ícone descreve a ação", () => {
  test("`.page-title` usa só tokens do tema, sem cor escrita na classe", () => {
    const inicio = decls.indexOf(".page-title {");
    assert.ok(inicio >= 0, "falta a regra .page-title");
    const corpo = decls.slice(inicio, decls.indexOf("}", inicio));
    assert.match(corpo, /var\(--nav-active-bar\)/, "a régua não lê o token de destaque do tema");
    assert.match(corpo, /var\(--shell-nav-bar-w\)/, "a espessura vem da métrica do shell");
    assert.equal(/#[0-9a-fA-F]{3,8}|rgba?\(/.test(corpo), false, "cor escrita na classe de título");
    // Vai por box-shadow inset: mudar de acento não desloca o título.
    assert.equal(/border-left/.test(corpo), false, "border deslocaria a caixa");
  });

  test("Otimizar e Configurações usam o título realçado; nenhum fixou cor", () => {
    for (const nome of ["OtimizarPage", "SettingsPage"] as const) {
      const fonte = read("src", "pages", `${nome}.tsx`);
      assert.match(fonte, /<h1 className="page-title/, `${nome}: título sem o padrão de destaque`);
      assert.equal(/<h1[^>]*text-\[(#|\d)/.test(fonte), false, `${nome}: cor fixa no título`);
    }
  });

  test("o ícone diz o que a linha faz — e não o tom do estado", () => {
    const fonte = read("src", "pages", "OtimizarPage.tsx");
    assert.match(fonte, /"analise-profunda": ScanSearch/, "análise profunda não é um alerta");
    assert.match(fonte, /startup: Power/, "arranque do Windows não é a CPU");
    assert.match(fonte, /backup: DatabaseBackup/, "cópia de segurança não é um download");
    assert.match(fonte, /extensoes: Puzzle/, "extensão não é «vigiar»");
    assert.equal(/"analise-profunda": AlertTriangle/.test(fonte), false, "voltou o ícone de alarme na análise");
    assert.equal(/AlertTriangle/.test(fonte), false, "AlertTriangle já não tem uso nesta página");
  });

  test("cada botão de linha diz QUAL linha é, não só «Verificar»", () => {
    assert.match(htmlProtegido, /aria-label="[^"]+ — Firewall do Windows"/);
    const rotulos = [...html.matchAll(/aria-label="([^"]*—[^"]*)"/g)].map((m) => m[1]);
    assert.ok(rotulos.length >= 8, `esperava rótulos em todas as ações de linha, obtive ${rotulos.length}`);
    assert.equal(new Set(rotulos).size, rotulos.length, "dois botões com o mesmo rótulo acessível");
  });

  test("as alavancas das Configurações deixaram de ser brancas sobre superficie clara", () => {
    const fonte = read("src", "pages", "SettingsPage.tsx");
    assert.equal(/rounded-full bg-white/.test(fonte), false, "knob com branco fixo: invisível nos temas claros");
    assert.match(fonte, /rounded-full bg-card border border-border/);
  });

  test("a telemetria do PC continua noutro plano — nunca dentro da faixa de proteção", () => {
    // Com hardware lido, a página mostra CPU/RAM nos contadores de trabalho.
    // Isso não pode aparecer dentro da faixa do estado global, que é só do
    // motor de proteção.
    assert.match(htmlComHardware, /CPU \d+% · RAM \d+%/);
    const faixa = htmlComHardware.slice(
      htmlComHardware.indexOf("Estado global da proteção"),
      htmlComHardware.indexOf("Ver detalhes da proteção"),
    );
    assert.ok(faixa.length > 40, "não se encontrou a faixa global");
    for (const intruso of ["CPU ", "RAM ", "problema", "correç"]) {
      assert.equal(faixa.includes(intruso), false, `medida de fora entrou na faixa global: ${intruso}`);
    }
  });

  test("o tom de carregamento vem do pedido em voo, não do catálogo", () => {
    const fonte = read("src", "pages", "OtimizarPage.tsx");
    assert.match(fonte, /const tom = aCorrer \? "proc" : tomVisual\(cartao\)/);
    // E no arranque (sem pedido em voo) a tinta de estado continua toda neutra.
    assert.equal((html.match(/state-chip--(crit|warn|proc)/g) ?? []).length, 0,
      "há tinta de estado sem pedido em voo nem medição");
  });
});

/* ═══ R6-L5 4b — botão explícito de detalhes da proteção ══════════════════ */

describe("R6-L5 4c — «Ver detalhes da proteção» é um botão, não um chip disfarçado", () => {
  test("o ecrã tem o botão nomeado, com o contorno de linha partilhado", () => {
    const botões = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);
    const alvo = botões.find((b) => b.replace(/<[^>]+>/g, "").trim() === "Ver detalhes da proteção");
    assert.ok(alvo, `o botão nomeado não está entre os ${botões.length} botões do ecrã`);
    assert.match(alvo, /class="[^"]*\bborder-border\b/, "o botão novo não usa o contorno partilhado");
    assert.equal(/bg-primary/.test(alvo), false, "vestiu a tinta da ação principal");
    // A ação cheia deste ecrã continua a ser UMA (o contrato da ronda 6-L1).
    assert.equal((html.match(/class="[^"]*\bbg-primary\b[^"]*"/g) ?? []).length, 1,
      "o botão novo vestiu a tinta da ação principal");
  });

  /**
   * CONTRATO REVISTO (R6-L5-UX). A versão anterior proibia o diálogo de receber
   * `engine` ou `score`, com a justificação de que «a Otimizar não lê os
   * motores, logo mostraria números emprestados». A regra estava mal escrita:
   * confundia AUSÊNCIA de dado com AUSÊNCIA de ORIGEM. O motor de proteção é
   * um só para a app, e o Painel já o lê — proibir a passagem produzia o
   * resultado pior: ou nada se mostrava, ou a página inventava um nível a partir
   * do firewall (que foi exatamente o que aconteceu uma vez).
   *
   * O contrato passa a exigir três coisas, e é isto que se verifica abaixo:
   *   ORIGEM      — o dado vem da fonte única do app (`protection`/App), nunca
   *                 de um cálculo local da página;
   *   SEMÂNTICA   — diz «estado GLOBAL da proteção» e separa tempo real,
   *                 motores e estado do PC; não soma nenhuma das três;
   *   APRESENTAÇÃO— sem leitura, o fallback honesto mantém-se: `degraded` +
   *                 «sem leitura»/«a ler», nunca um verde por omissão.
   */
  test("ORIGEM: o nível, os motores e a pontuação chegam do App, não da página", () => {
    const app = read("src", "App.tsx");
    const fonte = read("src", "pages", "OtimizarPage.tsx");
    const chamada = /<OtimizarPage[\s\S]{0,900}\/>/.exec(app.replace(/\s+/g, " "));
    assert.ok(chamada, "o App não liga a proteção à Otimizar");
    const corpo = chamada[0];
    assert.match(corpo, /nivel: protectionLevel/, "nível não vem do App");
    assert.match(corpo, /motores: protection\?\.engine/, "motores não vêm do App");
    assert.match(corpo, /pontuacao: dashboard\.riskScore/, "pontuação não vem do App");
    assert.match(corpo, /tempoReal: realtimeInfo/, "tempo real não vem do App");
    // A mesma fonte que o Painel, sem segunda leitura nem segunda derivação.
    // O terceiro argumento (realtimeInfo ?? {}) e o contrato actual: o nivel
    // do App incorpora a leitura do tempo real; continua UMA unica derivacao.
    assert.match(app, /protectionLevel = serviceConnected === false \? "critical" : protection\s*\?\s*deriveProtectionLevel\(protection\.status, protection\.engine,\s*realtimeInfo\s*\?\?\s*\{\}\)/);
    assert.equal(/deriveProtectionLevel,/.test(fonte), false, "a página voltou a importar o derivedor para calcular por conta própria");
  });

  test("SEMÂNTICA: diz «global», nomeia a origem e separa as três perguntas", () => {
    assert.match(htmlProtegido, /Estado global da proteção/);
    assert.match(htmlProtegido, /Sistema Protegido/);
    assert.match(htmlProtegido, /Tempo real: Ativa/);
    assert.match(htmlProtegido, /Motores: 3 de 4 a responder/);
    assert.match(htmlProtegido, /Origem: motor de proteção[\s\S]{0,200}mesma leitura do Painel/);
    // O estado do PC é outro plano e fica dito como tal — nada soma as duas
    // coisas num número só (contra-exemplo: «Proteção: 82% · PC: 40%»).
    assert.match(htmlProtegido, /O estado do PC é outra medida/);
    assert.equal(/<span[^>]*>[^<]*\d+%\s*·\s*(Proteç|proteç)/.test(htmlProtegido), false,
      "percentagem de proteção misturada com outra medida");
    assert.equal(/riskScore|pcState/.test(read("src", "pages", "OtimizarPage.tsx")), false,
      "a página a ler fontes que não lhe pertencem");
  });

  test("APRESENTAÇÃO: sem leitura não há verde; com pedido em voo há carregamento", () => {
    const fonte = read("src", "pages", "OtimizarPage.tsx");
    assert.match(fonte, /nivel: "degraded",\s*\n\s*estado: null/, "o valor por omissão deixou de ser «não sei»");
    assert.match(html, /sem leitura do motor|Ainda sem leitura do motor de proteção|Sem ligação ao serviço/);
    for (const afirmação of ["Protegido", "Tudo protegido", "proteção ativa"]) {
      assert.equal(html.includes(afirmação), false, `afirmado sem medição: ${afirmação}`);
    }
    // Carregamento do estado global e das linhas (é assim que o firewall tem
    // estado de «a ler», e não um rótulo de catálogo enquanto a pergunta vai).
    assert.match(fonte, /const aLerEstado = protecao\.aCarregar && semLeitura/);
    assert.match(fonte, /\{aLerEstado \? \(/);
    assert.match(fonte, /A ler o estado de proteção…/);
    assert.match(fonte, /const tom = aCorrer \? "proc" : tomVisual\(cartao\)/);
    assert.match(fonte, /\{aCorrer \? "A consultar…" : classe\.rotulo\}/);
    // O diálogo não existe no markup enquanto está fechado (`open={false}`).
    assert.equal(html.includes("Ver detalhes técnicos"), false, "o modal renderiza sem estar aberto");
  });

  test("o diálogo abre com o MOTOR, a PONTUAÇÃO e o NÍVEL da fonte única", () => {
    const fonte = read("src", "pages", "OtimizarPage.tsx");
    assert.match(fonte, /import ProtectionDetails from "@\/components\/ProtectionDetails"/);
    assert.match(fonte, /<ProtectionDetails\s+level=\{protecao\.nivel\}\s+engine=\{protecao\.motores\}\s+score=\{protecao\.pontuacao \?\? undefined\}/);
    // E continua sem inventar: sem prop, nada é passado como se fosse lido.
    assert.match(fonte, /const protecao = protecaoGlobal \?\? SEM_LEITURA/);
  });
});
