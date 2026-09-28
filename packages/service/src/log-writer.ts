/**
 * Log hygiene + observability (Workstream F).
 *
 * Problema observado em produção: `error.log` e `boot-debug.log` em
 * `~/.cybersafe-service` cresceram para GB sem qualquer limite, porque eram
 * escritos com `fs.appendFileSync` cru (sem rotação nem retenção) num processo
 * que, como serviço Windows, não tem consola. A causa raiz era um ciclo de
 * realimentação EPIPE (ver `safeConsole` em index.ts).
 *
 * Este módulo dá aos logs do serviço:
 * - Rotação por tamanho máximo por ficheiro (.1, .2, ...)
 * - Retenção real: o ficheiro mais antigo além de `maxFiles` é REMOVIDO
 *   (a implementação anterior deslocava .N -> .N+1 para sempre e nunca
 *   apagava nada, pelo que o disco crescia sem limite mesmo com rotação)
 * - Dedupe de linhas consecutivas, com contador de repetições
 * - Reclaim one-shot de ficheiros já giganticamente acima do orçamento
 * - Correlação: `scanId` propagado para as linhas de log
 * - `SyncLogWriter` para caminhos de crash (uncaughtException / unhandledRejection
 *   não podem aguardar promises)
 * - Filtro de eventos: só persistimos eventos úteis, não o ruído de alta
 *   frequência (file.created/modified, process.started/exited, scan.progress)
 *
 * Invariante: em regime normal nada é apagado antes de estar rotacionado e
 * dentro da retenção. Só o reclaim de emergência trunca ficheiros
 * macroscopicamente acima do orçamento.
 */
