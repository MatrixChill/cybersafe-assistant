import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { PIPE_NAME } from "@cybersafe/core";

/**
 * PERFIL DE ISOLAMENTO DO DEV.
 *
 * Fonte única do que o `main.ts` tem de aplicar **antes** de tocar em seja o
 * que for do sistema: nome da app, chave de instância única, `userData`, pipe do
 * serviço, porta da API local e arranque no login.
 *
 * Existe por três colisões medidas em 18/10, com o CyberSafe instalado a correr:
 * 1. `PIPE_NAME` é uma constante única (`@cybersafe/core`) — sem desvio, o
 *    `ServiceClient` de dev podia autenticar contra o serviço de proteção da
 *    instalação;
 * 2. `app.setName("CyberSafe")` + `requestSingleInstanceLock()` partilham a
 *    identidade e o lock com o artefacto instalado;
 * 3. `configureAutoStart()` chama `app.setLoginItemSettings({ openAtLogin: false })`
 *    sob esse mesmo nome, o que pode apagar a entrada de arranque da instalação
 *    enquanto o utilizador está em teste humano.
 *
 * Empacotado devolve exatamente os valores de hoje. Este módulo não abre
 * sockets, não cria diretórios e não lê o ambiente real: recebe `isPackaged`,
 * um `env` e as portas ocupadas, e devolve uma decisão.
 */

export const PRODUCTION_API_PORT = 4000;
export const DEV_API_PORT_FLOOR = 4100;
export const PRODUCTION_APP_NAME = "CyberSafe";
export const DEV_APP_NAME = "CybersafeDev";

export interface PerfilDevEntrada {
  isPackaged: boolean;
  env: Record<string, string | undefined>;
  /** Portas já ocupadas nesta máquina; a escolha sobe a partir do piso dev. */
  portasOcupadas?: ReadonlySet<number>;
}

export interface PerfilDev {
  pipeName: string;
  apiPort: number;
  /** Primeira porta da banda dev, para o log dizer o que foi pedido. */
  apiPortNao: number;
  apiBase: string;
  /** O renderer não pode ter um URL fixo: em dev a base vem injectada. */
  injectApiBaseInRenderer: boolean;
  userDataDir?: string;
  sessionDir?: string;
  /** Raiz de isolamento efectiva (dev); o main afirma contra ela antes da janela. */
  raizDev?: string;
  appName: string;
  /** Chave estável por perfil, usada no lock de instância única. */
  instanceId?: string;
  dbPath?: string;
  /** Em dev o serviço de proteção NÃO é ligado nem iniciado (opção (e)). */
  protectionService: boolean;
  /** Em dev não se escreve no registo de arranque do Windows. */
  autoStart: boolean;
}

const dirTemp = () => os.tmpdir();

/** Diretórios que pertencem ao utilizador real — nunca a base de dev. */
function pastasReais(): string[] {
  const candidates = [
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    process.env.USERPROFILE,
    path.join(os.homedir(), "AppData"),
  ].filter((v): v is string => !!v);
  return candidates.map((c) => path.resolve(c));
}

function dentroDePerfilReal(alvo: string): boolean {
  const resolvido = path.resolve(alvo);
  // Em Windows, `%TEMP%` vive DENTRO de `LOCALAPPDATA`: é precisamente a área
  // isolada que exigimos, não o perfil do produto. Só o que está fora do temp é
  // que pertence ao utilizador real.
  const temp = path.resolve(dirTemp());
  if (resolvido === temp || resolvido.startsWith(temp + path.sep)) return false;
  return pastasReais().some((real) => resolvido === real || resolvido.startsWith(real + path.sep));
}

function escolherPorta(pedido: number, ocupadas: ReadonlySet<number>): number {
  let porta = Math.max(DEV_API_PORT_FLOOR, pedido);
  while (ocupadas.has(porta)) porta += 1;
  return porta;
}

