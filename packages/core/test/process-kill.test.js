import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  KILL_REAP_DEADLINE_MS,
  TASKKILL_TIMEOUT_MS,
  classifyKillTarget,
  isProcessAlive,
  killProcessTree,
  killTargetIdentity,
  normalizeProcessPath,
  reconcileProcessExit,
} from "../dist/response.js";

/**
 * Regressão do kill de processos (Gestor de Tarefas).
 *
 * Bug manual: excluir deixava a página presa (taskkill sem prazo) e o processo
 * continuava na lista. O backend tem agora (a) `taskkill` com timeout real,
 * (b) resultado estruturado, (c) auto-proteção por PID/ppid/path (nome só em
 * fallback) e (d) reconciliação autoritativa antes de publicar `process.killed`.
 */

function fakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

const emitSoon = (child, event, ...args) => setImmediate(() => child.emit(event, ...args));

describe("killProcessTree — prazo real e resultado estruturado", () => {
  it("exit 0 → ok/ok", async () => {
    const child = fakeChild();
    const pending = killProcessTree(4242, { spawnImpl: () => child });
    emitSoon(child, "exit", 0);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.status, "ok");
    assert.equal(result.exitCode, 0);
  });

  it("exit 128 → not-found (o alvo já não existia)", async () => {
    const child = fakeChild();
    const pending = killProcessTree(4242, { spawnImpl: () => child });
    emitSoon(child, "exit", 128);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.status, "not-found");
    assert.equal(result.exitCode, 128);
  });

  it("exit != 0/128 → failed com o código", async () => {
    const child = fakeChild();
    const pending = killProcessTree(4242, { spawnImpl: () => child });
    emitSoon(child, "exit", 1);
    const result = await pending;
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 1);
  });

  it("erro de spawn → failed, sem ficar pendente", async () => {
    const result = await killProcessTree(4242, {
      spawnImpl: () => {
        throw new Error("spawn ENOENT");
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.error, /ENOENT/);
  });

  it("taskkill que não termina é abortado no prazo (timeout real)", async () => {
    const child = fakeChild();
    const startedAt = Date.now();
    const result = await killProcessTree(4242, { timeoutMs: 15, spawnImpl: () => child });

    assert.equal(result.status, "timeout");
    assert.equal(result.ok, false);
    assert.equal(child.killed, true, "o processo taskkill tem de ser morto");
    assert.ok(Date.now() - startedAt < 2_000, "não pode esperar indefinidamente");
  });

  it("um exit tardio depois do timeout não muda o resultado", async () => {
    const child = fakeChild();
    const pending = killProcessTree(4242, { timeoutMs: 15, spawnImpl: () => child });
    const result = await pending;
    child.emit("exit", 0);
    assert.equal(result.status, "timeout");
  });

  it("expõe prazos default positivos", () => {
    assert.ok(TASKKILL_TIMEOUT_MS > 0);
    assert.ok(KILL_REAP_DEADLINE_MS > 0);
  });
});

describe("isProcessAlive", () => {
  it("o próprio processo está vivo", () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it("PIDs inválidos nunca estão vivos", () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      assert.equal(isProcessAlive(pid), false, String(pid));
    }
  });
});

describe("normalizeProcessPath", () => {
  it("normaliza barras, maiúsculas e prefixo \\\\?\\", () => {
    assert.equal(normalizeProcessPath("C:/Program Files/CyberSafe/Service.exe"), "c:\\program files\\cybersafe\\service.exe");
    assert.equal(normalizeProcessPath("\\\\?\\C:\\Windows\\System32\\svchost.exe"), "c:\\windows\\system32\\svchost.exe");
    assert.equal(normalizeProcessPath("  C:\\A\\B.EXE  "), "c:\\a\\b.exe");
  });

  it("entradas vazias devolvem string vazia", () => {
    for (const value of [undefined, null, ""]) {
      assert.equal(normalizeProcessPath(value), "");
    }
  });
});

describe("killTargetIdentity", () => {
  it("distingue processos por nome + linha de comando", () => {
    const a = killTargetIdentity({ name: "Chrome.exe", commandLine: "chrome.exe --type=renderer" });
    const b = killTargetIdentity({ name: "chrome.exe", commandLine: "chrome.exe --type=renderer" });
    assert.equal(a, b, "nome é case-insensitive");
    assert.notEqual(a, killTargetIdentity({ name: "chrome.exe", commandLine: "chrome.exe --type=gpu" }));
    assert.notEqual(a, killTargetIdentity({ name: "edge.exe", commandLine: "chrome.exe --type=renderer" }));
  });
});

