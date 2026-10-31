/**
 * ── PONTE ADL: pede ao WORKER (processo próprio) e nunca à ADL in-process ─────
 *
 * Este módulo é a única forma como o core toca a AMD Display Library. As
 * garantias que ele é obrigado a manter, porque o resto do CyberSafe depende
 * delas:
 *
 *   1. NUNCA chama ADL no processo do serviço. O acesso violação demonstrado
 *      nesta máquina (26/10/2026) mataria o serviço; aqui mata só o filho.
 *   2. NUNCA lança por falta de driver, de biblioteca FFI ou de worker: devolve
 *      estado (`unsupported`) e o snapshot continua honesto.
 *   3. UM processo por consulta. O timeout mata e **confirma** a morte; se a
 *      morte não for confirmada dentro da graça, o filho fica registado como
 *      pendente e visível (`adlBridgePendingWorkers`), nunca esquecido.
 *   4. Não lança um processo depois de a operação ter sido resolvida ou
 *      cancelada — nem antes nem depois do timeout.
 *   5. Sem polling: o cache (por omissão 3 s), o single-flight e o backoff
 *      garantem que N consumidores pedidos simultâneos produzem UM filho, e que
 *      uma falha transitória não é tentada a cada poll.
 *
 * O que motivou a reescrita desta versão (auditoria de integração, 26/10/2026):
 * a resolução da promessa no instante do `kill()` — antes do `close` — deixava
 * em aberto «workers que sobrevivem ao cancelamento», «promises resolvidas antes
 * de close» e «processos órfãos»; e um `setTimeout` armado antes do `await` do
 * koffi permitia **criar o worker depois de a operação já ter sido resolvida por
 * timeout**, com um `spawned: 1` que não correspondia a nada de criado.
 *
 * Leituras obtidas aqui são user-mode e não exigem elevação. Nada é instalado.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AdlStatus = "ok" | "unsupported" | "timeout" | "error";

export interface AdlAdapterSample {
  adapterIndex: number;
  udid: string;
  adapterName: string;
  displayName: string;
  busNumber: number;
  deviceNumber: number;
  present: boolean;
  active: number | null;
  /** Chaves conhecidas: gpuCoreC, gpuHotspotC, gpuMemoryC, cpuC, fanRpm,
   *  fanPercent, gpuUtilPercent, memUtilPercent. Só existem se o sensor
   *  respondeu `supported`; valores crus, validados pelo provider. */
  pmlog: Record<string, number>;
  od6Celsius: number | null;
  /** Ordinais PMLog que o adaptador declarou suportados (diagnóstico de
   *  proveniência: distingue "sensor ausente" de "leitura falhou"). */
  supportedSensors?: number[];
}

export interface AdlReading {
  status: AdlStatus;
  /** Motivo técnico estável (`dll-not-found`, `ffi-module-absent`,
   *  `adl2-create-failed`, `worker-crashed`, ...). `null` quando `ok`. */
  reason: string | null;
  samples: AdlAdapterSample[];
  /** Momento da aquisição no processo pai (ISO). Não é o relógio do chip. */
  acquiredAt: string;
  /** Processos de worker **efetivamente criados** por esta chamada.
   *  0 quando nem sequer se tentou — e também 0 quando o timeout se deu antes
   *  do spawn, que é o caso que a versão anterior mentia como 1. */
  spawned: number;
  /** Morte do filho confirmado por `close`/`exit`. `null` quando nunca existiu
   *  filho. É a resposta observável a «a promessa resolveu antes do encerramento». */
  closeConfirmed: boolean | null;
  /** Ficou um filho sem morte confirmada (fica registado e será colhido). */
  orphaned: boolean;
  /**
   * Sonda de existência do PID no momento de resolver: `true` vivo, `false`
   * comprovadamente inexistente, `null` sem filho ou sem sonda possível.
   *
   * Existe porque `closeConfirmed: false` não diz tudo: um filho pode ter morrido
   * sem nunca emitir `close` (pipes pendurados), e outro pode estar vivo mas
   * irrecuperável (kill recusado). Confirmação de encerramento e existência do
   * processo são perguntas diferentes; responder às duas exige provas diferentes.
   */
  childAlive?: boolean | null;
}

