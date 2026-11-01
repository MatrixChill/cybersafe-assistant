import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { ClamavBridge, CLAMAV_ENGINE_PROCESS_NAMES } from "../dist/index.js";
import { isLoadProof, makeLoadProofHandle } from "./fixtures/clamav-load-proof.js";

/**
 * P0 — CLAMAV_RESOURCE_EXHAUSTION.
 *
 * Evidência manual (utilizador, 2026-10-02): 5 ficheiros .txt benignos
 * produziram DURAS DE `clamscan.exe` simultâneos, ~981 MB de RSS cada,
 * 98% de RAM e ~196 s. Diagnóstico em
 * `output/p0-clamav-resource-exhaustion/CHECKPOINT-1-DIAGNOSIS.md`.
 *
 * Duas causas, ambas de código:
 *
 *  1. CICLO AUTO-ALIMENTADO. O `ProcessMonitor` emitia `process.started` para
 *     o `clamscan.exe` que o próprio CyberSafe tinha acabado de iniciar, e o
 *     motor voltava a analisá-lo — porque `clamscan.exe` não está em
 *     SAFE_PROCESSES nem excluído das exclusões. Cada volta custava ~1 GB.
 *  2. ÓRFÃOS. `execFile(..., { timeout: 10000 })` rejeita a promise mas NÃO
 *     mata o filho: o clamscan continuava a correr com ~988 MB muito depois
 *     de o código já terUMNCTuado "falhou" e passado ao ficheiro seguinte.
 *
 * Estes testes fixam o contrato de SEGURANÇA (fase 3): nunca mais de um
 * clamscan simultâneo, e nenhum clamscan sobrevive a timeout/abort/dispose.
 * ASpeed de scan (batch) é fase 4 e não é o objecto destes testes.
 */

/**
 * Detecção síncrona do binário real. Os testes que dependem do clamscan real
 * são `skip`ped quando não existe, em vez de passarem a fingir cobertura.
 */
const CLAMSCAN_AVAILABLE = (() => {
  try {
    const r = spawnSync("clamscan", ["--version"], { timeout: 5000, windowsHide: true, encoding: "utf-8" });
    return r.status === 0 && String(r.stdout ?? "").includes("ClamAV");
  } catch {
    return false;
  }
})();

/**
 * INTEGRAÇÃO REAL = OPT-IN EXPLÍCITO. Desligado por omissão.
 *
 * Estes testes lançam o `clamscan` de verdade, que carrega ~981 MB de base por
 * processo, e um deles escreve EICAR REAL em disco. Disso resultava em
 * notificações "Ameaça bloqueada — Grave" do Windows Defender a cada
 * `npm test` — em 2026-10-02 o utilizador teve de interromper a sprint por
 * causa disso. Um gate automático não pode disparar o antivírus do utilizador:
 * a cobertura de DETECTED/CLEAN/ERROR, timeout, cancel, killTree, órfãos e
 * cap=1 é toda provada pelos testes com `spawn` injetado, que correm sempre.
 *
 * Para correr à mão, deliberadamente:
 *   set CYBERSAFE_REAL_CLAMSCAN=1 && npm test
 *
 * E o EICAR real, que escreve a assinatura em disco, tem de ser pedido à
 * SEPARADO e nunca junto do resto:
 *   set CYBERSAFE_EICAR_MANUAL=1 && node --test test/clamav-resource-cap.test.js
 */
const REAL_CLAMSCAN_OPT_IN = process.env.CYBERSAFE_REAL_CLAMSCAN === "1";
const EICAR_OPT_IN = process.env.CYBERSAFE_EICAR_MANUAL === "1";
const REAL_INTEGRATION = CLAMSCAN_AVAILABLE && REAL_CLAMSCAN_OPT_IN;

