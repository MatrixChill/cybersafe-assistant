import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  NO_DETECTIONS_NOTE,
  SCAN_ACTION_CARDS,
  SCAN_STALL_MS,
  SCAN_HYDRATING_DETAIL,
  SCAN_HYDRATING_TITLE,
  SCAN_RESULT_LABELS,
  activeScanDetail,
  activeScanTitle,
  buildResultSummary,
  conciseResultSummary,
  decideScanEvent,
  decideScanRecovery,
  formatEta,
  isActiveUiStatus,
  isTerminalScanStatus,
  isTerminalUiStatus,
  mergeScanState,
  normalizeScanState,
  normalizeScanType,
  scanEtaSeconds,
  scanPrimaryBar,
  scanProgressPercent,
  scanRateLabel,
  scanScopeFor,
  scopeFromIntent,
  scopeTitle,
  showNoThreatsReassurance,
  shouldAcceptScanState,
  shouldShowHydration,
  resultFollowUpNote,
  resultFilesWithoutDetections,
  resultFilesWithoutDetectionsNote,
  terminalResultLabels,
  uiStatusForState,
} from "../src/lib/scanSession";

/** Payload exactly as ProtectionEngineService.emitScanProgress() sends it. */
function scanState(overrides: Record<string, unknown> = {}) {
  return {
    id: "6f2b6f2b-1111-2222-3333-444455556666",
    type: "custom",
    status: "running",
    progress: 42,
    filesScanned: 42,
    threatsFound: 1,
    startTime: "2026-09-21T10:00:00.000Z",
    targetPath: "C:\\Users\\caioc\\Downloads",
    phase: "scanning",
    filesPerSecond: 12.5,
    currentFile: "report.pdf",
    ...overrides,
  };
}

describe("normalizeScanState — payload contract", () => {
  test("accepts the canonical service payload", () => {
    const state = normalizeScanState(scanState());
    assert.ok(state);
    assert.equal(state!.id, "6f2b6f2b-1111-2222-3333-444455556666");
    assert.equal(state!.status, "running");
    assert.equal(state!.phase, "scanning");
    assert.equal(state!.progress, 42);
    assert.equal(state!.filesScanned, 42);
    assert.equal(state!.threatsFound, 1);
    assert.equal(state!.filesPerSecond, 12.5);
    assert.equal(state!.currentFile, "report.pdf");
    assert.equal(state!.targetPath, "C:\\Users\\caioc\\Downloads");
  });

  test("normalizes a `scanId` field to the canonical `id`", () => {
    const raw = scanState();
    delete (raw as Record<string, unknown>).id;
    const state = normalizeScanState({ ...raw, scanId: "abc-123" });
    assert.ok(state, "a payload using scanId must still be usable");
    assert.equal(state!.id, "abc-123");
  });

  test("unwraps a nested { state } / { scanState } payload", () => {
    const nested = normalizeScanState({ state: scanState({ id: "nested-1" }) });
    assert.equal(nested?.id, "nested-1");
    const nestedAlias = normalizeScanState({ scanState: scanState({ id: "nested-2" }) });
    assert.equal(nestedAlias?.id, "nested-2");
  });

  test("rejects payloads without an id (legacy fullSystem scan.progress event)", () => {
    // runFullSystemScan() publishes scan.progress events with data = { progress }
    // and no id — they must never be applied to the active scan session.
    assert.equal(normalizeScanState({ progress: 0 }), null);
    assert.equal(normalizeScanState({ progress: 100, done: true }), null);
  });

  test("rejects an unknown status", () => {
    assert.equal(normalizeScanState(scanState({ status: "bogus" })), null);
  });

  test("rejects non-object payloads", () => {
    assert.equal(normalizeScanState(null), null);
    assert.equal(normalizeScanState(undefined), null);
    assert.equal(normalizeScanState("scan"), null);
    assert.equal(normalizeScanState(7), null);
  });

  test("clamps progress and defaults missing counters", () => {
    const state = normalizeScanState({ id: "x", status: "running", progress: 250, filesScanned: -3 });
    assert.ok(state);
    assert.equal(state!.progress, 100);
    assert.equal(state!.filesScanned, 0);
    assert.equal(state!.threatsFound, 0);
    assert.equal(state!.phase, undefined);
  });

  test("reduces currentFile to the basename (no usernames in the UI)", () => {
    const state = normalizeScanState(scanState({ currentFile: "C:\\Users\\caioc\\Desktop\\segredo\\invoice.pdf" }));
    assert.equal(state!.currentFile, "invoice.pdf");
  });

  test("keeps truthful counters (discovered vs analyzed vs failed)", () => {
    const state = normalizeScanState(scanState({
      phase: "gathering",
      progress: 0,
      filesScanned: 0,
      filesDiscovered: 143,
      filesFailed: 2,
    }));
    assert.ok(state);
    assert.equal(state!.filesDiscovered, 143);
    assert.equal(state!.filesScanned, 0);
    assert.equal(state!.filesFailed, 2);
  });

  test("normalizes the target kind reported by the service", () => {
    assert.equal(normalizeScanState(scanState({ targetKind: "file" }))!.targetKind, "file");
    assert.equal(normalizeScanState(scanState({ targetKind: "directory" }))!.targetKind, "directory");
    assert.equal(normalizeScanState(scanState({ targetKind: "bogus" }))!.targetKind, undefined);
  });
});

describe("decideScanEvent — scanId filtering", () => {
  test("buffers when no scan is expected yet (start → event → response race)", () => {
    const state = normalizeScanState(scanState())!;
    assert.equal(decideScanEvent(state, null), "buffer");
  });

  test("accepts the event of the expected scan", () => {
    const state = normalizeScanState(scanState())!;
    assert.equal(decideScanEvent(state, state.id), "accept");
  });

  test("ignores events from another (stale) scan", () => {
    const state = normalizeScanState(scanState())!;
    assert.equal(decideScanEvent(state, "some-other-scan-id"), "ignore");
  });
});

describe("uiStatusForState — phase mapping", () => {
  const cases: { raw: Record<string, unknown>; expected: string }[] = [
    { raw: { status: "queued", phase: "preparing" }, expected: "preparing" },
    { raw: { status: "running", phase: "preparing" }, expected: "preparing" },
    { raw: { status: "running", phase: "gathering" }, expected: "gathering" },
    { raw: { status: "running", phase: undefined }, expected: "gathering" },
    { raw: { status: "running", phase: "scanning" }, expected: "scanning" },
    { raw: { status: "running", phase: "finalizing" }, expected: "finalizing" },
    { raw: { status: "completed", phase: "finalizing" }, expected: "completed" },
    { raw: { status: "cancelled" }, expected: "cancelled" },
    { raw: { status: "failed" }, expected: "failed" },
  ];

  for (const c of cases) {
    test(`${c.raw.status} + phase=${c.raw.phase ?? "none"} → ${c.expected}`, () => {
      const state = normalizeScanState(scanState(c.raw as Record<string, unknown>))!;
      assert.equal(uiStatusForState(state), c.expected);
    });
  }
});

