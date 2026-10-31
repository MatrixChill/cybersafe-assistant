import { test } from "node:test";
import assert from "node:assert/strict";
import {
  engineCards,
  dashboardVerdict,
  isHistoryEntry,
} from "../src/v2/dashboard/model";
test("no connection never invents four healthy engines", () => {
  const cards = engineCards(undefined, false);
  assert.equal(cards.length, 4);
  assert.ok(cards.every((c) => c.state === "UNAVAILABLE"));
});
test("active with limited corpus remains degraded, never full coverage", () => {
  const cards = engineCards(
    {
      yara: { status: "active", coverage: "limited" },
      clamav: { status: "error" },
      hashDb: { status: "degraded" },
      nativeEngine: { status: "unavailable" },
    } as never,
    true,
  );
  assert.equal(cards[0].state, "DEGRADED");
  assert.equal(cards[1].state, "DEGRADED");
  assert.equal(cards[2].state, "ERROR");
  assert.equal(cards[3].state, "UNAVAILABLE");
});
test("unknown status is not healthy", () => {
  assert.equal(
    engineCards({ yara: { status: "unexpected" } } as never, true)[0].state,
    "UNAVAILABLE",
  );
});
test("monitoring off and disconnected cannot be protected", () => {
  assert.notEqual(
    dashboardVerdict(
      { systemStatus: "safe" } as never,
      { enabled: false },
      true,
    ).tone,
    "ok",
  );
  assert.equal(
    dashboardVerdict(
      { systemStatus: "safe" } as never,
      { enabled: true },
      false,
    ).tone,
    "na",
  );
});
test("malformed history is not presented as a successful scan or zero files", () => {
  assert.equal(isHistoryEntry({}), false);
  assert.equal(
    isHistoryEntry({ status: "completed", filesAnalyzed: 0 }),
    false,
  );
  assert.equal(
    isHistoryEntry({
      id: "a",
      type: "custom",
      status: "completed",
      endedAt: "2026-10-28T00:00:00Z",
      filesAnalyzed: 0,
    }),
    true,
  );
  assert.equal(
    isHistoryEntry({
      id: "a",
      type: "custom",
      status: "completed",
      endedAt: "invalid",
      filesAnalyzed: 0,
    }),
    false,
  );
  assert.equal(
    isHistoryEntry({
      id: "a",
      type: "custom",
      status: "completed",
      endedAt: "2026-10-28T00:00:00Z",
      filesAnalyzed: NaN,
    }),
    false,
  );
});
test("an engine error remains critical even when monitoring is off",()=>{
 const result=dashboardVerdict({systemStatus:'critical',engineHealth:{serviceRunning:true,yara:{status:'error'}}} as never,{enabled:false},true);
 assert.equal(result.tone,'crit');
});