describe("classifyKillTarget — PID/ppid/path primeiro, nome só fallback", () => {
  const ctx = {
    selfPid: 1000,
    ancestorPids: [900, 500],
    internalPaths: [normalizeProcessPath("C:\\Program Files\\CyberSafe\\service.exe")],
    fallbackNames: ["svchost.exe", "explorer.exe"],
    systemPidThreshold: 100,
  };

  it("protege o próprio serviço por PID", () => {
    assert.equal(classifyKillTarget({ pid: 1000 }, ctx), "self");
  });

  it("protege PIDs de sistema por limiar", () => {
    assert.equal(classifyKillTarget({ pid: 4 }, ctx), "system-pid");
  });

  it("protege ancestrais por PID", () => {
    assert.equal(classifyKillTarget({ pid: 900, name: "explorer.exe" }, ctx), "ancestor");
  });

  it("protege componentes internos por ppid (filhos do serviço/ancestral)", () => {
    assert.equal(classifyKillTarget({ pid: 1234, ppid: 1000 }, ctx), "internal");
    assert.equal(classifyKillTarget({ pid: 1234, ppid: 500 }, ctx), "internal");
  });

  it("protege componentes internos por caminho (case-insensitive)", () => {
    assert.equal(
      classifyKillTarget({ pid: 1234, path: "C:\\Program Files\\CyberSafe\\SERVICE.EXE" }, ctx),
      "internal",
    );
  });

  it("usa o nome APENAS quando não há caminho fiável", () => {
    assert.equal(classifyKillTarget({ pid: 1234, name: "Svchost.exe" }, ctx), "fallback-name");
    // Com caminho conhecido, o nome deixa de decidir.
    assert.equal(
      classifyKillTarget({ pid: 1234, name: "svchost.exe", path: "C:\\Windows\\System32\\svchost.exe" }, ctx),
      null,
    );
  });

  it("um processo normal não é protegido", () => {
    assert.equal(classifyKillTarget({ pid: 1234, name: "notepad.exe", path: "C:\\Windows\\notepad.exe" }, ctx), null);
  });
});

describe("classifyKillTarget — ligações runtime/projeto/app por path e commandLine", () => {
  const ctx = {
    selfPid: 1000,
    ancestorPids: [],
    internalPaths: [],
    internalPathPrefixes: [normalizeProcessPath("C:\\CyberSafe\\app")],
    commandLineMarkers: ["cybersafe", normalizeProcessPath("C:\\CyberSafe\\service\\dist")],
    fallbackNames: ["svchost.exe"],
    systemPidThreshold: 100,
  };

  it("protege por prefixo de diretório da app (com fronteira de separador)", () => {
    assert.equal(classifyKillTarget({ pid: 5000, path: "C:\\CyberSafe\\app\\electron.exe" }, ctx), "internal");
    // 'app-extra' não é a pasta da app: sem falso positivo por prefixo de texto.
    assert.equal(classifyKillTarget({ pid: 5000, path: "C:\\CyberSafe\\app-extra\\evil.exe" }, ctx), null);
  });

  it("protege node/electron/powershell só quando a commandLine liga ao projeto", () => {
    assert.equal(
      classifyKillTarget({
        pid: 5000,
        name: "node.exe",
        path: "C:\\Program Files\\nodejs\\node.exe",
        commandLine: "node C:\\proj\\cybersafe-assistant\\packages\\service\\dist\\index.js",
      }, ctx),
      "internal",
    );
    assert.equal(
      classifyKillTarget({ pid: 5000, name: "node.exe", path: "C:\\Program Files\\nodejs\\node.exe", commandLine: "node server.js" }, ctx),
      null,
      "um node qualquer não pode ser bloqueado globalmente",
    );
    assert.equal(
      classifyKillTarget({
        pid: 5000,
        name: "powershell.exe",
        path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        commandLine: "powershell -NoProfile -Command Start-Sleep 60",
      }, ctx),
      null,
      "um powershell qualquer não pode ser bloqueado globalmente",
    );
  });

  it("não protege por nome quando há commandLine/path fiáveis", () => {
    assert.equal(
      classifyKillTarget({ pid: 5000, name: "svchost.exe", path: "C:\\Windows\\System32\\svchost.exe", commandLine: "svchost.exe -k netsvcs" }, ctx),
      null,
    );
  });
});

describe("reconcileProcessExit — só publica depois de o PID desaparecer", () => {
  it("exited quando o PID desaparece", async () => {
    let slept = 0;
    const status = await reconcileProcessExit({
      pid: 42,
      probe: () => ({ alive: false }),
      sleep: async () => { slept += 1; },
    });
    assert.equal(status.status, "exited");
    assert.equal(slept, 0);
  });

  it("reused quando o PID continua vivo com outra identidade", async () => {
    const status = await reconcileProcessExit({
      pid: 42,
      originalIdentity: "old.exe|old.exe",
      probe: () => ({ alive: true, identity: "new.exe|new.exe" }),
      sleep: async () => {},
    });
    assert.equal(status.status, "reused");
  });

  it("still-running quando o PID nunca desaparece dentro do prazo", async () => {
    let clock = 0;
    const status = await reconcileProcessExit({
      pid: 42,
      originalIdentity: "app.exe|app.exe",
      probe: () => ({ alive: true, identity: "app.exe|app.exe" }),
      deadlineMs: 30,
      intervalMs: 10,
      now: () => clock,
      sleep: async () => { clock += 10; },
    });
    assert.equal(status.status, "still-running");
  });

  it("identidade desconhecida não é tratada como reuse (espera o desaparecimento)", async () => {
    const status = await reconcileProcessExit({
      pid: 42,
      originalIdentity: "app.exe|app.exe",
      probe: () => ({ alive: false }),
      sleep: async () => {},
    });
    assert.equal(status.status, "exited");
  });
});
