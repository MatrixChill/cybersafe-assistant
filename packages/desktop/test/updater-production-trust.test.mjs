import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createProductionUpdater } from "../src/updater/production.ts";

const trustPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "updater",
  "release-trust.json",
);
const trust = JSON.parse(fs.readFileSync(trustPath, "utf-8"));

function opts(extra = {}) {
  return {
    runtimeSupported: true,
    installedVersion: "0.1.11",
    cacheDir: path.join(process.cwd(), ".fixture-cache-que-nao-existe"),
    installedBuild: "build-de-teste",
    installedCommit: "0000000",
    ...extra,
  };
}

describe("updater de produção — trust stable ativa, medida no código real", () => {
  it("nasce configurado no canal stable sem consultar a rede", () => {
    const u = createProductionUpdater(opts());
    const snap = u.snapshotCopy();
    assert.equal(snap.channel, "stable");
    assert.equal(snap.phase, "idle");
    assert.equal(snap.automaticCheckEnabled, false);
    assert.equal(snap.canInstall, false);
  });

  it("cacheDir vazio continua a fechar o updater", () => {
    const u = createProductionUpdater(opts({ cacheDir: "" }));
    assert.equal(u.snapshotCopy().phase, "unconfigured");
  });

  it("install sem manifesto validado recusa antes de executar instalador", async () => {
    const u = createProductionUpdater(opts());
    const r = await u.install({ confirmed: true, expectedVersion: "0.2.0" });
    assert.equal(r.ok, false);
    assert.notEqual(r.error, "unconfigured");
  });

  it("a trust stable está completa e a instalação assistida continua separada", () => {
    assert.equal(trust.enabled, true);
    assert.match(trust.publicKeyPem, /BEGIN PUBLIC KEY/);
    assert.equal(
      trust.pinnedKeyFingerprint,
      "3982C36398918D077A417DDA02E6E7FF6C1F70622684DA4FB43673652E4C8FB6",
    );
    assert.equal(trust.publisherLabel, "CyberSafe Assistant — academic unsigned");
    assert.equal(trust.assistedInstallationEnabled, false);
  });

  it("o feed stable é o repositório oficial por HTTPS", () => {
    assert.match(
      String(trust.feedManifestUrl),
      /^https:\/\/github\.com\/MatrixChill\/cybersafe-assistant\/releases\/latest\/download\/update-manifest\.json$/,
    );
  });
});
