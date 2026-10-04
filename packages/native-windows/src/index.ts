import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import * as si from "systeminformation";
import type { ConnectionSnapshot, ProcessSnapshot } from "@cybersafe/shared-types";

export * from "./wfp-filter.js";
export * from "./amsi-provider.js";
export * from "./etw-consumer.js";
export * from "./powershell.js";
import { WindowsHealthEngine } from "./powershell.js";

export interface FileObservation {
  kind: "file.created" | "file.modified" | "file.renamed";
  path: string;
  observedAt: string;
}

export interface PersistenceObservation {
  kind: "registry.persistence.changed" | "scheduledtask.changed";
  path: string;
  observedAt: string;
  value?: string;
}

export interface NativeWindowsWatcherEvents {
  "file.created": (event: FileObservation) => void;
  "file.modified": (event: FileObservation) => void;
  "file.renamed": (event: FileObservation) => void;
  "registry.persistence.changed": (event: PersistenceObservation) => void;
  "scheduledtask.changed": (event: PersistenceObservation) => void;
}

/**
 * Erros esperados num watcher de filesystem do Windows. Não indicam problema
 * real: acontecem em junctions/reparse points (Documents\Meus Vídeos), em
 * pastas temporárias que desaparecem (Temp\WinSAT, __PSScriptPolicyTest_*.ps1)
 * e em ficheiros cujas permissões mudam a meio. Devem ser tolerados e
 * deduplicados, nunca spam de stack trace.
 */
export function isTransientWatcherError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "ENOENT" || code === "EACCES" || code === "EBUSY";
}

/** Extrai a chave estável (sem números voláteis) para agrupar erros repetidos. */
export function watcherErrorKey(error: unknown): string {
  const err = error as NodeJS.ErrnoException | null;
  const code = err?.code ?? "UNKNOWN";
  const rawPath = (err?.path as string | undefined) ?? "";
  // Normaliza prefixos temporários com sufixo aleatório (njhm4xe4, __PSScriptPolicyTest_x.ps1).
  const normalized = rawPath
    .replace(/__PSScriptPolicyTest_[^\\/]*/gi, "__PSScriptPolicyTest_*")
    .replace(/[\\/][a-z0-9]{6,8}(?=[\\/]|$)/gi, "\\*");
  return `${code}:${normalized}`;
}

/**
 * Deduplicação/rate-limit de erros do watcher. Mantém uma linha agregada por
 * assinatura e reporta quantas ocorrências foram suprimidas.
 */
export class WatcherErrorDeduper {
  private counts = new Map<string, number>();
  private lastLogged = new Map<string, number>();
  constructor(private readonly repeatWindowMs = 60_000) {}

  /** Devolve `null` quando o erro deve ser silenciado (já reportado na janela). */
  record(error: unknown, now = Date.now()): { key: string; suppressed: number } | null {
    const key = watcherErrorKey(error);
    const total = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, total);
    const last = this.lastLogged.get(key);
    // Primeira ocorrência desta assinatura é sempre reportada.
    if (last !== undefined && now - last < this.repeatWindowMs) return null;
    this.lastLogged.set(key, now);
    const suppressed = total - 1;
    this.counts.set(key, 0);
    return { key, suppressed };
  }
}