describe("terminal/active helpers", () => {
  test("terminal statuses", () => {
    assert.equal(isTerminalScanStatus("completed"), true);
    assert.equal(isTerminalScanStatus("cancelled"), true);
    assert.equal(isTerminalScanStatus("failed"), true);
    assert.equal(isTerminalScanStatus("running"), false);
    assert.equal(isTerminalScanStatus("queued"), false);

    assert.equal(isTerminalUiStatus("completed"), true);
    assert.equal(isTerminalUiStatus("scanning"), false);
  });

  test("active UI statuses drive the watchdog", () => {
    assert.equal(isActiveUiStatus("preparing"), true);
    assert.equal(isActiveUiStatus("gathering"), true);
    assert.equal(isActiveUiStatus("scanning"), true);
    assert.equal(isActiveUiStatus("finalizing"), true);
    assert.equal(isActiveUiStatus("idle"), false);
    assert.equal(isActiveUiStatus("completed"), false);
  });

  test("scan type normalization", () => {
    assert.equal(normalizeScanType("quick"), "quick");
    assert.equal(normalizeScanType("full"), "full");
    assert.equal(normalizeScanType("custom"), "custom");
    assert.equal(normalizeScanType(""), "custom");
    assert.equal(normalizeScanType(undefined), "custom");
  });
});

describe("naming das análises (UX para leigos)", () => {
  test("os quatro nomes e descrições são os combinados", () => {
    const byKind = Object.fromEntries(SCAN_ACTION_CARDS.map((card) => [card.kind, card]));
    assert.equal(byKind.quick.title, "Análise Rápida do Computador");
    assert.equal(byKind.full.title, "Análise Profunda do Computador");
    assert.equal(byKind.file.title, "Analisar um Ficheiro");
    assert.equal(byKind.folder.title, "Analisar uma Pasta");
    assert.match(byKind.quick.description, /áreas mais importantes/);
    assert.match(byKind.full.description, /abrangente/);
    assert.match(byKind.file.description, /ficheiro específico/);
    assert.match(byKind.folder.description, /dentro da pasta/);
    // Nenhum nome pode sugerir que a "análise rápida" é de um ficheiro, nem
    // sobrar linguagem antiga ("completa").
    assert.equal(SCAN_ACTION_CARDS.some((card) => /completa/i.test(card.title)), false);
    assert.equal(SCAN_ACTION_CARDS.some((card) => /^(Rápida|Completa|Pasta)$/.test(card.title)), false);
  });

  test("o âmbito vem da intenção e do alvo real reportado pelo serviço", () => {
    assert.equal(scopeFromIntent("quick"), "computer");
    assert.equal(scopeFromIntent("full"), "computer");
    assert.equal(scopeFromIntent("file"), "file");
    assert.equal(scopeFromIntent("folder"), "folder");
    // O alvo real do serviço manda sobre a intenção (pasta largada como ficheiro).
    assert.equal(scanScopeFor({ type: "custom", targetKind: "directory" }, "file"), "folder");
    assert.equal(scanScopeFor({ type: "custom", targetKind: "file" }, "folder"), "file");
    assert.equal(scanScopeFor({ type: "custom" }, "folder"), "folder");
    assert.equal(scanScopeFor({ type: "quick" }), "computer");
    assert.equal(scanScopeFor({ type: "full" }, "full"), "computer");
  });

  test("títulos e detalhes por âmbito/fase", () => {
    assert.equal(scopeTitle("computer", "quick"), "Análise Rápida do Computador");
    assert.equal(scopeTitle("computer", "full"), "Análise Profunda do Computador");
    assert.equal(scopeTitle("file", "custom"), "Analisar um Ficheiro");
    assert.equal(scopeTitle("folder", "custom"), "Analisar uma Pasta");
    assert.equal(activeScanTitle("file", "preparing"), "A preparar a análise do ficheiro...");
    assert.equal(activeScanTitle("file", "scanning"), "A analisar o ficheiro...");
    assert.equal(activeScanTitle("folder", "scanning"), "A analisar os ficheiros da pasta...");
    assert.equal(activeScanTitle("computer", "scanning"), "Análise em execução");
    assert.equal(activeScanTitle("computer", "preparing"), "A preparar a análise do computador...");
    assert.match(activeScanDetail("file", "custom", "preparing"), /motor de análise/);
    assert.match(activeScanDetail("folder", "custom", "gathering", "Downloads"), /Downloads/);
    assert.match(activeScanDetail("computer", "full", "gathering"), /pastas do seu utilizador/);
    assert.match(activeScanDetail("computer", "quick", "gathering"), /áreas prioritárias/);
  });
});

