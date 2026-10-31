/**
 * TP-MONITOR-P0-EVENT-FLOW-20261022 — descoberta de processos vs histórico de
 * segurança.
 *
 * O que o utilizador vê: 496 processos na lista e ZERO eventos. A lista vem de
 * `ProcessMonitor.list()`, que atravessa o single-flight de `enumerate()` e serve
 * a verdade do SO. Os eventos vêm do DIFF de `poll()`. Enquanto a UI está aberta,
 * `noteObserver()` põe a cadência rápida (2 000 ms) e a enumeração é medida pelo
 * próprio fonte entre 2 000 e 4 000 ms — ou seja, o tick chega SEMPRE com uma
 * enumeração em curso. E `poll()`, nesse caso, saía: `if (this.enumerationInFlight)
 * return`. O round era deitado fora e `previous` nunca era atualizado.
 * Consequência: quanto mais se olha para o Monitor, menos eventos há — o
 * inventário continua fresco (quem o serve é `list()`) e o histórico de segurança
 * fica vazio.
 *
 * A correção não é enumerar duas vezes: o round passa a JUN TAR-SE à enumeração
 * que já está em curso. Uma enumeração do SO de cada vez continua a ser o
 * invariante; o que deixa de existir é o round perdido.
 *
 * Nenhum teste daqui toca o SO: usa o seam `snapshot()` do construtor, com
 * processos sintéticos benignos. Sem WMI, sem CIM, sem proteção ligada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ProcessMonitor,
  PROCESS_FAST_POLL_INTERVAL_MS,
  PROCESS_POLL_INTERVAL_MS,
} from "../src/index.ts";

/** Mundo sintético: nada disto é um processo real desta máquina. */
function mundo(entradas: Array<[number, string]>): Map<number, any> {
  return new Map(
    entradas.map(([pid, name]) => [
      pid,
      {
        pid, name, ppid: 0, path: "", commandLine: name, user: undefined,
        cpu: 0, memoryMb: 0, trusted: "neutral" as const,
        startedAt: `2026-10-22T20:00:${String(pid % 60).padStart(2, "0")}.000Z`,
      },
    ]),
  );
}

/**
 * Enumeração controlada. Por defeito despega sozinha (senão o seed do arranque
 * nunca completava); `reter()` faz a PRÓXIMA chamada ficar em voo, que é o único
 * modo de reproduzir «o tick chega durante uma enumeração» sem esperar segundos
 * reais nem chamar o SO.
 */
function portaDeEspera() {
  let chamadas = 0;
  const mundos: Array<Map<number, any>> = [];
  const pendentes: Array<() => void> = [];
  let reter = false;
  const snapshot = async () => {
    chamadas += 1;
    const idx = Math.min(chamadas - 1, mundos.length - 1);
    if (reter) {
      reter = false;
      await new Promise<void>((resolver) => pendentes.push(resolver));
    }
    return mundos[idx];
  };
  return {
    get chamadas() { return chamadas; },
    snapshot,
    /** O mundo que a próxima enumeração devolve. */
    ver(m: Map<number, any>) { mundos.push(m); },
    /** A próxima chamada fica em voo até `descolar()`. */
    reter() { reter = true; },
    descolar() { pendentes.shift()?.(); },
  };
}

function contadores(monitor: ProcessMonitor) {
  const iniciado: string[] = [];
  const saido: string[] = [];
  monitor.on("process.started", (p: any) => iniciado.push(p.name));
  monitor.on("process.exited", (p: any) => saido.push(p.name));
  return { iniciado, saido };
}

