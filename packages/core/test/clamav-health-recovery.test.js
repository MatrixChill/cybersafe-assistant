import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClamavBridge } from "../dist/index.js";

/**
 * RECUPERAÇÃO DO ESTADO DO MOTOR (bug pegajoso) — regressão do fix.
 *
 * MEDIDO (2026-10-16, determinístico, sem carga): um batch que PROVA que a base
 * foi carregada e que todos os ficheiros obtiveram veredicto (clean/detected,
 * com exit válido) deixava o motor preso em `degraded` — `_health` só era
 * reescrito quando o batch NÃO era active (clamav.ts, hoje "if
 * (batch.status.status !== 'active')"). Após a correção, evidência positiva
 * devolve o motor a `active` NA MESMA INSTÂNCIA de bridge.
 *
 * Guardas exigidas (não podem recuperar): timeout→(exit 3221225794 / startup),
 * aborts, e batches sem veredicto por ficheiro — mesmo que `batch.status` seja
 * `active` com "N de M ficheiro(s) sem veredicto".
 *
 * O spawn é o seam de teste do core (nunca usado em produção); a sonda de
 * disponibilidade continua a correr contra a base falsa pronta (como nos
 * restantes testes do clamav).
 */

/**
 * O spawner roteia por TIPO de chamada. Com a prova de carga ligada por omissão
 * (produção), a PRIMEIRA chamada é a prova, não o batch: um guião sequencial
 * entregava ao batch o outcome da prova (e vice-versa). Aqui a prova recebe
 * sempre um `clean` do ficheiro de fixture, e os guiões do teste ficam para os
 * batches — o contrato testado (health e budgets) volta a ser o do batch.
 */
const LOAD_PROBE_DIR = "cybersafe-clamav-load-probe-";
const isLoadProofCall = (args) => (args ?? []).some((a) => a.includes(LOAD_PROBE_DIR));

function makeScriptedSpawner(scripts, options = {}) {
  const state = { spawned: 0, timeoutsSeen: [], batchTimeouts: [], loadProofTimeouts: [] };
  let index = 0;
  const spawn = (_file, args, request) => {
    const loadProof = isLoadProofCall(args);
    state.timeoutsSeen.push(request?.timeoutMs);
    (loadProof ? state.loadProofTimeouts : state.batchTimeouts).push(request?.timeoutMs);
    const script = loadProof
      ? (options.loadProof ?? { outcome: (targets) => cleanOutcome(targets.slice(-1)) })
      : scripts[Math.min(index, scripts.length - 1)];
    if (!loadProof) index++;
    state.spawned++;
    const targets = (args ?? []).filter((a) => !a.startsWith("-"));
    const handle = {
      pid: 40000 + state.spawned,
      killTree: script.killTree ?? (() => {}),
      outcome: new Promise((resolve) => {
        setTimeout(() => resolve(script.outcome(targets)), script.resolveDelayMs ?? 0);
      }),
    };
    return handle;
  };
  return { spawn, state };
}

function summary(count) {
  return [
    "----------- SCAN SUMMARY -----------",
    "Known viruses: 3628114",
    "Engine version: 1.5.4",
    "Scanned directories: 0",
    `Scanned files: ${count}`,
    "Infected files: 0",
    "Data scanned: 0.00 MB",
    "Time: 0.001 sec (0 m 0 s)",
  ].join("\n");
}

const cleanOutcome = (targets) => ({
  code: 0,
  stdout: targets.map((t) => `${t}: OK`).join("\n") + "\n" + summary(targets.length),
  stderr: "",
  timedOut: false,
  killed: false,
});

// Timeout real do deadline: o killTree não confirma (o outcome resolve depois,
// como o spawn verdadeiro faz) — produz reason "timeout" e motor degraded.
const timeoutScript = {
  resolveDelayMs: 250,
  killTree: () => {},
  outcome: () => ({ code: null, stdout: "", stderr: "", timedOut: true, killed: true }),
};

const startupFailScript = {
  killTree: () => {},
  outcome: () => ({ code: 3221225794, stdout: "", stderr: "", timedOut: false, killed: false }),
};

