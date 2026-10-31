// Testes de CICLO DE VIDA do worker ADL (P0 da auditoria de integração).
//
// Não testam leituras de sensor — testam o que acontece ao PROCESSO:
// timeout, cancelamento, concorrência, encerramento, recuperação, órfãos e
// handles. Cada caso corresponde a uma alegação concreta da auditoria:
//
//   · "possível lançamento de worker ADL após timeout"
//   · "risco de resolução de operação antes do encerramento confirmado do worker"
//   · "workers que sobrevivem ao cancelamento" / "processos órfãos"
//   · "consultas concorrentes" / "timeouts sem recuperação"
//   · "estado incorreto após falha do provider" / "reinicializações desnecessárias"
//   · "fugas de memória ou handles"
//
// Dois níveis deliberados: (1) fixtures determinísticas para as transições de
// estado, (2) PROCESSOS REAIS para provar que nada fica vivo — fixtures podem
// mentir sobre o que o SO observa.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  readAdlSensors,
  resetAdlBridgeState,
  adlBridgePendingWorkers,
} from "../dist/adl-bridge.js";

const realFile = () => path.join(process.cwd(), "package.json");

class FakeChild extends EventEmitter {
  constructor(pid = 4242) {
    super();
    this.stdout = new EventEmitter();
    this.pid = pid;
    this.kills = [];
    /** O que `kill()` devolve. `true` é o filho bem-comportado; os testes de
     *  terminação falhada viram isto para `false`, como o Windows faz quando
     *  não conseguimos matar o processo. */
    this.killResult = true;
  }
  kill(signal) {
    this.kills.push(signal ?? "SIGTERM");
    return this.killResult;
  }
}

function harness(behavior, pid = 4242) {
  const created = [];
  const options = {
    dllPath: realFile(),
    workerPath: realFile(),
    /** O fixture representa um filho que NÃO podemos provar morto: a sonda de
     *  PID devolve sempre `true`. Sem isto, os testes dependeriam de que número
     *  de PID anda livre nesta máquina — que é exatamente o não-determinismo que
     *  o ciclo de vida tem de eliminar. Em produção a sonda é
     *  `process.kill(pid, 0)`. */
    probeChild: () => true,
    spawnWorker: () => {
      const child = new FakeChild(pid);
      created.push(child);
      if (behavior) setImmediate(() => behavior(child));
      return child;
    },
  };
  return { options, created };
}


const okPayload = (c = 70) =>
  Buffer.from(
    JSON.stringify({
      status: "ok",
      reason: null,
      adapterCount: 1,
      createCode: 0,
      adapters: [
        {
          adapterIndex: 1,
          udid: "u",
          adapterName: "AMD Radeon RX 5600 XT",
          displayName: "d",
          busNumber: 8,
          deviceNumber: 0,
          present: true,
          active: 1,
          pmlog: { gpuCoreC: c },
          od6Celsius: null,
        },
      ],
    }),
  );

// ───────────────────────── Timeout ──────────────────────────────────────────

test("timeout: não resolve ANTES de ver o encerramento do filho", async () => {
  resetAdlBridgeState();
  const { options, created } = harness(() => {
    /* silencioso até ao timeout; nunca comunica encerramento */
  });
  const reading = await readAdlSensors({ ...options, timeoutMs: 30, reapGraceMs: 120 });

  // No instante em que a promessa se resolve, o filho TEM de ter sido confirmado
  // como encerrado — ou então a leitura tem de o admitir como órfão. Não há
  // terceira hipótese (era essa a lacuna da auditoria).
  assert.equal(reading.status, "timeout");
  assert.ok(
    reading.orphaned === true || reading.closeConfirmed === true,
    `resolveu sem confirmar encerramento nem marcar órfão: ${JSON.stringify(reading)}`,
  );
  assert.equal(reading.closeConfirmed, false);
  assert.equal(reading.orphaned, true, "filho que nunca comunicou close é órfão assumido");
  assert.equal(reading.spawned, 1);
  assert.equal(created[0].kills[0], "SIGTERM", "primeiro pedido de morte é gracioso");
  assert.equal(created.length, 1);
  // O órfão fica VISÍVEL, não esquecido.
  assert.equal(adlBridgePendingWorkers().length, 1, "órfão tem de estar registado");
  assert.equal(adlBridgePendingWorkers()[0].killedWith, "SIGKILL", "escalou para SIGKILL");

  // Quando esse processo morrer mesmo assim, é colhido.
  created[0].emit("close", null, "SIGKILL");
  await new Promise((r) => setImmediate(r));
  assert.equal(adlBridgePendingWorkers().length, 0, "colhido depois de morrer");
});