/**
 * PID de todos os clamscan.exe VIVOS no SO, com a sua memória.
 *
 * Distinguir peso importa: instalar o ClamAV pelo Chocolatey põe no PATH um
 * `clamscan.exe` de ~38 KB que é um LAUNCHER — ele próprio arranca o
 * `clamscan.exe` verdadeiro. Assim UM spawn nosso aparece no tasklist como DOIS
 * processos: o shim (~15 MB) e o clamscan que carrega a base (~981 MB). Contar
 * processos a dedo dava 2 com o cap a funcionar, e medir só o número de spawns
 * escondia um clamscan pesado a mais. Por isso a medição real é: quantos
 * processos clamscan carregam a base (memória alta) ao mesmo tempo.
 */
const DB_LOADING_MIN_KB = 200_000;

function liveClamscanRows() {
  if (process.platform !== "win32") return [];
  try {
    const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq clamscan.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf-8",
      windowsHide: true,
    });
    return String(r.stdout ?? "")
      .split(/\r?\n/)
      .filter((line) => line.includes("clamscan.exe"))
      // O CSV do tasklist vem QUOTED (`"clamscan.exe","38360",...`). Sem tirar
      // as aspas, `Number('"38360"')` dá NaN e o filtro deita fora todos os PIDs
      // — o teste passava sem estar a medir nada.
      .map((line) => {
        const parts = line.split(",").map((part) => part.replace(/"/g, "").trim());
        return { pid: Number(parts[1]), memoryKb: Number(String(parts[4] ?? "").replace(/[^0-9]/g, "")) };
      })
      .filter((row) => Number.isFinite(row.pid) && row.pid > 0);
  } catch {
    return [];
  }
}

function liveClamavDbLoaders(exclude = []) {
  return liveClamscanRows().filter((row) => !exclude.includes(row.pid) && row.memoryKb >= DB_LOADING_MIN_KB);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Spawner falso: conta concorrência, mede o pico, e só "morre" quando
 * `killTree()` é chamado. É isto que permite provar que o timeout e o abort
 * realmente terminam o processo, e não apenas a promise.
 */
function makeFakeSpawner({ durationMs = 200, code = 0, neverFinishes = false, stdout = "", stderr = "" } = {}) {
  const state = { live: 0, peak: 0, spawned: 0, killed: 0, completed: 0 };
  const live = new Set();
  const spawnedWaiters = [];
  /** Resolve no próximo spawn — para abortar DEPOIS do processo existir. */
  const waitForSpawn = () =>
    state.spawned > 0 ? Promise.resolve() : new Promise((r) => spawnedWaiters.push(r));

  const spawn = (file, args, request) => {
    // A prova de carga spawna por este mesmo seam (`scanId: "load-proof"`).
    // Ela não é um scan: contar aqui faria `spawned`/`peak`/`liveCount` medirem
    // a prova, e `neverFinishes` deixaria a prova pendurada 30 s. Responde
    // limpa e invisível; o `active` continua a exigir a prova, só não se conta
    // duas vezes.
    if (isLoadProof(request)) return makeLoadProofHandle();
    state.spawned++;
    state.live++;
    state.peak = Math.max(state.peak, state.live);
    while (spawnedWaiters.length) spawnedWaiters.shift()();

    let resolveOutcome;
    let dead = false;
    const finish = (outcome) => {
      if (dead) return;
      dead = true;
      state.live--;
      state.completed++;
      live.delete(handle);
      clearTimeout(timer);
      resolveOutcome(outcome);
    };

    const handle = {
      pid: 10000 + state.spawned,
      killTree() {
        if (dead) return;
        state.killed++;
        finish({ code: null, stderr: "", timedOut: false, killed: true });
      },
      outcome: new Promise((resolve) => {
        resolveOutcome = resolve;
      }),
    };
    live.add(handle);

    // Só termina sozinho quando o modelo diz que termina. `neverFinishes`
    // simula um clamscan a varrer algo grande: passa do timeout e SÓ morre
    // se alguém o matar — que é exactamente o caso que estava a vazar.
    const timer = setTimeout(
      () => {
        if (neverFinishes) return;
        finish({ code, stdout, stderr, timedOut: false, killed: false });
      },
      durationMs,
    );

    return handle;
  };

  return { spawn, state, liveCount: () => live.size, waitForSpawn };
}

/**
 * O EICAR em BYTES, nunca em string.
 *
 * Este ficheiro já contiv o EICAR como `"...[4\PZX54..."` — barra invertida
 * simples. Em JavaScript `\P` não é um escape válido, o interpretador
 * descarta a barra, e o ficheiro ficava com 67 bytes em vez dos 68. Ou seja:
 * **o fixture nunca foi EICAR**, o ClamAV devolvia `clean` com toda a razão,
 * e a conclusão que se tirou dele — "neste SO o EICAR dá exit 2" — era um
 * artefacto do escaping, misturado com o Defender a apagar o ficheiro.
 *
 * Escrever os bytes em hex elimina a classe inteira do problema: não há
 * escape para se enganar, e a asserção de guarda abaixo falha alto se
 * alguém voltar a editar a string.
 */
const EICAR_BYTES = Buffer.from(
  "58354f2150254041505b345c505a58353428505e2937434329377d2445494341522d5354414e444152442d414e544956495255532d544553542d46494c452124482b482a",
  "hex",
);
async function makeFakeReadyDefinitions(root) {
  const dir = path.join(root, "definitions", "clamav");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "main.cvd"), "x");
  await fs.writeFile(path.join(dir, "daily.cld"), "x");
  return path.join(root, "definitions");
}