describe("resumo final por tipo de análise", () => {
  test("análise rápida concluída sem ameaças", () => {
    const summary = buildResultSummary({ scope: "computer", type: "quick", status: "completed", filesConsidered: 800, threatsFound: 0 });
    assert.equal(
      summary,
      "A análise rápida do computador foi concluída. Foram analisados 800 ficheiros em áreas prioritárias do sistema e não foram encontradas ameaças.",
    );
  });

  test("análise rápida com ameaças", () => {
    const summary = buildResultSummary({ scope: "computer", type: "quick", status: "completed", filesConsidered: 143, threatsFound: 3 });
    assert.match(summary, /Foram analisados 143 ficheiros/);
    assert.match(summary, /foram encontradas 3 ameaças/);
  });

  test("análise profunda descreve o scope real", () => {
    const summary = buildResultSummary({ scope: "computer", type: "full", status: "completed", filesConsidered: 12000, threatsFound: 0 });
    assert.match(summary, /A análise profunda do computador foi concluída/);
    assert.match(summary, /pastas do seu utilizador e nos arranques automáticos/);
  });

  test("ficheiro único", () => {
    const clean = buildResultSummary({ scope: "file", type: "custom", status: "completed", filesConsidered: 1, threatsFound: 0, targetName: "invoice.pdf" });
    assert.equal(clean, "A análise do ficheiro «invoice.pdf» foi concluída: Foi analisado 1 ficheiro e não foram encontradas ameaças.");
    const dirty = buildResultSummary({ scope: "file", type: "custom", status: "completed", filesConsidered: 1, threatsFound: 1, targetName: "evil.exe" });
    assert.match(dirty, /foi encontrada 1 ameaça/);
  });

  test("pasta", () => {
    const summary = buildResultSummary({ scope: "folder", type: "custom", status: "completed", filesConsidered: 42, threatsFound: 0, targetName: "Downloads" });
    assert.match(summary, /A análise da pasta «Downloads» foi concluída/);
    assert.match(summary, /Foram analisados 42 ficheiros dentro da pasta/);
  });

  test("considerados ≠ analisados: o resumo diz os dois números (nunca 'verificados 800')", () => {
    const summary = buildResultSummary({
      scope: "computer",
      type: "quick",
      status: "completed",
      filesConsidered: 800,
      filesAnalyzed: 663,
      filesExcluded: 137,
      threatsFound: 0,
    });
    assert.match(summary, /Foram analisados 663 de 800 ficheiros considerados/);
    assert.match(summary, /137 ficheiros foram ignorados pelas exclusões/);
    assert.doesNotMatch(summary, /800 ficheiros verificados/);
    assert.doesNotMatch(summary, /analisados 800/);
  });

  test("sem ficheiros, cancelada e falhada", () => {
    assert.match(
      buildResultSummary({ scope: "folder", type: "custom", status: "completed", filesConsidered: 0, threatsFound: 0, targetName: "Vazia" }),
      /Não foram encontrados ficheiros/,
    );
    assert.match(
      buildResultSummary({ scope: "file", type: "custom", status: "completed", filesConsidered: 0, threatsFound: 0 }),
      /não pôde ser verificado/,
    );
    assert.match(
      buildResultSummary({ scope: "computer", type: "quick", status: "cancelled", filesConsidered: 120, threatsFound: 0 }),
      // TP-A5-D1: este caso NAO tem `filesAnalyzed` — o motor nunca reportou a
      // contagem de analisados. O assert antigo ("depois de analisar 120
      // ficheiros considerados") exigia o fallback considerados->analisados que
      // A5 corrigiu; agora exige o honesto, com os considerados ainda ditos.
      /cancelada: o motor não indicou quantos dos 120 ficheiros considerados chegaram a ser analisados/,
    );
    assert.match(
      buildResultSummary({ scope: "computer", type: "quick", status: "failed", filesConsidered: 0, threatsFound: 0, error: "sem ligação" }),
      /Não foi possível concluir a análise: sem ligação/,
    );
    // Cancelamento a meio: dose os dois números, senão "120" parece completo.
    assert.match(
      buildResultSummary({
        scope: "computer",
        type: "quick",
        status: "cancelled",
        filesConsidered: 800,
        filesAnalyzed: 120,
        threatsFound: 0,
      }),
      /Análise cancelada: 120 de 800 ficheiros considerados chegaram a ser analisados/,
    );
  });

  test("erros de leitura são mencionados no resumo", () => {
    const summary = buildResultSummary({ scope: "computer", type: "quick", status: "completed", filesConsidered: 10, threatsFound: 0, filesFailed: 2 });
    assert.match(summary, /2 ficheiros não puderam ser analisados/);
  });
});

describe("truthfulness do resultado (nenhuma deteção ≠ garantia absoluta)", () => {
  const FORBIDDEN = [/100% seguro/i, /comprovadamente/i, /ficheiros seguros/i, /nada de suspeito/i];

  test("o cartão deixou de dizer \"Ficheiros Seguros\"", () => {
    assert.equal(SCAN_RESULT_LABELS.filesWithoutDetections, "Ficheiros sem deteções");
    assert.equal(/seguro/i.test(SCAN_RESULT_LABELS.filesWithoutDetections), false);
    // "Considerados" (candidatos) e "Analisados pelos motores" são factos
    // diferentes: o rótulo antigo chamava "Ficheiros Verificados" a um número
    // que incluía ficheiros nunca enviados a motor nenhum.
    assert.equal(SCAN_RESULT_LABELS.filesConsidered, "Ficheiros considerados");
    assert.equal(SCAN_RESULT_LABELS.filesAnalyzed, "Analisados pelos motores");
    assert.equal(/verificad/i.test(SCAN_RESULT_LABELS.filesConsidered), false);
    assert.equal(SCAN_RESULT_LABELS.threatsFound, "Ameaças Encontradas");
  });

  test("o aviso explica que não há garantia absoluta", () => {
    assert.match(NO_DETECTIONS_NOTE, /não garante/i);
  });

  test("nenhuma frase do resultado promete segurança absoluta", () => {
    const scenarios = [
      { scope: "computer" as const, type: "quick" as const, filesConsidered: 800, threatsFound: 0 },
      { scope: "computer" as const, type: "full" as const, filesConsidered: 12000, threatsFound: 0 },
      { scope: "file" as const, type: "custom" as const, filesConsidered: 1, threatsFound: 0, targetName: "nota.txt" },
      { scope: "folder" as const, type: "custom" as const, filesConsidered: 42, threatsFound: 0, targetName: "Docs" },
    ];
    for (const scenario of scenarios) {
      const summary = buildResultSummary({ ...scenario, status: "completed" });
      for (const forbidden of FORBIDDEN) {
        assert.equal(forbidden.test(summary), false, `frase proibida em: ${summary}`);
      }
      // A formulação factual é permitida e usada.
      assert.match(summary, /não foram encontradas ameaças/);
    }
  });

  test("a descrição da análise profunda não promete o computador inteiro", () => {
    const full = SCAN_ACTION_CARDS.find((card) => card.kind === "full")!;
    assert.match(full.description, /pastas do seu utilizador/);
    for (const forbidden of [/todo o computador/i, /todo o sistema/i, /sistema completo/i, /computador inteiro/i]) {
      assert.equal(forbidden.test(full.description), false, `promessa falsa em: ${full.description}`);
    }
  });

  test("nenhum resumo afirma verificar todo o sistema", () => {
    const summary = buildResultSummary({ scope: "computer", type: "full", status: "completed", filesConsidered: 500, threatsFound: 0 });
    for (const forbidden of [/todo o sistema/i, /sistema completo/i, /todo o computador/i]) {
      assert.equal(forbidden.test(summary), false, `promessa falsa em: ${summary}`);
    }
  });

  test("o detalhe da fase descreve as zonas reais, não \"o sistema\"", () => {
    const detail = activeScanDetail("computer", "full", "gathering");
    assert.match(detail, /pastas do seu utilizador/);
    assert.equal(/todo o sistema/i.test(detail), false);
  });
});

