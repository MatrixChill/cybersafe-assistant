import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeScanState,
  mergeScanState,
  mergeFailedByReason,
  failureReasonsLabel,
  filesFailedFooterLabel,
  type FsErrorCategory,
} from "../src/lib/scanSession";

describe("scanSession — failedByReason extraction", () => {
  test("extrai failedByReason do payload do motor", () => {
    const raw = {
      id: "scan-1",
      status: "completed",
      progress: 100,
      filesScanned: 800,
      filesAnalyzed: 663,
      filesExcluded: 130,
      filesFailed: 7,
      failedByReason: {
        permissions_denied: 3,
        not_found: 2,
        locked_or_busy: 2,
      },
    };
    const result = normalizeScanState(raw);
    assert.ok(result);
    assert.deepEqual(result.failedByReason, {
      permissions_denied: 3,
      not_found: 2,
      locked_or_busy: 2,
    });
  });

  test("devolve undefined quando failedByReason não está presente", () => {
    const raw = { id: "scan-2", status: "completed", progress: 100, filesScanned: 10 };
    const result = normalizeScanState(raw);
    assert.equal(result?.failedByReason, undefined);
  });

  test("filtra categorias inválidas e contagens não positivas", () => {
    const raw = {
      id: "scan-3",
      status: "completed",
      progress: 100,
      filesScanned: 10,
      failedByReason: {
        permissions_denied: 5,
        categoria_invalida: 3,
        not_found: 0,
        other: -2,
        path_too_long: 4,
      },
    };
    const result = normalizeScanState(raw);
    assert.deepEqual(result?.failedByReason, {
      permissions_denied: 5,
      path_too_long: 4,
    });
  });

  test("devolve null para raw inválido", () => {
    assert.equal(normalizeScanState(null), null);
    assert.equal(normalizeScanState(undefined), null);
    assert.equal(normalizeScanState("string"), null);
    assert.equal(normalizeScanState({}), null);
  });
});

describe("scanSession — mergeFailedByReason", () => {
  test("junta dois registos de razão sem perder contagens", () => {
    const current: Record<FsErrorCategory, number> = { permissions_denied: 3, not_found: 2 };
    const next: Record<FsErrorCategory, number> = { permissions_denied: 1, locked_or_busy: 2 };
    const result = mergeFailedByReason(current, next);
    assert.deepEqual(result, {
      permissions_denied: 4,
      not_found: 2,
      locked_or_busy: 2,
    });
  });

  test("devolve current quando next é undefined", () => {
    const current: Record<FsErrorCategory, number> = { permissions_denied: 3 };
    const result = mergeFailedByReason(current, undefined);
    assert.deepEqual(result, current);
  });

  test("devolve next quando current é undefined", () => {
    const next: Record<FsErrorCategory, number> = { not_found: 2 };
    const result = mergeFailedByReason(undefined, next);
    assert.deepEqual(result, next);
  });

  test("devolve undefined quando ambos são undefined", () => {
    assert.equal(mergeFailedByReason(undefined, undefined), undefined);
  });
});

describe("scanSession — mergeScanState preserva failedByReason", () => {
  test("mantém failedByReason durante o merge", () => {
    const current = { id: "scan-1", status: "running" as const, progress: 50, filesScanned: 400, failedByReason: { permissions_denied: 2 } };
    const next = { id: "scan-1", status: "running" as const, progress: 80, filesScanned: 700, failedByReason: { not_found: 1 } };
    const merged = mergeScanState(current, next);
    assert.deepEqual(merged.failedByReason, { permissions_denied: 2, not_found: 1 });
  });

  test("não resgata failedByReason quando next não o tem", () => {
    const current = { id: "scan-1", status: "running" as const, progress: 80, filesScanned: 700, failedByReason: { permissions_denied: 3 } };
    const next = { id: "scan-1", status: "running" as const, progress: 90, filesScanned: 750 };
    const merged = mergeScanState(current, next);
    assert.deepEqual(merged.failedByReason, { permissions_denied: 3 });
  });
});

describe("scanSession — failureReasonsLabel", () => {
  test("produz label legível com múltiplas razões", () => {
    const label = failureReasonsLabel({ permissions_denied: 3, not_found: 2 });
    assert.ok(label);
    assert.ok(label.includes("3 ficheiros (permissões)"));
    assert.ok(label.includes("2 ficheiros (não encontrado)"));
  });

  test("usa singular para contagem 1", () => {
    const label = failureReasonsLabel({ locked_or_busy: 1 });
    assert.equal(label, "1 ficheiro (bloqueado ou ocupado)");
  });

  test("devolve null quando não há dados", () => {
    assert.equal(failureReasonsLabel(undefined), null);
    assert.equal(failureReasonsLabel({}), null);
  });
});

describe("scanSession — filesFailedFooterLabel", () => {
  test("usa singular para 1 ficheiro", () => {
    assert.equal(filesFailedFooterLabel(1), "1 ficheiro não pôde ser analisado");
  });

  test("usa plural para múltiplos", () => {
    assert.equal(filesFailedFooterLabel(7), "7 ficheiros não puderam ser analisados");
  });
});
