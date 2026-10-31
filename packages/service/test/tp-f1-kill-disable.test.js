import { after, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { ProtectionEngineService } from "../dist/engine.js";

/**
 * DELTA DE CONGELAMENTO — terminação fail-closed no serviço.
 *
 * Este ficheiro é o RED/GREEN do delta separado `f1-kill-disable-20261026`:
 *
 *  - em F1-R2 (sem delta) FALHA, porque a terminação prossegue;
 *  - com o delta aplicado PASSA: `killProcess` recusa DENTRO do serviço e,
 *    como o dispatch do pipe (`process.killTree`) chama exatamente esse
 *    método, a recusa cobre também chamadas IPC diretas;
 *  - a listagem NÃO é desativada.
 *
 * Nenhum processo real é lançado ou terminado: a recusa é provada pela
 * ausência de consulta à fonte e de taskkill (spies).
 */

const BASE = mkdtempSync(path.join(os.tmpdir(), "cs-f1-kill-disable-"));

function alvo() {
  return {
    pid: 987670,
    ppid: 4,
    name: "alvo.exe",
    path: "C:\\Temp\\alvo.exe",
    commandLine: "alvo.exe",
    cpu: 0,
    memoryMb: 0,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    trusted: "unknown",
  };
}

test("IPC direto (process.killTree) recusa sem consultar a fonte nem disparar taskkill", async () => {
  const engine = new ProtectionEngineService(BASE);
  const row = alvo();
  engine.processes = [row];
  engine.processesPhotoAt = Date.now();
  let queries = 0;
  let taskkill = 0;
  engine.queryCimProcesses = async () => {
    queries += 1;
    return [row];
  };
  engine.runTaskkill = async () => {
    taskkill += 1;
    return { ok: true, status: "ok", exitCode: 0 };
  };
  try {
    const resposta = await engine["handleRequest"]({
      id: "req-1",
      type: "request",
      method: "process.killTree",
      payload: { pid: row.pid },
    });
    assert.equal(resposta.ok, true, "a indisponibilidade é uma resposta honesta, não um erro de protocolo");
    assert.equal(resposta.result.success, false);
    assert.equal(resposta.result.status, "failed");
    assert.match(String(resposta.result.error ?? ""), /indisponível/i);
    assert.equal(taskkill, 0, "nenhuma terminação pode ser executada");
    assert.equal(queries, 0, "fail-closed: a recusa acontece antes de qualquer consulta");
  } finally {
    await engine.dispose().catch(() => undefined);
  }
});

test("listar processos continua a funcionar com a terminação desativada", async () => {
  const engine = new ProtectionEngineService(BASE);
  const row = alvo();
  engine.processes = [row];
  engine.processesPhotoAt = Date.now();
  engine.processesEnumeratedAt = Date.now();
  engine.processMonitor.list = async () => [row];
  try {
    const { processes } = await engine.listProcesses();
    assert.ok(processes.some((p) => p.pid === row.pid), "a listagem não é desativada pelo delta");
  } finally {
    await engine.dispose().catch(() => undefined);
  }
});

after(() => rmSync(BASE, { recursive: true, force: true }));
