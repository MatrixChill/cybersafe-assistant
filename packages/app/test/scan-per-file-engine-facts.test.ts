import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const exigir = createRequire(import.meta.url);

import {
  NO_DETECTIONS_NOTE,
  PER_FILE_ENGINE_COVERAGE_NOTE,
  createDirectedScanController,
  dirigidaContention,
  lancamentoContention,
  normalizeFileScanResponse,
  perFileOutcomeSentence,
  SCAN_CONTENTION_MESSAGES,
} from "../src/lib/scanSession";

/**
 * ENG-07, passo 1 — o facto por ficheiro (`analysisState`, `nativeEngine`,
 * `detail`) tem de sobreviver da resposta do serviço até ao ecrã, e tem de ser
 * mostrado sem transformer erro em resultado limpo.
 *
 * Nada aqui pede uma mudança de contrato: `electron.d.ts:72` já expõe
 * `scanFile(filePath) → Promise<FileScanResponse | null>`, o `main.ts:1455`
 * passa `scan.artifact` sem filtro, e `engine.ts:3121` devolve os três campos.
 * O que estava em falta era o lado do renderer ler.
 *
 * Cada teste é uma asserção sobre o que a UI PODE AFIRMAR, não sobre números:
 * ausência de estado é «desconhecido», nunca `completed`; ausência de
 * `nativeEngine` é «sem leitura», nunca «analisou».
 */

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { PerFileEngineCard } = await import("../src/pages/FileScannerPage");

/** Resposta mínima do serviço: um `results[]` como o contrato declara. */
function resposta(rows: unknown[]): unknown {
  return {
    results: rows,
    totalFiles: rows.length,
    highRiskCount: 0,
    overallSeverity: "low",
    rulesTriggered: [],
  };
}

/** Linha completa e honesta: concluída, nativa concluída, veredicto `safe`. */
const LINHA_CONCLUIDA = {
  fileName: "nota-fiscal.pdf",
  size: 20480,
  severity: "low",
  confidence: 0.1,
  rulesTriggered: [],
  verdict: "safe",
  sha256: "a".repeat(64),
  analysisState: "completed",
  nativeEngine: { status: "completed" },
};

const PROIBIDO_SEM_PROVA = [
  "limpo",
  "seguro",
  "verificado",
  "isento de risco",
  "protegido",
];

/** Cópia do caso concluído: fala do VEREDICTO AGREGADO, nunca dos motores. */
const FRASE_VEREDICTO_LIMPO = "O veredicto reportado para este ficheiro é sem deteções.";

/**
 * Quantificadores sobre a totalidade dos motores. A resposta por ficheiro não
 * diz quais motores correram, por isso nenhuma frase da UI os pode conter —
 * foi exatamente isto que a revisão do Codex pediu a corrigir no ENG-07.
 */
const QUANTIFICADOR_SEM_PROVA = /nenhum motor|todos os motores|os quatro motores|cada motor (?:analisou|viu)/i;

function semQuantificador(texto: string, contexto: string): void {
  assert.equal(QUANTIFICADOR_SEM_PROVA.test(texto), false, `${contexto}: quantifica motores sem prova`);
}

