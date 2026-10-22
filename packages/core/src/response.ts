import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { AnalysisResult, ProcessKillProtectionReason, QuarantineEntry, KillProcessResult } from "@cybersafe/shared-types";

type StoredQuarantineEntry = QuarantineEntry & { originalMode?: number };
type QuarantineResult = { success: boolean; error?: string };

export class QuarantineManager {
  private readonly quarantineDir: string;
  private readonly manifestPath: string;
  private entries = new Map<string, StoredQuarantineEntry>();
  private pending: Promise<unknown> = Promise.resolve();

  constructor(baseDir: string) {
    this.quarantineDir = path.resolve(baseDir, "quarantine");
    this.manifestPath = path.join(this.quarantineDir, "manifest.json");
  }

  async init() {
    await fs.mkdir(this.quarantineDir, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.manifestPath, "utf-8")) as StoredQuarantineEntry[];
      this.entries = new Map(parsed.map((entry) => [entry.id, entry]));
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async flush(entries = this.entries) {
    const temporary = path.join(this.quarantineDir, `.manifest-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(Array.from(entries.values()), null, 2), "utf-8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, this.manifestPath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  // No recursive removal and no aliases outside the direct quarantine directory.
  // These checks assume the directory is not concurrently controlled by another writer.
  private async checkedSource(entry: StoredQuarantineEntry): Promise<string> {
    const file = entry.quarantinePath;
    if (typeof file !== "string" || !path.isAbsolute(file)
      || path.dirname(path.resolve(file)) !== this.quarantineDir
      || !path.basename(file).endsWith(".quarantine")) {
      throw new Error("Caminho de quarentena invalido.");
    }
    const root = await fs.lstat(this.quarantineDir);
    if (!root.isDirectory() || root.isSymbolicLink()
      || await fs.realpath(this.quarantineDir) !== this.quarantineDir) {
      throw new Error("Caminho de quarentena invalido.");
    }
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Ficheiro em quarentena em falta.");
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("Caminho de quarentena invalido.");
    }
    return file;
  }

  private async digest(file: string): Promise<string> {
    const digest = crypto.createHash("sha256");
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        digest.update(buffer.subarray(0, bytesRead));
      }
      return digest.digest("hex");
    } finally { await handle.close(); }
  }

  async quarantine(analysis: AnalysisResult): Promise<QuarantineEntry | null> {
    return this.serialize(async () => {
      let entry: StoredQuarantineEntry | undefined;
      let moved = false;
      try {
        const stat = await fs.lstat(analysis.artifactPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null;
        const sha256 = await this.digest(analysis.artifactPath);
        if (analysis.sha256 && sha256 !== analysis.sha256.toLowerCase()) return null;
        const current = await fs.lstat(analysis.artifactPath);
        if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs || current.ino !== stat.ino) return null;
        const id = crypto.randomUUID();
        const quarantinePath = path.join(this.quarantineDir, `${id}.quarantine`);
        const rules = Array.isArray(analysis.rulesTriggered) ? analysis.rulesTriggered.filter(Boolean) : [];
        entry = {
          id, originalPath: analysis.artifactPath, quarantinePath,
          fileName: analysis.fileName, sha256, verdict: analysis.verdict,
          riskScore: analysis.riskScore,
          // Preserva a razão real, sem inventar regras.
          detectionReason: rules.length > 0 ? rules.join(", ") : undefined,
          quarantinedAt: new Date().toISOString(), originalMode: stat.mode & 0o777,
          isolationStatus: "recovery-required",
        };
        // Persist recovery metadata before moving the only copy.
        const next = new Map(this.entries).set(id, entry);
        await this.flush(next);
        this.entries = next;
        await fs.rename(analysis.artifactPath, quarantinePath);
        moved = true;
        if (await this.digest(quarantinePath) !== sha256) throw new Error("Destino alterado durante o isolamento.");
        const destination = await fs.lstat(quarantinePath);
        if (!destination.isFile() || destination.isSymbolicLink() || destination.nlink !== 1) throw new Error("Destino de quarentena inválido.");
        try {
          await fs.lstat(analysis.artifactPath);
          throw new Error("O caminho original voltou a existir; isolamento não confirmado.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await fs.chmod(quarantinePath, 0o000);
        const confirmed: StoredQuarantineEntry = {...entry,isolationStatus:"confirmed"};
        const confirmedEntries = new Map(this.entries).set(id,confirmed);
        await this.flush(confirmedEntries);
        const persisted = JSON.parse(await fs.readFile(this.manifestPath,"utf8")) as StoredQuarantineEntry[];
        if (!persisted.some(item=>item.id===id && item.sha256===sha256 && item.quarantinePath===quarantinePath && item.isolationStatus==="confirmed")) throw new Error("Manifesto não confirmou isolamento.");
        this.entries = confirmedEntries;
        return confirmed;
      } catch {
        // A moved file retains its recovery entry, even when chmod fails.
        if (entry && moved) {
          // Confirmation may have been persisted before a read failed. Revert
          // metadata to uncertainty without moving or deleting the only bytes.
          try { await this.flush(this.entries); } catch { /* existing metadata and bytes are retained */ }
        }
        if (entry && !moved && this.entries.has(entry.id)) {
          const next = new Map(this.entries);
          next.delete(entry.id);
          try { await this.flush(next); this.entries = next; } catch { /* retain recovery metadata */ }
        }
        return null;
      }
    });
  }

  async restore(id: string, _restoredBy = "user"): Promise<QuarantineResult> {
    return this.serialize(async () => {
      const entry = this.entries.get(id);
      if (!entry) return { success: false, error: "Entrada de quarentena nao encontrada." };
      const staging = path.join(this.quarantineDir, `.restore-${crypto.randomUUID()}.tmp`);
      let published = false;
      try {
        const source = await this.checkedSource(entry);
        if (typeof entry.originalPath !== "string" || !path.isAbsolute(entry.originalPath)) {
          throw new Error("Caminho original invalido (nao e absoluto).");
        }
        if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
          throw new Error("Digest de quarentena ausente ou invalido; restauro recusado.");
        }
        const original = path.resolve(entry.originalPath);
        try {
          await fs.lstat(original);
          throw new Error("Ja existe um ficheiro nesse destino. Restauro recusado para nao o substituir.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        // Persistence failure must be detected before publishing any destination.
        await this.flush();
        await fs.mkdir(path.dirname(original), { recursive: true });
        if (await fs.realpath(path.dirname(original)) !== path.dirname(original)) {
          throw new Error("Pasta de destino com redirecionamento; restauro recusado.");
        }
        // Windows can read a read-only quarantine file without changing its mode.
        // On POSIX, open while owner-readable, then remove that permission BEFORE copying.
        let input;
        try { input = await fs.open(source, "r"); }
        catch (error) {
          if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await fs.chmod(source, 0o400);
          try { input = await fs.open(source, "r"); }
          finally {
            try { await fs.chmod(source, 0o000); }
            catch {
              await input?.close();
              throw new Error("Falha ao repor isolamento da quarentena; permissao de leitura pode permanecer. Restauro recusado.");
            }
          }
        }
        try {
          const output = await fs.open(staging, "wx", 0o600);
          try {
            const buffer = Buffer.alloc(64 * 1024);
            for (;;) {
              const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
              if (!bytesRead) break;
              await output.writeFile(buffer.subarray(0, bytesRead));
            }
            await output.sync();
          } finally { await output.close(); }
        } finally { await input.close(); }
        if (await this.digest(staging) !== entry.sha256.toLowerCase()) {
          throw new Error("Digest de quarentena diferente; restauro recusado.");
        }
        // Exclusive publication: EEXIST refuses even a destination created after the check.
        // Cross-volume/unsupported hard links fail closed; never fall back to rename.
        await fs.link(staging, original);
        published = true;
        await fs.unlink(staging);
        const mode = entry.originalMode;
        await fs.chmod(original, Number.isInteger(mode) && mode! >= 0 && mode! <= 0o777 ? mode! : 0o600);
        await this.checkedSource(entry);
        await fs.rm(source);
        const next = new Map(this.entries);
        next.delete(id);
        await this.flush(next);
        this.entries = next;
        return { success: true };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const detail = code === "EEXIST"
          ? "Ja existe um ficheiro nesse destino. Restauro recusado para nao o substituir."
          : (error as Error).message;
        return published
          ? { success: true, error: `Ficheiro restaurado; limpeza, permissoes ou metadados pendentes. Entrada preservada para recuperacao. ${detail}` }
          : { success: false, error: detail || "Falha ao restaurar o ficheiro." };
      } finally {
        await fs.rm(staging, { force: true }).catch(() => undefined);
      }
    });
  }

  async delete(id: string): Promise<QuarantineResult> {
    return this.serialize(async () => {
      const entry = this.entries.get(id);
      if (!entry) return { success: false, error: "Entrada de quarentena nao encontrada." };
      let removed = false;
      try {
        const source = await this.checkedSource(entry);
        await this.flush();
        await fs.rm(source);
        removed = true;
        const next = new Map(this.entries);
        next.delete(id);
        await this.flush(next);
        this.entries = next;
        return { success: true };
      } catch (error) {
        return removed
          ? { success: true, error: `Ficheiro eliminado; metadados pendentes. Entrada preservada para recuperacao. ${(error as Error).message}` }
          : { success: false, error: (error as Error).message || "Falha ao eliminar o ficheiro." };
      }
    });
  }

  list(): QuarantineEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => b.quarantinedAt.localeCompare(a.quarantinedAt));
  }
}

/** Prazo máximo para o `taskkill` terminar antes de ser abortado. */
export const TASKKILL_TIMEOUT_MS = 10_000;
/** Intervalo entre verificações de desaparecimento do PID. */
export const KILL_REAP_INTERVAL_MS = 150;
/** Prazo máximo à espera de que o PID desapareça depois do taskkill. */
export const KILL_REAP_DEADLINE_MS = 5_000;
/** Limite do stdout/stderr preservados por stream (o resto é cortado). */
export const TASKKILL_OUTPUT_CAP = 4_000;

export interface KillProcessTreeOptions {
  timeoutMs?: number;
  /** Seam de teste: substitui o `spawn` real. */
  spawnImpl?: typeof spawn;
}

/**
 * Primeira linha não vazia de stderr (fallback: stdout), aparada — é o
 * diagnóstico real que o `taskkill` escreveu, nunca uma mensagem inventada.
 */
export function firstDiagnosticLine(stdout: string, stderr: string): string {
  for (const source of [stderr, stdout]) {
    const line = source
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);
    if (line) return line.slice(0, 400);
  }
  return "";
}

export interface TaskkillOutcomeInput {
  /** Código de saída do taskkill; `null` quando não houve código (timeout/sinal). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface TaskkillOutcome {
  ok: boolean;
  status: "ok" | "not-found" | "access-denied" | "timeout" | "failed";
  error?: string;
}

/**
 * Normaliza o texto que o taskkill escreveu: minusculas, sem acentos, espaços
 * colapsados. Não é cosmético — no Windows em português a mensagem real é
 * "Não foi possível terminar o processo" e chega da codepage da consola com os
 * acentos partidos. Um regex com `ó` ao lado não apanha nada, e um falhanço
 * documentado pelo stderr ficava a parecer "falha genérica".
 */
export function normalizeTaskkillText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const ACCESS_DENIED_PATTERN =
  /acesso negado|acesso e negado|nao e possivel negar acesso|access is denied|access denied/;
/**
 * "O PID já não existe", em pt-PT e en-US.
 *
 * O Windows nunca escreve "process not found" a seco: escreve
 * `ERROR: The process "22660" not found.` e, em pt-PT,
 * `ERRO: O processo "22660" não foi encontrado.` — o PID vem sempre entre
 * aspas, entre "process" e "not found". Com o `combined` já sem aspas (ver
 * abaixo) sobra `the process not found`; as formas em pt-PT entram aqui
 * pela ordem em que o Windows as escreve, que não é a do `processo nao
 * encontrado` que já cá estava.
 *
 * As variantes da TAREFA (task, não processo) entram sem acentos porque o
 * `normalizeTaskkillText` os remove antes do match, e sem o nome no meio
 * porque o `combined` já não traz o que estava entre aspas — `ERRO: Não há
 * ocorrência da tarefa "41113" em execução.` reduz-se a `erro: nao ha
 * ocorrencia da tarefa em execucao`. A ordem NOT_FOUND antes de
 * TERMINATE_FAILED é o que impede o 255 de um PID morto de virar erro.
 */
const NOT_FOUND_PATTERN =
  /nao foi possivel encontrar o processo|processo nao encontrado|processo nao foi encontrado|nao foi encontrado o processo|nao existe o processo|nao ha ocorrencia da tarefa em execucao|nao ha nenhuma tarefa em execucao|nao ha ocorrencia da tarefa|nao existe a tarefa|task not found|nao ha instancia em execucao|process not found|unable to find the process|no running instance/;
/** A frase que acompanha o exit 255 quando nada da árvore pôde ser terminado. */
const TERMINATE_FAILED_PATTERN =
  /nao foi possivel terminar|could not be terminated|unable to terminate|falha ao terminar/;

/**
 * Tabela de classificação do `taskkill`, pura e testável:
 * - 0   → ok (terminado; a confirmação de desaparecimento é outra fase);
 * - 128 → o PID já não existia;
 * - 5, ou exit 1 com texto "acesso negado" → o Windows recusou (processo
 *   protegido / sem privilégios) — distinto de falha genérica;
 * - timeout → abortado no prazo;
 * - resto → failed com a mensagem real do taskkill quando existe.
 */
export function interpretTaskkillOutcome(input: TaskkillOutcomeInput): TaskkillOutcome {
  if (input.timedOut) {
    return { ok: false, status: "timeout", error: "taskkill excedeu o prazo de execução." };
  }
  const detail = firstDiagnosticLine(input.stdout, input.stderr);
  if (input.exitCode === 0) return { ok: true, status: "ok" };
  if (input.exitCode === 128) {
    return { ok: false, status: "not-found", error: detail || "O processo já não existe (taskkill: PID não encontrado)." };
  }
  if (input.exitCode === 5) {
    return { ok: false, status: "access-denied", error: detail || "Acesso negado ao terminar o processo (taskkill exit 5)." };
  }
  // O texto que se casa com os padrões vai SEM o que está entre aspas: o
  // taskkill identifica o alvo sempre assim (`The process "22660" not found.`)
  // e essa citação parte a frase ao meio, fazendo o 255 de um PID já morto
  // cair em "falha genérica" e o utilizador ver um erro onde já não havia nada
  // a fazer. Tira-se ANTES de normalizar, para o colapso de espaços do
  // `normalizeTaskkillText` tapar os dois espaços que ficam em `process  not`
  // — depois de normalizar já seria tarde. A mensagem mostrada ao utilizador
  // sai de `detail`, que nunca foi tocada: o que se perde aqui é só o eco do
  // PID da stderr, e o PID que importa é o do alvo congelado.
  const combined = normalizeTaskkillText(`${input.stderr}\n${input.stdout}`.replace(/"[^"]*"|'[^']*'/g, " "));
  if (input.exitCode === 1 && ACCESS_DENIED_PATTERN.test(combined)) {
    return { ok: false, status: "access-denied", error: detail || "Acesso negado ao terminar o processo." };
  }
  // Codigos genericos (o 255 do taskkill e o maior deles): o numero nao diz
  // nada, a mensagem sim. Sem isto, "o processo ja nao existe" dicho pelo
  // stderr a um exit 255 virava falha generic e o utilizador via um erro onde
  // ja nao havia nada a fazer.
  if (NOT_FOUND_PATTERN.test(combined)) {
    return { ok: false, status: "not-found", error: detail || "O processo já não existe (taskkill: PID não encontrado)." };
  }
  if (ACCESS_DENIED_PATTERN.test(combined)) {
    return { ok: false, status: "access-denied", error: detail || "Acesso negado ao terminar o processo." };
  }
  // O taskkill em pt-PT escreve "Não foi possível terminar o processo..." e
  // sai com 255. Não é falha desconhecida: é recusa do Windows em matar AQUELE
  // PID (protegido, já em fecho, ou dono doutro token). Dizemos isso com a
  // mensagem real à frente em vez de atirar um "código 255" para o ecrã.
  if (TERMINATE_FAILED_PATTERN.test(combined)) {
    return {
      ok: false,
      status: "failed",
      error: detail || `O Windows não conseguiu terminar o processo (taskkill exit ${input.exitCode ?? "desconhecido"}).`,
    };
  }
  return {
    ok: false,
    status: "failed",
    error: detail || `taskkill terminou com código ${input.exitCode ?? "desconhecido"}.`,
  };
}

/** Quantas vezes o mesmo PID leva `taskkill` antes de mudar de estratégia. */
export const KILL_MAX_ATTEMPTS = 2;
/** Intervalo curto entre tentativas: dá tempo ao Windows para libertar o PID. */
export const KILL_RETRY_DELAY_MS = 250;

/**
 * Política de retry: só há segunda tentativa se o processo estiver VIVO para o
 * SO. Um PID que o SO já não tem não precisa de mais um taskkill — precisa de
 * uma confirmação verdadeira, que foi precisamente o erro que esteve a voltar
 * (repetir o mesmo comando sobre um PID inexistente e chamar-lhe resiliência).
 * `not-found` e `access-denied` param logo: a segunda tentativa daria no mesmo.
 */
export function decideTaskkillRetry(input: {
  attempts: number;
  targetAlive: boolean;
  budgetRemainingMs: number;
  status: TaskkillOutcome["status"];
}): "retry" | "stop" {
  if (!input.targetAlive) return "stop";
  if (input.status === "not-found" || input.status === "access-denied") return "stop";
  if (input.attempts >= KILL_MAX_ATTEMPTS) return "stop";
  if (input.budgetRemainingMs <= 0) return "stop";
  return "retry";
}

/** Filhos DIRETOS de um PID, numa recolha de linhas Win32_Process. */
export function treeChildrenOf<T extends { pid: number; ppid?: number }>(
  parentPid: number,
  rows: readonly T[],
): T[] {
  return rows.filter((r) => Number.isInteger(r.pid) && r.pid > 0 && r.pid !== parentPid && r.ppid === parentPid);
}

/** Tetos da varredura: não pode correr descontrolada no meio de um kill. */
export const TREE_SWEEP_MAX_DEPTH = 4;
export const TREE_SWEEP_MAX_TARGETS = 32;

/**
 * Descendentes a abater, um a um, já sem o que não pode ser alvo.
 *
 * `taskkill /T` depende do vínculo pai-filho EXISTENTE: se a raiz morreu e os
 * netos ficaram órfãos (re-parented), o `/T` não tem nada para alcançar — era
 * isso que fazia o kill do pai não resolver nada. Aqui percorre-se a árvore
 * nível a nível. Componentes do CyberSafe, o serviço e os seus ancestrais são
 * recusados mesmo que apareçam ligados à árvore.
 */
export function planTreeSweep<T extends KillTargetInfo>(options: {
  rootPid: number;
  rows: readonly T[];
  context: KillProtectionContext;
  maxTargets?: number;
}): { targets: number[]; refusedProtected: number[] } {
  const maxTargets = options.maxTargets ?? TREE_SWEEP_MAX_TARGETS;
  const targets: number[] = [];
  const refusedProtected: number[] = [];
  const seen = new Set<number>([options.rootPid]);
  let frontier: number[] = [options.rootPid];

  for (let depth = 0; depth < TREE_SWEEP_MAX_DEPTH && frontier.length > 0 && targets.length < maxTargets; depth += 1) {
    const next: number[] = [];
    for (const parentPid of frontier) {
      for (const child of treeChildrenOf(parentPid, options.rows)) {
        if (seen.has(child.pid) || targets.length >= maxTargets) continue;
        seen.add(child.pid);
        if (classifyKillTarget(child, options.context)) {
          refusedProtected.push(child.pid);
          continue;
        }
        targets.push(child.pid);
        next.push(child.pid);
      }
    }
    frontier = next;
  }
  return { targets, refusedProtected };
}

/**
 * Argumentos CANONICOS do `taskkill`. Uma única fonte: o `spawn` e o registo em
 * `actions.log` usam-nos, por isso o log prova sempre o comando real.
 *
 * `/F` e `/T` **antes** do `/PID`: `/F` força sem esperar que a janela responda
 * (sem `/F`, um Notepad com documento por guardar fica à espera de uma resposta
 * que nunca chega — era o "A terminar processo" lento e por nunca acabar), e
 * `/T` leva a árvore toda, incluindo os filhos que os MSIX criam.
 */
export function taskkillArgs(pid: number): string[] {
  return ["/F", "/T", "/PID", String(pid)];
}

/**
 * Corre `taskkill /F /T /PID <pid>` com **prazo real**: se o utilitário não terminar dentro
 * de `timeoutMs`, o processo filho é morto e o resultado é `timeout`. Nunca
 * rejeita e nunca fica pendente — é isto que impede um pedido de kill de ficar
 * preso à espera para sempre.
 *
 * O stdout/stderr são **capturados** (com teto) — sem eles um exit code != 0
 * não tem diagnóstico nenhum e o utilizador só vê "falha genérica".
 */
export async function killProcessTree(pid: number, options?: KillProcessTreeOptions): Promise<KillProcessResult> {
  const timeoutMs = options?.timeoutMs ?? TASKKILL_TIMEOUT_MS;
  const spawnFn = options?.spawnImpl ?? spawn;

  let child: ChildProcess;
  try {
    child = spawnFn("taskkill", taskkillArgs(pid), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    return { ok: false, status: "failed", pid, error: (err as Error).message, exitCode: undefined };
  }

  return new Promise((resolve) => {
    let settled = false;
    let exitCode: number | null = null;
    let stdout = "";
    let stderr = "";
    const collect = (which: "stdout" | "stderr") => (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (which === "stdout") stdout = (stdout + text).slice(0, TASKKILL_OUTPUT_CAP);
      else stderr = (stderr + text).slice(0, TASKKILL_OUTPUT_CAP);
    };
    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      resolve({
        ...interpretTaskkillOutcome({ exitCode: null, stdout, stderr, timedOut: true }),
        pid,
        stdout,
        stderr,
      });
    }, timeoutMs);
    // 'exit' só regista o código; a resolução é em 'close', quando o output
    // capturado está completo (com stdio em pipe, 'exit' pode chegar antes dos
    // últimos chunks).
    child.on("exit", (code) => {
      exitCode = code ?? null;
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const finalCode = code ?? exitCode ?? null;
      const outcome = interpretTaskkillOutcome({ exitCode: finalCode, stdout, stderr, timedOut: false });
      resolve({ ...outcome, pid, exitCode: finalCode ?? undefined, stdout, stderr });
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, status: "failed", pid, error: err.message, exitCode: undefined, stdout, stderr });
    });
  });
}

/**
 * `process.kill(pid, 0)` não envia sinal — só diz se o PID ainda existe.
 *
 * LIMITAÇÃO (foi causa de bug): no Windows o OBJETO de um processo já terminado
 * continua abrível enquanto houver handles em aberto — Notepad com documento
 * por guardar, notificação de shell pendurada, etc. Para esses PIDs isto
 * responde `true` quando o processo já morreu (`EPERM` também é "existe", mas
 * com outro dono). Quem precisa de saber se o processo **ainda é o alvo** — o
 * kill no serviço — confirma pela palavra do CIM/Win32_Process, que deixa de
 * listar o PID assim que ele sai; isto serve apenas como primeiro filtro barato.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = existe, mas não temos permissão para o sinalizar.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface KillTargetInfo {
  pid: number;
  ppid?: number;
  name?: string;
  path?: string;
  commandLine?: string;
}

export interface KillProtectionContext {
  /** PID do próprio serviço (nunca pode ser terminado). */
  selfPid: number;
  /** Ancestrais do serviço (processo pai e cadeia acima). */
  ancestorPids: readonly number[];
  /** Caminhos normalizados exatos de executáveis internos. */
  internalPaths: readonly string[];
  /** Prefixos de diretório ligados ao runtime/projeto/app (ex.: pasta do serviço). */
  internalPathPrefixes?: readonly string[];
  /** Marcadores de commandLine ligados ao runtime/projeto/app (ex.: "cybersafe"). */
  commandLineMarkers?: readonly string[];
  /** Nomes usados **apenas** quando não há PID/ppid/path fiáveis. */
  fallbackNames: readonly string[];
  /** PIDs de sistema (<= limiar) sempre protegidos. */
  systemPidThreshold?: number;
  /**
   * Mapa `pid -> ppid`, para subir a partir de um ALVO e perguntar
   * "o serviço está no meu ancestry?".
   *
   * É o inverso direcional de `ancestorPids`: aquele diz quem LANÇOU o
   * CyberSafe, este diz de quem o CyberSafe é pai. Sem ele, um descendente a
   * profundidade > 1 (serviço -> helper -> worker) não é reconhecido — e a
   * proteção de dois níveis desaparece.
   */
  parentOf?: Readonly<Record<number, number>>;
}

/** Normaliza caminhos para comparação (case-insensitive, sem prefixo \\?\). */
export function normalizeProcessPath(value: string | undefined | null): string {
  if (!value) return "";
  let normalized = value.trim().replace(/\//g, "\\");
  if (normalized.startsWith("\\\\?\\")) normalized = normalized.slice(4);
  return normalized.toLowerCase();
}

/**
 * Stub de App Execution Alias (MSIX): os lançadores vivem em
 * %LOCALAPPDATA%\Microsoft\WindowsApps e MORREM após ativar a app — o PID do
 * launcher nunca é o PID real. O executável REAL das apps empacotadas vive sob
 * C:\Program Files\WindowsApps\... e NÃO corresponde a este marcador.
 */
export const ALIAS_STUB_MARKER = "appdata\\local\\microsoft\\windowsapps";

/** Verdadeiro quando path ou commandLine do alvo aponta para o stub/alias. */
export function isAliasStubTarget(target: { path?: string; commandLine?: string }): boolean {
  const path = normalizeProcessPath(target.path);
  const commandLine = normalizeProcessPath(target.commandLine);
  return path.includes(ALIAS_STUB_MARKER) || commandLine.includes(ALIAS_STUB_MARKER);
}

/** Identidade estável o suficiente para detetar PID reuse (nome + linha de comando). */
export function killTargetIdentity(target: Pick<KillTargetInfo, "name" | "commandLine">): string {
  return `${(target.name ?? "").toLowerCase()}|${(target.commandLine ?? "").trim()}`;
}

/**
 * O `fromPid` tem o `selfPid` algures ACIMA dele na cadeia de pais?
 *
 * Sobe a partir de `fromPid` (o pai do alvo), com os mesmos limites da cadeia
 * de ancestrais do serviço: profundidade 16 e guarda de ciclo, porque um
 * snapshot do Windows pode ter um pai malformado e um ciclo a subir daria
 * `RangeError` dentro de um handler de pedido.
 *
 * Sem `parentOf` (ou com o pai fora do snapshot) a resposta é `false`: não se
 * assume proteção que não se provou. É o sentido seguro — no pior caso
 * LIBERTA-SE um kill, nunca BLOQUEIA-SE um processo legítimo.
 */
function isDescendantOf(fromPid: number | undefined, selfPid: number, parentOf: Readonly<Record<number, number>> | undefined): boolean {
  if (!Number.isInteger(fromPid) || (fromPid as number) <= 0) return false;
  if (!parentOf || selfPid <= 0) return false;

  let cursor = fromPid as number;
  const vistos = new Set<number>();
  for (let depth = 0; depth < 16 && cursor > 0; depth += 1) {
    if (cursor === selfPid) return true;
    if (vistos.has(cursor)) return false;
    vistos.add(cursor);
    const parent = parentOf[cursor];
    if (!Number.isInteger(parent) || parent <= 0) return false;
    cursor = parent;
  }
  return false;
}

/**
 * Decide se um alvo de kill está protegido. A identidade é resolvida por PID e
 * ppid (serviço/ancestrais/filhos internos), depois por caminho de executável
 * interno; o **nome é só fallback**, e apenas quando não há caminho fiável.
 */
export function classifyKillTarget(
  target: KillTargetInfo,
  context: KillProtectionContext,
): ProcessKillProtectionReason | null {
  const { pid } = target;
  if (!Number.isInteger(pid) || pid <= 0) return null;

  // 1. O próprio serviço — por PID, nunca por nome.
  if (context.selfPid > 0 && pid === context.selfPid) return "self";

  // 2. PIDs de sistema (kernel/idle/SMSS e afins).
  const threshold = context.systemPidThreshold ?? 0;
  if (threshold > 0 && pid <= threshold) return "system-pid";

  // 3. Ancestrais do serviço — por PID.
  if (context.ancestorPids.includes(pid)) return "ancestor";

  // 4. Descendentes do serviço — DIRECIONAL: o selfPid está na cadeia de
  //    ancestrais DO TARGET (ppid -> ppid -> ...), a qualquer profundidade.
  //
  //    A regra anterior era "filho de um ancestral" (`ancestorPids.includes(ppid)`)
  //    e era um falso positivo COMPROVADO: `ancestorPids` sobe a cadeia até 16
  //    níveis a partir de `process.ppid`, e num ambiente de desenvolvimento
  //    essa cadeia inclui o `explorer.exe`. Qualquer aplicação que o utilizador
  //    abrisse pelo Start menu (ppid = explorer.exe) era classificada
  //    "internal" — observado num Notepad vivo (PID 35744, ppid 1628 =
  //    explorer.exe), recusado 4x com `protectedReason: "internal"`.
  //
  //    A correção estreita para `ppid === selfPid` também estava ERRADA, pelo
  //    motivo oposto: só cobria profundidade 1, e um descendente real a dois
  //    níveis (serviço -> helper -> worker) ficava DESPROTEGIDO.
  //
  //    A forma certa é direcional: o ancestral partilhado (explorer, terminal)
  //    é ancestral NOS DOIS LADOS e não protege nada; o selfPid só protege quem
  //    tem o selfPid ACIMA dele.
  //
  //    Profundidade 1 (`target.ppid === selfPid`) é provável só com o alvo, sem
  //    mapa nenhum, e por isso verificada à parte: sem ela, um `parentOf`
  //    ausente (alvo fora do snapshot) desprotejia o filho direto. A
  //    profundidade > 1 é o que precisa da caminhada.
  if (target.ppid && target.ppid > 0 && target.ppid === context.selfPid) {
    return "internal";
  }
  if (isDescendantOf(target.ppid, context.selfPid, context.parentOf)) {
    return "internal";
  }
  const targetPath = normalizeProcessPath(target.path);
  if (targetPath) {
    if (context.internalPaths.includes(targetPath)) return "internal";
    for (const prefix of context.internalPathPrefixes ?? []) {
      if (!prefix) continue;
      const boundary = prefix.endsWith("\\") ? prefix : `${prefix}\\`;
      if (targetPath === prefix || targetPath.startsWith(boundary)) return "internal";
    }
  }

  // 5. Componentes internos pela linha de comando: node/electron/powershell só
  //    quando a linha liga ao runtime/projeto/app — nunca o executável em si.
  const commandLine = normalizeProcessPath(target.commandLine);
  if (commandLine && (context.commandLineMarkers ?? []).some((marker) => marker && commandLine.includes(marker))) {
    return "internal";
  }

  // 6. Nomes SÓ como fallback, quando não há caminho fiável.
  const name = (target.name ?? "").toLowerCase();
  if (!targetPath && name && context.fallbackNames.includes(name)) return "fallback-name";

  return null;
}

export type ReconcileKillStatus = "exited" | "reused" | "still-running";

export interface ProcessProbe {
  alive: boolean;
  identity?: string;
}

export interface ReconcileKillOptions {
  pid: number;
  /** Identidade do alvo capturada ANTES do kill; se mudar, o PID foi reutilizado. */
  originalIdentity?: string;
  probe: (pid: number) => ProcessProbe | Promise<ProcessProbe>;
  deadlineMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reconciliação autoritativa: só declara `exited` quando o PID desaparece. Se o
 * PID continuar vivo com outra identidade, é reutilização (`reused`) — nunca é
 * tratado como sucesso. Termina sempre (nunca fica pendente).
 */
export async function reconcileProcessExit(options: ReconcileKillOptions): Promise<{ status: ReconcileKillStatus }> {
  const deadlineMs = options.deadlineMs ?? KILL_REAP_DEADLINE_MS;
  const intervalMs = Math.max(1, options.intervalMs ?? KILL_REAP_INTERVAL_MS);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  // Limite de tentativas garante terminação mesmo com relógio injetado.
  const maxAttempts = Math.max(1, Math.ceil(deadlineMs / intervalMs) + 1);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const probe = await options.probe(options.pid);
    if (!probe.alive) return { status: "exited" };
    if (probe.identity && options.originalIdentity && probe.identity !== options.originalIdentity) {
      return { status: "reused" };
    }
    if (now() - startedAt >= deadlineMs) return { status: "still-running" };
    await sleep(intervalMs);
  }
  return { status: "still-running" };
}
