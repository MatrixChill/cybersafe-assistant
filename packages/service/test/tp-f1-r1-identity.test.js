import { after, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { ProtectionEngineService } from "../dist/engine.js";

/**
 * TP-PAP-F1-RUNTIME-20261026 — R1/R2 (reviews Codex).
 *
 * R1: `CreationDate` ausente nas duas pontas deixava a ação seguir até
 * `runTaskkill`.
 * R2 (FINDING-FRESH-PID-REUSE): a foto fresca dispensava a revalidação, e um
 * PID reutilizado com o MESMO nome/comando chegava a `taskkill` sem a fonte
 * ser consultada. A frescura da foto é metadado de cache; a identidade de
 * criação é consultada à fonte antes de TODA ação destrutiva.
 *
 * Fronteira coberta aqui:
 *  - identidade de criação tem de ser válida dos DOIS lados;
 *  - nome/comando iguais nunca substituem `CreationDate`;
 *  - foto fresca (0–2 s) NÃO dispensa a query de revalidação;
 *  - sem entrada no snapshot não há referência do utilizador: recusa;
 *  - CIM falhou ≠ CIM não devolveu o PID;
 *  - nenhum teste executa `taskkill` real.
 */

const BASE = mkdtempSync(path.join(os.tmpdir(), "cs-f1-r1-identity-"));
const OLD = new Date(Date.now() - 60_000).toISOString();
const YOUNG = new Date().toISOString();

function entry(overrides = {}) {
  return {
    pid: 987650,
    ppid: 4,
    name: "fixture-r1.exe",
    path: "C:\\Temp\\fixture-r1.exe",
    commandLine: "fixture-r1.exe --alvo",
    cpu: 0,
    memoryMb: 0,
    startedAt: OLD,
    trusted: "unknown",
    ...overrides,
  };
}

/** Cache + foto: `photoAgeMs` é o que decide se há revalidação. */
async function engineWith(entries, photoAgeMs = 0) {
  const engine = new ProtectionEngineService(BASE);
  engine.processes = entries;
  engine.processesPhotoAt = Date.now() - photoAgeMs;
  engine.runTaskkill = async () => {
    throw new Error("taskkill real proibido no teste R1");
  };
  return engine;
}

async function dispose(engine) {
  await engine.dispose().catch(() => undefined);
}

function refusedIdentity(result) {
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.match(String(result.error ?? ""), /identidade/i);
}

test("R1 RED: cache e CIM sem CreationDate não podem chegar ao taskkill", async () => {
  const engine = await engineWith([entry({ startedAt: "" })]);
  let taskkill = 0;
  let queries = 0;
  engine.queryCimProcesses = async () => {
    queries += 1;
    return [entry({ startedAt: "" })];
  };
  engine.runTaskkill = async () => {
    taskkill += 1;
    return { ok: true, status: "ok", exitCode: 0 };
  };
  try {
    const result = await engine.killProcess(987650);
    refusedIdentity(result);
    assert.equal(taskkill, 0, "sem identidade não se dispara taskkill");
    // Sem foto/identidade, a recusa não inventa uma consulta que prove o que falta.
    assert.ok(queries <= 1);
  } finally {
    await dispose(engine);
  }
});

test("R1: fonte sem CreationDate é recusada mesmo com cache válido e foto velha", async () => {
  const engine = await engineWith([entry()], 5_000);
  let taskkill = 0;
  let queries = 0;
  engine.queryCimProcesses = async () => {
    queries += 1;
    return [entry({ startedAt: "" })];
  };
  engine.runTaskkill = async () => {
    taskkill += 1;
    return { ok: true, status: "ok", exitCode: 0 };
  };
  try {
    const result = await engine.killProcess(987650);
    refusedIdentity(result);
    assert.equal(queries, 1, "foto velha obriga a consultar a fonte");
    assert.equal(taskkill, 0);
  } finally {
    await dispose(engine);
  }
});

test("R1: só o cache sem CreationDate é recusado, mesmo com fonte válida", async () => {
  const engine = await engineWith([entry({ startedAt: "" })], 5_000);
  let taskkill = 0;
  engine.queryCimProcesses = async () => [entry({ startedAt: OLD })];
  engine.runTaskkill = async () => {
    taskkill += 1;
    return { ok: true, status: "ok", exitCode: 0 };
  };
  try {
    refusedIdentity(await engine.killProcess(987650));
    assert.equal(taskkill, 0);
  } finally {
    await dispose(engine);
  }
});

test("R1: CreationDate inválida ou futura não prova identidade", async () => {
  for (const bad of ["not-a-date", new Date(Date.now() + 3_600_000).toISOString()]) {
    const engine = await engineWith([entry({ startedAt: bad })]);
    let taskkill = 0;
    engine.runTaskkill = async () => {
      taskkill += 1;
      return { ok: true, status: "ok", exitCode: 0 };
    };
    try {
      refusedIdentity(await engine.killProcess(987650));
      assert.equal(taskkill, 0, `startedAt=${bad}`);
    } finally {
      await dispose(engine);
    }
  }
});

test("R1: CreationDate inválida/futura na FONTE também não prova identidade", async () => {
  for (const bad of ["not-a-date", new Date(Date.now() + 3_600_000).toISOString()]) {
    const engine = await engineWith([entry()], 5_000);
    let taskkill = 0;
    engine.queryCimProcesses = async () => [entry({ startedAt: bad })];
    engine.runTaskkill = async () => {
      taskkill += 1;
      return { ok: true, status: "ok", exitCode: 0 };
    };
    try {
      refusedIdentity(await engine.killProcess(987650));
      assert.equal(taskkill, 0, `fonte startedAt=${bad}`);
    } finally {
      await dispose(engine);
    }
  }
});

test("R1: nome/comando iguais com CreationDate diferente são PID reutilizado", async () => {
  const engine = await engineWith([entry({ startedAt: OLD })], 5_000);
  let taskkill = 0;
  engine.queryCimProcesses = async () => [
    entry({ startedAt: new Date(Date.now() - 1_000).toISOString() }),
  ];
  engine.runTaskkill = async () => {
    taskkill += 1;
    return { ok: true, status: "ok", exitCode: 0 };
  };
  try {
    const result = await engine.killProcess(987650);
    assert.equal(result.status, "reused");
    assert.equal(result.success, false);
    assert.equal(taskkill, 0);
    assert.equal(engine.processes.some((p) => p.pid === 987650), false);
    assert.equal(engine.processTombstones.has(987650), false);
  } finally {
    await dispose(engine);
  }
});

test("R1: processo jovem com foto velha é revalidado (frescura é da foto)", async () => {
  const engine = await engineWith([entry({ startedAt: YOUNG })], 5_000);
  let taskkill = 0;
  let queries = 0;
  engine.queryCimProcesses = async () => {
    queries += 1;
    return [entry({ startedAt: YOUNG })];
  };
  engine.runTaskkill = async () => {
    taskkill += 1;
    return { ok: true, status: "ok", exitCode: 0 };
  };
  try {
    const result = await engine.killProcess(987650);
    assert.equal(queries, 1, "a idade do PROCESSO não pode dispensar a revalidação");
    assert.equal(taskkill, 1);
    assert.equal(result.success, true);
  } finally {
    await dispose(engine);
  }
});

test("R2: foto fresca continua a revalidar; criação igual segue para taskkill", async () => {
  const antigo = new Date(Date.now() - 3_600_000).toISOString();
  const engine = await engineWith([entry({ startedAt: antigo })], 0);
  let taskkill = 0;
  let queries = 0;
  engine.queryCimProcesses = async () => {
    queries += 1;
    return [entry({ startedAt: antigo })];
  };
  engine.runTaskkill = async () => {
    taskkill += 1;
    return { ok: true, status: "ok", exitCode: 0 };
  };
  try {
    const result = await engine.killProcess(987650);
    assert.equal(queries, 1, "foto fresca não dispensa a fonte: a criação é provada antes de agir");
    assert.equal(taskkill, 1);
    assert.equal(result.success, true);
  } finally {
    await dispose(engine);
  }
});

test("R1: fonte vazia na revalidação é already-exited confirmado, sem taskkill", async () => {
  const engine = await engineWith([entry()], 5_000);
  let taskkill = 0;
  engine.queryCimProcesses = async () => [];
  engine.runTaskkill = async () => {
    taskkill += 1;
    return { ok: true, status: "ok", exitCode: 0 };
  };
  try {
    const result = await engine.killProcess(987650);
    assert.equal(result.success, true);
    assert.equal(result.status, "already-exited");
    assert.equal(taskkill, 0);
    assert.equal(engine.processes.some((p) => p.pid === 987650), false);
    assert.equal(engine.processTombstones.has(987650), true);
  } finally {
    await dispose(engine);
  }
});

test("R1: CIM falhou na revalidação não vira killed nem reused", async () => {
  const engine = await engineWith([entry()], 5_000);
  let taskkill = 0;
  engine.queryCimProcesses = async () => {
    throw new Error("CIM indisponível");
  };
  engine.runTaskkill = async () => {
    taskkill += 1;
    return { ok: true, status: "ok", exitCode: 0 };
  };
  try {
    const result = await engine.killProcess(987650);
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.match(String(result.error ?? ""), /CIM|identidade/i);
    assert.equal(taskkill, 0, "falha de fonte não autoriza ação");
  } finally {
    await dispose(engine);
  }
});

test("R1: CIM devolveu o PID mas não há referência de snapshot ⇒ recusa", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const engine = new ProtectionEngineService(BASE);
  let taskkill = 0;
  engine.queryCimProcesses = async () => [entry({ pid: child.pid, startedAt: YOUNG })];
  engine.runTaskkill = async () => {
    taskkill += 1;
    return { ok: true, status: "ok", exitCode: 0 };
  };
  try {
    const result = await engine.killProcess(child.pid);
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.match(String(result.error ?? ""), /snapshot|referência|identidade/i);
    assert.equal(taskkill, 0);
  } finally {
    child.kill();
    await dispose(engine);
  }
});

