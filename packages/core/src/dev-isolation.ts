/**
 * Dev isolation — otim-in EXPLÍCITO de desenvolvimento.
 *
 * Objetivos (TP-REAL-BOOT-ISOLATION):
 * - Permitir arrancar a stack REAL (serviço + desktop) com o diretório de
 *   dados do serviço e o named pipe ISOLADOS, sem tocar nos dados pessoais.
 * - O default é exatamente o comportamento histórico: sem o otim-in ligado,
 *   nenhuma destas funções altera caminho nem pipe (byte-idêntico).
 * - Configuração parcial ou inválida falha FECHADO (lança) antes de qualquer
 *   mkdir/listen/connect. Não há fallback silencioso para dados pessoais
 *   quando o operador pediu isolamento.
 *
 * LIMITES HONESTOS (não alegar garantia estanque):
 * - `looksLikePackagedRuntime` é HEURÍSTICA de defesa em profundidade: procura
 *   ignorar ENV órfão num install, mas NÃO é prova de que um runtime empacotado
 *   jamais isola. O gate AUTORITATIVO de dev/package é `app.isPackaged` no
 *   processo main (quem define a ENV do filho via `serviceEnv`). Este helper é
 *   partilhado com o serviço (sem Electron), por isso usa apenas sinais de
 *   `process` seguros de ler. Ver relatório TP-REAL-BOOT (análise de order de
 *   import do core no main) para a cobertura do PAI empacotado.
 * - `path.resolve` só normaliza; NÃO prova que o caminho é não-pessoal (um
 *   junction pode apontar para `~/.cybersafe-service`). Essa prova é feita com
 *   realpath + varrimento de reparse points no preflight (gate de GO), não aqui.
 *
 * Não altera deteção, autenticação nem comportamento dos motores. Só a
 * resolução de dois identificadores de contexto (pipe e raiz de dados).
 */
import * as os from "node:os";
import * as path from "node:path";

/** Nome da ENV que liga o otim-in. Só o valor exato "1" liga. */
export const DEV_ISOLATION_FLAG_ENV = "CYBERSAFE_DEV_ISOLATION";
/** Raiz de dados isolada do serviço (caminho absoluto dedicado local). */
export const DEV_SERVICE_DIR_ENV = "CYBERSAFE_DEV_SERVICE_DIR";
/** Nome do pipe local isolado, na forma estrita `\\.\pipe\<nome>`. */
export const DEV_PIPE_NAME_ENV = "CYBERSAFE_DEV_PIPE_NAME";

/** Default de produção do nome do pipe — inalterado por esta mudança. */
export const DEFAULT_PIPE_NAME = "\\\\.\\pipe\\cybersafe-protection-dev-v2";
/** Default de produção da raiz de dados — `~/.cybersafe-service`. */
export const DEFAULT_SERVICE_DIRNAME = ".cybersafe-service";
/** Raiz de dados do CyberSafe Linux Lite — nunca partilhada com o perfil Windows. */
export const DEFAULT_SERVICE_DIRNAME_LINUX = ".cybersafe-linux-lite";
/** Ficheiro AF_UNIX do motor sob a raiz de dados, usado como transporte no Linux. */
export const ENGINE_SOCKET_FILENAME = "engine.sock";

type Env = Record<string, string | undefined>;
type Platform = NodeJS.Platform;

const currentPlatform = (): Platform => process.platform;

/** Erro de recusa de isolamento. Razões nomeiam só variáveis, nunca valores. */
export class DevIsolationError extends Error {
  constructor(reason: string) {
    super(`CyberSafe dev isolation recusado: ${reason}`);
    this.name = "DevIsolationError";
  }
}

export interface IsolationProbe {
  env?: Env;
  home?: string;
  argv?: readonly string[];
  execPath?: string;
  isElectron?: boolean;
  defaultApp?: boolean;
  platform?: Platform;
}

const readEnv = (env?: Env): Env => env ?? process.env;

/** Otim-in ligado apenas por `CYBERSAFE_DEV_ISOLATION=1` (exato). */
export function devIsolationRequested(env?: Env): boolean {
  return readEnv(env)[DEV_ISOLATION_FLAG_ENV] === "1";
}

/** Nome da raiz de dados por plataforma: Linux Lite tem raiz dedicada própria. */
export function defaultServiceDirName(platform: Platform = currentPlatform()): string {
  return platform === "linux" ? DEFAULT_SERVICE_DIRNAME_LINUX : DEFAULT_SERVICE_DIRNAME;
}

