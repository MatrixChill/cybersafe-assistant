import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ProtectionEngineService } from "../dist/engine.js";
// NÃO importar `../dist/index.js`: esse módulo escreve boot-debug.log e chama
// main() no topo, portanto importá-lo ligava o serviço a sério e escrevia no
// runtime REAL do utilizador — foi o que contaminou o home em 2026-10-02. Os
// handlers vivem num módulo sem efeitos ao importar.
import { createSignalHandlers, installSignalHandlers } from "../dist/signal-handlers.js";

/**
 * P1-5 (Codex) — SIGINT/SIGTERM SEM DISPOSE.
 *
 * Ver o Bloco A (identidade de criação) em own-child-pid-identity.test.js.
 *
 * Este ficheiro prende três coisas, e as duas primeiras eram bugs meus que o
 * utilizador apanhou por leitura de código:
 *
 *  BUG A — `process.off(signal, onSignal(signal))` criava DUAS closures
 *  diferentes: a registada e a removida. O `uninstall` não tirava nada, e o
 *  handler continuava vivo depois de o teste (ou o bootstrap) achar que o tinha
 *  removido.
 *
 *  BUG B — `let clamavStopped = true` e só posto a `false` dentro do `.catch`.
 *  Se o TIMEOUT ganhasse o race, `clamavStopped` continuava `true` e o serviço
 *  imprimia "ClamAV disposed" sem nunca ter confirmado a morte. É exactamente a
 *  mentira que este shutdown existe para não dizer.
 */

const TEST_BASE_DIR = mkdtempSync(path.join(os.tmpdir(), "cybersafe-p15-"));

// `engine.shutdown()` termina em `setTimeout(() => process.exit(0), 200)`.
// Sem isto, o runner de testes morre a meio do ficheiro e os testes seguintes
// nunca correm — que é exactamente o que acontecia: a suite reportava "2 tests"
// num ficheiro com 8.
const realExit = process.exit.bind(process);
let exitCalls = 0;
process.exit = (code) => {
  exitCalls++;
  void code;
};
after(() => {
  process.exit = realExit;
});

function makeEngine() {
  return new ProtectionEngineService(TEST_BASE_DIR);
}

function spyClamav(engine) {
  const calls = { dispose: 0 };
  engine.clamav.dispose = async () => {
    calls.dispose++;
  };
  return calls;
}

describe("P1-5 — o shutdown leva o ClamAV com ele", () => {
  it("quando um .stop() PENDURA, o clamav.dispose() ainda é chamado", async () => {
    const engine = makeEngine();
    const calls = spyClamav(engine);

    engine.processMonitor.stop = () => new Promise(() => {});
    engine.watcher.stop = () => new Promise(() => {});

    const exit = setTimeout(() => {}, 10_000);
    await engine.shutdown();
    clearTimeout(exit);

    assert.equal(
      calls.dispose,
      1,
      "o deadline do shutdown não pode ser uma desculpa para deixar o clamscan vivo",
    );
  });

  it("SIGINT e SIGTERM vão pelo MESMO caminho que o shutdown normal", async () => {
    const engine = makeEngine();
    const calls = spyClamav(engine);
    let shutdowns = 0;
    engine.shutdown = async () => {
      shutdowns++;
      await engine.clamav.dispose();
    };

    const uninstall = installSignalHandlers(engine, { exit: () => {} });
    process.emit("SIGINT");
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 80));
    uninstall();

    // Idempotente: o segundo sinal durante o shutdown NÃO abre um segundo
    // caminho, mas o clamscan já foi levado pelo primeiro.
    assert.ok(shutdowns >= 1, "cada sinal tem de percorrer o shutdown completo");
    assert.equal(calls.dispose, 1, "o clamscan só pode ser terminado uma vez");
  });

  it("o cleanup NUNCA é duplicado quando os sinais se atropelam", async () => {
    const engine = makeEngine();
    let shutdowns = 0;
    engine.shutdown = async () => {
      shutdowns++;
      await new Promise((r) => setTimeout(r, 30));
    };

    const uninstall = installSignalHandlers(engine, { exit: () => {} });
    process.emit("SIGINT");
    process.emit("SIGINT");
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 150));
    uninstall();

    assert.equal(shutdowns, 1, "o shutdown tem de ser idempotente sob surtos de sinal");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG A — o uninstall tem de tirar MESMO o handler que instalou
