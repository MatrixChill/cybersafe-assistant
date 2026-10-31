/**
 * R8 — ADAPTER REAL do scan USB: `readOnly: true` FORCADO no caminho do motor.
 *
 * Fatia minima (decisao do Codex, 13/10):
 *
 *  1. `PortaAnaliseUsb` — arranca SEMPRE uma analise `custom` com
 *     `readOnly: true` na raiz confirmada pelo servico. O chamador nunca
 *     escolhe o modo: nao ha caminho em que um scan USB corra mutavel.
 *  2. `ProvaReadOnlyUsb` — capacidade ESTRUTURAL e VERSIONADA do caminho
 *     implementado: o motor declara o contrato de analise read-only (nome +
 *     versao) e o adapter exige a versao que implementa. Capacidade aqui
 *     significa "modo suportado e configurado", nao uma prova dinamica de
 *     seguranca absoluta; divergencia de versao (motor antigo/desconhecido)
 *     => auto-scan BLOQUEADO no servico, com limitacao declarada.
 *
 * NAO existe self-test em runtime: nada de correr analises de ensaio no
 * arranque do servico (nem no caminho mutavel do motor, nem com rede). A
 * verificacao real do comportamento — zero quarentena, zero VirusTotal, zero
 * escrita, contencao de caminhos, estado global cancelado/incompleto na
 * remocao — vive nos testes (`r8-usb-readonly*.test.js`,
 * `r8-usb-adapter.test.js`), com o ScanManager real e spies.
 *
 * Injetavel por desenho: o ScanManager (porta) e a capacidade declarada pelo
 * motor sao parametros — os testes provam isto sem Windows, sem pen e sem rede.
 */
import type {
  AlvoAnaliseUsb,
  PortaAnaliseUsb,
  PortaDeteccaoUsb,
  ProvaReadOnlyUsb,
  UsbDispositivoDetetado,
} from "./usb-protection.js";

/** Contrato de analise read-only que este adapter implementa. */
export const USB_READONLY_CONTRATO = { nome: "usb-readonly", versao: 1 } as const;

/** O que o adapter precisa do ScanManager real. */
export interface PortaScansReadOnly {
  startScan(
    type: "custom",
    targetPath?: string,
    options?: {
      readOnly?: boolean;
      /**
       * Confirmação terminal OPCIONAL: corre antes de o scan declarar
       * `completed`. Devolver `{ ok: false }` (ou lançar) ⇒ terminal seguro.
       */
      confirmarTerminal?: () => Promise<{ ok: boolean; motivo?: string }>;
    },
  ): Promise<string | null>;
  cancelScan(id: string): void;
  getScan(id: string): { status?: string } | undefined;
}

/** Capacidade declarada pelo motor (versao do contrato implementado). */
export interface CapacidadeReadOnly {
  nome: string;
  versao: number;
}

/**
 * Porta de CONFIRMAÇÃO TERMINAL de presença: a única coisa que o adapter USB
 * injeta no terminal do ScanManager. Corre no fim da análise, por ENUMERAÇÃO
 * FRESCA, e confirma a MESMA identidade na MESMA raiz — existir o caminho não
 * chega. Ausente/trocado/instável/erro ⇒ `{ ok: false, motivo }`.
 */
export interface PortaConfirmacaoPresencaUsb {
  confirmar(alvo: { id: string; rootPath: string; rootPaths: string[] }): Promise<{ ok: boolean; motivo?: string }>;
}

export interface OpcoesAdaptadorUsbReadOnly {
  scans: PortaScansReadOnly;
  /**
   * Capacidade declarada pelo motor. Ausente/null = desconhecido: o adapter
   * nao inventa suporte e o auto-scan fica bloqueado.
   */
  capacidade: () => CapacidadeReadOnly | null | undefined;
  /**
   * Confirmação terminal de presença/identidade (opcional). Sem esta porta o
   * scan USB comporta-se como antes — a confirmação não é imposta a ninguém.
   */
  confirmarPresenca?: PortaConfirmacaoPresencaUsb;
}

export class UsbReadOnlyScanAdapter implements PortaAnaliseUsb, ProvaReadOnlyUsb {
  private readonly scans: PortaScansReadOnly;
  private readonly capacidade: () => CapacidadeReadOnly | null | undefined;
  private readonly confirmarPresenca?: PortaConfirmacaoPresencaUsb;
  /** Analises USB arrancadas por este adapter (diagnostico/cancelamento). */
  private readonly arrancadas = new Map<string, string>();

  constructor(opcoes: OpcoesAdaptadorUsbReadOnly) {
    this.scans = opcoes.scans;
    this.capacidade = opcoes.capacidade;
    this.confirmarPresenca = opcoes.confirmarPresenca;
  }

