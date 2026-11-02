import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analisarFiltroProcessosPosix,
  analisarLinhasStat,
  calcularCpuPercent,
  consultarProcessosPosix,
  listPosixProcesses,
  PosixProcessProvider,
} from "../dist/process-provider-posix.js";

const BTIME_SEG = 1700_000_000;
const BOOT_MS = BTIME_SEG * 1000;
const HZ = 100;
const PAGES = 4096;

/**
 * Constrói o conteúdo de `/proc/<pid>/stat` com o layout real do kernel:
 * campos 1..2 são pid e `comm` (entre parêntesis) e o campo 3 é `state`.
 * A lista `depois` cobre os campos 4..24 por ordem, um por posição:
 * ppid, pgrp, session, tty_nr, tpgid, flags, minflt, cminflt, majflt, cmajflt,
 * utime(14), stime(15), cutime, cstime, priority, nice, num_threads,
 * itrealvalue, starttime(22), vsize(23), rss(24).
 */
function stat(pid, comm, extra = {}) {
  const {
    state = "S", ppid = 1, utime = 0, stime = 0, starttime = 1000, rss = 0,
  } = extra;
  const depois = [
    ppid, 1, 1, 0, 0, 0, 0, 0, 0, 0,
    utime, stime,
    0, 0, 20, 0, 1, 0,
    starttime, 12_345_678, rss,
  ];
  return `${pid} (${comm}) ${state} ${depois.join(" ")}`;
}