export class NativeWindowsWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private registryTimer: NodeJS.Timeout | null = null;
  private lastRegistrySnapshot = "";
  private validatedPaths: string[] = [];
  private errorDeduper = new WatcherErrorDeduper();

  getDefaultPaths() {
    const home = os.homedir();
    return [
      path.join(home, "Downloads"),
      path.join(home, "Desktop"),
      path.join(home, "Documents"),
      os.tmpdir(),
      path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
      "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
    ];
  }

  /**
   * Validates and filters paths to only include those that are accessible.
   * Logs detailed information about paths that fail validation.
   */
  private async validateAndFilterPaths(paths: string[]): Promise<string[]> {
    const validPaths: string[] = [];
    const invalidPaths: Array<{ path: string; reason: string }> = [];

    for (const p of paths) {
      try {
        // Check if path exists and is accessible
        await fs.access(p, fs.constants.R_OK);
        validPaths.push(p);
        console.log(`[NativeWindowsWatcher] Path validated: ${p}`);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        let reason = "Unknown error";

        if (err.code === "ENOENT") {
          reason = "Path does not exist";
        } else if (err.code === "EACCES" || err.code === "EPERM") {
          reason = `Permission denied (${err.code})`;
        } else {
          reason = `Error: ${err.code || err.message}`;
        }

        invalidPaths.push({ path: p, reason });
        console.warn(
          `[NativeWindowsWatcher] Path validation failed: ${p} - ${reason}`
        );
      }
    }

    if (validPaths.length === 0 && paths.length > 0) {
      const failedList = invalidPaths.map((ip) => `  - ${ip.path} (${ip.reason})`).join("\n");
      console.error(
        `[NativeWindowsWatcher] CRITICAL: All ${paths.length} paths failed validation:\n${failedList}`
      );
    } else if (invalidPaths.length > 0) {
      console.warn(
        `[NativeWindowsWatcher] Proceeding with ${validPaths.length}/${paths.length} paths. Skipped paths:`
      );
      for (const ip of invalidPaths) {
        console.warn(`  - ${ip.path} (${ip.reason})`);
      }
    }

    return validPaths;
  }

  async start(paths = this.getDefaultPaths()): Promise<void> {
    // Validate and filter paths before creating watcher
    this.validatedPaths = await this.validateAndFilterPaths(paths);

    if (this.validatedPaths.length === 0) {
      throw new Error(
        "[NativeWindowsWatcher] Cannot start watcher: no accessible paths available"
      );
    }

    // Temp continua a ser monitorizado (é uma área relevante para segurança),
    // mas toleramos erros transitórios e ignoramos apenas os artefactos
    // temporários do próprio CyberSafe (evita que o scan reaja a si próprio).
    const ownTempPattern = /cybersafe-(zip|scanner|temp|probe)/i;

    // Destroy any existing watcher to prevent resource leak
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    this.watcher = chokidar.watch(this.validatedPaths, {
      persistent: true,
      ignoreInitial: true,
      // Junctions/reparse points NÃO são seguidos (Documents\Meus Vídeos,
      // Minhas Imagens, Minhas Músicas) — evita loops e spam de EPERM.
      followSymlinks: false,
      ignored: [
        /(^|[\/\\])\../, // ignore hidden files
        /node_modules/, // ignore node_modules
        /\.log$/, // ignore log files
        /cybersafe-assistant[\/\\]logs/, // specific ignore for app logs
        ownTempPattern, // ignore own temp artifacts (keep watching Temp otherwise)
      ],
      awaitWriteFinish: {
        stabilityThreshold: 3000,
        pollInterval: 2000,
      },
    });

    // Erros de runtime: esperados/transitórios são tolerados + deduplicados;
    // os inesperados continuam visíveis (uma vez).
    this.watcher.on("error", (error) => {
      const transient = isTransientWatcherError(error);
      const record = this.errorDeduper.record(error);
      if (record) {
        const suffix = record.suppressed > 0 ? ` (${record.suppressed} ocorrências suprimidas)` : "";
        const message = `[NativeWindowsWatcher] ${transient ? "Watch error tolerado" : "Watch error"} ${record.key}${suffix}`;
        if (transient) console.warn(message);
        else console.error(message);
      }
      // Emit as internal event for diagnostics but don't crash
      this.emit("watcher.error", { error, timestamp: new Date().toISOString() });
    });

    this.watcher
      .on("add", (entryPath) => this.emit("file.created", {
        kind: "file.created",
        path: entryPath,
        observedAt: new Date().toISOString(),
      }))
      .on("change", (entryPath) => this.emit("file.modified", {
        kind: "file.modified",
        path: entryPath,
        observedAt: new Date().toISOString(),
      }))
      .on("unlink", (entryPath) => this.emit("file.renamed", {
        kind: "file.renamed",
        path: entryPath,
        observedAt: new Date().toISOString(),
      }));

    console.log(
      `[NativeWindowsWatcher] File watcher started on ${this.validatedPaths.length} paths`
    );

    await this.captureRegistrySnapshot();
    this.registryTimer = setInterval(() => {
      void this.captureRegistrySnapshot();
    }, 30_000);
  }

  private registryInFlight = false;

  private async captureRegistrySnapshot() {
    if (this.registryInFlight) return;
    this.registryInFlight = true;
    try {
      const snapshot = await readRegistryRunKeys();
      if (this.lastRegistrySnapshot && this.lastRegistrySnapshot !== snapshot) {
        this.emit("registry.persistence.changed", {
          kind: "registry.persistence.changed",
          path: "HKCU/HKLM Run keys",
          observedAt: new Date().toISOString(),
        });
      }
      this.lastRegistrySnapshot = snapshot;
    } finally {
      this.registryInFlight = false;
    }
  }

  async stop() {
    if (this.registryTimer) {
      clearInterval(this.registryTimer);
      this.registryTimer = null;
    }
    if (this.watcher) {
      try {
        await this.watcher.close();
      } catch (error) {
        console.error("[NativeWindowsWatcher] Error closing watcher:", error);
      }
      this.watcher = null;
    }
    this.validatedPaths = [];
    console.log("[NativeWindowsWatcher] File watcher stopped");
  }
}

