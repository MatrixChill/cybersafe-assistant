/**
 * Registo de ciclo de vida do processo da API (diagnóstico local, sem segredos).
 *
 * Porque existe: em 2026-10-20 duas corridas DEV morreram com o processo
 * `npm run dev:api` a sair com 3221225786 = 0xC000013A (STATUS_CONTROL_C_EXIT),
 * sem uma linha de stderr, sem relatório do Node e sem evento no WER. O runner
 * só vê o código do wrapper `npm`/`cmd.exe` que representa a API — não vê o
 * processo da API. Resultado: horas de investigação sem prova do que morreu.
 *
 * Este módulo não tenta apanhar terminações do SO: um `TerminateProcess` não
 * deixa correr handlers. Torna observável o que é observável:
 *  - arranque e escuta (pid, porta, uptime), para se distinguir a API do
 *    wrapper que a lança;
 *  - SIGINT / SIGTERM / SIGBREAK (os sinais que o Windows entrega a um processo
 *    de consola) e o encerramento, com o motivo;
 *  - excepções não apanhadas e rejeições sem handler — que hoje matam o serviço
 *    de contas sem deixar rasto.
 *
 * Regras do registo: ficheiro JSONL local, escrita SÍNCRONA e best-effort
 * (nunca lança), texto sanitizado (sem emails, sem tokens, sem corpos de
 * pedidos, sem o segredo JWT).
 */

import fs from "node:fs";
import path from "node:path";

/** Nome do ficheiro, ao lado da DB, quando não há `CYBERSAFE_API_DIAG_LOG`. */
export const LIFECYCLE_LOG_FILENAME = "api-lifecycle.jsonl";
/** Tecto de cada campo de texto livre. Diagnóstico não é log de aplicação. */
export const LIFECYCLE_MAX_TEXT = 240;
/** Tecto do excerto de stack (3 primeiras linhas, colapsadas). */
export const LIFECYCLE_MAX_STACK = 400;
/** Acima disto o ficheiro roda para `.1` (um só histórico, sem crescimento infinito). */
export const LIFECYCLE_MAX_FILE_BYTES = 1024 * 1024;

export type LifecycleKind =
  | "startup"
  | "listening"
  | "signal"
  | "shutdown"
  | "uncaught-exception"
  | "unhandled-rejection";

export interface LifecycleInput {
  port?: number;
  signal?: string;
  reason?: string;
  error?: unknown;
}

export interface LifecycleRecord {
  at: string;
  kind: LifecycleKind;
  pid: number;
  uptimeMs: number;
  port?: number;
  signal?: string;
  reason?: string;
  name?: string;
  code?: string;
  message?: string;
  stack?: string;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{40,}\b/g;
const CONTROL_RE = /[\u0000-\u001f\u007f]+/g;

/**
 * Texto de diagnóstico: uma linha, sem caracteres de controlo, sem emails, sem
 * `Bearer ...`, sem sequências longas que pareçam tokens; cortado ao tecto.
 * Devolve `undefined` para entradas vazias (o campo não aparece no registo).
 */
export function sanitizeText(value: unknown, max: number = LIFECYCLE_MAX_TEXT): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = typeof value === "string" ? value : String(value);
  const flat = raw.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  const redacted = flat
    .replace(EMAIL_RE, "<email>")
    .replace(BEARER_RE, "Bearer <redacted>")
    .replace(LONG_TOKEN_RE, "<redacted>");
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

function extractError(error: unknown): Pick<LifecycleRecord, "name" | "code" | "message" | "stack"> {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      name: sanitizeText(error.name, 80),
      code: sanitizeText(code, 40),
      message: sanitizeText(error.message),
      stack: sanitizeText(error.stack?.split("\n").slice(0, 3).join(" | "), LIFECYCLE_MAX_STACK),
    };
  }
  if (typeof error === "string") return { message: sanitizeText(error) };
  try {
    return { message: sanitizeText(JSON.stringify(error)) };
  } catch {
    return { message: "<valor não serializável>" };
  }
}

export interface LifecycleClock {
  now?: () => number;
  pid?: number;
  startedAt?: number;
}

/** Registo puro: sem I/O, testável com relógio e pid injectados. */
export function buildLifecycleRecord(
  kind: LifecycleKind,
  input: LifecycleInput = {},
  clock: LifecycleClock = {},
): LifecycleRecord {
  const now = clock.now ? clock.now() : Date.now();
  const startedAt = clock.startedAt ?? now;
  const record: LifecycleRecord = {
    at: new Date(now).toISOString(),
    kind,
    pid: clock.pid ?? process.pid,
    uptimeMs: Math.max(0, now - startedAt),
  };
  if (typeof input.port === "number" && Number.isFinite(input.port)) record.port = input.port;
  const signal = sanitizeText(input.signal, 40);
  if (signal) record.signal = signal;
  const reason = sanitizeText(input.reason, 80);
  if (reason) record.reason = reason;
  if (input.error !== undefined) Object.assign(record, extractError(input.error));
  return record;
}

/**
 * Caminho do registo: `CYBERSAFE_API_DIAG_LOG` explícito, senão
 * `api-lifecycle.jsonl` ao lado da DB (nunca dentro de `node_modules`).
 * `:memory:` (testes) cai para o directorio de trabalho.
 */
export function resolveLifecycleLogPath(env: NodeJS.ProcessEnv, databasePath: string): string {
  const explicit = env.CYBERSAFE_API_DIAG_LOG?.trim();
  if (explicit) return path.resolve(explicit);
  const dbFile = typeof databasePath === "string" ? databasePath.trim() : "";
  const dir = dbFile && dbFile !== ":memory:" ? path.dirname(path.resolve(dbFile)) : process.cwd();
  return path.join(dir, LIFECYCLE_LOG_FILENAME);
}

