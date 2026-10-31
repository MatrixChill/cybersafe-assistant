import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { ProtectionEngineService } from "../dist/engine.js";

test("cada servico encaminha a sua raiz de definicoes ao ClamAV e ao updater", async () => {
  const first = path.join(os.tmpdir(), "cs-basedir-wiring-a");
  const second = path.join(os.tmpdir(), "cs-basedir-wiring-b");
  const a = new ProtectionEngineService(first);
  const b = new ProtectionEngineService(second);
  for (const [service, base] of [[a, first], [b, second]]) {
    assert.equal(service.clamav.options.definitionsDir, path.join(base, "definitions"));
    assert.equal(service.updater.definitionsDir, path.join(base, "definitions"));
    service.clamav.clamconfDatabaseDirs = async () => [];
    const dirs = await service.clamav.collectDatabaseCandidates();
    assert.ok(dirs.some((candidate) => candidate.dir === path.join(base, "definitions", "clamav")));
  }
});