/** Default da raiz de dados de produção. Único ponto que descreve `~` + nome. */
export function defaultServiceBaseDir(home: string = os.homedir(), platform: Platform = currentPlatform()): string {
  return path.join(home, defaultServiceDirName(platform));
}

/** Caminho AF_UNIX default do motor sob a raiz de dados (Linux). */
export function defaultEngineSocketPath(baseDir: string): string {
  return path.join(baseDir, ENGINE_SOCKET_FILENAME);
}

/**
 * Transporte default por plataforma: no Linux, socket AFUNIX sob a raiz Linux
 * Lite; fora de Linux exatamente o pipe Windows histórico (byte-idêntico).
 */
export function defaultEngineTransport(home: string = os.homedir(), platform: Platform = currentPlatform()): string {
  if (platform === "linux") return defaultEngineSocketPath(defaultServiceBaseDir(home, platform));
  return DEFAULT_PIPE_NAME;
}

/**
 * Heurística de runtime EMPACOTADO (não é prova, ver LIMITES acima). Sinais
 * lidos sem assumir Electron:
 *  - caminho contém `app.asar` ou `<resources>/app` (layout instalado), ou
 *  - corre sob Electron (`versions.electron`) MAS NÃO via `electron <app>`
 *    (`process.defaultApp` ausente) — o caso clássico do main instalado.
 */
export function looksLikePackagedRuntime(probe: IsolationProbe = {}): boolean {
  const argv = probe.argv ?? process.argv;
  const execPath = probe.execPath ?? process.execPath;
  const isElectron = probe.isElectron ?? typeof (process.versions as { electron?: string })?.electron === "string";
  const defaultApp = probe.defaultApp ?? (process as { defaultApp?: boolean }).defaultApp === true;
  const hay = [execPath, ...argv].join("\n");
  if (/app\.asar/i.test(hay)) return true;
  if (/[\\/][Rr]esources[\\/]app([\\/]|$)/.test(hay)) return true;
  if (isElectron && !defaultApp) return true;
  return false;
}

/** `candidate` é igual a `base` ou está por baixo de `base` (case-insensitive). */
export function pathIsSameOrUnder(candidate: string, base: string): boolean {
  const strip = (p: string) => path.resolve(p).replace(/[\\/]+$/, "");
  const c = strip(candidate).toLowerCase();
  const b = strip(base).toLowerCase();
  if (!b) return false;
  return c === b || c.startsWith(b + "/") || c.startsWith(b + "\\");
}

