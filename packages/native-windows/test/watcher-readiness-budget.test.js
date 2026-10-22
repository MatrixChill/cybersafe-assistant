import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { IsolatedFileWatcher } from "../dist/watcher-process.js";

/**
 * P0 WATCHER (15/10) — prontidão e orçamento, com duplo de `fork` BENIGNO.
 * Asserts propostos pela análise independente do OpenCode (WATCHER-READONLY-
 * ANALYSIS.md, item 3), escritos contra o código em produção: nada de Electron,
 * nada de chokidar, nada de API do Windows.
 *
 * O que estas provas prendem é a SEMÂNTICA, porque foi a semântica que rebentou
 * no Windows físico: `ready` é "o sistema de ficheiros está a vigiar", `started`
 * é apenas "o filho acordou", e um timeout não pode apagar o que o filho já
 * disse.
 */

function criarFilhoEstubao(comportamento) {
  const filho = new EventEmitter();
  const recebidos = [];
  Object.assign(filho, { pid: 4242, connected: true, exitCode: null, signalCode: null });
  filho.send = (mensagem, callback) => {
    recebidos.push(mensagem);
    if (comportamento.erroAoEnviar) {
      callback?.(new Error("Channel closed"));
      return false;
    }
    callback?.();
    queueMicrotask(() => comportamento.aoReceber?.(filho, mensagem));
    return true;
  };
  filho.kill = () => {
    filho.exitCode = null;
    filho.signalCode = "SIGKILL";
    filho.emit("exit", null, "SIGKILL");
  };
  return { filho, recebidos };
}

function watcherCom(filho, orcamento = 250) {
  return new IsolatedFileWatcher({
    childScript: "stub://filho",
    forkImpl: () => filho,
    startupBudgetMs: orcamento,
  });
}

const respostas = {
  ...{
    soStarted: (f) => f.emit("message", { type: "started", raizes: 6 }),
    startedEReady: (f) => {
      f.emit("message", { type: "started", raizes: 6 });
      f.emit("message", { type: "ready", raizes: 6 });
    },
    soReady: (f) => f.emit("message", { type: "ready", raizes: 6 }),
    nada: () => undefined,
    saiCom7: (f) => {
      f.exitCode = 7;
      f.emit("exit", 7, null);
    },
    erroASeguirAStarted: (f) => {
      f.emit("message", { type: "started", raizes: 6 });
      f.emit("message", { type: "ready", raizes: 6 });
      setTimeout(() => f.emit("message", { type: "error", message: "EPERM em C:/x", code: "EPERM", path: "C:/x" }), 20);
    },
  },
};

test("(a) `started` sozinho NAO resolve: rejeita com timeout e respeita o orcamento", async () => {
  const { filho } = criarFilhoEstubao({ aoReceber: respostas.soStarted });
  const w = watcherCom(filho, 250);
  const inicio = Date.now();
  await assert.rejects(w.start(["C:/qualquer"]), (erro) => {
    assert.match(erro.message, /timed out/);
    assert.match(erro.message, /started/, "o diagnostico tem de dizer o que o filho já tinha dito");
    assert.doesNotMatch(erro.message, /exited/, "um timeout limpo nao se disfarca de saida");
    return true;
  });
  assert.ok(Date.now() - inicio >= 200, `rejeitou cedo demais (${Date.now() - inicio}ms)`);
  assert.equal(w.pid, undefined, "(g) sem orfaos: pid tem de sumir depois de um start falhado");
});

test("(b) `ready` resolve e emite ready exatamente uma vez", async () => {
  const { filho } = criarFilhoEstubao({ aoReceber: respostas.startedEReady });
  const w = watcherCom(filho);
  const prontos = [];
  w.on("ready", (info) => prontos.push(info));
  await w.start(["C:/a"]);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(prontos.length, 1, "prontidade duplicada enganaria a UI/telemetria");
  assert.equal(typeof prontos[0].elapsedMs, "number");
});

test("(c) filho que sai antes do ready da SAIDA, nao timeout", async () => {
  const { filho } = criarFilhoEstubao({ aoReceber: respostas.saiCom7 });
  const w = watcherCom(filho, 1000);
  await assert.rejects(w.start(["C:/a"]), (erro) => {
    assert.match(erro.message, /exited \(7\)/);
    assert.doesNotMatch(erro.message, /timed out/);
    return true;
  });
});

