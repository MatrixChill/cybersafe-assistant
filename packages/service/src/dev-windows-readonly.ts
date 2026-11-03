/**
 * Modo de LEITURA Windows para DEV (TP-WIN-P0-SERVICE-READONLY-GATE).
 *
 * O que é: uma guarda de RPC fechada (allowlist), opt-in, que só existe em
 * desenvolvimento isolado. Não é o gate de fixture — esse fica byte-idêntico e
 * é mutualmente exclusivo com este modo — e não é uma permissão genérica: o que
 * não estiver na lista de leituras é recusado ANTES de chegar ao motor, pelo que
 * nenhuma mutação é sequer tentada.
 *
 * O que não é: não prova que o desktop é seguro. `app:set-auto-start`,
 * `setLoginItemSettings`, `app:update*` e a exportação de ficheiros vivem no
 * `main.ts` do Electron, fora deste RPC, e continuam por tratar.
 *
 * Porque é que a validação é chamada no TOPO de `index.ts`: o módulo abre
 * `BASE_DIR`, cria diretórios e gira `error.log`/`boot-debug.log` antes de
 * qualquer outra linha correr. Uma validação mais abaixo já teria produzido
 * esses efeitos numa configuração errada. (Limite honesto: os `import` de ES
 * módulos são içados — os efeitos de topo dos módulos importados não podem ser
 * antecedidos a partir daqui; ver a nota em `index.ts`.)
 *
 * Diádica de mensagens: só causas nomeadas e métodos de um enum fechado. Nada
 * de valores de ENV, caminhos ou payloads de pedido — o texto do pedido é
 * exatamente onde vivem caminhos de utilizador e segredos.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Código estável de recusa deste modo. Prefixo direto, sem envelope próprio. */
export const READONLY_CODE = "dev_windows_readonly";
/** ENV que pede o modo. Só o valor exato "1" liga. */
export const WINDOWS_READONLY_ENV = "CYBERSAFE_DEV_WINDOWS_READONLY";
/** ENVs de efeitos de arranque que têm de estar cortados ANTES de init. */
export const USB_PROTECTION_ENV = "CYBERSAFE_USB_PROTECTION";
export const STARTUP_RESUME_ENV = "CYBERSAFE_STARTUP_RESUME";
const DEV_ISOLATION_ENV = "CYBERSAFE_DEV_ISOLATION";
const SERVICE_DIR_ENV = "CYBERSAFE_DEV_SERVICE_DIR";
const PIPE_NAME_ENV = "CYBERSAFE_DEV_PIPE_NAME";
const DB_PATH_ENV = "CYBERSAFE_DB_PATH";
const FIXTURE_SCAN_ENV = "CYBERSAFE_REALDEV_FIXTURE_SCAN";
const FIXTURE_ROOT_ENV = "CYBERSAFE_REALDEV_FIXTURE_ROOT";
const TEST_YARA_ENV = "CYBERSAFE_DEV_TEST_YARA_PATH";
/** Pipe default de produção — nunca pode ser o pipe deste modo. */
const PIPE_DEFAULT = "\\\\.\\pipe\\cybersafe-protection-dev-v2";

type Env = Record<string, string | undefined>;

/** Erro de recusa do modo. `causa` é um token fechado; nunca contém valores. */
export class DevWindowsReadonlyError extends Error {
  readonly causa: string;
  constructor(causa: string) {
    super(`${READONLY_CODE}: ${causa}`);
    this.name = "DevWindowsReadonlyError";
    this.causa = causa;
  }
}

/**
 * Os 43 métodos do dispatch do serviço. Lista fechada: é o que pode ser nomeado
 * num log/recusa. Um `method` fora daqui é reportado como `metodo_desconhecido`,
 * porque o valor do pedido é conteúdo do chamador, não vocabulário nosso.
 */