describe("progresso real e contadores monotónicos", () => {
  const normalize = (overrides: Record<string, unknown>) => normalizeScanState(scanState(overrides))!;

  test("normaliza os contadores novos (total/analyzed/excluded/revision)", () => {
    const state = normalize({
      phase: "scanning",
      filesTotal: 899,
      filesScanned: 885,
      filesAnalyzed: 880,
      filesExcluded: 4,
      filesFailed: 1,
      revision: 42,
      updatedAt: "2026-09-21T10:01:00.000Z",
    });
    assert.equal(state.filesTotal, 899);
    assert.equal(state.filesAnalyzed, 880);
    assert.equal(state.filesExcluded, 4);
    assert.equal(state.revision, 42);
    assert.equal(state.updatedAt, "2026-09-21T10:01:00.000Z");
  });

  test("885/899 = 98%, nunca 1% (o cap de 50.000 não é denominador)", () => {
    const state = normalize({ phase: "scanning", filesTotal: 899, filesScanned: 885 });
    assert.equal(scanProgressPercent(state), 98);
  });

  test("sem total conhecido (gathering) → null (barra indeterminada, sem % inventada)", () => {
    const gathering = normalize({ phase: "gathering", filesDiscovered: 899, filesScanned: 0, filesTotal: undefined });
    assert.equal(scanProgressPercent(gathering), null);
    const preparing = normalize({ phase: "preparing", filesTotal: undefined });
    assert.equal(scanProgressPercent(preparing), null);
    // Terminal sem total ainda mostra 100 do backend.
    const done = normalize({ status: "completed", phase: "finalizing", progress: 100, filesTotal: undefined });
    assert.equal(scanProgressPercent(done), 100);
  });

  test("shouldAcceptScanState rejeita estado atrasado e nunca reabre terminal", () => {
    const current = normalize({ phase: "scanning", filesTotal: 899, filesScanned: 500, revision: 30 });
    const late = normalize({ phase: "scanning", filesTotal: 899, filesScanned: 302, revision: 12 });
    assert.equal(shouldAcceptScanState(current, late), false, "revisão inferior é ignorada");

    const fresh = normalize({ phase: "scanning", filesTotal: 899, filesScanned: 600, revision: 31 });
    assert.equal(shouldAcceptScanState(current, fresh), true);

    const finished = normalize({ status: "completed", phase: "finalizing", progress: 100, filesScanned: 899, revision: 40 });
    assert.equal(shouldAcceptScanState(finished, fresh), false, "um scan terminado não reabre");
  });

  test("mergeScanState mantém os contadores a subir", () => {
    const current = normalize({ phase: "scanning", filesTotal: 899, filesScanned: 500, filesAnalyzed: 490, threatsFound: 2, revision: 30 });
    // Snapshot atrasado com valores menores (não deve recuar nada).
    const late = normalize({ phase: "scanning", filesScanned: 400, filesAnalyzed: 395, threatsFound: 1, revision: 40 });
    const merged = mergeScanState(current, late);
    assert.equal(merged.filesScanned, 500);
    assert.equal(merged.filesAnalyzed, 490);
    assert.equal(merged.threatsFound, 2);
  });

  test("ETA só aparece quando a velocidade é minimamente estável", () => {
    assert.equal(scanEtaSeconds(normalize({ filesTotal: 899, filesScanned: 5, filesPerSecond: 10 })), null, "amostra curta");
    assert.equal(scanEtaSeconds(normalize({ filesTotal: 899, filesScanned: 100, filesPerSecond: 0 })), null, "sem velocidade");
    const eta = scanEtaSeconds(normalize({ filesTotal: 899, filesScanned: 100, filesPerSecond: 10 }));
    assert.equal(eta, 80);
    assert.equal(formatEta(80), "~1 min restantes");
    assert.equal(formatEta(30), "~30s restantes");
    assert.equal(formatEta(null), null);
  });

  test("o resumo menciona ficheiros ignorados pelas exclusões", () => {
    const summary = buildResultSummary({
      scope: "computer",
      type: "full",
      status: "completed",
      filesScanned: 899,
      threatsFound: 0,
      filesExcluded: 4,
    });
    assert.match(summary, /4 ficheiros foram ignorados pelas exclusões/);
    assert.match(summary, /4 ficheiros foram ignorados pelas exclusões e não passaram pelos motores de análise\./);
    assert.doesNotMatch(summary, /passou\/passaram/);
    const singular = buildResultSummary({
      scope: "computer",
      type: "full",
      status: "completed",
      filesScanned: 899,
      threatsFound: 0,
      filesExcluded: 1,
    });
    assert.match(singular, /1 ficheiro foi ignorado pelas exclusões e não passou pelos motores de análise\./);
  });
});

describe("scan session flow (integration of the pure rules)", () => {
  test("start race: buffered early event is applied once the id is known", () => {
    const expectedRef: { current: string | null } = { current: null };
    const buffer = new Map<string, ReturnType<typeof normalizeScanState>>();

    const deliver = (raw: unknown) => {
      const state = normalizeScanState(raw)!;
      const decision = decideScanEvent(state, expectedRef.current);
      if (decision === "buffer") buffer.set(state.id, state);
      return decision;
    };

    // Service emits the first progress before the renderer knows the id.
    assert.equal(deliver(scanState({ id: "scan-1", status: "running", phase: "gathering" })), "buffer");
    assert.equal(buffer.size, 1);

    // startScan resolves with the id.
    expectedRef.current = "scan-1";
    const early = buffer.get("scan-1");
    assert.ok(early, "the early event must still be available after the response");
    assert.equal(early!.id, "scan-1");

    // Later events are accepted directly, other scans are ignored.
    assert.equal(deliver(scanState({ id: "scan-1", status: "running", phase: "scanning" })), "accept");
    assert.equal(deliver(scanState({ id: "scan-old", status: "running" })), "ignore");

    // A completed event arriving immediately after the start must still land.
    assert.equal(deliver(scanState({ id: "scan-1", status: "completed", progress: 100 })), "accept");
  });

  test("navegação: sair e voltar ressincroniza o MESMO scan (sem reiniciar)", () => {
    // O scan vive no serviço; a página React pode desmontar/remontar.
    let state = normalizeScanState(scanState({
      id: "scan-77",
      type: "full",
      status: "running",
      phase: "scanning",
      filesTotal: 5000,
      filesScanned: 1200,
      filesDiscovered: 5000,
      revision: 120,
    }))!;

    // Utilizador navega para o Dashboard: a página desmonta (listener removido).
    // O backend continua; novos eventos continuam a chegar ao serviço.
    const afterNavigation = normalizeScanState(scanState({
      id: "scan-77",
      status: "running",
      phase: "scanning",
      filesTotal: 5000,
      filesScanned: 2600,
      revision: 260,
    }))!;

    // Volta à página: o resync usa o snapshot do backend.
    const snapshot = normalizeScanState(scanState({
      id: "scan-77",
      status: "running",
      phase: "scanning",
      filesTotal: 5000,
      filesScanned: 2600,
      revision: 261,
    }))!;

    // Mesmo scanId: o estado é aceite e continua (não reinicia).
    assert.equal(snapshot.id, "scan-77");
    assert.equal(shouldAcceptScanState(state, afterNavigation), true);
    state = mergeScanState(state, afterNavigation);
    assert.equal(shouldAcceptScanState(state, snapshot), true);
    state = mergeScanState(state, snapshot);
    assert.ok(state.filesScanned >= 2600, "o progresso não recua ao voltar à página");
    assert.equal(scanProgressPercent(state), 52);

    // Cancelar depois de navegar usa o mesmo id.
    const cancelled = normalizeScanState(scanState({
      id: "scan-77",
      status: "cancelled",
      phase: "finalizing",
      filesTotal: 5000,
      filesScanned: 2600,
      revision: 262,
    }))!;
    assert.equal(shouldAcceptScanState(state, cancelled), true);
    state = mergeScanState(state, cancelled);
    assert.equal(isTerminalScanStatus(state.status), true);
  });
});