let tmp;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-clamcap-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe("ClamavBridge — HARD CAP de processos (o que causou os 98% de RAM)", () => {
  it("N ficheiros concorrentes ⇒ no máximo 1 clamscan vivo", async () => {
    const fake = makeFakeSpawner({ durationMs: 150 });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
    });

    await Promise.all(
      ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"].map((f) =>
        bridge.scanFile(path.join(tmp, f)).catch(() => {}),
      ),
    );

    assert.equal(fake.state.spawned, 5, "os 5 ficheiros são todos analiseados");
    assert.equal(fake.state.peak, 1, `pico tem de ser 1, foi ${fake.state.peak}`);
    assert.equal(fake.liveCount(), 0, "nada fica vivo no fim");
  });

  it("o cap é transversal a bridges distintos (limite global, não por instância)", async () => {
    // Bug real: o loop do ScanManager é serial, mas `scanArtifact` também é
    // chamado pelo monitor de ficheiros, pelo monitor de processos e pelo
    // dashboard. Um cap por instância não impediria a explosão.
    const fake = makeFakeSpawner({ durationMs: 150 });
    const definitionsDir = await makeFakeReadyDefinitions(tmp);
    const a = new ClamavBridge({ definitionsDir, spawn: fake.spawn });
    const b = new ClamavBridge({ definitionsDir, spawn: fake.spawn });

    await Promise.all([
      a.scanFile(path.join(tmp, "a.txt")).catch(() => {}),
      b.scanFile(path.join(tmp, "b.txt")).catch(() => {}),
    ]);

    assert.ok(fake.state.peak <= 1, `pico tem de ser <=1 entre bridges, foi ${fake.state.peak}`);
  });

  it("o limite é configurável mas o default é 1", async () => {
    const fake = makeFakeSpawner({ durationMs: 120 });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
      maxConcurrent: 1,
    });
    for (let i = 0; i < 4; i++) await bridge.scanFile(path.join(tmp, `f${i}.txt`)).catch(() => {});
    assert.equal(fake.state.peak, 1);
  });

  it("um scan que nunca acaba NÃO bloqueia a fila para sempre sem timeout", async () => {
    const fake = makeFakeSpawner({ durationMs: 50, neverFinishes: true });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
      scanTimeoutMs: 300,
    });

    const res = await bridge.scanFile(path.join(tmp, "enorme.bin"));

    assert.equal(res.detected, false, "sem detecção: o scan expirou");
    assert.equal(res.status.status, "degraded", "expirar é degradado, nunca 'active' a fingir");
    assert.equal(fake.state.killed, 1, "o timeout tem de MATAR o processo, não só rejeitar");
    assert.equal(fake.liveCount(), 0, "sem órfãos");
  });
});