describe("ENG-07 transporte — o que a resposta por ficheiro permite afirmar", () => {
  test("caso legado: sem `analysisState` nem `nativeEngine` não se inventa estado", () => {
    // Um serviço mais velho devolve a linha sem os campos opcionais. O
    // renderer não pode ler isso como «analisado».
    const [fact] = normalizeFileScanResponse(
      resposta([{ fileName: "velho.txt", size: 1, severity: "low", confidence: 0, rulesTriggered: [] }]),
    )!;
    assert.equal(fact.analysisState, "desconhecido");
    assert.equal(fact.native.status, "sem leitura");
    assert.equal(fact.canClaimClean, false);
    assert.equal(fact.detail, undefined, "detalhe inventado a partir de ausência");
    const frase = perFileOutcomeSentence(fact);
    for (const palavra of PROIBIDO_SEM_PROVA) {
      assert.equal(frase.includes(palavra), false, `frase afirma «${palavra}» sem leitura do motor`);
    }
  });

  test("caso de sucesso: concluído + nativo concluído + veredicto safe é o único que pode dizer «sem deteção»", () => {
    const [fact] = normalizeFileScanResponse(resposta([LINHA_CONCLUIDA]))!;
    assert.equal(fact.analysisState, "completed");
    assert.equal(fact.native.status, "completed");
    assert.equal(fact.canClaimClean, true);
    assert.equal(perFileOutcomeSentence(fact), FRASE_VEREDICTO_LIMPO);
    semQuantificador(perFileOutcomeSentence(fact), "frase do caso concluído");
  });

  test("caso de falha: o `detail` do motor chega ao ecrã e não vira resultado limpo", () => {
    const [fact] = normalizeFileScanResponse(
      resposta([{ ...LINHA_CONCLUIDA, analysisState: "failed", verdict: "safe", detail: "leitura recusada pelo sistema de ficheiros" }]),
    )!;
    assert.equal(fact.analysisState, "failed");
    assert.equal(fact.canClaimClean, false, "falha de motor foi convertida em resultado limpo");
    assert.equal(fact.detail, "leitura recusada pelo sistema de ficheiros");
    const frase = perFileOutcomeSentence(fact);
    assert.match(frase, /falhou/i);
    assert.match(frase, /leitura recusada pelo sistema de ficheiros/);
    assert.equal(frase.includes("Nenhum motor reportou deteção"), false);
  });

  test("caso indisponível: motor em falta é dito como indisponível, com o motivo medido", () => {
    const [fact] = normalizeFileScanResponse(
      resposta([{ ...LINHA_CONCLUIDA, analysisState: "engine-unavailable", nativeEngine: { status: "unavailable", failure: "unavailable" } }]),
    )!;
    assert.equal(fact.analysisState, "engine-unavailable");
    assert.equal(fact.native.status, "unavailable");
    assert.equal(fact.native.failure, "unavailable");
    assert.equal(fact.canClaimClean, false);
    assert.match(perFileOutcomeSentence(fact), /indisponível/i);
  });

  test("caso inconclusivo: não é nem limpo nem ameaça", () => {
    const [fact] = normalizeFileScanResponse(
      resposta([{ ...LINHA_CONCLUIDA, analysisState: "inconclusive", verdict: "inconclusive", nativeEngine: { status: "cancelled", failure: "cancelled" } }]),
    )!;
    assert.equal(fact.analysisState, "inconclusive");
    assert.equal(fact.canClaimClean, false);
    assert.match(perFileOutcomeSentence(fact), /inconclusivo/i);
  });

  test("caso excluído: diz que o ficheiro não chegou a nenhum motor", () => {
    const [fact] = normalizeFileScanResponse(
      resposta([{ ...LINHA_CONCLUIDA, analysisState: "excluded" }]),
    )!;
    assert.equal(fact.analysisState, "excluded");
    assert.equal(fact.canClaimClean, false);
    assert.match(perFileOutcomeSentence(fact), /não chegou a nenhum motor/);
  });

  test("ausência de regras heurísticas não nomeia YARA, HashDB nem ClamAV", () => {
    // `rulesTriggered` são ids heurísticos do analisador, não motores. Traduzi-
    // los (ou traduzir a sua ausência) em cobertura de assinaturas seria a
    // atribuição inventada que este teste procura impedir.
    const [fact] = normalizeFileScanResponse(resposta([LINHA_CONCLUIDA]))!;
    assert.deepEqual(fact.rulesTriggered, []);
    const nota = PER_FILE_ENGINE_COVERAGE_NOTE;
    assert.match(nota, /não são identificados por ficheiro/);
    assert.equal(/analisado por (yara|clamav|hashdb)/i.test(perFileOutcomeSentence(fact)), false);
  });

  test("resposta malformada não rebenta nem fabrica linha", () => {
    assert.equal(normalizeFileScanResponse(null), null);
    assert.equal(normalizeFileScanResponse(undefined), null);
    assert.equal(normalizeFileScanResponse("completed"), null);
    assert.equal(normalizeFileScanResponse({}), null);
    assert.equal(normalizeFileScanResponse({ results: "completed" }), null);
    assert.deepEqual(normalizeFileScanResponse(resposta([])), []);
    // Linhas sem forma usam apenas o que existe; nada vira `completed`.
    const [fact] = normalizeFileScanResponse(resposta([null, 7, { analysisState: 42, nativeEngine: "ok" }]))!;
    assert.equal(fact.analysisState, "desconhecido");
    assert.equal(fact.native.status, "sem leitura");
    assert.equal(fact.canClaimClean, false);
  });

  test("`nativeEngine` com estado fora do contrato é «sem leitura», nunca o valor lido", () => {
    const [fact] = normalizeFileScanResponse(
      resposta([{ ...LINHA_CONCLUIDA, nativeEngine: { status: "ok-lokal", failure: "nada" } }]),
    )!;
    assert.equal(fact.native.status, "sem leitura");
    assert.equal(fact.native.failure, undefined);
    assert.equal(fact.canClaimClean, false, "nativo malformado ainda autorizou «sem deteção»");
  });
});