/**
 * O portão de recuperação. A regra mudou: a tela deixou de ser uma espera
 * cega e passou a exigir PROVA de uma sessão viva. Sem prova, o scanner abre em
 * IDLE — o `hydrating` deixou de nascer a `true` no mount, que era o que
 * prometia "A recuperar análise em curso" em cada abertura do CyberSafe sem
 * qualquer análise para recuperar.
 */
describe("velocidade mostrada — a medição real do arranque", () => {
  // Números vindos de um probe real contra o serviço vivo (2.º arranque, motores
  // quentes): REQUEST->scanId 1984 ms · primeiro progress 1984 ms ·
  // `gathering`->`scanning` 90 653 ms. Durante esses ~88 s o serviço conta
  // ficheiros encontrados (filesDiscovered 0->800) mas filesScanned fica a 0 e
  // SÓ calcula filesPerSecond no ciclo de análise.
  const st = (over: Record<string, unknown>) => ({
    id: "a", type: "quick", status: "running", progress: 0, filesScanned: 0,
    threatsFound: 0, revision: 0, ...over,
  });

  test("a enumerar ficheiros NÃO mostra 0 f/s: mostra que ainda não há velocidade", () => {
    // "0 f/s" afirma que o motor parou. Está a fazer trabalho real.
    assert.equal(scanRateLabel(st({ phase: "gathering", filesDiscovered: 412 })), "—");
  });

  test("a preparar também não mostra 0 f/s", () => {
    assert.equal(scanRateLabel(st({ phase: "preparing" })), "—");
  });

  test("sem estado nenhum, não inventa velocidade", () => {
    assert.equal(scanRateLabel(null), "—");
  });

  test("a analisar com velocidade real, mostra a velocidade real", () => {
    // Só depois de haver ficheiros analisados é que a velocidade significa algo.
    assert.equal(scanRateLabel(st({ phase: "scanning", filesScanned: 89, filesTotal: 800, filesPerSecond: 12.5 })), "12.5 f/s");
  });

  test("a analisar sem velocidade conhecida, honesto é '—' e não 0", () => {
    // filesScanned > 0 mas o serviço ainda não mandou filesPerSecond.
    assert.equal(scanRateLabel(st({ phase: "scanning", filesScanned: 30, filesTotal: 800 })), "—");
  });

  test("já terminado, mostra a velocidade final que o serviço mediu", () => {
    assert.equal(scanRateLabel(st({ status: "completed", filesScanned: 800, filesTotal: 800, filesPerSecond: 9.1 })), "9.1 f/s");
  });
});

describe("scanner hydration gate", () => {
  test("sem sessão comprovada, nunca promete recuperar uma análise", () => {
    // A regressão que importa: hydrating a true, idle, e NADA comprovado.
    // Antes isto era `true` — a tela mentia em cada arranque.
    assert.equal(shouldShowHydration(true, "idle", false), false);
  });

  test("com sessão viva comprovada, mostra a recuperação em vez do idle", () => {
    assert.equal(shouldShowHydration(true, "idle", true), true);
  });

  test("depois do resync, nunca hidrata (mostra idle)", () => {
    assert.equal(shouldShowHydration(false, "idle", true), false);
  });

  test("nunca esconde uma análise ativa atrás da recuperação", () => {
    for (const status of ["preparing", "gathering", "scanning", "finalizing"] as const) {
      assert.equal(shouldShowHydration(true, status, true), false, status);
    }
  });

  test("nunca substitui um resultado terminal", () => {
    for (const status of ["completed", "cancelled", "failed"] as const) {
      assert.equal(shouldShowHydration(true, status, true), false, status);
    }
  });

  test("a cópia de recuperação é explícita e não promete resultados", () => {
    assert.match(SCAN_HYDRATING_TITLE, /recuperar/i);
    assert.ok(SCAN_HYDRATING_DETAIL.length > 0);
  });
});

/**
 * As quatro regressões do P0. Fixam a DECISÃO (`decideScanRecovery`), não a
 * estética: o que separa "abrir o CyberSafe" de "retomar uma análise" é o que
 * o motor responde, e nada mais.
 */
