import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QuarantinePage from "../src/pages/QuarantinePage";
import type { QuarantineEntry } from "@cybersafe/shared-types";

/**
 * TP-PAP-QUARANTINE-V2-20261027 (Qoder) — vocabulário visual medido e
 * acessibilidade da lista de quarentena.
 *
 * O que isto prova, exatamente:
 *  - Render REAL do componente (React 19 + `react-dom/server`), sem DOM, sem
 *    jsdom, sem dependências novas — o mesmo caminho do `7h-usb-ssr.test.ts` e
 *    do `recovery-quarantine-ui.test.ts`. Nada de `window` falso instalado.
 *  - O render acontece DENTRA de cada `test()`: um throw é contado como falha.
 *
 * O que NÃO prova (declarado, não escondido):
 *  - Estado de clique. `renderToStaticMarkup` só vê o estado inicial, por isso
 *    expanded/pending/busy/error/ok não são exercitados aqui. Os três testes
 *    marcados como «prova estática» leem o fonte para verificar que esses ramos
 *    estão ligados — isso é verificação estrutural, NÃO simulação de evento.
 *  - Contraste resolvido em ecrã, prefers-reduced-motion real e comportamento
 *    em Electron: ficam para a avaliação visual manual do Codex Lead.
 */

(globalThis as Record<string, unknown>).React = React;

const fontePagina = readFileSync(new URL("../src/pages/QuarantinePage.tsx", import.meta.url), "utf8");
const fonteTemas = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

const entrada = (overrides: Partial<QuarantineEntry> = {}): QuarantineEntry => ({
  id: "e1",
  originalPath: "C:\\temp\\ameaca.dll",
  quarantinePath: "C:\\quarantine\\e1",
  fileName: "ameaca.dll",
  sha256: "a".repeat(64),
  verdict: "malicious",
  riskScore: 90,
  quarantinedAt: "2026-10-27T10:00:00.000Z",
  ...overrides,
});

const render = (entries: QuarantineEntry[], extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(QuarantinePage, { entries, onChanged: () => {}, embedded: true, ...extra }),
  );

/** Todas as etiquetas de botão renderizadas. */
function botoes(html: string): string[] {
  return html.match(/<button[^>]*>/g) ?? [];
}

describe("TP QUARANTINE V2 — severidade emprestada não pinta suspeita de crítico", () => {
  test("malicioso chega ao chip e ao mosaico críticos", () => {
    const html = render([entrada()]);
    assert.match(html, /state-chip state-chip--crit/);
    assert.match(html, /icon-tile icon-tile--crit/);
    assert.match(html, /Malicioso/);
  });

  test("suspeito é AVISO, não crítico: sem tinta crítica na linha", () => {
    const html = render([entrada({ verdict: "suspicious", fileName: "suspeito.exe" })]);
    assert.match(html, /state-chip state-chip--warn/);
    assert.doesNotMatch(html, /state-chip--crit|icon-tile--crit/, "suspeita não é classificação confirmada");
  });

  test("veredicto desconhecido lê-se como POR MEDIR (argola), não como verde nem como falha", () => {
    const html = render([entrada({ verdict: "unknown" as QuarantineEntry["verdict"] })]);
    assert.match(html, /state-chip state-chip--na/);
    assert.doesNotMatch(html, /state-chip--ok|state-chip--crit/);
    assert.match(html, /Desconhecido/);
  });

  test("o risco só aparece quando é número", () => {
    const html = render([entrada({ riskScore: 0 })]);
    assert.match(html, /· risco 0/, "0 é uma medição, não ausência");
    const semRisco = render([entrada({ riskScore: undefined as unknown as number })]);
    assert.doesNotMatch(semRisco, /· risco/, "sem leitura não se inventa risco");
  });
});

