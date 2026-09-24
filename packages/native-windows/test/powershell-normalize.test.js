import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeTopProcesses } from "../dist/powershell.js";

function rawProcess({ pid = 1, name = "node.exe", workingSet = 0, cpu = 0, path = "", user = "SYSTEM" } = {}) {
  return { ProcessId: pid, Name: name, WorkingSet: workingSet, CpuPercent: cpu, ExecutablePath: path, User: user };
}

describe("normalizeTopProcesses — unidades de memória", () => {
  test("WorkingSetSize em bytes é convertido corretamente para MB", () => {
    // 3.4 GB em bytes -> deve dar ~3.3 GB / ~3310 MB (nunca mais de 1024^3)
    const bytes = 3_473_000_000;
    const [proc] = normalizeTopProcesses([rawProcess({ workingSet: bytes })]);
    assert.ok(proc.memoryMb > 3000 && proc.memoryMb < 3400, `esperado ~3310 MB, obtido ${proc.memoryMb}`);
    assert.ok(proc.memoryMb < 1_000_000, "nunca deve parecer TB (bug antigo de MB rotulado a partir de bytes/1024)");
  });

  test("um processo de ~500 MB mantém valor plausível", () => {
    const [proc] = normalizeTopProcesses([rawProcess({ workingSet: 500 * 1024 * 1024 })]);
    assert.equal(proc.memoryMb, 500);
  });

  test("WorkingSet ausente vira 0", () => {
    const [proc] = normalizeTopProcesses([rawProcess({})]);
    assert.equal(proc.memoryMb, 0);
    assert.equal(proc.cpuPercent, 0);
  });
});

describe("normalizeTopProcesses — exclusão de System Idle Process", () => {
  test("PID 0 (System Idle Process) é removido do ranking", () => {
    const idle = rawProcess({ pid: 0, name: "System Idle Process", cpu: 73.3 });
    const busy = rawProcess({ pid: 1234, name: "node.exe", cpu: 12 });
    const list = normalizeTopProcesses([idle, busy]);
    assert.equal(list.length, 1);
    assert.equal(list[0].pid, 1234);
    assert.equal(list[0].name, "node.exe");
  });

  test("processos normais (incl. System, PID 4) são mantidos", () => {
    const system = rawProcess({ pid: 4, name: "System", cpu: 8 });
    const list = normalizeTopProcesses([system]);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "System");
  });

  test("entrada não-array e null são toleradas", () => {
    assert.deepEqual(normalizeTopProcesses(null), []);
    assert.deepEqual(normalizeTopProcesses(undefined), []);
    assert.deepEqual(normalizeTopProcesses({}), []);
  });
});