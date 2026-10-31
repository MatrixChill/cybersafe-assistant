import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ProtectionEngineService } from "../dist/engine.js";

/**
 * C4 — QA INDEPENDENTE DA "OPCAO A" (contrato P0 GUI-TEST-18/19, transferencia 15/10).
 *
 * Prende, com duplos BENIGNOS (nenhuma API do Windows, nenhum motor real, nenhuma
 * pasta pessoal), o contrato que o titular ratificou:
 *
 *   1. `startProtection()` NUNCA inicia o filtro WFP. O `WfpFilter.start()` cria
 *      regras de firewall (operacao privilegiada) e o `stop()` removeria a regra:
 *      um clique em "ligar protecao" nao pode alterar o Windows. O filtro de rede
 *      fica em DEGRADACAO EXPLICITA e permanente ate haver provisionamento
 *      privilegiado separado — e essa degradacao tem de ser DITA, nao silenciada.
 *   2. watcher/processMonitor/etwConsumer/amsiProvider continuam FATAIS: qualquer
 *      um a falhar => ok:false + teardown de TODOS + causa saneada ate a UI.
 *   3. Um arranque falhado nao deixa handles, timers nem transicao pendurada.
 *   4. Ligar a protecao mata uma pausa agendada (uma protecao ligada nao pode
 *      trazer consigo uma retomada pendente); parar liberta os recursos.
 *
 * ── NOTA DE ARTEFACTO (le isto antes de interpretar um RED) ──────────────────
 * Este ficheiro importa `../dist/engine.js`, como o resto da suite. O
 * `src/engine.ts` NAO e' importavel pelo Node: os seus imports relativos usam a
 * extensao `.js`, que so existe em `dist/` — MEDIDO:
 *   ERR_MODULE_NOT_FOUND | Cannot find module '.../packages/service/src/native-engine-bridge.js'
 * Logo o resultado vale para o BUILD que estiver em `dist/`, nao para o source
 * vivo. Se `src/` estiver mais recente do que `dist/`, um RED aqui e' um
 * artefacto de compilacao (gate por compilar), nao uma prova de defeito: correr
 * `npm run build -w @cybersafe/service` e repetir antes de julgar.
 *
 * Nao se chama `init()`: o motor corre sem watcher/ETW/AMSI reais, como em
 * `protection-pause-timers.test.js` e `shutdown.test.js`.
 */

const TEST_BASE_DIR = mkdtempSync(path.join(os.tmpdir(), "cybersafe-c4-option-a-"));

let engine = null;

/** Duplos benignos: registam chamadas e impedem qualquer efeito no Windows. */
function montarDuplos(e) {
  const chamadas = [];
  for (const nome of ["watcher", "processMonitor", "etwConsumer", "amsiProvider", "wfpFilter"]) {
    e[nome].start = async () => {
      chamadas.push(`${nome}.start`);
    };
    e[nome].stop = async () => {
      chamadas.push(`${nome}.stop`);
    };
  }
  // Nada de WMI/PowerShell/rede no caminho de sucesso (fire-and-forget incluido).
  e.processMonitor.list = async () => [];
  e.refreshConnections = async () => {};
  e.hardware.getSnapshot = async () => ({});
  e.updater.startScheduler = () => {
    chamadas.push("updater.startScheduler");
  };
  e.updater.stopScheduler = () => {
    chamadas.push("updater.stopScheduler");
  };
  return chamadas;
}

function freshEngine() {
  engine = new ProtectionEngineService(TEST_BASE_DIR);
  return engine;
}

function vivo(timer) {
  return timer !== null && timer !== undefined;
}

afterEach(async () => {
  if (engine) {
    await engine.dispose().catch(() => {});
    engine = null;
  }
});

test("ativacao: o filtro WFP NUNCA arranca (zero alteracoes do Windows no clique)", async () => {
  const e = freshEngine();
  const chamadas = montarDuplos(e);

  const r = await e.startProtection();

  assert.equal(r.ok, true, "a ativacao com duplos benignos tinha de subir");
  assert.equal(
    chamadas.includes("wfpFilter.start"),
    false,
    `o WFP nao pode ser iniciado na ativacao (chamadas: ${chamadas.join(", ") || "(nenhuma)"})`,
  );
  assert.equal(
    chamadas.includes("wfpFilter.stop"),
    false,
    "nem se para um filtro que nunca chegou a arrancar",
  );
  // Controlo: os quatro subsistemas FATAIS tem de arrancar na mesma, senao o
  // teste passaria a' custa de nao ligar nada.
  for (const nome of ["watcher", "processMonitor", "etwConsumer", "amsiProvider"]) {
    assert.equal(chamadas.includes(`${nome}.start`), true, `${nome} tinha de arrancar`);
  }
});