describe("TP QUARANTINE V2 — a linha de política diz o estado sem escalar o desconhecido", () => {
  test("sem reportação do serviço: 'desconhecido' fica discreto", () => {
    const html = render([entrada()]);
    assert.match(html, /estado desconhecido/);
    assert.match(html, /row-note text-muted-foreground/);
    assert.doesNotMatch(html, /text-cyber-red|text-cyber-yellow/, "ausência de leitura não é avaria");
  });

  test("automática ligada é a única com tinta de verde", () => {
    const html = render([entrada()], { quarantinePolicy: "automatic-high-confidence" });
    assert.match(html, /row-note text-cyber-green/);
    assert.match(html, /Quarentena automática: LIGADA/);
  });

  test("OFF reportado pelo serviço usa o amarelo de atenção", () => {
    const html = render([entrada()], { quarantinePolicy: "warn" });
    assert.match(html, /row-note text-cyber-yellow/);
    assert.match(html, /Quarentena automática: OFF/);
  });

  test("modo 'ask' não é pintado como falha", () => {
    const html = render([entrada()], { quarantinePolicy: "ask" });
    assert.match(html, /row-note text-foreground/);
    assert.match(html, /pede confirmação caso a caso/);
  });
});

describe("TP QUARANTINE V2 — nomes acessíveis e disclosure ligada", () => {
  test("cada linha tem controlos nomeados pelo ficheiro, não genéricos", () => {
    const html = render([
      entrada({ id: "a", fileName: "ameaca.dll" }),
      entrada({ id: "b", fileName: "outra.dll", quarantinedAt: "2026-10-26T10:00:00.000Z" }),
    ]);
    const nomes = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(nomes.includes("Ver detalhes de ameaca.dll"), `falta o nome da primeira linha em ${JSON.stringify(nomes)}`);
    assert.ok(nomes.includes("Ver detalhes de outra.dll"));
    assert.ok(nomes.includes("Restaurar ameaca.dll para o local original"));
    assert.ok(nomes.includes("Eliminar outra.dll permanentemente"));
    assert.ok(!nomes.includes("Ver detalhes"), "o rótulo igual em todas as linhas voltou");
  });

  test("o botão de detalhes declara estado e alvo", () => {
    const html = render([entrada()]);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /aria-controls="quar-e1-detalhes"/);
  });

  test("identificador opaco do manifesto não vaza para o nome do elemento", () => {
    const html = render([entrada({ id: "q/2026:10 27" })]);
    const alvo = html.match(/aria-controls="([^"]+)"/)?.[1] ?? "";
    assert.match(alvo, /^[A-Za-z][A-Za-z0-9_-]*$/, `aria-controls inválido: ${alvo}`);
    assert.equal(alvo, "quar-q_2026_10_27-detalhes");
  });

  test("todos os botões são type=button", () => {
    const lista = botoes(render([entrada()]));
    assert.ok(lista.length >= 3, `esperava pelo menos 3 botões, obtive ${lista.length}`);
    for (const b of lista) {
      assert.match(b, /type="button"/, `botão sem type=button: ${b}`);
    }
  });

  test("o estado inicial não tem nada desativado", () => {
    assert.doesNotMatch(render([entrada()]), /disabled(?:="")?(?=[\s/>])/);
  });
});