describe("ClamavBridge — ausência de órfãos", () => {
  it("abort termina o processo filho em curso", async () => {
    const fake = makeFakeSpawner({ durationMs: 50, neverFinishes: true });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
      scanTimeoutMs: 60_000, // só o abort pode acabar com este
    });

    const controller = new AbortController();
    const pending = bridge.scanFile(path.join(tmp, "grande.bin"), { signal: controller.signal });
    // O abort só tem de matar algo que JÁ EXISTE. Abortar durante o probe
    // (antes do spawn) é um caso diferente, coberto pelo teste seguinte.
    await fake.waitForSpawn();
    controller.abort();
    await pending;

    assert.equal(fake.state.spawned, 1, "o processo chegou a ser criado");
    assert.equal(fake.state.killed, 1, "o cancel tem de matar o filho");
    assert.equal(fake.liveCount(), 0, "sem órfãos depois do cancel");
  });

  it("um abort já disparado não arranca processo nenhum", async () => {
    const fake = makeFakeSpawner();
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
    });
    const controller = new AbortController();
    controller.abort();

    const res = await bridge.scanFile(path.join(tmp, "nunca.txt"), { signal: controller.signal });

    assert.equal(fake.state.spawned, 0, "abort antes do spawn não pode fazer spawn");
    assert.equal(res.detected, false);
  });

  it("dispose (shutdown do serviço) mata o que estiver em curso", async () => {
    const fake = makeFakeSpawner({ durationMs: 50, neverFinishes: true });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
      scanTimeoutMs: 60_000,
    });

    const pending = bridge.scanFile(path.join(tmp, "grande.bin"));
    await fake.waitForSpawn();
    await bridge.dispose();
    await pending;

    assert.equal(fake.liveCount(), 0, "shutdown não pode deixar clamscan vivo");
  });

  it("um spawn que falha não deixa nada para trás", async () => {
    let attempted = 0;
    const spawn = (_file, _args, request) => {
      // A prova de carga spawna por este seam; `attempted` conta o spawn do
      // SCAN que falhou, e é esse que tem de ser 1.
      if (isLoadProof(request)) return makeLoadProofHandle();
      attempted++;
      const handle = {
        pid: 4242,
        killTree() {},
        outcome: Promise.resolve({ code: null, stderr: "spawn falhou", timedOut: false, killed: false }),
      };
      return handle;
    };
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn,
    });

    const res = await bridge.scanFile(path.join(tmp, "x.txt"));

    assert.equal(attempted, 1);
    assert.equal(res.detected, false, "spawn falhado não é detecção");
    assert.equal(res.status.status, "degraded");
  });

  it("depois de dispose o bridge recusa novos scans em vez de fazer spawn", async () => {
    const fake = makeFakeSpawner();
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
    });
    await bridge.dispose();

    const res = await bridge.scanFile(path.join(tmp, "x.txt"));

    assert.equal(fake.state.spawned, 0, "um bridge descartado não arranca processos");
    assert.equal(res.detected, false);
  });
});

