import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowsHealthEngine } from "../dist/powershell.js";

async function firewallSnapshot(data, ok = true) {
  const engine = new WindowsHealthEngine();
  // Replace only the OS query boundary; aggregation and classification stay real.
  engine.executor.run = async (query) => query === "firewallProfiles"
    ? { ok, data }
    : { ok: false, data: null, error: "unavailable in fixture" };
  return (await engine.getSnapshot()).firewall;
}

for (const [value, enabled] of [
  [true, true], [false, false], [1, true], [0, false],
  ["True", true], ["true", true], ["False", false], ["false", false],
]) {
  test(`firewall Enabled=${JSON.stringify(value)} has an explicit known state`, async () => {
    assert.deepEqual(await firewallSnapshot([{ Name: "Public", Enabled: value }]), {
      available: true, enabled, profiles: [{ name: "Public", enabled }],
    });
  });
}

for (const value of [undefined, null, "yes", 2, {}, []]) {
  test(`firewall Enabled=${JSON.stringify(value)} is unavailable, never a known state`, async () => {
    assert.deepEqual(await firewallSnapshot([{ Name: "Public", Enabled: value }]), {
      available: false, enabled: false, profiles: [],
    });
  });
}

test("one unknown profile invalidates the aggregate rather than reporting active", async () => {
  const result = await firewallSnapshot([{ Name: "Domain", Enabled: true }, { Name: "Public" }]);
  assert.equal(result.available, false);
  assert.deepEqual(result.profiles, []);
});

test("a disabled profile makes a known aggregate inactive", async () => {
  assert.equal((await firewallSnapshot([{ Name: "Domain", Enabled: true }, { Name: "Public", Enabled: 0 }])).enabled, false);
});

test("empty and failed queries are unavailable", async () => {
  assert.equal((await firewallSnapshot([])).available, false);
  assert.equal((await firewallSnapshot(null, false)).available, false);
});