test("timeout: com close dentro da graça, confirma e NÃO se chama órfão", async () => {
  resetAdlBridgeState();
  const { options, created } = harness((child) => {
    /* nada */
  });
  const p = readAdlSensors({ ...options, timeoutMs: 20, reapGraceMs: 400 });
  await new Promise((r) => setTimeout(r, 40));
  created[0].emit("close", null, "SIGTERM");
  const reading = await p;
  assert.equal(reading.status, "timeout");
  assert.equal(reading.reason, "worker-timeout", "razão estável, sem sufixo de órfão");
  assert.equal(reading.closeConfirmed, true);
  assert.equal(reading.orphaned, false);
  assert.equal(reading.spawned, 1);
  assert.equal(adlBridgePendingWorkers().length, 0, "nada pendente depois de confirmado");
});

test("timeout: um filho que já morreu não é re-morto", async () => {
  resetAdlBridgeState();
  const { options, created } = harness((child) => child.emit("close", null, "SIGKILL"));
  const reading = await readAdlSensors({ ...options, timeoutMs: 5000, reapGraceMs: 50 });
  assert.equal(reading.spawned, 1);
  assert.equal(created[0].kills.length, 0, "close chegou antes do timeout: nenhum kill");
  assert.equal(reading.status, "error");
  assert.equal(reading.reason, "worker-signal-SIGKILL");
});

// ─────────────────────── Nenhum spawn após resolução ────────────────────────

test("cancelado antes do arranque: spawned = 0 e nenhum processo criado", async () => {
  resetAdlBridgeState();
  const { options, created } = harness(null);
  const controller = new AbortController();
  controller.abort();
  const reading = await readAdlSensors({ ...options, signal: controller.signal });
  assert.equal(created.length, 0, "operaçao cancelada não pode criar filho");
  assert.equal(reading.spawned, 0, "`spawned` tem de dizer a verdade, não 1");
  assert.equal(reading.status, "error");
  assert.equal(reading.reason, "worker-cancelled-before-start");
  assert.equal(reading.closeConfirmed, null, "sem filho não há encerramento a confirmar");
});

test("single-flight: 20 chamadas simultâneas criam UM processo", async () => {
  resetAdlBridgeState();
  const { options, created } = harness((child) => {
    child.stdout.emit("data", okPayload(66));
    child.emit("close", 0, null);
  });
  const results = await Promise.all(Array.from({ length: 20 }, () => readAdlSensors(options)));
  assert.equal(created.length, 1, `esperava 1 processo, houve ${created.length}`);
  for (const r of results) {
    assert.equal(r.status, "ok");
    assert.equal(r.closeConfirmed, true);
    assert.equal(r.samples[0].pmlog.gpuCoreC, 66);
  }
});