describe("TP QUARANTINE V2 — vocabulário do design system em vez de escala inventada", () => {
  test("a lista é row-list/row-item, uma aresta por linha", () => {
    const html = render([entrada({ id: "a" }), entrada({ id: "b", quarantinedAt: "2026-10-26T10:00:00.000Z" })]);
    assert.match(html, /stat-card overflow-hidden/);
    assert.match(html, /class="row-list"/);
    assert.equal((html.match(/row-item/g) ?? []).length, 2, "uma row-item por entrada");
  });

  test("não sobram tamanhos de letra fora da escala", () => {
    const html = render([entrada()]);
    for (const tamanho of ["text-[9px]", "text-[10px]", "text-[11px]"]) {
      assert.doesNotMatch(html, new RegExp(tamanho.replace(/[[\]]/g, "\\$&")), `resta ${tamanho} no markup`);
    }
    assert.doesNotMatch(fontePagina, /text-\[(9|10|11)px\]/, "resta tamanho ad-hoc no fonte");
  });

  test("o fundo destrutivo usa o par --destructive/--destructive-foreground", () => {
    const html = render([entrada()]);
    assert.match(html, /bg-destructive[^"]*text-destructive-foreground/);
    assert.doesNotMatch(html, /bg-cyber-red[^ ]* text-primary-foreground|text-primary-foreground[^"]*bg-cyber-red/,
      "vermelho de TEXTO usado como fundo com tinta clara: par não medido");
  });

  test("nenhum efeito de material ou WebGL numa lista de evidência", () => {
    // Só o que é uso conta: importações e markup. O comentário que explica a
    // regra não pode ser apanhado pela própria regra.
    const html = render([entrada()]);
    for (const efeito of ["cs-spotlight", "surface-liquid", "surface-showcase", "surface-glass-highlight"]) {
      assert.doesNotMatch(html, new RegExp(`class="[^"]*${efeito}`), `${efeito} entrou numa linha`);
    }
    assert.doesNotMatch(html, /<canvas/, "elemento canvas no markup");
    assert.doesNotMatch(fontePagina, /from "(three|@react-three[^"]*|gl-matrix)"/, "dependência gráfica importada");
  });

  test("o reduced-motion é o do shell, não um duplicado local", () => {
    assert.match(fonteTemas, /@media \(prefers-reduced-motion: reduce\)/,
      "sem o bloco global, o animate-spin da linha não tem alternativa estática");
    assert.doesNotMatch(fontePagina, /prefers-reduced-motion/);
  });
});

describe("TP QUARANTINE V2 — resumo e vazio continuam a dizer a verdade", () => {
  test("zeros não entram na chapa; o estado real entra", () => {
    const html = render([entrada({ isolationStatus: "confirmed" })]);
    assert.match(html, /1 confirmado/);
    assert.doesNotMatch(html, /0 a recuperar|0 por verificar/, "chapa de zero é ruído à frente do número");
  });

  test("mistura mantém as três contagens por estado", () => {
    const html = render([
      entrada({ id: "a", isolationStatus: "confirmed" }),
      entrada({ id: "b", isolationStatus: "recovery-required", quarantinedAt: "2026-10-26T10:00:00.000Z" }),
      entrada({ id: "c", quarantinedAt: "2026-10-25T10:00:00.000Z" }),
    ]);
    assert.match(html, /1 confirmado/);
    assert.match(html, /1 a recuperar/);
    assert.match(html, /1 por verificar/);
    assert.doesNotMatch(html, /itens/);
  });

  test("vazio: frase intacta, sem contagens e sem ações de linha", () => {
    const html = render([]);
    assert.match(html, /A quarentena está vazia\./);
    assert.doesNotMatch(html, /confirmado|a recuperar|por verificar/);
    // V4: a recarga passou a existir sempre (também com lista vazia) — o que
    // continua proibido num contentor vazio são AÇÕES sobre entradas que não
    // existem: restaurar/eliminar/detalhes.
    assert.deepEqual(botoes(html).filter((b) => /Restaurar|Eliminar|Detalhes/.test(b)), [], "lista vazia não pode ter ações");
    assert.match(html, /aria-label="Atualizar a lista de quarentena a partir do serviço"/, "a recarga tem de existir com lista vazia");
  });
});

describe("TP QUARANTINE V2 — prova estática dos ramos que o SSR não clica", () => {
  /** Recorta do fonte o ramo que desenha uma banda, a partir da sua guarda. */
  function ramo(guarda: string): string {
    const inicio = fontePagina.indexOf(guarda);
    assert.notEqual(inicio, -1, `faltava o ramo ${guarda} no fonte`);
    return fontePagina.slice(inicio, inicio + 900);
  }

  /** O portador de anúncio tem de anteceder a frase que se quer que se ouça. */
  function portadorAntesDoTexto(textoFonte: string, papel: string, texto: string, nome: string): void {
    const lugarPapel = textoFonte.indexOf(`role="${papel}"`);
    const lugarTexto = textoFonte.indexOf(texto);
    assert.notEqual(lugarPapel, -1, `${nome}: sem role="${papel}"`);
    assert.notEqual(lugarTexto, -1, `${nome}: texto em falta`);
    assert.ok(lugarPapel < lugarTexto, `${nome}: o papel vem depois do texto, não anuncia nada`);
  }

  test("resultado, ocupado e recarga têm portador de anúncio", () => {
    // V4: o resultado de uma ação deixou de viver na linha — a linha desaparece
    // quando o serviço confirma restaurar/eliminar — e passou a uma banda
    // persistente. Continua a exigir-se que o portador anteceda a frase.
    const banda = ramo("{bandeira && (");
    assert.match(banda, /role=\{PAPEL_BANDEIRA\[bandeira\.tipo\]\}/, "o papel depende do estado");
    assert.match(banda, /aria-live=\{PAPEL_BANDEIRA\[bandeira\.tipo\] === "alert" \? "assertive" : "polite"\}/);
    const lugarPapel = banda.indexOf("role={PAPEL_BANDEIRA");
    const lugarTexto = banda.indexOf("{ROTULO_BANDEIRA[bandeira.tipo]}");
    assert.notEqual(lugarTexto, -1, "faltava o texto do resultado");
    assert.ok(lugarPapel < lugarTexto, "o papel vem depois do texto, não anuncia nada");
    portadorAntesDoTexto(ramo("{emCurso && ("), "status", "A comunicar com o serviço", "voo em curso");
    assert.match(fontePagina, /aria-label=\{QUARENTENA_ATUALIZAR_ARIA\}/, "a recarga é anunciada por nome");
  });

  test("V4: nada do resultado fica dependente da linha existir", () => {
    const inicioBanda = fontePagina.indexOf("{bandeira && (");
    const inicioLinhas = fontePagina.indexOf("{sorted.map((entry) => {");
    assert.ok(inicioBanda > 0 && inicioBanda < inicioLinhas, "a banda é desenhada antes do mapa das entradas");
    assert.equal(/const \[okId/.test(fontePagina), false, "voltou o estado por linha, que morre com a linha");
    assert.equal(/\{okId === entry\.id/.test(fontePagina), false, "voltou a banda por linha");
    assert.equal(/const \[error, setError\]/.test(fontePagina), false, "voltou o erro por linha");
  });

  test("a confirmação pergunta antes de agir e o cancelamento existe", () => {
    assert.match(fontePagina, /Eliminar permanentemente\? Esta ação é irreversível\./);
    assert.match(fontePagina, /setPending\(\{ id: entry\.id, action: "delete" \}\)/);
    assert.match(fontePagina, /onClick=\{\(\) => setPending\(null\)\}/);
    assert.match(fontePagina, /void run\(entry, aConfirmar\)/, "o pedido só sai depois de confirmar");
  });

  test("o restauro bloqueado por trabalho em voo é o único bloqueio", () => {
    const ocorrencias = fontePagina.match(/disabled=\{busyId !== null\}/g) ?? [];
    assert.equal(ocorrencias.length, 2, "esperava exatamente Restaurar e Eliminar dependentes do voo");
    assert.doesNotMatch(fontePagina, /disabled=\{(?:true|total|expanded)/);
  });

  test("o detalhe só mostra campos que existem", () => {
    for (const campo of ["detectionReason", "engine", "restoredAt"]) {
      assert.match(fontePagina, new RegExp(`entry\\.${campo} &&`), `${campo} passou a ser inventado`);
    }
    assert.match(fontePagina, /entry\.sha256 \|\| "não disponível"/);
  });
});