test("(d) `ready` sem `started` continua a resolver (nada depende do ack intermedio)", async () => {
  const { filho } = criarFilhoEstubao({ aoReceber: respostas.soReady });
  const w = watcherCom(filho);
  await w.start(["C:/a"]);
  assert.equal(w.pid, 4242);
});

test("(e) o start e entregue com os caminhos pedidos, ecoados ao filho", async () => {
  const { filho, recebidos } = criarFilhoEstubao({ aoReceber: respostas.startedEReady });
  const w = watcherCom(filho);
  const caminhos = ["C:/Users/x/Downloads", "C:/Users/x/Desktop"];
  await w.start(caminhos);
  assert.deepEqual(recebidos[0], { type: "start", paths: caminhos });
  assert.equal(JSON.stringify(recebidos[0].paths), JSON.stringify(caminhos), "os paths tem de chegar inalterados");
});

test("(f) fail-fast: canal fechado da erro do send, nao um timeout", async () => {
  const { filho } = criarFilhoEstubao({ erroAoEnviar: true, aoReceber: respostas.nada });
  const w = watcherCom(filho, 1000);
  await assert.rejects(w.start(["C:/a"]), (erro) => {
    assert.match(erro.message, /Channel closed/);
    assert.doesNotMatch(erro.message, /timed out/);
    return true;
  });
});

test("(h) started+ready no mesmo tick: resolve uma vez e nao rejeita depois", async () => {
  const { filho } = criarFilhoEstubao({ aoReceber: respostas.startedEReady });
  const w = watcherCom(filho, 300);
  const rejeicoes = [];
  w.on("error", (e) => rejeicoes.push(e));
  await w.start(["C:/a"]);
  await new Promise((r) => setTimeout(r, 400)); // para lá do orcamento: nada pode rebentar depois
  assert.equal(rejeicoes.length, 0, `nada pode ser emitido apos a prontidao: ${rejeicoes.map((e) => e.message).join(" | ")}`);
});

test("erro do filho APOSES o ready e um evento, nao uma falha de arranque", async () => {
  const { filho } = criarFilhoEstubao({ aoReceber: respostas.erroASeguirAStarted });
  const w = watcherCom(filho, 1000);
  const eventos = [];
  w.on("error", (e) => eventos.push(e));
  await w.start(["C:/a"]);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(eventos.length, 1);
  assert.match(eventos[0].message, /EPERM em C:\/x/);
  assert.equal(eventos[0].code, "EPERM");
});

test("orcamento default continua a ser os 10 000 ms medidos (sem alavancas)", async () => {
  const w = new IsolatedFileWatcher({ childScript: "stub://x", forkImpl: () => new EventEmitter() });
  assert.equal(w.startupBudgetMs, 10_000);
});

/* ── os dois asserts que a verificacao do OpenCode pediu (adenda 15/10) ───── */

test("(i) ready DUPLICADO nao duplica a prontidao", async () => {
  const { filho } = criarFilhoEstubao({
    aoReceber: (f) => {
      f.emit("message", { type: "ready", raizes: 6 });
      f.emit("message", { type: "ready", raizes: 6 });
      f.emit("message", { type: "ready", raizes: 6 });
    },
  });
  const w = watcherCom(filho, 1000);
  const prontos = [];
  w.on("ready", () => prontos.push(1));
  await w.start(["C:/a"]);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(prontos.length, 1, `prontidao emitida ${prontos.length} vezes — a UI contaria arranques falsos`);
});

