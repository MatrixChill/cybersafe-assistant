import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ExclusionManager } from "../dist/exclusions.js";
import os from "node:os";
import path from "node:path";

describe("ExclusionManager policy (scanner exclusion policy fix)", () => {
  const mgr = new ExclusionManager();

  test("high-risk extensions must NOT be excluded (they reach the engines)", () => {
    for (const ext of [".exe", ".dll", ".zip", ".lnk", ".msi", ".sys", ".bat", ".ps1", ".scr", ".jar"]) {
      const p = path.join(os.homedir(), "Downloads", `sample${ext}`);
      assert.equal(mgr.isExcluded(p), false, `${ext} should reach the engines`);
      assert.equal(mgr.exclusionReason(p), null, `${ext} should have no exclusion reason`);
    }
  });

  test("temp/cache extensions ARE excluded before engines", () => {
    for (const ext of [".tmp", ".log", ".cache", ".bak", ".dat"]) {
      const p = path.join(os.homedir(), "Documents", `notes${ext}`);
      assert.equal(mgr.isExcluded(p), true, `${ext} should be excluded`);
    }
  });

  test("Downloads is NOT a default path exclusion", () => {
    const downloads = path.join(os.homedir(), "Downloads", "setup.exe");
    assert.equal(mgr.isExcluded(downloads), false);
    const defaultPaths = mgr.getConfig().paths;
    assert.ok(
      !defaultPaths.some((p) => p.toLowerCase().includes("downloads")),
      "no default path exclusion may contain 'downloads'"
    );
  });

  test("CyberSafe internal dir IS excluded", () => {
    const internal = path.join(os.homedir(), ".cybersafe-service", "definitions.dat");
    assert.equal(mgr.isExcluded(internal), true);
  });

  test("empty path is excluded", () => {
    assert.equal(mgr.isExcluded(""), true);
  });
});