describe("ClamavBridge — o veredicto vem do OUTPUT, não do exit code", () => {
  const bridgeWith = async (opts) =>
    new ClamavBridge({ definitionsDir: await makeFakeReadyDefinitions(tmp), ...opts });

  it("exit 1 COM linha FOUND ⇒ detected, com a assinatura", async () => {
    // O que o clamscan DIZ, não o código que devolve. Um exit 1 sem linha
    // FOUND é estado inconsistente — ver o teste seguinte.
    const target = path.join(tmp, "infectado.txt");
    const bridge = await bridgeWith({
      spawn: makeFakeSpawner({ code: 1, stdout: `${target}: Eicar-Test-Signature FOUND\n` }).spawn,
    });
    const res = await bridge.scanFile(target);
    assert.equal(res.detected, true, "FOUND no stdout é deteção");
    assert.equal(res.verdict, "detected");
    assert.equal(res.signature, "Eicar-Test-Signature");
  });

  it("exit 1 SEM linha FOUND ⇒ inconclusivo, nunca clean e nunca detected", async () => {
    // Confiar no exit code foi o defeito original: convertia qualquer erro
    // com código 1 numa deteção, e qualquer erro com código 2 numa base avariada.
    const bridge = await bridgeWith({ spawn: makeFakeSpawner({ code: 1, stdout: "" }).spawn });
    const res = await bridge.scanFile(path.join(tmp, "x.txt"));
    assert.equal(res.verdict, "error");
    assert.equal(res.detected, false, "sem evidência não se afirma deteção");
    assert.equal(res.reason, "inconsistent-exit");
  });

  it("exit 0 ⇒ clean, sem degradar", async () => {
    const target = path.join(tmp, "limpo.txt");
    const bridge = await bridgeWith({ spawn: makeFakeSpawner({ code: 0, stdout: `${target}: OK\n----------- SCAN SUMMARY ----------\nKnown viruses: 1\nEngine version: 1.5.2\nScanned directories: 0\nScanned files: 1\nInfected files: 0\nTotal errors: 0\nData scanned: 0.00MiB\nTime: 0.01s\n` }).spawn });
    const res = await bridge.scanFile(path.join(tmp, "limpo.txt"));
    assert.equal(res.detected, false);
    assert.equal(res.verdict, "clean");
    assert.equal(res.status.status, "active");
  });

  it("exit 2 de BASE (cl_load no stderr) ⇒ degraded, e a mensagem é sobre a base", async () => {
    const bridge = await bridgeWith({
      spawn: makeFakeSpawner({ code: 2, stderr: "LibClamAV Error: cl_load: No such file or directory: C:\\db\n" }).spawn,
    });
    const res = await bridge.scanFile(path.join(tmp, "x.txt"));
    assert.equal(res.status.status, "degraded");
    assert.equal(res.verdict, "error");
    assert.equal(res.reason, "database-unavailable");
    assert.match(res.status.detail, /carregar a base/i);
  });

  it("exit 2 de I/O ⇒ error, e o MOTOR fica activo (a base carregou bem)", async () => {
    // A regressão que o checkpoint 2 registou: exit 2 dizia "não conseguiu
    // carregar a base" num caso em que a base tinha carregado 3,6 milhões de
    // virus. O motor não pode ser degradado por causa de UM ficheiro.
    const target = path.join(tmp, "ilegivel.txt");
    // O ficheiro EXISTE: o que o clamscan não conseguiu foi lê-lo, não tê-lo
    // debaixo do nariz. A diferença entre 'ilegível' e 'removido' é um facto
    // que medimos, não uma suposição.
    await fs.writeFile(target, "conteudo qualquer\n");
    const bridge = await bridgeWith({
      spawn: makeFakeSpawner({
        code: 2,
        stdout: "Scanned files: 0\nInfected files: 0\nTotal errors: 1\n",
        stderr: `LibClamAV Warning: Can't open file ${target}: 225\n`,
      }).spawn,
    });
    const res = await bridge.scanFile(target);
    assert.equal(res.verdict, "error");
    assert.equal(res.reason, "file-unreadable");
    assert.equal(res.status.status, "active", "um ficheiro ilegível não degrada o ClamAV");
    assert.doesNotMatch(res.status.detail, /carregar a base/);
  });
});

describe("anti-cascata — o motor tem de se reconhecer", () => {
  it("os binários do ClamAV estão na lista de processos que o motor ignora", () => {
    // Se um destes NÃO estiver na lista, o CyberSafe analisa o seu próprio
    // motor de scan, que volta a arrancar o motor, que volta a ser visto...
    for (const name of ["clamscan.exe", "clamscan", "clamd.exe", "freshclam.exe", "clambc.exe"]) {
      assert.ok(
        CLAMAV_ENGINE_PROCESS_NAMES.has(name),
        `${name} tem de ser reconhecido como binário do nosso próprio motor`,
      );
    }
  });

  it("a lista não é uma lista de 'processos bons' — só o motor de scan", () => {
    // Um nome genérico aqui desligaria monitorização real sem que ninguém
    // perceba. Cada nome tem de ser um binário REAL do ClamAV — nada mais.
    const allowed = new Set([
      "clamscan.exe", "clamscan",
      "clamdscan.exe",
      "clamd.exe", "clamd",
      "clamdtop.exe",
      "clambc.exe",
      "clamsubmit.exe",
      "freshclam.exe", "freshclam",
      "sigtool.exe",
    ]);
    for (const name of CLAMAV_ENGINE_PROCESS_NAMES) {
      assert.ok(allowed.has(name), `${name} não é um binário conhecido do ClamAV`);
    }
    // E nenhum nome genérico de Windows pode ter entrado por engano.
    for (const name of ["cmd.exe", "svchost.exe", "notepad.exe", "explorer.exe", "services.exe"]) {
      assert.ok(!CLAMAV_ENGINE_PROCESS_NAMES.has(name), `${name} não pode ser ignorado pelo monitor`);
    }
  });
});