/**
 * Cadencia de DESCOBERTA de processos. É o número que governa a fase da
 * latência com que um processo novo aparece na lista, e é a fonte de verdade
 * que o `PROCESS_TRUTH_TTL_MS` do serviço tem de seguir.
 *
 * Escolhido por medição, e a medição disse para NÃO mexer. Numa máquina com
 * 355+ processos:
 *   - uma enumeração CIM completa custa 338-364 ms de wall e 266-297 ms de CPU
 *     do próprio PowerShell (medido), dos quais ~204 ms/~188 ms são só o
 *     arranque do `powershell.exe` — o arranque, não a consulta, é o custo;
 *   - `tasklist` nativo, alternativa sem PowerShell, mede 376-403 ms: É MAIS
 *     LENTO, portanto não serve;
 *   - `systeminformation.processes()` devolve 0 ms em 4 de 5 chamadas: é um
 *     cache, não uma fonte de verdade;
 *   - A/B medido (5 s contra 10 s, mesma máquina, mesmo método, com a app a
 *     pedir a lista de 10 em 10 s): 2 enumerações em 30 s NAS DUAS configs, e
 *     CPU de máquina de 25,6% contra 28,2% — dentro do ruido. Encurtar o
 *     intervalo não compra latência nenhuma, porque com uma enumeração a
 *     demorar 8-12 s o `pollInFlight` salta o round seguinte de qualquer
 *     maneira: o que manda é o CUSTO DA ENUMERAÇÃO, não o intervalo.
 *
/**
 * Cadencia de DESCOBERTA de processos em REPOUSO (sem ninguem a olhar).
 * É o número que governa a fase da latência com que um processo novo aparece
 * na lista quando ninguem pediu a lista, e é a fonte de verdade que o
 * `PROCESS_TRUTH_TTL_MS` do serviço tem de seguir.
 *
 * Escolhido por medição, e a medição disse para NÃO mexer. Numa máquina com
 * 355+ processos:
 *   - uma enumeração CIM completa custa 338-364 ms de wall e 266-297 ms de CPU
 *     do próprio PowerShell (medido), dos quais ~204 ms/~188 ms são só o
 *     arranque do `powershell.exe` — o arranque, não a consulta, é o custo;
 *   - `tasklist` nativo, alternativa sem PowerShell, mede 376-403 ms: É MAIS
 *     LENTO, portanto não serve;
 *   - `systeminformation.processes()` devolve 0 ms em 4 de 5 chamadas: é um
 *     cache, não uma fonte de verdade;
 *   - A/B medido (5 s contra 10 s, mesma máquina, mesmo método, com a app a
 *     pedir a lista de 10 em 10 s): 2 enumerações em 30 s NAS DUAS configs, e
 *     CPU de máquina de 25,6% contra 28,2% — dentro do ruido. Encurtar o
 *     intervalo não compra latência nenhuma, porque com uma enumeração a
 *     demorar 8-12 s o `pollInFlight` salta o round seguinte de qualquer
 *     maneira: o que manda é o CUSTO DA ENUMERAÇÃO, não o intervalo.
 *
 * NOTA DE MEDIÇÃO (2026-09-30): oMaster mediu `snapshotProcesses()` em
 * 652, 284, 574, 582, 591, 594 ms — MEDIANA 591 ms, MAX 652 ms, com 355+
 * processos. Isto CONTRADIZ os 0,3 s citados acima e nas Medidas acima: o
 * custo real é ~0,6 s, não ~0,3 s. Onde este comentario e o do serviço dizem
 * 0,3 s, o número certo hoje é 0,6 s. Se um dia o custo mudar, mede-se e
 * actualiza-se — nunca por palpite.
 *
 * Passa a 5 s só quando a enumeração ficar ordens de grandeza mais barata (uma
 * sessão CIM persistente, por exemplo) — e nesse dia o número sai da medição
 * outra vez, não de um palpite.
 */
