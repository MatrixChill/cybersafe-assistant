import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
      assert.equal(result.exitCode, 0, "o exit code real do taskkill é propagado");
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

describe("processes.list — verdade do SO reconciliada a pedido (P0)", () => {
  it("com >200 processos reais, o PID mais alto continua acessível (o cap de 200 matava-o)", async () => {
    const engine = new ProtectionEngineService();
    const osTruth = [];
    for (let i = 0; i < 331; i++) osTruth.push(processEntry({ pid: 4000 + i, name: `app-${i}.exe` }));
    let enumerations = 0;
    engine.processMonitor.list = async () => {
      enumerations += 1;
      return osTruth;
    };
    // Estado do bug: cache truncado a 200 e sem qualquer caminho de volta ao SO.
    engine.processes = osTruth.slice(0, 200);

    const list = await engine.listProcesses();
    assert.equal(list.length, 331, "a lista devolve a verdade do SO, não o cache capado");
    assert.ok(list.some((p) => p.pid === 4000 + 330), "o processo de PID mais alto continua visível");
    assert.equal(engine.processes.length, 331, "o cache fica reconciliado com a verdade");
    assert.equal(enumerations, 1);
  });

  it("refresh repetido dentro da janela de frescura não re-enumerada (a UI refresca a cada evento)", async () => {
    const engine = new ProtectionEngineService();
    const truth = [processEntry({ pid: 11, name: "a.exe" })];
    let calls = 0;
    engine.processMonitor.list = async () => {
      calls += 1;
      return truth;
    };
    await engine.listProcesses();
    await engine.listProcesses();
    await engine.listProcesses();
    assert.equal(calls, 1, "dentro do TTL serve o cache recém-reconciliado");
  });

  it("enumeração falhou → serve o cache de eventos, nunca lista vazia silenciosa", async () => {
    const engine = new ProtectionEngineService();
    engine.processes = [processEntry({ pid: 777, name: "mantido.exe" })];
    engine.processMonitor.list = async () => {
      throw new Error("PowerShell caiu");
    };
    const list = await engine.listProcesses();
    assert.equal(list.length, 1);
    assert.equal(list[0].pid, 777);
  });

  it("process.started já não empurra processos para fora do cache (cap de 200 removido)", () => {
    const engine = new ProtectionEngineService();
    engine.bindWatchers();
    engine.processes = [];
    for (let i = 0; i < 210; i++) {
      // "node.exe" está na SAFE_PROCESSES: exercita só a manutenção do cache.
      engine.processMonitor.emit("process.started", processEntry({ pid: 30000 + i, name: "node.exe" }));
    }
    assert.equal(engine.processes.length, 210);
    assert.ok(engine.processes.some((p) => p.pid === 30000), "o primeiro continua presente");
  });
});

