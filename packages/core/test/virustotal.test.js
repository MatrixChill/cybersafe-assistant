import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { VirusTotalClient } from "../dist/virustotal.js";

function harness(t, statuses, options = {}) {
  let now = 1_000_000_000;
  const calls = [];
  const waits = [];
  const warnings = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (resolve, delay) => {
    waits.push(delay);
    now += delay;
    resolve();
  });
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    const status = statuses.shift();
    if (status instanceof Error) throw status;
    assert.notEqual(status, undefined, "unexpected network request");
    return {
      status,
      ok: status === 200,
      json: async () => ({ data: { attributes: {
        last_analysis_results: {
          Example: { category: "malicious", result: "Test.Detection" },
          Clean: { category: "undetected", result: null },
        },
        reputation: -5,
        last_analysis_date: 1_700_000_000,
      } } }),
    };
  });
  return {
    client: new VirusTotalClient("test-key", { rateLimitMs: 0, ...options }),
    calls, waits, warnings,
    advance: (ms) => { now += ms; },
  };
}

test("without an API key, lookup returns null without network or throttle", async (t) => {
  const h = harness(t, []);
  const client = new VirusTotalClient();
  assert.equal(client.isEnabled(), false);
  assert.equal(await client.scanHash("a"), null);
  assert.equal(h.calls.length, 0);
  assert.equal(h.waits.length, 0);
});

test("three 429s open the breaker before throttle and fetch on subsequent calls", async (t) => {
  const h = harness(t, [429, 429, 429, 429], { rateLimitMs: 60_000 });
  for (const hash of ["a", "b", "c"]) assert.equal(await h.client.scanHash(hash), null);
  assert.equal(h.waits.length, 2);
  const waitsBefore = h.waits.length;
  const started = performance.now();
  assert.equal(await h.client.scanHash("d"), null);
  assert.ok(performance.now() - started < 1000, "open breaker must return immediately");
  assert.equal(h.calls.length, 3);
  assert.equal(h.waits.length, waitsBefore, "open breaker must not schedule a throttle timer");
});

for (const success of [200, 404]) {
  test(`${success} resets consecutive failures before the next three failures`, async (t) => {
    const h = harness(t, [429, 429, success, 429, 429, 429, 200]);
    for (const hash of ["a", "b"]) await h.client.scanHash(hash);
    const result = await h.client.scanHash("c");
    assert.equal(result.positives, success === 200 ? 1 : 0);
    assert.equal(result.total, success === 200 ? 2 : 0);
    for (const hash of ["d", "e", "f", "g"]) await h.client.scanHash(hash);
    assert.equal(h.calls.length, 6, "only the third failure after success opens the breaker");
  });
}

test("an open breaker still serves normalized cache hits without losing detections", async (t) => {
  const h = harness(t, [200, 429, 429, 429]);
  const result = await h.client.scanHash("ABC");
  for (const hash of ["d", "e", "f"]) await h.client.scanHash(hash);
  assert.deepEqual(await h.client.scanHash("abc"), { ...result, cached: true });
  assert.equal(result.detectionRatio, "1/2");
  assert.deepEqual(result.engines, [{ name: "Example", detected: true, result: "Test.Detection" }]);
  assert.equal(h.client.getCacheSize(), 1);
  assert.equal(h.calls.length, 4);
});

test("expired cache entries are not served while the breaker is open", async (t) => {
  const h = harness(t, [404, 429, 429, 429], { cooldownMs: 7_200_000 });
  await h.client.scanHash("cached");
  for (const hash of ["a", "b", "c"]) await h.client.scanHash(hash);
  h.advance(3_600_000);
  assert.equal(await h.client.scanHash("cached"), null);
  assert.equal(h.calls.length, 4);
});

test("cooldown expiry starts a fresh failure window and logs once per opening", async (t) => {
  const h = harness(t, Array(9).fill(429), { cooldownMs: 10 });
  for (let i = 0; i < 5; i++) await h.client.scanHash(`first-${i}`);
  assert.equal(h.calls.length, 3);
  assert.equal(h.warnings.filter((line) => /circuit breaker.*open/i.test(line)).length, 1);
  const warningCount = h.warnings.length;
  h.advance(9);
  await h.client.scanHash("still-open");
  assert.equal(h.warnings.length, warningCount);
  assert.equal(h.calls.length, 3);
  h.advance(1);
  for (let i = 0; i < 5; i++) await h.client.scanHash(`second-${i}`);
  assert.equal(h.calls.length, 6);
  const openings = h.warnings.filter((line) => /circuit breaker.*open/i.test(line));
  assert.equal(openings.length, 2);
  assert.ok(openings.every((line) => line.includes("429")), "opening log includes the reason");
});

