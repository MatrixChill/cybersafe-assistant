import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  NO_DETECTIONS_NOTE,
  SCAN_ACTION_CARDS,
  SCAN_HYDRATING_DETAIL,
  SCAN_HYDRATING_TITLE,
  SCAN_RESULT_LABELS,
  activeScanDetail,
  activeScanTitle,
  buildResultSummary,
  decideScanEvent,
  formatEta,
  isActiveUiStatus,
  isTerminalScanStatus,
  isTerminalUiStatus,
  mergeScanState,
  normalizeScanState,
  normalizeScanType,
  scanEtaSeconds,
  scanProgressPercent,
  scanScopeFor,
  scopeFromIntent,
  scopeTitle,
  shouldAcceptScanState,
  shouldShowHydration,
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
    const summary = buildResultSummary({ scope: "computer", type: "quick", status: "completed", filesScanned: 800, threatsFound: 0 });
    assert.equal(
      summary,
      "A análise rápida do computador foi concluída. Foram verificados 800 ficheiros em áreas prioritárias do sistema e não foram encontradas ameaças.",
    );
  });

  test("análise rápida com ameaças", () => {
    const summary = buildResultSummary({ scope: "computer", type: "quick", status: "completed", filesScanned: 143, threatsFound: 3 });
    assert.match(summary, /Foram verificados 143 ficheiros/);
    assert.match(summary, /foram encontradas 3 ameaças/);
  });

  test("análise profunda descreve o scope real", () => {
    const summary = buildResultSummary({ scope: "computer", type: "full", status: "completed", filesScanned: 12000, threatsFound: 0 });
    assert.match(summary, /A análise profunda do computador foi concluída/);
    assert.match(summary, /pastas do seu utilizador e nos arranques automáticos/);
  });

  test("ficheiro único", () => {
    const clean = buildResultSummary({ scope: "file", type: "custom", status: "completed", filesScanned: 1, threatsFound: 0, targetName: "invoice.pdf" });
    assert.equal(clean, "A análise do ficheiro «invoice.pdf» foi concluída: 1 ficheiro verificado e não foram encontradas ameaças.");
    const dirty = buildResultSummary({ scope: "file", type: "custom", status: "completed", filesScanned: 1, threatsFound: 1, targetName: "evil.exe" });
    assert.match(dirty, /foi encontrada 1 ameaça/);
  });

  test("pasta", () => {
    const summary = buildResultSummary({ scope: "folder", type: "custom", status: "completed", filesScanned: 42, threatsFound: 0, targetName: "Downloads" });
    assert.match(summary, /A análise da pasta «Downloads» foi concluída/);
    assert.match(summary, /42 ficheiros verificados dentro da pasta/);
  });

  test("sem ficheiros, cancelada e falhada", () => {
    assert.match(
      buildResultSummary({ scope: "folder", type: "custom", status: "completed", filesScanned: 0, threatsFound: 0, targetName: "Vazia" }),
      /Não foram encontrados ficheiros/,
    );
    assert.match(
      buildResultSummary({ scope: "file", type: "custom", status: "completed", filesScanned: 0, threatsFound: 0 }),
      /não pôde ser verificado/,
    );
    assert.match(
      buildResultSummary({ scope: "computer", type: "quick", status: "cancelled", filesScanned: 120, threatsFound: 0 }),
      /cancelada depois de verificar 120 ficheiros/,
    );
    assert.match(
      buildResultSummary({ scope: "computer", type: "quick", status: "failed", filesScanned: 0, threatsFound: 0, error: "sem ligação" }),
      /Não foi possível concluir a análise: sem ligação/,
    );
  });

  test("erros de leitura são mencionados no resumo", () => {
    const summary = buildResultSummary({ scope: "computer", type: "quick", status: "completed", filesScanned: 10, threatsFound: 0, filesFailed: 2 });
    assert.match(summary, /2 ficheiros não puderam ser analisado\(s\)/);
  });
});

describe("truthfulness do resultado (nenhuma deteção ≠ garantia absoluta)", () => {
  const FORBIDDEN = [/100% seguro/i, /comprovadamente/i, /ficheiros seguros/i, /nada de suspeito/i];

  test("o cartão deixou de dizer \"Ficheiros Seguros\"", () => {
    assert.equal(SCAN_RESULT_LABELS.noThreatsDetected, "Sem ameaças detetadas");
    assert.equal(/seguro/i.test(SCAN_RESULT_LABELS.noThreatsDetected), false);
    assert.equal(SCAN_RESULT_LABELS.filesChecked, "Ficheiros Verificados");
    assert.equal(SCAN_RESULT_LABELS.threatsFound, "Ameaças Encontradas");
  });

  test("o aviso explica que não há garantia absoluta", () => {
    assert.match(NO_DETECTIONS_NOTE, /não garante/i);
  });

  test("nenhuma frase do resultado promete segurança absoluta", () => {
    const scenarios = [
      { scope: "computer" as const, type: "quick" as const, filesScanned: 800, threatsFound: 0 },
      { scope: "computer" as const, type: "full" as const, filesScanned: 12000, threatsFound: 0 },
      { scope: "file" as const, type: "custom" as const, filesScanned: 1, threatsFound: 0, targetName: "nota.txt" },
      { scope: "folder" as const, type: "custom" as const, filesScanned: 42, threatsFound: 0, targetName: "Docs" },
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
    const summary = buildResultSummary({ scope: "computer", type: "full", status: "completed", filesScanned: 500, threatsFound: 0 });
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
 * Hidratação ao montar a página. O bug manual: ao voltar à secção a meio de uma
 * análise existia um flash do estado idle ("O que pretende analisar?") antes de
 * o snapshot de `scan.getActive` chegar. Estes testes fixam a regra: enquanto a
 * ressincronização está pendente, o ecrã de hidratação substitui o idle.
 */
describe("scanner hydration gate", () => {
  test("mostra hidratação (e não idle) enquanto o snapshot está pendente", () => {
    assert.equal(shouldShowHydration(true, "idle"), true);
  });

  test("depois do snapshot sem scan ativo, deixa de hidratar (mostra idle)", () => {
    assert.equal(shouldShowHydration(false, "idle"), false);
  });

  test("nunca esconde uma análise ativa atrás da hidratação", () => {
    for (const status of ["preparing", "gathering", "scanning", "finalizing"] as const) {
      assert.equal(shouldShowHydration(true, status), false, status);
    }
  });

  test("nunca substitui um resultado terminal", () => {
    for (const status of ["completed", "cancelled", "failed"] as const) {
      assert.equal(shouldShowHydration(true, status), false, status);
    }
  });

  test("a cópia de hidratação é explícita e não promete resultados", () => {
    assert.match(SCAN_HYDRATING_TITLE, /recuperar/i);
    assert.ok(SCAN_HYDRATING_DETAIL.length > 0);
  });
});