describe("killProcess — diagnóstico do taskkill propagado (P0)", () => {
  it("acesso negado (exit 5) → status/exitCode/stderr próprios, com a mensagem real, sem mexer na lista", async () => {
    const engine = new ProtectionEngineService();
    engine.processes = [processEntry({
      pid: 41111,
      name: "notepad.exe",
      path: "C:\\Windows\\System32\\notepad.exe",
      commandLine: "notepad.exe",
    })];
    engine.runTaskkill = async (pid) => ({
      ok: false,
      status: "access-denied",
      pid,
      exitCode: 5,
      stdout: "",
      stderr: 'ERROR: The process "41111" could not be terminated. Reason: Access is denied.',
      error: 'ERROR: The process "41111" could not be terminated. Reason: Access is denied.',
    });

    const result = await engine.killProcess(41111);
    assert.equal(result.success, false);
    assert.equal(result.status, "access-denied", "desfecho próprio, não um failed genérico");
    assert.equal(result.exitCode, 5);
    assert.match(result.stderr ?? "", /Access is denied/);
    assert.match(result.error ?? "", /Access is denied/, "a mensagem real do taskkill chega ao renderer");
    assert.ok(engine.processes.some((p) => p.pid === 41111), "falha não remove o processo da lista");
  });

  it("falha genérica → failed com exit code e a mensagem real (nunca error undefined)", async () => {
    const engine = new ProtectionEngineService();
    // O alvo tem de estar VIVO para o Windows: o engine reconcilia pelo SO, e um
    // PID que nao existe da logo success/killed, sem falhar nada. Por isso e um
    // processo real (o stub de isProcessAlive nao existe) reportado pelo CIM.
    const victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
    await new Promise((resolve, reject) => {
      victim.once("spawn", resolve);
      victim.once("error", reject);
    });
    try {
      engine.processes = [processEntry({ pid: victim.pid, name: "node.exe", commandLine: "node dorme.js" })];
      engine.queryCimProcesses = async (filter) =>
        filter.startsWith("ProcessId=")
          ? [processEntry({ pid: victim.pid, name: "node.exe", commandLine: "node dorme.js" })]
          : [];
      engine.runTaskkill = async (pid) => ({
        ok: false,
        status: "failed",
        pid,
        exitCode: 2,
        stdout: "",
        stderr: "ERRO: aconteceu qualquer coisa real.",
        error: "ERRO: aconteceu qualquer coisa real.",
      });

      const result = await engine.killProcess(victim.pid);
      assert.equal(result.status, "failed");
      assert.equal(result.exitCode, 2);
      // O engine compoe a mensagem (Tentativas=N e a lista de sobreviventes), por
      // isso o texto real e um prefixo, nunca a igualdade.
      assert.match(result.error ?? "", /^ERRO: aconteceu qualquer coisa real\./);
      assert.match(result.error ?? "", new RegExp(String(victim.pid)), "o PID que sobreviveu tem de aparecer no erro");
    } finally {
      try {
        victim.kill();
      } catch {
        /* ja saiu */
      }
    }
  });

  it("actions.log fica com PID, comando, exit code, stdout e stderr", async () => {
    const engine = new ProtectionEngineService();
    const logsDir = path.join(os.homedir(), ".cybersafe-service", "logs");
    await fs.mkdir(logsDir, { recursive: true });
    engine.processes = [processEntry({ pid: 41112, name: "calc.exe", path: "C:\\Windows\\System32\\calc.exe" })];
    engine.runTaskkill = async (pid) => ({
      ok: false,
      status: "access-denied",
      pid,
      exitCode: 5,
      stdout: "KILLLOG-STDOUT-MARCADOR",
      stderr: "KILLLOG-STDERR-MARCADOR acesso negado",
      error: "KILLLOG-STDERR-MARCADOR acesso negado",
    });

    await engine.killProcess(41112);

    // appendFile é fire-and-forget: espreita até a linha chegar.
    let line = "";
    for (let i = 0; i < 50 && !line; i++) {
      await new Promise((r) => setTimeout(r, 40));
      const raw = await fs.readFile(path.join(logsDir, "actions.log"), "utf-8").catch(() => "");
      line = raw.split(/\r?\n/).filter((entry) => entry.includes("PID=41112")).pop() ?? "";
    }
    assert.ok(line, "o kill tem de ficar registado em actions.log");
    // Literal de proposito: e o que o utilizador ve no ficheiro, e tem de
    // bater certo com o argv real do spawn (fixado em core/test/process-kill
    // .test.js contra taskkillArgs). /F e /T antes do /PID.
    assert.match(line, /Cmd=taskkill \/F \/T \/PID 41112/);
    assert.doesNotMatch(line, /\/PID 41112 \/T/, "o log nao pode voltar a descrever a ordem antiga");
    assert.match(line, /Status=access-denied/);
    assert.match(line, /Exit=5/);
    assert.match(line, /Stdout="KILLLOG-STDOUT-MARCADOR"/);
    assert.match(line, /Stderr="KILLLOG-STDERR-MARCADOR/);
  });

  it("alvo vivo fora do cache: query-alvo ao OS alimenta classifyKillTarget sem enumerar tudo (A1)", async () => {
    const engine = new ProtectionEngineService();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      // Cache vazio (o cenário do bug). A identidade vem de uma query-alvo
      // por PID — listProcesses()/monitor.list completos estão proibidos aqui.
      engine.processes = [];
      let enumerations = 0;
      engine.processMonitor.list = async () => {
        enumerations += 1;
        return [];
      };
      const seenFilters = [];
      engine.queryCimProcesses = async (filter) => {
        seenFilters.push(filter);
        return [processEntry({
          pid: child.pid,
          name: "node.exe",
          path: process.execPath,
          commandLine: "node C:\\cybersafe-assistant\\packages\\service\\dist\\index.js",
        })];
      };

      const result = await engine.killProcess(child.pid);
      assert.equal(result.status, "protected", "a classificação não pode ficar cega quando o cache falha");
      assert.equal(result.protectedReason, "internal");
      assert.equal(enumerations, 0, "o caminho do kill NUNCA enumera o SO completo (A1)");
      assert.ok(seenFilters.some((f) => f.startsWith("ProcessId=")), "usa query-alvo pelo PID");
    } finally {
      try {
        child.kill();
      } catch {
        /* já saiu */
      }
    }
  });
});