import * as fs from "node:fs/promises";
import * as fss from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface LogWriterOptions {
  /** Tamanho máximo por ficheiro antes de rotacionar. */
  maxBytes?: number;
  /** Número máximo de ficheiros rotacionados retidos (.1 .. .maxFiles). */
  maxFiles?: number;
  /** Linhas consecutivas idênticas dentro desta janela são suprimidas. */
  dedupeWindowMs?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const DEFAULT_DEDUPE_MS = 2000;

/** Orçamentos por log. Total máximo = maxBytes * (1 + maxFiles). */
export const ERROR_LOG_BUDGET = { maxBytes: 8 * 1024 * 1024, maxFiles: 3 } as const;
export const BOOT_DEBUG_LOG_BUDGET = { maxBytes: 4 * 1024 * 1024, maxFiles: 3 } as const;

/**
 * Desloca as rotações e aplica a retenção.
 *
 * `.N -> .N+1` em ordem descendente (para nunca sobrescrever um ficheiro que
 * ainda vamos ler), `base -> .1`, e por fim `unlink(.maxFiles)` — este último
 * passo é o que torna a retenção real.
 */
function rotateSync(filePath: string, maxFiles: number): void {
  if (maxFiles < 1) maxFiles = 1;
  for (let i = maxFiles - 1; i >= 1; i--) {
    const from = `${filePath}.${i}`;
    const to = `${filePath}.${i + 1}`;
    try {
      fss.renameSync(from, to);
    } catch {
      /* ficheiro inexistente — nada a deslocar */
    }
  }
  try {
    fss.renameSync(filePath, `${filePath}.1`);
  } catch {
    return; // base inexistente: nada a rotacionar
  }
  // Retenção: o que ficou além de `maxFiles` é removido. É o passo que impede
  // o crescimento indefinido do directório de logs.
  try {
    fss.unlinkSync(`${filePath}.${maxFiles + 1}`);
  } catch {
    /* ainda não existe o ficheiro mais antigo */
  }
}

function ensureDirSync(dir: string): void {
  try {
    fss.mkdirSync(dir, { recursive: true });
  } catch {
    /* sem permissão — a escrita seguinte falha e é engolida em silêncio */
  }
}

/**
 * Conta e comprime linhas consecutivas idênticas.
 *
 * Numa transição (a linha deixa de repetir) é preciso escrever DUAS coisas:
 * o fecho do bloco anterior (`linha (xN)`) e a linha nova. Por isso
 * `admit` devolve um array — devolver só uma das duas perderia linhas:
 * a nova ficaria pendente até à próxima transição e, no fim do processo,
 * nunca seria escrita.
 *
 * A primeira ocorrência escreve `line`. As repetições dentro da janela são
 * absorvidas. Assim perdemos o volume, não a informação de que o problema se
 * repetiu N vezes.
 */
class Dedupe {
  private lastKey = "";
  private lastAt = 0;
  private repeats = 0;

  /** Linhas a escrever agora (pode ser vazio se tudo foi suprimido). */
  admit(line: string, now: number, windowMs: number): string[] {
    if (this.lastKey === "") {
      this.lastKey = line;
      this.lastAt = now;
      this.repeats = 0;
      return [line];
    }
    if (line === this.lastKey && now - this.lastAt < windowMs) {
      this.repeats++;
      return [];
    }
    // Transição. A linha anterior já foi escrita quando foi admitida, por isso
    // só emitimos um fecho com contador se houve mesmo repetições suprimidas
    // (repeats > 0) — caso contrário voltaríamos a escrever a mesma linha.
    const out: string[] = [];
    if (this.repeats > 0) out.push(`${this.lastKey} (x${this.repeats + 1})`);
    this.lastKey = line;
    this.lastAt = now;
    this.repeats = 0;
    out.push(line);
    return out;
  }

  /** Fecha a linha pendente, para não perder a contagem no fim do processo. */
  flush(): string | null {
    if (this.lastKey === "" || this.repeats === 0) {
      this.repeats = 0;
      return null;
    }
    const flushed = `${this.lastKey} (x${this.repeats + 1})`;
    this.repeats = 0;
    return flushed;
  }
}

/**
 * Escritor de log para caminhos que não podem aguardar (uncaughtException,
 * unhandledRejection, bootstrap antes do event loop). Rotação e retenção
 * síncronas: são operações de metadados inexpensive e O(1).
 */
export class SyncLogWriter {
  private readonly dedupe = new Dedupe();

  constructor(
    private readonly dir: string,
    private readonly name: string,
    private readonly options: LogWriterOptions = {},
  ) {}

  get filePath(): string {
    return path.join(this.dir, this.name);
  }

  write(line: string): void {
    try {
      const out = this.dedupe.admit(line, Date.now(), this.options.dedupeWindowMs ?? DEFAULT_DEDUPE_MS);
      if (out.length === 0) return;
      ensureDirSync(this.dir);
      const filePath = this.filePath;
      const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
      const maxFiles = this.options.maxFiles ?? DEFAULT_MAX_FILES;
      let size = 0;
      try {
        size = fss.statSync(filePath).size;
      } catch {
        size = 0;
      }
      if (size >= maxBytes) rotateSync(filePath, maxFiles);
      fss.appendFileSync(filePath, out.map((l) => `${l}\n`).join(""), "utf-8");
    } catch {
      // Um log nunca pode derrubar o serviço.
    }
  }

  /** Escreve o bloco pendente com o contador de repetições. */
  flush(): void {
    try {
      const pending = this.dedupe.flush();
      if (pending === null) return;
      fss.appendFileSync(this.filePath, `${pending}\n`, "utf-8");
    } catch {
      /* best effort */
    }
  }
}

/** Escritor assíncrono, com a mesma rotação/retenção/dedupe. */
export class LogWriter {
  private readonly dedupe = new Dedupe();
  /** Serializa as escritas para evitar rotações concorrentes. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly name: string,
    private readonly options: LogWriterOptions = {},
  ) {}

  get filePath(): string {
    return path.join(this.dir, this.name);
  }

  async write(line: string): Promise<void> {
    const out = this.dedupe.admit(line, Date.now(), this.options.dedupeWindowMs ?? DEFAULT_DEDUPE_MS);
    if (out.length === 0) return;
    const payload = out.map((l) => `${l}\n`).join("");
    const task = this.queue.then(() => this.append(payload));
    // A fila nunca pode gerar unhandledRejection.
    this.queue = task.catch(() => {});
    return task;
  }

  private async append(payload: string): Promise<void> {
    const filePath = this.filePath;
    const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxFiles = this.options.maxFiles ?? DEFAULT_MAX_FILES;
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const size = await fs.stat(filePath).then((s) => s.size, () => 0);
      // `await` é obrigatório: sem isto a rotação corre em paralelo com o
      // append e uma escrita pode cair no ficheiro a ser renomeado.
      if (size >= maxBytes) await rotateAsync(filePath, maxFiles);
      await fs.appendFile(filePath, payload, "utf-8");
    } catch {
      // idem: um log não derruba o serviço
    }
  }
}

async function rotateAsync(filePath: string, maxFiles: number): Promise<void> {
  if (maxFiles < 1) maxFiles = 1;
  for (let i = maxFiles - 1; i >= 1; i--) {
    await fs.rename(`${filePath}.${i}`, `${filePath}.${i + 1}`).catch(() => {});
  }
  await fs.rename(filePath, `${filePath}.1`).catch(() => {});
  await fs.unlink(`${filePath}.${maxFiles + 1}`).catch(() => {});
}

/**
 * Reclaim de emergência para um log que já está macroscopicamente acima do
 * orçamento (ex.: 3.3 GB com orçamento de 8 MB).
 *
 * Só trunca quando `size > maxBytes * maxFiles`; nesse caso guarda apenas os
 * `maxBytes` mais recentes. É a única operação deste módulo que perde
 * histórico, e só quando esse histórico é, por construção, ruído de runaway.
 * Abaixo do limite de truncar, o ficheiro é apenas rotacionado (nada apagado).
 */
export function reclaimOversizedLog(filePath: string, maxBytes: number, maxFiles: number): void {
  let size: number;
  try {
    size = fss.statSync(filePath).size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;
  if (size <= maxBytes * Math.max(maxFiles, 1)) {
    rotateSync(filePath, maxFiles);
    return;
  }
  try {
    const fd = fss.openSync(filePath, "r");
    try {
      const keep = Buffer.allocUnsafe(maxBytes);
      const read = fss.readSync(fd, keep, 0, maxBytes, size - maxBytes);
      const trimmed = keep.subarray(0, read);
      // Descarta a primeira linha parcial deixada pelo corte.
      const firstNl = trimmed.indexOf(0x0a);
      const body = firstNl >= 0 ? trimmed.subarray(firstNl + 1) : trimmed;
      fss.closeSync(fd);
      const tmp = `${filePath}.trim`;
      fss.writeFileSync(tmp, body, "utf-8");
      fss.renameSync(tmp, filePath);
    } finally {
      try {
        fss.closeSync(fd);
      } catch {
        /* já fechado */
      }
    }
  } catch {
    return;
  }
  rotateSync(filePath, maxFiles);
}

/** Escritores dos logs de eventos/ações do motor. */
export function createServiceLogWriters(baseDir: string) {
  const logsDir = path.join(baseDir, "logs");
  return {
    events: new LogWriter(logsDir, "security-events.log", { maxBytes: 5 * 1024 * 1024, maxFiles: 3 }),
    actions: new LogWriter(logsDir, "actions.log", { maxBytes: 5 * 1024 * 1024, maxFiles: 3 }),
    logsDir,
  };
}

/** Directório base do serviço (`~/.cybersafe-service`). */
export function serviceBaseDir(): string {
  return path.join(os.homedir(), ".cybersafe-service");
}

export function errorLogPath(baseDir = serviceBaseDir()): string {
  return path.join(baseDir, "error.log");
}

export function bootDebugLogPath(baseDir = serviceBaseDir()): string {
  return path.join(baseDir, "boot-debug.log");
}

/**
 * Eventos que valem a pena persistir em disco.
 *
 * `file.created`/`file.modified`/`process.started`/`process.exited` e
 * `scan.progress` são ruído de alta frequência alimentado por ETW/watcher
 * (dezenas a milhares por minuto). Continuam a ser transmitidos em direto para
 * a UI via broadcast — deixamos de os escrever em security-events.log.
 */
const PERSISTED_EVENT_TYPES = new Set([
  "process.blocked",
  "process.killed",
  "threat.detected",
  "quarantine.added",
  "quarantine.restored",
  "quarantine.deleted",
  "persistence.detected",
  "engine.health",
]);

export function shouldPersistEvent(event: { type?: string } | null | undefined): boolean {
  if (!event || typeof event.type !== "string") return false;
  return PERSISTED_EVENT_TYPES.has(event.type);
}

/** Extrai o `scanId` de um evento/progresso, de onde vier. */
export function scanIdFromContext(context?: { scanId?: string; id?: string; data?: { scanId?: string; id?: string } }): string | undefined {
  if (!context) return undefined;
  if (context.scanId) return context.scanId;
  if (context.data?.scanId) return context.data.scanId;
  if (context.data?.id && String(context.data.id).startsWith("scan-")) return context.data.id;
  if (context.id) return context.id;
  return undefined;
}

/** Formata uma linha de log de scan com o `scanId` para correlação. */
export function formatScanLog(scanId: string | undefined, message: string): string {
  return scanId ? `[scan ${scanId}] ${message}` : message;
}

/**
 * Limitador de taxa para logs de consola de alta frequência.
 *
 * Substitui os `console.log` por ficheiro que o motor emitia uma vez por
 * ficheiro analisado/excluído. Não faz benchmark de disco: apenas garante
 * que o mesmo motivo não é impresso milhares de vezes.
 */
export class RateLimitedLogger {
  private lastAt = new Map<string, number>();
  private suppressed = new Map<string, number>();

  constructor(
    private readonly minIntervalMs = 2000,
    private readonly enabled: boolean = true,
  ) {}

  /** Devolve `true` se esta mensagem deve ser impressa agora. */
  admit(key: string, now = Date.now()): boolean {
    if (!this.enabled) return false;
    // `has` (e não `?? 0`) porque 0 é um instante válido: sem isto, a primeira
    // chamada com now=0 seria confundida com "já admitida à frente".
    const last = this.lastAt.get(key);
    if (last !== undefined && now - last < this.minIntervalMs) {
      this.suppressed.set(key, (this.suppressed.get(key) ?? 0) + 1);
      return false;
    }
    this.suppressed.set(key, 0);
    this.lastAt.set(key, now);
    return true;
  }

  /** Quantas mensagens foram suprimidas para esta chave. */
  suppressedCount(key: string): number {
    return this.suppressed.get(key) ?? 0;
  }

  reset(): void {
    this.lastAt.clear();
    this.suppressed.clear();
  }
}