const abortedScript = {
  killTree: () => {},
  outcome: () => ({ code: null, stdout: "", stderr: "", timedOut: false, killed: true }),
};

// Exit 50 com UM ficheiro nomeado e outro sem veredicto: batch "active" com
// "N de M ficheiro(s) sem veredicto" — não é evidência positiva.
const noVerdictScript = {
  killTree: () => {},
  outcome: (targets) => ({ code: 50, stdout: `${targets[0]}: OK\n`, stderr: "", timedOut: false, killed: false }),
};

async function makeFakeReadyDefinitions(root, { staleMs = 0 } = {}) {
  const dir = path.join(root, "definitions", "clamav");
  await fs.mkdir(dir, { recursive: true });
  const main = path.join(dir, "main.cvd");
  const daily = path.join(dir, "daily.cld");
  await fs.writeFile(main, "x");
  await fs.writeFile(daily, "x");
  if (staleMs > 0) {
    const past = new Date(Date.now() - staleMs);
    await fs.utimes(main, past, past);
    await fs.utimes(daily, past, past);
  }
  return path.join(root, "definitions");
}

async function makeScenario(scripts, { staleMs = 0 } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-health-"));
  const target = path.join(tmp, "alvo.txt");
  await fs.writeFile(target, "benigno\n");
  const fake = makeScriptedSpawner(scripts);
  const bridge = new ClamavBridge({
    definitionsDir: await makeFakeReadyDefinitions(tmp, { staleMs }),
    spawn: fake.spawn,
    scanTimeoutMs: 60,
  });
  return { tmp, target, fake, bridge };
}

let scenario;
afterEach(async () => {
  await fs.rm(scenario.tmp, { recursive: true, force: true }).catch(() => {});
});

describe("recuperação do estado do motor — evidência positiva devolve active", () => {
  it("timeout -> batch limpo (mesma instância) recupera o motor", async () => {
    scenario = await makeScenario([timeoutScript, { killTree: () => {}, outcome: cleanOutcome }]);
    const { bridge, target } = scenario;

    const a = await bridge.scanFiles([target]);
    assert.equal(a.status.status, "degraded", "timeout degrada o motor");
    assert.equal(bridge.health.status, "degraded");

    const b = await bridge.scanFiles([target]);
    assert.equal(b.status.status, "active", "batch limpo com veredicto por ficheiro");
    assert.equal(
      bridge.health.status,
      "active",
      "evidência positiva comprovada deve devolver o motor a active (bug pegajoso)",
    );
  });

  it("timeout -> batch com deteção atribuída (exit 1) também recupera", async () => {
    scenario = await makeScenario([
      timeoutScript,
      {
        killTree: () => {},
        outcome: (targets) => ({
          code: 1,
          stdout: targets.map((t) => `${t}: Eicar-Test-Signature FOUND`).join("\n") + "\n" + "Infected files: 1\n",
          stderr: "",
          timedOut: false,
          killed: false,
        }),
      },
    ]);
    const { bridge, target } = scenario;

    await bridge.scanFiles([target]);
    assert.equal(bridge.health.status, "degraded");

    const b = await bridge.scanFiles([target]);
    assert.equal(b.detected, true);
    assert.equal(b.files[0].verdict, "detected");
    assert.equal(bridge.health.status, "active", "deteção atribuída é evidência positiva");
  });
});