describe("recuperação de análise — a decisão, não a tela", () => {
  test("CASO A: abrir sem análise recente ou interrompida — nada a recuperar", () => {
    for (const raw of [null, undefined, {}, { id: "" }, { type: "quick" }, "scan", 42, []]) {
      assert.equal(decideScanRecovery(raw), null, JSON.stringify(raw));
    }
    // E o portão concorda: sem decisão, não há promessa na tela.
    assert.equal(shouldShowHydration(true, "idle", false), false);
  });

  test("CASO B: análise terminada normalmente, depois restart — nada a recuperar", () => {
    // Carimbo fresco de propósito: a recusa tem de vir do estado TERMINAL, não
    // de um carimbo velho ou em falta.
    const completed = decideScanRecovery(
      scanState({ status: "completed", phase: "finalizing", progress: 100, filesScanned: 1200, filesTotal: 1200, endTime: "2026-09-21T10:30:00.000Z", updatedAt: new Date().toISOString() }),
    );
    assert.equal(completed, null, "completed nunca abre recuperação");
  });

  test("CASO C: cancelada ou falhada terminalmente, depois restart — nada a recuperar", () => {
    // Tal como em B: com carimbo fresco, quem recusa é o estado terminal.
    const fresh = new Date().toISOString();
    assert.equal(decideScanRecovery(scanState({ status: "cancelled", updatedAt: fresh })), null, "cancelled");
    assert.equal(decideScanRecovery(scanState({ status: "failed", error: "motor caiu", updatedAt: fresh })), null, "failed");
    // E o que o serviço devolve quando o PID já não lá estava: "já saiu", que
    // também não é uma sessão retomável.
    assert.equal(decideScanRecovery({ id: "abc", status: "idle", phase: "scanning", filesTotal: 10, updatedAt: fresh }), null, "idle");
  });

  test("CASO D: interrompida a meio, depois restart — recupera E traz dados reais", () => {
    const resumed = decideScanRecovery(
      scanState({ status: "running", phase: "scanning", filesScanned: 340, filesTotal: 1200, progress: 28, updatedAt: new Date().toISOString() }),
    );
    assert.ok(resumed, "uma sessão viva é retomável");
    assert.equal(resumed!.id, "6f2b6f2b-1111-2222-3333-444455556666");
    assert.equal(resumed!.status, "running");
    assert.equal(resumed!.phase, "scanning");
    assert.equal(resumed!.filesScanned, 340, "os contadores verdadeiros chegam com a recuperação");
    assert.equal(resumed!.filesTotal, 1200);
    assert.equal(resumed!.targetPath, "C:\\Users\\caioc\\Downloads");
  });

  test("sessão a correr com `updatedAt` recente — continua a abrir", () => {
    // O heartbeat do serviço carimba `updatedAt` de 1 em 1 s, e o watchdog usa
    // SCAN_STALL_MS como limite de emudecia (scan-manager.ts:155-163,
    // FileScannerPage.tsx:288). Um carimbo dentro desse limite é o produto a
    // dizer que o motor continua a falar: a sessão TEM de ser retomada.
    const beating = scanState({
      status: "running", phase: "scanning", filesScanned: 340, filesTotal: 1200,
      updatedAt: new Date().toISOString(),
    });
    const resumed = decideScanRecovery(beating);
    assert.ok(resumed, "uma sessão viva e a emitir tem de continuar a abrir");
    assert.equal(resumed!.id, "6f2b6f2b-1111-2222-3333-444455556666");
    assert.equal(resumed!.filesScanned, 340, "e a trazer os contadores reais");
    assert.equal(resumed!.filesTotal, 1200);
  });

  test("sessão a correr parada há mais de SCAN_STALL_MS — NÃO é recuperável", () => {
    // Um scan "running" cujo updatedAt já passou o limite está parado pelo
    // critério do próprio produto. Era a ressalva 5: dentro da mesma vida do
    // serviço um scan encravado sem atividade nenhuma continuava a ser
    // oferecido para sempre. Aberta, agora, em idle.
    const silent = new Date(Date.now() - SCAN_STALL_MS - 1_000).toISOString();
    assert.equal(
      decideScanRecovery(scanState({ status: "running", phase: "scanning", filesScanned: 340, filesTotal: 1200, updatedAt: silent })),
      null,
      "sem atividade há mais de SCAN_STALL_MS não há nada a recuperar",
    );
    // Ainda dentro do limite (com folga de 1 s) continua a recuperar: o corte
    // tem de ser o do produto, não um limite arbitrário mais apertado.
    const justBeating = new Date(Date.now() - SCAN_STALL_MS + 1_000).toISOString();
    assert.ok(
      decideScanRecovery(scanState({ status: "running", phase: "scanning", filesScanned: 340, filesTotal: 1200, updatedAt: justBeating })),
      "dentro de SCAN_STALL_MS a sessão ainda é retomável",
    );
  });

  test("sem `updatedAt`, ou com um ilegível — NÃO é recuperável", () => {
    // Porta 4, à letra: o carimbo tem de EXISTIR e ser PARSEÁVEL. Sem ele não há
    // prova suficiente para oferecer Recuperar análise, e sem prova o scanner
    // abre em IDLE. Mesmo com id válido, status vivo e dados para retomar — é a
    // ausência do carimbo que recusa.
    const base = { status: "running", phase: "scanning", filesScanned: 12, filesTotal: 900 };
    assert.equal(
      decideScanRecovery(scanState({ ...base, updatedAt: undefined })),
      null,
      "carimbo ausente não é recuperável",
    );
    assert.equal(
      decideScanRecovery(scanState({ ...base, updatedAt: "ontem" })),
      null,
      "carimbo ilegível não é recuperável",
    );
    assert.equal(
      decideScanRecovery(scanState({ ...base, updatedAt: "" })),
      null,
      "carimbo vazio não é recuperável",
    );
  });

  test("as portas do contrato: id, sessão viva e dados para retomar", () => {
    const fresh = { updatedAt: new Date().toISOString() };
    // Porta 1 — identidade real.
    assert.equal(decideScanRecovery(scanState({ ...fresh, id: "" })), null, "sem id");
    // Porta 2 — sessão viva. `idle` não é terminal, mas também não é vida.
    assert.equal(decideScanRecovery(scanState({ ...fresh, status: "idle" })), null, "idle nao e vida");
    // Porta 3 — dados. Sem fase nem total não há progresso honesto a mostrar.
    assert.equal(decideScanRecovery(scanState({ ...fresh, phase: undefined, filesTotal: undefined })), null, "sem dados");
    // Uma fase viva basta (o serviço escreve `phase` desde o arranque do scan).
    assert.ok(decideScanRecovery(scanState({ ...fresh, status: "queued", phase: "preparing", filesTotal: undefined })), "queued com fase");
    // E um total real basta, sem fase.
    assert.ok(decideScanRecovery(scanState({ ...fresh, status: "running", phase: undefined, filesTotal: 7 })), "running com total");
  });
});

/**
 * Copy de quarentena coerente com o backend REAL (GUI-TEST-01, 15/10): a
 * política efetiva é `warn` — engine.ts só auto-quarenta com
 * `automatic-high-confidence` + critical + malicious + conf≥0.99 + known_bad_hash,
 * que não está ativo. O texto antigo afirmava quarentena automática; isto corrige.
 */
