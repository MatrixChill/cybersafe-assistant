import * as fs from "node:fs";
import { installSignalHandlers } from "./signal-handlers.js";
import { validarConfigWindowsReadOnly } from "./dev-windows-readonly.js";

import "dotenv/config";
import {
  BOOT_DEBUG_LOG_BUDGET,
  ERROR_LOG_BUDGET,
  SyncLogWriter,
  bootDebugLogPath,
  errorLogPath,
  reclaimOversizedLog,
  serviceBaseDir,
} from "./log-writer.js";

// ── LOG HYGIENE (Workstream F) ───────────────────────────────────────────────
// error.log e boot-debug.log cresceram para GB porque eram escritos com
// `fs.appendFileSync` cru, sem rotação nem retenção. Passam a usar
// SyncLogWriter com orçamento fixo: rotação por tamanho + retenção real.
// Em regime normal nada é apagado antes de estar dentro da retenção; o
// reclaim de truncar só dispara para ficheiros já macroscopicamente acima do
// orçamento (o caso dos GB herdados desta máquina).
// ── Validação do modo de leitura Windows — ANTES do primeiro efeito ──────────
// As linhas seguintes abrem `BASE_DIR`, criam diretórios, giram `error.log` e
// `boot-debug.log` e escrevem no primeiro log. Uma configuração inválida do modo
// não pode deixar um único desses efeitos para trás, por isso a decisão de
// «pedido ou não» é a primeira coisa que corre neste módulo.
//
// É estritamente condicional: sem `CYBERSAFE_DEV_WINDOWS_READONLY=1` nenhuma
// função do modo é chamada, nenhuma estat é feita e o arranque normal é
// byte-a-byte o de antes. Com a flag pedida e errada, lança aqui — antes de
// `BASE_DIR`, antes do construtor do serviço e muito antes do pipe.
//
// Limite honesto e não evitável a partir deste ficheiro: as importações de
// módulos ES são içadas e avaliadas antes do corpo, pelo que efeitos de topo dos
// módulos importados (p. ex. `dotenv/config` a ler `.env`) acontecem seja onde
// foi que esta linha for posta. O que aqui se garante é a ordem dentro de
// `index.ts`, não uma anterioridade absoluta sobre todos os módulos.
const configWindowsReadOnly = process.env.CYBERSAFE_DEV_WINDOWS_READONLY === "1"
  ? validarConfigWindowsReadOnly(process.env)
  : null;

const BASE_DIR = serviceBaseDir();
const DEBUG_LOG = bootDebugLogPath(BASE_DIR);
const ERROR_LOG = errorLogPath(BASE_DIR);

try {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  reclaimOversizedLog(ERROR_LOG, ERROR_LOG_BUDGET.maxBytes, ERROR_LOG_BUDGET.maxFiles);
  reclaimOversizedLog(DEBUG_LOG, BOOT_DEBUG_LOG_BUDGET.maxBytes, BOOT_DEBUG_LOG_BUDGET.maxFiles);
} catch {
  // Ignorar falha inicial se não tiver permissão
}

const bootDebug = new SyncLogWriter(BASE_DIR, "boot-debug.log", BOOT_DEBUG_LOG_BUDGET);
const errorLog = new SyncLogWriter(BASE_DIR, "error.log", ERROR_LOG_BUDGET);

/**
 * Consola à prova de EPIPE.
 *
 * Causa raiz dos GB de log: sob o serviço Windows o stdout é um pipe sem
 * leitor. Um `console.error` dentro do handler de `uncaughtException` lançava
 * ele próprio EPIPE, que voltava a entrar no mesmo handler, infinitamente —
 * cada iteração anexava um stack trace de ~600 B a error.log e boot-debug.log.
 * Aqui absorvemos o erro de escrita em vez de o propagar, quebrando o ciclo.
 */
function safeWrite(stream: "out" | "err", args: unknown[]): void {
  const fn = stream === "out" ? process.stdout : process.stderr;
  try {
    if (fn.destroyed || !fn.writable) return;
    fn.write(args.map((a) => (typeof a === "string" ? a : safeInspect(a))).join(" ") + "\n");
  } catch {
    // stdout/stderr indisponível — jamais propagar a partir daqui.
  }
}

