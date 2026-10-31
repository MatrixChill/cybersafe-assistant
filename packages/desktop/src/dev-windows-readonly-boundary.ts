/**
 * FRONTEIRA DE LEITURA WINDOWS (DEV, opt-in) — lado do Desktop.
 *
 * O que é: uma política cerrada por canal, decidida ANTES do handler, mais uma
 * validação de configuração que tem de passar antes de qualquer efeito local.
 * O que NÃO é: uma segunda implementação do isolamento. O perfil efectivo é o
 * que `resolveDevProfile` (dev-isolation.ts) já resolveu e já recusou; este
 * módulo consome esse objecto e prova a CONSISTÊNCIA dele com o run do serviço.
 * Não importa `electron` — quem chama passa `isPackaged` e o perfil resolvido,
 * o que também permite exercitar a política com doubles, sem Electron.
 *
 * Separado do gate do serviço (`packages/service/src/dev-windows-readonly.ts`):
 * o serviço recusa mutações no RPC; este módulo impede que o renderer peça ao
 * main effects que NUNCA passaram pelo serviço — arranque no login, actualizador,
 * diálogos nativos, exportação de ficheiro, preferências gravadas, janela de
 * relatório — e as acções mutantes do menu da tray.
 *
 * Higiene de mensagens: só causas nomeadas de um conjunto fechado. Nenhum valor
 * de ambiente, caminho, URL ou payload de pedido entra num erro ou num registo.
 */

export const WINDOWS_READONLY_BOUNDARY_CODE = "dev_windows_readonly";
export const WINDOWS_READONLY_ENV = "CYBERSAFE_DEV_WINDOWS_READONLY";

/**
 * Causas fechadas — a única coisa que este módulo sabe dizer quando recusa.
 * Os quatro tokens de caminho são BASES: a recusa acrescenta-lhe o sufixo do
 * problema medido (`_fora_da_raiz`, `_reparse`, `_realpath_difere`,
 * `_realpath_indisponivel`, `_pai_inexistente`), porque «fora da raiz» e
 * «ancestral é um junction» são diagnósticos diferentes com mensagens iguais.
 */
const CAUSA = {
  EMPACOTADO: "empacotado_recusa_modo_dev",
  ISOLAMENTO: "exige_isolamento_de_dev",
  NODE_ENV: "exige_node_env_development",
  PERFIL_INCOMPLETO: "perfil_de_dev_incompleto",
  PERFIL_EMPACOTADO: "perfil_efectivo_e_o_de_producao",
  RAIZ_USUARIO: "user_data",
  RAIZ_SESSAO: "session_data",
  RAIZ_BD: "bd",
  SERVICE_DIR: "service_dir",
  SERVICE_DIR_AUSENTE: "service_dir_ausente",
  PIPE_AUSENTE: "pipe_ausente_no_ambiente",
  PIPE_DIVERGENTE: "pipe_diverge_do_servico",
  BD_AUSENTE: "bd_ausente_no_ambiente",
  BD_DIVERGENTE: "bd_diverge_do_servico",
  PORTA_ABAIXO_DO_PISO: "porta_api_abaixo_do_piso_dev",
  PORTA_DIVERGENTE: "porta_api_diverge_do_pedido",
  USB: "exige_poll_usb_cortado",
  RETOMA: "exige_retoma_de_protecao_cortada",
  FIXTURE_SCAN: "conflito_com_sessao_de_fixture",
  FIXTURE_ROOT: "conflito_com_raiz_de_fixture",
  CORPUS_CANARIO: "conflito_com_corpus_canario",
} as const;

export class FronteiraWindowsReadOnlyError extends Error {
  readonly causa: string;
  constructor(causa: string) {
    super(`${WINDOWS_READONLY_BOUNDARY_CODE}: ${causa}`);
    this.name = "FronteiraWindowsReadOnlyError";
    this.causa = causa;
  }
}