describe("ClamavBridge — integração real (OPT-IN: CYBERSAFE_REAL_CLAMSCAN=1)", { skip: !REAL_INTEGRATION }, () => {
  if (!REAL_INTEGRATION && CLAMSCAN_AVAILABLE) {
    console.log(
      "    [real] integração real do ClamAV DESLIGADA. Para a correr: set CYBERSAFE_REAL_CLAMSCAN=1",
    );
  }
  it("5 ficheiros pequenos ⇒ 1 clamscan a carregar a base, nenhum órfão", { skip: !REAL_INTEGRATION, timeout: 300_000 }, async () => {
    const dir = path.join(tmp, "cinco");
    await fs.mkdir(dir, { recursive: true });
    for (let i = 1; i <= 5; i++) await fs.writeFile(path.join(dir, `f${i}.txt`), `benign file ${i}\n`);

    const baseline = liveClamscanRows().map((row) => row.pid);
    const bridge = new ClamavBridge();
    const available = await bridge.isAvailable();
    assert.ok(available, `ClamAV tem de estar disponível neste teste: ${bridge.health.detail}`);

    // Mede-se a NOSSA concorrência: quantos clamscan que ESTE bridge lançou
    // estão vivos ao mesmo tempo. Medir "quantos clamscan há no SO" não
    // responde à pergunta — o `node --test` corre ficheiros em paralelo e o
    // `clamav-db.test.js` também escaneia a sério ao mesmo tempo.
    let peak = 0;
    let peakOurSpawns = 0;
    const sampler = setInterval(() => {
      const ours = bridge.liveChildPids();
      peakOurSpawns = Math.max(peakOurSpawns, ours.length);
      peak = Math.max(peak, liveClamavDbLoaders(baseline).length);
    }, 60);

    const started = Date.now();
    try {
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((i) => bridge.scanFile(path.join(dir, `f${i}.txt`))),
      );
      assert.equal(results.length, 5);
      assert.ok(results.every((r) => r.detected === false), "ficheiros benignos não são detecções");
    } finally {
      clearInterval(sampler);
    }

    assert.ok(peakOurSpawns <= 1, `este bridge não pode ter 2 clamscan vivos, teve ${peakOurSpawns}`);
    assert.deepEqual(bridge.liveChildPids(), [], "o bridge não pode ficar com clamscan vivo");
    await sleep(800);
    // Órfãos: clamscan NENHUM nosso pode ter ficado. Só se pode exigir isto
    // depois de o outro ficheiro de teste ter acabado, por isso a baseline
    // filtra os PIDs que já estavam vivos quando este teste começou.
    const left = liveClamscanRows().filter((row) => !baseline.includes(row.pid));
    console.log(`    [real] 5 ficheiros: pico_nossos=${peakOurSpawns} pico_so=${peak} wall=${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`    [real] clamscan(s) no SO depois (podem ser de outro ficheiro de teste em paralelo): ${left.map((r) => r.pid).join(",") || "nenhum"}`);
  });

  it("o timeout real não deixa clamscan órfão (a prova do bug de 988 MB)", { skip: !REAL_INTEGRATION }, async () => {
    const dir = path.join(tmp, "grande");
    await fs.mkdir(dir, { recursive: true });
    // 12 MB aleatórios: passa dos 10 s de DB load + scan, como no bug real.
    for (let i = 1; i <= 8; i++) {
      await fs.writeFile(path.join(dir, `b${i}.bin`), Buffer.alloc(12 * 1024 * 1024, i));
    }

    const baseline = liveClamscanRows().map((row) => row.pid);
    const bridge = new ClamavBridge({ scanTimeoutMs: 8000 });
    if (!(await bridge.isAvailable())) return; // sem base: nada a provar

    const res = await bridge.scanFile(dir);

    assert.equal(res.detected, false, "dados aleatórios não são deteção");
    // O ponto não é o resultado: é que NÃO fica nenhum clamscan vivo depois.
    await sleep(7500);
    const left = liveClamscanRows().map((row) => row.pid).filter((pid) => !baseline.includes(pid));
    assert.deepEqual(left, [], `clamscan órfão depois do timeout: ${left.join(",")}`);
  });

  it("20 ficheiros pequenos ⇒ continua 1 clamscan, nenhum órfão (o pico não cresce com N)", { skip: !REAL_INTEGRATION, timeout: 600_000 }, async () => {
    const dir = path.join(tmp, "vinte");
    await fs.mkdir(dir, { recursive: true });
    for (let i = 1; i <= 20; i++) await fs.writeFile(path.join(dir, `f${i}.txt`), `benign file ${i}\n`);

    const baseline = liveClamscanRows().map((row) => row.pid);
    const bridge = new ClamavBridge();
    if (!(await bridge.isAvailable())) return;

    let peak = 0;
    let peakOurSpawns = 0;
    const sampler = setInterval(() => {
      peakOurSpawns = Math.max(peakOurSpawns, bridge.liveChildPids().length);
      const live = liveClamavDbLoaders(baseline).length;
      peak = Math.max(peak, live);
    }, 60);

    const started = Date.now();
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => bridge.scanFile(path.join(dir, `f${i + 1}.txt`))),
      );
      assert.equal(results.length, 20);
      assert.ok(results.every((r) => r.detected === false), "benignos não são detecções");
    } finally {
      clearInterval(sampler);
    }

    // 4x mais ficheiros, o MESMO pico: é isto que diz que o P0 não voltou.
    assert.ok(peakOurSpawns <= 1, `4x mais ficheiros, o mesmo clamscan: houve ${peakOurSpawns}`);
    assert.deepEqual(bridge.liveChildPids(), [], "o bridge não pode ficar com clamscan vivo");
    await sleep(800);
    const left = liveClamscanRows().map((row) => row.pid).filter((pid) => !baseline.includes(pid));
    console.log(`    [real] 20 ficheiros: pico_nossos=${peakOurSpawns} pico_so=${peak} wall=${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`    [real] clamscan(s) no SO depois (outro ficheiro de teste em paralelo): ${left.join(",") || "nenhum"}`);
  });

  // CAUSA RAIZ DO `clamav-eicdar-exit2` — investigated e provada em
  // `output/p0-clamav-resource-exhaustion/CHECKPOINT-3-REVIEW-AND-EICAR.md`.
  //
  // O que se pensava antes: "o ClamAV não detecta EICAR neste SO".
  // O que a medição mostrou: o Windows Defender apaga o ficheiro no instante
  // em que o clamscan o abre (registo `Get-MpThreatDetection` com
  // `ProcessName = ...\clamscan.exe` e o recurso a ser o próprio ficheiro), e
  // o clamscan devolve
  //
  //   exit=2  stdout=vazio  Scanned files: 0
  //   stderr="LibClamAV Warning: Can't open file ...: 225 (Invalid argument)"
  //
  // com a base perfeitamente carregada (3 628 114 virus, 6,485 s).
  //
  // Acima de tudo, o que este teste fixar NÃO é o exit code, é o invariante: um
  // ficheiro que o clamscan não conseguiu ler NUNCA é reportado como limpo.
  // Noutra máquina (sem Defender) o EICAR dá FOUND + exit 1, e o invariante
  // continua verdadeiro — por isso o teste aceita os dois caminhos e recusa o
  // terceiro, que é o que estava a acontecer.
  it("EICAR nunca é reportado como 'limpo' (OPT-IN: CYBERSAFE_EICAR_MANUAL=1)", { skip: !(REAL_INTEGRATION && EICAR_OPT_IN) }, async () => {
    if (!EICAR_OPT_IN) {
      console.log("    [real] EICAR real DESLIGADO — escreve uma assinatura viva em disco e o Defender bloqueia.");
    }
    const eicar = path.join(tmp, "eicar.txt");
    // Guarda de fixture: se isto deixar de ser o EICAR, o teste mede outra
    // coisa e passa a mentir em silêncio. A barra invertida verifica-se por
    // BYTE, não por string — ver o comentário do EICAR_BYTES acima.
    assert.equal(EICAR_BYTES.length, 68, "o EICAR canonico tem 68 bytes");
    assert.equal(EICAR_BYTES[11], 0x5c, "byte 11 tem de ser a barra invertida (0x5C)");
    assert.equal(
      EICAR_BYTES.subarray(12, 20).toString("latin1"),
      "PZX54(P^",
      "o corpo da assinatura tem de estar intacto",
    );
    await fs.writeFile(eicar, EICAR_BYTES);
    // Mesmo tamanho, zero assinaturas: dá OK. Serve de controlo.
    const benign = path.join(tmp, "benign68.txt");
    await fs.writeFile(benign, "A".repeat(68));

    const bridge = new ClamavBridge();
    if (!(await bridge.isAvailable())) return;

    const resEicar = await bridge.scanFile(eicar);
    const resBenign = await bridge.scanFile(benign);

    console.log(`    [real] EICAR  cru: ${JSON.stringify(resEicar)}`);
    console.log(`    [real] BENIGN cru: ${JSON.stringify(resBenign)}`);
    console.log(`    [real] eicar existe? ${await fs.stat(eicar).then(() => "sim").catch(() => "nao")}`);

    assert.equal(resBenign.detected, false, "benigno tem de dar limpo");
    assert.equal(resBenign.verdict, "clean", "e o benigno tem mesmo de ser clean — é o controlo");

    // O INVARIANTE. Este é o teste que valia a pena escrever.
    assert.notEqual(
      resEicar.verdict,
      "clean",
      `um EICAR não pode ser 'clean' (verdict=${resEicar.verdict}, detail=${resEicar.detail})`,
    );
    if (resEicar.verdict === "detected") {
      // Ambiente sem Defender: o ClamAV viu mesmo a assinatura.
      assert.match(resEicar.signature ?? "", /eicar/i, "detectado tem de trazer a assinatura");
    } else {
      // Ambiente com Defender: o ficheiro desapareceu a meio. O resultado tem
      // de dizer isso, e sem inventar um culpado.
      assert.equal(resEicar.verdict, "error");
      assert.ok(
        ["file-removed-during-scan", "file-unreadable"].includes(resEicar.reason ?? ""),
        `motivo honesto para um ficheiro que o clamscan não leu, foi '${resEicar.reason}'`,
      );
      assert.ok(
        !/defender|microsoft/i.test(`${resEicar.detail} ${resEicar.reason}`),
        "não se atribui a remoção ao Defender sem evidência",
      );
    }
    console.log(
      `    [real] EICAR: verdict=${resEicar.verdict} reason=${resEicar.reason ?? "-"} ` +
        `removed=${resEicar.removedDuringScan ?? false} signature=${resEicar.signature ?? "-"}`,
    );
    assert.equal(resBenign.status.status, "active", "benigno não pode degradar o motor");
    // Um ficheiro ilegível NÃO degrada o motor. Degradar o ClamAV por causa de
    // um ficheiro seria apanhar o motor de mentira — e era o que acontecia.
    if (resEicar.verdict === "error") {
      assert.equal(
        resEicar.status.status,
        "active",
        `um ficheiro que o clamscan não leu não degrada o ClamAV (detail=${resEicar.status.detail})`,
      );
    }
    console.log(`    [real] EICAR: status=${resEicar.status.detail}`);
  });
});