test("ativacao: a degradacao do WFP e' DECLARADA (real, nao 'tudo bem')", async () => {
  const e = freshEngine();
  montarDuplos(e);

  const r = await e.startProtection();

  assert.equal(r.ok, true);
  const wfp = (r.degraded ?? []).find((d) => d.label === "wfpFilter");
  assert.ok(
    wfp,
    `a ativacao tem de declarar o wfpFilter degradado (recebido: ${JSON.stringify(r.degraded ?? null)})`,
  );
  assert.match(
    wfp.reason,
    /Windows/i,
    "o motivo tem de dizer ao utilizador que nada foi alterado no Windows",
  );
  assert.equal(
    (r.degraded ?? []).some((d) => d.label === "watcher"),
    false,
    "um subsistema que arrancou bem nao pode aparecer como degradado",
  );
});

test("falha fatal: OFF + teardown de TODOS, sem transicao pendurada nem timers vivos", async () => {
  const e = freshEngine();
  const chamadas = montarDuplos(e);
  e.watcher.start = async () => {
    throw new Error("watcher indisponivel");
  };

  const r = await e.startProtection();

  assert.equal(r.ok, false, "uma falha fatal nao pode devolver sucesso");
  assert.equal(r.protectionEnabled, false);
  assert.equal(r.failures?.[0]?.label, "watcher");
  assert.equal(e.protectionState, false, "o motor nao pode ficar 'ligado' depois de falhar");
  assert.equal(
    e.protectionTransition ?? null,
    null,
    "a transicao tem de ser libertada (senao o proximo arranque pendura)",
  );
  for (const nome of ["watcher", "processMonitor", "etwConsumer", "amsiProvider", "wfpFilter"]) {
    assert.equal(
      chamadas.includes(`${nome}.stop`),
      true,
      `${nome} tinha de ser desmontado no teardown (chamadas: ${chamadas.join(", ") || "(nenhuma)"})`,
    );
  }
  assert.equal(vivo(e.networkTimer), false, "nenhum intervalo de rede pode sobreviver ao teardown");
  assert.equal(vivo(e.protectionResumeTimer), false, "nenhuma retomada agendada pode sobreviver ao teardown");
});

test("o motivo da falha chega a UI sem caminhos pessoais", async () => {
  const e = freshEngine();
  montarDuplos(e);
  e.watcher.start = async () => {
    throw new Error("nao consegui abrir C:\\Users\\utilizadordeteste\\AppData\\Local\\alguma-coisa");
  };

  const r = await e.startProtection();

  assert.equal(r.ok, false);
  const motivo = r.failures?.[0]?.reason ?? "";
  assert.equal(
    motivo.includes("utilizadordeteste"),
    false,
    `o motivo nao pode levar o nome do utilizador para a UI: ${motivo}`,
  );
  assert.match(motivo, /<utilizador>/, "o caminho pessoal tinha de ser substituido");
});

test("ligar mata a pausa; parar liberta os recursos (sem estado falso)", async () => {
  const e = freshEngine();
  const chamadas = montarDuplos(e);

  await e.pauseProtection(15 * 60_000);
  assert.equal(vivo(e.protectionResumeTimer), true, "pre-condicao: a pausa agendou a retomada");

  const ligado = await e.startProtection();
  assert.equal(ligado.ok, true);
  assert.equal(
    vivo(e.protectionResumeTimer),
    false,
    "uma protecao LIGADA nao pode trazer uma retomada agendada",
  );
  assert.equal(e.protectionPausedUntil ?? null, null, "uma protecao ligada nao esta pausada");

  const parado = await e.stopProtection();
  assert.equal(parado.ok, true);
  assert.equal(parado.protectionEnabled, false);
  assert.equal(e.protectionState, false);
  assert.equal(vivo(e.networkTimer), false, "o intervalo de rede tem de morrer no stop");
  for (const nome of ["watcher", "processMonitor", "etwConsumer", "amsiProvider", "wfpFilter"]) {
    assert.equal(
      chamadas.filter((c) => c === `${nome}.stop`).length >= 1,
      true,
      `${nome} tinha de ser parado no stop`,
    );
  }
});
