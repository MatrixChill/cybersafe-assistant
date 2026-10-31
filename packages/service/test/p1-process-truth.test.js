/**
 * P1-PROCESS-TRUTH — o contrato de estado da enumeração de processos.
 *
 * O defeito (lido no fonte, linha 3226-3231 de engine.ts): quando a enumeração do
 * SO falha, `listProcesses()` `catch`-a e devolve `this.processes` — que ao arranque
 * é `[]` (engine.ts:566). No pipe isso é uma resposta `ok:true` com zero linhas, e o
 * `App.tsx` carimba frescura do lado do cliente. Resultado observável: o Gestor de
 * Tarefas escreve «Nenhum processo encontrado» quando na verdade o Windows nunca foi
 * ouvido. Uma lista vazia legítima e uma enumeração falhada são indistingíveis.
 *
 * Este ficheiro fixa o contrato que os distingue, do SO à interface:
 *   · `state` describe a ÚLTIMA TENTATIVA real, não a presença de linhas;
 *   · `enumeratedAt` é o instante da última foto bem-sucedida — `null` se nunca houve;
 *   · `servedFrom` diz se as linhas vêm da foto do SO ou do cache;
 *   · falhou ⇒ `state:"failed"` com `error`, nunca `ok`.
 *
 * Isolamento: base de dados injetada em tmpdir deste ficheiro (nunca o home real);
 * `engine.processMonitor.list` substituído pelo seam que os testes já usam. O único
 * caso com CIM real é o último, e é só leitura.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProtectionEngineService } from "../dist/engine.js";
import { snapshotProcesses } from "@cybersafe/native-windows";

const execFileAsync = promisify(execFile);
const TEST_BASE_DIR = mkdtempSync(path.join(os.tmpdir(), "cybersafe-p1-process-truth-"));

function entry(overrides = {}) {
  return {
    pid: 0,
    ppid: 0,
    name: "sample.exe",
    path: "",
    commandLine: "",
    cpu: 0,
    memoryMb: 0,
    user: "",
    startedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

/** Motor com uma fonte de verdade do SO controlada pelo teste. */
function engineComVerdade(truth, { falhar } = {}) {
  const engine = new ProtectionEngineService(TEST_BASE_DIR);
  const calls = { enumerations: 0 };
  engine.processMonitor.list = async () => {
    calls.enumerations += 1;
    if (falhar) throw new Error("Enumeração de processos indisponível (CIM falhou)");
    return typeof truth === "function" ? truth() : truth;
  };
  return { engine, calls };
}

describe("contrato processes.list — forma e estado", () => {
  it("a resposta traz o processo e a verdade da enumeração, não um array nu", async () => {
    const { engine } = engineComVerdade([entry({ pid: 4321, name: "a.exe" })]);
    const result = await engine.listProcesses();
    assert.ok(Array.isArray(result.processes), "result.processes é a lista");
    assert.equal(typeof result.truth, "object", "result.truth existe");
    assert.ok(
      ["never", "ok", "failed", "unreported"].includes(result.truth.state),
      `state tem de ser um dos estados do contrato, veio: ${result.truth.state}`,
    );
  });

  it("enumeração bem-sucedida: ok, servida da foto do SO, com instante da foto", async () => {
    const { engine } = engineComVerdade([entry({ pid: 1, name: "a.exe" }), entry({ pid: 2, name: "b.exe" })]);
    const { truth } = await engine.listProcesses();
    assert.equal(truth.state, "ok");
    assert.equal(truth.servedFrom, "snapshot");
    assert.ok(Number.isFinite(truth.enumeratedAt) && truth.enumeratedAt > 0, "há instante de foto");
    assert.equal(truth.attempt.ok, true);
    assert.equal(truth.attempt.error, undefined, "sem erro quando ok");
  });

  it("cache dentro da janela de frescura: servida do cache, sem re-enumerar, e continua ok", async () => {
    const { engine, calls } = engineComVerdade([entry({ pid: 11, name: "a.exe" })]);
    const primeiro = await engine.listProcesses();
    const segundo = await engine.listProcesses();
    assert.equal(calls.enumerations, 1, "três pedidos, uma enumeração (o TTL não pode mudar por causa disto)");
    assert.equal(segundo.truth.state, "ok");
    assert.equal(segundo.truth.servedFrom, "cache", "as linhas são a foto anterior");
    assert.equal(
      segundo.truth.enumeratedAt,
      primeiro.truth.enumeratedAt,
      "a idade da informação é a da FOTO, não o instante da resposta",
    );
    assert.ok(segundo.truth.asOf >= primeiro.truth.asOf, "asOf é quando a resposta foi composta");
  });

  it("NUNCA tentou: estado 'never' e enumeratedAt null (sem linhas nem afirmação)", async () => {
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    const truth = engine.processesTruth;
    assert.equal(truth.state, "never");
    assert.equal(truth.enumeratedAt, null);
    assert.equal(truth.attempt, null, "sem tentativa não há tentativa a descrever");
  });
});