test("(ii) segundo start() com vigilancia ativa substitui sem rejeicao nem 6os", async () => {
  const primeira = criarFilhoEstubao({ aoReceber: respostas.startedEReady });
  const segunda = criarFilhoEstubao({ aoReceber: respostas.startedEReady });
  const filhos = [primeira.filho, segunda.filho];
  let index = 0;
  const w = new IsolatedFileWatcher({
    childScript: "stub://filho",
    forkImpl: () => filhos[index++],
    startupBudgetMs: 1000,
  });
  const paradas = [];
  w.on("error", (e) => paradas.push(e.message));

  await w.start(["C:/a"]);
  assert.equal(primeira.filho.connected, true);
  await w.start(["C:/b"]); // segunda ativaao com a primeira ainda viva

  assert.equal(index, 2, "o segundo start tinha de montar um filho novo");
  assert.equal(paradas.length, 0, `nada pode rebentar numa substituicao limpa: ${paradas.join(" | ")}`);
  assert.equal(segunda.filho.connected, true);
});

/* ── buraco de cobertura: o filho perdeu eventos, ou a raiz morreu ─────────
   O sinal tem de chegar como DEGRADACAO. O canal de erro do motor faz
   `stopProtection()` (engine.ts), entao um gap tratado como erro derrubaria a
   protecao inteira por uma pasta desaparecida — o oposto do que se quer. */

test("gap do filho vira 'coverage', nunca erro nem falha de arranque", async () => {
  const { filho } = criarFilhoEstubao({
    aoReceber: (f) => {
      f.emit("message", { type: "started", raizes: 6 });
      f.emit("message", { type: "ready", raizes: 6 });
      setTimeout(() => f.emit("message", {
        type: "gap", motivo: "overflow", path: "C:/Users/x/Desktop", eventosSemNome: 41,
        message: "a janela transbordou",
      }), 5);
      setTimeout(() => f.emit("message", {
        type: "gap", motivo: "raiz-desaparecida", path: "C:/Users/x/Downloads", eventosSemNome: 0,
        message: "deixou de existir",
      }), 10);
    },
  });
  const w = watcherCom(filho, 1000);
  const erros = [];
  const coberturas = [];
  w.on("error", (e) => erros.push(e.message));
  w.on("coverage", (info) => coberturas.push(info));

  await w.start(["C:/a"]);
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(erros.length, 0, `gap nao e erro de motor: ${erros.join(" | ")}`);
  assert.equal(coberturas.length, 2);
  assert.deepEqual(
    coberturas.map((c) => `${c.motivo}:${c.path}:${c.eventosSemNome}`).sort(),
    ["overflow:C:/Users/x/Desktop:41", "raiz-desaparecida:C:/Users/x/Downloads:0"],
  );
});

test("falhas de attach viajam no ready e sao registadas ANTES de resolver", async () => {
  const { filho } = criarFilhoEstubao({
    aoReceber: (f) => {
      f.emit("message", { type: "started", raizes: 2 });
      f.emit("message", {
        type: "ready", raizes: 2,
        falhas: [{ path: "C:/nao-existe", message: "ENOENT" }],
        aviso: "1 raizes nao ficaram vigiadas: C:/nao-existe",
      });
    },
  });
  const w = watcherCom(filho, 1000);
  const ordem = [];
  w.on("coverage", (i) => ordem.push("coverage:" + i.motivo + ":" + i.path));
  w.on("ready", () => ordem.push("ready"));
  await w.start(["C:/a", "C:/nao-existe"]);
  ordem.push("resolveu");
  // A ORDEM e o ponto: se o coverage vier depois do resolve, o agregado publica
  // monitoredPaths com a raiz morta la dentro — foi o buraco medido pelo OpenCode.
  assert.deepEqual(ordem, ["coverage:raiz-inacessivel:C:/nao-existe", "ready", "resolveu"]);
});

test("gap ANTES do ready nao pode confirmar a proteção", async () => {
  const { filho } = criarFilhoEstubao({
    aoReceber: (f) => {
      f.emit("message", { type: "gap", motivo: "overflow", path: "C:/a", eventosSemNome: 3, message: "sem nomes" });
      // …e nunca chega o ready: o arranque tem de falhar pelo orcamento, nao
      // resolver por uma degradacao ter sido comunicada.
    },
  });
  const w = watcherCom(filho, 300);
  const coberturas = [];
  w.on("coverage", (i) => coberturas.push(i));
  await assert.rejects(w.start(["C:/a"]), /timed out/);
  assert.equal(coberturas.length, 0, "um gap de um filho que nunca ficou pronto nao e cobertura de algo que vigie");
});
