import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { ProtectionEngineService } from "../dist/engine.js";

/**
 * Regressão do kill de processos no serviço.
 *
 * O que acontecia: `killProcess` só olhava ao nome/limiar de PID, não tinha
 * prazo e publicava `process.killed` logo após o exit code do taskkill — antes
 * de o PID desaparecer. Agora devolve resultado estruturado, protege o próprio
 * serviço/ancestrais/internos e só publica depois de confirmar o desaparecimento.
 */

/** PID de um processo que já terminou (garantido por espera real do exit). */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid;
}

function processEntry(overrides) {
  return {
    pid: 0,
    ppid: 0,
    name: "sample.exe",
    path: "",
    commandLine: "",
    cpu: 0,
    memoryMb: 0,
    startedAt: new Date().toISOString(),
    trusted: "unknown",
    ...overrides,
  };
}

describe("killProcess — resultado estruturado e auto-proteção", () => {
  it("PID inválido → failed", async () => {
    const engine = new ProtectionEngineService();
    for (const pid of [0, -3, 1.5]) {
      const result = await engine.killProcess(pid);
      assert.equal(result.success, false);
      assert.equal(result.status, "failed");
      assert.equal(result.pid, pid);
    }
  });

  it("o próprio serviço nunca é terminado (proteção por PID)", async () => {
    const engine = new ProtectionEngineService();
    const result = await engine.killProcess(process.pid);
    assert.equal(result.success, false);
    assert.equal(result.status, "protected");
    assert.equal(result.protectedReason, "self");
  });

  it("PIDs de sistema são protegidos por limiar", async () => {
    const engine = new ProtectionEngineService();
    const result = await engine.killProcess(4);
    assert.equal(result.status, "protected");
    assert.equal(result.protectedReason, "system-pid");
  });

  it("não bloqueia globalmente o runtime partilhado (mesmo executável, sem ligação)", async () => {
    const engine = new ProtectionEngineService();
    const dead = await deadPid();
    engine.processes = [processEntry({
      pid: dead,
      name: "node.exe",
      path: process.execPath,
      commandLine: "node server.js",
    })];
    const result = await engine.killProcess(dead);
    assert.equal(result.status, "already-exited", "sem ligação ao projeto, não é protegido");
  });

  it("um processo já terminado devolve already-exited (não é erro)", async () => {
    const engine = new ProtectionEngineService();
    const pid = await deadPid();
    const result = await engine.killProcess(pid);
    assert.equal(result.success, true);
    assert.equal(result.status, "already-exited");
    assert.equal(result.pid, pid);
  });

  it("não protege por nome quando há caminho fiável, e taskkill not-found → already-exited", async () => {
    const engine = new ProtectionEngineService();
    const dead = await deadPid();
    engine.processes = [processEntry({
      pid: dead,
      name: "svchost.exe",
      path: "C:\\Windows\\System32\\svchost.exe",
    })];
    const result = await engine.killProcess(dead);
    assert.equal(result.success, true);
    assert.equal(result.status, "already-exited");
  });
});

describe("killProcess — reconciliação autoritativa publica só após o PID desaparecer", () => {
  it("termina o processo, remove-o da lista e publica killed + exited", async () => {
    const engine = new ProtectionEngineService();
    const victim = spawn("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 120"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      await new Promise((resolve, reject) => {
        victim.once("spawn", resolve);
        victim.once("error", reject);
      });

      engine.processes = [processEntry({
        pid: victim.pid,
        name: "powershell.exe",
        path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        commandLine: "powershell -NoProfile -Command Start-Sleep -Seconds 120",
      })];

      const seen = [];
      engine.eventBus.on("process.killed", () => seen.push("killed"));
      engine.eventBus.on("process.exited", () => seen.push("exited"));

      const result = await engine.killProcess(victim.pid);

      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.status, "killed");
      assert.deepEqual(seen, ["killed", "exited"]);
      assert.equal(engine.processes.some((entry) => entry.pid === victim.pid), false);
    } finally {
      try {
        victim.kill();
      } catch {
        /* já terminou */
      }
    }
  });
});

describe("componentes internos — protegidos só quando ligados ao runtime/projeto", () => {
  it("node ligado ao projeto é protegido por commandLine", async () => {
    const engine = new ProtectionEngineService();
    engine.processes = [processEntry({
      pid: 61000,
      name: "node.exe",
      path: "C:\\Program Files\\nodejs\\node.exe",
      commandLine: "node C:\\proj\\cybersafe-assistant\\packages\\service\\dist\\index.js",
    })];
    const result = await engine.killProcess(61000);
    assert.equal(result.status, "protected");
    assert.equal(result.protectedReason, "internal");
  });

  it("o helper de snapshot do serviço é protegido por commandLine", async () => {
    const engine = new ProtectionEngineService();
    engine.processes = [processEntry({
      pid: 61002,
      name: "powershell.exe",
      commandLine: "powershell -NoProfile -Command Get-CimInstance Win32_Process | ConvertTo-Json",
    })];
    const result = await engine.killProcess(61002);
    assert.equal(result.status, "protected");
  });

  it("node/powershell sem ligação à app NÃO são bloqueados globalmente", async () => {
    const engine = new ProtectionEngineService();
    const dead = await deadPid();
    engine.processes = [processEntry({
      pid: dead,
      name: "node.exe",
      path: "C:\\Program Files\\nodejs\\node.exe",
      commandLine: "node server.js",
    })];
    const result = await engine.killProcess(dead);
    // Não foi tratado como protegido: caiu no ramo já-terminou.
    assert.equal(result.status, "already-exited");
    assert.equal(result.success, true);
  });
});

describe("processMonitor — process.exited natural não duplica o kill reconciliado", () => {
  it("publica só quando o PID ainda estava no cache", () => {
    const engine = new ProtectionEngineService();
    const events = [];
    engine.eventBus.on("process.exited", () => events.push("exited"));

    const entry = processEntry({ pid: 55555, name: "sample.exe" });
    engine.processes = [entry];

    engine.handleNaturalProcessExit(entry);
    assert.equal(events.length, 1);
    assert.equal(engine.processes.some((p) => p.pid === 55555), false);

    // Segunda deteção do mesmo PID já fora do cache: nada novo é publicado.
    engine.handleNaturalProcessExit(entry);
    assert.equal(events.length, 1);
  });

  it("lista já filtrada por um kill reconciliado não gera evento duplicado", () => {
    const engine = new ProtectionEngineService();
    const events = [];
    engine.eventBus.on("process.exited", () => events.push("exited"));

    const entry = processEntry({ pid: 66666, name: "ghost.exe" });
    // Simula o que o kill reconciliado faz: PID já removido do cache.
    engine.processes = [];
    engine.handleNaturalProcessExit(entry);

    assert.equal(events.length, 0);
  });
});