describe("a mentira do arranque frio — o caso que este contrato fecha", () => {
  it("falha sem cache: state 'failed', enumeratedAt null, e NÃO é uma leitura válida vazia", async () => {
    const { engine } = engineComVerdade([], { falhar: true });
    const result = await engine.listProcesses();
    assert.deepEqual(result.processes, [], "não há linhas a servir");
    assert.equal(result.truth.state, "failed", "falhou: o estado diz que falhou");
    assert.notEqual(result.truth.state, "ok", "jamais pode ser lido como «o SO não tem processos»");
    assert.equal(result.truth.enumeratedAt, null, "nunca houve foto do SO");
    assert.match(result.truth.attempt.error.message, /CIM/, "o motivo chega à interface");
  });

  it("falha com foto anterior: linhas mantidas, origem cache, idade = foto anterior (não agora)", async () => {
    let primeiraFoto = true;
    const { engine } = engineComVerdade(() => (primeiraFoto ? [entry({ pid: 77, name: "vivo.exe" })] : []), {
      falhar: false,
    });
    const bom = await engine.listProcesses();
    primeiraFoto = false;
    engine.processesEnumeratedAt = 0; // envelhece a janela: o próximo pedido volta ao SO
    engine.processMonitor.list = async () => {
      throw new Error("Enumeração de processos indisponível (CIM falhou)");
    };
    const avariado = await engine.listProcesses();

    assert.equal(avariado.truth.state, "failed");
    assert.equal(avariado.truth.servedFrom, "cache");
    assert.ok(avariado.processes.some((p) => p.pid === 77), "as linhas anteriores não são apagadas por uma falha");
    assert.equal(
      avariado.truth.enumeratedAt,
      bom.truth.enumeratedAt,
      "a idade afirmada é a da última foto boa — o UI mostra «última leitura conhecida», não «actual»",
    );
    assert.ok(avariado.truth.asOf >= (avariado.truth.enumeratedAt ?? 0), "a resposta é de agora");
    assert.equal(avariado.truth.attempt.ok, false, "a tentativa que acabou de correr falhou");
    assert.ok(
      (avariado.truth.attempt.finishedAt ?? 0) >= (avariado.truth.enumeratedAt ?? 0),
      "o fim da tentativa é posterior à foto — a falha não reafresca nada",
    );
  });

  it("em curso: enquanto a tentativa não acaba o estado é 'in-progress', não 'ok' nem 'failed'", async () => {
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    let libertar;
    const sinal = new Promise((r) => { libertar = r; });
    engine.processMonitor.list = async () => {
      await sinal;
      return [entry({ pid: 31337, name: "depois.exe" })];
    };
    const pedido = engine.listProcesses();
    // A tentativa está em voo: este é o instante em que a UI tem de dizer
    // «a enumerar», e não «sem processos».
    const durante = engine.processesTruth;
    assert.equal(durante.state, "in-progress");
    assert.equal(durante.attempt.finishedAt, null, "a tentativa ainda não tem fim");
    assert.equal(durante.enumeratedAt, null, "e ainda não há foto");
    libertar();
    const depois = await pedido;
    assert.equal(depois.truth.state, "ok");
    assert.equal(depois.truth.servedFrom, "snapshot");
    assert.equal(depois.truth.attempt.finishedAt !== null, true, "a tentativa fechou com fim real");
  });

  it("zero linhas utilizáveis na fronteira nativa é FALHA, não lista validamente vazia", async () => {
    // O Windows com zero processos não existe; um CIM que devolve nada útil é um CIM
    // que não respondeu. A fronteira já o sabe — o contrato tem de o preservar.
    await assert.rejects(
      () => snapshotProcesses({ runPrimary: async () => "[]", enrich: async () => {} }),
      /indisponível|CIM/i,
      "snapshotProcesses rejeita em vez de afirmar «0 processos»",
    );
    const { engine } = engineComVerdade([], { falhar: true });
    const { truth } = await engine.listProcesses();
    assert.equal(truth.state, "failed", "e o motor reporta a rejeição como falha");
  });
});

