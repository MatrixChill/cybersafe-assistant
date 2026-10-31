import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { ProtectionEngineService } from "../dist/engine.js";
import { classifyProcessEnumerationError } from "@cybersafe/shared-types";
import { ProcessSnapshotFailure } from "@cybersafe/native-windows";

/**
 * TP-PAP-F1-RUNTIME-20261026 — F1b.
 *
 * (1) Uma falha de enumeração não pode ficar a servir cache até ao TTL: durante
 *     o intervalo de retry serve a última foto com `truth.state=failed`; depois
 *     disso volta ao SO, mesmo que a foto ainda seja recente.
 * (2) O estágio concreto (spawn/execução/parse/vazio) chega ao classificador
 *     público sem inventar um contador novo em shared-types.
 */

const BASE = mkdtempSync(path.join(os.tmpdir(), "cs-f1-recovery-"));

const entrada = {
  pid: 4242,
  ppid: 4,
  name: "exemplo.exe",
  path: "",
  commandLine: "exemplo.exe",
  cpu: 0,
  memoryMb: 0,
  startedAt: "2026-10-26T10:00:00.000Z",
  trusted: "unknown",
};

test("falha → cache com truth failed; retry devido → SO outra vez e recupera", async (t) => {
  const engine = new ProtectionEngineService(BASE);
  t.after(async () => {
    await engine.dispose().catch(() => undefined);
    rmSync(BASE, { recursive: true, force: true });
  });

  let chamadas = 0;
  let falhar = false;
  engine.processMonitor.list = async () => {
    chamadas += 1;
    if (falhar) throw new Error("CIM falhou");
    return [entrada];
  };

  const primeira = await engine.listProcesses();
  assert.equal(primeira.truth.state, "ok");
  assert.equal(primeira.processes.length, 1);
  assert.ok(primeira.truth.enumeratedAt > 0);

  // Força uma tentativa (foto envelhecida) que falha; a lista antiga fica.
  engine.processesEnumeratedAt = 0;
  falhar = true;
  const falha = await engine.listProcesses();
  assert.equal(falha.truth.state, "failed");
  assert.equal(falha.truth.attempt.error.code, "cim");
  assert.equal(falha.processes.length, 1, "a última foto boa não é apagada por uma falha");
  assert.equal(falha.truth.servedFrom, "cache");
  const chamadasAposFalha = chamadas;

  // Dentro da janela de retry: não se martela o SO; serve cache + failed.
  falhar = false;
  const duranteRetry = await engine.listProcesses();
  assert.equal(chamadas, chamadasAposFalha, "não repete a enumeração dentro da janela de retry");
  assert.equal(duranteRetry.truth.state, "failed");
  assert.equal(duranteRetry.truth.servedFrom, "cache");

  // Passada a janela: a próxima leitura vai ao SO e a verdade recupera.
  engine.processesAttempt.finishedAt = Date.now() - 2_000;
  const recuperada = await engine.listProcesses();
  assert.ok(chamadas > chamadasAposFalha, "a recuperação volta a enumerar o SO");
  assert.equal(recuperada.truth.state, "ok");
  assert.equal(recuperada.truth.servedFrom, "snapshot");
  assert.equal(recuperada.processes.length, 1);
});

test("PID reutilizado: foto antiga + CIM com outra identidade → reused, sem taskkill", async (t) => {
  const engine = new ProtectionEngineService(BASE);
  t.after(async () => {
    await engine.dispose().catch(() => undefined);
    rmSync(BASE, { recursive: true, force: true });
  });

  engine.processes = [{
    ...entrada,
    pid: 5001,
    name: "velho.exe",
    commandLine: "velho.exe --antes",
    startedAt: "2026-01-01T00:00:00.000Z",
  }];
  engine.processesPhotoAt = Date.now() - 5_000;
  engine.runCimQuery = async () => [{
    pid: 5001,
    ppid: 4,
    name: "novo.exe",
    commandLine: "novo.exe --depois",
    path: "",
    startedAt: "2026-10-26T12:00:00.000Z",
  }];
  let taskkillChamado = false;
  engine.runTaskkill = async () => {
    taskkillChamado = true;
    return { success: true, status: "killed", pid: 5001 };
  };

  const resultado = await engine.killProcess(5001);
  assert.equal(resultado.success, false);
  assert.equal(resultado.status, "reused");
  assert.equal(taskkillChamado, false, "não se dispara taskkill sobre um PID que mudou de dono");
});

test("revalidação indisponível: CIM falha → failed, nunca «já morreu» nem taskkill", async (t) => {
  const engine = new ProtectionEngineService(BASE);
  t.after(async () => {
    await engine.dispose().catch(() => undefined);
    rmSync(BASE, { recursive: true, force: true });
  });

  engine.processes = [{
    ...entrada,
    pid: 5002,
    name: "alvo.exe",
    commandLine: "alvo.exe --x",
    startedAt: "2026-01-01T00:00:00.000Z",
  }];
  engine.runCimQuery = async () => { throw new Error("CIM indisponível"); };
  let taskkillChamado = false;
  engine.runTaskkill = async () => {
    taskkillChamado = true;
    return { success: true, status: "killed", pid: 5002 };
  };

  const resultado = await engine.killProcess(5002);
  assert.equal(resultado.success, false);
  assert.equal(resultado.status, "failed");
  assert.match(String(resultado.error), /CIM|identidade/i);
  assert.equal(taskkillChamado, false, "sem identidade provada não se dispara taskkill");
});

test("estágios nativos chegam ao classificador público sem novo contrato", () => {
  const cimExecucao = new ProcessSnapshotFailure(
    "spawn",
    "CIM execução: powershell.exe indisponível (spawn ENOENT)",
  );
  assert.equal(classifyProcessEnumerationError(cimExecucao).code, "cim");

  const timeout = new ProcessSnapshotFailure(
    "execution",
    "CIM execução: tempo esgotado a enumerar Win32_Process",
  );
  assert.equal(classifyProcessEnumerationError(timeout).code, "cim");

  const parse = new ProcessSnapshotFailure("parse", "JSON parse: payload de processos não é JSON utilizável");
  assert.equal(classifyProcessEnumerationError(parse).code, "parse");

  const vazio = new ProcessSnapshotFailure("empty", "CIM vazio: zero registos utilizáveis");
  assert.equal(classifyProcessEnumerationError(vazio).code, "cim");
});