describe("ENG-07 render — o cartão por ficheiro desenhado sem falsos verdes", () => {
  const sem = (
    estado: Parameters<typeof PerFileEngineCard>[0]["estado"],
    scanAtivo = false,
  ) => renderToStaticMarkup(
    createElement(PerFileEngineCard, { estado, scanAtivo, onAnalisar: () => {} }),
  );

  test("sem ficheiro largado não há cartão", () => {
    assert.equal(sem({ fase: "inerte" }), "");
  });

  test("ficheiro disponível ainda não afirma nada sobre os motores", () => {
    const html = sem({ fase: "disponivel", fileName: "nota-fiscal.pdf" });
    assert.match(html, /nota-fiscal\.pdf/);
    assert.match(html, /Analisar com os motores/);
    semQuantificador(html, "cartão desenhado");
    assert.equal(html.includes("Analisado"), false);
    for (const palavra of PROIBIDO_SEM_PROVA) {
      assert.equal(html.includes(palavra), false, `cartão afirma «${palavra}» sem resposta`);
    }
  });

  test("sem ligação ao serviço di-lo, em vez de desenhar resultado vazio", () => {
    const html = sem({ fase: "sem_ligacao", fileName: "a.txt" });
    assert.match(html, /Sem ligação ao serviço/);
    semQuantificador(html, "cartão desenhado");
  });

  test("falha do motor é mostrada como alerta com a mensagem real", () => {
    const html = sem({
      fase: "erro",
      fileName: "a.txt",
      mensagem: "A análise dirigida falhou: spawn falhou (scan-engine.exe)",
    });
    assert.match(html, /role="alert"/);
    assert.match(html, /spawn falhou \(scan-engine\.exe\)/);
    for (const palavra of PROIBIDO_SEM_PROVA) {
      assert.equal(html.includes(palavra), false);
    }
  });

  test("caso de falha renderizado: estado, frase e detalhe do motor; nunca o cartão de sucesso", () => {
    const facts = normalizeFileScanResponse(
      resposta([{ ...LINHA_CONCLUIDA, analysisState: "failed", detail: " ficheiro bloqueado " }]),
    )!;
    const html = sem({ fase: "pronto", fileName: "a.txt", facts });
    assert.match(html, /Falhou/);
    assert.match(html, /Estado informado pelo motor: falhou/);
    // o `detail` chega ao ecrã porque é o motor que o escreve
    assert.match(html, /Detalhe do motor/);
    assert.match(html, /Native Engine: analisou este ficheiro/);
    assert.equal(html.includes(NO_DETECTIONS_NOTE), false, "falha mostrou a nota de ausência de deteção");
    semQuantificador(html, "cartão desenhado");
  });

  test("caso de sucesso renderizado: nota de ausência de deteção E cobertura por motor declarada", () => {
    const facts = normalizeFileScanResponse(resposta([LINHA_CONCLUIDA]))!;
    const html = sem({ fase: "pronto", fileName: "nota-fiscal.pdf", facts });
    assert.match(html, /Analisado/);
    assert.match(html, /veredicto reportado para este ficheiro é sem deteções/);
    semQuantificador(html, "cartão do caso concluído");
    assert.ok(html.includes(NO_DETECTIONS_NOTE), "perdeu a nota que impede a tranquilização");
    assert.ok(html.includes(PER_FILE_ENGINE_COVERAGE_NOTE), "omitiu a fronteira de atribuição por motor");
    assert.match(html, /Native Engine: analisou este ficheiro/);
  });

  test("motor indisponível renderizado: não existe nota de ausência de deteção", () => {
    const facts = normalizeFileScanResponse(
      resposta([{ ...LINHA_CONCLUIDA, analysisState: "engine-unavailable", nativeEngine: { status: "unavailable", failure: "unavailable" } }]),
    )!;
    const html = sem({ fase: "pronto", fileName: "a.txt", facts });
    assert.equal(html.includes(NO_DETECTIONS_NOTE), false);
    assert.match(html, /Motor indisponível/);
    assert.match(html, /Native Engine: indisponível/);
  });

  test("resposta sem linha por ficheiro não é desenhada como análise", () => {
    const html = sem({
      fase: "sem_resposta",
      fileName: "a.txt",
      mensagem: "O serviço não devolveu um resultado por ficheiro: não há estado de motor para mostrar.",
    });
    assert.match(html, /role="alert"/);
    assert.match(html, /não devolveu um resultado por ficheiro/);
    assert.equal(html.includes(NO_DETECTIONS_NOTE), false);
  });
});