test("R1: sem cache e CIM falhou ⇒ failed; sem cache e CIM vazio ⇒ failed distinto", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  const falha = new ProtectionEngineService(BASE);
  falha.queryCimProcesses = async () => {
    throw new Error("CIM indisponível");
  };
  falha.runTaskkill = async () => {
    throw new Error("taskkill proibido");
  };

  const vazio = new ProtectionEngineService(BASE);
  vazio.queryCimProcesses = async () => [];
  vazio.runTaskkill = async () => {
    throw new Error("taskkill proibido");
  };

  try {
    const a = await falha.killProcess(child.pid);
    const b = await vazio.killProcess(child.pid);
    assert.equal(a.status, "failed");
    assert.equal(b.status, "failed");
    assert.match(String(a.error ?? ""), /CIM|fonte|identidade/i);
    assert.match(String(b.error ?? ""), /PID|vazio|não devolveu|identidade/i);
    assert.notEqual(a.error, b.error, "falha de CIM e ausência de linha são factos distintos");
  } finally {
    child.kill();
    await dispose(falha);
    await dispose(vazio);
  }
});

test("R1: PID protegido é recusado antes de qualquer consulta/ação, mesmo sem cache", async () => {
  const engine = new ProtectionEngineService(BASE);
  let queries = 0;
  let taskkill = 0;
  engine.queryCimProcesses = async () => {
    queries += 1;
    return [];
  };
  engine.runTaskkill = async () => {
    taskkill += 1;
    return { ok: true, status: "ok", exitCode: 0 };
  };
  try {
    for (const pid of [4, process.pid]) {
      const result = await engine.killProcess(pid);
      assert.equal(result.status, "protected");
      assert.equal(result.success, false);
    }
    assert.equal(queries, 0);
    assert.equal(taskkill, 0);
  } finally {
    await dispose(engine);
  }
});

