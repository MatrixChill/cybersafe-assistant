/**
 * Ciclo de vida da API local empacotada (P0 — instalador, 2026-10-10).
 *
 * Problema concreto que este módulo resolve: no artefacto empacotado o Electron
 * só arrancava o SERVIÇO (`node_modules/@cybersafe/service/dist/index.js`); a
 * API (contas, sessões, dashboard, treino, IA) não era empacotada nem arrancada,
 * e sem `JWT_SECRET` o processo da API aborta antes de abrir o listener (S1).
 * Resultado fora de DEV: a app abria no ecrã de login e nada respondia em
 * 127.0.0.1:4000.
 *
 * Aqui ficam as peças verificáveis (puras sempre que possível, para poderem ser
 * testadas sem Electron):
 *  - segredo JWT ALEATÓRIO POR INSTALAÇÃO, guardado fora do pacote e estável
 *    entre arranques (rotação silenciosa invalidaria sessões sem avisar);
 *  - resolução do entry da API dentro do artefacto (preferindo a cópia
 *    desempacotada, porque o módulo nativo `better-sqlite3` não pode viver no
 *    asar);
 *  - ambiente do processo filho SEM herdar flags de DEV/teste;
 *  - readiness real por HTTP (/health) e encerramento controlado.
 *
 * Regra de produto: a API é AUXILIAR. Nenhuma falha aqui pode impedir o
 * serviço de proteção, a tray ou a janela de arrancar — é por isso que todas as
 * funções devolvem estado explícito em vez de lançar para o boot do Electron.
 */

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Mínimo exigido pela API (S1): igual a JWT_SECRET_MIN_LENGTH em packages/api. */
export const API_SECRET_MIN_LENGTH = 32;
/** Nome do ficheiro do segredo da instalação (dentro do diretório de segredos). */
export const INSTALLATION_SECRET_FILENAME = "api-jwt-secret";
/** Porta por omissão da API local (a mesma que os consumidores da app usam). */
export const DEFAULT_API_PORT = 4000;
/** 48 bytes → 64 caracteres base64url: muito acima do mínimo de 32. */
const SECRET_BYTES = 48;
/** Espera máxima pelo /health antes de declarar falha (não bloqueia a UI). */
export const DEFAULT_HEALTH_TIMEOUT_MS = 20_000;

export interface InstallationSecret {
  secret: string;
  /** true quando o ficheiro não existia e foi criado agora. */
  created: boolean;
  secretPath: string;
}

export interface ApiRuntime {
  child: ChildProcess;
  entryPath: string;
  port: number;
  secretPath: string;
  createdSecret: boolean;
}

export type StartApiResult =
  | { status: "started"; runtime: ApiRuntime }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string; error?: unknown };

export interface SecretDeps {
  fsImpl?: Pick<
    typeof fs,
    "existsSync" | "readFileSync" | "writeFileSync" | "mkdirSync" | "renameSync" | "unlinkSync" | "chmodSync"
  >;
  generateSecret?: () => string;
}

function randomSecret(): string {
  return crypto.randomBytes(SECRET_BYTES).toString("base64url");
}

/**
 * Lê o segredo desta instalação ou cria-o no primeiro arranque.
 *
 * Se o ficheiro existir mas for demasiado curto, NÃO o substituímos em
 * silêncio: isso rodaria o segredo sem o utilizador saber e invalidaria todas as
 * sessões. Lançamos erro e o chamador decide (o boot do Electron trata isto como
 * falha não-fatal da API).
 */