describe("ENG-07 ligações — o facto chega à página e o histórico não o imita", () => {
  const pagina = readFileSync(
    fileURLToPath(new URL("../src/pages/FileScannerPage.tsx", import.meta.url)), "utf8",
  );
  const historico = readFileSync(
    fileURLToPath(new URL("../src/components/ScanHistoryPanel.tsx", import.meta.url)), "utf8",
  );

  test("a página chama o contrato existente e monta o cartão por ficheiro", () => {
    assert.match(pagina, /scanFile\(filePath\)/, "a análise dirigida deixou de usar o contrato existente");
    assert.match(pagina, /normalizeFileScanResponse\(resposta\)/, "a resposta deixou de ser normalizada");
    assert.match(pagina, /<PerFileEngineCard estado=\{perFile\} scanAtivo=\{isActive\}/,
      "o cartão saiu da página ou deixou de receber o estado de scan ativo");
  });

  test("os três travões estão ligados à página, não só à máquina", () => {
    assert.match(pagina, /useRef\(createDirectedScanController\(\)\)/, "a página deixou de usar a máquina de concorrência");
    assert.match(pagina, /dirigidaRef\.current\.tentarAbrir\(\s*launchLockRef\.current \|\| isActiveUiStatus\(uiStatus\),/,
      "o pedido deixou de ser bloqueado quando há análise ativa");
    assert.match(pagina, /dirigidaRef\.current\.novaSelecao\(\)/, "largar outro ficheiro deixou de invalidar a resposta em curso");
    assert.match(pagina, /dirigidaRef\.current\.pertence\(token, mountedRef\.current\)/,
      "a resposta deixou de ser vinculada à seleção e à montagem");
    assert.match(pagina, /dirigidaRef\.current\.fechar\(token\)/, "a trava deixou de ser libertada no finally");
    assert.match(pagina, /if \(token === null\) return/, "o bloqueio não tem retorno explícito");
  });

  test("o caminho do utilizador fica em ref e não é desenhado pelo cartão", () => {
    assert.match(pagina, /perFilePathRef\.current = filePath/, "o caminho deixou de viver no ref");
    // O cartão só recebe `fileName`; se o caminho passar para o JSX, isto falha.
    const corpo = pagina.slice(pagina.indexOf("export function PerFileEngineCard"), pagina.indexOf("interface FileScannerPageProps"));
    assert.equal(/perFilePathRef|estado\.path|\.filePath/.test(corpo), false,
      "o cartão passou a desenhar o caminho real do utilizador");
  });

  test("o histórico declara contadores agregados e não atribui motores por ficheiro", () => {
    assert.match(historico, /o histórico não diz que motores viram cada ficheiro/,
      "desapareceu a fronteira de atribuição do histórico");
    assert.equal(/histórico[^.]{0,40}(yara|clamav|hashdb)/i.test(historico), false,
      "o histórico passou a nomear motores por ficheiro");
  });

  test("persistência: nada do facto por ficheiro é escrito em armazenamento", () => {
    const corpo = pagina.slice(pagina.indexOf("export function PerFileEngineCard"), pagina.indexOf("interface FileScannerPageProps"));
    assert.equal(/localStorage|sessionStorage|indexedDB|electron-store|writeFile/.test(pagina.slice(
      pagina.indexOf("const analisarFicheiroDireto"),
      pagina.indexOf("const analisarFicheiroDireto") + 2200,
    )), false, "a análise dirigida passou a persistir o resultado");
    assert.equal(/localStorage|writeFile/.test(corpo), false);
  });
});

describe("ENG-07 revisão Codex — frase limitada ao veredicto e concorrência da análise dirigida", () => {
  test("payload onde só o nativo e o veredicto são conhecidos não autoriza frase de limpeza", () => {
    // Exatamente o caso que a revisão pediu: `nativeEngine` concluído e
    // `verdict: "safe"` sem `analysisState`. Ausência de estado tem de valer
    // «desconhecido», e a frase nunca pode dizer que não há deteção.
    const [fact] = normalizeFileScanResponse(
      resposta([{ fileName: "parcial.docx", size: 10, severity: "low", confidence: 0.5, rulesTriggered: [], verdict: "safe", nativeEngine: { status: "completed" } }]),
    )!;
    assert.equal(fact.analysisState, "desconhecido");
    assert.equal(fact.native.status, "completed");
    assert.equal(fact.verdict, "safe");
    assert.equal(fact.canClaimClean, false, "sem `analysisState` foi tratado como veredicto confiável");
    const frase = perFileOutcomeSentence(fact);
    assert.equal(frase.includes("sem deteções"), false, `frase afirmou ausência de deteção: ${frase}`);
    semQuantificador(frase, "frase do payload parcial");
    assert.match(frase, /estado não informado pelo motor/i);
  });

  test("mesmo o caso completo usa copy do veredicto agregado, não dos motores", () => {
    const [fact] = normalizeFileScanResponse(resposta([LINHA_CONCLUIDA]))!;
    const frase = perFileOutcomeSentence(fact);
    assert.equal(frase, FRASE_VEREDICTO_LIMPO);
    assert.equal(frase.includes("motor"), false, `a copy de limpeza voltou a nomear motores: ${frase}`);
  });

  test("análise em curso: o cartão bloqueia o botão e diz porquê", () => {
    const html = renderToStaticMarkup(createElement(PerFileEngineCard, {
      estado: { fase: "disponivel", fileName: "nota-fiscal.pdf" },
      scanAtivo: true,
      onAnalisar: () => {},
    }));
    assert.match(html, /disabled/, "o botão ficou clicável durante uma análise ativa");
    assert.match(html, /Bloqueado durante a análise/);
    assert.match(html, /role="status"/);
    assert.equal(html.includes("Analisar com os motores"), false, "ofereceu o pedido em paralelo com a análise");
  });

  test("travão 1: análise de pasta ativa não deixa sair o pedido dirigido", () => {
    const c = createDirectedScanController();
    c.novaSelecao();
    assert.equal(c.tentarAbrir(true), null, "pediu análise dirigida com scan ativo");
    assert.equal(c.emCurso, false, "o bloqueio deixou a trava presa");
    assert.ok(c.tentarAbrir(false), "sem scan ativo o pedido foi recusado");
  });

  test("travão 2: duplo clique no mesmo tick produz um pedido, não dois", () => {
    const c = createDirectedScanController();
    c.novaSelecao();
    const primeiro = c.tentarAbrir(false)!;
    const segundo = c.tentarAbrir(false);
    assert.ok(primeiro, "o primeiro clique não abriu pedido");
    assert.equal(segundo, null, "o segundo clique do duplo clique abriu pedido extra");
    c.fechar(primeiro);
    assert.equal(c.emCurso, false);
    assert.ok(c.tentarAbrir(false), "a trava não libertou depois do fechar");
  });

  test("travão 3: troca de ficheiro torna a resposta antiga alheia", () => {
    const c = createDirectedScanController();
    c.novaSelecao();                       // nota-fiscal.pdf
    const token = c.tentarAbrir(false)!;
    c.novaSelecao();                        // utilizador largou outro ficheiro
    assert.equal(c.pertence(token, true), false, "resposta antiga ia escrever sobre a nova seleção");
    c.fechar(token);
    assert.equal(c.emCurso, false);
  });

  test("travão 3b: desmontar a página descarta a resposta tardia", () => {
    const c = createDirectedScanController();
    c.novaSelecao();
    const token = c.tentarAbrir(false)!;
    assert.equal(c.pertence(token, true), true, "caso normal foi tratado como tardio");
    assert.equal(c.pertence(token, false), false, "resposta pós-desmontagem foi aceite");
    c.fechar(token);
  });

  test("travão 4: um fechar tardio não liberta a trava de outro pedido", () => {
    const c = createDirectedScanController();
    c.novaSelecao();
    const antigo = c.tentarAbrir(false)!;
    c.fechar(antigo);
    const novo = c.tentarAbrir(false)!;
    c.fechar(antigo);                       // eco tardio do pedido anterior
    assert.equal(c.emCurso, true, "o eco tardio libertou a trava do pedido novo");
    c.fechar(novo);
    assert.equal(c.emCurso, false);
  });
});

describe("ENG-07 mutação — controlo anti-máscara", () => {
  /**
   * Prova de que o teste de cima é carga real e não texto a repetir o código:
   * se o estado em falta passar a «completed» (o falsificar verde que este
   * trabalho existe para impedir), o caso legado tem de falhar.
   */
  test("mudar o valor por defeito para «completed» quebra o caso legado", () => {
    const caminho = fileURLToPath(new URL("../src/lib/scanSession.ts", import.meta.url));
    const fonte = readFileSync(caminho, "utf8");
    const alvo = '    : "desconhecido";';
    assert.ok(fonte.includes(alvo), "o valor por defeito deixou de estar no sítio esperado");
    const mutada = fonte.replace(alvo, '    : "completed";');
    assert.notEqual(mutada, fonte, "mutação não alterou nada — não é controlo nenhum");

    const saida = ts.transpileModule(mutada, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;

    const dir = fileURLToPath(new URL("./.tmp-eng07/", import.meta.url));
    mkdirSync(dir, { recursive: true });
    const ficheiro = `${dir}/scanSession.mutante.cjs`;
    writeFileSync(ficheiro, saida);
    try {
      const mutante = exigir(ficheiro) as {
        normalizeFileScanResponse: (raw: unknown) => Array<{ analysisState: string }> | null;
      };
      const [fact] = mutante.normalizeFileScanResponse(
        resposta([{ fileName: "velho.txt", size: 1, severity: "low", confidence: 0, rulesTriggered: [] }]),
      )!;
      // O código mutado afirma `completed` onde o original afirma ausência.
      assert.equal(fact.analysisState, "completed");
      assert.notEqual(
        fact.analysisState,
        normalizeFileScanResponse(
          resposta([{ fileName: "velho.txt", size: 1, severity: "low", confidence: 0, rulesTriggered: [] }]),
        )![0].analysisState,
        "o original e o mutante concordam: o teste não está a medir nada",
      );
    } finally {
      rmSync(ficheiro, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("remover a exigência de veredicto `safe` faria um ficheiro sem veredicto parecer limpo", () => {
    const caminho = fileURLToPath(new URL("../src/lib/scanSession.ts", import.meta.url));
    const fonte = readFileSync(caminho, "utf8");
    const alvo = 'canClaimClean: analysisState === "completed" && native.status === "completed" && verdict === "safe",';
    assert.ok(fonte.includes(alvo), "a condição de «sem deteção» deixou de estar no sítio esperado");
    const mutada = fonte.replace(alvo, 'canClaimClean: analysisState === "completed",');

    const dir = fileURLToPath(new URL("./.tmp-eng07b/", import.meta.url));
    mkdirSync(dir, { recursive: true });
    const ficheiro = `${dir}/scanSession.mutante.cjs`;
    writeFileSync(ficheiro, ts.transpileModule(mutada, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText);
    try {
      const mutante = exigir(ficheiro) as {
        normalizeFileScanResponse: (raw: unknown) => Array<{ canClaimClean: boolean }> | null;
      };
      // Linha concluída mas SEM veredicto: o original recusa «sem deteção».
      const semVeredicto = { ...LINHA_CONCLUIDA } as Record<string, unknown>;
      delete semVeredicto.verdict;
      const [m] = mutante.normalizeFileScanResponse(resposta([semVeredicto]))!;
      const [o] = normalizeFileScanResponse(resposta([semVeredicto]))!;
      assert.equal(o.canClaimClean, false);
      assert.equal(m.canClaimClean, true, "mutação não produz o falso verde esperado");
    } finally {
      rmSync(ficheiro, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ENG-07 v4 — exclusão mútua síncrona nos dois sentidos", () => {
  const pagina = readFileSync(
    fileURLToPath(new URL("../src/pages/FileScannerPage.tsx", import.meta.url)), "utf8",
  );
  const livre = { dirigidaEmCurso: false, lancamentoEmCurso: false, analiseAtiva: false };
  const ocupada = (parcial: Partial<typeof livre>) => ({ ...livre, ...parcial });

  test("nada em curso: os dois sentidos estão abertos", () => {
    assert.equal(dirigidaContention(livre), null);
    assert.equal(lancamentoContention(false), null);
  });

  test("sentido lançada→dirigida: o lançamento bloqueia ANTES de o estado ser pintado", () => {
    // O caso que faltava. `uiStatus` ainda diz `idle` porque o render não
    // aconteceu, mas `launchScan` já prendeu a trava síncrona: sem ler
    // `launchLockRef`, a análise dirigida passava por cima do scan.
    assert.equal(
      dirigidaContention(ocupada({ lancamentoEmCurso: true })),
      "analise_em_curso",
      "a análise dirigida passou por cima de um lançamento em curso",
    );
  });

  test("sentido lançada→dirigida: um scan já visível no ecrã bloqueia igualmente", () => {
    assert.equal(dirigidaContention(ocupada({ analiseAtiva: true })), "analise_em_curso");
  });

  test("sentido dirigida→lançada: o pedido em voo bloqueia, e fechar liberta", () => {
    const c = createDirectedScanController();
    c.novaSelecao();
    assert.equal(lancamentoContention(c.emCurso), null, "bloqueou sem nada em curso");
    const token = c.tentarAbrir(false)!;
    assert.equal(lancamentoContention(c.emCurso), "dirigida_em_curso",
      "o lançamento não foi bloqueado pela análise dirigida");
    c.fechar(token);
    assert.equal(lancamentoContention(c.emCurso), null, "a recusa ficou presa depois de fechar");
  });

  test("duplo clique no mesmo tick: um pedido e uma recusa que diz porquê", () => {
    const c = createDirectedScanController();
    c.novaSelecao();
    const primeiro = c.tentarAbrir(false)!;
    const recusa = dirigidaContention(ocupada({ dirigidaEmCurso: c.emCurso }));
    assert.equal(recusa, "dirigida_em_curso", "o segundo clique não foi recusado");
    assert.equal(c.tentarAbrir(false), null, "a máquina deixou sair um segundo pedido");
    assert.match(SCAN_CONTENTION_MESSAGES[recusa!], /em curso/);
    c.fechar(primeiro);
    assert.equal(dirigidaContention(ocupada({ dirigidaEmCurso: c.emCurso })), null);
  });

  test("pedido em voo com resposta lenta: nada entra pelo meio até resolver", async () => {
    // As promessas só resolvem quando o teste quisermos — é assim que a janela
    // entre pedido e resposta se mede sem DOM nem browser.
    const c = createDirectedScanController();
    c.novaSelecao();
    let libertar!: () => void;
    const emVoo = new Promise<null>((r) => { libertar = () => r(null); });
    const token = c.tentarAbrir(false)!;
    assert.equal(lancamentoContention(c.emCurso), "dirigida_em_curso");
    assert.equal(dirigidaContention(ocupada({ dirigidaEmCurso: c.emCurso })), "dirigida_em_curso");
    libertar();
    await emVoo;
    c.fechar(token);
    assert.equal(lancamentoContention(c.emCurso), null);
    assert.equal(dirigidaContention(livre), null);
  });

  test("resposta velha depois de nova seleção: alheia, e o pedido antigo segura a trava", () => {
    const c = createDirectedScanController();
    c.novaSelecao();
    const antigo = c.tentarAbrir(false)!;
    c.novaSelecao();
    assert.equal(c.pertence(antigo, true), false, "a resposta antiga ainda pertence à seleção");
    // O pedido antigo continua em voo: trocar de ficheiro não o cancela, por
    // isso não pode haver um segundo pedido por cima dele.
    assert.equal(c.tentarAbrir(false), null, "saiu um segundo pedido com o antigo em voo");
    assert.equal(lancamentoContention(c.emCurso), "dirigida_em_curso");
    c.fechar(antigo);
    assert.equal(c.emCurso, false, "a trava ficou presa depois de o antigo resolver");
    assert.ok(c.tentarAbrir(false), "com a trava liberta, o novo pedido não arranca");
  });

  test("as recusas não inventam motores nem atribuições", () => {
    for (const frase of Object.values(SCAN_CONTENTION_MESSAGES)) {
      assert.equal(/yara|clamav|hashdb|analisado por/i.test(frase), false,
        `a recusa passou a nomear motores: «${frase}»`);
      assert.equal(/limpo|seguro|verificado/i.test(frase), false,
        `a recusa passou a tranquilizar: «${frase}»`);
    }
    assert.match(SCAN_CONTENTION_MESSAGES.analise_em_curso, /até essa análise terminar/);
    assert.match(SCAN_CONTENTION_MESSAGES.dirigida_em_curso, /volta a pedir/);
  });

  test("a página consulta os dois sentidos e recusa em voz alta", () => {
    assert.match(pagina, /lancamentoContention\(dirigidaRef\.current\.emCurso\)/,
      "o lançamento deixou de perguntar pela análise dirigida");
    assert.match(pagina, /setError\(SCAN_CONTENTION_MESSAGES\[recusaLancamento\]\)/,
      "a recusa do lançamento voltou a ser silenciosa");
    assert.match(pagina, /dirigidaContention\(\{[\s\S]{0,200}lancamentoEmCurso: launchLockRef\.current/,
      "o pedido dirigido voltou a olhar só para o estado pintado");
    assert.match(pagina, /setError\(SCAN_CONTENTION_MESSAGES\[recusa\]\)/,
      "a recusa do pedido dirigido voltou a ser silenciosa");
  });

  test("as duas guardas correm antes de qualquer espera", () => {
    // Guarda depois do primeiro `await` não é guarda: é sorte.
    const corpoLancamento = pagina.slice(
      pagina.indexOf("const launchScan = useCallback"),
      pagina.indexOf("const active = normalizeScanState(await api.getActiveScan())"),
    );
    assert.ok(corpoLancamento.includes("lancamentoContention(dirigidaRef.current.emCurso)"),
      "a contenção do lançamento deixou de anteceder a primeira espera");
    const corpoDirigida = pagina.slice(
      pagina.indexOf("const analisarFicheiroDireto = useCallback"),
      pagina.indexOf("const resposta = await scanFile(filePath)"),
    );
    assert.ok(corpoDirigida.includes("dirigidaContention({"),
      "a contenção do pedido dirigido deixou de anteceder a primeira espera");
  });
});

describe("ENG-07 v4 mutação — as duas guardas são carga real", () => {
  const caminho = fileURLToPath(new URL("../src/lib/scanSession.ts", import.meta.url));

  /** Transpila uma versão mutada do módulo e devolve o conteúdo carregável. */
  function mutante(alvo: string, substituicao: string, pasta: string) {
    const fonte = readFileSync(caminho, "utf8");
    assert.ok(fonte.includes(alvo), "o alvo da mutação deixou de estar no sítio esperado");
    const mutada = fonte.replace(alvo, substituicao);
    assert.notEqual(mutada, fonte, "mutação não alterou nada — não é controlo nenhum");
    const dir = fileURLToPath(new URL(`./${pasta}/`, import.meta.url));
    mkdirSync(dir, { recursive: true });
    const ficheiro = `${dir}/scanSession.mutante.cjs`;
    writeFileSync(ficheiro, ts.transpileModule(mutada, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText);
    return { ficheiro, dir };
  }

  test("sem o termo do lançamento, a janela pré-render volta a abrir", () => {
    const alvo = 'if (ocupacao.lancamentoEmCurso || ocupacao.analiseAtiva) return "analise_em_curso";';
    const { ficheiro, dir } = mutante(
      alvo, 'if (ocupacao.analiseAtiva) return "analise_em_curso";', ".tmp-eng07c",
    );
    try {
      const m = exigir(ficheiro) as {
        dirigidaContention: (o: unknown) => string | null;
      };
      // Original recusa; o mutado só olha para o estado pintado e deixa passar.
      assert.equal(dirigidaContention({
        dirigidaEmCurso: false, lancamentoEmCurso: true, analiseAtiva: false,
      }), "analise_em_curso");
      assert.equal(
        m.dirigidaContention({ dirigidaEmCurso: false, lancamentoEmCurso: true, analiseAtiva: false }),
        null,
        "a mutação não reabriu a janela — o teste não está a medir nada",
      );
    } finally {
      rmSync(ficheiro, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sem a trava inversa, o lançamento passa por cima do pedido em voo", () => {
    const alvo = 'return dirigidaEmCurso ? "dirigida_em_curso" : null;';
    const { ficheiro, dir } = mutante(alvo, "return null;", ".tmp-eng07d");
    try {
      const m = exigir(ficheiro) as {
        lancamentoContention: (emCurso: boolean) => string | null;
      };
      assert.equal(lancamentoContention(true), "dirigida_em_curso");
      assert.equal(m.lancamentoContention(true), null,
        "a mutação não deixou o lançamento passar — o teste não está a medir nada");
    } finally {
      rmSync(ficheiro, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