function safeInspect(value: unknown): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Cabeçalho de sessão, escrito uma vez por arranque. */
bootDebug.write(`[${new Date().toISOString()}] BOOT INICIADO EM: ${process.cwd()}`);

import { ProtectionEngineService } from "./engine.js";
import { DefinitionUpdater } from "./updater.js";
import { installDevFixtureGate } from "./dev-fixture-gate.js";
// `validarConfigWindowsReadOnly` é importado no topo deste ficheiro porque a
// decisão do modo tem de anteceder `BASE_DIR`; daqui só se usa a montagem.
import { montarGuardaWindowsReadOnly } from "./dev-windows-readonly.js";

// ── Crash Resilience ─────────────────────────────────────────────────────────
// Quando rodando como serviço Windows (SYSTEM), não há UI nem console.
// Capturamos erros fatais para log e tentamos manter o processo vivo.

const LOG_DIR = BASE_DIR;
fs.mkdirSync(LOG_DIR, { recursive: true });

function logToFile(level: string, message: string, error?: unknown) {
  const timestamp = new Date().toISOString();
  const errorStr = error instanceof Error ? `\n  Stack: ${error.stack}` : "";
  // Dedupe + rotação + retenção via SyncLogWriter (nunca appendFileSync cru).
  errorLog.write(`[${timestamp}] [${level}] ${message}${errorStr}`);
}