export const METODOS_DO_SERVICO: ReadonlySet<string> = new Set<string>([
  "analysis.restricted", "connections.list", "definitions.status", "definitions.update", "events.clear", "events.list",
  "exclusions.get", "exclusions.update", "hardware.snapshot", "monitor.pause", "monitor.resume",
  "monitor.start", "monitor.stop", "pcstate.get", "process.analyze", "process.killTree", "process.termination.prepare", "process.termination.confirm", "process.termination.cancel",
  "processes.list", "protection.getState", "protectionIntent.get", "protectionIntent.setOptIn",
  "quarantine.delete", "quarantine.list", "quarantine.restore", "scan.artifact", "scan.cancel",
  "scan.fullSystem", "scan.getActive", "scan.getLast", "scan.history", "scan.start",
  "service.shutdown", "threat.action", "threats.list", "trust.allowHash", "trust.allowPublisher",
  "usb.cancel", "usb.configure", "usb.getState", "usb.scan", "windows.healthSnapshot",
]);

/**
 * Leituras permitidas, confirmadas no dispatch acima. Tudo o resto é recusado,
 * por decisão da Root: allowlist, não denylist — um método novo fica recusado
 * até ser revisto explicitamente.
 */
export const LEITURAS_PERMITIDAS: ReadonlySet<string> = new Set<string>([
  // `definitions.status` é leitura pura do estado das bases: precisa de funcionar
  // na lane read-only, senão a página de definições ficaria muda justamente no
  // modo em que uma descarga real não pode ocorrer.
  "definitions.status",
  "protection.getState",
  "protectionIntent.get",
  "events.list",
  "threats.list",
  "processes.list",
  "connections.list",
  "quarantine.list",
  "pcstate.get",
  "hardware.snapshot",
  "windows.healthSnapshot",
  "usb.getState",
  "exclusions.get",
  "scan.getActive",
  "scan.getLast",
  "scan.history",
]);

/** Injeções para testar o filesystem sem tocar em ficheiros reais. */
export interface WindowsReadonlyDeps {
  existsSync: (p: string) => boolean;
  statSync: (p: string) => { isDirectory(): boolean; isSymbolicLink(): boolean };
  lstatSync: (p: string) => { isSymbolicLink(): boolean };
  realpathSync: (p: string) => string;
  homedir: () => string;
  tmpdir: () => string;
}

const DEPS_REAL: WindowsReadonlyDeps = {
  existsSync: (p) => fs.existsSync(p),
  statSync: (p) => fs.statSync(p),
  lstatSync: (p) => fs.lstatSync(p),
  realpathSync: (p) => fs.realpathSync(p),
  homedir: () => os.homedir(),
  tmpdir: () => os.tmpdir(),
};

export interface ConfigWindowsReadOnly {
  /** Raiz dedicada do run (pai do `service`), já resolvida. */
  runRoot: string;
  serviceDir: string;
  dbPath: string;
  pipe: string;
}

function modoPedido(env: Env): boolean {
  return env[WINDOWS_READONLY_ENV] === "1";
}

/**
 * `caminho` é `base` ou está por baixo dela. Escrito à mão de propósito:
 * `path.relative` entre UNIDADES diferentes devolve um caminho ABSOLUTO, que não
 * começa por `..` — usá-lo como «não está por baixo» fazia `D:\outro` parecer
 * «sob `…\.cybersafe-service`» (medido por um negativo deste modo).
 */
function mesmoOuSob(caminho: string, base: string): boolean {
  const c = path.resolve(caminho).toLowerCase();
  const b = path.resolve(base).toLowerCase();
  if (!b) return false;
  return c === b || c.startsWith(b + "\\") || c.startsWith(b + "/");
}

/** Descendente ESTRITO: por baixo, nunca igual. */
function descendenteEstrito(caminho: string, base: string): boolean {
  const c = path.resolve(caminho).toLowerCase();
  const b = path.resolve(base).toLowerCase();
  return c !== b && (c.startsWith(b + "\\") || c.startsWith(b + "/"));
}

/**
 * Nenhum ancestral pode ser link/junction: um degrau reparse pode redirecionar
 * uma raiz que parece estar em TEMP para qualquer outro sítio. `realpath` só
 * normaliza o caminho completo, por isso é preciso olhar degrau a degrau.
 * Devolve um token (`grau_inexistente` / `reparse`), nunca o caminho.
 */