describe("orçamento do batch — contrato do default novo vs override antigo", () => {
  // Sem `scanTimeoutMs`: estes casos exercitam o DEFAULT real (o makeScenario
  // usa 60 ms para os testes de timeout/deadline — aqui não).
  const makeShared = async () => {
    scenario = await makeScenario([{ killTree: () => {}, outcome: cleanOutcome }]);
    const { tmp, fake } = scenario;
    const bridge = new ClamavBridge({ definitionsDir: path.join(tmp, "definitions"), spawn: fake.spawn });
    return { ...scenario, bridge };
  };

  it("default N=1 => 20 s (startup 10 s + 10 s por ficheiro)", async () => {
    const { bridge, target, fake } = await makeShared();
    await bridge.scanFiles([target]);
    assert.equal(fake.state.batchTimeouts[0], 20_000);
  });

  it("default N=2 => 30 s", async () => {
    const { bridge, target, tmp, fake } = await makeShared();
    const segundo = path.join(tmp, "segundo.txt");
    await fs.writeFile(segundo, "b\n");
    await bridge.scanFiles([target, segundo]);
    assert.equal(fake.state.batchTimeouts[0], 30_000);
  });

  it("override explícito 60 ms mantém o contrato antigo: N × override (2 × 60)", async () => {
    scenario = await makeScenario([{ killTree: () => {}, outcome: cleanOutcome }]);
    const { tmp, target, fake } = scenario;
    const segundo = path.join(tmp, "segundo.txt");
    await fs.writeFile(segundo, "b\n");
    const bridge2 = new ClamavBridge({
      definitionsDir: path.join(tmp, "definitions"),
      spawn: fake.spawn,
      scanTimeoutMs: 60,
    });
    await bridge2.scanFiles([target, segundo]);
    assert.equal(fake.state.batchTimeouts[0], 120);
  });

  it("cap 600 s aplica-se também ao default (N grande)", async () => {
    const { bridge, tmp, fake } = await makeShared();
    const muitos = Array.from({ length: 60 }, (_, i) => path.join(tmp, `f${i}.txt`));
    await bridge.scanFiles(muitos);
    assert.equal(fake.state.batchTimeouts[0], 600_000, "10 s + 60 × 10 s = 610 s => cap 600 s");
  });
});

describe("recuperação do estado do motor — guardas (NÃO recupera)", () => {
  it("timeout -> processo que falha a arrancar (3221225794) NÃO recupera", async () => {
    scenario = await makeScenario([timeoutScript, startupFailScript]);
    const { bridge, target } = scenario;

    await bridge.scanFiles([target]);
    assert.equal(bridge.health.status, "degraded");

    const b = await bridge.scanFiles([target]);
    assert.equal(b.status.status, "active", "exit-code é reportado por ficheiro, não como degradação nova");
    assert.equal(bridge.health.status, "degraded", "startup falhado sem veredicto não é evidência positiva");
  });

  it("timeout -> abort NÃO recupera", async () => {
    scenario = await makeScenario([timeoutScript, abortedScript]);
    const { bridge, target } = scenario;

    await bridge.scanFiles([target]);
    assert.equal(bridge.health.status, "degraded");

    await bridge.scanFiles([target]);
    assert.equal(bridge.health.status, "degraded", "abort não é evidência positiva");
  });

  it("timeout -> exit 50 com ficheiro sem veredicto NÃO recupera", async () => {
    scenario = await makeScenario([timeoutScript, noVerdictScript]);
    const { bridge, target, tmp } = scenario;
    const segundo = path.join(tmp, "segundo.txt");
    await fs.writeFile(segundo, "benigno 2\n");

    await bridge.scanFiles([target]);
    assert.equal(bridge.health.status, "degraded");

    const b = await bridge.scanFiles([target, segundo]);
    assert.equal(b.status.status, "active", "exit-code por ficheiro não é degradação nova");
    assert.match(b.status.detail, /sem veredicto/, "batch active mas sem veredicto por ficheiro");
    assert.equal(bridge.health.status, "degraded", "batch.active sozinho não é evidência positiva");
  });

  it("base EXPIRADA no probe -> batch limpo conserva degraded (a base não fica fresca por analisar)", async () => {
    // Definições com 30 dias (> janela de 7 dias): o probe classifica-as
    // expiradas, mas `_hasSignatures` continua true e o scan é permitido.
    // Um batch limpo NÃO torna a base fresca: a saúde da base tem de pesar.
    scenario = await makeScenario([{ killTree: () => {}, outcome: cleanOutcome }], {
      staleMs: 30 * 24 * 60 * 60 * 1000,
    });
    const { bridge, target } = scenario;

    const available = await bridge.isAvailable();
    assert.equal(available, false, "o probe não declara disponível uma base expirada");
    assert.equal(bridge.health.status, "degraded", "o probe classifica a base como expirada");
    assert.match(bridge.health.detail, /freshclam/, "e diz o que fazer");

    const b = await bridge.scanFiles([target]);
    assert.equal(b.status.status, "active", "o batch em si está limpo");
    assert.equal(
      bridge.health.status,
      "degraded",
      "batch limpo com base expirada NÃO pode recuperar o motor (DB stale)",
    );
  });
});