export interface AdlBridgeOptions {
  timeoutMs?: number;
  cacheMs?: number;
  /** Janela após `kill()` para esperar o `close` antes de escalar para SIGKILL
   *  e, se ainda assim não morrer, resolver como órfão registado. */
  reapGraceMs?: number;
  /** Sobreponível em testes: caminho do worker e verificação do DLL. */
  workerPath?: string;
  dllPath?: string;
  now?: () => number;
  /** Cancelação explícita do consumidor: mata com confirmação, não entra em
   *  backoff (cancelar não é falha do provider). */
  signal?: AbortSignal;
  /** Seam de teste: cria o filho com a mesma contratação de `spawn`, para
   *  provar single-flight, timeout+kill e backoff sem processos reais. */
  spawnWorker?: (workerPath: string, dllPath: string) => ReturnType<typeof spawn>;
  /** Força a tentativa mesmo sem `koffi` resolvido no processo pai — usado pelo
   *  probe de integração, que corre um worker a partir de uma pasta onde o
   *  módulo existe. Em produção fica `false` (zero processos quando não há FFI). */
  assumeFfi?: boolean;
  /**
   * Sonda de existência de um PID. Por omissão `process.kill(pid, 0)`, que no
   * Windows distingue «não existe» (ESRCH/ENOENT) de «existe mas não posso
   * signalizar» (EPERM). Sobreponível em teste: um fixture que representa «não
   * conseguimos provar que morreu» tem de o poder dizer sem depender de que
   * número de PID anda livre na máquina.
   */
  probeChild?: (pid: number | null | undefined) => boolean | null;
}

const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_CACHE_MS = 3_000;
const DEFAULT_REAP_GRACE_MS = 750;
/** Razões definitivas: não vale a pena tentar de novo neste processo de vida. */
const PERMANENT_REASONS = new Set([
  "dll-not-found",
  "ffi-module-absent",
  "worker-missing",
  "adl-entrypoint-missing",
  "adl-pmlog-shmem-missing",
  "pddll-paths-unavailable",
]);
/** Razões de «não há nada a ler aqui» que são um estado legítimo e estável, não
 *  uma avaria: mantêm o seu próprio `status` em vez de serem reetiquetadas
 *  `error` pelo backoff. */
const NON_FAILURE_REASONS = new Set([
  "no-adapters",
  "no-sensor-data",
  "adl-unsupported",
  "adl2-create-failed",
  "no-amd-adapters",
]);
/** Backoff para falhas transitórias (crash do ADL, timeout, exit anómalo). */
const FAILURE_BACKOFF_MS = 120_000;

type ChildHandle = ReturnType<typeof spawn> & { pid?: number };

/** Registo de um filho a quem pedimos a morte e que ainda não vimos morrer. */
interface PendingWorker {
  pid: number | null;
  since: number;
  /** O que aconteceu de facto ao pedido de morte: `SIGTERM`, `SIGKILL`,
   *  `kill-returned-false` ou `kill-threw`. Nunca um valor que afirme um
   *  sucesso que o sistema operativo recusou. */
  killedWith: string | null;
}

/** Filhos a quem demos `kill` e cuja morte ainda não vimos. Publicados para que
 *  «sem processos órfãos» seja observável em teste e em diagnóstico, em vez de
 *  ser uma afirmação. */
const pendingWorkers = new Set<PendingWorker>();

/** `true` vivo, `false` comprovadamente inexistente, `null` sem prova possível.
 *  Conservador por omissão: só dizemos «morto» quando o SO o afirma. */
function probePidAlive(pid: number | null | undefined): boolean | null {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ESRCH" || code === "ENOENT") return false;
    if (code === "EPERM" || code === "EACCES") return true;
    return null;
  }
}

/** Estado observável dos filhos ainda por confirmar — usado por testes e pelo
 *  diagnóstico de encerramento do serviço. */
export function adlBridgePendingWorkers(): { pid: number | null; since: number; killedWith: string | null }[] {
  return [...pendingWorkers];
}