describe("resultFollowUpNote — quarentena honesta", () => {
  test("sem ameaças: nenhuma nota de follow-up", () => {
    assert.equal(resultFollowUpNote("completed", 0), null);
  });

  test("estados não concluídos: nenhuma nota", () => {
    assert.equal(resultFollowUpNote("cancelled", 3), null);
    assert.equal(resultFollowUpNote("failed", 3), null);
    assert.equal(resultFollowUpNote("running", 3), null);
  });

  test("com ameaças: nega isolamento automático e aponta a página Ameaças", () => {
    const note = resultFollowUpNote("completed", 2);
    assert.ok(note);
    assert.match(note, /Nenhum ficheiro foi isolado automaticamente/);
    assert.match(note, /Ameaças/);
    assert.equal(/quarentena automaticamente/.test(note), false, note);
  });
});

/**
 * O cartão de "sem deteções" do resultado. A regra do produto: nunca
 * tranquilizar quando há ameaça, nunca dar conclusão sem análise concluída,
 * e nunca mostrar 0 quando o valor não é conhecido. O número só pode vir de
 * `filesAnalyzed` menos ameaças e resultados inconclusivos — usar
 * `filesScanned` incluiria os excluídos, que nunca foram verificados.
 */
describe("resultFilesWithoutDetections — cartão honesto por estado", () => {
  test("concluída: analisados menos ameaças e inconclusivos, nunca negativo", () => {
    assert.equal(resultFilesWithoutDetections({ status: "completed", filesAnalyzed: 100, threatsFound: 3, filesInconclusive: 0 }), 97);
    assert.equal(resultFilesWithoutDetections({ status: "completed", filesAnalyzed: 2, threatsFound: 5, filesInconclusive: 0 }), 0);
    assert.equal(resultFilesWithoutDetections({ status: "completed", filesAnalyzed: 80, threatsFound: 0, filesInconclusive: 0 }), 80);
    assert.equal(resultFilesWithoutDetections({ status: "completed", filesAnalyzed: 80, threatsFound: 2, filesInconclusive: 3 }), 75);
  });

  test("em curso, cancelada ou falhada: sem contagem (null, nunca 0)", () => {
    assert.equal(resultFilesWithoutDetections({ status: "running", filesAnalyzed: 50, threatsFound: 1 }), null);
    assert.equal(resultFilesWithoutDetections({ status: "cancelled", filesAnalyzed: 50, threatsFound: 1 }), null);
    assert.equal(resultFilesWithoutDetections({ status: "failed", filesAnalyzed: 50, threatsFound: 1 }), null);
  });

  test("concluída sem filesAnalyzed reportado: dados indisponíveis, não se inventa", () => {
    assert.equal(resultFilesWithoutDetections({ status: "completed", filesAnalyzed: undefined, threatsFound: 0, filesInconclusive: 0 }), null);
    assert.equal(resultFilesWithoutDetections({ status: "completed", filesAnalyzed: 4, threatsFound: 0 }), null);
  });

  test("a nota explica a base quando existe e diz por que falta quando não existe", () => {
    assert.match(
      resultFilesWithoutDetectionsNote({ status: "completed", filesAnalyzed: 97, threatsFound: 0, filesInconclusive: 0 }),
      /97 ficheiros? enviados aos motores/,
    );
    assert.match(
      resultFilesWithoutDetectionsNote({ status: "cancelled", filesAnalyzed: 40, threatsFound: 2 }),
      /não foi concluída/,
    );
    assert.match(
      resultFilesWithoutDetectionsNote({ status: "failed", filesAnalyzed: undefined, threatsFound: 0 }),
      /falhou/,
    );
    assert.match(
      resultFilesWithoutDetectionsNote({ status: "completed", filesAnalyzed: undefined, threatsFound: 1 }),
      /não reportou/,
    );
  });

  test("a nota separa o total enviado aos motores dos resultados inconclusivos", () => {
    assert.equal(
      resultFilesWithoutDetectionsNote({
        status: "completed",
        filesAnalyzed: 97,
        threatsFound: 0,
        filesInconclusive: 3,
      }),
      "de 97 ficheiros enviados aos motores; 3 tiveram resultados inconclusivos",
    );
    assert.match(
      resultFilesWithoutDetectionsNote({
        status: "completed",
        filesAnalyzed: 97,
        threatsFound: 0,
      }),
      /estado conclusivo dos 97 ficheiros não foi reportado/,
    );
  });

  test("nenhuma tranquilização com ameaças presentes", () => {
    // O cartão é factual ("Ficheiros sem deteções"); a frase de tranquilização
    // só existe com 0 ameaças (gate já coberto por resultFollowUpNote/render).
    assert.equal(/sem ameaças/i.test(SCAN_RESULT_LABELS.filesWithoutDetections), false);
  });
});

/**
 * A REGRA CRÍTICA, agora num único predicado usado pelo JSX
 * (`showNoThreatsReassurance`): a tranquilização verde — avatar de sucesso,
 * cartão e nota "não foram encontradas ameaças" — só com análise COMPLETA,
 * dados reais do motor e zero ameaças. Os cinco cenários proibidos do
 * sprint 02/10 estão cada um representado aqui.
 */
