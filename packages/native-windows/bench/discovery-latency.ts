/**
 * Mede a latencia de DESCOBERTA de um processo novo, pela via real: o evento
 * `process.started` do ProcessMonitor, que e o que alimenta o cache do
 * servico. Nao se mede `list()` — essa vai ao SO a cada chamada e mede o custo
 * da enumeracao (591 ms), nao a espera pelo relogio da descoberta.
 *
 * Lanca um processo benigno e descartavel (node -e que dorme), marca T0 no
 * instante em que o lanca, e espera pelo evento. Imprime T5 - T0.
 *
 * Nao e um teste: e a medicao que o packet exige para nao afirmar uma melhoria
 * sem numero. Nao usa EICAR, nao toca a rede, nao escreve fora de %TEMP%.
 */
import { ProcessMonitor, PROCESS_POLL_INTERVAL_MS, PROCESS_FAST_POLL_INTERVAL_MS } from "../dist/index.js";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const MODE = process.argv[2] === "fast" ? "fast" : "slow";
const ROUNDS = Number(process.argv[3] ?? 5);

const monitor = new ProcessMonitor();
await monitor.start();

const samples = [];

for (let i = 0; i < ROUNDS; i++) {
  // Quem esta a medir esta a olhar: e o que dispara a cadencia adaptativa.
  if (MODE === "fast") monitor.noteObserver();

  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { stdio: "ignore" });
  const pid = child.pid;
  const t0 = Date.now();

  const seen = await new Promise<number>((resolve) => {
    const onStarted = (p: { pid: number }) => {
      if (p.pid !== pid) return;
      monitor.off("process.started", onStarted);
      resolve(Date.now() - t0);
    };
    monitor.on("process.started", onStarted);
    // Tecto de seguranca: se a cadencia falhar, nao ficamos a espera para sempre.
    setTimeout(() => {
      monitor.off("process.started", onStarted);
      resolve(-1);
    }, 30_000);
  });

  samples.push(seen);
  child.kill();
  await sleep(500);
}

await monitor.stop();

const validos = samples.filter((s) => s > 0);
const ordenados = [...validos].sort((a, b) => a - b);
const media = validos.length ? validos.reduce((a, b) => a + b, 0) / validos.length : -1;
const mediana = ordenados.length ? ordenados[Math.floor(ordenados.length / 2)] : -1;

console.log(`MODE=${MODE}  rounds=${ROUNDS}  lento=${PROCESS_POLL_INTERVAL_MS}ms rapido=${PROCESS_FAST_POLL_INTERVAL_MS}ms`);
console.log(`T5-T0 por round (ms): ${samples.join(", ")}`);
console.log(
  `vistos=${validos.length}/${ROUNDS}  min=${Math.min(...validos)}  mediana=${mediana}  media=${Math.round(media)}  max=${Math.max(...validos)}`,
);