const empty = (
  status: AdlStatus,
  reason: string | null,
  now: () => number,
  spawned = 0,
  closeConfirmed: boolean | null = null,
  orphaned = false,
  childAlive: boolean | null = null,
): AdlReading => ({
  status,
  reason,
  samples: [],
  acquiredAt: new Date(now()).toISOString(),
  spawned,
  closeConfirmed,
  orphaned,
  childAlive,
});

function defaultWorkerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Em produção é o JS compilado ao lado deste módulo; em `src/` (tsx) é o .ts.
  const js = path.join(here, "adl-bridge-worker.js");
  return existsSync(js) ? js : path.join(here, "adl-bridge-worker.ts");
}

function defaultDllPath(): string {
  const root = process.env.SystemRoot || "C:\\Windows";
  return `${root}\\System32\\atiadlxx.dll`;
}

/** koffi é uma dependência OPCIONAL. Confirmar isso no pai, uma única vez,
 *  evita criar um processo por consulta numa máquina onde o ADL não pode
 *  sequer ser lido — é o caso normal (utilizador sem `npm install koffi`). */
let ffiChecked: boolean | null = null;

async function ffiIsPresent(): Promise<boolean> {
  if (ffiChecked !== null) return ffiChecked;
  try {
    const specifier = "koffi";
    await import(specifier);
    ffiChecked = true;
  } catch {
    ffiChecked = false;
  }
  return ffiChecked;
}

interface NegativeEntry {
  at: number;
  reading: AdlReading;
  /** `true` quando a razão justifica backoff (avaria); `false` quando é um
   *  estado estável que só não queremos repetir a cada poll. */
  backedOff: boolean;
}

interface CacheEntry {
  at: number;
  reading: AdlReading;
}

let cache: CacheEntry | null = null;
let negative: NegativeEntry | null = null;
let inFlight: Promise<AdlReading> | null = null;
let latchedUnsupported: string | null = null;

/** Estado interno de throttling — exportado só para os testes poderem
 *  reiniciar o módulo entre casos. */
export function resetAdlBridgeState(): void {
  cache = null;
  negative = null;
  inFlight = null;
  latchedUnsupported = null;
  ffiChecked = null;
  pendingWorkers.clear();
}

function parseWorkerOutput(stdout: string): AdlReading["samples"] | null {
  const text = stdout.replace(/^\uFEFF/, "").trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const obj = parsed as { adapters?: unknown };
  if (!obj || !Array.isArray(obj.adapters)) return null;
  const samples: AdlAdapterSample[] = [];
  for (const raw of obj.adapters) {
    const a = raw as Record<string, unknown>;
    const index = Number(a.adapterIndex);
    if (!Number.isInteger(index) || index < 0) continue;
    const pmlogRaw = a.pmlog && typeof a.pmlog === "object" ? (a.pmlog as Record<string, unknown>) : {};
    const pmlog: Record<string, number> = {};
    for (const [key, value] of Object.entries(pmlogRaw)) {
      if (typeof value === "number" && Number.isFinite(value)) pmlog[key] = value;
    }
    samples.push({
      adapterIndex: index,
      udid: typeof a.udid === "string" ? a.udid : "",
      adapterName: typeof a.adapterName === "string" ? a.adapterName : "",
      displayName: typeof a.displayName === "string" ? a.displayName : "",
      busNumber: Number(a.busNumber) || 0,
      deviceNumber: Number(a.deviceNumber) || 0,
      present: a.present === true,
      // `null` tem de ficar `null`: `Number(null) === 0` transformaria
      // "sem leitura" em zero, que é exatamente o erro que este subsistema
      // já cometeu com temperaturas.
      active: a.active === null || a.active === undefined ? null : Number.isFinite(Number(a.active)) ? Number(a.active) : null,
      pmlog,
      od6Celsius: a.od6Celsius === null || a.od6Celsius === undefined ? null : Number.isFinite(Number(a.od6Celsius)) ? Number(a.od6Celsius) : null,
      supportedSensors: Array.isArray(a.supportedSensors)
        ? (a.supportedSensors as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0)
        : undefined,
    });
  }
  return samples;
}

function workerStatusOf(stdout: string): { status: string; reason: string | null } {
  try {
    const parsed = JSON.parse(stdout.replace(/^\uFEFF/, "").trim()) as {
      status?: string;
      reason?: string | null;
    };
    return { status: String(parsed.status ?? ""), reason: parsed.reason ? String(parsed.reason) : null };
  } catch {
    return { status: "", reason: null };
  }
}