export interface LifecycleRecorder {
  /** Ficheiro para onde os registos vão (útil na mensagem de arranque). */
  readonly file: string;
  /** Acrescenta um registo. Nunca lança; devolve `null` se nada foi escrito. */
  record(kind: LifecycleKind, input?: LifecycleInput): LifecycleRecord | null;
}

export interface RecorderOptions extends LifecycleClock {
  file: string;
  /** Seam de teste: escritor (por omissão appendFileSync com mkdir). */
  appendFile?: (file: string, line: string) => void;
  /** Seam de teste: aviso quando a escrita falha. */
  onError?: (message: string) => void;
}

function appendFileSyncSafe(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size >= LIFECYCLE_MAX_FILE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // Ficheiro ainda não existe: nada a rodar.
  }
  fs.appendFileSync(file, line, { encoding: "utf8" });
}

export function createLifecycleRecorder(options: RecorderOptions): LifecycleRecorder {
  const startedAt = options.startedAt ?? Date.now();
  const append = options.appendFile ?? appendFileSyncSafe;
  return {
    file: options.file,
    record(kind: LifecycleKind, input: LifecycleInput = {}): LifecycleRecord | null {
      const record = buildLifecycleRecord(kind, input, {
        now: options.now,
        pid: options.pid,
        startedAt,
      });
      try {
        append(options.file, `${JSON.stringify(record)}\n`);
        return record;
      } catch (error) {
        // Um diagnóstico não pode derrubar o serviço que está a diagnosticar.
        options.onError?.(`registo de ciclo de vida indisponível: ${sanitizeText((error as Error)?.message) ?? "erro desconhecido"}`);
        return null;
      }
    },
  };
}

export interface DiagnosticsDeps {
  /** Seam de teste: `process` (ou um EventEmitter) por omissão. */
  process?: Pick<NodeJS.Process, "on">;
  /** Seam de teste: saída do processo. */
  exit?: (code: number) => void;
  /** Rejeições sem handler terminam o processo (opt-in explícito). */
  strictRejections?: boolean;
  /** Seam de teste: mensagem operacional (vai para stderr por omissão). */
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}

const STRICT_VALUES = new Set(["1", "true", "yes", "on"]);/**
 * Instala os handlers de processo. Política:
 *  - `uncaughtException`: registar e sair com 1. O estado do processo deixou de
 *    ser fiável; continuar a servir contas seria pior do que reiniciar.
 *  - `unhandledRejection`: registar e CONTINUAR (o serviço de contas não pode
 *    desaparecer por uma promessa esquecida numa rota). Com
 *    `CYBERSAFE_API_STRICT_REJECTIONS=1` termina, para quem quer o
 *    comportamento do Node por omissão.
 */
export function installProcessDiagnostics(recorder: LifecycleRecorder, deps: DiagnosticsDeps = {}): void {
  const proc = deps.process ?? process;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const env = deps.env ?? process.env;
  const strict = deps.strictRejections ?? STRICT_VALUES.has(String(env.CYBERSAFE_API_STRICT_REJECTIONS ?? "").toLowerCase().trim());
  const say = deps.log ?? ((message: string) => console.error(message));

  proc.on("uncaughtException", (error: unknown) => {
    recorder.record("uncaught-exception", { error });
    say(`[API] Excepção não apanhada registada em ${recorder.file}; o processo vai terminar.`);
    exit(1);
  });

  proc.on("unhandledRejection", (reason: unknown) => {
    recorder.record("unhandled-rejection", { error: reason });
    if (strict) {
      say(`[API] Rejeição sem handler registada em ${recorder.file}; modo estrito: o processo vai terminar.`);
      exit(1);
      return;
    }
    say(`[API] Rejeição sem handler registada em ${recorder.file}; o serviço continua.`);
  });
}

export type LifecycleVerdict = "clean-shutdown" | "js-crash" | "external-kill" | "never-started";

export interface LifecycleVerdictResult {
  verdict: LifecycleVerdict;
  reason: string;
}

/**
 * Lê registos (já parseados) e conclui o que aconteceu ao processo.
 *
 * É a regra que faltava em 2026-10-20: se há `listening` e não há `signal`,
 * `shutdown` nem `uncaught-exception`, o processo foi terminado POR FORA
 * (TerminateProcess/taskkill/job object/consola fechada) — nenhum handler de
 * Node pode escrever nesse caminho. Sem esta distinção, "desapareceu" era
 * indistinguível de "crashou", e duas corridas foram investigadas como crash.
 */
export function classifyLifecycleRecords(records: unknown[]): LifecycleVerdictResult {
  const kinds = new Set<string>();
  for (const record of Array.isArray(records) ? records : []) {
    if (record && typeof record === "object" && typeof (record as { kind?: unknown }).kind === "string") {
      kinds.add((record as { kind: string }).kind);
    }
  }
  if (kinds.has("uncaught-exception")) {
    return { verdict: "js-crash", reason: "excepção não apanhada registada antes da saída" };
  }
  if (kinds.has("shutdown")) {
    return {
      verdict: "clean-shutdown",
      reason: kinds.has("signal") ? "sinal recebido e encerramento concluído" : "encerramento registado sem sinal",
    };
  }
  if (!kinds.has("listening")) {
    return { verdict: "never-started", reason: "sem registo de escuta: falhou antes de abrir o listener" };
  }
  return {
    verdict: "external-kill",
    reason: "escuta registada sem sinal, encerramento nem excepção: terminado por fora do processo",
  };
}
