import { test } from "node:test";
import assert from "node:assert/strict";

import {
  criacaoPosix,
  abrirLeasePosixTerminacao,
} from "../dist/process-termination-posix.js";
import {
  SafeProcessTermination,
  exactCreationStamp,
  matchesSnapshotCreation,
} from "../dist/safe-process-termination.js";

const SELF = { pid: 1000, uid: 1000, euid: 1000 };
const HZ = 100;
const BOOT_MS = 1_700_000_000_000;
const STARTTIME = 5000;

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

const stat = (pid, { comm = "sleep", state = "S", starttime = STARTTIME } = {}) =>
  // Forma copiada do fixture que já passa em `process-termination-posix.test.js`:
  // `starttime` tem de cair no índice 19 dos campos após `state`. Menos uma
  // token faz o parser ler o `vsize` (12345678) como instante de criação.
  `${pid} (${comm}) ${state} 1 1 1 0 0 0 0 0 0 0 0 0 0 20 0 1 0 0 ${starttime} 12345678 987654`;

const entrada = (pid, extra) => ({
  stat: stat(pid, extra),
  status: `Name:\tsleep\nState:\tS (sleeping)\nUid:\t1000\t1000\t1000\t1000\n`,
  cmdline: "/bin/sleep 900",
});

/** Lease sobre um `/proc` falso mutável; devolve também o registo de sinais. */
function montar(opcoes = {}) {
  const entradas = { 500: entrada(500, opcoes.inicial ?? {}) };
  const sinais = [];
  const lease = abrirLeasePosixTerminacao(500, {
    hz: HZ,
    bootMs: BOOT_MS,
    proc: procFalso(entradas),
    self: SELF,
    pathLeitura: () => opcoes.caminho ?? "/usr/bin/sleep",
    protegido: opcoes.protegido,
    signalImpl: (pid, sinal) => {
      sinais.push({ pid, sinal });
      // O sinal "mata" o processo do falso /proc, como faria o kernel.
      delete entradas[pid];
    },
  });
  return { lease, entradas, sinais };
}

test("criacaoPosix produz o corte do contrato partilhado (7 decimais) e o FILETIME bate", () => {
  const ms = BOOT_MS + STARTTIME / HZ * 1000;
  const criada = criacaoPosix(ms);
  assert.match(criada.startedAt, /\.\d{7}Z$/);
  assert.equal(exactCreationStamp(criada.startedAt), criada.creation);
  assert.equal(matchesSnapshotCreation(criada.startedAt, criada.creation), true);
  // 0 e negativos não são instante de criação: ausência, não Epoch.
  assert.equal(criacaoPosix(0), null);
  assert.equal(criacaoPosix(Number.NaN), null);
});

test("lease POSIX: identidade lida de /proc é elegível e declara reconfirmacao", () => {
  const { lease } = montar();
  const identidade = lease.read();
  assert.equal(identidade.pid, 500);
  assert.equal(identidade.name, "sleep");
  assert.equal(identidade.path, "/usr/bin/sleep");
  assert.equal(identidade.eligible, true);
  assert.equal(identidade.reason, undefined);
  assert.equal(identidade.creation, criacaoPosix(BOOT_MS + STARTTIME / HZ * 1000).creation);
  assert.equal(lease.confirmation, "identity-reconfirmed");
  assert.equal(lease.exited(), false);
  lease.close();
});

test("lease POSIX: PID reutilizado (starttime outro) nao e elegivel e nao sinaliza", () => {
  const { lease, entradas, sinais } = montar();
  // O 500 morreu e nasceu outro processo no mesmo PID: starttime diferente.
  entradas[500] = entrada(500, { starttime: STARTTIME + 40 });
  const identidade = lease.read();
  assert.equal(identidade.eligible, false);
  assert.equal(identidade.reason, "identidade-nao-confirma");
  assert.throws(() => lease.terminate(), /identidade-nao-confirma.*nenhum efeito/m);
  assert.deepEqual(sinais, []);
});

test("lease POSIX: nome divergente é recusado antes do sinal", () => {
  const { lease, entradas, sinais } = montar();
  entradas[500] = entrada(500, { comm: "mv" });
  assert.equal(lease.read().reason, "nome-nao-corresponde");
  assert.throws(() => lease.terminate(), /nome-nao-corresponde/);
  assert.deepEqual(sinais, []);
});

test("lease POSIX: Zombie não é alvo; exited não autoriza sinal", () => {
  const { lease, entradas, sinais } = montar();
  entradas[500] = entrada(500, { state: "Z" });
  assert.equal(lease.exited(), true);
  assert.equal(lease.read().eligible, false);
  assert.throws(() => lease.terminate(), /processo-zombie/);
  assert.deepEqual(sinais, []);
});

