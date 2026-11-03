import test from "node:test";
import assert from "node:assert/strict";
import { activityEventsForDisplay } from "../src/lib/securityEventPresentation";
import type { SecurityEvent } from "@cybersafe/shared-types";

const event = (id: string, sequence: number, type: SecurityEvent["type"], extra: Partial<SecurityEvent> = {}) =>
  ({ id, sequence, type, summary: id, severity: "low", timestamp: "2026-11-01T10:00:00Z", data: {}, ...extra } as SecurityEvent);

test("Painel colapsa progresso do mesmo scan e preserva o evento mais recente", () => {
  const events = [
    event("p-old", 1, "scan.progress", { scanId: "scan-a" }),
    event("other", 2, "artifact.analyzed"),
    event("p-mid", 3, "scan.progress", { scanId: "scan-a" }),
    event("p-other-scan", 4, "scan.progress", { scanId: "scan-b" }),
    event("p-latest", 5, "scan.progress", { scanId: "scan-a" }),
  ];
  const visible = activityEventsForDisplay(events, 3);
  assert.deepEqual(visible.map((e) => e.id), ["p-latest", "p-other-scan", "other"]);
});

test("eventos sem scanId nao sao colapsados por engano", () => {
  const events = [event("a", 1, "scan.progress", { scanId: undefined }), event("b", 2, "scan.progress", { scanId: undefined })];
  assert.deepEqual(activityEventsForDisplay(events).map((e) => e.id), ["b", "a"]);
});