describe("POST017 — recuperação após falha transitória da prova de carga", () => {
  it("prova com timeout não contamina permanentemente a frescura da base; batch posterior comprovado recupera", async () => {
    scenario = await makeScenario([{ outcome: cleanOutcome }]);
    const fake = makeScriptedSpawner([{ outcome: cleanOutcome }], {
      loadProof: { resolveDelayMs: 35, killTree: () => {}, outcome: () => ({code:null,stdout:"",stderr:"",timedOut:true,killed:true}) },
    });
    const bridge = new ClamavBridge({ definitionsDir: path.join(scenario.tmp,"definitions"), spawn: fake.spawn, probeTimeoutMs: 10, scanTimeoutMs: 100, loadProofEnabled: true });
    assert.equal(await bridge.isAvailable(), false);
    assert.equal(bridge.health.status, "degraded");
    const later = await bridge.scanFile(scenario.target);
    assert.equal(later.verdict, "clean", "resultado positivo real do parser, não indicador fabricado");
    assert.equal(bridge.health.status, "active", "base fresca + batch comprovado recuperam após timeout da prova");
    assert.equal(await bridge.isAvailable(), true, "a disponibilidade cacheada acompanha a recuperação comprovada");
    await bridge.dispose();
  });
});

describe("POST017 — falhas transitórias repetidas",()=>{
 it("nova prova falhada volta a degradar honestamente e um batch positivo volta a recuperar",async()=>{
  scenario=await makeScenario([{outcome:cleanOutcome}]);
  const fake=makeScriptedSpawner([{outcome:cleanOutcome}],{loadProof:{resolveDelayMs:35,killTree:()=>{},outcome:()=>({code:null,stdout:"",stderr:"",timedOut:true,killed:true})}});
  const bridge=new ClamavBridge({definitionsDir:path.join(scenario.tmp,"definitions"),spawn:fake.spawn,probeTimeoutMs:10,scanTimeoutMs:100,loadProofEnabled:true});
  try {for(let i=0;i<2;i++){assert.equal(await bridge.isAvailable(true),false);assert.equal(bridge.health.status,"degraded");assert.equal((await bridge.scanFile(scenario.target)).verdict,"clean");assert.equal(bridge.health.status,"active");assert.equal(await bridge.isAvailable(),true)}}finally{await bridge.dispose()}
 });
});

describe("POST017 — diagnóstico opt-in do deadline real da bridge",()=>{
 it("identifica budget, origem e pedido de terminação sem publicar alvo; posterior batch positivo recupera",async()=>{
  scenario=await makeScenario([{outcome:cleanOutcome}]);
  const fake=makeScriptedSpawner([{resolveDelayMs:35,outcome:cleanOutcome},{outcome:cleanOutcome}]);
  const bridge=new ClamavBridge({definitionsDir:path.join(scenario.tmp,"definitions"),spawn:fake.spawn,scanTimeoutMs:10,loadProofEnabled:false});
  const originalLog=console.log,old=process.env.CYBERSAFE_DEBUG_SCAN,records=[];
  console.log=(...args)=>{const line=args.join(" ");if(line.includes("CLAMAV_BATCH_TIMEOUT"))records.push(line)};
  process.env.CYBERSAFE_DEBUG_SCAN="1";
  try {
   const first=await bridge.scanFile(scenario.target);assert.equal(first.verdict,"error");assert.equal(bridge.health.status,"degraded");
   assert.equal(records.length,1);assert.match(records[0],/origin=batch-background/);assert.match(records[0],/budgetMs=10/);assert.match(records[0],/termination=requested/);assert.equal(records[0].includes(scenario.target),false);
   assert.equal((await bridge.scanFile(scenario.target)).verdict,"clean");assert.equal(bridge.health.status,"active");
  }finally{console.log=originalLog;if(old===undefined)delete process.env.CYBERSAFE_DEBUG_SCAN;else process.env.CYBERSAFE_DEBUG_SCAN=old;await bridge.dispose()}
 });
});