/**
 * Lê os sensores ADL. Não lança em nenhuma circunstância: um falhanço é sempre
 * um `status` + `reason`, para o provider publicar indisponibilidade verdadeira
 * em vez de um número inventado.
 */
export async function readAdlSensors(options: AdlBridgeOptions = {}): Promise<AdlReading> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const reapGraceMs = options.reapGraceMs ?? DEFAULT_REAP_GRACE_MS;
  const now = options.now ?? Date.now;
  const workerPath = options.workerPath ?? defaultWorkerPath();
  const dllPath = options.dllPath ?? defaultDllPath();
  const probeChild = options.probeChild ?? probePidAlive;

  // 1) Latch definitivo: já se provou que este ambiente não tem ADL.
  if (latchedUnsupported) {
    return empty("unsupported", latchedUnsupported, now, 0, null);
  }
  // 2) Cache quente: nenhum processo novo enquanto a leitura é válida.
  if (cache && now() - cache.at < cacheMs) return cache.reading;
  // 3) Single-flight: consumidores simultâneos partilham UM filho.
  if (inFlight) return inFlight;
  // 4) ADMISSÃO, antes de qualquer throttling. Um filho nosso com morte por
  //    confirmar é razão suficiente para não abrir outro: é assim que «workers
  //    que sobrevivem ao cancelamento» deixa de poder multiplicar-se. A poda usa
  //    a sonda de PID, portanto um processo comprovadamente extinto libera a
  //    admissão — o bloqueio nunca é perpétuo e não precisa de timer. Vai à
  //    frente do throttling de propósito: enquanto houver um filho por
  //    confirmar, a verdade presente («ainda temos um processo em dívida») é
  //    mais útil do que a repetição da falha anterior, e não escrevemos em
  //    `negative` nem em `cache` — a recusa de hoje não é o backoff de amanhã.
  for (const entry of [...pendingWorkers]) {
    if (probeChild(entry.pid) === false) pendingWorkers.delete(entry);
  }
  if (pendingWorkers.size > 0) {
    /**
     * A recusa é conservadora, mas o metadado tem de o ser também: `null` da
     * sonda significa «não consigo provar», e escrever `true` ali transformaria
     * uma ausência de prova numa afirmação sobre o sistema operativo.
     */
    const provas = [...pendingWorkers].map((entry) => probeChild(entry.pid));
    return empty(
      "error",
      "worker-reap-pending",
      now,
      0,
      null,
      true,
      provas.includes(true) ? true : provas.includes(null) ? null : false,
    );
  }
  // 5) Throttling de resultado não-lido. Mantém o `status` e a `reason`
  //    originais: um `unsupported` legítimo não se transforma em `error`.
  if (negative) {
    const window = negative.backedOff ? FAILURE_BACKOFF_MS : cacheMs;
    if (now() - negative.at < window) return negative.reading;
  }
  // 6) Pré-verificação no pai: sem driver AMD não se cria processo nenhum.
  if (!existsSync(dllPath)) {
    latchedUnsupported = "dll-not-found";
    return empty("unsupported", latchedUnsupported, now, 0, null);
  }
  if (!existsSync(workerPath)) {
    latchedUnsupported = "worker-missing";
    return empty("unsupported", latchedUnsupported, now, 0, null);
  }

  const task = new Promise<AdlReading>(async (resolve) => {
    const started = now();
    let settled = false;
    let stdout = "";
    let spawned = 0;
    let child: ChildHandle | null = null;
    let closeSeen = false;
    let exitSeen = false;
    let reapTimer: ReturnType<typeof setTimeout> | null = null;
    /** Prazo limitado à espera de `close` DEPOIS de um `exit` natural. Sem ele,
     *  um filho que deixe um pipe herdado aberto nunca fecha e a promessa fica
     *  pendurada — o `inFlight` prende então `readTemperature` e o coordenador. */
    let exitWaitTimer: ReturnType<typeof setTimeout> | null = null;
    /** Evidência de que o pedido de morte falhou. `null` = nada a reportar;
     *  string = o código do evento `error` recebido depois de termos pedido a
     *  morte, ou `returned-false` quando `kill()` devolveu `false` sem evento. */
    let killFailure: string | null = null;
    // A colheita é por IDENTIDADE do registo, não por PID: dois filhos sem PID
    // observável (`undefined` em fixtures, ou um filho que morreu antes de o
    // reportarmos) não se podem apagar mutuamente.
    let pendingEntry: PendingWorker | null = null;

    /** Encerramento do filho confirmado (`close`/`exit`) → limpa listeners e
     *  os pipes; caso contrário o registo de órfão fica visível. */
    const releaseChild = (): void => {
      if (pendingEntry) {
        pendingWorkers.delete(pendingEntry);
        pendingEntry = null;
      }
      if (!child) return;
      try {
        child.stdout?.removeAllListeners("data");
        (child.stdout as unknown as { destroy?: () => void })?.destroy?.();
        child.removeAllListeners();
      } catch {
        /* o filho pode já ter sido recolhido */
      }
    };

    const publish = (reading: AdlReading): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reapTimer) clearTimeout(reapTimer);
      if (exitWaitTimer) clearTimeout(exitWaitTimer);
      if (reading.status === "ok") {
        cache = { at: now(), reading };
        negative = null;
      } else if (reading.reason && PERMANENT_REASONS.has(reading.reason)) {
        latchedUnsupported = reading.reason;
        negative = null;
      } else {
        negative = {
          at: now(),
          reading,
          backedOff: reading.reason !== null && !NON_FAILURE_REASONS.has(reading.reason),
        };
      }
      resolve(reading);
    };

    /** Resultado pedido por `terminate`. Quando o `close` chega depois de uma
     *  morte que NÓS pedimos, o código de saída é SIGTERM/SIGKILL — isso não é
     *  uma avaria do worker, é o cancelamento a acontecer. Sem este registo, um
     *  timeout passaria a publicar `worker-signal-SIGTERM` como se fosse crash. */
    let requestedOutcome: { status: AdlStatus; reason: string } | null = null;

    /** Sufixo que preserva a evidência de que matar falhou. */
    const killSuffix = (): string => (killFailure ? `-kill-${killFailure}` : "");

    /**
     * Pede a morte e só resolve depois de a ver — ou de a assumir como **não
     * confirmada**, com o filho registado. Nunca resolve no instante do `kill()`.
     */
    const terminate = (status: AdlStatus, reason: string): void => {
      if (settled) return;
      if (!child) {
        // Nunca houve filho: nada para matar, nada para esperar, spawned honesto.
        publish(empty(status, reason, now, 0, null, false));
        return;
      }
      if (closeSeen || exitSeen) {
        /**
         * O filho JÁ acabou — visto por `close` ou por `exit`. Não há nada para
         * matar, e matar seria ativo: o PID pode ter sido reciclado por um
         * processo completamente alheio. Também não há dívida para registar, e
         * um `terminate` sem saída deixava a promessa pendurada para sempre
         * (era exatamente o bloqueio da v3).
         */
        publish(
          empty(status, killFailure ? `${reason}-kill-${killFailure}` : reason, now, spawned, true, false, false),
        );
        return;
      }
      // Um segundo pedido de morte para o mesmo filho não acrescenta verdade e
      // multiplicaria registo: o primeiro já está a ser acompanhado.
      if (requestedOutcome) return;
      requestedOutcome = { status, reason };
      const alvo = child;
      let killedWith: string;
      try {
        // `false` é um facto: no Windows quer dizer que o processo NÃO foi morto.
        // Registá-lo como SIGTERM seria afirmar um sucesso que o SO recusou.
        if (alvo.kill() === false) {
          killedWith = "kill-returned-false";
          killFailure = killFailure ?? "returned-false";
        } else {
          killedWith = "SIGTERM";
        }
      } catch {
        killedWith = "kill-threw";
        killFailure = killFailure ?? "threw";
      }
      const entry: PendingWorker = { pid: alvo.pid ?? null, since: now(), killedWith };
      pendingEntry = entry;
      pendingWorkers.add(entry);
      reapTimer = setTimeout(() => {
        if (settled) return;
        if (closeSeen || exitSeen) return;
        try {
          if (alvo.kill("SIGKILL") === false) {
            entry.killedWith = "SIGKILL-returned-false";
            killFailure = killFailure ?? "sigkill-returned-false";
          } else {
            entry.killedWith = "SIGKILL";
          }
        } catch {
          entry.killedWith = "SIGKILL-threw";
          killFailure = killFailure ?? "sigkill-threw";
        }
        const alive = probeChild(entry.pid);
        if (alive === false) {
          // O SO afirma que o processo não existe. Deixa de ser órfão, mas não
          // lhe chamamos «encerramento confirmado»: nunca vimos `close`/`exit`.
          pendingWorkers.delete(entry);
          if (pendingEntry === entry) pendingEntry = null;
          publish(empty(status, `${reason}${killSuffix()}-absent`, now, spawned, false, false, false));
          return;
        }
        // Morte não confirmada: resolve como órfão registado, nunca como ok.
        publish(empty(status, `${reason}${killSuffix()}-unconfirmed`, now, spawned, false, true, alive));
      }, reapGraceMs);
    };

    const timer = setTimeout(() => {
      terminate("timeout", "worker-timeout");
    }, timeoutMs);

    // Cancelação do consumidor: mesmo caminho do timeout, razão distinta, e sem
    // backoff — quem cancelou não é uma avaria do provider.
    const signal = options.signal;
    if (signal) {
      if (signal.aborted) {
        publish(empty("error", "worker-cancelled-before-start", now, 0, null, false));
        return;
      }
      signal.addEventListener("abort", () => {
        if (settled) return;
        if (!child) {
          publish(empty("error", "worker-cancelled-before-start", now, 0, null, false));
          return;
        }
        terminate("error", "worker-cancelled");
      }, { once: true });
    }

    // Sem `koffi` (dependência opcional) não há como ler a ADL: latch e — o que
    // importa para a regra anti-tempestade — ZERO processos criados.
    if (!options.spawnWorker && !options.assumeFfi && !(await ffiIsPresent())) {
      latchedUnsupported = "ffi-module-absent";
      publish(empty("unsupported", latchedUnsupported, now, 0, null, false));
      return;
    }

    // Ponto crítico corrigido: este `await` era o intervalo em que o timeout
    // podia disparar e, na versão anterior, o spawn acontecia **depois** de a
    // operação já se ter resolvido. Aqui, resolvido = nunca mais criar filho.
    if (settled) return;

    try {
      child = options.spawnWorker
        ? (options.spawnWorker(workerPath, dllPath) as ChildHandle)
        : (spawn(process.execPath, [workerPath], {
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
            env: { ...process.env, CYBERSAFE_ADL_DLL: dllPath },
          }) as ChildHandle);
      spawned = 1;
    } catch {
      publish(empty("error", "worker-spawn-failed", now, 0, null, false));
      return;
    }

    // Se o timeout ou a cancelação aconteceram durante o arranque do filho,
    // mata-se imediatamente com confirmação — não se abandona um processo vivo.
    if (settled) {
      terminate("timeout", "worker-timeout");
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 4 * 1024 * 1024) {
        terminate("error", "worker-output-too-large");
      }
    });
    /**
     * O evento `error` do `ChildProcess` NÃO significa só «não conseguiu
     * arrancar»: a documentação do Node inclui explicitamente «não conseguiu
     * matar» e falhas de pipes/mensagem. Confundir os dois foi o defeito da v2 —
     * um erro ao matar resolvia `worker-spawn-failed` com `orphaned: false`
     * enquanto o filho continuava registado como pendente, e o `publish`
     * desarmava a graça que ainda ia a tempo de o matar.
     *
     * As três situações têm de sair diferentes:
     *   a) sem PID  → efectivamente não há processo: falha de spawn;
     *   b) morte já pedida → é falhanço da TERMINAÇÃO: não resolvemos aqui,
     *      mantemos a graça a correr e o rasto pendente até `close`/`exit`;
     *   c) filho vivo sem pedido nosso → matar com confirmação, nunca abandonar.
     */
    child.on("error", (err: unknown) => {
      const code = (err as { code?: string } | null)?.code ?? null;
      if (settled) return;
      const pidDesconhecido = child === null || child.pid === undefined;
      if (pidDesconhecido && !requestedOutcome) {
        // (a) Não existe processo para matar nem para aguardar: spawned 0 e nada
        // pendente. liberta os listeners que acabámos de pendurar no objeto.
        releaseChild();
        publish(empty("error", code ? `worker-spawn-failed-${code}` : "worker-spawn-failed", now, 0, null, false));
        return;
      }
      if (requestedOutcome) {
        // (b) Já tínhamos pedido a morte. Isto é prova de que ela FALHOU, não de
        // que nunca houve filho. Guardamos a evidência e deixamos a graça correr.
        killFailure = killFailure ?? (code ?? "unknown");
        return;
      }
      // (c) Erro num filho que existe e que não pedimos para matar.
      terminate("error", code ? `worker-error-${code}` : "worker-error");
    });
    /**
     * `exit` = o processo acabou; `close` = os pipes fecharam. São perguntas
     * diferentes: um worker com um pipe pendurado emite `exit` e pode nunca
     * emitir `close`. A morte confirma-se no `exit`, mas a leitura só se decide
     * no `close`, quando o stdout está completo.
     */
    child.on("exit", () => {
      exitSeen = true;
      if (pendingEntry) {
        pendingWorkers.delete(pendingEntry);
        pendingEntry = null;
      }
      if (settled) return;
      if (requestedOutcome) {
        publish(
          empty(
            requestedOutcome.status,
            `${requestedOutcome.reason}${killSuffix()}`,
            now,
            spawned,
            true,
            false,
            false,
          ),
        );
        return;
      }
      /**
       * `exit` natural sem `close`: pode ser um neto a herdar o pipe, e então
       * o `close` nunca chega. Dar-lhe o timeout inteiro prendia o `inFlight`
       * e o timeout seguinte mataria um PID que já pode ser de outro processo.
       * Do-lhe um prazo limitado e depois digo a verdade: não houve encerramento
       * de pipes, logo não há stdout completo, logo não há leitura para servir.
       */
      exitWaitTimer = setTimeout(() => {
        publish(empty("error", "worker-exited-without-close", now, spawned, true, false, false));
      }, reapGraceMs);
    });
    child.on("close", (code, signalName) => {
      closeSeen = true;
      releaseChild();
      // Timeout/cancelação já pedida: a morte é a notícia, não o resultado.
      if (settled) return;
      if (requestedOutcome) {
        // Morreu porque nós o matámos. Confirma-se o encerramento e publica-se
        // o estado pedido, nunca `worker-signal-*` disfarçado de avaria. Se o
        // caminho até aqui incluiu um `kill()` recusado, isso vai na razão.
        publish(
          empty(requestedOutcome.status, `${requestedOutcome.reason}${killSuffix()}`, now, spawned, true, false, false),
        );
        return;
      }
      if (code !== 0 || signalName) {
        // Crash do worker (ex.: access violation dentro da ADL) fica contido.
        publish(empty("error", signalName ? `worker-signal-${signalName}` : `worker-exit-${code}`, now, spawned, true, false, false));
        return;
      }
      const worker = workerStatusOf(stdout);
      if (worker.status === "unsupported") {
        publish(empty("unsupported", worker.reason ?? "adl-unsupported", now, spawned, true, false, false));
        return;
      }
      if (worker.status === "error") {
        publish(empty("error", worker.reason ?? "worker-reported-error", now, spawned, true, false, false));
        return;
      }
      const samples = parseWorkerOutput(stdout);
      if (!samples) {
        publish(empty("error", "worker-unparseable-output", now, spawned, true, false, false));
        return;
      }
      publish({
        status: samples.length ? "ok" : "unsupported",
        reason: samples.length ? null : "no-adapters",
        samples,
        acquiredAt: new Date(started).toISOString(),
        spawned,
        closeConfirmed: true,
        orphaned: false,
        childAlive: false,
      });
    });
  });

  const flight = task.finally(() => {
    if (inFlight === flight) inFlight = null;
  });
  inFlight = flight;
  return flight;
}

/** Verdade sobre a última decisão de cancelamento — usada pelos testes de
 *  encerramento para provar que a abstração não foi apagada. */
export function adlBridgeIsAborted(signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted);
}