function cadeiaSemReparse(absoluto: string, deps: WindowsReadonlyDeps, causa: string): string | null {
  const parsed = path.parse(absoluto);
  let corrente = parsed.root;
  const relativa = path.relative(parsed.root, absoluto);
  for (const degrau of relativa === "" ? [] : relativa.split(path.sep)) {
    corrente = path.join(corrente, degrau);
    let st: { isSymbolicLink(): boolean };
    try {
      st = deps.lstatSync(corrente);
    } catch {
      return `${causa}_grau_inexistente`;
    }
    if (st.isSymbolicLink()) return `${causa}_reparse`;
  }
  return null;
}

/**
 * Diretorio existente, não-link, realpath igual ao léxico e cadeia sem reparse.
 * Devolve `null` quando passa, ou o token do motivo.
 */
function provarDiretorio(alvo: string, deps: WindowsReadonlyDeps, causa: string): string | null {
  if (!deps.existsSync(alvo)) return `${causa}_inexistente`;
  let st: { isDirectory(): boolean; isSymbolicLink(): boolean };
  try {
    st = deps.statSync(alvo);
  } catch {
    return `${causa}_nao_inspecionavel`;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${causa}_nao_e_diretorio`;
  let real: string;
  try {
    real = deps.realpathSync(alvo);
  } catch {
    return `${causa}_realpath_indisponivel`;
  }
  if (real.toLowerCase() !== path.resolve(alvo).toLowerCase()) return `${causa}_realpath_difere`;
  return cadeiaSemReparse(alvo, deps, causa);
}

/**
 * Validação da configuração. Não produz efeito: lê ambiente e estado do
 * filesystem. Lança com a causa nomeada e nada mais.
 *
 * O isolamento de `core/dev-isolation.ts` não chega aqui: prova que o caminho não
 * é pessoal e que o pipe é local, mas não prova raiz dedicada dentro de TEMP, nem
 * reparse nos ancestrais, nem que a BD do API pertence AO MESMO run por caminhos
 * seguros, nem que os efeitos de arranque estão cortados. Sem fallback.
 */
export function validarConfigWindowsReadOnly(
  env: Env = process.env,
  deps: WindowsReadonlyDeps = DEPS_REAL,
): ConfigWindowsReadOnly {
  if (env.NODE_ENV !== "development") throw new DevWindowsReadonlyError("exige_node_env_development");
  if (env[DEV_ISOLATION_ENV] !== "1") throw new DevWindowsReadonlyError("exige_isolamento_de_dev");
  // Exclusividade com o fixture: um processo serve um regime. O gate de fixture
  // não é afrouxado nem alargado; simplesmente não coexiste.
  if (env[FIXTURE_SCAN_ENV] === "1") throw new DevWindowsReadonlyError("conflito_com_sessao_de_fixture");
  if (env[FIXTURE_ROOT_ENV]) throw new DevWindowsReadonlyError("conflito_com_raiz_de_fixture");
  if (env[TEST_YARA_ENV]) throw new DevWindowsReadonlyError("conflito_com_corpus_canario");
  // Efeitos de arranque: o módulo EXIGE o corte, não o define. Silenciar aqui
  // seria o launcher a prometer e o serviço a fingir que validou.
  if (env[USB_PROTECTION_ENV] !== "0") throw new DevWindowsReadonlyError("exige_poll_usb_cortado");
  if (env[STARTUP_RESUME_ENV] !== "0") throw new DevWindowsReadonlyError("exige_retoma_de_protecao_cortada");

  const dirServico = (env[SERVICE_DIR_ENV] ?? "").trim();
  const db = (env[DB_PATH_ENV] ?? "").trim();
  const pipe = (env[PIPE_NAME_ENV] ?? "").trim();
  if (!dirServico || !db || !pipe) throw new DevWindowsReadonlyError("config_parcial");
  if (!path.isAbsolute(dirServico) || !path.isAbsolute(db)) throw new DevWindowsReadonlyError("caminhos_nao_absolutos");
  if (pipe === PIPE_DEFAULT) throw new DevWindowsReadonlyError("pipe_coincide_com_default");
  if (!/^\\\\\.\\pipe\\[^\\/:*?"<>|\x00-\x1f]+$/.test(pipe)) throw new DevWindowsReadonlyError("pipe_nao_local_estrito");

  const serviceDir = path.resolve(dirServico);
  const dbPath = path.resolve(db);
  const runRoot = path.resolve(path.dirname(serviceDir));

  // Ordem do diagnóstico: o caso perigoso nomeia-se primeiro.
  const pessoal = path.resolve(deps.homedir());
  if (serviceDir.toLowerCase() === pessoal.toLowerCase()) throw new DevWindowsReadonlyError("raiz_e_o_pessoal");
  if (mesmoOuSob(serviceDir, path.join(pessoal, ".cybersafe-service"))) {
    throw new DevWindowsReadonlyError("raiz_esta_no_servico_instalado");
  }

  const temp = path.resolve(deps.tmpdir());
  if (runRoot.toLowerCase() === temp.toLowerCase()) {
    // `TEMP\service` dá runRoot == TEMP: a "raiz do run" seria a base temporária
    // inteira, com a BD e o perfil de outro qualquer run misturado dentro.
    throw new DevWindowsReadonlyError("raiz_do_run_e_a_base_temporaria");
  }
  if (!descendenteEstrito(runRoot, temp)) throw new DevWindowsReadonlyError("raiz_do_run_fora_da_base_temporaria");
  if (!descendenteEstrito(serviceDir, runRoot)) throw new DevWindowsReadonlyError("service_dir_fora_da_raiz_do_run");

  // BD: mesma raiz dedicada, e o caminho até ela tem de ser tão verificável
  // como o diretório do serviço — um link no pai da BD ou a BD ser um symlink
  // levam-na para fora do run com uma comparação léxica a dizer que está dentro.
  if (!mesmoOuSob(dbPath, runRoot)) throw new DevWindowsReadonlyError("bd_fora_da_raiz_do_run");
  if (!dbPath.toLowerCase().endsWith(".db")) throw new DevWindowsReadonlyError("bd_sem_extensao_explicita");

  const provaRaiz = provarDiretorio(runRoot, deps, "raiz");
  if (provaRaiz) throw new DevWindowsReadonlyError(provaRaiz);
  const provaServico = provarDiretorio(serviceDir, deps, "service_dir");
  if (provaServico) throw new DevWindowsReadonlyError(provaServico);

  const dirDaBd = path.dirname(dbPath);
  const provaBd = provarDiretorio(dirDaBd, deps, "pai_da_bd");
  if (provaBd) throw new DevWindowsReadonlyError(provaBd);
  if (deps.existsSync(dbPath)) {
    let st: { isSymbolicLink(): boolean; isFile(): boolean };
    try {
      st = deps.lstatSync(dbPath) as { isSymbolicLink(): boolean; isFile(): boolean };
    } catch {
      throw new DevWindowsReadonlyError("bd_nao_inspecionavel");
    }
    if (st.isSymbolicLink()) throw new DevWindowsReadonlyError("bd_e_um_link");
    const real = deps.realpathSync(dbPath);
    if (real.toLowerCase() !== dbPath.toLowerCase()) throw new DevWindowsReadonlyError("bd_realpath_difere");
    if (!mesmoOuSob(real, runRoot)) throw new DevWindowsReadonlyError("bd_realpath_fora_da_raiz");
  }

  return { runRoot, serviceDir, dbPath, pipe };
}

interface Pedido {
  id?: string;
  type?: string;
  method?: string;
  payload?: unknown;
}
interface Resposta {
  id: string;
  type: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
type ServicoAlvo = { handleRequest?: (pedido: Pedido | undefined) => Promise<Resposta> | Resposta };

/** Nome de método seguro para log/recusa: só o vocabulário fechado do serviço. */
function metodoNomeado(method: unknown): string {
  return typeof method === "string" && METODOS_DO_SERVICO.has(method) ? method : "metodo_desconhecido";
}

/**
 * Registo das instalações feitas POR ESTE módulo. Única fonte de verdade de
 * `guardaWindowsReadOnlyMontada`: olhar o texto da função distinguiria mal uma
 * imitação de uma guarda provada.
 */
const instalacoes = new WeakMap<object, { wrapper: unknown; runRoot: string }>();

/**
 * Monta a guarda. Devolve `false` sem tocar no filesystem nem no serviço quando
 * o modo não é pedido — regime normal e modo desligado inalterados. Quando é
 * pedido: valida (pode lançar) e substitui `handleRequest` por uma versão que
 * recusa fora da allowlist sem dispatch.
 */
export function montarGuardaWindowsReadOnly(
  service: object,
  env: Env = process.env,
  log: (linha: string) => void = (l) => console.log(l),
  deps: WindowsReadonlyDeps = DEPS_REAL,
): boolean {
  if (!modoPedido(env)) return false;
  const config = validarConfigWindowsReadOnly(env, deps);

  const alvo = service as unknown as ServicoAlvo;
  if (typeof alvo.handleRequest !== "function") {
    throw new DevWindowsReadonlyError("servico_sem_handle_request");
  }
  const original = alvo.handleRequest.bind(alvo);
  const raizRegistada = config.runRoot;

  const recusa = (pedido: Pedido | undefined, causa: string): Resposta => {
    log(`[Service] ${READONLY_CODE} recusou ${metodoNomeado(pedido?.method)}: ${causa}`);
    return { id: String(pedido?.id ?? ""), type: "response", ok: false, error: `${READONLY_CODE}: ${causa}` };
  };

  const wrapper = async (pedido: Pedido | undefined): Promise<Resposta> => {
    if (!pedido || typeof pedido !== "object") return recusa(pedido, "pedido_ausente_ou_nao_objeto");
    if (typeof pedido.method !== "string" || pedido.method === "") return recusa(pedido, "pedido_sem_metodo");
    if (pedido.type !== "request") return recusa(pedido, "pedido_tipo_incorreto");
    // A recusa acontece aqui, sem `original()`: o motor não é alcançado, logo
    // nenhuma mutação é tentada — não é «mutação que falhou».
    if (!LEITURAS_PERMITIDAS.has(pedido.method)) {
      return recusa(pedido, "metodo_nao_e_leitura_permitida_neste_modo");
    }
    // Prova de posse: a env pode ter mudado desde a montagem (outro run no mesmo
    // processo). Uma flag válida, sozinha, não é autoridade.
    let atual: ConfigWindowsReadOnly;
    try {
      atual = validarConfigWindowsReadOnly(env, deps);
    } catch {
      return recusa(pedido, "configuracao_do_modo_deixou_de_ser_valida");
    }
    if (atual.runRoot.toLowerCase() !== raizRegistada.toLowerCase()) {
      return recusa(pedido, "raiz_do_ambiente_nao_e_a_raiz_registada");
    }
    return await original(pedido);
  };
  alvo.handleRequest = wrapper as ServicoAlvo["handleRequest"];
  instalacoes.set(service, { wrapper: alvo.handleRequest, runRoot: config.runRoot });

  log(`[Service] ${READONLY_CODE} montado: leituras permitidas ativas, mutacoes recusadas antes do motor.`);
  return true;
}

/** Prova de montagem pela instalação registada — não pelo ambiente nem pelo código. */
export function guardaWindowsReadOnlyMontada(
  service: object,
  env: Env = process.env,
  deps: WindowsReadonlyDeps = DEPS_REAL,
): { montado: boolean; causa: string } {
  if (!modoPedido(env)) return { montado: false, causa: "modo_nao_pedido" };
  const alvo = service as unknown as ServicoAlvo;
  if (typeof alvo.handleRequest !== "function") return { montado: false, causa: "sem_handle_request" };
  const registro = instalacoes.get(service);
  if (!registro) return { montado: false, causa: "sem_instalacao_registada" };
  if (alvo.handleRequest !== registro.wrapper) return { montado: false, causa: "wrapper_nao_e_o_registado" };
  let atual: ConfigWindowsReadOnly;
  try {
    atual = validarConfigWindowsReadOnly(env, deps);
  } catch (erro) {
    return { montado: false, causa: `config_invalida:${(erro as DevWindowsReadonlyError).causa ?? "desconhecida"}` };
  }
  if (atual.runRoot.toLowerCase() !== registro.runRoot.toLowerCase()) {
    return { montado: false, causa: "raiz_diferente_da_registada" };
  }
  return { montado: true, causa: "wrapper_instalado_para_esta_raiz" };
}
