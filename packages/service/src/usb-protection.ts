/**
 * R8 — PROTECAO USB no servico: opt-in persistente + monitor de dispositivos.
 *
 * Contrato (R8-USB-CONTRACT-CODEX-2026-10-12.md):
 *  - `UsbProtectionConfig { version: 1, enabled, updatedAt }` gravado
 *    atomicamente (temp + rename) no baseDir do servico. Ausente,
 *    corrompido ou invalido = DISABLED com motivo: NUNCA auto-enable.
 *  - A opcao `enabled` (intencao do utilizador) e o `monitorStatus`
 *    (estado operacional) sao eixos SEPARADOS.
 *  - Identidade instavel (`disk-index-fallback`, reciclavel entre
 *    insercoes) recusa auto-scan com limitacao declarada — nunca se
 *    analisa "o que estiver naquela letra agora".
 *  - Baseline: dispositivos ja' presentes na ativacao/first enumeration
 *    nunca disparam analise automatica sem politica explicita.
 *  - Fila limitada e dedup por IDENTIDADE de insercao (nunca pela
 *    letra). UMA analise global real: se ja' houver analise (manual ou
 *    USB) a decorrer, a insercao nova fica em fila. O slot global e'
 *    reservado no proprio ciclo em que se arranca, para que a segunda
 *    insercao da MESMA enumeracao nao arranque tambem.
 *  - Uma insercao e' analisada UMA vez: um dispositivo presente e terminal
 *    nao volta a arrancar em cada ciclo (senao era um loop de analises).
 *  - Desfecho da analise mapeado com honestidade: `completed` fica retido
 *    ate confirmacao fresca; `cancelled`/`failed`/desconhecido dao o estado
 *    correspondente ao dispositivo e NENHUM resultado publicado.
 *  - O historico TERMINAL e' podado (o snapshot e' bounded, mas o mapa
 *    interno tambem: uma pen que passa nao fica em memoria para sempre).
 *  - Remocao/letra reutilizada/reconexao revalidam identidade por
 *    ENUMERACAO FRESCA (as raizes da mesma enumeracao nao provam nada); o
 *    estado terminal exige confirmacao FRESCA (nunca `completed` por heranca):
 *    um resultado de analise so' e' publicado como `completed` depois de
 *    uma enumeracao posterior que confirme a MESMA identidade na MESMA
 *    raiz. Sem essa confirmacao (remocao, letra trocada ou enumeracao
 *    falhada) o dispositivo fica `incomplete` com motivo e o resultado
 *    NAO e' publicado: nunca "pen limpa" por heranca.
 *  - Enumeracao falhada = `unavailable` + motivo, SEM transicoes: nao se
 *    publica `completed` sem confirmar presenca.
 *  - Desativar cancela APENAS a analise USB iniciada por este modulo —
 *    nunca uma analise manual.
 *  - Se a prova de read-only faltar, o AUTO e' bloqueado AQUI (no
 *    servico), nao apenas na UI: o dispositivo fica `detected` com
 *    limitacao declarada e nenhuma analise arranca.
 *
 * Injetavel por desenho: deteccao, analise, prova de read-only, relogio e
 * store sao portas. Nenhum Windows, pen ou PowerShell — nem nos testes.
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  UsbDeviceState,
  UsbDeviceStatus,
  UsbMonitorStatus,
  UsbProtectionConfig,
  UsbProtectionSnapshot,
} from "@cybersafe/shared-types";

// ── Configuracao (opt-in) ───────────────────────────────────────────────────

/** Porque e' que a configuracao nao foi aceite (nunca "enabled" por omissao). */
export type MotivoConfigUsb =
  | "documento_ausente"
  | "documento_corrompido"
  | "documento_invalido"
  | "versao_desconhecida"
  | "leitura_falhou";

export type LeituraConfigUsb =
  | { estado: "known"; enabled: boolean; config: UsbProtectionConfig }
  | { estado: "unknown"; enabled: false; motivo: MotivoConfigUsb };