function portaPedida(bruto: string | undefined): number {
  const n = Number.parseInt(bruto ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEV_API_PORT_FLOOR;
}

/**
 * Afirmação usada pelo `main.ts` DEPOIS de cada `app.setPath`, com o valor lido de
 * volta do próprio Electron. Não é dedução: compara o caminho efectivo com o esperado
 * e exige contenção na raiz. Sem nisto, `--user-data-dir` na linha de comandos era
 * prova de nada (medido a 19/10: duas corridas "isoladas" no mesmo `%TEMP%\cybersafe-dev`).
 */
export function afirmarCaminhoIsolado(rotulo: string, efectivo: string, esperado: string, raiz: string | undefined): string {
  const resolvidoEfectivo = path.resolve(efectivo);
  const resolvidoEsperado = path.resolve(esperado);
  if (resolvidoEfectivo !== resolvidoEsperado) {
    throw new Error(`ISOLAMENTO RECUSADO: ${rotulo} efectivo é ${resolvidoEfectivo}, esperado ${resolvidoEsperado}. Nada foi aberto.`);
  }
  if (!raiz) {
    throw new Error(`ISOLAMENTO RECUSADO: ${rotulo} sem raiz de teste declarada (${resolvidoEfectivo}).`);
  }
  const relativo = path.relative(path.resolve(raiz), resolvidoEfectivo);
  const dentro = relativo !== "" && relativo !== ".." && !relativo.startsWith(".." + path.sep) && !path.isAbsolute(relativo);
  if (!dentro) {
    throw new Error(`ISOLAMENTO RECUSADO: ${rotulo} ${resolvidoEfectivo} não está dentro da raiz de teste ${path.resolve(raiz)}.`);
  }
  return resolvidoEfectivo;
}

export function resolveDevProfile(entrada: PerfilDevEntrada): PerfilDev {
  const env = entrada.env ?? {};
  const ocupadas = entrada.portasOcupadas ?? new Set<number>();

  // ── Empacotado: os valores de hoje, e só os de hoje ──────────────────────
  // As variáveis de dev são IGNORADAS aqui de propósito: um artefacto não pode
  // ser desviado para um pipe, uma porta ou uma base de dados de teste.
  if (entrada.isPackaged) {
    return {
      pipeName: PIPE_NAME,
      apiPort: PRODUCTION_API_PORT,
      apiPortNao: PRODUCTION_API_PORT,
      apiBase: `http://127.0.0.1:${PRODUCTION_API_PORT}`,
      injectApiBaseInRenderer: false,
      appName: PRODUCTION_APP_NAME,
      protectionService: true,
      autoStart: true,
    };
  }

  // ── Dev ──────────────────────────────────────────────────────────────────
  const raiz = path.resolve(env.CYBERSAFE_DEV_ROOT ?? path.join(dirTemp(), "cybersafe-dev"));
  const instanceId = crypto
    .createHash("sha256")
    .update(`${DEV_APP_NAME}|${raiz}|${PIPE_NAME}`)
    .digest("hex")
    .slice(0, 16);

  const dbPath = env.CYBERSAFE_DB_PATH ? path.resolve(env.CYBERSAFE_DB_PATH) : path.join(raiz, "data", "matrix.db");
  if (dentroDePerfilReal(dbPath)) {
    throw new Error(
      `CYBERSAFE_DB_PATH aponta para o perfil real do utilizador (APPDATA/perfil): ${dbPath}. ` +
        "Em dev a base tem de viver no diretório temporário isolado.",
    );
  }

  const apiPortNao = DEV_API_PORT_FLOOR;
  const apiPort = escolherPorta(portaPedida(env.CYBERSAFE_DEV_PORT), ocupadas);

  // O `--user-data-dir` do Electron é NEUTRALIZADO pelo `app.setPath("userData", ...)`
  // do `main.ts`: o que manda é o que este perfil devolve. Medido a 19/10 — corridas
  // "isoladas" diferentes partilhavam `%TEMP%\cybersafe-dev\userData` porque só
  // `CYBERSAFE_DEV_USER_DATA_DIR` era passado e nada o lia; o token de uma corrida
  // anterior aparecia na seguinte como se fosse restauro de sessão.
  const userDataDir = env.CYBERSAFE_DEV_USER_DATA_DIR?.trim()
    ? path.resolve(env.CYBERSAFE_DEV_USER_DATA_DIR.trim())
    : path.join(raiz, "userData");
  const sessionDir = env.CYBERSAFE_DEV_SESSION_DATA_DIR?.trim()
    ? path.resolve(env.CYBERSAFE_DEV_SESSION_DATA_DIR.trim())
    : path.join(raiz, "session");
  const dentroDaRaiz = (alvo: string) => {
    const relativo = path.relative(raiz, alvo);
    return relativo !== "" && !relativo.startsWith(".." + path.sep) && relativo !== ".." && !path.isAbsolute(relativo);
  };
  for (const [nome, alvo] of [["CYBERSAFE_DEV_USER_DATA_DIR", userDataDir], ["CYBERSAFE_DEV_SESSION_DATA_DIR", sessionDir]] as const) {
    if (dentroDePerfilReal(alvo)) {
      throw new Error(`${nome} aponta para o perfil real do utilizador (APPDATA/perfil): ${alvo}. Em dev o estado do Electron tem de viver no diretório temporário isolado.`);
    }
    // A raiz declarada é a fronteira de isolamento: override fora da raiz é recusa,
    // nunca re-encaminhamento silencioso para um directório partilhado.
    if (!dentroDaRaiz(alvo)) {
      throw new Error(`${nome} está FORA de CYBERSAFE_DEV_ROOT (${raiz}): ${alvo}. Passa a raiz certa ou remove o override — nunca os dois a discordar.`);
    }
  }

  return {
    // Sufixo próprio: nunca o pipe do serviço instalado, e visível como dev.
    // Com `CYBERSAFE_DEV_PIPE_NAME` explícito (o caso do runner isolado) o nome
    // é usado VERBATIM: o validador do core já recusa o default de produção, e o
    // serviço escuta exactamente nesse nome — sem isto, o desktop ligava-se a
    // `<pipe>-matrixdev` enquanto o serviço abria `<pipe>`, e a ligação falhava
    // com ENOENT para sempre. Sem variável, o sufixo continua a ser derivado.
    pipeName: env.CYBERSAFE_DEV_PIPE_NAME?.trim() ? env.CYBERSAFE_DEV_PIPE_NAME.trim() : `${PIPE_NAME}-matrixdev`,
    apiPort,
    apiPortNao,
    apiBase: `http://127.0.0.1:${apiPort}`,
    injectApiBaseInRenderer: true,
    userDataDir,
    sessionDir,
    raizDev: raiz,
    appName: DEV_APP_NAME,
    instanceId,
    dbPath,
    protectionService: false,
    autoStart: false,
  };
}