export const PROCESS_POLL_INTERVAL_MS = 10_000;

/**
 * Cadencia de DESCOBERTA enquanto alguém está a olhar (o serviço recebeu um
 * pedido `processes.list` nos últimos `PROCESS_OBSERVER_IDLE_MS`).
 *
 * O piso de 2000 ms sai da conta, não de uma preferência:
 *   591 ms por enumeração / 2000 ms = 29,6% de um núcleo, e é esse preço que
 *   compra ver o processo novo em menos de 2 s (um ciclo) em vez de esperar
 *   até 10 s (média 5 s).
 * A 1500 ms seriam 39,4% de um núcleo — daí o piso.
 *
 * NOTA: o intervalo não é a fase dominante quando a enumeração é cara; é
 * exatamente por isso que o ganho só compensa enquanto há observador. Em
 * repouso, pagar 29,6% de um núcleo a toda a hora seria absurdo.
 */
export const PROCESS_FAST_POLL_INTERVAL_MS = 2_000;

/**
 * Janela de inatividade sem pedidos de lista antes de voltar à cadência
 * lenta. Tem de ser MAIOR que a cadência rápida, senão oscila entre os dois
 * estados a cada round.
 */
export const PROCESS_OBSERVER_IDLE_MS = 15_000;

/** Opções do `ProcessMonitor` (seam de teste; produção não passa nada). */
export interface ProcessMonitorOptions {
  /** Relógio injetável, para testar a janela de inatividade sem esperar. */
  now?: () => number;
}