test("R1: kill normal com cache/foto/identidade válidos continua a funcionar", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const row = entry({ pid: child.pid, startedAt: YOUNG });
  const engine = await engineWith([row], 0);
  // A revalidação pré-ação consulta a fonte: a linha tem de descrever o
  // MESMO dono que o snapshot (identidade e CreationDate iguais).
  engine.queryCimProcesses = async () => [row];
  let taskkill = 0;
  engine.runTaskkill = async (pid) => {
    taskkill += 1;
    try {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    } catch {
      /* já saiu */
    }
    return { ok: true, status: "ok", pid, exitCode: 0 };
  };
  try {
    const result = await engine.killProcess(child.pid);
    assert.equal(result.success, true);
    assert.equal(result.status, "killed");
    assert.equal(taskkill, 1);
  } finally {
    child.kill();
    await dispose(engine);
  }
});

test("R2 RED: foto de 1 ms + PID reutilizado (mesmo nome/comando, criação diferente) não chega ao taskkill", async () => {
  const outro = new Date(Date.now() - 5_000).toISOString();
  const engine = await engineWith([entry({ startedAt: OLD })], 1);
  let taskkill = 0;
  let queries = 0;
  engine.queryCimProcesses = async () => {
    queries += 1;
    // O nome/comando são iguais: só a CreationDate revela o novo dono do PID.
    return [entry({ startedAt: outro })];
  };
  engine.runTaskkill = async () => {
    taskkill += 1;
    return { ok: true, status: "ok", exitCode: 0 };
  };
  try {
    const result = await engine.killProcess(987650);
    assert.equal(queries, 1, "a foto fresca não dispensa a fonte antes de agir");
    assert.equal(taskkill, 0, "a fonte contradiz o snapshot: nenhum taskkill");
    assert.equal(result.success, false);
    assert.equal(result.status, "reused");
  } finally {
    await dispose(engine);
  }
});

test("R2: foto fresca + CIM falhou ⇒ failed, nunca taskkill", async () => {
  const engine = await engineWith([entry()], 5);
  let taskkill = 0;
  engine.queryCimProcesses = async () => {
    throw new Error("CIM indisponível");
  };
  engine.runTaskkill = async () => {
    taskkill += 1;
    return { ok: true, status: "ok", exitCode: 0 };
  };
  try {
    const result = await engine.killProcess(987650);
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.match(String(result.error ?? ""), /CIM|identidade/i);
    assert.equal(taskkill, 0, "falha de fonte não autoriza ação");
  } finally {
    await dispose(engine);
  }
});

test("R2: foto fresca + CIM sem a linha ⇒ already-exited confirmado, sem taskkill", async () => {
  const engine = await engineWith([entry()], 5);
  let taskkill = 0;
  engine.queryCimProcesses = async () => [];
  engine.runTaskkill = async () => {
    taskkill += 1;
    return { ok: true, status: "ok", exitCode: 0 };
  };
  try {
    const result = await engine.killProcess(987650);
    assert.equal(result.success, true);
    assert.equal(result.status, "already-exited");
    assert.equal(taskkill, 0);
    assert.equal(engine.processTombstones.has(987650), true);
  } finally {
    await dispose(engine);
  }
});

after(() => rmSync(BASE, { recursive: true, force: true }));
