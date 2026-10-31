import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { ProtectionEngineService } from "../dist/engine.js";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";

/**
 * P0 ISOLAMENTO DE RUNTIME: raiz de dados INJETADA num tmpdir deste ficheiro.
 * Sem isto, qualquer `killProcess` num teste faria appendFile em
 * `%USERPROFILE%\.cybersafe-service\logs\actions.log` — o home real do
 * utilizador. `new ProtectionEngineService(TEST_BASE_DIR)` sem argumentos continua a
 * significar "home real" (default de PRODUÇÃO); em teste passa-se o tmpdir.
 * Ver test/p0-runtime-isolation.test.js.
 */
const TEST_BASE_DIR = mkdtempSync(path.join(os.tmpdir(), "cybersafe-p0-kill-budget-"));

/**
 * Compatibilidade dos cenários legados: a lista é injetada à mão e o alvo do
 * teste é o orçamento, não a frescura da foto (coberta em tp-f1-r1-identity).
 * Uma cache injetada sem `processesPhotoAt` é tratada como foto do instante
 * da injeção.
 *
 * R2 (FINDING-FRESH-PID-REUSE): a foto já não dispensa a revalidação — quem
 * chega ao taskkill fixa o mock de `queryCimProcesses` com o MESMO dono do
 * snapshot. Nenhum caminho de produto passa por este wrapper.
 */
const killProcessReal = ProtectionEngineService.prototype.killProcess;
ProtectionEngineService.prototype.killProcess = function killProcessComFotoDeTeste(...args) {
  if (this.processesPhotoAt === 0 && this.processes.length > 0) {
    this.processesPhotoAt = Date.now();
  }
  return killProcessReal.apply(this, args);
};


/**
 * P4 — orçamento global do kill.
 *
 * Diagnóstico que originou isto: o renderer desiste aos 15 000 ms
 * (packages/app/src/lib/processActions.ts: KILL_TIMEOUT_MS) e o serviço podia
 * legitimamente levar 27–33 s, porque cada etapa tinha o seu timeout
 * independente e todos eram ADITIVOS. Pior: o deadline do reap (5 s) não
 * limitava a sua própria probe — em packages/core/src/response.ts a probe é
 * awaited (407) e o deadline só é verificado depois (411), pelo que uma query
 * CIM de 6 s a meio do loop transbordava.
 *
 * A correção é um deadline só, com cada etapa a receber `remaining()`. Estes
 * testes travam três coisas:
 *   1. as constantes respeitam o contrato com o renderer (pior caso < 15 s);
 *   2. o total é mesmo limitado, mesmo com as etapas a gastarem tudo o que
 *      lhes é concedido — e o desfecho continua honesto (`timeout`, nunca
 *      `killed` falso);
 *   3. o reap ainda confirma a morte no caso típico — encolher o reap não pode
 *      fabricar `still-running`.
 *
 * Sem spawn real na maioria dos testes: as seams (`queryCimProcesses`,
 * `runTaskkill`) são substituídas, o que é o mesmo mecanismo que
 * process-kill.test.js usa. O reap é exercitado com um filho real vivo.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * O prazo do renderer e lido do FICHEIRO, nunca copiado para aqui: uma copia
 * deixa os dois lados divergir em silencio (foi o que escondeu o buraco de
 * 15 000 vs 12 000). O renderer deriva o prazo do mesmo orçamento, por isso
 * aqui só se leem as parcelas e se compara a soma.
 */
function readRendererBudget() {
  const source = readFileSync(new URL("../../app/src/lib/processActions.ts", import.meta.url), "utf8");
  const part = (name) => {
    const match = source.match(new RegExp(`const ${name} = ([\\d_]+);`));
    assert.ok(match, `processActions.ts perdeu a parcela ${name} do prazo do renderer`);
    return Number(match[1].replace(/_/g, ""));
  };
  return {
    serviceBudget: part("KILL_SERVICE_TOTAL_BUDGET_MS"),
    reapFloor: part("KILL_REAP_FLOOR_MS"),
    pipeMargin: part("KILL_PIPE_MARGIN_MS"),
  };
}

