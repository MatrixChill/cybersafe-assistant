import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { decidePaginaHistorico } from "../src/components/ScanHistoryPanel";
import { isHistoryEntry } from "../src/v2/dashboard/model";
import * as progressiveRead from "../src/lib/progressiveRead";

// Same hook boundary used by service-connection-app.test.ts. The component,
// effect and response validators are real; only IPC and React scheduling vary.
function harness(source = readFileSync(new URL("../src/pages/DashboardPage.tsx", import.meta.url), "utf8")) {
  let history: unknown;
  let cleanup: (() => void) | undefined;
  let listener: ((scan: { id?: string; status: string }) => void) | undefined;
  let shutdown = false;
  const requests: { resolve: (page: unknown) => void; reject: (error: Error) => void }[] = [];
  const api = {
    getScanHistory: (options: unknown) => {
      assert.equal(JSON.stringify(options), '{"limit":1}');
      return new Promise((resolve, reject) => requests.push({ resolve, reject }));
    },
    onScanProgress: (fn: typeof listener) => { listener = fn; return () => { listener = undefined; }; },
  };
  const modules: Record<string, unknown> = {
    react: {
      useState: (initial: unknown) => [initial, (next: unknown) => { history = next; }],
      useEffect: (effect: () => (() => void) | undefined) => { cleanup = effect(); },
      useRef: (value: unknown) => ({ current: value }),
      useMemo: (fn: () => unknown) => fn(),
    },
    "react/jsx-runtime": { jsx: () => null },
    "@/v2/dashboard/LabDashboard": { default: () => null },
    "@/components/ScanHistoryPanel": { decidePaginaHistorico },
    "@/lib/shutdownState": { isAppShuttingDown: () => shutdown },
    "@/v2/dashboard/model": { isHistoryEntry },
    "@/lib/progressiveRead": progressiveRead,
  };
  const exports: { default?: (props: { serviceConnected: boolean }) => void } = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, {
    exports, window: { electronAPI: api },
    require: (name: string) => {
      assert.ok(name in modules, `Unexpected dependency: ${name}`);
      return modules[name];
    },
  });
  exports.default!({ serviceConnected: true });
  return {
    requests,
    history: () => history as { phase: string; entry: unknown },
    event: (status: string, id = "fixture") => listener?.({ id, status }),
    dispose: () => cleanup?.(),
    subscribed: () => Boolean(listener),
    shutdown: () => { shutdown = true; },
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const empty = { entries: [], total: 0, offset: 0, limit: 1 };

test("terminal events refresh the mounted Dashboard; ordinary progress never reads history", async () => {
  const h = harness();
  h.requests[0].resolve(empty); await settle();
  assert.equal(h.history().phase, "pronto");
  for (let i = 0; i < 100; i++) h.event("running");
  assert.equal(h.requests.length, 1);
  for (const status of ["completed", "cancelled", "failed"]) {
    h.event(status);
    const request = h.requests.at(-1)!;
    request.resolve(empty); await settle();
  }
  assert.equal(h.requests.length, 4);
  h.dispose();
});

test("terminal bursts during a pending read coalesce and discard its stale result", async () => {
  const h = harness();
  for (let i = 0; i < 100; i++) h.event("completed");
  assert.equal(h.requests.length, 1, "only one IPC read in flight");
  h.requests[0].resolve(empty); await settle();
  assert.equal(h.requests.length, 2, "one fresh read after the burst");
  assert.equal(h.history().phase, "a_consultar", "stale response is not published");
  h.requests[1].resolve(empty); await settle();
  assert.equal(h.history().phase, "pronto");
  h.dispose();
});

test("unmount unsubscribes and prevents publication or a pending follow-up", async () => {
  const h = harness();
  h.event("completed"); h.dispose();
  assert.equal(h.subscribed(), false);
  h.requests[0].resolve(empty); await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.history().phase, "a_consultar");
});

test("unconfirmed and failed reads are not presented as empty history", async () => {
  const h = harness();
  h.requests[0].resolve(null); await settle();
  assert.equal(h.history().phase, "sem_confirmacao");
  h.event("completed"); h.requests[1].reject(new Error("pipe closed")); await settle();
  assert.equal(h.history().phase, "erro");
  h.event("completed"); h.requests[2].resolve(empty); await settle();
  assert.equal(h.history().phase, "pronto", "a failure does not poison the next read");
  h.dispose();
});

test("shutdown prevents new requests and late publication", async () => {
  const h = harness();
  h.shutdown(); h.event("completed");
  h.requests[0].resolve(empty); await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.history().phase, "a_consultar");
  h.dispose();
});