describe("kill — reliability do snapshot (A1/A2/A3)", () => {
  async function spawnSleeper() {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return child;
  }

  it("A1: kill de PID fora do cache usa query-alvo e não dispara enumeração completa", async () => {
    const engine = new ProtectionEngineService();
    const victim = await spawnSleeper();
    try {
      engine.processes = [];
      let enumerations = 0;
      engine.processMonitor.list = async () => {
        enumerations += 1;
        return [];
      };
      engine.queryCimProcesses = async (filter) => {
        if (!filter.startsWith("ProcessId=")) return [];
        return [processEntry({
          pid: victim.pid,
          name: "node.exe",
          path: process.execPath,
          commandLine: "node dorme.js",
        })];
      };
      // Mock do taskkill: mata mesmo o filho do teste e reporta exit 0.
      engine.runTaskkill = async (pid) => {
        victim.kill();
        await new Promise((resolve) => victim.once("exit", resolve));
        return { ok: true, status: "ok", pid, exitCode: 0, stdout: "SUCCESS: terminated.", stderr: "" };
      };

      const result = await engine.killProcess(victim.pid);
      assert.equal(result.status, "killed");
      assert.equal(result.exitCode, 0);
      assert.equal(enumerations, 0, "nenhuma listProcesses()/monitor.list completa no caminho do kill");
    } finally {
      try {
        victim.kill();
      } catch {
        /* já saiu */
      }
    }
  });

  it("A2: após remoção, TTL invalidado — o próximo processes.list re-enumerada e nunca devolve o morto", async () => {
    const engine = new ProtectionEngineService();
    const dead = processEntry({ pid: 22001, name: "morto.exe", path: "C:\\Temp\\morto.exe" });
    const alive = processEntry({ pid: 22002, name: "vivo.exe", path: "C:\\Temp\\vivo.exe" });
    let calls = 0;
    // 1.ª enumeração vê os dois; 2.ª (pós-kill) já não vê o morto — como o SO real.
    engine.processMonitor.list = async () => {
      calls += 1;
      return calls === 1 ? [dead, alive] : [alive];
    };
    engine.queryCimProcesses = async () => []; // sem instância homónima: not-found limpo

    const first = await engine.listProcesses();
    assert.equal(first.length, 2);
    const cachedAgain = await engine.listProcesses();
    assert.equal(cachedAgain.length, 2);
    assert.equal(calls, 1, "dentro do TTL serve o cache");

    engine.runTaskkill = async (pid) => ({
      ok: false,
      status: "not-found",
      pid,
      exitCode: 128,
      stdout: "",
      stderr: 'ERROR: The process "22001" not found.',
    });
    const kill = await engine.killProcess(22001);
    assert.equal(kill.status, "already-exited");
    assert.equal(engine.processesEnumeratedAt, 0, "a remoção do cache tem de invalidar a janela de frescura");

    const after = await engine.listProcesses();
    assert.equal(calls, 2, "o refresh imediato re-enumerada (não serve o cache com a entrada morta nem a restaura)");
    assert.ok(after.every((p) => p.pid !== 22001), "o morto nunca volta à lista");
  });

  it("A3: stub/alias morto com sucesso + instância viva da mesma identidade → alias-stub com o PID real", async () => {
    const engine = new ProtectionEngineService();
    const stub = await spawnSleeper(); // faz de PID do launcher
    try {
      engine.processes = [processEntry({
        pid: stub.pid,
        name: "Notepad.exe",
        path: `C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\Notepad.exe`,
        commandLine: `\\??\\C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\Notepad.exe`,
      })];
      engine.runTaskkill = async (pid) => {
        stub.kill();
        await new Promise((resolve) => stub.once("exit", resolve));
        return { ok: true, status: "ok", pid, exitCode: 0, stdout: "SUCCESS: terminated.", stderr: "" };
      };
      // A query por nome devolve o processo REAL (outro PID, vivo: o próprio teste).
      engine.queryCimProcesses = async (filter) => {
        assert.match(filter, /^Name=/, "o caminho de stub pergunta ao OS pelo nome");
        return [processEntry({
          pid: process.pid,
          name: "Notepad.exe",
          path: "C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2607.14.0_x64__8wekyb3d8bbwe\\Notepad\\Notepad.exe",
          commandLine: "C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2607.14.0_x64__8wekyb3d8bbwe\\Notepad\\Notepad.exe",
        })];
      };

      const result = await engine.killProcess(stub.pid);
      assert.equal(result.success, false, "matar o stub NÃO é sucesso — o notepad real continua vivo");
      assert.equal(result.status, "alias-stub");
      assert.match(result.error ?? "", /stub\/App Execution Alias/i);
      assert.ok((result.error ?? "").includes(String(process.pid)), "a mensagem diz qual é o PID real");
      assert.equal(engine.processes.some((p) => p.pid === stub.pid), false, "o stub sai da lista");
      assert.equal(engine.processesEnumeratedAt, 0, "A2 também no caminho killed");
    } finally {
      try {
        stub.kill();
      } catch {
        /* já saiu */
      }
    }
  });

  it("A3: not-found com OUTRA instância de identidade idêntica → alias-stub explícito", async () => {
    const engine = new ProtectionEngineService();
    engine.processes = [processEntry({
      pid: 23001,
      name: "app.exe",
      path: "C:\\Temp\\app.exe",
      commandLine: "app.exe --mesma-identidade",
    })];
    engine.runTaskkill = async (pid) => ({
      ok: false,
      status: "not-found",
      pid,
      exitCode: 128,
      stdout: "",
      stderr: 'ERROR: The process "23001" not found.',
    });
    engine.queryCimProcesses = async () => [processEntry({
      pid: process.pid, // vivo por definição
      name: "app.exe",
      path: "C:\\Temp\\app.exe",
      commandLine: "app.exe --mesma-identidade",
    })];

    const result = await engine.killProcess(23001);
    assert.equal(result.status, "alias-stub");
    assert.equal(result.success, false);
    assert.ok((result.error ?? "").includes(String(process.pid)), "reporta o PID da instância viva");
  });

  it("A3: kill bem-sucedido de processo NORMAL com outra instância homónima NÃO é confundido com alias", async () => {
    const engine = new ProtectionEngineService();
    const victim = await spawnSleeper();
    try {
      engine.processes = [processEntry({
        pid: victim.pid,
        name: "chrome.exe",
        path: "C:\\Program Files\\Google\\Chrome\\chrome.exe",
        commandLine: "chrome.exe --no-window",
      })];
      engine.runTaskkill = async (pid) => {
        victim.kill();
        await new Promise((resolve) => victim.once("exit", resolve));
        return { ok: true, status: "ok", pid, exitCode: 0, stdout: "SUCCESS.", stderr: "" };
      };
      // Instância homónima viva (outro chrome do utilizador) NÃO dispara alias-stub
      // porque o alvo não tem marcador de stub e o killed-same-identity está desligado.
      engine.queryCimProcesses = async () => [processEntry({ pid: process.pid, name: "chrome.exe", commandLine: "chrome.exe" })];

      const result = await engine.killProcess(victim.pid);
      assert.equal(result.status, "killed");
      assert.equal(result.success, true);
    } finally {
      try {
        victim.kill();
      } catch {
        /* já saiu */
      }
    }
  });
});