describe("erro real de enumeração (sem simulacro)", () => {
  it("um PowerShell real que falha produz um erro de CIM classificado, não uma lista vazia", async () => {
    await assert.rejects(
      () =>
        snapshotProcesses({
          runPrimary: async () => {
            // Executa de facto: código de saída != 0 e stderr do Windows real.
            const { stdout } = await execFileAsync(
              "powershell.exe",
              ["-NoProfile", "-Command", "$ErrorActionPreference='Stop'; throw 'CIM indisponivel (teste)'"],
              { windowsHide: true },
            );
            return stdout;
          },
          enrich: async () => {
            throw new Error("nunca deve ser alcançado");
          },
        }),
      /indisponível|CIM/i,
    );

    const { engine } = engineComVerdade([], { falhar: true });
    const { truth } = await engine.listProcesses();
    assert.equal(truth.state, "failed");
    assert.equal(truth.attempt.error.code, "cim", "a origem do erro é classificada");
    assert.ok(truth.attempt.finishedAt >= truth.attempt.startedAt, "a tentativa tem início e fim reais");
  });

  it("CIM de verdade: enumeração real responde ok com linhas (permissões normais de utilizador)", async () => {
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    const { processes, truth } = await engine.listProcesses();
    assert.equal(truth.state, "ok", "a enumeração real do Windows funciona nesta máquina");
    assert.ok(processes.length > 20, `vieram ${processes.length} processos — esperado a lista completa do SO`);
    assert.ok(truth.enumeratedAt !== null && truth.servedFrom === "snapshot");
  });
});

describe("envelope RPC — a verdade atravessa o pipe", () => {
  it("handleRequest('processes.list') devolve result.processes e result.truth", async () => {
    const { engine } = engineComVerdade([entry({ pid: 9001, name: "a.exe" })]);
    const response = await engine.handleRequest({ id: "p1", type: "request", method: "processes.list" });
    assert.equal(response.ok, true, "a chamada foi aceite");
    assert.ok(Array.isArray(response.result.processes), "result é o objeto do contrato");
    assert.equal(response.result.truth.state, "ok");
    assert.equal(typeof response.result.truth.asOf, "number");
  });

  it("e com a enumeração a falhar a resposta continua honesta: ok:true é sobre o transporte, truth diz a verdade", async () => {
    const { engine } = engineComVerdade([], { falhar: true });
    const response = await engine.handleRequest({ id: "p2", type: "request", method: "processes.list" });
    assert.equal(response.result.truth.state, "failed");
    assert.deepEqual(response.result.processes, []);
  });
});

describe("fim-a-fim pelo pipe (cliente real da lane) — a mentira não sobrevive ao transporte", () => {
  /** Motor real com pipe de teste e raiz de dados temporária. */
  async function motorNoPipe(t, { falhar }) {
    const { randomBytes } = await import("node:crypto");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const base = mkdtempSync(path.join(os.tmpdir(), "cybersafe-p1-wire-"));
    const token = randomBytes(32).toString("hex");
    const previousToken = process.env.CYBERSAFE_PIPE_TOKEN;
    const previousMode = process.env.NODE_ENV;
    process.env.CYBERSAFE_PIPE_TOKEN = token;
    process.env.NODE_ENV = "production";
    const engine = new ProtectionEngineService(base);
    if (previousToken === undefined) delete process.env.CYBERSAFE_PIPE_TOKEN;
    else process.env.CYBERSAFE_PIPE_TOKEN = previousToken;
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
    engine.processMonitor.list = falhar
      ? async () => { throw new Error("Enumeração de processos indisponível (CIM falhou)"); }
      : async () => [entry({ pid: 4242, name: "no.pipe.exe" })];
    const pipe = process.platform === "win32"
      ? `\\\\.\\pipe\\cybersafe-p1-${process.pid}-${randomBytes(6).toString("hex")}`
      : path.join(base, "p1.sock");
    await engine.startPipeServer(pipe);
    t.after(async () => {
      try { await engine.dispose(); } catch { /* já desmontado */ }
      rmSync(base, { recursive: true, force: true });
    });
    return { engine, pipe, token, base };
  }

  it("enumeração boa: o cliente recebe linhas + idade da foto", async t => {
    const { pipe, token } = await motorNoPipe(t, { falhar: false });
    const { ServiceClient } = await import("../../desktop/src/service-client.ts");
    const client = new ServiceClient(pipe, token);
    t.after(() => client.disconnect());
    const r = await client.request("processes.list", undefined);
    assert.equal(r.truth.state, "ok");
    assert.ok(r.processes.some((p) => p.pid === 4242), "as linhas chegam");
    assert.equal(typeof r.truth.enumeratedAt, "number", "o instante da foto viaja no wire");
    assert.equal(r.truth.servedFrom, "snapshot");
  });

  it("enumeração a falhar: chega 'failed' com enumeratedAt null — nunca uma lista vazia legítima", async t => {
    const { pipe, token } = await motorNoPipe(t, { falhar: true });
    const { ServiceClient } = await import("../../desktop/src/service-client.ts");
    const client = new ServiceClient(pipe, token);
    t.after(() => client.disconnect());
    const r = await client.request("processes.list", undefined);
    assert.deepEqual(r.processes, [], "sem linhas (arranque frio)");
    assert.equal(r.truth.state, "failed", "e o wire diz que falhou");
    assert.equal(r.truth.enumeratedAt, null, "sem foto: o cliente não tem com que afirmar frescura");
    assert.match(r.truth.attempt.error.message, /CIM/);
  });
});