/** Data canonica (UTC ISO exata) — a mesma regra da intencao de protecao. */
function isDataCanonica(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/**
 * Validacao pura do documento de opt-in. Documento ausente/corrompido/
 * invalido devolve `unknown` com motivo e `enabled: false`: nao existe
 * caminho em que a ausencia de configuracao ligue a protecao.
 */
export function validarConfigUsb(value: unknown): LeituraConfigUsb {
  if (value === null || value === undefined) {
    return { estado: "unknown", enabled: false, motivo: "documento_ausente" };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { estado: "unknown", enabled: false, motivo: "documento_invalido" };
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) {
    return {
      estado: "unknown",
      enabled: false,
      motivo: typeof raw.version === "number" ? "versao_desconhecida" : "documento_invalido",
    };
  }
  const chaves = Object.keys(raw);
  const chavesEsperadas = ["version", "enabled", "updatedAt"];
  if (
    chaves.length !== chavesEsperadas.length ||
    chaves.some((chave) => !chavesEsperadas.includes(chave)) ||
    typeof raw.enabled !== "boolean" ||
    !isDataCanonica(raw.updatedAt)
  ) {
    return { estado: "unknown", enabled: false, motivo: "documento_invalido" };
  }
  return {
    estado: "known",
    enabled: raw.enabled,
    config: { version: 1, enabled: raw.enabled, updatedAt: raw.updatedAt },
  };
}

interface ConfigIO {
  readFile(file: string, encoding: "utf8"): Promise<string>;
  writeFile(file: string, data: string, options: { encoding: "utf8"; flag: "wx"; mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
}

/** Escritas pendentes por ficheiro (um writer por ficheiro). */
const escritasPendentes = new Map<string, Promise<void>>();

/**
 * Store do opt-in: leitura honesta (nunca cria ficheiro) e escrita
 * ATOMICA (temp com `wx` + rename) com compare-and-set. O diretorio pai
 * tem de existir: este modulo nao inventa caminhos nem cria diretorios.
 */
export class UsbConfigStore {
  private readonly file: string;
  private readonly queueKey: string;
  private readonly io: ConfigIO;

  constructor(file: string, io: ConfigIO = fs) {
    if (!path.isAbsolute(file)) throw new Error("Caminho absoluto da configuração USB obrigatório.");
    this.file = path.normalize(file);
    this.queueKey = process.platform === "win32" ? this.file.toLowerCase() : this.file;
    this.io = io;
  }

  async ler(): Promise<LeituraConfigUsb> {
    let raw: string;
    try {
      raw = await this.io.readFile(this.file, "utf8");
    } catch (error) {
      return {
        estado: "unknown",
        enabled: false,
        motivo: (error as NodeJS.ErrnoException).code === "ENOENT" ? "documento_ausente" : "leitura_falhou",
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { estado: "unknown", enabled: false, motivo: "documento_corrompido" };
    }
    return validarConfigUsb(parsed);
  }

  /**
   * Compare-and-set obrigatorio: `null` so' permite criar quando o
   * ficheiro ainda nao existe. Uma escrita com expectativa errada ou um
   * relogio recuado falham SEM tocar no documento.
   */
  async guardar(config: UsbProtectionConfig, esperada: UsbProtectionConfig | null): Promise<void> {
    const validado = validarConfigUsb(config);
    if (validado.estado !== "known") throw new Error("Configuração USB inválida: não é gravada.");
    const esperadaValidada = esperada === null ? null : validarConfigUsb(esperada);
    if (esperadaValidada !== null && esperadaValidada.estado !== "known") {
      throw new Error("conflito: snapshot esperado de configuração USB inválido.");
    }
    const anterior = escritasPendentes.get(this.queueKey) ?? Promise.resolve();
    const tarefa = anterior.then(async () => {
      const atual = await this.ler();
      const coincide = esperadaValidada === null
        ? atual.estado === "unknown" && atual.motivo === "documento_ausente"
        : atual.estado === "known" &&
          atual.config.enabled === esperadaValidada.config.enabled &&
          atual.config.updatedAt === esperadaValidada.config.updatedAt;
      if (!coincide) throw new Error("conflito: configuração USB alterada ou desconhecida; reler antes de decidir.");
      if (atual.estado === "known" && Date.parse(validado.config.updatedAt) < Date.parse(atual.config.updatedAt)) {
        throw new Error("relógio recuado: escrita de configuração USB recusada.");
      }
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await this.io.writeFile(temp, `${JSON.stringify(validado.config)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await this.io.rename(temp, this.file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") await this.io.unlink(temp).catch(() => {});
        throw error;
      }
    });
    const cauda = tarefa.then(() => {}, () => {});
    escritasPendentes.set(this.queueKey, cauda);
    void cauda.then(() => {
      if (escritasPendentes.get(this.queueKey) === cauda) escritasPendentes.delete(this.queueKey);
    });
    await tarefa;
  }
}

// ── Portas injetaveis do monitor ────────────────────────────────────────────

/** Um dispositivo de armazenamento USB ja' confirmado (join feito fora). */
export interface UsbDispositivoDetetado {
  /** Identidade da insercao (serial/PNPDeviceID do disco) — nunca a letra. */
  id: string;
  rootPath: string;
  rootPaths: string[];
  label?: string;
  identityProvenance?: string;
}

export interface PortaDeteccaoUsb {
  listar(): Promise<UsbDispositivoDetetado[]>;
  /**
   * Discos USB detetados AINDA SEM volume/letra (estado de espera). Opcional:
   * quem não o implementa continua a funcionar — apenas não mostra a espera.
   * NUNCA são alvos de análise (não têm raiz).
   */
  listarPendentes?(): Promise<Array<{ id: string; identityProvenance?: string }>>;
}

/** Motivo ÚNICO e explícito do estado de espera (usado no snapshot e nos testes). */
export const LIMITACAO_AGUARDA_VOLUME =
  "dispositivo detetado — a aguardar volume (letra) do Windows";

/**
 * Cobertura PARCIAL de um disco com vários volumes (partições/letras). A
 * análise automática arranca SEMPRE uma única análise global, na raiz
 * principal — o `UsbDeviceState` do contrato só expõe `rootPath`, e as
 * restantes raízes ficam no mapa interno `raizes` (sem inventar campos). Sem
 * esta declaração, um disco multi-volume apresentava-se como integralmente
 * analisado quando só a primeira letra foi lida; o contrato da deteção nativa
 * promete precisamente que "o serviço declara a cobertura como limitação
 * quando há mais".
 */
export function limitacaoCoberturaParcial(raizes: readonly string[]): string {
  const principal = raizes[0];
  const restantes = raizes.slice(1).join(", ");
  return `cobertura parcial: só ${principal} foi analisado; ${restantes} (mesmo dispositivo) ficou por analisar`;
}

export interface AlvoAnaliseUsb {
  id: string;
  rootPath: string;
  rootPaths: string[];
}

export interface PortaAnaliseUsb {
  iniciar(alvo: AlvoAnaliseUsb): Promise<{ scanId: string }>;
  cancelar(scanId: string): Promise<void>;
}

/**
 * Prova de que o motor analisa em modo estritamente read-only. Sem esta
 * prova o auto-scan fica BLOQUEADO aqui — declarar o MVP como funcional
 * sem ela seria mentir.
 */
export interface ProvaReadOnlyUsb {
  verificar(): { ok: boolean; motivo?: string };
}

export interface StoreConfigUsb {
  ler(): Promise<LeituraConfigUsb>;
  guardar(config: UsbProtectionConfig, esperada: UsbProtectionConfig | null): Promise<void>;
}

export interface OpcoesMonitorUsb {
  deteccao: PortaDeteccaoUsb;
  store: StoreConfigUsb;
  analise?: PortaAnaliseUsb;
  readOnly?: ProvaReadOnlyUsb;
  agora?: () => Date;
  /** Analise global (manual) em curso: a insercao nova espera na fila. */
  analiseManualAtiva?: () => boolean;
  limiteDispositivos?: number;
  limiteFila?: number;
  /** Tecto do historico TERMINAL mantido em memoria (o snapshot e' outro tecto). */
  limiteHistoricoTerminal?: number;
}

const LIMITE_DISPOSITIVOS = 24;
const LIMITE_FILA = 8;
const LIMITE_HISTORICO_TERMINAL = 24;
const LIMITACAO_OPT_IN = "proteção USB desligada (opt-in)";
const LIMITACAO_BASELINE = "dispositivo já presente na ativação — sem análise automática (política de baseline)";
const LIMITACAO_FILA_CHEIA = "fila de análise USB cheia — dispositivo não enfileirado";

function mensagemDeErro(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

/** Prioridade de apresentacao do snapshot bounded (nunca corta o que corre). */
function prioridade(status: UsbDeviceStatus): number {
  if (status === "scanning") return 0;
  if (status === "queued") return 1;
  if (status === "detected") return 2;
  return 3;
}

/** Motivo discriminado de recusa ao ligar uma análise MANUAL ao ciclo de vida. */
export type RegistarAnaliseManualMotivo = "sem-porta" | "ids-invalidos" | "sem-raiz" | "analise-viva";

/**
 * Monitor de protecao USB. Ciclo bounded (uma enumeracao em curso), fila
 * limitada/dedup por identidade e sem qualquer escrita no dispositivo.
 */
export class UsbProtectionMonitor {
  private readonly deteccao: PortaDeteccaoUsb;
  private readonly store: StoreConfigUsb;
  private readonly analise?: PortaAnaliseUsb;
  private readonly readOnly?: ProvaReadOnlyUsb;
  private readonly agora: () => Date;
  private readonly manual?: () => boolean;
  private readonly limiteDispositivos: number;
  private readonly limiteFila: number;
  private readonly limiteHistoricoTerminal: number;

  private readonly dispositivos = new Map<string, UsbDeviceState>();
  /**
   * Raizes confirmadas por identidade. O `UsbDeviceState` do contrato
   * so' tem `rootPath` (a raiz padrao), por isso todas as raizes de um
   * disco com varias particoes ficam aqui — sem inventar campos novos.
   */
  private readonly raizes = new Map<string, string[]>();
  /** Identidades presentes quando a protecao foi ativada: baseline. */
  private readonly baseline = new Set<string>();
  /**
   * Baseline por definir. A PRIMEIRA enumeracao BEM SUCEDIDA a seguir a
   * definir o momento (ARRANQUE em `iniciar()`, ATIVACAO do opt-in em
   * `configurar(true)`) e' o baseline. Se a enumeracao falhar (CIM
   * indisponivel) ou se o dispositivo chegou sem ter sido observado, ele NAO
   * pode entrar como "insercao nova" no ciclo seguinte — senao era
   * autoanalisado contra a politica de baseline (RED POSTHUMAN 13/10).
   */
  private baselinePorMarcar = false;
  /**
   * Analises `completed` a aguardar confirmacao fresca. O resultado fica
   * retido aqui com o NUMERO DE ENUMERACAO em que chegou: so' uma
   * enumeracao POSTERIOR (numero maior) o pode publicar. O mapa, sozinho,
   * nao prova frescura nenhuma — o numero prova.
   */
  private readonly resultadosPendentes = new Map<string, { resultado: unknown; enumeracao: number }>();
  /** Raizes que a analise em curso/pendente leu — a confirmacao exige-as. */
  private readonly raizesAnalisadas = new Map<string, string[]>();
  /**
   * Identidades de insercao que JA' tiveram a sua analise automatica. Uma
   * insercao analisa-se UMA vez: sem isto, um dispositivo presente e terminal
   * voltava a arrancar em cada ciclo (loop de analises sobre a mesma pen).
   * Repetir exige nova insercao (ou accao explicita, fora deste modulo).
   */
  private readonly sessoesIniciadas = new Set<string>();
  /**
   * Enumeracoes BEM SUCEDIDAS feitas por este monitor (ciclos do poll e
   * revalidacoes pre-arranque). E' o relogio da frescura, nao um contador
   * de UI.
   */
  private enumeracoes = 0;
  private enabled = false;
  private monitorStatus: UsbMonitorStatus = "starting";
  private erro?: string;
  private emCurso: Promise<UsbProtectionSnapshot> | null = null;

  constructor(opcoes: OpcoesMonitorUsb) {
    this.deteccao = opcoes.deteccao;
    this.store = opcoes.store;
    this.analise = opcoes.analise;
    this.readOnly = opcoes.readOnly;
    this.agora = opcoes.agora ?? (() => new Date());
    this.manual = opcoes.analiseManualAtiva;
    this.limiteDispositivos = opcoes.limiteDispositivos ?? LIMITE_DISPOSITIVOS;
    this.limiteFila = opcoes.limiteFila ?? LIMITE_FILA;
    this.limiteHistoricoTerminal = opcoes.limiteHistoricoTerminal ?? LIMITE_HISTORICO_TERMINAL;
  }

  /**
   * Quantos dispositivos o monitor mantem em memoria. O snapshot e' bounded
   * por `limiteDispositivos`; este numero prova que o mapa INTERNO tambem
   * nao cresce com o historico (uma pen que passa nao fica para sempre).
   */
  dispositivosConhecidos(): number {
    return this.dispositivos.size;
  }

  snapshot(): UsbProtectionSnapshot {
    const ordenados = [...this.dispositivos.values()].sort((a, b) => {
      const porPrioridade = prioridade(a.status) - prioridade(b.status);
      return porPrioridade !== 0 ? porPrioridade : a.id.localeCompare(b.id);
    });
    const limitados = ordenados
      .slice(0, Math.max(0, this.limiteDispositivos))
      .map((dispositivo) => {
        const copia: UsbDeviceState = { ...dispositivo };
        // Cobertura parcial de um disco com vários volumes: nunca se esconde o
        // que ficou por analisar. Deriva-se no snapshot (a confirmação terminal
        // limpa `limitation`), e só quando não há já um motivo mais específico
        // — esse é mais accionável. Um disco de uma só raiz não ganha nada.
        if (copia.limitation === undefined) {
          const raizes = this.raizes.get(copia.id);
          if (raizes && raizes.length > 1) copia.limitation = limitacaoCoberturaParcial(raizes);
        }
        return copia;
      });
    return {
      enabled: this.enabled,
      monitorStatus: this.monitorStatus,
      updatedAt: this.agora().toISOString(),
      devices: limitados,
      ...(this.erro ? { error: this.erro } : {}),
    };
  }

  /**
   * Arranque: le o opt-in e faz a PRIMEIRA enumeracao. Tudo o que estiver
   * ja' presente na primeira enumeracao BEM SUCEDIDA entra no baseline —
   * nunca e' analisado sozinho, mesmo que a tentativa de arranque falhe.
   */
  async iniciar(): Promise<UsbProtectionSnapshot> {
    const leitura = await this.store.ler();
    this.enabled = leitura.enabled;
    this.baselinePorMarcar = true;
    return this.correrCiclo(true);
  }

  /** Um passo do poll. Bounded: nunca corre duas enumeracoes ao mesmo tempo. */
  async ciclo(): Promise<UsbProtectionSnapshot> {
    return this.correrCiclo(false);
  }

  /**
   * Opt-in. `enabled` tem de ser booleano (input invalido = erro, sem
   * efeitos). Desativar limpa a fila USB e cancela apenas a analise USB
   * que este modulo iniciou.
   */
  async configurar(input: { enabled: unknown }): Promise<UsbProtectionSnapshot> {
    // Validacao ESTRITA: exactamente `{ enabled: boolean }`. Um payload com
    // caminhos/raizes (que este modulo nem usa) e' recusado em vez de ignorado
    // em silencio — o servico nao aceita, nem deixa por validar, nenhum alvo
    // vindo de quem pede.
    const chaves = input && typeof input === "object" ? Object.keys(input) : [];
    const enabled = (input as { enabled?: unknown } | null | undefined)?.enabled;
    if (chaves.length !== 1 || chaves[0] !== "enabled" || typeof enabled !== "boolean") {
      throw new Error(
        "enabled tem de boolean (true/false) e ser o único campo; nenhuma configuração foi gravada.",
      );
    }
    const leitura = await this.store.ler();
    const esperada = leitura.estado === "known" ? leitura.config : null; // CAS
    const proxima: UsbProtectionConfig = { version: 1, enabled, updatedAt: this.agora().toISOString() };
    await this.store.guardar(proxima, esperada);
    const estavaLigada = this.enabled;
    this.enabled = proxima.enabled;

    if (proxima.enabled) {
      for (const id of this.dispositivos.keys()) this.baseline.add(id);
      // Ativacao conservadora, SO' numa transicao OFF->ON: o que estiver
      // presente na PRIMEIRA enumeracao BEM SUCEDIDA a seguir a ligar o opt-in
      // entra no baseline. Sem isto, um dispositivo que ja' estava presente mas
      // ainda nao tinha sido observado (chegou entre a ultima enumeracao e a
      // ativacao, ou a ultima enumeracao falhou) era tratado como insercao nova
      // e AUTOANALISADO contra a politica de baseline (RED POSTHUMAN 13/10).
      // Um `configurar(true)` REDUNDANTE (ja' ligado) e' um no-op e NAO re-arma
      // o baseline — senao engolia uma insercao que chegasse logo a seguir.
      if (!estavaLigada) this.baselinePorMarcar = true;
      return this.snapshot();
    }

    for (const [id, estado] of [...this.dispositivos]) {
      if (estado.status === "queued") {
        this.dispositivos.set(id, {
          ...estado,
          status: "removed",
          limitation: "proteção USB desativada antes de a análise arrancar",
        });
        continue;
      }
      if (estado.status === "scanning") {
        if (estado.scanId && this.analise) await this.analise.cancelar(estado.scanId).catch(() => {});
        this.dispositivos.set(id, {
          ...estado,
          status: "incomplete",
          limitation: "análise USB cancelada por desativação da proteção",
        });
        continue;
      }
      if (this.resultadosPendentes.has(id)) {
        // Resultado retido que nunca foi confirmado: desligar a proteção nao
        // pode publica-lo. Fica registado o motivo, sem resultado nenhum.
        this.resultadosPendentes.delete(id);
        this.raizesAnalisadas.delete(id);
        const { result: _naoPublicado, ...semResultado } = estado;
        this.dispositivos.set(id, {
          ...semResultado,
          status: "incomplete",
          limitation: "proteção USB desativada antes de confirmar a presença — resultado não publicado",
        });
      }
    }
    this.baseline.clear();
    return this.snapshot();
  }

  /**
   * Resultado de uma analise USB. Só aceita a sessao que esta' mesmo a
   * correr: um evento tardio de uma sessao antiga e' ignorado.
   *
   * O desfecho da analise e' mapeado com honestidade:
   *  - `completed` => RETIDO (`incomplete` + motivo) e so' publicado com
   *    `completed` depois de uma enumeracao POSTERIOR confirmar a mesma
   *    identidade na mesma raiz.
   *  - `cancelled`/`failed`/`incomplete`/desconhecido => o dispositivo recebe
   *    esse estado com motivo e **nenhum** resultado: uma analise cancelada
   *    nunca vira "concluida", e nao se publica desfecho nenhum.
   */
  aplicarResultado(scanId: string, resultado: unknown): boolean {
    for (const [id, estado] of this.dispositivos) {
      if (estado.status !== "scanning" || estado.scanId !== scanId) continue;
      const desfecho = (resultado as { status?: unknown } | null | undefined)?.status;
      const { result: _naoPublicado, ...semResultado } = estado;

      if (desfecho === "completed") {
        this.resultadosPendentes.set(id, { resultado, enumeracao: this.enumeracoes });
        this.dispositivos.set(id, {
          ...semResultado,
          status: "incomplete",
          limitation: "análise terminada — aguarda confirmação fresca de presença e identidade",
        });
        return true;
      }

      // Sem desfecho publicavel: nada fica retido, nada e' publicado.
      this.resultadosPendentes.delete(id);
      this.raizesAnalisadas.delete(id);
      if (desfecho === "cancelled") {
        this.dispositivos.set(id, {
          ...semResultado,
          status: "cancelled",
          limitation: "análise USB cancelada — nenhum desfecho publicado",
        });
        return true;
      }
      if (desfecho === "failed") {
        this.dispositivos.set(id, {
          ...semResultado,
          status: "failed",
          limitation: "análise USB falhou — nenhum desfecho publicado",
        });
        return true;
      }
      this.dispositivos.set(id, {
        ...semResultado,
        status: "incomplete",
        limitation: `análise USB sem desfecho publicável (estado da análise: ${typeof desfecho === "string" ? desfecho : "desconhecido"})`,
      });
      return true;
    }
    return false;
  }

  /**
   * Liga uma análise MANUAL (`usb.scan`) ao ciclo de vida do monitor.
   *
   * Sem isto, uma análise arrancada pelo gesto do utilizador ficava FORA do
   * estado publicado (P0 15/10): o snapshot nunca mostrava `scanning`/`scanId`,
   * a UI não tinha o que mostrar nem o que cancelar, nenhum desfecho passava
   * pelo `aplicarResultado` e uma remoção a meio não cancelava nada.
   *
   * NÃO arma o auto-scan nem o opt-in: só publica a análise que o utilizador
   * já autorizou, com a raiz MEDIDA pela enumeração fresca de quem chama.
   *
   * Presença: quem chama só regista depois de uma enumeração fresca ter
   * encontrado o dispositivo com raiz — logo a presença é MEDIDA, não suposta.
   * Se o dispositivo ainda não estiver no mapa (gesto imediatamente a seguir ao
   * arranque, antes do primeiro ciclo) ele é ADOPTADO com esses dados reais, em
   * vez de o gesto do utilizador ficar invisível.
   *
   * Recusa — sem alterar nada — se não houver porta de análise, se os ids forem
   * inválidos, se vier sem raiz, ou se JÁ existir análise viva nesse dispositivo
   * (`queued`/`scanning`): nunca se sobrepõe uma análise a outra. O motivo sai
   * discriminado para quem chama poder dizer a VERDADE ao utilizador.
   */
  registarAnaliseManual(alvo: {
    id: string;
    scanId: string;
    rootPath: string;
    rootPaths?: string[];
  }): { ok: true } | { ok: false; motivo: RegistarAnaliseManualMotivo } {
    if (!this.analise) return { ok: false, motivo: "sem-porta" };
    const id = typeof alvo?.id === "string" ? alvo.id : "";
    const scanId = typeof alvo?.scanId === "string" ? alvo.scanId : "";
    if (id === "" || scanId === "") return { ok: false, motivo: "ids-invalidos" };
    const rootPath = typeof alvo?.rootPath === "string" ? alvo.rootPath.trim() : "";
    if (rootPath === "") return { ok: false, motivo: "sem-raiz" };
    const existente = this.dispositivos.get(id);
    if (existente && (existente.status === "queued" || existente.status === "scanning")) {
      return { ok: false, motivo: "analise-viva" };
    }
    const rootPaths =
      Array.isArray(alvo.rootPaths) && alvo.rootPaths.length > 0 ? [...alvo.rootPaths] : [rootPath];
    const base: UsbDeviceState = existente ?? { id, rootPath, present: true, status: "detected" };
    this.raizes.set(id, rootPaths);
    this.raizesAnalisadas.set(id, [...rootPaths]);
    this.sessoesIniciadas.add(id);
    const ligado: UsbDeviceState = { ...base, rootPath, present: true, status: "scanning", scanId };
    // A análise que CORRE manda: um motivo de espera/limitação antiga e o
    // desfecho de uma análise anterior não podem viajar para este estado.
    delete ligado.limitation;
    delete ligado.awaitingVolume;
    delete ligado.result;
    this.dispositivos.set(id, ligado);
    return { ok: true };
  }

  private correrCiclo(marcarBaseline: boolean): Promise<UsbProtectionSnapshot> {
    if (this.emCurso) return this.emCurso;
    const promessa = this.executar(marcarBaseline).finally(() => {
      this.emCurso = null;
    });
    this.emCurso = promessa;
    return promessa;
  }

  /** Conta uma enumeracao BEM SUCEDIDA: e' o que da' frescura a um resultado. */
  private contarEnumeracao(): void {
    this.enumeracoes += 1;
  }

  private provaReadOnly(): { ok: boolean; motivo?: string } {
    if (!this.readOnly) return { ok: false, motivo: "nenhuma prova de read-only ligada (integração pendente)" };
    try {
      const resultado = this.readOnly.verificar();
      return resultado && typeof resultado.ok === "boolean" ? resultado : { ok: false, motivo: "prova de read-only inválida" };
    } catch (erro) {
      return { ok: false, motivo: mensagemDeErro(erro) };
    }
  }

  private async executar(marcarBaseline: boolean): Promise<UsbProtectionSnapshot> {
    // P0 FIABILIDADE (14/10/2026): discos USB detetados SEM volume publicado.
    // O pedido arranca AQUI, em paralelo com a enumeracao principal: o adapter
    // de deteccao partilha a MESMA leitura CIM (1 leitura por ciclo, nao 2) e o
    // trabalho de espera nunca duplica o custo da deteccao. Best-effort: a
    // falha desta porta nunca derruba um ciclo (devolve lista vazia).
    const pendentesPromessa: Promise<Array<{ id: string; identityProvenance?: string }>> = Promise.resolve()
      .then(() => this.deteccao.listarPendentes?.())
      .then((lista) => (Array.isArray(lista) ? lista : []))
      .catch(() => []);

    let brutos: UsbDispositivoDetetado[];
    try {
      brutos = await this.deteccao.listar();
    } catch (erro) {
      // Falha de enumeracao = desconhecido. Nao se transita nada: sem
      // confirmacao fresca de presenca nao existe estado terminal honesto.
      this.monitorStatus = "unavailable";
      this.erro = mensagemDeErro(erro);
      return this.snapshot();
    }
    this.contarEnumeracao();
    this.monitorStatus = "operational";
    this.erro = undefined;

    const vivos = new Map<string, UsbDispositivoDetetado>();
    for (const bruto of Array.isArray(brutos) ? brutos : []) {
      if (!bruto || typeof bruto.id !== "string" || bruto.id === "") continue;
      if (typeof bruto.rootPath !== "string" || bruto.rootPath === "") continue;
      vivos.set(bruto.id, bruto);
    }

    // Dispositivos em espera de volume (best-effort, ja' em curso desde o
    // inicio do ciclo e com desfecho sempre resolvido).
    const listaPendentes = await pendentesPromessa;
    const pendentes = new Set<string>(
      listaPendentes
        .filter((p) => p && typeof p.id === "string" && p.id !== "")
        .map((p) => p.id),
    );
    if (marcarBaseline || this.baselinePorMarcar) {
      for (const id of vivos.keys()) this.baseline.add(id);
      this.baselinePorMarcar = false;
    }

    // 1. Remocoes por IDENTIDADE (nunca pela letra). Um disco em espera de
    // volume esta' PRESENTE: nao pode ser marcado como removido so' por nao ter
    // raiz (era isso que fazia a pagina piscar entre "detetado" e "ausente").
    for (const [id, estado] of [...this.dispositivos]) {
      if (vivos.has(id)) continue;
      if (pendentes.has(id)) {
        if (!estado.awaitingVolume) {
          this.dispositivos.set(id, {
            ...estado,
            rootPath: "",
            present: true,
            status: "detected",
            awaitingVolume: true,
            limitation: LIMITACAO_AGUARDA_VOLUME,
          });
        }
        continue;
      }
      if (estado.awaitingVolume) {
        // Deixou de estar em espera sem ter raiz: saiu (removido) ou o volume
        // ainda nao chegou a uma enumeracao bem sucedida. Factual, sem herdar
        // desfechos de uma vida anterior do mesmo id.
        this.dispositivos.set(id, {
          ...estado,
          present: false,
          status: "removed",
          awaitingVolume: false,
          limitation: "dispositivo ausente na enumeração",
        });
        this.baseline.delete(id);
        this.sessoesIniciadas.delete(id);
        continue;
      }
      if (estado.status === "scanning") {
        if (estado.scanId && this.analise) await this.analise.cancelar(estado.scanId).catch(() => {});
        this.dispositivos.set(id, {
          ...estado,
          present: false,
          status: "incomplete",
          limitation: "dispositivo removido durante a análise — resultado não confirmado",
        });
      } else if (estado.status === "queued") {
        this.dispositivos.set(id, {
          ...estado,
          present: false,
          status: "removed",
          limitation: "removido antes de a análise arrancar",
        });
      } else if (this.resultadosPendentes.has(id)) {
        // Removido antes da confirmacao: o resultado retido morre aqui. Nunca
        // se publica um desfecho sobre um volume que ja' nao esta' presente.
        this.resultadosPendentes.delete(id);
        this.raizesAnalisadas.delete(id);
        const { result: _naoPublicado, ...semResultado } = estado;
        this.dispositivos.set(id, {
          ...semResultado,
          present: false,
          status: "incomplete",
          limitation: "dispositivo removido antes de confirmar a presença — resultado não publicado",
        });
      } else if (estado.status === "completed") {
        this.dispositivos.set(id, { ...estado, present: false });
      } else {
        this.dispositivos.set(id, {
          ...estado,
          present: false,
          status: "removed",
          limitation: "dispositivo ausente na enumeração",
        });
      }
      // Ausente: uma reconexao e' uma insercao nova (confirmacao fresca).
      this.baseline.delete(id);
      this.sessoesIniciadas.delete(id);
    }

    const prova = this.provaReadOnly();
    // O slot global e' RESERVADO DINAMICAMENTE: arrancar para um dispositivo
    // ocupa-o ja' neste ciclo, senao o segundo dispositivo da mesma enumeracao
    // arrancava tambem e ficavam DUAS analises globais a correr.
    // 1b. Estado de espera DESTE ciclo (registar quem ja' esta' em espera sem
    // sessao aberta). Nunca arranca analise: sem raiz nao ha alvo.
    for (const id of pendentes) {
      if (vivos.has(id)) continue; // ganhou volume: entra no fluxo normal abaixo
      const existente = this.dispositivos.get(id);
      if (existente && (existente.status === "queued" || existente.status === "scanning")) continue;
      const anterior = existente;
      this.dispositivos.set(id, {
        id,
        rootPath: "",
        present: true,
        status: "detected",
        awaitingVolume: true,
        limitation: LIMITACAO_AGUARDA_VOLUME,
        // Nao se herda o desfecho de outra passagem deste id: a espera de volume
        // e' um estado factual, nao um resultado de analise.
        ...(anterior?.label !== undefined ? { label: anterior.label } : {}),
      });
      this.raizes.set(id, []);
    }

    let slotOcupado = [...this.dispositivos.values()].some((estado) => estado.status === "scanning");
    let emFila = [...this.dispositivos.values()].filter((estado) => estado.status === "queued").length;

    // 2. Presencas: sessao nova quando a identidade reaparece/insere.
    for (const [id, bruto] of vivos) {
      const existente = this.dispositivos.get(id);
      const rootPaths = bruto.rootPaths && bruto.rootPaths.length > 0 ? [...bruto.rootPaths] : [bruto.rootPath];
      this.raizes.set(id, rootPaths);

      // Confirmacao fresca da analise pendente: mesma identidade (a chave do
      // mapa) E mesma raiz que a analise leu.
      if (existente && this.resultadosPendentes.has(id)) {
        const pendente = this.resultadosPendentes.get(id)!;
        const analisadas = this.raizesAnalisadas.get(id) ?? [];
        const resultado = pendente.resultado;
        // Frescura ESTRUTURAL: so' confirma uma enumeracao feita DEPOIS de o
        // resultado ter chegado (numero de enumeracao superior ao registado).
        const fresca = this.enumeracoes > pendente.enumeracao;
        this.resultadosPendentes.delete(id);
        this.raizesAnalisadas.delete(id);
        if (fresca && analisadas.includes(bruto.rootPath) && existente.rootPath === bruto.rootPath) {
          const confirmado: UsbDeviceState = {
            ...existente,
            rootPath: bruto.rootPath,
            present: true,
            status: "completed",
            result: resultado as UsbDeviceState["result"],
          };
          if (bruto.label !== undefined) confirmado.label = bruto.label;
          delete confirmado.limitation;
          this.dispositivos.set(id, confirmado);
        } else {
          // Sem confirmacao (identidade noutra raiz ou nenhuma enumeracao
          // posterior): fica a faltar, com motivo, e sem resultado publicado.
          const { result: _naoPublicado, ...semResultado } = existente;
          this.dispositivos.set(id, {
            ...semResultado,
            rootPath: bruto.rootPath,
            present: true,
            status: "incomplete",
            limitation: fresca
              ? "raiz mudou depois da análise — resultado não publicado"
              : "resultado sem confirmação fresca — não publicado",
          });
        }
        continue;
      }

      if (existente && (existente.status === "queued" || existente.status === "scanning")) {
        // Sessao em curso: a identidade manda; nao se reinicia nem se herda nada.
        const atualizado: UsbDeviceState = { ...existente, present: true, rootPath: bruto.rootPath };
        if (bruto.label !== undefined) atualizado.label = bruto.label;
        this.dispositivos.set(id, atualizado);
        this.raizes.set(id, rootPaths);
        if (atualizado.status === "queued" && !slotOcupado && this.podeArrancar(id, prova)) {
          const iniciado = await this.arrancar(id, bruto, rootPaths);
          if (iniciado) {
            emFila -= 1;
            slotOcupado = true;
          }
        }
        continue;
      }

      if (existente && existente.present && this.sessoesIniciadas.has(id)) {
        // A insercao JA' teve a sua analise automatica: nao se repete o scan a
        // cada ciclo. So' se actualiza o que e' factualmente novo (presenca,
        // label, raiz), sem tocar no desfecho anterior nem arrancar nada.
        const repetido: UsbDeviceState = { ...existente, present: true, rootPath: bruto.rootPath };
        if (bruto.label !== undefined) repetido.label = bruto.label;
        if (existente.rootPath !== bruto.rootPath) {
          repetido.limitation = "raiz mudou sem nova inserção — sem análise automática repetida";
        }
        this.raizes.set(id, rootPaths);
        this.dispositivos.set(id, repetido);
        continue;
      }

      // Sessao nova (insercao/reconexao): estado terminal anterior nao transita.
      const novo: UsbDeviceState = {
        id,
        rootPath: bruto.rootPath,
        ...(bruto.label !== undefined ? { label: bruto.label } : {}),
        present: true,
        status: "detected",
      };
      if (!this.enabled) {
        novo.limitation = LIMITACAO_OPT_IN;
        this.dispositivos.set(id, novo);
        continue;
      }
      if (this.baseline.has(id)) {
        novo.limitation = LIMITACAO_BASELINE;
        this.dispositivos.set(id, novo);
        continue;
      }
      if (!prova.ok) {
        novo.limitation = `read-only não provado: análise automática bloqueada${prova.motivo ? ` (${prova.motivo})` : ""}`;
        this.dispositivos.set(id, novo);
        continue;
      }
      if (bruto.identityProvenance === "disk-index-fallback") {
        // Identidade reciclavel entre insercoes: arrancar aqui podia analisar
        // OUTRO dispositivo que reutilizasse a letra. Recusa declarada.
        novo.limitation = "identidade da inserção não é estável (índice de disco) — análise automática recusada";
        this.dispositivos.set(id, novo);
        continue;
      }
      if (slotOcupado || (this.manual?.() ?? false)) {
        if (emFila >= this.limiteFila) {
          novo.limitation = LIMITACAO_FILA_CHEIA;
          this.dispositivos.set(id, novo);
          continue;
        }
        novo.status = "queued";
        novo.limitation = "análise global em curso — aguarda na fila";
        this.dispositivos.set(id, novo);
        emFila += 1;
        continue;
      }
      this.dispositivos.set(id, novo);
      const iniciado = await this.arrancar(id, bruto, rootPaths);
      // Reserva imediata do unico slot global: os restantes vao para a fila.
      if (iniciado) slotOcupado = true;
    }

    this.podarHistorico();
    return this.snapshot();
  }

  /**
   * Poda do historico TERMINAL. O snapshot e' bounded, mas o mapa interno
   * tambem tem de ser: sem isto, cada pen que passa ficava em memoria para
   * sempre e o "bounded" era so' de fachada. Nunca se poda o que esta'
   * presente nem o que esta' activo (`queued`/`scanning`).
   */
  private podarHistorico(): void {
    const podavel = (estado: UsbDeviceState): boolean =>
      !estado.present &&
      (estado.status === "removed" ||
        estado.status === "completed" ||
        estado.status === "cancelled" ||
        estado.status === "failed" ||
        estado.status === "incomplete");
    let terminais = [...this.dispositivos.values()].filter(podavel).length;
    if (terminais <= this.limiteHistoricoTerminal) return;
    // Ordem de insercao = mais antigo primeiro.
    for (const [id, estado] of [...this.dispositivos]) {
      if (terminais <= this.limiteHistoricoTerminal) break;
      if (!podavel(estado)) continue;
      this.dispositivos.delete(id);
      this.raizes.delete(id);
      this.raizesAnalisadas.delete(id);
      this.resultadosPendentes.delete(id);
      this.baseline.delete(id);
      this.sessoesIniciadas.delete(id);
      terminais -= 1;
    }
  }

  /**
   * Um item em fila so' arranca se TODAS as portas o permitirem: presente,
   * read-only provado, porta de analise ligada, opt-in ligado e o slot
   * global livre (nenhuma analise manual do utilizador a correr).
   *
   * RED Codex 13/10: faltavam aqui o `enabled` e o slot manual — uma insercao
   * em fila arrancava sozinha com a protecao desligada ou com uma analise
   * manual a decorrer, e o ScanManager ainda podia recusar e perde-la.
   */
  private podeArrancar(id: string, prova: { ok: boolean }): boolean {
    const estado = this.dispositivos.get(id);
    return (
      !!estado &&
      estado.present &&
      prova.ok &&
      !!this.analise &&
      this.enabled &&
      !(this.manual?.() ?? false)
    );
  }

  /**
   * Revalida identidade/raiz com uma enumeracao NOVA, imediatamente antes de
   * arrancar. As raizes da MESMA enumeracao que decidiu nao provam nada — o
   * mapa interno ja' foi actualizado por elas, logo comparar com ele era
   * auto-confirmacao. So' uma leitura POSTERIOR prova que a identidade ainda
   * esta' ali, na mesma raiz, e que a letra nao foi reutilizada pelo vizinho.
   */
  private async revalidarAntesDeArrancar(id: string, rootPath: string): Promise<string | null> {
    let frescos: UsbDispositivoDetetado[];
    try {
      frescos = await this.deteccao.listar();
    } catch (erro) {
      return `identidade não revalidada: enumeração falhou (${mensagemDeErro(erro)})`;
    }
    this.contarEnumeracao();
    const aindaPresente = (Array.isArray(frescos) ? frescos : []).find((d) => d && d.id === id);
    if (!aindaPresente) return "identidade não revalidada: dispositivo ausente na enumeração fresca";
    if (aindaPresente.identityProvenance === "disk-index-fallback") {
      return "identidade não revalidada: identidade reciclável (índice de disco)";
    }
    if (aindaPresente.rootPath !== rootPath) return "identidade não revalidada: raiz mudou antes de arrancar";
    const raizes = aindaPresente.rootPaths && aindaPresente.rootPaths.length > 0 ? [...aindaPresente.rootPaths] : [aindaPresente.rootPath];
    if (!raizes.includes(rootPath)) return "identidade não revalidada: raiz não confirmada na enumeração fresca";
    this.raizes.set(id, raizes);
    return null;
  }

  /** Revalida identidade/raiz (enumeracao fresca) e só depois arranca. */
  private async arrancar(id: string, bruto: UsbDispositivoDetetado, rootPaths: string[]): Promise<boolean> {
    const estado = this.dispositivos.get(id);
    if (!estado) return false;
    if (!this.analise) {
      this.dispositivos.set(id, { ...estado, limitation: "sem porta de análise ligada (integração pendente)" });
      return false;
    }
    const motivo = await this.revalidarAntesDeArrancar(id, estado.rootPath);
    if (motivo !== null) {
      this.dispositivos.set(id, { ...estado, status: "failed", limitation: motivo });
      return false;
    }
    // Re-checagem DEPOIS da enumeração fresca (que e' assincrona): durante esse
    // `await` o opt-in pode ter sido desligado ou uma analise manual pode ter
    // arrancado. Sem isto, a decisao tomada antes do await arrancava na mesma.
    if (!this.enabled) {
      this.dispositivos.set(id, { ...estado, status: "detected", limitation: LIMITACAO_OPT_IN });
      return false;
    }
    if (this.manual?.() ?? false) {
      this.dispositivos.set(id, {
        ...estado,
        status: "queued",
        limitation: "análise global em curso — aguarda na fila",
      });
      return false;
    }
    try {
      const { scanId } = await this.analise.iniciar({ id, rootPath: bruto.rootPath, rootPaths });
      this.raizesAnalisadas.set(id, [...rootPaths]);
      this.sessoesIniciadas.add(id);
      // A análise COMEÇOU: um motivo de ESPERA ("aguarda na fila") deixou de ser
      // verdade e não pode viajar para o estado `scanning` (a confirmação
      // terminal já não herda limitações pela mesma razão).
      const analisando: UsbDeviceState = { ...estado, status: "scanning", scanId, present: true };
      delete analisando.limitation;
      this.dispositivos.set(id, analisando);
      return true;
    } catch (erro) {
      const falhado: UsbDeviceState = { ...estado, status: "failed", present: true };
      delete falhado.scanId;
      this.dispositivos.set(id, { ...falhado, limitation: `análise USB não arrancou: ${mensagemDeErro(erro)}` });
      return false;
    }
  }
}
