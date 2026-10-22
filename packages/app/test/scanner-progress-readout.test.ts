/**
 * P1-B (teste humano de 15/10) — cinco defeitos visuais do Scanner, fixados por
 * teste para não voltarem:
 *
 *  1. DUPLICAÇÃO: «A analisar os ficheiros da pasta...» aparecia duas vezes no
 *     mesmo cartão — no título do painel (`activeScanTitle`) e outra vez na
 *     linha do alvo, porque a linha do alvo caía no título quando não havia
 *     nome de pasta. A linha do alvo passa a ser `activeScanTarget`, que devolve
 *     `null` em vez de repetir a frase de fase.
 *  2. BARRA SEM PROPORÇÃO: o motor reportava 16% (denominador real) e a barra
 *     continuava a pulsar em largura total, porque a proporção só era desenhada
 *     para `scope === "computer"`. A leitura passa por `scanProgressReadout`:
 *     fase + contador, proporção quando existe denominador, INDETERMINADO quando
 *     não existe — e nunca uma percentagem inventada.
 *  3. MEDIÇÃO: a regra de ETA/velocidade (`scanEtaSeconds`, `formatEta`,
 *     `scanRateLabel`) não pode regredir; fica guardada aqui com valores medidos.
 *  4. CARTÕES: duas das quatro métricas tinham ícone em linha e as outras duas
 *     não — densidade diferente no mesmo grupo. O teste verifica que a receita é
 *     uma só (rótulo + valor com `tabular-nums`), sem ícones em linha.
 *
 * O que este ficheiro NÃO prova: nada sobre a janela a correr a sério (arrasto,
 * maximizar, DPI). Isso é reteste humano, não teste unitário.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScanScope, ScanUiStatus } from "../src/lib/scanSession";

const {
  activeScanTarget,
  activeScanTitle,
  scanProgressReadout,
  scanProgressPercent,
  scanEtaSeconds,
  formatEta,
  scanRateLabel,
  normalizeScanState,
  SCAN_CANCEL_REQUESTED_NOTE,
} = await import("../src/lib/scanSession");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(HERE, "..", "src", "pages", "FileScannerPage.tsx"), "utf8");
const PANEL = fs.readFileSync(path.join(HERE, "..", "src", "components", "ScanHistoryPanel.tsx"), "utf8");

const SCOPES: ScanScope[] = ["computer", "file", "folder"];
const UI_STATUSES: ScanUiStatus[] = [
  "idle",
  "preparing",
  "gathering",
  "scanning",
  "finalizing",
  "completed",
  "cancelled",
  "failed",
];

describe("P1-B (1) — a frase de fase não se repete na linha do alvo", () => {
  test("a linha do alvo NUNCA é igual ao título do painel", () => {
    for (const scope of SCOPES) {
      for (const ui of UI_STATUSES) {
        for (const file of [undefined, "relatorio.pdf"]) {
          for (const target of [undefined, "Documentos"]) {
            const alvo = activeScanTarget(scope, file, target);
            const titulo = activeScanTitle(scope, ui);
            if (alvo !== null) {
              assert.notEqual(alvo, titulo, `duplicou «${titulo}» (${scope}/${ui})`);
            }
          }
        }
      }
    }
  });

  test("o caso reportado: pasta sem nome confirmado não volta a escrever o título", () => {
    // Era exactamente isto que produzia as duas frases iguais no ecrã.
    assert.equal(activeScanTarget("folder", undefined, undefined), null);
    assert.equal(activeScanTarget("computer", undefined, undefined), null);
    assert.equal(activeScanTarget("file", undefined, undefined), null);
    assert.equal(activeScanTitle("folder", "scanning"), "A analisar os ficheiros da pasta...");
  });

  test("com alvo confirmado, a linha nomeia-o (pasta, ficheiro, ou o ficheiro em curso)", () => {
    assert.equal(activeScanTarget("folder", undefined, "Documentos"), "Pasta: Documentos");
    assert.equal(activeScanTarget("file", undefined, "relatorio.pdf"), "Ficheiro: relatorio.pdf");
    // O ficheiro em curso tem precedência sobre o nome do alvo.
    assert.equal(activeScanTarget("file", "atual.pdf", "relatorio.pdf"), "Ficheiro: atual.pdf");
    // O computador inteiro não tem alvo a nomear.
    assert.equal(activeScanTarget("computer", "x.pdf", "Documentos"), null);
  });

  test("o JSX tem uma só chamada ao título do painel (a do cabeçalho)", () => {
    const chamadas = PAGE.match(/activeScanTitle\(scope, uiStatus\)/g) ?? [];
    assert.equal(
      chamadas.length,
      1,
      `o título de fase aparece ${chamadas.length}× no painel; o cabeçalho é o único sítio`,
    );
    assert.match(PAGE, /\{targetLine && \(/, "a linha do alvo deixou de ser derivada de `activeScanTarget`");
  });
});

describe("P1-B (2) — barra proporcional só com denominador real", () => {
  const campoPasta = {
    id: "scan-p1b",
    type: "custom",
    status: "running" as const,
    phase: "scanning" as const,
    progress: 16,
    filesTotal: 800,
    filesDiscovered: 800,
    filesScanned: 128,
  };

  test("denominador real + fase scanning: o contador e a barra mostram o número do motor", () => {
    const estado = normalizeScanState(campoPasta)!;
    const percent = scanProgressPercent(estado);
    assert.equal(percent, 16, "128/800 é 16%");

    const pasta = scanProgressReadout({ scope: "folder", ui: "scanning", percent, discovered: 800 });
    assert.deepEqual(pasta, { label: "16%", percent: 16 });

    // O mesmo vale para a análise do computador: a regra deixou de ser por âmbito.
    const computador = scanProgressReadout({ scope: "computer", ui: "scanning", percent, discovered: 800 });
    assert.deepEqual(computador, { label: "16%", percent: 16 });
  });

  test("sem denominador real a barra é INDETERMINADA e o contador não inventa %", () => {
    const semTotal = normalizeScanState({ ...campoPasta, filesTotal: undefined })!;
    assert.equal(scanProgressPercent(semTotal), null);

    for (const scope of ["computer", "folder"] as const) {
      assert.deepEqual(
        scanProgressReadout({ scope, ui: "scanning", percent: null, discovered: 800 }),
        { label: "a analisar", percent: null },
        `${scope}: sem total não há percentagem para afirmar`,
      );
    }
  });

  test("antes de o motor medir (preparing) nada é afirmado", () => {
    assert.deepEqual(scanProgressReadout({ scope: "folder", ui: "preparing", percent: null, discovered: 0 }), {
      label: "…",
      percent: null,
    });
  });

  test("enumeração: conta o que encontrou, sem percentagem nenhuma", () => {
    assert.deepEqual(scanProgressReadout({ scope: "folder", ui: "gathering", percent: null, discovered: 0 }), {
      label: "0 ficheiros",
      percent: null,
    });
    assert.deepEqual(scanProgressReadout({ scope: "computer", ui: "gathering", percent: null, discovered: 1 }), {
      label: "1 ficheiro",
      percent: null,
    });
  });

  test("ficheiro único: 'a verificar' e depois 100%, como antes", () => {
    assert.deepEqual(
      scanProgressReadout({ scope: "file", ui: "scanning", percent: 0, discovered: 1, hasFileActivity: false }),
      { label: "a verificar", percent: null },
    );
    assert.deepEqual(
      scanProgressReadout({ scope: "file", ui: "scanning", percent: 100, discovered: 1, hasFileActivity: true }),
      { label: "100%", percent: 100 },
    );
  });

  test("finalizing fecha a análise: não mede progresso, logo não mostra número", () => {
    assert.deepEqual(scanProgressReadout({ scope: "computer", ui: "finalizing", percent: 99, discovered: 800 }), {
      label: "a concluir",
      percent: null,
    });
  });

  test("a percentagem devolvida é sempre a do motor, ou null — nunca reescalada", () => {
    for (let p = 0; p <= 100; p++) {
      const r = scanProgressReadout({ scope: "folder", ui: "scanning", percent: p, discovered: 800 });
      assert.equal(r.percent, p);
    }
    // Valores impossíveis não passam pelo normalizador: ficam null na origem.
    const impossivel = normalizeScanState({ ...campoPasta, filesScanned: 99999 })!;
    assert.ok((scanProgressPercent(impossivel) ?? 0) <= 100, "a % do pipeline nunca passa de 100");
  });

  test("a largura vem da fonte declarada (`scanPrimaryBar`, P0-A) e não de um âmbito", () => {
    // P0-A decide de onde vem a percentagem (pipeline / etapa / nenhuma); o
    // renderer só desenha. A regressão que se quer impedir era a barra ficar
    // indeterminada para tudo o que não fosse o computador.
    assert.match(PAGE, /const bar = scanPrimaryBar\(scanProgress\)/);
    assert.match(PAGE, /style=\{\{ width: `\$\{bar\.percent\}%` \}\}/);
    assert.equal(
      /scope === "computer" && uiStatus === "scanning"/.test(PAGE),
      false,
      "a proporção voltou a estar limitada ao âmbito «computer»",
    );
    // O detalhe recebe os ficheiros já verificados dentro do batch.
    assert.match(PAGE, /scanProgress\?\.filesAnalyzed \?\? 0/);
  });
});

describe("P1-B (3) — a medição (ETA/velocidade) não regride", () => {
  test("sem amostra suficiente não se estima tempo nenhum", () => {
    const estado = normalizeScanState({
      id: "s1",
      type: "custom",
      status: "running",
      phase: "scanning",
      progress: 0,
      filesTotal: 800,
      filesScanned: 9,
      filesPerSecond: 20,
    })!;
    assert.equal(scanEtaSeconds(estado), null, "9 ficheiros não são amostra suficiente");
    assert.equal(formatEta(null), null);
  });

  test("com amostra suficiente o ETA é arredondado e dito em linguagem humana", () => {
    const estado = normalizeScanState({
      id: "s1",
      type: "custom",
      status: "running",
      phase: "scanning",
      progress: 0,
      filesTotal: 800,
      filesScanned: 800,
      filesPerSecond: 0,
    })!;
    assert.equal(scanEtaSeconds(estado), null, "velocidade 0 não produz estimativa");

    const bom = normalizeScanState({
      id: "s1",
      type: "custom",
      status: "running",
      phase: "scanning",
      progress: 0,
      filesTotal: 800,
      filesScanned: 400,
      filesPerSecond: 100,
    })!;
    assert.equal(scanEtaSeconds(bom), 4);
    assert.equal(formatEta(4), "~4s restantes");
    assert.equal(formatEta(1), "menos de 1 segundo restante");
    assert.equal(formatEta(600), "~10 min restantes");
  });

  test("velocidade continua a ser '—' enquanto não há ficheiros analisados", () => {
    const batch = normalizeScanState({
      id: "s1",
      type: "custom",
      status: "running",
      phase: "scanning",
      progress: 0,
      filesScanned: 0,
      filesAnalyzed: 0,
      filesInEngineBatch: 20,
      filesPerSecond: 0,
    })!;
    assert.equal(scanRateLabel(batch), "—");
  });
});

describe("P1-B (4) — os quatro cartões de métricas são uma receita só", () => {
  test("nenhum cartão tem ícone em linha (a divergência de densidade que se viu)", () => {
    assert.equal(
      /<Activity className="w-4 h-4 text-primary" \/>/.test(PAGE),
      false,
      "voltou o ícone em linha no cartão da velocidade",
    );
    assert.equal(
      /<Clock className="w-4 h-4 text-primary" \/>/.test(PAGE),
      false,
      "voltou o ícone em linha no cartão do tempo decorrido",
    );
  });

  test("os valores das métricas são todos tabulares (os dígitos não saltam)", () => {
    const valores = PAGE.match(/text-xl font-mono font-bold text-foreground tabular-nums/g) ?? [];
    assert.ok(valores.length >= 2, `esperava os cartões homogéneos, encontrei ${valores.length}`);
    assert.match(PAGE, /text-cyber-red tabular-nums/);
    assert.match(PAGE, /font-bold text-foreground tabular-nums", scope === "file"/);
  });
});

/**
 * P0 UX (15/10) — o cartão em curso tem UM progresso e mais nada que se pareça
 * com uma barra:
 *
 *  · a barra funcional é UMA só e lê `scanPrimaryBar` (`bar.percent`);
 *  · o «registo» escuro da página — `bg-black/40`, altura de barra quando
 *    vazio — saiu: ficava vazio durante TODA a análise, porque o primeiro
 *    evento do motor limpava a única linha que tinha, e o que escrevia no fim
 *    (mensagem terminal, motivos de falha) só acontecia quando este cartão já
 *    não estava em cena (o cartão de RESULTADO substitui-o no instante
 *    terminal). Era, por isso, a segunda barra escura vazia do ecrã;
 *  · o cancelamento e os motivos das falhas passam a ser ditos onde se lêem.
 */