export class ProcessMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private previous = new Map<number, ProcessSnapshot>();
  /**
   * Promessa da enumeração do SO EM CURSO, partilhada por TODOS os caminhos
   * (o tick do timer E `list()`).
   *
   * Antes havia dois guards independentes — `pollInFlight` aqui e
   * `processesEnumerating` no serviço — e o `list()` chamava
   * `snapshotProcesses()` DIRECTAMENTE, sem passar por nenhum deles. Um tick do
   * timer e um pedido da UI podiam então correr DUAS enumerações do SO em
   * paralelo, porque cada guard dizia "estou ocupado" apenas a si próprio. É
   * o padrão que produziu a tempestade de WMI descrita no serviço.
   *
   * Agora existe uma única promessa em curso: nunca há duas enumerações do SO
   * ao mesmo tempo, venha ela de onde vier.
   */
  private enumerationInFlight: Promise<Map<number, ProcessSnapshot>> | null = null;
  /** Ultimo instante em que alguem pediu a lista de processos. */
  private lastObserverAt: number | null = null;
  private readonly now: () => number;

  /**
   * Seam de teste, mesmo padrão do `SnapshotProcessesDeps` abaixo e do
   * `executor` desta página: por defeito é a enumeração real do SO, e o
   * chamador de produção nunca passa nada. Existe para o diff ser testável sem
   * WMI (e para nenhum teste poder transformar um "round" num poll de 5 s).
   */
  constructor(
    private readonly snapshot: () => Promise<Map<number, ProcessSnapshot>> = snapshotProcesses,
    options: ProcessMonitorOptions = {},
  ) {
    super();
    this.now = options.now ?? Date.now;
  }

  async start() {
    await this.poll();
    this.schedule();
  }

  /**
   * Marca "há alguém a olhar". Chamado pelo serviço a cada pedido de lista.
   * Reinicia a janela de inatividade, de propósito.
   */
  noteObserver() {
    this.lastObserverAt = this.now();
  }

  /** Há observador dentro da janela? (público para o teste) */
  hasObserver(): boolean {
    if (this.lastObserverAt === null) return false;
    return this.now() - this.lastObserverAt < PROCESS_OBSERVER_IDLE_MS;
  }

  /** O intervalo em vigor neste instante (público para o teste). */
  currentIntervalMs(): number {
    return this.hasObserver() ? PROCESS_FAST_POLL_INTERVAL_MS : PROCESS_POLL_INTERVAL_MS;
  }

  /**
   * O atraso até ao próximo round. Reinicia o timer de propósito: mudar de
   * intervalo não pode deixar um round lento de 10 s a meio da visualização.
   */
  scheduleDelayMs(): number {
    return this.currentIntervalMs();
  }

  /**
   * Agenda o próximo round com o intervalo em vigor. Usa `setTimeout` e não
   * `setInterval` porque é a única forma de reiniciar o atraso quando o
   * intervalo muda a meio do caminho.
   */
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.poll().finally(() => this.schedule());
    }, this.scheduleDelayMs());
    // Não segura o processo vivo só por causa do timer do poll.
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Enumeração do SO, single-flight partilhada. Todos os chamadores (o poll e
   * `list()`) partilham a mesma promessa enquanto ela estiver em curso.
   */
  private async enumerate(): Promise<Map<number, ProcessSnapshot>> {
    if (this.enumerationInFlight) return this.enumerationInFlight;
    this.enumerationInFlight = this.snapshot().finally(() => {
      this.enumerationInFlight = null;
    });
    return this.enumerationInFlight;
  }

  async list(): Promise<ProcessSnapshot[]> {
    // Passa pelo single-flight partilhado, e já não pela enumeração directa:
    // dois pedidos simultâneos são UMA enumeração do SO, não duas.
    return Array.from((await this.enumerate()).values());
  }

  /**
   * Um round de descoberta. Público (e não `private`) só para o seam de teste
   * poder correr rounds sem esperar pela cadência de produção.
   *
   * Um round que chega enquanto outro está em curso SAI (não espera, não
   * enfileira, não duplica). É o que o `pollInFlight` fazia antes, e continua
   * a ser o certo para um timer: a cadência degrada, a fila não cresce. O que
   * mudou é que a enumeração por baixo é agora a mesma promessa partilhada
   * com `list()`, portanto "sair" nunca significa "deixar passar" uma segunda
   * enumeração do SO.
   */
  async poll() {
    if (this.enumerationInFlight) return;
    let current: Map<number, ProcessSnapshot>;
    try {
      current = await this.enumerate();
    } catch (error) {
      console.warn("[ProcessMonitor] Round de poll ignorado (enumeração indisponível):", error);
      return;
    }

    for (const [pid, processInfo] of current.entries()) {
      if (!this.previous.has(pid)) {
        this.emit("process.started", processInfo);
      }
    }

    for (const [pid, processInfo] of this.previous.entries()) {
      if (!current.has(pid)) {
        this.emit("process.exited", processInfo);
      }
    }

    this.previous = current;
  }
}

/**
 * Fontes injetáveis de `snapshotProcesses` (seam de teste, mesmo padrão do
 * `executor` já usado nesta página). Por defeito são as reais; o chamador de
 * produção nunca passa nada.
 */