/**
 * Subconjunto de `PerfilDev` que esta fronteira consome. Está declarado aqui (e
 * não importado de dev-isolation) para o módulo poder ser exercitado com um
 * perfil observável — o objecto real é exactamente este, vindo de
 * `resolveDevProfile`.
 */
export interface PerfilObservavel {
  pipeName?: string;
  apiPort?: number;
  userDataDir?: string;
  sessionDir?: string;
  raizDev?: string;
  dbPath?: string;
  autoStart?: boolean;
  protectionService?: boolean;
}

export interface FronteiraDeps {
  /**
   * O ambiente do processo (em `main.ts` é `process.env`). `NODE_ENV` é lido
   * DAQUI — é a única autoridade — e não do `process.env.NODE_ENV` escrito à mão
   * no `main.ts`, porque o `vite build` pode substituir essa expressão por
   * `"production"` em tempo de compilação e o modo passaria a recusar sempre.
   */
  env: Record<string, string | undefined>;
  isPackaged: boolean;
  perfil: PerfilObservavel;
  /** Injetável para os testes provarem reparse sem criar links (precisa de privilégio). */
  fsLike?: FsLike;
}

/** O mínimo de filesystem que a validação usa. OFF não usa nada disto. */
export interface FsLike {
  existsSync(caminho: string): boolean;
  lstatSync(caminho: string): { isSymbolicLink(): boolean };
  realpathSync(caminho: string): string;
}

import fs from "node:fs";
import path from "node:path";

const fsReal: FsLike = {
  existsSync: (c) => fs.existsSync(c),
  lstatSync: (c) => fs.lstatSync(c),
  realpathSync: (c) => fs.realpathSync(c),
};

export interface DecisaoFronteira {
  activo: boolean;
  causa: string;
}

/** Forma canónica: resolve (mata `..`), sem separador final. */
function canonico(valor: string): string {
  return path.resolve(valor).replace(/[\\/]+$/, "") || path.resolve(valor);
}

/** Descendente com pelo menos um nível próprio, sobre formas canónicas. */
function descendenteEstrito(base: string, alvo: string): boolean {
  const b = base.toLowerCase();
  const a = alvo.toLowerCase();
  return a.length > b.length + 1 && (a.startsWith(b + "\\") || a.startsWith(b + "/"));
}

/**
 * Prova estrutural de um caminho: cada degrau EXISTENTE da ascendência é lido com
 * `lstat` (link/junction ⇒ recusa) e o ancestral existente mais profundo tem de
 * ter `realpath` igual à forma léxica. A própria folha pode ainda não existir
 * (o `userData` é criado mais tarde pelo Electron) — mas só se o PAI existir e
 * estiver provado, e a contenção é sempre medida contra o realpath da raiz, não
 * contra a string que veio do ambiente.
 */
function provarCaminho(alvo: string, raizReal: string | null, deps: FsLike, causa: string): string {
  const absoluto = canonico(alvo);
  // Estrita: a própria raiz também não serve de `userData`/`service dir` — foi
  // exatamente o `runRoot == base temporária` que a revisão do serviço apanhou.
  if (raizReal && !descendenteEstrito(raizReal, absoluto)) {
    throw new FronteiraWindowsReadOnlyError(`${causa}_fora_da_raiz`);
  }
  // Degraus até à raiz já provada; `mesmaCoisa` acima cobre o próprio alvo.
  let degrau = absoluto;
  const fronteira = raizReal ? raizReal.length : path.parse(degrau).root.length - 1;
  let folhasEmFalta = 0;
  while (degrau.length > fronteira) {
    if (deps.existsSync(degrau)) {
      if (deps.lstatSync(degrau).isSymbolicLink()) {
        throw new FronteiraWindowsReadOnlyError(`${causa}_reparse`);
      }
      let real = "";
      try {
        real = canonico(deps.realpathSync(degrau));
      } catch {
        throw new FronteiraWindowsReadOnlyError(`${causa}_realpath_indisponivel`);
      }
      if (!mesmaCoisa(real, degrau)) throw new FronteiraWindowsReadOnlyError(`${causa}_realpath_difere`);
      break;
    }
    folhasEmFalta += 1;
    if (folhasEmFalta > 1) throw new FronteiraWindowsReadOnlyError(`${causa}_pai_inexistente`);
    const pai = path.dirname(degrau);
    if (pai === degrau) break;
    degrau = pai;
  }
  return absoluto;
}

