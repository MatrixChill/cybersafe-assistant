/**
 * FIX P2 — `stop()` durante um poll em voo não rearma o timer.
 *
 * Causa-raiz (HANDOFF-ANTIGRAVITY-P1): `this.poll().finally(() => this.schedule())`
 * reagendava o timer incondicionalmente, mesmo após `stop()`. O ProcessMonitor
 * ressurgia em background após a proteção parar.
 *
 * O teste usa um snapshot injetado que demora (gate controlado) para simular
 * uma enumeração em voo, e verifica que após `stop()` o timer NUNCA dispara
 * de novo — contado pelo número de chamadas ao snapshot.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProcessMonitor } from "../dist/index.js";

function world(entries) {
  return new Map(
    entries.map(([pid, name]) => [
      pid,
      { pid, name, commandLine: name, user: undefined, cpu: 0, memoryMb: 0, path: "", ppid: 0 },
    ]),
  );
}

describe("FIX P2 — stop() em voo não rearma o poll", () => {
  it("stop() enquanto poll() está em voo impede re-agendamento", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const monitor = new ProcessMonitor(async () => {
      calls += 1;
      if (calls === 1) await gate; // primeiro poll fica preso até release
      return world([[1, "a.exe"]]);
    });

    // Inicia o poll em voo (não awaited).
    const first = monitor.poll();
    // Dá uma voltinha para a promessa entrar em pending.
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1, "o primeiro poll entrou na enumeração");

    // Parar enquanto a enumeração está em voo.
    await monitor.stop();

    // Soltar a enumeração. O .finally NÃO pode reagendar.
    release(world([[1, "a.exe"]]));
    await first;

    // Espera muito mais do que qualquer intervalo de poll para garantir que
    // nenhum timer secreto disparou.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls, 1, "nenhum segundo poll foi agendado após stop()");

    // E se o monitor for reiniciado, volta a funcionar (o running é reset).
    await monitor.start();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(calls >= 2, "restart após stop funciona normalmente");
  });

  it("stop() antes de start() não deixa schedule() reagendar no start()", async () => {
    const monitor = new ProcessMonitor(async () => world([[1, "a.exe"]]));
    // Parar antes de começar: running fica false.
    await monitor.stop();
    // start() liga running=true e agenda uma vez.
    await monitor.start();
    let calls = 0;
    monitor.snapshot = async () => { calls += 1; return world([[1, "a.exe"]]); };
    await new Promise((r) => setTimeout(r, 50));
    await monitor.stop();
    // Nenhum poll adicional após o stop.
    const antes = calls;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls, antes, "poll não reagendou após stop() pós-start()");
  });
});