for (const failure of [503, new Error("network unavailable")]) {
  test(`${failure} counts towards the failure threshold`, async (t) => {
    const h = harness(t, [failure, failure, failure, 200]);
    for (const hash of ["a", "b", "c", "d"]) assert.equal(await h.client.scanHash(hash), null);
    assert.equal(h.calls.length, 3);
  });
}

test("constructor overrides support a different failure threshold", async (t) => {
  const h = harness(t, [429, 200], { failureThreshold: 1 });
  await h.client.scanHash("a");
  assert.equal(await h.client.scanHash("b"), null);
  assert.equal(h.calls.length, 1);
});

test("production defaults retain the throttle and reopen only after five minutes", async (t) => {
  const h = harness(t, [429, 429, 429, 404]);
  const client = new VirusTotalClient("test-key");
  for (const hash of ["a", "b", "c"]) await client.scanHash(hash);
  assert.deepEqual(h.waits, [15_500, 15_500]);
  h.advance(299_999);
  assert.equal(await client.scanHash("d"), null);
  assert.equal(h.calls.length, 3);
  h.advance(1);
  assert.equal((await client.scanHash("d")).detectionRatio, "0/0");
  assert.equal(h.calls.length, 4);
});

test("a lookup already waiting for throttle skips fetch if another lookup opens the breaker", async (t) => {
  const h = harness(t, [429, 429], { rateLimitMs: 1000 });
  await h.client.scanHash("a");
  await h.client.scanHash("b");
  h.advance(1000);
  let finishRequest;
  let releaseThrottle;
  let requests = 0;
  t.mock.method(globalThis, "fetch", () => {
    requests++;
    return new Promise((resolve) => { finishRequest = resolve; });
  });
  t.mock.method(globalThis, "setTimeout", (resolve) => { releaseThrottle = resolve; });
  const third = h.client.scanHash("c");
  const waiting = h.client.scanHash("d");
  finishRequest({ status: 429, ok: false });
  assert.equal(await third, null);
  releaseThrottle();
  assert.equal(await waiting, null);
  assert.equal(requests, 1);
  assert.equal(h.warnings.filter((line) => /circuit breaker.*open/i.test(line)).length, 1);
});

// ─── VT_CALL diagnostic log (DIAG VT) ─────────────────────────────────────
// Apenas instrumentacao: scanHash ganhou um 2.o parametro OPCIONAL sourceTag
// e emite uma unica linha de log gated por CYBERSAFE_DEBUG_VT=1. Nada mais
// muda (throttle, breaker, cache, return values intocados).
test("VT_CALL: sem CYBERSAFE_DEBUG_VT=1, scanHash nao emite nada", async (t) => {
  const h = harness(t, [200], { rateLimitMs: 0 });
  const calls = [];
  t.mock.method(console, "log", (...args) => calls.push(args.join(" ")));
  await h.client.scanHash("abcdef0123456789");
  assert.equal(calls.filter((l) => l.startsWith("[VT_CALL]")).length, 0);
});

test("VT_CALL: com CYBERSAFE_DEBUG_VT=1 emite a linha com o sourceTag passado", async (t) => {
  const h = harness(t, [200], { rateLimitMs: 0 });
  const calls = [];
  t.mock.method(console, "log", (...args) => calls.push(args.join(" ")));
  const prev = process.env.CYBERSAFE_DEBUG_VT;
  process.env.CYBERSAFE_DEBUG_VT = "1";
  try {
    await h.client.scanHash("abcdef0123456789", "scanArtifact:system-scanner");
  } finally {
    if (prev === undefined) delete process.env.CYBERSAFE_DEBUG_VT;
    else process.env.CYBERSAFE_DEBUG_VT = prev;
  }
  const vtCalls = calls.filter((l) => l.startsWith("[VT_CALL]"));
  assert.equal(vtCalls.length, 1);
  assert.ok(vtCalls[0].includes("source=scanArtifact:system-scanner"));
  assert.ok(vtCalls[0].includes("sha8=abcdef01"));
});

test("VT_CALL: sourceTag padrao e unknown quando nao passado", async (t) => {
  const h = harness(t, [200], { rateLimitMs: 0 });
  const calls = [];
  t.mock.method(console, "log", (...args) => calls.push(args.join(" ")));
  const prev = process.env.CYBERSAFE_DEBUG_VT;
  process.env.CYBERSAFE_DEBUG_VT = "1";
  try {
    await h.client.scanHash("abcdef0123456789");
  } finally {
    if (prev === undefined) delete process.env.CYBERSAFE_DEBUG_VT;
    else process.env.CYBERSAFE_DEBUG_VT = prev;
  }
  const vtCalls = calls.filter((l) => l.startsWith("[VT_CALL]"));
  assert.equal(vtCalls.length, 1);
  assert.ok(vtCalls[0].includes("source=unknown"));
});