  /**
   * Capacidade estrutural: o motor tem de DECLARAR o contrato read-only e na
   * mesma versao que o adapter implementa. Sem declaracao ou com versao
   * diferente, nao ha garantia nenhuma — e sem garantia nao se analisa nada.
   */
  verificar(): { ok: boolean; motivo?: string } {
    let declarada: CapacidadeReadOnly | null | undefined;
    try {
      declarada = this.capacidade();
    } catch (erro) {
      return { ok: false, motivo: `capacidade de read-only não pôde ser lida (${mensagemDeErro(erro)})` };
    }
    if (!declarada || typeof declarada.nome !== "string" || typeof declarada.versao !== "number") {
      return { ok: false, motivo: "o motor não declara o contrato de análise read-only" };
    }
    if (declarada.nome !== USB_READONLY_CONTRATO.nome) {
      return { ok: false, motivo: `contrato de read-only inesperado (${declarada.nome})` };
    }
    if (declarada.versao !== USB_READONLY_CONTRATO.versao) {
      return {
        ok: false,
        motivo: `contrato de read-only incompatível (motor v${declarada.versao}, adapter v${USB_READONLY_CONTRATO.versao})`,
      };
    }
    return { ok: true };
  }

  /** Nomes das analises arrancadas por este adapter (diagnostico). */
  analisesAtivas(): string[] {
    return [...this.arrancadas.keys()];
  }

  /**
   * Arranca a analise USB: `custom` na raiz confirmada, com `readOnly: true`
   * FORCADO aqui. Sem capacidade provada, recusa.
   */
  async iniciar(alvo: AlvoAnaliseUsb): Promise<{ scanId: string }> {
    const raiz = typeof alvo?.rootPath === "string" ? alvo.rootPath.trim() : "";
    if (raiz === "") throw new Error("alvo USB sem raiz confirmada: análise recusada");
    const prova = this.verificar();
    if (!prova.ok) {
      throw new Error(`análise USB recusada: ${prova.motivo ?? "sem contrato de read-only"}`);
    }
    // Confirmação terminal: SÓ quando a porta de presença está ligada. O
    // callback prova, por ENUMERAÇÃO FRESCA, que o alvo ainda está presente
    // com a MESMA identidade na MESMA raiz — existir o caminho não chega. Com
    // a recusa, o ScanManager escreve um terminal seguro em vez de `completed`.
    const confirmarTerminal = this.confirmarPresenca
      ? () =>
          this.confirmarPresenca!.confirmar({
            id: alvo.id,
            rootPath: raiz,
            rootPaths: Array.isArray(alvo.rootPaths) && alvo.rootPaths.length > 0 ? [...alvo.rootPaths] : [raiz],
          })
      : undefined;
    const scanId = await this.scans.startScan(
      "custom",
      raiz,
      confirmarTerminal ? { readOnly: true, confirmarTerminal } : { readOnly: true },
    );
    if (!scanId) {
      // O ScanManager recusa um segundo scan global: a insercao volta a fila
      // com limite honesto, em vez de fingir que arrancou.
      throw new Error("não foi possível arrancar a análise read-only: já existe uma análise global em curso");
    }
    this.arrancadas.set(scanId, raiz);
    return { scanId };
  }

  /** Cancela apenas a analise indicada (o ScanManager e' idempotente). */
  async cancelar(scanId: string): Promise<void> {
    this.arrancadas.delete(scanId);
    this.scans.cancelScan(scanId);
  }
}

function mensagemDeErro(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

/**
 * Confirmação de presença do dispositivo pelo DETETOR EXISTENTE: uma enumeração
 * FRESCA tem de devolver a MESMA identidade na MESMA raiz. Recusa (com motivo
 * PT-PT, sempre sem publicar resultado) quando:
 *  - a enumeração falha (erro ⇒ desconhecido, nunca "presente por omissão");
 *  - a identidade desapareceu;
 *  - a identidade é reciclável (`disk-index-fallback`);
 *  - a raiz mudou / não está entre as raízes confirmadas.
 *
 * Aceitar apenas "o caminho existe" seria aceitar uma letra reutilizada por
 * outro dispositivo — por isso a prova é a identidade + a raiz.
 */
export function criarConfirmacaoPresencaUsb(deteccao: PortaDeteccaoUsb): PortaConfirmacaoPresencaUsb {
  return {
    async confirmar(alvo) {
      let frescos: UsbDispositivoDetetado[];
      try {
        frescos = await deteccao.listar();
      } catch (erro) {
        return {
          ok: false,
          motivo: `enumeração do dispositivo falhou no fim da análise (${mensagemDeErro(erro)}) — resultado não publicado`,
        };
      }
      const presente = (Array.isArray(frescos) ? frescos : []).find((d) => d && d.id === alvo.id);
      if (!presente) {
        return {
          ok: false,
          motivo: "dispositivo ausente no fim da análise — identidade não confirmada; resultado não publicado",
        };
      }
      if (presente.identityProvenance === "disk-index-fallback") {
        return {
          ok: false,
          motivo: "identidade do dispositivo instável no fim da análise (índice de disco) — resultado não publicado",
        };
      }
      const raizes = presente.rootPaths && presente.rootPaths.length > 0 ? [...presente.rootPaths] : [presente.rootPath];
      if (presente.rootPath !== alvo.rootPath || !raizes.includes(alvo.rootPath)) {
        return {
          ok: false,
          motivo: "raiz do dispositivo mudou no fim da análise — resultado não publicado",
        };
      }
      return { ok: true };
    },
  };
}