test("cancelação durante a leitura: mata com confirmação e não entra em backoff", async () => {
  resetAdlBridgeState();
  const controller = new AbortController();
  const { options, created } = harness(null);
  const p = readAdlSensors({ ...options, signal: controller.signal, reapGraceMs: 300 });
  await new Promise((r) => setImmediate(r));
  controller.abort();
  await new Promise((r) => setImmediate(r));
  created[0].emit("close", null, "SIGTERM");
  const reading = await p;
  assert.equal(reading.status, "error");
  assert.equal(
    reading.reason,
    "worker-cancelled",
    "morrer porque nós mandámos não é crash; veio " + reading.reason,
  );
  assert.equal(reading.closeConfirmed, true);
  assert.equal(reading.orphaned, false);
  assert.equal(created[0].kills[0], "SIGTERM");

  // Recuperação: cancelar NÃO é falha do provider. A chamada seguinte tem de
  // poder tentar de novo imediatamente (sem 120 s de penalização).
  resetAdlBridgeState();
  const second = harness((child) => {
    child.stdout.emit("data", okPayload(55));
    child.emit("close", 0, null);
  });
  const after = await readAdlSensors(second.options);
  assert.equal(after.status, "ok");
  assert.equal(second.created.length, 1, "tentativa seguinte não pode ser bloqueada por backoff");
});

// ─────────────────────────── Recuperação de estado ──────────────────────────

test("falha transitória: throttling mantém o STATUS e a RAZÃO originais", async () => {
  resetAdlBridgeState();
  const { options } = harness((child) => child.emit("close", null, "SIGSEGV"));
  const first = await readAdlSensors(options);
  assert.equal(first.status, "error");
  assert.equal(first.reason, "worker-signal-SIGSEGV");
  const second = await readAdlSensors(options);
  assert.equal(second.status, "error", "estado de avaria não pode mudar de natureza");
  assert.equal(second.reason, "worker-signal-SIGSEGV", "a razão tem de sobreviver ao throttling");
});

test("unsupported legítimo não é reetiquetado como error (sem leitura ≠ avaria)", async () => {
  resetAdlBridgeState();
  const { options, created } = harness((child) => {
    child.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ status: "unsupported", reason: "no-sensor-data", adapters: [] })),
    );
    child.emit("close", 0, null);
  });
  const first = await readAdlSensors(options);
  assert.equal(first.status, "unsupported");
  assert.equal(first.reason, "no-sensor-data");
  const second = await readAdlSensors({ ...options });
  assert.equal(
    second.status,
    "unsupported",
    "maquina sem sensor AMD nao pode passar a error: veio " + second.status + "/" + second.reason,
  );
  assert.equal(second.reason, "no-sensor-data");
  assert.equal(created.length, 1, "sem sensor não se re-tenta a cada poll (reinicialização desnecessária)");
});

test("recuperação após timeout: volta a ler quando o throttle expira", async () => {
  resetAdlBridgeState();
  const { options } = harness(() => {});
  const timedOut = await readAdlSensors({ ...options, timeoutMs: 10, reapGraceMs: 20 });
  assert.equal(timedOut.status, "timeout");
  // Deixa de haver órfão pendente para a fase ser limpa.
  adlBridgePendingWorkers();

  resetAdlBridgeState();
  const ok = harness((child) => {
    child.stdout.emit("data", okPayload(49));
    child.emit("close", 0, null);
  });
  const recovered = await readAdlSensors(ok.options);
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.samples[0].pmlog.gpuCoreC, 49);
});

// ───────────────────────────── Handles ─────────────────────────────────────

test("encerramento confirmado liberta listeners (sem fuga de handles)", async () => {
  resetAdlBridgeState();
  const { options, created } = harness((child) => {
    child.stdout.emit("data", okPayload(61));
    child.emit("close", 0, null);
  });
  await readAdlSensors(options);
  await new Promise((r) => setImmediate(r));
  const child = created[0];
  assert.equal(child.listenerCount("close"), 0, "o listener de close tem de ser removido");
  assert.equal(child.listenerCount("error"), 0, "o listener de error tem de ser removido");
  assert.equal(child.stdout.listenerCount("data"), 0, "o listener de stdout tem de ser removido");
});

// ────────────────── Processos REAIS: nada fica vivo (SO) ────────────────────