export interface SnapshotProcessesDeps {
  /** Fase (a) primária: devolve o stdout da enumeração CIM. */
  runPrimary?: () => Promise<string>;
  /** Fase (b): enriquecimento com systeminformation (cpu/mem/path/user). */
  enrich?: (map: Map<number, ProcessSnapshot>) => Promise<void>;
}

export async function snapshotProcesses(
  deps: SnapshotProcessesDeps = {},
): Promise<Map<number, ProcessSnapshot>> {
  const map = new Map<number, ProcessSnapshot>();

  // ── Fase (a) PRIMÁRIA (CIM) ──────────────────────────────────────────────
  // É a única fonte de verdade da lista. Se ela falha, esta função REJEITA:
  // devolver um Map vazio é afirmar "o SO não tem processos", que é mentira e
  // fazia o chamador apagar o cache e servir a lista vazia como fresca.
  // Quem chama decide o plano B (servir o cache) — a fronteira só diz a verdade.
  const runPrimary =
    deps.runPrimary ??
    (async () => {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);
      // Saída JSON (a versão CSV anterior partia campos com vírgulas e gerava dados corrompidos).
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine, @{n=\'CreatedIso\';e={$_.CreationDate.ToUniversalTime().ToString(\'o\')}} | ConvertTo-Json -Compress"',
        { windowsHide: true }
      );
      return stdout;
    });

  let rows: unknown;
  try {
    const raw = await runPrimary();
    rows = JSON.parse(raw.trim());
  } catch (err) {
    console.error("[ProcessMonitor] Falha ao coletar processos do S.O:", err);
    throw new Error("Enumeração de processos indisponível (CIM falhou)", { cause: err });
  }

  const list = Array.isArray(rows) ? rows : rows && typeof rows === "object" ? [rows] : [];
  const now = new Date().toISOString();

  for (const raw of list) {
    const pid = parseInt(raw.ProcessId, 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;

    map.set(pid, {
      pid,
      ppid: 0,
      name: String(raw.Name || `pid-${pid}`),
      path: "",
      commandLine: String(raw.CommandLine || ""),
      user: undefined,
      cpu: 0,
      memoryMb: 0,
      // A IDENTIDADE DE CRIAÇÃO do processo, não a hora do poll.
      //
      // Isto era `now` — o instante da enumeração — e é o que tornava a defesa
      // de ownership (P1-6) um placebo: todos os processos de um snapshot
      // partilhavam a mesma data, logo comparar "a identidade registada" com a
      // "identidade observada" nunca podia bater certo, e o registo era
      // descartado a cada poll — devolvendo a cascata do P0.
      //
      // O CIM devolve CreationDate em formato DMTF; pedimos o ISO já formatado
      // para não interpretar DMTF em TypeScript. Sem CreationDate (CIM antigo,
      // acesso parcial) caímos em `now`, que é o comportamento antigo — degradado,
      // mas honesto: sem identidade não há prova de ownership.
      startedAt: String(raw.CreatedIso || now),
      signer: undefined,
      trusted: "neutral",
    });
  }

  // Primária devolveu zero processos utilizáveis = também não-verdade (no Windows
  // há sempre processos). Mesma política: falhar alto em vez de lista vazia.
  if (map.size === 0) {
    throw new Error("Enumeração de processos devolveu zero registos (CIM sem verdade)");
  }

  // ── Fase (b) ENRIQUECIMENTO (systeminformation) ─────────────────────────
  // Opcional por natureza: a lista JÁ está completa sem ele. Falhar aqui é
  // perder cpu/mem/path, não a verdade — logo NUNCA vira erro.
  const enrich =
    deps.enrich ??
    (async (target: Map<number, ProcessSnapshot>) => {
      const siProcesses = await si.processes();
      for (const p of siProcesses.list) {
        const existing = target.get(Number(p.pid));
        if (existing) {
          existing.cpu = Math.round((p.cpu ?? 0) * 10) / 10;
          existing.memoryMb = Math.round((p.memRss ?? 0) / 1024);
          existing.path = (p as any).path || existing.path;
          existing.ppid = Number((p as any).parentPid || 0);
          existing.user = p.user || existing.user;
        }
      }
    });

  try {
    await enrich(map);
  } catch (err) {
    // Lista verdadeira, só sem métricas: segue na mesma.
    console.warn("[ProcessMonitor] Enriquecimento (systeminformation) falhou; lista sem cpu/mem:", err);
  }

  return map;
}