describe("P0 UX (15/10) — uma barra só, sem segunda barra escura vazia", () => {
  test("a vista desenha exatamente UMA barra funcional, e é a da fonte declarada", () => {
    const barras = PAGE.match(/h-2 bg-secondary rounded-full overflow-hidden/g) ?? [];
    assert.equal(barras.length, 1, `encontrei ${barras.length} barras funcionais no cartão`);
    assert.match(PAGE, /const bar = scanPrimaryBar\(scanProgress\)/);
    assert.match(PAGE, /style=\{\{ width: `\$\{bar\.percent\}%` \}\}/);
  });

  test("a segunda barra escura (o registo) não volta", () => {
    assert.equal(/scanLog/.test(PAGE), false, "voltou o registo do scanner");
    assert.equal(/bg-black\/40/.test(PAGE), false, "voltou uma strip escura ao cartão em curso");
    assert.equal(/max-h-48 overflow-y-auto/.test(PAGE), false, "voltou a caixa do registo");
  });

  test("o cancelamento pedido é dito no cartão, com a frase testada", () => {
    assert.equal(
      SCAN_CANCEL_REQUESTED_NOTE,
      "Cancelamento pedido ao motor. A análise só termina quando o motor confirmar.",
    );
    assert.match(PAGE, /\{cancelRequested && \(/, "a nota do cancelamento deixou de ser condicional");
    assert.match(PAGE, /\{SCAN_CANCEL_REQUESTED_NOTE\}/, "a nota do cancelamento não é mostrada");
    // A frase antiga vivia no registo escuro: não pode ter ficado só lá.
    assert.match(PAGE, /text-cyber-yellow">\s*\n\s*\{SCAN_CANCEL_REQUESTED_NOTE\}/);
  });

  test("os motivos das falhas aparecem no cartão de resultado, não num registo invisível", () => {
    assert.match(
      PAGE,
      /motivosDeFalha = \(scanProgress\.filesFailed \?\? 0\) > 0\s*\n\s*\? failureReasonsLabel\(\(scanProgress as ScanStateExtended\)\.failedByReason\)/,
    );
    assert.match(PAGE, /Motivos das falhas:/);
    assert.match(PAGE, /\{motivosDeFalha && \(/);
  });
});

/**
 * P0 UX (15/10) — histórico atualiza. O gatilho continua a ser o id terminal
 * (sem polling nem temporizador, contrato de R7-L3), e o serviço grava o
 * registo logo a seguir ao evento terminal: quando a leitura chega primeiro, o
 * painel di-lo em vez de mostrar uma lista que parece não ter registado nada.
 */
describe("P0 UX (15/10) — o histórico diz quando o registo ainda não chegou", () => {
  test("a condição é derivada do que foi lido, sem timers", () => {
    assert.match(PANEL, /const registoDoTerminalEmFalta =\s*\n\s*sessaoTerminada !== null && fase === "pronto" && !entradas\.some\(\(e\) => e\.id === sessaoTerminada\)/);
    assert.equal(/setInterval|setTimeout/.test(PANEL), false, "o painel passou a refrescar por temporizador");
  });

  test("quando falta, é dito — e a lista vazia não afirma «não há análises»", () => {
    assert.match(PANEL, /const notaRegistoPendente =/);
    assert.match(PANEL, /registoDoTerminalEmFalta\s*\n\s*\? notaRegistoPendente\s*\n\s*: "Ainda não há análises registadas/);
    assert.match(PANEL, /\{registoDoTerminalEmFalta && total > 0 && \(/);
    assert.match(PANEL, /<p className="row-note">\{notaRegistoPendente\}<\/p>/);
  });
});