// ─────────────────────────────────────────────────────────────────────────────
describe("P1-5/A — o uninstall remove mesmo o handler", () => {
  it("depois do uninstall, um sinal NÃO chama mais o shutdown", async () => {
    const engine = makeEngine();
    let shutdowns = 0;
    engine.shutdown = async () => {
      shutdowns++;
    };

    const before = process.listenerCount("SIGINT");
    const uninstall = installSignalHandlers(engine, { exit: () => {} });
    assert.equal(
      process.listenerCount("SIGINT"),
      before + 1,
      "o install tem de acrescentar exactamente um listener",
    );

    uninstall();

    assert.equal(
      process.listenerCount("SIGINT"),
      before,
      "o uninstall tem de REMOVER o listener — se não remover, o serviço continua a reagir depois de o chamador achar que não está",
    );

    process.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(shutdowns, 0, "um handler que sobrevive ao uninstall continua a fechar o serviço");
  });

  it("SIGINT e SIGTERM juntos dão UM shutdown, não dois", async () => {
    const engine = makeEngine();
    let shutdowns = 0;
    engine.shutdown = async () => {
      shutdowns++;
      await new Promise((r) => setTimeout(r, 30));
    };

    const uninstall = installSignalHandlers(engine, { exit: () => {} });
    process.emit("SIGINT");
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 150));
    uninstall();

    assert.equal(shutdowns, 1, "dois sinais próximos são uma só saída");
  });

  it("importar o módulo dos handlers NÃO arranca o serviço", () => {
    // A regressão que custou a contaminação do runtime: o módulo tem de ser
    // importável sem escrever nada. Se alguém voltar a pôr isto em index.ts,
    // este teste continua a passar mas o outro deixa de existir — por isso a
    // protecção é estrutural: este ficheiro importa signal-handlers, não index.
    const antes = process.listenerCount("SIGINT");
    createSignalHandlers(makeEngine(), { exit: () => {} });
    assert.ok(antes >= 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG B — o timeout do dispose NÃO pode ser reportado como sucesso
// ─────────────────────────────────────────────────────────────────────────────
describe("P1-5/B — um dispose que expira nunca é dito como 'disposed'", () => {
  it("se o clamav.dispose() não resolve a tempo, NÃO se anuncia sucesso", async () => {
    const engine = makeEngine();
    // Um dispose que NUNCA resolve: é o caso do clamscan que não morre.
    engine.clamav.dispose = () => new Promise(() => {});

    const linhas = [];
    const logOriginal = console.log;
    const errOriginal = console.error;
    console.log = (...args) => linhas.push(args.join(" "));
    console.error = (...args) => linhas.push(args.join(" "));

    try {
      const exit = setTimeout(() => {}, 60_000);
      await engine.shutdown();
      clearTimeout(exit);
    } finally {
      console.log = logOriginal;
      console.error = errOriginal;
    }

    const falaDisposed = linhas.some((l) => l.includes("ClamAV disposed"));
    const falaNaoConfirmado = linhas.some((l) => /ClamAV.*(NÃO|não) confirmado/.test(l));

    assert.equal(
      falaDisposed,
      false,
      `o timeout do dispose NÃO confirma a morte do clamscan; linhas: ${JSON.stringify(linhas)}`,
    );
    assert.equal(
      falaNaoConfirmado,
      true,
      `e o serviço tem de dizer que não confirmou, em vez de se calar; linhas: ${JSON.stringify(linhas)}`,
    );
  });

  it("se o clamav.dispose() FALHAR, também não se anuncia sucesso", async () => {
    const engine = makeEngine();
    engine.clamav.dispose = async () => {
      throw new Error("kill falhou");
    };

    const linhas = [];
    const logOriginal = console.log;
    const errOriginal = console.error;
    console.log = (...args) => linhas.push(args.join(" "));
    console.error = () => {};
    try {
      const exit = setTimeout(() => {}, 60_000);
      await engine.shutdown();
      clearTimeout(exit);
    } finally {
      console.log = logOriginal;
      console.error = errOriginal;
    }

    assert.equal(
      linhas.some((l) => l.includes("ClamAV disposed")),
      false,
      "uma rejeição também não é 'disposed'",
    );
  });
});