export async function snapshotConnections(): Promise<ConnectionSnapshot[]> {
  try {
    // No Windows, systeminformation depende do netstat em inglês e falha em locales
    // como o português. Usa Get-NetTCPConnection (estável em qualquer locale).
    const engine = new WindowsHealthEngine();
    const res = await engine.executor.run<Array<{
      LocalAddress?: string;
      LocalPort?: number;
      RemoteAddress?: string;
      RemotePort?: number;
      State?: string;
      OwningProcess?: number;
    }>>("tcpConnections");

    if (!res.ok || !res.data) return [];

    // Map numeric TcpState values (from Get-NetTCPConnection) to human-readable names
    const STATE_MAP: Record<string, string> = {
      "1": "Listen",
      "2": "SynSent",
      "3": "SynReceived",
      "4": "Established",
      "5": "FinWait1",
      "6": "FinWait2",
      "7": "CloseWait",
      "8": "Closing",
      "9": "LastAck",
      "10": "TimeWait",
      "11": "DeleteTCB",
      "12": "Bound",
      // Also handle string values that PowerShell may return directly
      "Listen": "Listen",
      "SynSent": "SynSent",
      "SynReceived": "SynReceived",
      "Established": "Established",
      "FinWait1": "FinWait1",
      "FinWait2": "FinWait2",
      "CloseWait": "CloseWait",
      "Closing": "Closing",
      "LastAck": "LastAck",
      "TimeWait": "TimeWait",
      "DeleteTCB": "DeleteTCB",
    };

    const normalizeState = (raw: string): string => {
      if (!raw) return "Desconhecido";
      // Try numeric map first, then string map
      const mapped = STATE_MAP[raw] ?? STATE_MAP[raw.toLowerCase()];
      return mapped ?? "Desconhecido";
    };

    const isUnspecifiedAddress = (addr: string): boolean => {
      return !addr || addr === "0.0.0.0" || addr === "::" || addr === "[::]";
    };

    const seen = new Set<string>();
    const result: ConnectionSnapshot[] = [];
    for (const raw of res.data) {
      const localAddress = String(raw.LocalAddress || "0.0.0.0");
      const localPort = Number(raw.LocalPort) || 0;
      const remoteAddress = String(raw.RemoteAddress || "");
      const remotePort = Number(raw.RemotePort) || 0;
      const state = normalizeState(String(raw.State || ""));
      const key = `${localAddress}:${localPort}:${remoteAddress}:${remotePort}:${state}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const isListening = isUnspecifiedAddress(remoteAddress) || state === "Listen";

      // For listening sockets: show local address/port as the destination
      // and mark direction as inbound
      // For established connections: show remote address/port
      const displayAddress = isListening ? localAddress : remoteAddress;
      const displayPort = isListening ? localPort : remotePort;

      // Skip entries where the display address is still unspecified
      // (these are truly unbound sockets with no useful info)
      if (isUnspecifiedAddress(displayAddress) && displayPort === 0) continue;

      result.push({
        processPid: (raw.OwningProcess && raw.OwningProcess > 0) ? raw.OwningProcess : undefined,
        remoteAddress: displayAddress,
        remotePort: displayPort,
        protocol: "tcp",
        state,
        direction: isListening ? "inbound" : "outbound",
        observedAt: new Date().toISOString(),
      });
      if (result.length >= 200) break;
    }
    return result;
  } catch {
    return [];
  }
}

export async function terminateProcessTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function readRegistryRunKeys(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("powershell", [
      "-NoProfile",
      "-Command",
      "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' | ConvertTo-Json -Compress",
    ], { windowsHide: true });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("exit", () => resolve(stdout.trim()));
    child.on("error", () => resolve(""));
  });
}