/**
 * P0-A — a lista nunca pode repor um PID que o Windows confirmou morto, e o
 * kill não pode depender de `process.kill(pid,0)` para saber se o processo
 * ainda é o alvo.
 *
 * Os três buracos que isto fecha:
 *  1. uma `processes.list` demora 2-4 s; se um kill acontecer lá pelo meio, o
 *     resultado VELHO era atribuído por cima do cache já filtrado e ainda
 *     re-armava o TTL — o morto ficava visível e intocável;
 *  2. o `process.started` do poll (snapshot capturado antes da morte)
 *     re-inseria exatamente o mesmo processo;
 *  3. um processo terminado mantem o objeto abrível enquanto houver handles —
 *     OpenProcess diz "vivo", o CIM já o perdeu; o kill gastava o deadline e
 *     devolvia um falso `still-running` sem tocar no cache.
 */
describe("P0-A — morto confirmado nunca volta; CIM é a autoridade", () => {
  async function spawnSleeper() {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return child;
  }

  const okTaskkill = async (pid) => ({
    ok: true,
    status: "ok",
    pid,
    exitCode: 0,
    stdout: "SUCCESS: terminated.",
    stderr: "",
  });

  it("P1: enumeração EM VOO durante o kill não repõe o morto nem re-arman o TTL", async () => {
    const engine = new ProtectionEngineService();
    const dead = processEntry({ pid: 31001, name: "morto.exe", commandLine: "morto.exe" });
    const alive = processEntry({ pid: 31002, name: "vivo.exe", commandLine: "vivo.exe" });
    let enumerations = 0;
    let releaseEnumeration;
    const gate = new Promise((resolve) => {
      releaseEnumeration = resolve;
    });
    // O SO (lento) ainda tem o morto quando a enumeração arranca — e vai
    // continuar a tê-lo no resultado, porque o snapshot foi tirado antes.
    engine.processMonitor.list = async () => {
      enumerations += 1;
      await gate;
      return [dead, alive];
    };
    engine.queryCimProcesses = async () => [];
    engine.runTaskkill = okTaskkill;
    engine.processes = [dead, alive];
    engine.processesEnumeratedAt = 0;

    const inflight = engine.listProcesses(); // NÃO se espera: a enumeração fica em voo
    const kill = await engine.killProcess(31001);
    assert.equal(kill.status, "killed", JSON.stringify(kill));

    releaseEnumeration();
    const raced = await inflight;
    assert.ok(!raced.some((entry) => entry.pid === 31001), "o resultado velho não pode repor o PID morto");
    // Mecanismo (mudou com a reconciliação): a foto é fundida com o que o
    // monitor observou durante a foto, e o que saiu está tombstonado — o
    // resultado JÁ está certo, portanto a frescura é re-armada em vez de
    // obrigar o pedido seguinte a voltar ao Windows sem ganhar nada.
    assert.ok(engine.processesEnumeratedAt > 0, "a reconciliação fundida põe a frescura");
    assert.ok(!engine.processes.some((entry) => entry.pid === 31001), "o morto fica de fora do cache");

    // E o pedido seguinte é servido do cache reconciliado, com o morto fora.
    const after = await engine.listProcesses();
    assert.equal(enumerations, 1, "sem re-enumeração: a foto já estava reconciliada");
    assert.deepEqual(after.map((entry) => entry.pid), [31002]);
  });

  it("P1: process.started de snapshot velho não re-insere; dono novo no PID passa", () => {
    const engine = new ProtectionEngineService();
    engine.bindWatchers();
    const dead = processEntry({ pid: 32001, name: "morto.exe", commandLine: "morto.exe" });
    engine.processes = [dead, processEntry({ pid: 32002, name: "vivo.exe" })];

    engine.processMonitor.emit("process.exited", dead);
    assert.equal(engine.processes.length, 1, "saída natural tira o processo");

    engine.processMonitor.emit("process.started", processEntry({ pid: 32001, name: "morto.exe", commandLine: "morto.exe" }));
    assert.equal(engine.processes.some((entry) => entry.pid === 32001), false, "o MESMO processo morto não reentra");

    engine.processMonitor.emit("process.started", processEntry({ pid: 32001, name: "outro.exe", commandLine: "outro --flag" }));
    assert.equal(engine.processes.length, 2, "PID reutilizado por outro dono é um processo novo e legítimo");
    assert.equal(engine.processes[0].name, "outro.exe");
  });

  it("P1: o tombstone barra o morto numa re-enumeração que o ainda traz", async () => {
    const engine = new ProtectionEngineService();
    const dead = processEntry({ pid: 33001, name: "morto.exe", commandLine: "morto.exe" });
    engine.processes = [dead];
    engine.processesEnumeratedAt = 0;
    engine.runTaskkill = okTaskkill;
    engine.queryCimProcesses = async () => [];
    // O CIM teima em listar o morto (o handle ainda não foi libertado).
    engine.processMonitor.list = async () => [dead];

    await engine.killProcess(33001);
    const list = await engine.listProcesses();
    assert.equal(list.length, 0, "mesmo listado pelo SO, o morto confirmado não volta");
  });

  it("P2: OpenProcess diz vivo, CIM já não tem o PID → morte confirmada (não é timeout)", async () => {
    const engine = new ProtectionEngineService();
    const victim = await spawnSleeper();
    try {
      engine.processes = [processEntry({ pid: victim.pid, name: "node.exe", commandLine: "node dorme.js" })];
      engine.queryCimProcesses = async () => []; // o Windows já o não lista
      engine.runTaskkill = okTaskkill; // NÃO mata o filho: é precisamente o caso do handle pendurado
      engine.killProbeMinIntervalMs = 0;
      engine.killReapIntervalMs = 10;
      engine.killReapDeadlineMs = 4_000;

      const startedAt = Date.now();
      const result = await engine.killProcess(victim.pid);
      assert.equal(result.status, "killed", JSON.stringify(result));
      assert.ok(Date.now() - startedAt < 2_000, "não pode gastar o deadline inteiro à espera de um morto");
      assert.equal(engine.processes.some((entry) => entry.pid === victim.pid), false);
      assert.equal(engine.processesEnumeratedAt, 0);
      assert.ok(engine.processTombstones.has(victim.pid), "o PID fica tombado até à próxima verdade do SO");
    } finally {
      try {
        victim.kill();
      } catch {
        /* já saiu */
      }
    }
  });

  it("P2: uma única ausência no CIM NÃO declara morte (falhanço transitório não mata)", async () => {
    const engine = new ProtectionEngineService();
    const victim = await spawnSleeper();
    try {
      engine.processes = [processEntry({ pid: victim.pid, name: "node.exe", commandLine: "node dorme.js" })];
      let queries = 0;
      engine.queryCimProcesses = async () => {
        queries += 1;
        // 1.ª ausência (pode ser PowerShell a falhar); depois volta com a MESMA
        // identidade → o processo está vivo e é o nosso alvo.
        if (queries === 1) return [];
        return [processEntry({ pid: victim.pid, name: "node.exe", commandLine: "node dorme.js" })];
      };
      engine.runTaskkill = okTaskkill;
      engine.killProbeMinIntervalMs = 0;
      engine.killReapIntervalMs = 10;
      engine.killReapDeadlineMs = 300;
      engine.killProbeConfirmations = 2;

      const result = await engine.killProcess(victim.pid);
      assert.equal(result.status, "timeout", "vivo confirmado: nunca é falso killed");
      assert.equal(queries >= 2, true, "tem de haver segunda palavra do CIM");
      assert.equal(engine.processes.some((entry) => entry.pid === victim.pid), true, "a linha não se mente para baixo");
      assert.equal(engine.processesEnumeratedAt, 0, "P3: desfecho terminal invalida sempre a janela de frescura");
    } finally {
      try {
        victim.kill();
      } catch {
        /* já saiu */
      }
    }
  });

  it("P2: reconciliação não lança um PowerShell por iteração (a tempestade que fazia o kill lento)", async () => {
    const engine = new ProtectionEngineService();
    const victim = await spawnSleeper();
    try {
      engine.processes = [processEntry({ pid: victim.pid, name: "node.exe", commandLine: "node dorme.js" })];
      let queries = 0;
      engine.queryCimProcesses = async () => {
        queries += 1;
        return [processEntry({ pid: victim.pid, name: "node.exe", commandLine: "node dorme.js" })];
      };
      engine.runTaskkill = okTaskkill;
      // Guarda de 10 s sobre um deadline de 400 ms com intervalo de 20 ms:
      // ~20 iterações, UMA consulta-alvo. Antes: ~20 PowerShell.
      engine.killProbeMinIntervalMs = 10_000;
      engine.killReapIntervalMs = 20;
      engine.killReapDeadlineMs = 400;

      const result = await engine.killProcess(victim.pid);
      assert.equal(result.status, "timeout");
      assert.equal(queries, 1, `uma query por kill, não uma por iteração (${queries})`);
    } finally {
      try {
        victim.kill();
      } catch {
        /* já saiu */
      }
    }
  });

  it("P3: PID reutilizado — a entrada do dono antigo sai, sem tombstone, e o TTL cai", async () => {    const engine = new ProtectionEngineService();
    const victim = await spawnSleeper();
    try {
      engine.processes = [processEntry({ pid: victim.pid, name: "node.exe", commandLine: "node dorme.js" })];
      engine.queryCimProcesses = async () => [
        processEntry({ pid: victim.pid, name: "outro.exe", commandLine: "outro.exe --novo-dono" }),
      ];
      engine.runTaskkill = okTaskkill;
      engine.killProbeMinIntervalMs = 0;
      engine.killReapIntervalMs = 10;
      engine.killReapDeadlineMs = 1_000;

      const result = await engine.killProcess(victim.pid);
      assert.equal(result.status, "reused");
      assert.equal(result.success, false);
      assert.equal(engine.processes.some((entry) => entry.pid === victim.pid), false, "a linha do dono antigo não fica");
      assert.equal(engine.processTombstones.has(victim.pid), false, "o novo dono está VIVO: não pode ficar barrado");
      assert.equal(engine.processesEnumeratedAt, 0);
    } finally {
      try {
        victim.kill();
      } catch {
        /* já saiu */
      }
    }
  });
});