function realSleeverChild(ms) {
  return () =>
    spawn(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
};

test("processo real: timeout mata mesmo e não deixa órfão no sistema", { timeout: 20000 }, async () => {
  resetAdlBridgeState();
  const seenPids = [];
  const options = {
    dllPath: realFile(),
    workerPath: realFile(),
    spawnWorker: () => {
      const child = realSleeverChild(30000)();
      seenPids.push(child.pid);
      return child;
    },
  };
  const reading = await readAdlSensors({ ...options, timeoutMs: 400, reapGraceMs: 1500 });
  assert.equal(reading.status, "timeout");
  assert.ok(seenPids.length === 1, "tem de haver exatamente um filho real criado");
  assert.equal(reading.spawned, 1);

  const pid = seenPids[0];
  // Espera activa pela morte, com limite — prova observável, não asserção.
  const deadline = Date.now() + 8000;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(pidAlive(pid), false, `o worker ${pid} sobreviveu ao timeout`);
  assert.equal(adlBridgePendingWorkers().length, 0, "nada fica pendente depois de morrer");
});

test("processo real: dois consumidores simultâneos = UM processo, sem tempestade", { timeout: 20000 }, async () => {
  resetAdlBridgeState();
  const pids = [];
  const options = {
    dllPath: realFile(),
    workerPath: realFile(),
    spawnWorker: () => {
      const child = realSleeverChild(400)();
      pids.push(child.pid);
      return child;
    },
  };
  const results = await Promise.all(
    Array.from({ length: 12 }, () => readAdlSensors({ ...options, timeoutMs: 120, reapGraceMs: 400 })),
  );
  assert.equal(pids.length, 1, `single-flight falhou com processos reais: ${pids.length} filhos`);
  for (const r of results) assert.equal(r.status, "timeout");
  const deadline = Date.now() + 6000;
  while (pids.some(pidAlive) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(pids.filter(pidAlive).length, 0, "nenhum worker real pode ficar vivo");
});

// ──── Erro do filho que já existia: o caso que a revisão v2 reproduziu ───────
//
// A documentação do `child_process` diz que o evento `error` cobre **tanto**
// «não conseguiu arrancar» **como** «não conseguiu matar». A ponte v2 tratava
// os dois como spawn: resolvia `worker-spawn-failed`, `closeConfirmed: null`,
// `orphaned: false` e, pior, `publish` desarmava o `reapTimer` — cancelando a
// graça e o SIGKILL enquanto o processo continuava registado como pendente.
// Resultado observável: `pending = 1` com uma leitura que dizia que não havia
// órfão. Estas três coisas têm de ser distintas: spawn sem filho, filho com
// morte não confirmada, filho com morte confirmada.

/** Fixture do caso exato da sonda: kill falha com EPERM e o close nunca chega. */
function killFailingChild(code = "EPERM") {
  const child = new FakeChild(876543);
  child.killResult = false;
  const originalKill = child.kill.bind(child);
  child.kill = (signal) => {
    originalKill(signal);
    setImmediate(() =>
      child.emit("error", Object.assign(new Error("simulated kill error"), { code })),
    );
    return false;
  };
  return child;
}

function fixedChild(child) {
  return {
    dllPath: realFile(),
    workerPath: realFile(),
    probeChild: () => true,
    spawnWorker: () => child,
  };
}

test("erro ao matar após timeout: NÃO é falha de spawn e o filho é órfão", async () => {
  resetAdlBridgeState();
  const child = killFailingChild("EPERM");
  const reading = await readAdlSensors({ ...fixedChild(child), timeoutMs: 20, reapGraceMs: 60 });

  assert.notEqual(reading.reason, "worker-spawn-failed", "o filho existia; chamar-lhe spawn-failed é mentir");
  assert.equal(reading.status, "timeout");
  assert.equal(reading.spawned, 1, "foi criado um filho, e isso tem de se ver");
  assert.equal(reading.closeConfirmed, false, "a morte não foi confirmada por close/exit");
  assert.equal(reading.orphaned, true, "registo pendente + órfão assumido, nunca `false`");
  assert.match(reading.reason, /unconfirmed/, `razão tem de dizer que a morte não se confirmou: ${reading.reason}`);
  assert.match(reading.reason, /EPERM|kill/, `razão tem de preservar a causa do falhanço: ${reading.reason}`);
  assert.equal(child.kills.includes("SIGKILL"), true, "a graça não pode ser cancelada por um erro de kill");
  assert.equal(adlBridgePendingWorkers().length, 1, "o órfão continua registado depois de resolver");
  assert.equal(adlBridgePendingWorkers()[0].pid, 876543);

  // E quando o processo morrer mais tarde, é colhido.
  child.emit("exit", null, "SIGKILL");
  await new Promise((r) => setImmediate(r));
  assert.equal(adlBridgePendingWorkers().length, 0, "exit confirma a morte tardia");
});

test("erro ao matar com close dentro da graça: morte confirmada, sem órfão", async () => {
  resetAdlBridgeState();
  const child = killFailingChild("EPERM");
  const p = readAdlSensors({ ...fixedChild(child), timeoutMs: 20, reapGraceMs: 500 });
  await new Promise((r) => setTimeout(r, 40));
  child.emit("close", null, "SIGTERM");
  const reading = await p;
  assert.equal(reading.status, "timeout");
  assert.equal(reading.closeConfirmed, true, "vimos o close: não é órfão");
  assert.equal(reading.orphaned, false);
  assert.match(reading.reason, /^worker-timeout/, `razão estável: ${reading.reason}`);
  assert.equal(adlBridgePendingWorkers().length, 0);
});

test("kill() devolve false: pedido de morte registado como falhado, não como SIGTERM", async () => {
  resetAdlBridgeState();
  const child = new FakeChild(31337);
  child.killResult = false; // false sem evento `error`: também é um facto possível
  const reading = await readAdlSensors({ ...fixedChild(child), timeoutMs: 20, reapGraceMs: 60 });
  assert.equal(reading.orphaned, true);
  assert.equal(reading.closeConfirmed, false);
  assert.match(reading.reason, /kill/, `tem de se saber que matar falhou: ${reading.reason}`);
  const [entry] = adlBridgePendingWorkers();
  assert.ok(entry, "o filho sobrevivo tem de estar visível");
  assert.notEqual(entry.killedWith, "SIGTERM", "não podemos afirmar um SIGTERM que o SO recusou");
});

test("erro de spawn verdadeiro (sem pid): sem filho, sem pendência, spawned 0", async () => {
  resetAdlBridgeState();
  const child = new FakeChild();
  // `new FakeChild(undefined)` NÃO daria `undefined`: o parâmetro por defeito
  // engole `undefined`. Retirar a propriedade é o que o Node faz quando o
  // processo não chegou a existir.
  delete child.pid;
  const p = readAdlSensors({ ...fixedChild(child), timeoutMs: 200, reapGraceMs: 50 });
  await new Promise((r) => setImmediate(r));
  child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
  const reading = await p;
  assert.equal(reading.reason, "worker-spawn-failed-ENOENT");
  assert.equal(reading.spawned, 0, "não existiu processo: dizer 1 era a mentira original");
  assert.equal(reading.closeConfirmed, null, "sem filho não há encerramento a confirmar");
  assert.equal(reading.orphaned, false);
  assert.equal(adlBridgePendingWorkers().length, 0, "falha de spawn não cria órfão");
  assert.equal(child.listenerCount("error"), 0, "e não deixa listener pendurado");
});

test("erro inesperado com filho vivo e sem pedido nosso: mata com confirmação", async () => {
  resetAdlBridgeState();
  const child = new FakeChild(5151);
  const p = readAdlSensors({ ...fixedChild(child), timeoutMs: 5000, reapGraceMs: 300 });
  await new Promise((r) => setImmediate(r));
  child.emit("error", Object.assign(new Error("internal failure"), { code: "EPIPE" }));
  await new Promise((r) => setImmediate(r));
  assert.equal(child.kills.length >= 1, true, "um erro no filho tem de desencadear a morte pedida");
  assert.equal(adlBridgePendingWorkers().length, 1, "e tem de ser rastreado até close/exit");
  child.emit("exit", 1, null);
  const reading = await p;
  assert.equal(reading.status, "error");
  assert.match(reading.reason, /worker-error/, reading.reason);
  assert.equal(reading.closeConfirmed, true, "confirmámos a morte antes de resolver");
  assert.equal(reading.orphaned, false);
  assert.equal(adlBridgePendingWorkers().length, 0);
});

test("exit sem close confirma a morte (pipes pendurados não são órfãos)", async () => {
  resetAdlBridgeState();
  const child = new FakeChild(6161);
  const p = readAdlSensors({ ...fixedChild(child), timeoutMs: 20, reapGraceMs: 400 });
  await new Promise((r) => setTimeout(r, 40));
  child.emit("exit", null, "SIGTERM");
  const reading = await p;
  assert.equal(reading.status, "timeout");
  assert.equal(reading.closeConfirmed, true);
  assert.equal(reading.orphaned, false);
  assert.equal(adlBridgePendingWorkers().length, 0, "o processo acabou; a pendência tem de sair");
});

test("órfão vivo bloqueia novas admissões (não multiplicamos sobreviventes)", async () => {
  resetAdlBridgeState();
  // Relógio controlado: o bloqueio por dívida e o backoff de falha são dois
  // mecanismos diferentes, e testá-los juntos com `Date.now` real só daria um
  // teste que falha por uma razão alheia à que se quer provar.
  let t = 1_000_000;
  const now = () => t;
  const primeiro = new FakeChild(7070);
  const timedOut = await readAdlSensors({
    ...fixedChild(primeiro),
    now,
    timeoutMs: 20,
    reapGraceMs: 60,
  });
  assert.equal(timedOut.orphaned, true, "pressuposto: ficou um órfão");
  assert.equal(adlBridgePendingWorkers().length, 1);

  let tentativas = 0;
  const bloqueado = await readAdlSensors({
    dllPath: realFile(),
    workerPath: realFile(),
    now,
    probeChild: () => true,
    spawnWorker: () => {
      tentativas += 1;
      return new FakeChild(9999);
    },
  });
  assert.equal(tentativas, 0, "com um órfão vivo, criar outro filho é exatamente o que a revisão proíbe");
  assert.equal(bloqueado.reason, "worker-reap-pending");
  assert.equal(bloqueado.spawned, 0);
  assert.equal(bloqueado.orphaned, true);
  assert.equal(adlBridgePendingWorkers().length, 1, "a recusa não apaga o rasto do órfão");

  // A dívida, uma vez comprovadamente paga, deixa de bloquear. Para distinguir
  // isto do backoff de 120 s da falha anterior, avançamos o relógio além dele.
  t += 121_000;
  const admitido = await readAdlSensors({
    dllPath: realFile(),
    workerPath: realFile(),
    now,
    probeChild: () => false,
    spawnWorker: () => {
      tentativas += 1;
      const child = new FakeChild(8080);
      setImmediate(() => {
        child.stdout.emit("data", okPayload(52));
        child.emit("close", 0, null);
      });
      return child;
    },
  });
  assert.equal(tentativas, 1, "órfão comprovadamente morto libera a admissão");
  assert.equal(admitido.status, "ok");
  assert.equal(admitido.samples[0].pmlog.gpuCoreC, 52);
  assert.equal(adlBridgePendingWorkers().length, 0);
});

test("cancelação e timeout concorrentes: um filho, uma resolução, rasto coerente", async () => {
  resetAdlBridgeState();
  const controller = new AbortController();
  const { options, created } = harness(null);
  const p = readAdlSensors({ ...options, timeoutMs: 5, reapGraceMs: 200 });
  controller.abort();
  const reading = await p;
  assert.equal(created.length, 1);
  assert.ok(
    ["worker-timeout", "worker-cancelled"].includes(reading.reason.split("-unconfirmed")[0].replace("kill-EPERM", "").replace("-kill-failed", "")),
    `razão esperada, veio ${reading.reason}`,
  );
  assert.ok(reading.orphaned === true || reading.closeConfirmed === true, "uma das duas, nunca nenhuma");
  created[0].emit("close", null, "SIGTERM");
  await new Promise((r) => setImmediate(r));
  assert.equal(adlBridgePendingWorkers().length, 0);
});

// ───────── exit sem close: o caso que deixou a v3 em HOLD ────────────────────
//
// `exit` ≠ `close`: o Node emite `exit` quando o processo acaba e `close`
// quando os pipes fecham. Um filho que deixa um pipe herdado aberto (por
// exemplo por um neto que o herdou) emite `exit` e pode NUNCA emitir `close`.
// Na v3 o handler de `exit` sem morte pedida limitava-se a marcar `exitSeen` e
// sair: a promessa ficava pendurada até ao timeout, e o `terminate` do timeout
// matava um PID que pode já ter sido RECICLADO por outro processo qualquer e
// registava pendência falsa sobre um filho que já morreu. Um `inFlight` preso
// aqui não é um detalhe interno: bloqueia `readTemperature` e retém o grupo no
// coordenador de hardware.

test("exit normal sem close: prazo limitado, sem matar PID reciclado, sem pendência falsa", async () => {
  resetAdlBridgeState();
  const { options, created } = harness((child) => child.emit("exit", 0, null));
  const inicio = Date.now();
  const reading = await readAdlSensors({ ...options, timeoutMs: 4000, reapGraceMs: 400 });
  const durou = Date.now() - inicio;

  assert.ok(durou < 3000, `a promessa tinha de resolver pelo «exit», não à espera do timeout (${durou} ms)`);
  assert.equal(reading.status, "error");
  assert.equal(reading.reason, "worker-exited-without-close", "sem close não há stdout completo: não se serve resultado parcial");
  assert.equal(reading.spawned, 1);
  assert.equal(reading.closeConfirmed, true, "`exit` é prova de morte");
  assert.equal(reading.orphaned, false, "um processo que vimos morrer não é órfão");
  assert.equal(reading.childAlive, false, "sabemos que não está vivo; null seria fingir ignorância");
  assert.equal(created[0].kills.length, 0, "matar o PID de um filho que já saiu é matar possivelmente outra coisa");
  assert.equal(adlBridgePendingWorkers().length, 0, "sem filho vivo não há dívida pendente");
});

test("exit e depois close: o close manda, a leitura completa é servida", async () => {
  resetAdlBridgeState();
  const { options, created } = harness((child) => {
    child.emit("exit", 0, null);
    setTimeout(() => {
      child.stdout.emit("data", okPayload(63));
      child.emit("close", 0, null);
    }, 10);
  });
  const reading = await readAdlSensors({ ...options, timeoutMs: 4000, reapGraceMs: 300 });
  assert.equal(reading.status, "ok");
  assert.equal(reading.samples[0].pmlog.gpuCoreC, 63);
  assert.equal(reading.closeConfirmed, true);
  assert.equal(created[0].kills.length, 0);
  assert.equal(adlBridgePendingWorkers().length, 0);
});

test("exit depois de cancelamento: um só pedido de morte, morte confirmada", async () => {
  resetAdlBridgeState();
  const controller = new AbortController();
  const { options, created } = harness(null);
  const p = readAdlSensors({
    ...options,
    signal: controller.signal,
    timeoutMs: 4000,
    reapGraceMs: 300,
  });
  await new Promise((r) => setImmediate(r));
  controller.abort();
  await new Promise((r) => setImmediate(r));
  created[0].emit("exit", null, "SIGTERM");
  const reading = await p;
  assert.equal(reading.reason, "worker-cancelled");
  assert.equal(reading.closeConfirmed, true);
  assert.equal(reading.orphaned, false);
  assert.equal(reading.childAlive, false);
  assert.equal(created[0].kills.length, 1, "o segundo pedido de morte ao mesmo filho não acrescenta verdade");
  assert.equal(adlBridgePendingWorkers().length, 0);
});

test("filho REAL sem close (neto retém o pipe): resolve com prazo e não mata PID alheio", { timeout: 20000 }, async () => {
  resetAdlBridgeState();
  const vistos = [];
  const options = {
    dllPath: realFile(),
    workerPath: realFile(),
    spawnWorker: () =>
      // O neto herda o stdout do filho; o filho sai a seguir. `exit` chega no
      // instante, `close` só quando o neto morrer (1,2 s) — exatamente a
      // situação que a fixture simulava. Nada é morto por nós.
      spawn(
        process.execPath,
        [
          "-e",
          "const{spawn}=require('child_process');" +
            "spawn(process.execPath,['-e','setTimeout(()=>{},1200)'],{stdio:'inherit'});" +
            "process.exit(0)",
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      ),
  };
  const original = options.spawnWorker;
  const killsFeitas = [];
  options.spawnWorker = () => {
    const c = original();
    vistos.push(c.pid);
    const killOriginal = c.kill.bind(c);
    c.kill = (sig) => {
      killsFeitas.push(sig ?? "SIGTERM");
      return killOriginal(sig);
    };
    return c;
  };
  const inicio = Date.now();
  const reading = await readAdlSensors({ ...options, timeoutMs: 6000, reapGraceMs: 300 });
  assert.ok(Date.now() - inicio < 4000, "um pipe retido não pode prender o coordenador de hardware");
  assert.equal(reading.spawned, 1);
  assert.equal(reading.status, "error");
  /**
   * Nesta máquina o neto não chegou a reter o handle e o `close` veio vazio,
   * pelo que a honestidade exigida é a mesma por outro caminho: um deles é
   * reportado, e NENHUM deles serve `ok` com stdout incompleto. Manter os dois
   * aceitáveis é o que a evidência permite; fixar um seria escrever o teste à
   * volta do resultado.
   */
  assert.ok(
    ["worker-exited-without-close", "worker-unparseable-output"].includes(reading.reason),
    `saída honesta esperada, veio ${reading.reason}`,
  );
  assert.equal(reading.closeConfirmed, true, "ou vimos o exit, ou vimos o close");
  assert.equal(reading.orphaned, false);
  assert.equal(adlBridgePendingWorkers().length, 0);
  assert.deepEqual(killsFeitas, [], "matar o PID de um filho que já saiu é matar possivelmente outro processo");
});

test("recusa de admissão não afirma vida sem prova (childAlive conserva null)", async () => {
  resetAdlBridgeState();
  // probe = null é «não consigo provar»: o filho continua em dívida (recusa
  // conservadora), mas afirmar `childAlive: true` seria inventar a observação.
  const { options, created } = harness(null);
  const comDuvida = await readAdlSensors({
    ...options,
    probeChild: () => null,
    timeoutMs: 20,
    reapGraceMs: 40,
  });
  assert.equal(comDuvida.orphaned, true);
  assert.equal(comDuvida.childAlive, null, "sem prova de existência, o metadado é desconhecido");
  assert.equal(adlBridgePendingWorkers().length, 1);

  const recusado = await readAdlSensors({
    dllPath: realFile(),
    workerPath: realFile(),
    probeChild: () => null,
    spawnWorker: () => {
      throw new Error("não podia spawnar com dívida por confirmar");
    },
  });
  assert.equal(recusado.reason, "worker-reap-pending");
  assert.equal(recusado.childAlive, null, "a recusa repete a dúvida, não a transforma em facto");
  assert.equal(created.length, 1, "apenas o primeiro filho");
});