/** Aceita SÓ pipe local Windows estrito; rejeita remotos, traversal, lixo. */
function isValidLocalPipeName(name: string): boolean {
  const m = /^\\\\\.\\pipe\\([^\\/:*?"<>|\x00-\x1f]+)$/.exec(name);
  if (!m) return false;
  const leaf = m[1];
  if (leaf === "." || leaf === "..") return false;
  return true;
}

/**
 * Transporte isolado válido por plataforma: no Windows, pipe local estrito
 * como sempre; no Linux, caminho absoluto de socket AFUNIX (sem NUL, não UNC).
 * Outras plataformas mantêm a validação de pipe (comportamento histórico).
 */
function isValidEngineTransport(name: string, platform: Platform): boolean {
  if (platform === "linux") {
    if (name.includes("\0")) return false;
    if (name.startsWith("\\\\")) return false;
    return path.isAbsolute(name) && path.resolve(name) === name && name !== path.parse(name).root;
  }
  return isValidLocalPipeName(name);
}

/**
 * Candidato a raiz dedicada: absoluto, SEM NUL, NÃO UNC/device (`\\...`), não
 * a raiz do filesystem, e NEM o diretório pessoal NEM os seus DESCENDENTES.
 * Não prova ausência de reparse (isso é o preflight). Retorna false para
 * rejeitar.
 */
function isLocalDedicatedDir(candidate: string, home: string, platform: Platform = currentPlatform()): boolean {
  if (candidate.includes("\0")) return false;
  if (candidate.startsWith("\\\\")) return false; // UNC \\servidor e device \\?\ / \\.\
  if (!path.isAbsolute(candidate)) return false;
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root) return false;
  if (pathIsSameOrUnder(resolved, defaultServiceBaseDir(home, platform))) return false; // pessoal + descendentes
  if (resolved.toLowerCase() === path.resolve(home).toLowerCase()) return false; // home exato
  return true;
}

/**
 * Valida o par {dir, pipe} em conjunto e com o pipe NÃO a coincidir com o
 * default. Se o otim-in está ligado, AMBOS têm de estar presentes e válidos.
 */
function validateIsolationPair(env: Env, home: string, platform: Platform = currentPlatform()): { dir: string; pipe: string } {
  const rawDir = env[DEV_SERVICE_DIR_ENV];
  const rawPipe = env[DEV_PIPE_NAME_ENV];
  if (rawDir === undefined || rawPipe === undefined) {
    const missing = [
      rawDir === undefined ? DEV_SERVICE_DIR_ENV : null,
      rawPipe === undefined ? DEV_PIPE_NAME_ENV : null,
    ]
      .filter((x): x is string => x !== null)
      .join(", ");
    throw new DevIsolationError(`configuracao parcial: faltam ${missing}`);
  }
  const dir = rawDir.trim();
  const pipe = rawPipe.trim();
  if (!isLocalDedicatedDir(dir, home, platform)) {
    throw new DevIsolationError(`${DEV_SERVICE_DIR_ENV} invalido (absoluto dedicado local; nunca o pessoal nem descendentes; nunca UNC/device)`);
  }
  if (!isValidEngineTransport(pipe, platform)) {
    throw new DevIsolationError(`${DEV_PIPE_NAME_ENV} invalido (precisa da forma local estrita)`);
  }
  if (pipe.toLowerCase() === defaultEngineTransport(home, platform).toLowerCase()) {
    throw new DevIsolationError(`${DEV_PIPE_NAME_ENV} nao pode coincidir com o transporte default de producao`);
  }
  return { dir: path.resolve(dir), pipe };
}

/**
 * Remove as 3 variáveis de isolamento de um ENV de FILHO. Usado por
 * `main.serviceEnv` quando `app.isPackaged`: `...process.env` espalha-as, logo
 * há de apagá-las explicitamente. Em dev (não empacotado) NÃO é chamado e as
 * variáveis são preservadas. É a única parte testável da garantia; continua a
 * NÃO cobrir o import do core no PAI main (ver relatório).
 */
export function stripDevIsolationEnv(env: Env): Env {
  delete env[DEV_ISOLATION_FLAG_ENV];
  delete env[DEV_SERVICE_DIR_ENV];
  delete env[DEV_PIPE_NAME_ENV];
  return env;
}

/**
 * Runtime que parece empacotado + otim-in ligado: RECUSA nomeada.
 *
 * Devolver o default em silêncio transformava um pedido explícito de isolamento
 * numa ligação ao pipe/raiz de produção — o oposto do que foi pedido. A
 * heurística continua a não ser prova; por isso a única resposta honesta é
 * falhar fechado, com o gate autoritativo (`app.isPackaged`) nomeado.
 */
function refusePackagedOverride(probe: IsolationProbe): void {
  if (!looksLikePackagedRuntime(probe)) return;
  throw new DevIsolationError(
    "runtime parece empacotado e CYBERSAFE_DEV_ISOLATION=1 foi pedido; " +
      "overrides de dev nao sao ignorados em silencio (gate autoritativo: app.isPackaged no main)",
  );
}

/**
 * Nome do pipe a usar. Sem otim-in => `DEFAULT_PIPE_NAME` no Windows
 * (idêntico) e socket AFUNIX dedicado no Linux. Com otim-in válido =>
 * transporte isolado (nunca o default). Inválido/parcial => lança (falha
 * fechada antes de qualquer connect). Runtime empacotado com otim-in =>
 * lança, nunca devolve o default em silêncio.
 */
export function resolvePipeName(probe: IsolationProbe = {}): string {
  const env = readEnv(probe.env);
  const home = probe.home ?? os.homedir();
  const platform = probe.platform ?? currentPlatform();
  if (!devIsolationRequested(env)) return defaultEngineTransport(home, platform);
  refusePackagedOverride(probe);
  return validateIsolationPair(env, home, platform).pipe;
}

/**
 * Raiz de dados do serviço. Sem otim-in => `~/.cybersafe-service` no Windows
 * (idêntico) e `~/.cybersafe-linux-lite` no Linux. Com otim-in válido =>
 * diretório dedicado. Inválido/parcial => lança. Runtime empacotado com
 * otim-in => lança, nunca devolve a raiz pessoal em silêncio.
 */
export function resolveServiceBaseDir(probe: IsolationProbe = {}): string {
  const env = readEnv(probe.env);
  const home = probe.home ?? os.homedir();
  const platform = probe.platform ?? currentPlatform();
  if (!devIsolationRequested(env)) return defaultServiceBaseDir(home, platform);
  refusePackagedOverride(probe);
  return validateIsolationPair(env, home, platform).dir;
}
