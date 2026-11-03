import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseProcStat,
  parseProcStatusUids,
  readPosixProcessIdentity,
  decidePosixTermination,
  terminatePosixProcess,
  commCorresponde,
} from "../dist/process-termination-posix.js";

const SELF = { pid: 1000, uid: 1000, euid: 1000 };

/** `/proc` falso: só os caminhos que o teste declara existem. */
function procFalso(entradas) {
  return {
    existsSync: (caminho) => {
      const m = /^\/proc\/(\d+)$/.exec(caminho);
      return m ? Object.prototype.hasOwnProperty.call(entradas, m[1]) : false;
    },
    readFileSync: (caminho) => {
      const m = /^\/proc\/(\d+)\/(\w+)$/.exec(caminho);
      if (!m || !entradas[m[1]]) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      const valor = entradas[m[1]][m[2]];
      if (valor === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return valor;
    },
  };
}

const proc = (pid, { comm = "sleep", state = "S", ppid = 1, starttime = 5000, uid = 1000, euid = uid, cmdline = "/bin/sleep 30" } = {}) => ({
  // Campos 3..22 de um `stat` real: state, ppid, pgrp, session, tty_nr, tpgid,
  // flags, minflt, cminflt, majflt, cmajflt, utime, stime, cutime, cstime,
  // priority, nice, num_threads, itrealtime, starttime. O `starttime` tem de
  // caer no índice 19 — é o que o parser lê.
  stat: `${pid} (${comm}) ${state} ${ppid} 1 1 0 0 0 0 0 0 0 0 0 0 20 0 1 0 0 ${starttime} 12345678 987654`,
  status: `Name:\t${comm}\nState:\tS (sleeping)\nUid:\t${uid}\t${euid}\t${uid}\t${uid}\n`,
  cmdline,
});

test("parseProcStat sobrevive a comm com espacos e parentesis", () => {
  const r = parseProcStat("42 (my (odd) app) S 7 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 3 0 98765 1234");
  assert.equal(r.comm, "my (odd) app");
  assert.equal(r.ppid, 7);
  assert.equal(r.state, "S");
  assert.equal(r.starttime, 98765);
  assert.equal(r.pid, 42);
});

test("parseProcStat rejeita conteudo sem parentesis ou curto", () => {
  assert.equal(parseProcStat("sem parentesis"), null);
  assert.equal(parseProcStat("1 (x) S 0 0 0"), null);
});

test("parseProcStatusUids le real e effective", () => {
  assert.deepEqual(parseProcStatusUids("Uid:\t1000\t1001\t1000\t1000\n"), { uid: 1000, euid: 1001 });
  assert.equal(parseProcStatusUids("Nada aqui"), null);
});

test("readPosixProcessIdentity: sem directorio nao ha prova", () => {
  assert.equal(readPosixProcessIdentity(77, procFalso({})), null);
});

test("readPosixProcessIdentity: thread de kernel (cmdline vazio, pai <= 2)", () => {
  const p = procFalso({ "9": proc(9, { comm: "kworker/0:1", ppid: 2, cmdline: "" }) });
  const i = readPosixProcessIdentity(9, p);
  assert.equal(i.kernelThread, true);
  assert.equal(i.starttime, 5000);
});

test("decidePosixTermination recusa antes do sinal, com motivo nomeado", () => {
  const p = (extra) => procFalso({ "500": proc(500, extra) });
  assert.equal(decidePosixTermination(null, SELF), "sem-identidade");
  assert.equal(decidePosixTermination(readPosixProcessIdentity(500, p({ state: "Z" })), SELF), "processo-zombie");
  assert.equal(
    decidePosixTermination(readPosixProcessIdentity(500, p({})), SELF, 4321),
    "identidade-nao-confirma",
  );
  assert.equal(decidePosixTermination(readPosixProcessIdentity(1, procFalso({ "1": proc(1, { comm: "systemd", ppid: 0 }) })), SELF), "thread-de-kernel");
  assert.equal(decidePosixTermination(readPosixProcessIdentity(1000, procFalso({ "1000": proc(1000) })), SELF), "processo-proprio");
  // Filho DIRETO do chamador não é intocável: a medição em WSL2 mostrou que
  // recusar `ppid === self` barrava processos legítimos do ecrã. A proteção de
  // ancestrais e componentes do CyberSafe é do `classifyKillTarget` do motor.
  assert.equal(
    decidePosixTermination(readPosixProcessIdentity(600, procFalso({ "600": proc(600, { ppid: 1000 }) })), SELF),
    null,
  );
  assert.equal(decidePosixTermination(readPosixProcessIdentity(601, procFalso({ "601": proc(601, { euid: 0 }) })), SELF), "outro-utilizador");
  assert.equal(decidePosixTermination(readPosixProcessIdentity(602, procFalso({ "602": proc(602) })), SELF), null);
});

test("root pode sinalizar outro uid (a recusa e por privilegio real, nao por suposicao)", () => {
  const i = readPosixProcessIdentity(610, procFalso({ "610": proc(610, { uid: 0, euid: 0 }) }));
  assert.equal(decidePosixTermination(i, { pid: 9, uid: 0, euid: 0 }), null);
});

test("terminatePosixProcess: recusa nao envia sinal nenhum", async () => {
  const enviados = [];
  const r = await terminatePosixProcess(500, {
    proc: procFalso({ "500": proc(500, { euid: 0 }) }),
    raizProc: "/proc",
    self: SELF,
    signalImpl: (pid, s) => enviados.push([pid, s]),
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, "access-denied");
  assert.match(r.error, /outro-utilizador/);
  assert.deepEqual(enviados, []);
});

test("terminatePosixProcess: SIGTERM e o default; sem escalar a SIGKILL", async () => {
  const enviados = [];
  let vivo = true;
  const entradas = { "700": proc(700) };
  const p = {
    existsSync: (c) => /^\/proc\/700$/.test(c) && vivo,
    readFileSync: (c) => {
      if (!vivo) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return entradas["700"][/stat$/.test(c) ? "stat" : "status"];
    },
  };
  const r = await terminatePosixProcess(700, {
    proc: p,
    self: SELF,
    timeoutMs: 300,
    signalImpl: (pid, s) => enviados.push([pid, s]),
    sleepMs: async () => { vivo = false; },
    agora: () => Date.now(),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(enviados, [[700, "SIGTERM"]]);
});

test("terminatePosixProcess: SIGKILL so quando pedido explicitamente", async () => {
  const enviados = [];
  let vivo = true;
  const p = {
    existsSync: () => vivo,
    readFileSync: (c) => {
      if (!vivo) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return /stat$/.test(c) ? proc(701).stat : proc(701).status;
    },
  };
  const r = await terminatePosixProcess(701, {
    proc: p, self: SELF, signal: "SIGKILL",
    signalImpl: (pid, s) => enviados.push([pid, s]),
    sleepMs: async () => { vivo = false; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(enviados, [[701, "SIGKILL"]]);
});

test("terminatePosixProcess: alvo que ignora SIGTERM devolve timeout e NAO e tratado como morto", async () => {
  const enviados = [];
  const r = await terminatePosixProcess(702, {
    proc: procFalso({ "702": proc(702) }),
    self: SELF,
    timeoutMs: 200,
    signalImpl: (pid, s) => enviados.push([pid, s]),
    sleepMs: async () => {},
    agora: () => Date.now(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, "timeout");
  assert.match(r.error, /SIGKILL exige confirmacao explicita/);
  assert.equal(enviados.length, 1, "uma tentativa por pedido; sem escalar sozinho");
});

test("terminatePosixProcess: EPERM do kernel e access-denied, ESRCH e not-found", async () => {
  const comErro = (code) =>
    terminatePosixProcess(703, {
      proc: procFalso({ "703": proc(703) }),
      self: SELF,
      signalImpl: () => { throw Object.assign(new Error(code), { code }); },
    });
  assert.equal((await comErro("EPERM")).status, "access-denied");
  assert.equal((await comErro("ESRCH")).status, "not-found");
});

test("terminatePosixProcess: PID reaproveitado durante a espera nao e re-sinalizado", async () => {
  const enviados = [];
  let leituras = 0;
  const p = {
    existsSync: () => true,
    readFileSync: (c) => {
      const novo = leituras > 0;
      if (/stat$/.test(c)) return proc(704, { starttime: novo ? 99999 : 5000, comm: novo ? "outro" : "sleep" }).stat;
      return proc(704).status;
    },
  };
  const r = await terminatePosixProcess(704, {
    proc: p, self: SELF, timeoutMs: 300,
    signalImpl: (pid, s) => { enviados.push([pid, s]); leituras += 1; },
    sleepMs: async () => {},
    agora: ((t) => () => t++)(0),
  });
  assert.equal(r.status, "not-found");
  assert.match(r.error, /reapareceu com identidade diferente/);
  assert.equal(enviados.length, 1);
});

test("commCorresponde: nome simples, caminho, corte de 15 e ausencia de relacao", () => {
  assert.equal(commCorresponde("sleep", "sleep"), true);
  assert.equal(commCorresponde("node", "/usr/local/bin/node"), true);
  assert.equal(commCorresponde("chrome", "/opt/google/chrome/chrome"), true);
  // `/proc` corta o comm a 15 caracteres; o corte é prefixo, não outro nome.
  assert.equal(commCorresponde("systemd-journa", "systemd-journald"), true);
  assert.equal(commCorresponde("systemd-logge", "systemd-journald"), false);
  assert.equal(commCorresponde("notepad", "sleep"), false);
  assert.equal(commCorresponde("", "sleep"), false);
  assert.equal(commCorresponde("sleep", "   "), false);
  // Um caractere nao e prova: sem a regra do minimo, quase tudo casaria.
  assert.equal(commCorresponde("s", "sleepy"), false);
});

test("decidePosixTermination: nome do snapshot e segunda ancora de identidade", () => {
  const i = readPosixProcessIdentity(620, procFalso({ "620": proc(620, { comm: "sleep" }) }));
  assert.equal(decidePosixTermination(i, SELF, { esperadoNome: "sleep" }), null);
  assert.equal(decidePosixTermination(i, SELF, { esperadoNome: "/bin/sleep" }), null);
  assert.equal(decidePosixTermination(i, SELF, { esperadoNome: "firefox" }), "nome-nao-corresponde");
  // Retro-compatibilidade: o terceiro argumento ainda aceita so o starttime.
  assert.equal(decidePosixTermination(i, SELF, 5000), null);
  assert.equal(decidePosixTermination(i, SELF, 1234), "identidade-nao-confirma");
});

test("terminatePosixProcess: nome divergente recusa e nao envia sinal", async () => {
  const enviados = [];
  const r = await terminatePosixProcess(710, {
    proc: procFalso({ "710": proc(710, { comm: "sleep" }) }),
    self: SELF,
    esperadoNome: "firefox",
    signalImpl: (pid, s) => enviados.push([pid, s]),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /nome-nao-corresponde/);
  assert.deepEqual(enviados, []);
});
