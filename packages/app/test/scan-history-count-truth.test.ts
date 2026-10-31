import { test } from "node:test";
import assert from "node:assert/strict";
import * as report from "../src/lib/scanHistoryReport";
import { htmlDoRelatorio } from "../src/components/ScanHistoryPanel";
import type { ScanHistoryEntry } from "@cybersafe/shared-types";

const base: ScanHistoryEntry = {
  id: "fixture", type: "quick", target: "default", status: "completed",
  startedAt: "2026-10-30T12:00:00Z", endedAt: "2026-10-30T12:01:00Z",
  durationMs: 60000, filesConsidered: 18, filesAnalyzed: 12,
  filesExcluded: 4, filesFailed: 2, threatsFound: 0,
};

test("PDF HTML keeps legacy counts unknown, while confirmed zero is numeric", () => {
  assert.match(htmlDoRelatorio(base, null), /<b>Conclusivos<\/b>: sem leitura/);
  assert.match(htmlDoRelatorio({ ...base, filesInconclusive: 0 }, null), /<b>Conclusivos<\/b>: 12/);
});
test("PDF HTML preserves measured partial reasons and excludes paths", () => {
  const html = htmlDoRelatorio({ ...base, filesInconclusive: 3,
    inconclusiveByReason: [{ reason: "engine-failed", count: 3 }],
  }, null);
  assert.match(html, /<b>Conclusivos<\/b>: 9/);
  assert.match(html, /Motivos dos inconclusivos/);
  assert.match(html, /<b>Excluídos<\/b>: 4/);
  assert.match(htmlDoRelatorio({ ...base, status: "cancelled", filesInconclusive: 0 }, null), /<b>Conclusivos<\/b>: sem leitura/);
});

// Removing either input validation or the legacy unknown branch must fail these cases.
const count = (entry: Record<string, unknown>): unknown => {
  const fn = (report as unknown as Record<string, unknown>).conclusiveHistoryCount;
  assert.equal(typeof fn, "function", "history needs an evidence-based conclusive count");
  return (fn as (value: Record<string, unknown>) => unknown)(entry);
};

test("legacy: missing inconclusive count is unknown, not zero", () => {
  assert.equal(count({ status: "completed", filesAnalyzed: 12 }), null);
});
test("confirmed zero preserves the measured conclusive count", () => {
  assert.equal(count({ status: "completed", filesAnalyzed: 12, filesInconclusive: 0 }), 12);
});
test("partial: subtract measured inconclusives only", () => {
  assert.equal(count({ status: "completed", filesAnalyzed: 12, filesInconclusive: 3 }), 9);
});
test("excluded and failed files are not subtracted twice from accepted results", () => {
  assert.equal(count({ status: "completed", filesAnalyzed: 12, filesInconclusive: 3, filesExcluded: 4, filesFailed: 2 }), 9);
});
test("cancelled legacy coverage cannot claim conclusive pipeline results", () => {
  assert.equal(count({ status: "cancelled", filesAnalyzed: 2003, filesInconclusive: 0 }), null);
});
test("inconsistent and invalid counters are unknown rather than clamped", () => {
  for (const [filesAnalyzed, filesInconclusive] of [[2, 3], [-1, 0], [3, -1], [NaN, 0], [3, 0.5]]) {
    assert.equal(count({ status: "completed", filesAnalyzed, filesInconclusive }), null);
  }
});
