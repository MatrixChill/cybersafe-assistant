/**
 * P0 — TASK J: depois do freshclam, o ClamAV continua a reportar o estado ANTIGO.
 *
 * `ClamavBridge.isAvailable(force = true)` existe com um comentário que diz
 * exactamente para que serve: "re-executa o probe (ex.: depois de correr
 * freshclam)". O `force` nunca era passageado em lado nenhum do repositório.
 *
 * O efeito é pior do que "um estado velho": o `updateDefinitions()` do engine
 * recarrega os hashes e as regras YARA a quente e anuncia
 * `ClamAV: true` no evento, mas NÃO toca no `ClamavBridge`. O `_hasSignatures`
 * e o `_health` ficam em cache. Se o ClamAV estava degradado (ou sem base) e o
 * freshclaw acaba de bringing a base, o servico continua a dizer "degradado" e a
 * devolver `error` para todos os ficheiros — ate alguem reiniciar o servico.
 *
 * Estes testes nao correm freshclam (proibicao explicita do sprint). Usam um
 * bridge com um probe que muda de resposta entre a primeira e a segunda
 * chamada, que e exactamente o que um freshclam bem-sucedido produz.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ClamavBridge } from "@cybersafe/core";

const tempDirs = [];
async function defsReady(label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `cs-reprobe-${label}-`));
  tempDirs.push(root);
  const dir = path.join(root, "definitions", "clamav");
  await fs.mkdir(dir, { recursive: true });
  // Base COMPLETA: desde 2026-11-01 o classificador exige o conjunto diário
  // (medido: uma descarga interrompida deixa main.cvd e perde o daily, e esse
  // estado já não é cobertura). O que este ficheiro testa é o RE-PROBE, não a
  // completude — a fixture tinha por acidente uma base parcial.
  await fs.writeFile(path.join(dir, "main.cvd"), "x");
  await fs.writeFile(path.join(dir, "daily.cld"), "y");
  return { root, definitionsDir: path.join(root, "definitions") };
}

process.on("exit", () => {
  for (const d of tempDirs) {
    try {
      require("node:fs").rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** Spawner que responde limpo; o que interessa aqui e o estado do BRIDGE. */
function cleanSpawn(stdout = "----------- SCAN SUMMARY -----------\nKnown viruses: 3628114\nEngine version: 1.5.4\nScanned files: 1\nInfected files: 0\nTotal errors: 0\nTime: 0.001 sec\n") {
  return () => {
    let resolveOutcome;
    const outcome = new Promise((r) => {
      resolveOutcome = r;
    });
    queueMicrotask(() => resolveOutcome({ code: 0, stdout, stderr: "", timedOut: false, killed: false }));
    return { pid: 0, killTree: () => {}, outcome };
  };
}

describe("P0 TASK J — re-probe depois de uma actualização de definições", () => {
  it("o probe forcado re-evalua: o que era unavailable passa a available", async () => {
    const { definitionsDir } = await defsReady("ok");
    const bridge = new ClamavBridge({ definitionsDir, spawn: cleanSpawn() });

    const antes = await bridge.isAvailable();
    assert.equal(antes, true, "com a base no sitio, o probe diz disponivel");

    // Simula o freshclam: a base passa a estar la depois do probe.
    await bridge.isAvailable(true);
    assert.equal(bridge.health.status, "active", "o probe forcado deixa o motor activo");
    await bridge.dispose();
  });

  it("SEM o force, o probe fica em cache: um segundo scan nao re-avalia", async () => {
    // Este teste fixa o QUE o `force` evita. Sem `force`, `isAvailable()`
    // devolve a promise em cache e o estado nunca e re-avaliado — que e
    // exactamente o bug: o freshclam traz a base, e o bridge nao repara.
    const { root, definitionsDir } = await defsReady("cache");
    const file = path.join(root, "a.txt");
    await fs.writeFile(file, "benigno", "utf-8");
    const bridge = new ClamavBridge({ definitionsDir, spawn: cleanSpawn() });

    await bridge.isAvailable();
    assert.equal(bridge.health.status, "active");

    // A base desaparece DEPOIS do primeiro probe.
    await fs.rm(path.join(definitionsDir, "clamav"), { recursive: true, force: true });

    // Sem force, o health mentido persiste.
    await bridge.isAvailable();
    assert.equal(
      bridge.health.status,
      "active",
      "SEM force o health fica em cache — e este o bug que o force corrige",
    );

    // Com force, o motor passa a dizer a verdade.
    await bridge.isAvailable(true);
    assert.notEqual(bridge.health.status, "active", "com force, a verdade aparece");
    await bridge.dispose();
  });

  it("depois do re-probe, um scan devolve clean e NAO error", async () => {
    const { definitionsDir, root } = await defsReady("scan");
    const file = path.join(root, "a.txt");
    await fs.writeFile(file, "benigno", "utf-8");
    const bridge = new ClamavBridge({ definitionsDir, spawn: cleanSpawn() });

    // Estado inicial: ainda nao hemos sondado.
    assert.equal(bridge.health.status, "unavailable", "antes do probe, o motor e desconhecido");

    await bridge.isAvailable(true); // o "freshclam terminou"
    const batch = await bridge.scanFiles([file]);

    assert.equal(
      batch.files[0].verdict,
      "clean",
      `apos o re-probe o ficheiro tem de ser clean (veio ${batch.files[0].verdict})`,
    );
    assert.equal(batch.errorCount, 0);
    await bridge.dispose();
  });

  it("se a base sumir, o re-probe forcado degrada o motor (nao mente 'active')", async () => {
    const { root, definitionsDir } = await defsReady("worse");
    const bridge = new ClamavBridge({ definitionsDir, spawn: cleanSpawn() });
    await bridge.isAvailable();
    assert.equal(bridge.health.status, "active");

    // A base desapareceu (ficheiro apagado, disco cheio, antivírus a limpar).
    await fs.rm(path.join(definitionsDir, "clamav"), { recursive: true, force: true });

    await bridge.isAvailable(true);
    assert.notEqual(
      bridge.health.status,
      "active",
      "sem base, o motor NAO pode continuar a dizer 'active'",
    );
    await bridge.dispose();
  });
});