function processEntry(overrides) {
  return {
    pid: 0,
    ppid: 0,
    name: "alvo.exe",
    path: "",
    commandLine: "alvo.exe",
    cpu: 0,
    memoryMb: 0,
    startedAt: new Date().toISOString(),
    trusted: "unknown",
    ...overrides,
  };
}

const okTaskkill = async () => ({
  ok: true,
  status: "ok",
  exitCode: 0,
  stdout: "SUCCESS: terminated.",
  stderr: "",
});

describe("P4 — orçamento global do kill", () => {
  it("1. as constantes respeitam o contrato com o renderer, mesmo no pior caso", () => {
    const total = ProtectionEngineService.KILL_TOTAL_BUDGET_MS;
    const floor = ProtectionEngineService.KILL_REAP_FLOOR_MS;
    const renderer = readRendererBudget();
    const rendererTimeout = renderer.serviceBudget + renderer.reapFloor + renderer.pipeMargin;

    // As parcelas nao podem ser numeros diferentes: o renderer deriva o prazo
    // das mesmas que o servico usa.
    assert.equal(
      renderer.serviceBudget,
      total,
      `o renderer assume ${renderer.serviceBudget} ms de orçamento, o servo tem ${total}`,
    );
    assert.equal(renderer.reapFloor, floor, `o renderer assume um piso de ${renderer.reapFloor} ms, o servo tem ${floor}`);
    assert.ok(
      renderer.pipeMargin >= 1_000,
      `margem de pipe de ${renderer.pipeMargin} ms e curta demais para o invoke + fila do handler`,
    );
    // O reap pode ultrapassar o `remaining` ate ao piso, por isso o pior caso
    // absoluto e orcamento + piso. Tem de caber no prazo do renderer.
    assert.ok(
      total + floor < rendererTimeout,
      `pior caso ${total + floor} ms nao cabe nos ${rendererTimeout} ms do renderer`,
    );
    // O piso tem de ser suficiente para as confirmações que a reconciliação
    // exige: `killProbeConfirmations` ausências CIM, espaçadas por
    // `killProbeMinIntervalMs` (~500 ms) → ~1–1.5 s, logo o piso de 2 s
    // deixa margem. Encolher abaixo disto fabricaria `still-running` falsos.
    assert.ok(floor >= 2_000, `piso de ${floor} ms e insuficiente para as confirmações do reap`);
  });

  it("1b. a espera entre tentativas tambem come orçamento (nada gasta fora do deadline)", async () => {      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    const BUDGET = 700;
    try {
      // O alvo tem de vir do snapshot (referência do utilizador); sem cache a
      // R1 recusa antes do taskkill. A frescura da foto é do instante da
      // injeção (wrapper de compatibilidade).
      const row = processEntry({ pid: child.pid, name: "vivo.exe", commandLine: "vivo.exe" });
      engine.processes = [row];
      // taskkill falha e o SO diz que o alvo esta vivo: a segunda tentativa e
      // tentada, e a espera entre as duas nao pode passar do deadline.
      engine.queryCimProcesses = async (filter) => {
        if (!filter.startsWith("ProcessId=")) return [];
        await sleep(10);
        return [row];
      };
      let attempts = 0;
      engine.runTaskkill = async (pid) => {
        attempts += 1;
        return { ok: false, status: "failed", pid, exitCode: 255, stdout: "", stderr: "ERRO: nao possivel terminar." };
      };

      ProtectionEngineService.KILL_TOTAL_BUDGET_MS = BUDGET;
      const started = Date.now();
      const result = await engine.killProcess(child.pid);
      const elapsed = Date.now() - started;
      ProtectionEngineService.KILL_TOTAL_BUDGET_MS = 12_000;

      assert.ok(attempts >= 1, `o taskkill tem de correr, correu ${attempts}`);
      assert.ok(
        elapsed <= BUDGET + ProtectionEngineService.KILL_REAP_FLOOR_MS,
        `elapsed ${elapsed} ms acima do orcamento ${BUDGET} + piso`,
      );
      assert.equal(result.success, false, "o SO disse que o alvo continua vivo: nada de sucesso inventado");
    } finally {
      child.kill();
    }
  });

  it("2. o total é limitado mesmo com as etapas a gastarem tudo o que lhes é concedido", async () => {
    // PID tem de ESTAR VIVO: um PID inexistente faz o kill curto-circuitar em
    // `already-exited` antes de qualquer etapa (e o orçamento) ser consumido.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    const BUDGET = 900;
    const PER_STAGE = BUDGET / 3;
    try {
      const target = processEntry({ pid: child.pid, name: "vivo.exe", commandLine: "vivo.exe" });
      engine.processes = [target];
      let calls = 0;
      // Cada seam gasta até `PER_STAGE`, e o que lhe é concedido é o que
      // resta do orçamento. Se a soma não estivesse limitada, o elapsed
      // escalaria acima do renderer conforme as etapas se acumulam.
      const granted = [];
      engine.queryCimProcesses = async (filter, timeoutMs) => {
        const budget = timeoutMs ?? ProtectionEngineService.CIM_QUERY_TIMEOUT_MS;
        granted.push(budget);
        await sleep(Math.min(budget, PER_STAGE));
        calls += 1;
        // 1ª chamada = lookup do alvo; as seguintes = probes do reap, que já
        // não o veem (a morte foi confirmada).
        return calls === 1 ? [target] : [];
      };
      engine.runTaskkill = async (_pid, options) => {
        granted.push(options?.timeoutMs);
        await sleep(Math.min(options?.timeoutMs ?? 0, PER_STAGE));
        return { ok: true, status: "ok", exitCode: 0, stdout: "", stderr: "" };
      };

      ProtectionEngineService.KILL_TOTAL_BUDGET_MS = BUDGET;
      const started = Date.now();
      const result = await engine.killProcess(child.pid);
      const elapsed = Date.now() - started;
      ProtectionEngineService.KILL_TOTAL_BUDGET_MS = 12_000;

      assert.ok(granted.length >= 2, `deviam correr várias etapas, correram ${granted.length}`);

      // Nenhuma etapa recebeu mais do que o orçamento total — este é o núcleo
      // do P4: o que deixou de existir foi a soma de budgets independentes.
      // `0` é legítimo: significa "sem orçamento, não gastes tempo nisto" — a
      // reconciliação continua a depender do piso, não desta probe.
      for (const budget of granted) {
        assert.ok(typeof budget === "number", `timeout ausente: ${budget}`);
        assert.ok(
          budget >= 0 && budget <= BUDGET,
          `etapa recebeu ${budget} ms, fora do orçamento de [0, ${BUDGET}] ms`,
        );
      }

      // O total cabe no orçamento (+ o piso do reap).
      assert.ok(
        elapsed <= BUDGET + ProtectionEngineService.KILL_REAP_FLOOR_MS,
        `elapsed ${elapsed} ms acima do orçamento ${BUDGET} + piso`,
      );

      // NOTA sobre `killed` depois de o orçamento acabar: isso é CORRECTO e
      // pretendido. O reap pode transbordar `remaining` até ao piso, e é
      // precisamente isso que lhe permite confirmar a morte em vez de desistir.
      // O `killed` é então verdadeiro. O que jamais pode acontecer é um
      // `killed` sem confirmação — daí exigir, abaixo, que o reap viu mesmo o
      // processo desaparecer. É essa a garantia de honestidade, não a
      // wall-clock.
      assert.ok(["killed", "timeout"].includes(result.status), `desfecho inesperado: ${result.status}`);
      if (result.status === "killed") {
        assert.ok(
          calls - 1 >= 2,
          `anunciou killed com ${calls - 1} confirmações CIM — o reap não confirmou a morte`,
        );
        assert.equal(result.success, true);
      } else {
        assert.equal(result.success, false);
        assert.match(result.error ?? "", /Orçamento|ainda ativo/i, "a mensagem tem de ser a real");
      }
    } finally {
      child.kill();
    }
  });

  it("3. o reap ainda confirma a morte no caso típico (não regrediu por encolher)", async () => {
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    // PID inexistente → `isProcessAlive` falso, o reap confirma à primeira.
    // R2: a fonte confirma o alvo antes da ação (mesmo dono do snapshot).
    const row = processEntry({ pid: 42001, name: "morto.exe", commandLine: "morto.exe" });
    engine.processes = [row];
    engine.queryCimProcesses = async () => [row];
    engine.runTaskkill = okTaskkill;

    const started = Date.now();
    const result = await engine.killProcess(42001);
    const elapsed = Date.now() - started;

    assert.equal(result.status, "killed", JSON.stringify(result));
    assert.ok(result.success, "o reap tem de confirmar a morte");
    assert.ok(elapsed < 1_000, `o caso típico não pode custar ${elapsed} ms`);
  });

  it("3b. reap com processo VIVO: confirma via 2 ausências CIM dentro do piso", async () => {
    // Filho real e vivo: `isProcessAlive` responde verdadeiro, por isso o reap
    // tem de passar pelas confirmações do CIM (killProbeConfirmations=2) em vez
    // de desistir por orçamento. É o teste que prova que encolher o reap não
    // fabricou um `still-running` falso.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    try {
      const row = processEntry({ pid: child.pid, name: "vivo.exe", commandLine: "vivo.exe" });
      engine.processes = [row];
      // 1.ª query = pré-ação (confirma o alvo); depois o CIM "não vê" o PID
      // duas vezes → ausência confirmada.
      let queries = 0;
      engine.queryCimProcesses = async () => {
        queries += 1;
        return queries === 1 ? [row] : [];
      };
      engine.runTaskkill = okTaskkill; // NÃO mata o filho: força o caminho do reap

      const started = Date.now();
      const result = await engine.killProcess(child.pid);
      const elapsed = Date.now() - started;

      assert.equal(result.status, "killed", `esperava killed, obtive ${result.status}: ${result.error ?? ""}`);
      assert.ok(result.success);
      assert.ok(queries >= 2, `o reap tem de fazer as confirmações do CIM, fez ${queries}`);
      assert.ok(
        elapsed <= 12_000,
        `o reap não pode passar do orçamento: ${elapsed} ms`,
      );
    } finally {
      child.kill();
    }
  });

  it("4. orçamento já esgotado antes do taskkill devolve timeout sem disparar o kill", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    try {
      const row = processEntry({ pid: child.pid, name: "vivo.exe", commandLine: "vivo.exe" });
      engine.processes = [row];
      engine.queryCimProcesses = async (_filter, timeoutMs) => {
        // Com o orçamento a zero, a revalidação pré-ação recebe 0 e responde
        // de imediato; o timeout é decidido a seguir, antes do taskkill.
        await sleep(Math.min(timeoutMs ?? 0, 50));
        return [row];
      };
      let taskkillRan = false;
      engine.runTaskkill = async () => {
        taskkillRan = true;
        return okTaskkill();
      };

      ProtectionEngineService.KILL_TOTAL_BUDGET_MS = 0;
      const result = await engine.killProcess(child.pid);
      ProtectionEngineService.KILL_TOTAL_BUDGET_MS = 12_000;

      assert.equal(result.status, "timeout");
      assert.equal(result.success, false);
      assert.equal(taskkillRan, false, "não deve disparar um taskkill sem orçamento");
      assert.match(result.error ?? "", /Orçamento/);
    } finally {
      child.kill();
    }
  });
});
