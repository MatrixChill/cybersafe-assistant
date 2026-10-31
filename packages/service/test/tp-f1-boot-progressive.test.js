import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  PIPE_AUTH_VERSION,
  decodeMessages,
  encodeMessage,
  generatePipeNonce,
  isPipeNonce,
  makePipeProof,
  verifyPipeProof,
} from "@cybersafe/core";
import { ProtectionEngineService } from "../dist/engine.js";

/**
 * TP-PAP-F1-RUNTIME-20261026 — arranque progressivo.
 *
 * Fenómeno: `index.ts` corria `init()` completo (definições, quarentena,
 * assinaturas, YARA, probe ClamAV, retoma) ANTES de `startPipeServer()`. Com
 * init lento, o pipe só existia no fim e o desktop esperava pelo orçamento de
 * arranque sem uma única resposta. O motor, porém, já servia leituras sem init
 * (`qa2-service-readiness`); o que faltava era abrir o pipe antes e fechar as
 * ações que exigem init.
 *
 * Correção provada aqui:
 *  - gate → beginProgressiveStart → pipe → init (ordem no bootstrap real);
 *  - leituras seguras durante a janela; leituras dependentes de init esperam
 *    com prazo; mutações recusadas com erro estável (fail-closed);
 *  - init falha/dispose resolvem a prontidão (ninguém fica pendurado);
 *  - handshake HMAC v2 real completa durante a janela; `service-ready` só
 *    depois de init (pipe ligado nunca é proteção pronta).
 *
 * Tudo usa baseDir TEMP e pipe único. Nenhum teste toca no perfil real.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_INDEX = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const DIST_ENGINE = fs.readFileSync(new URL("../dist/engine.js", import.meta.url), "utf8");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function baseTemp(prefixo) {
  return mkdtempSync(path.join(os.tmpdir(), prefixo));
}

function guardarEnv(chaves) {
  const guardado = {};
  for (const chave of chaves) {
    guardado[chave] = process.env[chave];
    delete process.env[chave];
  }
  return guardado;
}

function restaurarEnv(guardado) {
  for (const [chave, valor] of Object.entries(guardado)) {
    if (valor === undefined) delete process.env[chave];
    else process.env[chave] = valor;
  }
}

function pipeUnico(prefixo, base) {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${prefixo}-${process.pid}-${randomBytes(6).toString("hex")}`
    : path.join(base, `${prefixo}.sock`);
}

function stubInit(engine, fn) {
  // `initInternal` é privado no TypeScript, mas o wrapper `init()` chama-o por
  // esta instância — o seam existe para os testes não pagarem um init real.
  engine.initInternal = fn;
}

test("bootstrap real: gate → progressivo → pipe → init", () => {
  const iPipe = SRC_INDEX.indexOf("await service.startPipeServer()");
  const iInit = SRC_INDEX.indexOf("await service.init()");
  const iGate = SRC_INDEX.indexOf("installDevFixtureGate(service");
  const iProgressivo = SRC_INDEX.indexOf("service.beginProgressiveStart()");
  const iValidacao = SRC_INDEX.indexOf("validarConfigWindowsReadOnly(process.env)");

  for (const [nome, i] of [["gate", iGate], ["progressivo", iProgressivo], ["pipe", iPipe], ["init", iInit], ["validacao", iValidacao]]) {
    assert.ok(i >= 0, `marcador em falta no fonte: ${nome}`);
  }
  assert.ok(iValidacao < iPipe, "a validação de leitura Windows tem de anteceder o pipe");
  assert.ok(iValidacao < iInit, "a validação de leitura Windows tem de anteceder init()");
  assert.ok(iGate < iPipe, "nenhum pedido pode chegar sem o gate de fixture em pé");
  assert.ok(iGate < iInit, "o gate de fixture tem de anteceder init()");
  assert.ok(iProgressivo < iPipe, "beginProgressiveStart() tem de anteceder o pipe");
  assert.ok(iPipe < iInit, "o pipe tem de abrir antes de init() completar");
  assert.match(DIST_ENGINE, /beginProgressiveStart\s*\(\s*\)\s*\{/, "o método tem de existir no dist");
});

test("gate: leituras seguras passam, dependentes esperam, mutações recusadas; init liberta", async (t) => {
  const env = guardarEnv(["NODE_ENV", "CYBERSAFE_USB_PROTECTION", "CYBERSAFE_STARTUP_RESUME"]);
  process.env.NODE_ENV = "test";
  process.env.CYBERSAFE_USB_PROTECTION = "0";
  process.env.CYBERSAFE_STARTUP_RESUME = "0";
  const base = baseTemp("cs-f1-gate-");
  const engine = new ProtectionEngineService(base);
  t.after(async () => {
    await engine.dispose().catch(() => undefined);
    rmSync(base, { recursive: true, force: true });
    restaurarEnv(env);
  });

  // Contrato herdado: sem modo progressivo o motor serve sem init().
  assert.equal(engine.ready, true);
  assert.equal(engine.startupState, "legacy");
  const protecaoDefault = await engine.dispatch("protection.getState", undefined);
  assert.ok(protecaoDefault && typeof protecaoDefault === "object" && "status" in protecaoDefault);

  engine.beginProgressiveStart();
  assert.equal(engine.ready, false);
  assert.equal(engine.startupState, "starting");

  // Leituras seguras: resposta imediata, sem esperar por init. Só as que não
  // afirmam saúde/histórico/exclusões/intenção (R1).
  const imediatas = await Promise.all([
    engine.dispatch("events.list", { limit: 5 }),
    engine.dispatch("threats.list", undefined),
    engine.dispatch("scan.getActive", undefined),
  ]);
  assert.ok(Array.isArray(imediatas[0]));
  assert.ok(Array.isArray(imediatas[1]));
  assert.equal(imediatas[2], null);

  // R1: saúde/histórico/exclusões/intenção dependem de leituras reais do init.
  // Têm de ficar pendentes, não devolver um "saudável/vazio" inventado.
  let initSettled = false;
  stubInit(engine, async () => {
    await sleep(120);
    initSettled = true;
  });
  const initEmVoo = engine.init();
  const pendentes = [
    engine.dispatch("protection.getState", undefined),
    engine.dispatch("quarantine.list", undefined),
    engine.dispatch("exclusions.get", undefined),
    engine.dispatch("scan.history", { limit: 5 }),
    engine.dispatch("protectionIntent.get", undefined),
  ];
  await sleep(30);
  assert.equal(initSettled, false, "init ainda está em curso");
  assert.equal(engine.ready, false);
  await initEmVoo;
  const [protecao, quarentena, exclusoes, historico, intencao] = await Promise.all(pendentes);
  assert.ok(protecao && typeof protecao === "object" && "status" in protecao);
  assert.ok(Array.isArray(quarentena), "quarentena.list resolve depois de init");
  assert.ok(exclusoes && Array.isArray(exclusoes.paths));
  assert.ok(historico && (Array.isArray(historico) || Array.isArray(historico.entries)));
  assert.ok(intencao && typeof intencao === "object");
  assert.equal(protecao.engine?.osLayerHealthy, true, "depois de init a leitura real é healthy");
  assert.equal(engine.ready, true, "init resolve a prontidão");
  assert.equal(engine.startupState, "ready");
});

test("mutações e métodos desconhecidos são recusados durante a janela (fail-closed)", async (t) => {
  const env = guardarEnv(["NODE_ENV"]);
  process.env.NODE_ENV = "test";
  const base = baseTemp("cs-f1-mut-");
  const engine = new ProtectionEngineService(base);
  t.after(async () => {
    await engine.dispose().catch(() => undefined);
    rmSync(base, { recursive: true, force: true });
    restaurarEnv(env);
  });

  engine.beginProgressiveStart();
  const mutacoes = [
    ["monitor.start", undefined],
    ["monitor.stop", undefined],
    ["scan.artifact", { path: os.tmpdir() }],
    ["scan.fullSystem", undefined],
    ["scan.cancel", { id: "x" }],
    ["quarantine.restore", { id: "x" }],
    ["quarantine.delete", { id: "x" }],
    ["definitions.update", undefined],
    ["process.killTree", { pid: 1 }],
    ["process.analyze", { pid: 1 }],
    ["analysis.restricted", { path: os.tmpdir() }],
    ["threat.action", { id: "x", action: "quarantine" }],
    ["protectionIntent.setOptIn", { enabled: true }],
    ["exclusions.update", { paths: [] }],
    ["trust.allowHash", { sha256: "a".repeat(64) }],
    ["trust.allowPublisher", { publisher: "x" }],
    ["metodo.desconhecido", undefined],
  ];
  for (const [metodo, payload] of mutacoes) {
    await assert.rejects(
      engine.dispatch(metodo, payload),
      (error) => {
        assert.match(String(error?.message ?? error), /a arrancar/i, `${metodo}: mensagem estável`);
        assert.equal(error?.code, "SERVICE_STARTING", `${metodo}: código estável`);
        return true;
      },
      `${metodo} tem de ser recusado durante a janela`,
    );
  }

  // init termina e as mesmas ações deixam de ser recusadas pelo gate.
  stubInit(engine, async () => undefined);
  await engine.init();
  const depois = await Promise.allSettled([
    engine.dispatch("monitor.stop", undefined),
    engine.dispatch("exclusions.update", { paths: [] }),
  ]);
  for (const r of depois) {
    if (r.status === "rejected") {
      assert.doesNotMatch(String(r.reason?.message ?? r.reason), /a arrancar/i);
    }
  }
});

test("init falha: a prontidão não fica pendurada e o gate recusa com causa", async (t) => {
  const env = guardarEnv(["NODE_ENV"]);
  process.env.NODE_ENV = "test";
  const base = baseTemp("cs-f1-fail-");
  const engine = new ProtectionEngineService(base);
  t.after(async () => {
    await engine.dispose().catch(() => undefined);
    rmSync(base, { recursive: true, force: true });
    restaurarEnv(env);
  });

  engine.beginProgressiveStart();
  stubInit(engine, async () => {
    throw new Error("init de teste falhou");
  });
  await assert.rejects(engine.init(), /init de teste falhou/);
  assert.equal(engine.ready, false);
  assert.equal(engine.startupState, "failed");
  await assert.rejects(
    engine.dispatch("protection.getState", undefined),
    (error) => {
      assert.equal(error?.code, "SERVICE_STARTUP_FAILED");
      assert.match(String(error?.message), /inicialização falhou/i);
      return true;
    },
  );
  await assert.rejects(engine.dispatch("quarantine.list", undefined), /inicialização falhou/i);
});

test("dispose durante a janela: leitura pendente é rejeitada, sem promise pendurada", async (t) => {
  const env = guardarEnv(["NODE_ENV"]);
  process.env.NODE_ENV = "test";
  const base = baseTemp("cs-f1-dispose-");
  const engine = new ProtectionEngineService(base);
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
    restaurarEnv(env);
  });

  engine.beginProgressiveStart();
  let initReject;
  stubInit(engine, () => new Promise((_, reject) => { initReject = reject; }));
  const initEmVoo = engine.init();
  const pendente = engine.dispatch("quarantine.list", undefined);
  await sleep(20);
  await engine.dispose();
  assert.equal(engine.startupState, "disposed");
  assert.equal(engine.ready, false);
  initReject?.(new Error("init abortado pelo dispose"));
  await initEmVoo.catch(() => undefined);
  await assert.rejects(pendente, (error) => {
    assert.equal(error?.code, "SERVICE_DISPOSED");
    assert.match(String(error?.message), /a encerrar/i);
    return true;
  });
});

test("R1: getProtectionState não afirma saúde antes de init", async (t) => {
  const env = guardarEnv(["NODE_ENV", "CYBERSAFE_USB_PROTECTION", "CYBERSAFE_STARTUP_RESUME"]);
  process.env.NODE_ENV = "test";
  process.env.CYBERSAFE_USB_PROTECTION = "0";
  process.env.CYBERSAFE_STARTUP_RESUME = "0";
  const base = baseTemp("cs-f1-r1-health-");
  const engine = new ProtectionEngineService(base);
  t.after(async () => {
    await engine.dispose().catch(() => undefined);
    rmSync(base, { recursive: true, force: true });
    restaurarEnv(env);
  });

  engine.beginProgressiveStart();
  const estado = engine.getProtectionState();
  assert.equal(estado.engine.osLayerHealthy, false, "sem leitura real não há saúde afirmada");
  assert.equal(estado.engine.anyEngineDegraded, true);
  assert.match(String(estado.engine.degradedReasons.join(" ")), /arranque|não foi confirmada/i);
  assert.equal(estado.protectionEnabled, false);
  assert.equal(estado.status, "critical", "OFF durante o arranque nunca é 'protected'");
});

test("R1: dispose durante init não deixa init declarar ready nem serviço pronto", async (t) => {
  const env = guardarEnv(["NODE_ENV"]);
  process.env.NODE_ENV = "test";
  const base = baseTemp("cs-f1-r1-dispose-init-");
  const engine = new ProtectionEngineService(base);
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
    restaurarEnv(env);
  });

  engine.beginProgressiveStart();
  let release;
  stubInit(engine, () => new Promise((resolve) => { release = resolve; }));
  const initEmVoo = engine.init();
  await sleep(20);
  await engine.dispose();
  assert.equal(engine.startupState, "disposed");
  release();
  await assert.rejects(initEmVoo, (error) => {
    assert.equal(error?.code, "SERVICE_DISPOSED");
    return true;
  });
  assert.equal(engine.startupState, "disposed", "init tardio não pode voltar a ready");
  assert.equal(engine.ready, false);
});

test("protocolo real: HMAC v2 durante a janela; leitura e mutação com desfechos distintos", async (t) => {
  const env = guardarEnv(["NODE_ENV", "CYBERSAFE_PIPE_TOKEN", "CYBERSAFE_USB_PROTECTION", "CYBERSAFE_STARTUP_RESUME"]);
  const token = randomBytes(32).toString("hex");
  process.env.NODE_ENV = "production";
  process.env.CYBERSAFE_PIPE_TOKEN = token;
  process.env.CYBERSAFE_USB_PROTECTION = "0";
  process.env.CYBERSAFE_STARTUP_RESUME = "0";

  const base = baseTemp("cs-f1-pipe-");
  const engine = new ProtectionEngineService(base);
  const pipe = pipeUnico("cybersafe-f1", base);
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) { try { s.destroy(); } catch {} }
    await engine.dispose().catch(() => undefined);
    rmSync(base, { recursive: true, force: true });
    restaurarEnv(env);
  });

  engine.beginProgressiveStart();
  assert.equal(engine.ready, false);
  await engine.startPipeServer(pipe);

  async function conectar() {
    const socket = net.createConnection(pipe);
    sockets.push(socket);
    socket.on("error", () => {});
    const mensagens = [];
    let buffer = "";
    socket.on("data", (chunk) => {
      const decoded = decodeMessages(buffer + chunk.toString());
      buffer = decoded.rest;
      mensagens.push(...decoded.messages);
    });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    async function proximo(predicado, prazoMs = 3000) {
      const prazo = Date.now() + prazoMs;
      while (Date.now() < prazo) {
        const mensagem = mensagens.find(predicado);
        if (mensagem) return mensagem;
        await sleep(5);
      }
      throw new Error("resposta em falta");
    }
    return { socket, proximo };
  }

  async function handshake(c) {
    const clientNonce = generatePipeNonce();
    c.socket.write(encodeMessage({ type: "auth-hello", v: PIPE_AUTH_VERSION, nonce: clientNonce }));
    const desafio = await c.proximo((m) => m.type === "auth-challenge");
    assert.equal(desafio.v, PIPE_AUTH_VERSION);
    assert.equal(isPipeNonce(desafio.nonce), true);
    assert.equal(verifyPipeProof(token, "server", clientNonce, desafio.nonce, desafio.proof), true);
    c.socket.write(encodeMessage({
      type: "auth-response",
      v: PIPE_AUTH_VERSION,
      proof: makePipeProof(token, "client", clientNonce, desafio.nonce),
    }));
    const ack = await c.proximo((m) => m.type === "auth");
    assert.equal(ack.ok, true, "auth-ok durante a janela");
  }

  const t0 = performance.now();
  const c = await conectar();
  await handshake(c);
  assert.ok(performance.now() - t0 < 2000, "handshake não pode esperar por init");

  // Leitura segura da janela: events.list não depende de init. A proteção
  // (saúde real) fica para depois de init — ver teste de gate acima.
  c.socket.write(encodeMessage({ id: "req-read", type: "request", method: "events.list", payload: { limit: 5 } }));
  const leitura = await c.proximo((m) => m.type === "response" && m.id === "req-read");
  assert.equal(leitura.ok, true);
  assert.ok(Array.isArray(leitura.result));

  c.socket.write(encodeMessage({ id: "req-mut", type: "request", method: "monitor.start", payload: undefined }));
  const mutacao = await c.proximo((m) => m.type === "response" && m.id === "req-mut");
  assert.equal(mutacao.ok, false);
  assert.match(String(mutacao.error ?? ""), /a arrancar/i);
});
