import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { validateSavedSession } from "../src/lib/authSessionValidation";
import { authTokenExpiresAt } from "../src/lib/authSession";

async function withServer(handler: http.RequestListener, run: (base: string) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
test("transient startup failure retries only /auth/me and returns its actual response", async () => {
  let requests = 0;
  await withServer((req, res) => { assert.equal(req.url, "/auth/me"); assert.equal(req.method, "GET"); res.writeHead(++requests < 3 ? 503 : 200); res.end("{}"); }, async base => {
    assert.equal((await validateSavedSession(base, "public-fixture", undefined, 2000, 10)).status, 200);
    assert.equal(requests, 3);
  });
});
test("invalid or revoked bearer is not retried", async () => {
  let requests = 0;
  await withServer((_req, res) => { requests++; res.writeHead(401); res.end(); }, async base => {
    assert.equal((await validateSavedSession(base, "invalid-fixture", undefined, 1000, 10)).status, 401);
    assert.equal(requests, 1);
  });
});
test("a hung API cannot leave restoration pending indefinitely", async () => {
  await withServer(() => {}, async base => {
    await assert.rejects(validateSavedSession(base, "public-fixture", undefined, 100, 10));
  });
});
test("logout/unmount cancels a restoration in flight", async () => {
  await withServer(() => {}, async base => {
    const controller = new AbortController();
    const request = validateSavedSession(base, "public-fixture", controller.signal, 2000, 10);
    controller.abort(); await assert.rejects(request);
  });
});
test("expiry metadata can drop identity but never creates one", () => {
  const token = "fixture." + btoa(JSON.stringify({ exp: 123 })) + ".signature";
  assert.equal(authTokenExpiresAt(token), 123000);
  for (const value of [null, "corrupt", "a.e30.c"]) assert.equal(authTokenExpiresAt(value), null);
});