/**
 * ROUND 2 — retry com verificacao pelo SO e varredura da arvore.
 *
 * Evidence real do actions.log: `taskkill` com Exit=255 sobre um PID cuja arvore
 * nao caiu. O exit 255 nao distingue "ja nao existe" de "nao consegui terminar",
 * por isso a decisao de repetir tem de vir do Windows, e o `/T` tem de ser
 * substituido por mortes individuais quando a raiz morreu e os filhos ficaram
 * orfaos. Usa filhos reais porque e exatamente isso que se quer provar: um PID
 * vivo para o SO nao pode ser fingido num stub.
 */
describe("kill round 2 — retry verificado e arvore abatida um a um", () => {
  async function spawnSleeper() {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return child;
  }

  const failed255 = (pid) => ({
    ok: false,
    status: "failed",
    pid,
    exitCode: 255,
    stdout: "",
    stderr: "ERRO: Nao foi possivel terminar o processo.",
    error: "Nao foi possivel terminar o processo com PID.",
  });

  // O caso real do Windows em pt-PT para um alvo que ja nao existe: exit 255 com
  // a mensagem da tarefa inexistente, nunca a de "nao possivel terminar".
  const notFound255 = (pid) => ({
    ok: false,
    status: "not-found",
    pid,
    exitCode: 255,
    stdout: "",
    stderr: 'ERRO: Nao ha ocorrencia da tarefa "41113" em execucao.',
    error: 'Nao ha ocorrencia da tarefa "41113" em execucao.',
  });

  it("PID que o Windows ja nao tem NAO recebe segunda tentativa", async () => {
    const engine = new ProtectionEngineService();
    const ghost = processEntry({ pid: 98765432, name: "fantasma.exe" });
    engine.processes = [ghost];
    engine.queryCimProcesses = async () => [];
    const called = [];
    engine.runTaskkill = async (pid) => {
      called.push(pid);
      return notFound255(pid);
    };

    const result = await engine.killProcess(98765432);
    assert.equal(called.length, 1, "repetir sobre um PID inexistente nao e resiliencia");
    // not-found nunca repete, logo o SO e a unica autoridade: o desfecho e sucesso.
    assert.equal(result.success, true);
    assert.equal(result.status, "already-exited");
  });

  // Irmao do anterior: prova que um 255 nao prova nada. Mesmo com a mensagem de
  // "nao possivel terminar", quem manda e o SO, e um PID ausente e sucesso.
  it("exit 255 sem prova: o SO manda, um PID ausente da sucesso e nao repete", async () => {
    const engine = new ProtectionEngineService();
    const ghost = processEntry({ pid: 98765436, name: "fantasma.exe" });
    engine.processes = [ghost];
    engine.queryCimProcesses = async () => [];
    const called = [];
    engine.runTaskkill = async (pid) => {
      called.push(pid);
      return failed255(pid);
    };

    const result = await engine.killProcess(98765436);
    assert.equal(called.length, 1, "o 255 nao justifica segunda tentativa quando o PID nao existe");
    assert.equal(result.success, true, "o SO disse que o PID nao existe: nao ha nada a matar");
    assert.equal(result.status, "killed");
  });

  it("acesso negado para logo: nao ha retry de recusa", async () => {
    const engine = new ProtectionEngineService();
    const victim = await spawnSleeper();
    try {
      engine.processes = [processEntry({ pid: victim.pid, name: "node.exe", commandLine: "node dorme.js" })];
      engine.queryCimProcesses = async (filter) =>
        filter.startsWith("ProcessId=")
          ? [processEntry({ pid: victim.pid, name: "node.exe", commandLine: "node dorme.js" })]
          : [];
      const called = [];
      engine.runTaskkill = async (pid) => {
        called.push(pid);
        return { ok: false, status: "access-denied", pid, exitCode: 5, stdout: "", stderr: "Acesso negado.", error: "Acesso negado." };
      };

      const result = await engine.killProcess(victim.pid);
      assert.equal(called.length, 1, "a segunda tentativa daria exatamente na mesma recusa");
      assert.equal(result.status, "access-denied");
    } finally {
      try {
        victim.kill();
      } catch {
        /* já saiu */
      }
    }
  });

  it("vivo para o Windows = no maximo duas tentativas, e diz-no", async () => {
    const engine = new ProtectionEngineService();
    const victim = await spawnSleeper();
    try {
      engine.processes = [processEntry({ pid: victim.pid, name: "node.exe", commandLine: "node dorme.js" })];
      engine.queryCimProcesses = async (filter) =>
        filter.startsWith("ProcessId=")
          ? [processEntry({ pid: victim.pid, name: "node.exe", commandLine: "node dorme.js" })]
          : [];
      const called = [];
      engine.runTaskkill = async (pid) => {
        called.push(pid);
        return failed255(pid);
      };

      const result = await engine.killProcess(victim.pid);
      assert.equal(called.length, 2, `esperava 2 tentativas, houve ${called.length}`);
      assert.equal(result.success, false);
      assert.match(result.error ?? "", /Tentativas=2/);
      assert.match(result.error ?? "", new RegExp(String(victim.pid)), "diz quais PIDs continuam vivos");
    } finally {
      try {
        victim.kill();
      } catch {
        /* já saiu */
      }
    }
  });

  it("REGRESSAO REAL: raiz morta com filho vivo — o /T nao chegava la", async () => {
    const engine = new ProtectionEngineService();
    const filho = await spawnSleeper();
    try {
      const rootPid = 98765433;
      engine.processes = [processEntry({ pid: rootPid, name: "launcher.exe" })];
      // A arvore, vista pelo Windows: o filho existe e esta vivo, mas o ppid ja
      // nao e o da raiz original (re-parented) — exactamente o caso do launcher.
      engine.queryCimProcesses = async (filter) => {
        if (filter.startsWith("ParentProcessId=")) {
          return [processEntry({ pid: filho.pid, name: "node.exe", ppid: rootPid, commandLine: "node dorme.js" })];
        }
        return [];
      };
      const targeted = [];
      engine.runTaskkill = async (pid) => {
        targeted.push(pid);
        if (pid === filho.pid) {
          try {
            filho.kill();
            await new Promise((resolve) => filho.once("exit", resolve));
          } catch {
            /* ja saiu */
          }
        }
        return failed255(pid);
      };

      const result = await engine.killProcess(rootPid);
      assert.ok(targeted.includes(filho.pid), "o filho tem de ser abatido individualmente");
      assert.equal(result.success, true, "raiz confirmada morta e nada da arvore sobreviveu");
      assert.equal(result.status, "killed");
    } finally {
      try {
        filho.kill();
      } catch {
        /* já saiu */
      }
    }
  });

  it("a varredura nunca abate componente protegido do CyberSafe", async () => {
    const engine = new ProtectionEngineService();
    const rootPid = 98765434;
    engine.processes = [processEntry({ pid: rootPid, name: "launcher.exe" })];
    const systemChild = processEntry({ pid: 4, name: "System", ppid: rootPid });
    engine.queryCimProcesses = async (filter) => (filter.startsWith("ParentProcessId=") ? [systemChild] : []);
    const targeted = [];
    engine.runTaskkill = async (pid) => {
      targeted.push(pid);
      return failed255(pid);
    };

    const result = await engine.killProcess(rootPid);
    assert.equal(targeted.includes(4), false, "PID 4 (System) jamais e alvo, aparecendo na arvore");
    // Um PID protegido nunca entra em survived: vai para refusedProtected, logo
    // o kill e um sucesso legitimo e o status e killed.
    assert.equal(result.success, true);
    assert.equal(result.status, "killed");
  });

  it("actions.log registou cada tentativa, com o comando real", async () => {
    const engine = new ProtectionEngineService();
    const rootPid = 98765435;
    engine.processes = [processEntry({ pid: rootPid, name: "fantasma.exe" })];
    engine.queryCimProcesses = async () => [];
    engine.runTaskkill = async (pid) => failed255(pid);
    const logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-kill-attempt-"));
    engine.logsDir = logsDir;
    try {
      await engine.killProcess(rootPid);
      let raw = "";
      for (let i = 0; i < 50 && !raw.includes("Attempt=1"); i += 1) {
        await new Promise((r) => setTimeout(r, 40));
        raw = await fs.readFile(path.join(logsDir, "actions.log"), "utf-8").catch(() => "");
      }
      assert.match(raw, /Cmd=taskkill \/F \/T \/PID 98765435/, "o log espelha o argv canónico");
      assert.match(raw, /Attempt=1/);
      assert.match(raw, /Exit=255/);
    } finally {
      await fs.rm(logsDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
