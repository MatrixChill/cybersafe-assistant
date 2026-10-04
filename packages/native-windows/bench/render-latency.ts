/**
 * Latencia T0 -> T5: o numero que o UTILIZADOR SENTE.
 *
 * A primeira fatia mediu T0 -> T1 (o servico descobre o processo). Isso nao e o
 * que o utilizador ve. A cadeia completa e:
 *
 *   T0 o processo nasce
 *   T1 o servico descobre (cadencia adaptativa, 2 s com observador)
 *   T2 o cache do servico fica actualizado (imediato)
 *   T3 processes.list devolve
 *   T4 o renderer recebe o snapshot (cadencia do poll do renderer)
 *   T5 a linha aparece no ecra
 *
 * T3-T5 e o termo que faltava: o renderer so perguntava de 10 em 10 s, e lia a
 * verdade 5 vezes atrasada. Este bench replica a cadeia inteira com as
 * cadencias reais (o cache com o TTL real de 20 s, o consumidor a cadencia que
 * a constante PROCESSES_POLL_MS definir) e mede T0 -> T5.
 *
 * Nao e teste: e a medicao. Nao usa EICAR, nao toca a rede.
 */
import { ProcessMonitor, PROCESS_POLL_INTERVAL_MS, PROCESS_FAST_POLL_INTERVAL_MS } from "../dist/index.js";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/** TTL de frescura do cache no servico (PROCESS_TRUTH_TTL_MS = poll * 2). */
const CACHE_TTL_MS = PROCESS_POLL_INTERVAL_MS * 2;

/** Cadencia do renderer. passed: o valor a testar. */
const RENDERER_POLL_MS = Number(process.argv[2] ?? 2_000);
const ROUNDS = Number(process.argv[3] ?? 5);

/** Estado do cache do servico, com o TTL real. */
let cache: Map<number, unknown> | null = null;
let cacheEnumeratedAt = 0;
let enumerations = 0;

/**
 * O que o servico faz a cada pedido `processes.list`: marca observador (e o que
 * liga a cadencia adaptativa) e devolve cache se estiver fresco.
 */
async function processesList() {
  // O pedido de lista é o sinal de "ha alguem a olhar". Sem esta chamada o
  // monitor fica na cadencia lenta (10 s) e o T5 nao desce, por mais que o
  // consumidor pergunte depressa — e exatamente o que aconteceu na primeira
  // medicao deste bench.
  monitor.noteObserver();
  const now = Date.now();
  if (cache && now - cacheEnumeratedAt < CACHE_TTL_MS) return cache;
  enumerations += 1;
  cache = await monitor.list().then((l) => new Map(l.map((p) => [p.pid, p])));
  cacheEnumeratedAt = now;
  return cache;
}

const monitor = new ProcessMonitor();
await monitor.start();

/** O que o service faz quando o monitor descobre um processo novo. */
monitor.on("process.started", (p: { pid: number }) => {
  if (cache) cache.set(p.pid, p);
});

const samples = [];

for (let i = 0; i < ROUNDS; i++) {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { stdio: "ignore" });
  const pid = child.pid;
  const t0 = Date.now();

  // O renderer esta aberto na pagina de processos: pergunta de RENDERER_POLL_MS
  // em RENDERER_POLL_MS, como o setInterval do App faz. Este e o T3 -> T5: o que
  // o utilizador ve. O sleep e o intervalo, nao um poll continuo — um poll
  // continuo mediria o cache, nao a cadencia do consumidor.
  let seen = -1;
  const deadline = t0 + 30_000;
  let nextAsk = t0;
  while (Date.now() < deadline) {
    const wait = nextAsk - Date.now();
    if (wait > 0) await sleep(wait);
    nextAsk += RENDERER_POLL_MS;

    const list = await processesList();
    if (list.has(pid)) {
      seen = Date.now() - t0;
      break;
    }
  }

  samples.push(seen);
  child.kill();
  await sleep(500);
}

await monitor.stop();

const validos = samples.filter((s) => s > 0);
const ordenados = [...validos].sort((a, b) => a - b);
const media = validos.length ? validos.reduce((a, b) => a + b, 0) / validos.length : -1;
const mediana = ordenados.length ? ordenados[Math.floor(ordenados.length / 2)] : -1;

console.log(`T0->T5  rendererPoll=${RENDERER_POLL_MS}ms  rounds=${ROUNDS}  cacheTTL=${CACHE_TTL_MS}ms`);
console.log(`T5-T0 por round (ms): ${samples.join(", ")}`);
console.log(
  `vistos=${validos.length}/${ROUNDS}  min=${Math.min(...validos)}  mediana=${mediana}  media=${Math.round(media)}  max=${Math.max(...validos)}`,
);
console.log(`enumeracoes do SO na corrida: ${enumerations}`);