test("lease POSIX: proteção do serviço vence a elegibilidade", () => {
  const { lease, sinais } = montar({ protegido: () => true });
  const identidade = lease.read();
  assert.equal(identidade.eligible, false);
  assert.equal(identidade.reason, "protegido");
  assert.throws(() => lease.terminate(), /protegido pelo serviço/);
  assert.deepEqual(sinais, []);
});

test("lease POSIX: PID já morto no open é «já saiu», não falha opaca", () => {
  const entradas = {};
  const sinais = [];
  const lease = abrirLeasePosixTerminacao(777, {
    hz: HZ, bootMs: BOOT_MS, proc: procFalso(entradas), self: SELF,
    signalImpl: (pid, sinal) => sinais.push({ pid, sinal }),
  });
  assert.equal(lease.exited(), true);
  assert.equal(lease.read().reason, "sem-identidade");
  assert.throws(() => lease.terminate(), /já tinha saído/);
  assert.deepEqual(sinais, []);
});

test("lease POSIX: bilhete fechado não sinaliza", () => {
  const { lease, sinais } = montar();
  lease.close();
  assert.throws(() => lease.terminate(), /bilhete já tinha sido fechado/);
  assert.deepEqual(sinais, []);
});

test("lease POSIX: terminate envia um SIGTERM ao PID pinado", () => {
  const { lease, sinais } = montar();
  lease.terminate();
  assert.deepEqual(sinais, [{ pid: 500, sinal: "SIGTERM" }]);
});

test("fluxo completo com SafeProcessTermination: prepare e confirm em POSIX", () => {
  const { lease, sinais } = montar();
  const identidade = lease.read();
  const auditados = [];
  const controlador = new SafeProcessTermination({
    open: () => lease,
    blocked: () => null,
    audit: (evento) => auditados.push(evento),
  });
  const preparacao = controlador.prepare({ pid: 500, startedAt: identidade.startedAt });
  assert.equal(preparacao.ok, true, JSON.stringify(preparacao));
  assert.equal(preparacao.target.name, "sleep");

  const resultado = controlador.confirm(preparacao.ticket);
  return resultado.then((final) => {
    assert.equal(final.success, true);
    assert.equal(final.status, "killed");
    assert.equal(final.scope, "single-process");
    // A garantia dita o rótulo: em POSIX não houve handle pinado.
    assert.equal(final.confirmation, "identity-reconfirmed");
    assert.deepEqual(sinais, [{ pid: 500, sinal: "SIGTERM" }]);
    assert.equal(auditados.length, 1);
    assert.equal(auditados[0].status, "killed");
    assert.equal(auditados[0].source, "user-confirmed");
  });
});

test("prepare POSIX: snapshot com startedAt de 3 casas não é rejeitado como ausência", () => {
  // O `exactCreationStamp` do contrato partilhado exige 7 decimais. Uma linha
  // mal formatada tem de ser recusada no prepare, nunca tratada como "identidade
  // não confirmada" do processo.
  const { lease } = montar();
  const controlador = new SafeProcessTermination({
    open: () => lease, blocked: () => null, audit: () => {},
  });
  const preparacao = controlador.prepare({ pid: 500, startedAt: "2023-11-14T22:13:20.000Z" });
  assert.equal(preparacao.ok, false);
  assert.equal(preparacao.status, "failed");
});

test("confirm POSIX: PID reutilizado entre prepare e confirm não sinaliza", () => {
  const entradas = { 500: entrada(500) };
  const sinais = [];
  const lease = abrirLeasePosixTerminacao(500, {
    hz: HZ, bootMs: BOOT_MS, proc: procFalso(entradas), self: SELF,
    pathLeitura: () => "/usr/bin/sleep",
    signalImpl: (pid) => { sinais.push(pid); delete entradas[pid]; },
  });
  const controlador = new SafeProcessTermination({
    open: () => lease, blocked: () => null, audit: () => {},
  });
  const preparacao = controlador.prepare({ pid: 500, startedAt: lease.read().startedAt });
  assert.equal(preparacao.ok, true);
  // Reutilização depois do bilhete: o starttime muda e o nome também.
  entradas[500] = entrada(500, { comm: "sh", starttime: STARTTIME + 99 });
  return controlador.confirm(preparacao.ticket).then((final) => {
    assert.equal(final.success, false);
    assert.equal(final.status, "reused");
    assert.deepEqual(sinais, []);
  });
});