export function readOrCreateInstallationSecret(secretDir: string, deps: SecretDeps = {}): InstallationSecret {
  const f = deps.fsImpl ?? fs;
  const makeSecret = deps.generateSecret ?? randomSecret;
  const secretPath = path.join(secretDir, INSTALLATION_SECRET_FILENAME);

  if (f.existsSync(secretPath)) {
    const current = String(f.readFileSync(secretPath, "utf8")).trim();
    if (current.length >= API_SECRET_MIN_LENGTH) {
      return { secret: current, created: false, secretPath };
    }
    throw new Error(
      `Segredo da instalação inválido em ${secretPath}: esperado um valor com ${API_SECRET_MIN_LENGTH}+ caracteres. ` +
        "Não é substituído automaticamente (isso invalidaria as sessões); apaga o ficheiro de forma explícita para gerar um novo.",
    );
  }

  const secret = makeSecret();
  if (!secret || secret.trim().length < API_SECRET_MIN_LENGTH) {
    throw new Error("Segredo gerado não satisfaz o mínimo exigido; nada foi escrito.");
  }

  f.mkdirSync(secretDir, { recursive: true });
  // Escrita atómica: um ficheiro meio escrito (ou um crash a meio) não pode
  // deixar a instalação com um segredo truncado.
  const tmpPath = `${secretPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    f.writeFileSync(tmpPath, `${secret}\n`, { mode: 0o600 });
    f.renameSync(tmpPath, secretPath);
  } catch (error) {
    try {
      if (f.existsSync(tmpPath)) f.unlinkSync(tmpPath);
    } catch {
      // best-effort: o ficheiro temporário fica visível no diagnóstico, não
      // substitui o segredo real.
    }
    throw error;
  }
  try {
    // Windows mapeia isto de forma parcial, mas restringe o ficheiro em
    // sistemas que o respeitem. Nunca é motivo para falhar o arranque.
    f.chmodSync(secretPath, 0o600);
  } catch {
    /* permissões best-effort */
  }

  return { secret, created: true, secretPath };
}

/**
 * Caminho do entry da API dentro do artefacto empacotado.
 *
 * Preferimos `app.asar.unpacked` porque `better-sqlite3` é um módulo nativo e
 * processos filhos não devem ler binários de dentro do asar. Devolve `null`
 * quando a API não está empacotada — falhar honestamente em vez de inventar um
 * caminho que não existe.
 */
export function resolveApiEntryPath(
  appPath: string,
  existsSync: (candidate: string) => boolean = fs.existsSync,
): string | null {
  const unpackedAppPath = appPath.endsWith("app.asar") ? `${appPath}.unpacked` : null;
  const candidates = [
    ...(unpackedAppPath ? [path.join(unpackedAppPath, "node_modules", "api", "dist", "index.js")] : []),
    path.join(appPath, "node_modules", "api", "dist", "index.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface ApiChildEnvOptions {
  secret: string;
  port: number;
  /** Só o produto empacotado (renderer em file://) precisa de Origin: null. */
  allowNullOrigin?: boolean;
  /** Override explícito (usado pelas sondas). Em produto: omitido = DB da instalação. */
  dbPath?: string;
}

/**
 * Ambiente do processo filho da API.
 *
 * Limpeza deliberada: as flags de teste/DEV herdadas do ambiente do Electron não
 * entram no processo empacotado — `CYBERSAFE_API_NO_LISTEN=1` deixaria a API sem
 * listener e `CYBERSAFE_DB_PATH` apontaria os dados do produto para uma base de
 * DEV. Por omissão usamos a DB da instalação (a mesma do serviço), o que
 * preserva os dados existentes.
 */
export function buildApiChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: ApiChildEnvOptions,
): Record<string, string> {
  const env: Record<string, string | undefined> = { ...baseEnv };
  delete env.CYBERSAFE_API_NO_LISTEN;
  delete env.CYBERSAFE_DB_PATH;

  env.ELECTRON_RUN_AS_NODE = "1";
  env.NODE_ENV = "production";
  env.JWT_SECRET = options.secret;
  env.CYBERSAFE_API_PORT = String(options.port);
  if (options.allowNullOrigin) env.CYBERSAFE_API_ALLOW_NULL_ORIGIN = "1";
  if (options.dbPath) env.CYBERSAFE_DB_PATH = options.dbPath;

  return env as Record<string, string>;
}

export interface HealthDeps {
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: (url: string, init?: { method?: string }) => Promise<{ ok?: boolean }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Readiness real: a API só está "pronta" quando /health responde 2xx. */
export async function waitForApiHealth(port: number, deps: HealthDeps = {}): Promise<boolean> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const intervalMs = deps.intervalMs ?? 400;
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as HealthDeps["fetchImpl"]);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!fetchImpl) return false;

  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/health`, { method: "GET" });
      if (res?.ok) return true;
    } catch {
      // Ainda não há listener: continuar até ao prazo.
    }
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