describe("showNoThreatsReassurance — gate dos 7 estados", () => {
  const stateWith = (overrides: Record<string, unknown> = {}) =>
    normalizeScanState(scanState({
      status: "completed",
      phase: "finalizing",
      progress: 100,
      filesAnalyzed: 1,
      filesFailed: 0,
      filesInconclusive: 0,
      ...overrides,
    }))!;

  test("proibido: scan ainda não terminou (idle, preparar, gathering, scanning, finalizar)", () => {
    const live = stateWith();
    for (const ui of ["idle", "preparing", "gathering", "scanning", "finalizing"] as const) {
      assert.equal(showNoThreatsReassurance(ui, live), false, `ui=${ui} não pode tranquilizar`);
      assert.equal(showNoThreatsReassurance(ui, null), false, `ui=${ui} sem dados não pode tranquilizar`);
    }
  });

  test("proibido: falhada", () => {
    assert.equal(
      showNoThreatsReassurance("failed", stateWith({ status: "failed", error: "motor caiu" })),
      false,
    );
  });

  test("proibido: cancelada", () => {
    assert.equal(
      showNoThreatsReassurance("cancelled", stateWith({ status: "cancelled" })),
      false,
    );
  });

  test("proibido: completada COM ameaças", () => {
    assert.equal(showNoThreatsReassurance("completed", stateWith({ threatsFound: 1 })), false);
    assert.equal(showNoThreatsReassurance("completed", stateWith({ threatsFound: 9 })), false);
  });

  test("proibido: sem dados suficientes (estado nulo)", () => {
    assert.equal(showNoThreatsReassurance("completed", null), false);
  });

  test("permitido apenas: concluída, com estado e zero ameaças", () => {
    assert.equal(showNoThreatsReassurance("completed", stateWith({ threatsFound: 0 })), true);
  });

  test("proibido: análise concluída com ficheiro inconclusivo não tranquiliza", () => {
    assert.equal(
      showNoThreatsReassurance(
        "completed",
        stateWith({ threatsFound: 0, filesAnalyzed: 1, filesFailed: 0, filesInconclusive: 1 }),
      ),
      false,
    );
  });

  test("inconclusivos são preservados na normalização do estado de scan", () => {
    const state = normalizeScanState(scanState({ filesInconclusive: 2 }));
    assert.equal(state?.filesInconclusive, 2);
  });

  test("resultado concluído com ficheiro inconclusivo usa estado parcial, não verde", () => {
    assert.deepEqual(
      terminalResultLabels("completed", stateWith({
        threatsFound: 0,
        filesAnalyzed: 2,
        filesFailed: 0,
        filesInconclusive: 1,
      })),
      {
        titulo: "Análise concluída com verificações inconclusivas",
        chip: "Parcial",
        tom: "yellow",
      },
    );
  });

  test("resumo quick identifica ficheiros inconclusivos", () => {
    const summary = conciseResultSummary({
      scope: "computer",
      type: "quick",
      status: "completed",
      filesConsidered: 2,
      filesAnalyzed: 2,
      filesExcluded: 0,
      filesFailed: 0,
      filesInconclusive: 1,
      threatsFound: 0,
    });

    test("resumo geral identifica ficheiros inconclusivos sem os contar como limpos", () => {
      const summary = buildResultSummary({
        scope: "folder",
        type: "custom",
        status: "completed",
        filesConsidered: 3,
        filesAnalyzed: 3,
        filesFailed: 0,
        filesExcluded: 0,
        filesInconclusive: 1,
        threatsFound: 0,
      });
      assert.match(summary, /não foram encontradas ameaças/);
      assert.match(summary, /1 ficheiro teve um resultado inconclusivo/);
    });
    assert.match(summary, /Não foram detetadas ameaças no ficheiro com resultado conclusivo/);
    assert.match(summary, /1 ficheiro.*inconclusiv/);
  });

  test("resultado desconhecido ou sem ficheiros analisados não tranquiliza", () => {
    assert.equal(
      showNoThreatsReassurance("completed", stateWith({ filesInconclusive: undefined })),
      false,
    );
    assert.equal(
      showNoThreatsReassurance("completed", stateWith({ filesAnalyzed: 0 })),
      false,
    );
    assert.equal(
      showNoThreatsReassurance("completed", stateWith({ filesFailed: 1 })),
      false,
    );
  });
});

// P0 UX (15/10, apos recuo 97%->17% na C3): a barra principal e UMA, monotonica
// e so do eixo global (ficheiros com ciclo fechado). A percentagem da ETAPA de
// assinaturas NUNCA vai para a barra — vive em texto (activeScanDetail). Sem
// trabalho global fechado: indeterminada honesta, nunca % que possa recuar.
describe("scanPrimaryBar — fonte da percentagem da barra", () => {
  test("pipeline com trabalho fechado ganha sempre", () => {
    const st = scanState({ status: "running", phase: "scanning", filesTotal: 1000, filesScanned: 400, filesInEngineBatch: 900, filesAnalyzed: 900 });
    const bar = scanPrimaryBar(st);
    assert.deepEqual(bar, { percent: 40, source: "pipeline" });
  });

  test("batch ativo sem pipeline fechado: barra INDETERMINADA, nunca % de etapa", () => {
    const st = scanState({ status: "running", phase: "scanning", filesTotal: 16421, filesScanned: 0, filesInEngineBatch: 16409, filesAnalyzed: 2646 });
    const bar = scanPrimaryBar(st);
    assert.deepEqual(bar, { percent: null, source: "nenhum" });
  });

  test("total conhecido sem trabalho fechado: indeterminado (o 0 cru deixava a barra presa)", () => {
    const bar = scanPrimaryBar(scanState({ status: "running", phase: "scanning", filesTotal: 500, filesScanned: 0 }));
    assert.deepEqual(bar, { percent: null, source: "nenhum" });
  });

  test("sem total nem etapa: null + fonte nenhuma (barra indeterminada)", () => {
    const bar = scanPrimaryBar(scanState({ status: "running", phase: "scanning", filesTotal: undefined, filesScanned: 0 }));
    assert.equal(bar.percent, null);
    assert.equal(bar.source, "nenhum");
  });

  test("terminal: percentagem do pipeline, nao da etapa", () => {
    const st = scanState({ status: "completed", phase: "finalizing", progress: 100, filesTotal: 100, filesScanned: 100, filesInEngineBatch: 0, filesAnalyzed: 100 });
    const bar = scanPrimaryBar(st);
    assert.equal(bar.source, "pipeline");
    assert.equal(bar.percent, 100);
  });

  test("monotoncia entre fases: 97% etapa -> 17% pipeline NAO recua a barra (etapa nunca alimenta a barra)", () => {
    const etapa = scanPrimaryBar(scanState({ status: "running", phase: "scanning", filesTotal: 16421, filesScanned: 0, filesInEngineBatch: 15917, filesAnalyzed: 15917 }));
    const global = scanPrimaryBar(scanState({ status: "running", phase: "scanning", filesTotal: 16421, filesScanned: 2792, filesInEngineBatch: 0, filesAnalyzed: 16409 }));
    assert.equal(etapa.percent, null);
    assert.equal(global.percent, 17);
    assert.ok(global.percent >= 0 && (etapa.percent ?? 0) <= 100);
    // regra: transicao etapa->global e null->17 (nunca 97->17).
  });
});

describe("activeScanDetail — fase de assinaturas com contagem real", () => {
  test("com verificados: diz 'Fase de assinaturas: done de total'", () => {
    const d = activeScanDetail("folder", "custom", "scanning", "H:", 16409, 2646);
    assert.match(d, /Fase de assinaturas: 2646 de 16409 verificados pelo motor/);
  });
  test("sem verificados: comportamento antigo preservado", () => {
    const d = activeScanDetail("folder", "custom", "scanning", "H:", 16409, 0);
    assert.match(d, /16409 ficheiros de uma só vez/);
  });
});