describe("reprodução — o round de descoberta não pode ser deitado fora", () => {
  it("com a enumeração mais lenta que o tick, o processo novo é anunciado", async () => {
    assert.ok(PROCESS_FAST_POLL_INTERVAL_MS <= PROCESS_POLL_INTERVAL_MS, "cadência rápida existe");
    const gate = portaDeEspera();
    gate.ver(mundo([[1, "alpha.exe"]]));
    const monitor = new ProcessMonitor(gate.snapshot);
    const eventos = contadores(monitor);

    await monitor.seedOnly();
    assert.deepEqual(eventos.iniciado, [], "seed de arranque é silencioso (contrato existente)");

    // benign.exe nasceu. A UI está aberta: `list()` pede a enumeração e o tick do
    // timer chega enquanto ela ainda está em curso.
    gate.ver(mundo([[1, "alpha.exe"], [2, "benign.exe"]]));
    gate.reter();
    const lista = monitor.list();
    const tick = monitor.poll();
    gate.descolar();
    await Promise.all([lista, tick]);

    assert.equal(
      eventos.iniciado.length,
      1,
      `o round tinha de anunciar benign.exe; anunciou ${JSON.stringify(eventos.iniciado)} — é o «zero eventos» com inventário fresco`,
    );
    assert.equal(eventos.iniciado[0], "benign.exe");
    assert.equal(eventos.saido.length, 0, "nenhum exited inventado");
  });

  it("seis ticks sobrepostos a enumerações produzem seis, não doze, enumerações", async () => {
    // O invariante que a correção tem de preservar: uma enumeração em curso,
    // venha de onde vier. O que muda é o round, não o preço.
    const gate = portaDeEspera();
    gate.ver(mundo([[1, "alpha.exe"]]));
    const monitor = new ProcessMonitor(gate.snapshot);
    const eventos = contadores(monitor);
    await monitor.seedOnly();
    assert.equal(gate.chamadas, 1, "seed = 1 enumeração");

    for (let i = 0; i < 6; i += 1) {
      gate.ver(mundo([[1, "alpha.exe"], [10 + i, `novo${i}.exe`]]));
      gate.reter();
      const lista = monitor.list();
      const tick = monitor.poll();
      gate.descolar();
      await Promise.all([lista, tick]);
    }

    assert.equal(gate.chamadas, 7, "1 seed + 6 rounds: nunca duas enumerações em simultâneo");
    assert.deepEqual(
      eventos.iniciado,
      ["novo0.exe", "novo1.exe", "novo2.exe", "novo3.exe", "novo4.exe", "novo5.exe"],
      "cada processo novo anunciado uma única vez",
    );
  });

  it("três rounds simultâneos anunciam o mesmo processo UMA única vez", async () => {
    const gate = portaDeEspera();
    gate.ver(mundo([[1, "alpha.exe"]]));
    const monitor = new ProcessMonitor(gate.snapshot);
    const eventos = contadores(monitor);
    await monitor.seedOnly();
    gate.ver(mundo([[1, "alpha.exe"], [7, "unico.exe"]]));
    gate.reter();

    const lista = monitor.list();
    const a = monitor.poll();
    const b = monitor.poll();
    const c = monitor.poll();
    gate.descolar();
    await Promise.all([lista, a, b, c]);

    assert.deepEqual(eventos.iniciado, ["unico.exe"], "juntar-se à enumeração não duplica a emissão");
    assert.equal(gate.chamadas, 2, "seed + uma única enumeração partilhada");
  });

  it("seedOnly continua sem emitir, mesmo com uma enumeração de `list()` em curso", async () => {
    const gate = portaDeEspera();
    gate.reter();
    gate.ver(mundo([[1, "alpha.exe"], [2, "beta.exe"], [3, "gamma.exe"]]));
    const monitor = new ProcessMonitor(gate.snapshot);
    const eventos = contadores(monitor);

    const lista = monitor.list();
    const semear = monitor.seedOnly();
    gate.descolar();
    await Promise.all([lista, semear]);

    assert.deepEqual(eventos.iniciado, [], "o seed nunca anuncia a totalidade do arranque");
    assert.deepEqual(eventos.saido, []);
    assert.equal(gate.chamadas, 1, "seed junta-se à enumeração em curso, não duplica");
  });

  it("stop() durante um round em voo não re-agenda o timer", async () => {
    const gate = portaDeEspera();
    gate.ver(mundo([[1, "alpha.exe"]]));
    const monitor = new ProcessMonitor(gate.snapshot);
    await monitor.seedOnly();
    gate.ver(mundo([[1, "alpha.exe"], [2, "depois.exe"]]));
    gate.reter();

    const emVoo = monitor.poll();
    await monitor.stop();
    gate.descolar();
    await emVoo;
    const antes = gate.chamadas;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(gate.chamadas, antes, "parado é parado: nenhum round novo depois do stop()");
  });

  it("uma saída natural continua a ser anunciada quando o round corre", async () => {
    const gate = portaDeEspera();
    gate.ver(mundo([[1, "alpha.exe"], [2, "beta.exe"]]));
    const monitor = new ProcessMonitor(gate.snapshot);
    const eventos = contadores(monitor);
    await monitor.seedOnly();
    gate.ver(mundo([[1, "alpha.exe"]]));
    await monitor.poll();
    assert.deepEqual(eventos.saido, ["beta.exe"], "diff de saída preservado");
    assert.deepEqual(eventos.iniciado, []);
  });
});