// Códigos que significam "o outro lado fechou o pipe" — esperados no shutdown.
const EXPECTED_PIPE_ERROR_CODES = new Set<string>([
  "EPIPE",
  "ECONNRESET",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);

/**
 * Um EPIPE dentro do próprio handler de excepção deve nunca voltar a
 * disparar o handler. Esta guarda é a rede que fecha o ciclo de realimentação.
 */
let inCrashHandler = false;

process.on("uncaughtException", (err) => {
  if (inCrashHandler) {
    try {
      errorLog.write(`[${new Date().toISOString()}] [CRITICAL] exceção dentro do handler de crash (ignorada): ${safeInspect(err)}`);
    } catch {
      /* nada mais a fazer */
    }
    return;
  }
  inCrashHandler = true;
  try {
    const code = (err as NodeJS.ErrnoException)?.code;
    // O peer (Electron) pode fechar o pipe antes de lermos/escrevermos a resposta.
    // EPIPE/ECONNRESET são o resultado esperado desse fecho — sobretudo no
    // shutdown — e não uma falha crítica do serviço. O engine já os trata no
    // handler de "error" de cada socket; isto é a rede de segurança final.
    if (EXPECTED_PIPE_ERROR_CODES.has(String(code))) {
      bootDebug.write(`[${new Date().toISOString()}] EXPECTED pipe close (${code}) — peer fechou a ligação`);
      logToFile("WARN", `EXPECTED pipe close (${code}) — peer fechou a ligação`, err);
      safeWrite("err", [`[Service] EXPECTED pipe close (${code}) — peer fechou a ligação`]);
      return;
    }
    bootDebug.write(`[${new Date().toISOString()}] CRITICAL uncaught exception: ${err.stack || err}`);
    logToFile("CRITICAL", "Uncaught exception — tentando manter serviço vivo", err);
    safeWrite("err", ["[Service] CRITICAL uncaught exception:", err]);
    // NÃO chamamos process.exit() — o serviço deve sobreviver
  } finally {
    inCrashHandler = false;
  }
});

process.on("unhandledRejection", (reason) => {
  if (inCrashHandler) return;
  inCrashHandler = true;
  try {
    bootDebug.write(`[${new Date().toISOString()}] Unhandled rejection: ${reason}`);
    logToFile("ERROR", "Unhandled promise rejection", reason as Error);
    safeWrite("err", ["[Service] Unhandled rejection:", reason]);
  } finally {
    inCrashHandler = false;
  }
});

// ── Service Bootstrap ────────────────────────────────────────────────────────
// `configWindowsReadOnly` foi decidido no topo deste módulo, antes do primeiro
// efeito de logging; aqui limita-se a montar a guarda, porque precisa do objeto.

const service = new ProtectionEngineService();

async function main() {
  logToFile("INFO", "Service starting...");
  safeWrite("out", ["[Service] Starting init..."]);

  try {
    // Gate de fixture do Scanner (TP-CONTINUOUS-RUNTIME Q1). Sem a env ligada isto é
    // estritamente não-invasivo: `installDevFixtureGate` devolve `false` sem tocar em nada.
    //
    // A ordem é gate → init → pipe, e não o contrário. O resolutor do corpus YARA de teste
    // (TP-A4) corre DENTRO de `init()` e exige o gate efetivamente montado; montado depois,
    // essa prova nunca podia ser satisfeita. Antes do pipe server continua obrigatório:
    // nenhum pedido pode chegar sem o gate em pé. Config inválida MATA o arranque — o
    // requisito é «falha ⇒ zero sessão».
    //
    // A política de quarentena é lida do disco em `init()`, por isso é reportada à parte,
    // depois, em vez de se montar o gate tarde demais para o corpus.
    const gateMontado = installDevFixtureGate(service);
    if (gateMontado) {
      logToFile("WARN", "Gate de fixture de DEV montado: só scan.start custom dentro do FIXTURE_ROOT, readOnly forçado.");
    }

    // Guarda de leitura Windows: outro regime, também antes de `init()` e do pipe,
    // para que nenhum pedido chegue ao motor sem a allowlist montada. Os dois são
    // exclusivos por construção — `validarConfigWindowsReadOnly` recusa a flag de
    // fixture — pelo que montar um não altera o outro. Os efeitos de arranque que
    // este modo exige cortados (`USB_PROTECTION=0`, `STARTUP_RESUME=0`) são os
    // ramos já existentes em `engine.ts init()`; este módulo valida-os e lança,
    // nunca os escreve por detrás do launcher.
    if (configWindowsReadOnly && montarGuardaWindowsReadOnly(service, process.env, (linha) => logToFile("WARN", linha))) {
      safeWrite("out", ["[Service] Modo de leitura Windows montado: leituras permitidas, mutações recusadas antes do motor."]);
    }

    await service.init();

    if (gateMontado) {
      // Linha exclusiva do modo de DEV (só aqui com o gate montado): a política EFECTIVA,
      // agora sim lida do disco. Não altera o regime normal nem o modo desligado.
      const efetiva = (service as unknown as { quarantinePolicy?: string }).quarantinePolicy;
      safeWrite("out", [`[Service] política de quarentena efetiva após init: ${String(efetiva)}`]);
    }

    safeWrite("out", ["[Service] Init complete. Starting pipe server..."]);
    await service.startPipeServer();
    safeWrite("out", ["[Service] Pipe server started!"]);
    logToFile("INFO", "Service fully initialized. Pipe server listening. Protection remains OFF until monitor.start is called.");

    // Sinaliza para o processo pai (Electron em dev) que está pronto
    process.send?.({ type: "service-ready" });
  } catch (err: any) {
    // Pipe já está em uso: existe outra instância (possivelmente órfã de um
    // boot anterior). Não é um erro fatal — saímos limpo (0) e o processo pai
    // reutiliza o serviço que já está a servir o pipe.
    if (err?.code === "EADDRINUSE") {
      logToFile("WARN", "Pipe já em uso. Outra instância do serviço está ativa; encerrando nova instância.");
      safeWrite("out", ["[Service] Outra instância já ativa no pipe. Encerrando nova instância (0)."]);
      process.exit(0);
    }
    logToFile("CRITICAL", "Fatal error during startup", err as Error);
    safeWrite("err", ["[Service] Fatal error during startup:", err]);
    process.exit(1);
  }
}

void main();

// ── Graceful Shutdown ────────────────────────────────────────────────────────

// O código vive em `signal-handlers.ts`, e não aqui, por uma razão concreta:
// este módulo escreve `boot-debug.log` e arranca o serviço no topo. Um teste
// que importasse daqui para alcançar os handlers ligava o serviço inteiro e
// escrevia no runtime REAL do utilizador — aconteceu a 2026-10-02.
const uninstallSignals = installSignalHandlers(service, {
  log: (message) => logToFile("INFO", message),
  warn: () => {},
  error: (message, err) => {
    logToFile("CRITICAL", message, err as Error);
    safeWrite("err", [`[Service] ${message}:`, err]);
  },
});
void uninstallSignals;