export interface StartApiOptions {
  /** `app.getAppPath()` do Electron. */
  appPath: string;
  /** `app.getPath("userData")` — fora do pacote. */
  userDataDir: string;
  /** `process.execPath` (o binário do Electron). */
  electronPath: string;
  baseEnv?: NodeJS.ProcessEnv;
  port?: number;
  allowNullOrigin?: boolean;
  dbPath?: string;
  existsSync?: (candidate: string) => boolean;
  spawnImpl?: typeof spawn;
  waitForHealth?: (port: number) => Promise<boolean>;
  log?: (message: string, error?: unknown) => void;
}

/**
 * Arranca a API local empacotada. Nunca lança: devolve sempre um estado
 * explícito para o chamador poder continuar (a proteção não depende da API).
 */
export async function startLocalApi(options: StartApiOptions): Promise<StartApiResult> {
  const log = options.log ?? ((message: string) => console.log(message));
  const spawnImpl = options.spawnImpl ?? spawn;
  const existsSync = options.existsSync ?? fs.existsSync;
  const port = options.port ?? DEFAULT_API_PORT;
  const secretDir = path.join(options.userDataDir, "secrets");

  const entryPath = resolveApiEntryPath(options.appPath, existsSync);
  if (!entryPath) {
    return { status: "skipped", reason: `API não encontrada no artefacto (${options.appPath})` };
  }

  let secretInfo: InstallationSecret;
  try {
    secretInfo = readOrCreateInstallationSecret(secretDir);
  } catch (error) {
    return { status: "failed", reason: "segredo da instalação indisponível", error };
  }

  const env = buildApiChildEnv(options.baseEnv ?? process.env, {
    secret: secretInfo.secret,
    port,
    allowNullOrigin: options.allowNullOrigin,
    dbPath: options.dbPath,
  });

  let child: ChildProcess;
  try {
    child = spawnImpl(options.electronPath, [entryPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // cwd fora do repositório: nenhum `.env` de DEV é lido por engano.
      cwd: options.userDataDir,
      env,
    });
  } catch (error) {
    return { status: "failed", reason: "não foi possível iniciar o processo da API", error };
  }

  child.on("error", (error) => log("[Electron] Falha no processo da API:", error));
  child.stderr?.on("data", (chunk: Buffer) => {
    // Log do filho passa por aqui (nunca inclui o segredo: a API não o imprime).
    log(`[API] ${String(chunk).trimEnd()}`);
  });

  const waitForHealth = options.waitForHealth ?? ((p: number) => waitForApiHealth(p));
  const healthy = await waitForHealth(port);
  if (!healthy) {
    stopLocalApi(child);
    return { status: "failed", reason: `API não respondeu em 127.0.0.1:${port}/health` };
  }

  log(`[Electron] API local pronta em http://127.0.0.1:${port} (segredo: ${secretInfo.created ? "novo" : "existente"}).`);
  return {
    status: "started",
    runtime: {
      child,
      entryPath,
      port,
      secretPath: secretInfo.secretPath,
      createdSecret: secretInfo.created,
    },
  };
}

/**
 * Encerramento controlado. Síncrono por desenho: é chamado no `before-quit`,
 * onde não há tempo para esperar. No Windows o sinal não é entregue como
 * SIGTERM (o processo é terminado), pelo que o SQLite recupera o WAL no arranque
 * seguinte — limitação declarada, não escondida.
 */
export function stopLocalApi(child: ChildProcess | null, deps: { escalateMs?: number } = {}): void {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill();
  } catch {
    /* o processo pode já ter saído */
  }
  const escalateMs = deps.escalateMs ?? 2000;
  const timer = setTimeout(() => {
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* já saiu */
      }
    }
  }, escalateMs);
  // Não deve manter o processo principal vivo só por causa do watchdog.
  timer.unref?.();
}
