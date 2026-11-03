import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { ProtectionEngineService } from "../dist/engine.js";

/**
 * Contrato ATIVO da recusa global do kill legado.
 *
 * `KILL_TERMINATION_DISABLED` é uma decisão de produto fail-closed: a operação
 * não é tentada, não consulta o SO, não executa taskkill e não publica eventos.
 * O único efeito é a linha de auditoria `process.termination.refused`.
 *
 * Os cenários do caminho legado estão em `test/legacy-disabled/` e não são
 * executados. Se a flag for reaberta, este contrato tem de ser revisto em
 * conjunto com esses cenários, nunca apenas para os tornar verdes.
 */
const bases = [];

function base(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  bases.push(dir);
  return dir;
}

after(async () => {
  for (const dir of bases) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function processEntry(pid, overrides = {}) {
  return {
    pid,
    ppid: 0,
    name: "node.exe",
    path: process.execPath,
    commandLine: "node -e setTimeout",
    cpu: 0,
    memoryMb: 0,
    startedAt: new Date().toISOString(),
    trusted: "unknown",
    ...overrides,
  };
}

async function spawnSleeper() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

describe("killProcess — contrato ativo fail-closed", () => {
  it("recusa um PID válido sem consultar o SO, sem taskkill, sem eventos e com auditoria", async () => {
    const testBase = base("cybersafe-kill-contract-");
    const engine = new ProtectionEngineService(testBase);
    const victim = await spawnSleeper();
    try {
      engine.processes = [processEntry(victim.pid)];
      let queries = 0;
      let taskkills = 0;
      engine.queryCimProcesses = async () => {
        queries += 1;
        return [];
      };
      engine.runTaskkill = async () => {
        taskkills += 1;
        throw new Error("taskkill não pode ser chamado no contrato fail-closed");
      };
      const events = [];
      engine.eventBus.on("process.killed", () => events.push("killed"));
      engine.eventBus.on("process.exited", () => events.push("exited"));
      const before = engine.processes.map((entry) => entry.pid);

      const result = await engine.killProcess(victim.pid);

      assert.equal(result.success, false);
      assert.equal(result.status, "failed");
      assert.equal(result.pid, victim.pid);
      assert.match(result.error ?? "", /nenhuma ação foi executada/);
      assert.equal(queries, 0, "a recusa acontece antes de qualquer query ao SO");
      assert.equal(taskkills, 0, "taskkill nunca pode ser executado");
      assert.equal(victim.exitCode, null, "o processo real continua vivo");
      assert.deepEqual(events, [], "não pode publicar killed/exited");
      assert.deepEqual(engine.processes.map((entry) => entry.pid), before, "a lista não é alterada");

      const raw = await fs.readFile(path.join(testBase, "logs", "actions.log"), "utf8");
      const linha = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line)).find((entry) => entry.pid === victim.pid);
      assert.ok(linha, "a recusa tem de ficar auditada antes da resposta");
      assert.equal(linha.action, "process.termination.refused");
      assert.equal(linha.reason, "legacy-disabled");
      assert.equal(linha.request, "manual");
      assert.equal(linha.executed, false);
      assert.match(linha.requestId, /^k\d+-\d+$/);
      assert.equal(Number.isNaN(Date.parse(linha.timestamp)), false);
    } finally {
      try {
        victim.kill();
      } catch {
        /* já terminou */
      }
    }
  });

  it("PID inválido falha antes da auditoria e sem qualquer efeito no SO", async () => {
    const testBase = base("cybersafe-kill-contract-invalid-");
    const engine = new ProtectionEngineService(testBase);
    let queries = 0;
    let taskkills = 0;
    engine.queryCimProcesses = async () => {
      queries += 1;
      return [];
    };
    engine.runTaskkill = async () => {
      taskkills += 1;
      return { ok: true, status: "ok", exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await engine.killProcess(0);

    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.pid, 0);
    assert.equal(queries, 0);
    assert.equal(taskkills, 0);
    await assert.rejects(fs.readFile(path.join(testBase, "logs", "actions.log"), "utf8"));
  });
});