function mesmaCoisa(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Prova da RAIZ do run: tem de existir já (é criada pelo launcher isolado) e ser
 * limpa de reparse. Devolve o realpath, que passa a ser a base de toda a
 * contenção. Não há segunda heurística permissiva: sem esta prova não há modo.
 */
function provarRaiz(raiz: string, deps: FsLike): string {
  const absoluto = canonico(raiz);
  if (!deps.existsSync(absoluto)) throw new FronteiraWindowsReadOnlyError("raiz_do_run_inexistente");
  if (deps.lstatSync(absoluto).isSymbolicLink()) throw new FronteiraWindowsReadOnlyError("raiz_do_run_reparse");
  let real = "";
  try {
    real = canonico(deps.realpathSync(absoluto));
  } catch {
    throw new FronteiraWindowsReadOnlyError("raiz_do_run_realpath_indisponivel");
  }
  if (!mesmaCoisa(real, absoluto)) throw new FronteiraWindowsReadOnlyError("raiz_do_run_realpath_difere");
  // Ascendência até à base temporária: cada degrau existente tem de ser limpo.
  let degrau = path.dirname(absoluto);
  for (let i = 0; i < 24 && degrau.length > 2; i += 1) {
    if (deps.existsSync(degrau)) {
      if (deps.lstatSync(degrau).isSymbolicLink()) throw new FronteiraWindowsReadOnlyError("ancestral_da_raiz_reparse");
      degrau = path.dirname(degrau);
    } else break;
  }
  return real;
}

function modoPedido(env: Record<string, string | undefined>): boolean {
  return env[WINDOWS_READONLY_ENV] === "1";
}

/**
 * Valida a configuração do modo. OFF devolve `{activo:false}` sem uma única
 * leitura de ambiente além da flag e sem qualquer estat — é esse o contrato de
 * «normal/off igual». ON com configuração errada LANÇA com causa nomeada.
 */
export function validarFronteiraWindowsReadOnly(deps: FronteiraDeps): DecisaoFronteira {
  const env = deps.env ?? {};
  if (!modoPedido(env)) return { activo: false, causa: "modo_nao_pedido" };
  const fsLike = deps.fsLike ?? fsReal;

  // 1) Só faz sentido num DEV não empacotado. `app.isPackaged` é a autoridade;
  //    um artefacto com a flag posta recusa em vez de mudar de comportamento.
  if (deps.isPackaged) throw new FronteiraWindowsReadOnlyError(CAUSA.EMPACOTADO);
  if (env.CYBERSAFE_DEV_ISOLATION !== "1") throw new FronteiraWindowsReadOnlyError(CAUSA.ISOLAMENTO);
  // NODE_ENV explícito de desenvolvimento, lido do ambiente que nos foi passado
  // (`env.NODE_ENV`, única autoridade): sem ele não há modo, em vez de um
  // comportamento de produção silenciosamente alterado.
  if (env.NODE_ENV !== "development") throw new FronteiraWindowsReadOnlyError(CAUSA.NODE_ENV);

  // 2) O perfil EFECTIVO (o que `resolveDevProfile` devolveu e o main está prestes
  //    a aplicar), não uma dedução deste módulo. A forma de produção continua a
  //    ser recusada, mas NUNCA é a única prova: abaixo vem a prova estrutural.
  const p = deps.perfil ?? {};
  if (!p.raizDev || !p.userDataDir || !p.sessionDir || !p.dbPath || !p.pipeName) {
    throw new FronteiraWindowsReadOnlyError(CAUSA.PERFIL_INCOMPLETO);
  }
  if (p.autoStart !== false || p.protectionService !== false) {
    throw new FronteiraWindowsReadOnlyError(CAUSA.PERFIL_EMPACOTADO);
  }
  const raizReal = provarRaiz(p.raizDev, fsLike);
  // Cada caminho que o main vai aplicar via `app.setPath`/spawn, provado degrau a
  // degrau e medido contra o REALPATH da raiz (não contra a string do ambiente).
  provarCaminho(p.userDataDir, raizReal, fsLike, CAUSA.RAIZ_USUARIO);
  provarCaminho(p.sessionDir, raizReal, fsLike, CAUSA.RAIZ_SESSAO);
  provarCaminho(p.dbPath, raizReal, fsLike, CAUSA.RAIZ_BD);

  // 3) Consistência EXPLÍCITA com o run do serviço: as variáveis têm de existir e
  //    bater certo com o perfil; uma ausência não é «passa por não haver nada com
  //    que comparar» (foi exatamente o achado da revisão).
  const serviceDirBruto = (env.CYBERSAFE_DEV_SERVICE_DIR ?? "").trim();
  if (!serviceDirBruto) throw new FronteiraWindowsReadOnlyError(CAUSA.SERVICE_DIR_AUSENTE);
  provarCaminho(serviceDirBruto, raizReal, fsLike, CAUSA.SERVICE_DIR);
  const pipePedido = (env.CYBERSAFE_DEV_PIPE_NAME ?? "").trim();
  if (!pipePedido) throw new FronteiraWindowsReadOnlyError(CAUSA.PIPE_AUSENTE);
  if (pipePedido !== p.pipeName) throw new FronteiraWindowsReadOnlyError(CAUSA.PIPE_DIVERGENTE);
  if (!pipePedido.startsWith("\\\\.\\pipe\\")) throw new FronteiraWindowsReadOnlyError(CAUSA.PIPE_DIVERGENTE);
  const bdPedido = (env.CYBERSAFE_DB_PATH ?? "").trim();
  if (!bdPedido) throw new FronteiraWindowsReadOnlyError(CAUSA.BD_AUSENTE);
  if (!mesmaCoisa(canonico(bdPedido), canonico(p.dbPath))) throw new FronteiraWindowsReadOnlyError(CAUSA.BD_DIVERGENTE);
  if (typeof p.apiPort !== "number" || !Number.isInteger(p.apiPort) || p.apiPort < 4100) {
    throw new FronteiraWindowsReadOnlyError(CAUSA.PORTA_ABAIXO_DO_PISO);
  }
  const portaPedida = env.CYBERSAFE_DEV_PORT ? Number.parseInt(env.CYBERSAFE_DEV_PORT, 10) : NaN;
  if (Number.isFinite(portaPedida) && portaPedida >= 4100 && portaPedida !== p.apiPort) {
    throw new FronteiraWindowsReadOnlyError(CAUSA.PORTA_DIVERGENTE);
  }

  // 4) Os dois cortes de arranque, EXIGIDOS e nunca escritos por trás do launcher.
  //    São os ramos já existentes: `engine.ts init()` corta o poll USB com `=0` e
  //    a retoma de proteção com `=0`; o serviço (outro processo) exige o mesmo par.
  if (env.CYBERSAFE_USB_PROTECTION !== "0") throw new FronteiraWindowsReadOnlyError(CAUSA.USB);
  if (env.CYBERSAFE_STARTUP_RESUME !== "0") throw new FronteiraWindowsReadOnlyError(CAUSA.RETOMA);

  // 5) Exclusividade com sessões de fixture/canário: regimes diferentes, nunca
  //    sobrepostos (o gate do serviço recusa o mesmo, por construção). Qualquer
  //    valor não-vazio conta — incluindo caminho RELATIVO, que um teste de
  //    «é absoluto?» deixaria passar.
  if (env.CYBERSAFE_REALDEV_FIXTURE_SCAN === "1") throw new FronteiraWindowsReadOnlyError(CAUSA.FIXTURE_SCAN);
  if ((env.CYBERSAFE_REALDEV_FIXTURE_ROOT ?? "").trim() !== "") throw new FronteiraWindowsReadOnlyError(CAUSA.FIXTURE_ROOT);
  if ((env.CYBERSAFE_DEV_TEST_YARA_PATH ?? "").trim() !== "") throw new FronteiraWindowsReadOnlyError(CAUSA.CORPUS_CANARIO);

  return { activo: true, causa: "fronteira_validada" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Política por canal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Permitidos: leituras do serviço já presentes no gate do serviço, leituras
 * locais sem efeito externo, o controlo da própria janela (cores da barra) e —
 * CRÍTICO — os dois canais da confirmação de saída, porque sem eles o
 * `before-quit` fica à espera para sempre e o utilizador fica preso atrás da
 * política de leitura.
 */
export const CANAIS_PERMITIDOS: ReadonlySet<string> = new Set([
  // Ponte local do próprio processo: estado de ligação, sem RPC.
  "service:get-connection-state",
  // Janela própria (cosmético) e saída segura.
  "app:set-titlebar-overlay",
  "app:exit-confirm-ack",
  "app:exit-confirm-response",
  // Leituras de preferência/estado, sem escrita nem efeito.
  "app:get-auto-start",
  "app:get-notifications-enabled",
  "app:update-get-snapshot",
  // Leituras RPC com equivalente permitido no gate do serviço.
  "service:get-protection-state",
  "service:get-protection-intent",
  "service:get-events",
  "service:get-threats",
  "service:get-processes",
  "service:get-connections",
  "service:get-quarantine",
  "service:get-hardware",
  "service:get-windows-health",
  "service:get-pcstate",
  "service:get-scan-history",
  "service:get-active-scan",
  "service:get-last-scan",
  "service:get-usb-protection",
]);

/**
 * Negados explicitamente: mutação de proteção/engine, scans, kill, quarentena,
 * permissões, definições, USB, escrita de ficheiro, diálogo nativo, registo de
 * arranque, preferências gravadas, actualizador e janela de relatório.
 */
export const CANAIS_NEGADOS: ReadonlySet<string> = new Set([
  "service:set-protection",
  "service:pause-protection",
  "service:set-protection-intent",
  "service:start-scan",
  "service:cancel-scan",
  "service:scan-artifact",
  "service:scan-full-system",
  "service:run-restricted-analysis",
  "service:analyze-process",
  "service:kill-process-tree",
  "service:prepare-process-termination",
  "service:confirm-process-termination",
  "service:cancel-process-termination",
  "service:restore-quarantine",
  "service:delete-quarantine",
  "service:allow-hash",
  "service:allow-publisher",
  "service:threat-action",
  "service:clear-events",
  "service:update-definitions",
  "service:configure-usb-protection",
  "service:usb-scan",
  "service:usb-cancel",
  "app:set-auto-start",
  "app:set-notifications-enabled",
  "app:open-report-window",
  "app:export-pdf",
  "dialog:open-file",
  "dialog:open-folder",
  "app:update-check",
  "app:update-download",
  "app:update-reveal",
  "app:update-install",
  "app:update-cancel",
  "app:update-defer",
  "app:update-set-automatic",
]);

export interface DecisaoCanal {
  permitido: boolean;
  causa: string;
}

/**
 * Decisão por canal, sem olhar para o payload: o nome do canal é o único input,
 * por isso nada do que o renderer enviou pode influenciar a política nem acabar
 * numa mensagem de erro.
 */
export function decidirCanalWindowsReadOnly(canal: unknown): DecisaoCanal {
  if (typeof canal !== "string" || canal.length === 0) {
    return { permitido: false, causa: "canal_ausente" };
  }
  if (CANAIS_PERMITIDOS.has(canal)) return { permitido: true, causa: "leitura_ou_janela_propria" };
  if (CANAIS_NEGADOS.has(canal)) return { permitido: false, causa: "efeito_negado_por_modo_leitura" };
  return { permitido: false, causa: "canal_fora_do_inventario" };
}

/**
 * Acções do menu da tray que têm efeito mutante e NÃO passam por IPC (são
 * chamadas directas do handler nativo). `tray-menu.ts` esconde o item cujo
 * handler não existe, por isso suprimir o handler suprime o efeito.
 */
export const ACOES_TRAY_NEGADAS = ["quickScan", "startProtection", "stopProtection", "pauseProtection"] as const;

export type AccaoTrayNegada = (typeof ACOES_TRAY_NEGADAS)[number];

/** Objecto a fazer spread sobre os handlers da tray: `undefined` ⇒ item escondido. */
export function suprimirAcoesTray(tray: Record<string, unknown>): Record<string, unknown> {
  const copia: Record<string, unknown> = { ...tray };
  for (const accao of ACOES_TRAY_NEGADAS) delete copia[accao];
  return copia;
}

/**
 * Envolvente do handler: decide antes de qualquer efeito e nunca reescreve a
 * resposta dos canais permitidos. O `trustedIpcHandler` continua por fora, logo
 * um emissor falso é recusado com o erro dele, não com a política.
 */
export function comPoliticaLeituraWindows<R>(
  canal: string,
  activo: () => boolean,
  handler: (...args: any[]) => R,
): (...args: any[]) => R {
  return (...args) => {
    if (activo()) {
      // Teste local opt-in: só a sessão no userData temporário já validado.
      // Não abre os canais de serviço, ficheiros, scans ou ações Windows.
      const sessaoDeTeste = process.env.CYBERSAFE_DEV_AUTH_SESSION_TEST === "1"
        && process.env.CYBERSAFE_DEV_WINDOWS_READONLY === "1"
        && process.env.CYBERSAFE_DEV_ISOLATION === "1"
        && process.env.NODE_ENV === "development"
        && ["auth-session:read", "auth-session:write", "auth-session:clear"].includes(canal);
      if (sessaoDeTeste) return handler(...args);
      const decisao = decidirCanalWindowsReadOnly(canal);
      if (!decisao.permitido) throw new FronteiraWindowsReadOnlyError(decisao.causa);
    }
    return handler(...args);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resposta da confirmação de saída
// ─────────────────────────────────────────────────────────────────────────────

export interface DecisaoSaida {
  /** `false` ⇒ o handler do main NÃO toca no resolver pendurado (sem fechar, sem autorizar). */
  consumir: boolean;
  valor: boolean;
  causa: string;
}

/**
 * O handler do main sempre fez `resolve(Boolean(confirmed))`. Isso é correto no
 * caminho normal — e insuficiente aqui: com o modo ligado, um `"lixo"`/string
 * qualquer valeria `true` e **aprovava a saída** sem o utilizador ter confirmado.
 * O modo exige o booleano real antes de consumir o resolver; inválido não
 * resolve, não anula o pending e não fecha janela nenhuma (`false` cancela,
 * `true` resolve exatamente uma vez). Desligado, a semântica é a de sempre.
 */
export function validarRespostaSaida(confirmado: unknown, activo: boolean): DecisaoSaida {
  if (!activo) return { consumir: true, valor: Boolean(confirmado), causa: "comportamento_normal" };
  if (typeof confirmado !== "boolean") {
    return { consumir: false, valor: false, causa: "resposta_de_saida_nao_booleana" };
  }
  return {
    consumir: true,
    valor: confirmado,
    causa: confirmado ? "saida_confirmada" : "saida_cancelada",
  };
}