function procFalso(entradas, raiz = "/proc") {
  const ficheiros = new Map();
  ficheiros.set(`${raiz}/stat`, `cpu  1 2 3 4\nbtime ${BTIME_SEG}\n`);
  ficheiros.set("/etc/passwd", "root:x:0:0:root:/root:/bin/sh\ncaioc:x:1000:1000::/home/caioc:/bin/bash\n");
  for (const [pid, entrada] of Object.entries(entradas)) {
    const base = `${raiz}/${pid}`;
    ficheiros.set(`${base}/stat`, entrada.stat);
    ficheiros.set(`${base}/status`, entrada.status ?? `Name:\tx\nUid:\t1000\t1000\t1000\t1000`);
    ficheiros.set(`${base}/cmdline`, entrada.cmdline ?? "/usr/bin/x\0--flag");
  }
  const pidsNumericos = Object.keys(entradas);
  return {
    existsSync: (c) => ficheiros.has(c),
    readFileSync: (c) => {
      if (!ficheiros.has(c)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return ficheiros.get(c);
    },
    readdirSync: () => ["cpu", "stat", "meminfo", "self", ...pidsNumericos],
    readlinkSync: (c) => {
      if (entradas[c.split("/")[2]]?.semExe) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return "/usr/bin/x";
    },
    _ficheiros: ficheiros,
  };
}

const sysconfOk = (nome) => (nome === "CLK_TCK" ? HZ : PAGES);
const sysconfAusente = () => null;

const estadoNovo = () => ({ amostras: new Map(), constantes: null, utilizadores: null });

test("analisarLinhasStat extrai cpu ticks e rss nas posições certas", () => {
  const lida = analisarLinhasStat(stat(42, "sleep", { ppid: 7, utime: 300, stime: 200, starttime: 5000, rss: 512 }));
  assert.equal(lida.pid, 42);
  assert.equal(lida.comm, "sleep");
  assert.equal(lida.ppid, 7);
  assert.equal(lida.state, "S");
  assert.equal(lida.starttime, 5000);
  assert.equal(lida.cpuTicks, 500);
  assert.equal(lida.rssPages, 512);
});

test("analisarLinhasStat aceita comm com espaços e parêntesis", () => {
  const lida = analisarLinhasStat(stat(9, "(a b) c", { starttime: 10 }));
  assert.equal(lida.comm, "(a b) c");
  assert.equal(lida.starttime, 10);
});

test("listPosixProcesses converte starttime em instante real e rss em MB", () => {
  const proc = procFalso({ "42": { stat: stat(42, "sleep", { starttime: 1000, utime: 500, rss: 512 }) } });
  const linhas = listPosixProcesses(estadoNovo(), {
    proc,
    agora: () => BOOT_MS + 110_000,
    sysconf: sysconfOk,
  });
  assert.equal(linhas.length, 1);
  const linha = linhas[0];
  assert.equal(linha.pid, 42);
  assert.equal(linha.name, "sleep");
  assert.equal(linha.path, "/usr/bin/x");
  assert.equal(linha.commandLine, "/usr/bin/x --flag");
  assert.equal(linha.user, "caioc");
  assert.equal(linha.startedAt, new Date(BOOT_MS + 10_000).toISOString().replace(/Z$/, "0000Z"));
  assert.equal(linha.memoryMb, 2);
  assert.equal(linha.trusted, "neutral");
});

test("CPU da primeira enumeração é a média da vida; a segunda é o intervalo", () => {
  const entradas = { "42": { stat: stat(42, "sleep", { starttime: 1000, utime: 500, rss: 512 }) } };
  const proc = procFalso(entradas);
  const estado = estadoNovo();
  const opcoes = { proc, agora: () => BOOT_MS + 110_000, sysconf: sysconfOk };

  const primeira = listPosixProcesses(estado, opcoes)[0];
  // 500 ticks = 5 s de CPU em 100 s de vida → 5%.
  assert.equal(primeira.cpu, 5);

  proc._ficheiros.set("/proc/42/stat", stat(42, "sleep", { starttime: 1000, utime: 700, rss: 512 }));
  const segunda = listPosixProcesses(estado, { ...opcoes, agora: () => BOOT_MS + 120_000 })[0];
  // +200 ticks em +10 s = 2 s de CPU por 10 s → 20%, não a média da vida.
  assert.equal(segunda.cpu, 20);
});

test("sem getconf não há instante nem memória inventados", () => {
  const proc = procFalso({ "42": { stat: stat(42, "sleep", { starttime: 1000, utime: 500, rss: 512 }) } });
  const linha = listPosixProcesses(estadoNovo(), {
    proc, agora: () => BOOT_MS + 110_000, sysconf: sysconfAusente,
  })[0];
  assert.equal(linha.startedAt, "", "sem HZ/btime não se afirma quando o processo nasceu");
  assert.equal(linha.memoryMb, 0);
  assert.equal(linha.cpu, 0);
});

test("uid sem entrada em /etc/passwd fica numérico, nunca vazio", () => {
  const proc = procFalso({ "42": { stat: stat(42, "x"), status: "Uid:\t4242\t4242\t4242\t4242" } });
  const linha = listPosixProcesses(estadoNovo(), { proc, sysconf: sysconfOk })[0];
  assert.equal(linha.user, "uid:4242");
});

test("processo sem exe legível fica com caminho vazio (ausência, não adivinha)", () => {
  const proc = procFalso({ "42": { stat: stat(42, "kworker/0:1", { ppid: 2, starttime: 10 }), semExe: true, cmdline: "" } });
  const linha = listPosixProcesses(estadoNovo(), { proc, sysconf: sysconfOk })[0];
  assert.equal(linha.path, "");
  assert.equal(linha.commandLine, "");
});

test("PID que nasce entre o readdir e a leitura é ignorado, não rebenta a lista", () => {
  const entradas = {
    "42": { stat: stat(42, "sleep") },
    "43": { stat: stat(43, "desapareceu") },
  };
  const proc = procFalso(entradas);
  const original = proc.readFileSync;
  proc.readFileSync = (c) => {
    if (c === "/proc/43/stat") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return original(c);
  };
  const linhas = listPosixProcesses(estadoNovo(), { proc, sysconf: sysconfOk });
  assert.deepEqual(linhas.map((l) => l.pid), [42]);
});

test("/proc ilegível lança; não é tratado como «zero processos»", () => {
  const proc = { ...procFalso({ "42": { stat: stat(42, "x") } }), readdirSync: () => { throw new Error("EPERM"); } };
  assert.throws(() => listPosixProcesses(estadoNovo(), { proc, sysconf: sysconfOk }), /indisponível/);
});

test("zero registos utilizáveis é falha da fonte, nunca lista vazia", () => {
  const proc = procFalso({});
  assert.throws(() => listPosixProcesses(estadoNovo(), { proc, sysconf: sysconfOk }), /zero registos/);
});

test("calcularCpuPercent recusa o intervalo quando a amostra não é da mesma vida", () => {
  const atual = { starttime: 2000, ticks: 400, atMs: 20_000 };
  const anterior = { starttime: 1000, ticks: 100, atMs: 10_000 };
  const r = calcularCpuPercent(atual, anterior, HZ, 100);
  assert.equal(r.base, "media-vida", "PID reutilizado: amostras antigas não contam");
  assert.equal(r.cpu, 4);
});

test("PosixProcessProvider mantém estado entre chamadas (CPU por intervalo)", () => {
  const entradas = { "42": { stat: stat(42, "sleep", { starttime: 1000, utime: 100 }) } };
  const proc = procFalso(entradas);
  let agoraMs = BOOT_MS + 110_000;
  const fornecedor = new PosixProcessProvider({ proc, agora: () => agoraMs, sysconf: sysconfOk });
  assert.equal(fornecedor.list()[0].cpu, 1);
  proc._ficheiros.set("/proc/42/stat", stat(42, "sleep", { starttime: 1000, utime: 300 }));
  agoraMs = BOOT_MS + 115_000;
  assert.equal(fornecedor.list()[0].cpu, 40);
  assert.equal(fornecedor.constantes().hz, HZ);
});

test("analisarFiltroProcessosPosix entende os três filtros que o serviço usa", () => {
  assert.deepEqual(analisarFiltroProcessosPosix("ProcessId=42"), { tipo: "pid", pid: 42 });
  assert.deepEqual(analisarFiltroProcessosPosix("ParentProcessId=7"), { tipo: "ppid", ppid: 7 });
  assert.deepEqual(analisarFiltroProcessosPosix("Name='sleep'"), { tipo: "nome", nome: "sleep" });
  assert.deepEqual(analisarFiltroProcessosPosix("Name='O''Brien'"), { tipo: "nome", nome: "O'Brien" });
});

test("filtro que o fornecedor não sabe interpretar LANÇA, não responde «não existe»", () => {
  assert.throws(() => analisarFiltroProcessosPosix("WorkingSet>100"), /não interpretado/);
  assert.throws(() => analisarFiltroProcessosPosix("Status=S"), /não interpretado/);
});

test("consultarProcessosPosix devolve só a linha pedida e não mexe nas amostras de CPU", () => {
  const entradas = {
    "42": { stat: stat(42, "sleep", { starttime: 1000, utime: 100, ppid: 43 }) },
    "43": { stat: stat(43, "cron", { starttime: 2000, utime: 50, ppid: 1 }) },
  };
  const proc = procFalso(entradas);
  const agora = () => BOOT_MS + 110_000;
  const estado = estadoNovo();
  const opcoes = { proc, agora, sysconf: sysconfOk };

  listPosixProcesses(estado, opcoes);
  const baseline = estado.amostras.get(42).ticks;

  const peloPid = consultarProcessosPosix(estado, "ProcessId=43", opcoes);
  assert.deepEqual(peloPid.map((l) => l.pid), [43]);
  assert.equal(peloPid[0].name, "cron");
  assert.equal(peloPid[0].startedAt, new Date(BOOT_MS + 20_000).toISOString().replace(/Z$/, "0000Z"));
  assert.deepEqual(consultarProcessosPosix(estado, "Name='sleep'", opcoes).map((l) => l.pid), [42]);
  assert.deepEqual(consultarProcessosPosix(estado, "ParentProcessId=1", opcoes).map((l) => l.pid), [43]);
  assert.deepEqual(consultarProcessosPosix(estado, "ProcessId=9999", opcoes), []);
  assert.equal(estado.amostras.get(42).ticks, baseline, "consulta de identidade não desloca a base do intervalo");
});

test("cadeiaIdentia diz porque é que a terminação não pode ser autorizada", () => {
  const proc = procFalso({ "42": { stat: stat(42, "sleep") } });
  assert.deepEqual(
    new PosixProcessProvider({ proc, sysconf: sysconfOk }).cadeiaIdentia(),
    { ok: true, motivo: "ok" },
  );
  assert.deepEqual(
    new PosixProcessProvider({ proc, sysconf: (n) => (n === "CLK_TCK" ? null : PAGES) }).cadeiaIdentia(),
    { ok: false, motivo: "sem-clk-tck" },
  );
  const semBtime = procFalso({ "42": { stat: stat(42, "sleep") } });
  semBtime._ficheiros.set("/proc/stat", "cpu  1 2 3 4\n");
  assert.deepEqual(
    new PosixProcessProvider({ proc: semBtime, sysconf: sysconfOk }).cadeiaIdentia(),
    { ok: false, motivo: "sem-btime" },
  );
});
