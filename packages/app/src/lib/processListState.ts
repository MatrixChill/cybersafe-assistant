/**
 * Estado HONESTO da lista do Gestor de Tarefas.
 *
 * QA1 (2026-10-25): a página dizia "Nenhum processo encontrado" quando o
 * serviço estava desligado ou quando a primeira leitura ainda não tinha
 * chegado. Três situações distintas caíam no mesmo texto — e uma delas
 * afirmava um facto (não há processos) que ninguém tinha medido.
 *
 * Regra que este módulo fixa:
 *   "Nenhum processo encontrado" só é dito quando o serviço RESPONDEU com uma
 *   lista vazia. Sem resposta válida não se afirma ausência; diz-se que não há
 *   leitura. Sem pesquisa, uma lista antiga com o serviço caído é rotulada como
 *   leitura antiga, nunca apresentada como actual.
 *
 * P1-PROCESS-TRUTH (25/10/2026): a regra acima estava a ser violada pela origem
 * dos dados, não por este módulo. `processes.list` devolvia `[]` com `ok:true`
 * quando a enumeração do Windows rebentava, e o `App` carimbava a frescura com
 * `Date.now()` — portanto `observadoEm` existia, zero linhas chegavam, e a página
 * dizia «nenhum processo» sobre uma leitura que não tinha acontecido. Além da
 * lista vazia legítima, passam a existir estados próprios para «a enumerar»,
 * «a enumeração falhou» e «serviço sem contrato de frescura».
 */

import type { ProcessEnumerationTruth } from "@cybersafe/shared-types";

export type EstadoListaProcessos =
  | { kind: "sem-resposta"; motivo: "servico-desligado" }
  | { kind: "a-carregar" }
  | { kind: "a-enumerar" }
  | { kind: "falha-enumeracao" }
  | { kind: "sem-leitura-afirmada" }
  | { kind: "vazio" }
  | { kind: "filtro-sem-resultados"; total: number; pesquisa: string }
  | { kind: "a-confirmar-remocao" }
  | { kind: "ok" };

export interface EntradaEstadoLista {
  /** Processos no snapshot recebido (prova de resposta), antes do filtro. */
  total: number;
  /** Linhas que o filtro/pesquisa deixam passar. */
  visiveis: number;
  pesquisa: string;
  /** `null` = ligação ainda desconhecida. */
  servicoLigado: boolean | null;
  /** Instante da última leitura VÁLIDA. `null` = nunca houve resposta válida. */
  observadoEm: number | null;
  /**
   * O que o serviço afirma sobre a enumeração. `null`/`undefined` = leitura à
   * antiga (serviço sem contrato): os estados prévios mantêm-se, nada se inventa.
   */
  verdade?: ProcessEnumerationTruth | null;
  /** Um pedido da lista está em voo agora (o único observador real de «em curso»). */
  aEnumerar?: boolean;
}

/**
 * Instante que pode ser afirmado como «leitura válida»: só existe quando o
 * Windows respondeu, e vale pelo instante da FOTO. Uma falha não dá idade nova;
 * um serviço sem contrato não dá idade nenhuma.
 */
export function instanteDeLeituraValida(
  verdade?: ProcessEnumerationTruth | null,
): number | null {
  if (!verdade) return null;
  if (verdade.state !== "ok" && verdade.state !== "failed") return null;
  return verdade.enumeratedAt;
}

export function estadoDaListaDeProcessos(entrada: EntradaEstadoLista): EstadoListaProcessos {
  const { total, visiveis, pesquisa, servicoLigado, observadoEm, verdade, aEnumerar } = entrada;

  if (total === 0) {
    // Serviço comprovadamente desligado: não existe resposta válida de onde se
    // possa concluir "não há processos".
    if (servicoLigado === false) return { kind: "sem-resposta", motivo: "servico-desligado" };
    // Com o serviço ligado, o que o Windows FEZ manda mais do que o número de
    // linhas: uma falha não é uma ausência, e uma foto em curso não é um vazio.
    if (verdade?.state === "failed") return { kind: "falha-enumeracao" };
    // «Em voo» vale também sem contrato: é o único observador real de que a
    // enumeração está a acontecer neste instante.
    if (aEnumerar || verdade?.state === "in-progress") return { kind: "a-enumerar" };
    if (verdade) {
      if (verdade.state === "unreported") return { kind: "sem-leitura-afirmada" };
      if (verdade.state === "never") return { kind: "a-carregar" };
      return { kind: "vazio" };
    }
    // Ligado (ou ainda desconhecido) e sem leitura registada: está a carregar.
    if (observadoEm === null) return { kind: "a-carregar" };
    // Resposta válida com zero processos: aqui sim, a ausência é um facto.
    return { kind: "vazio" };
  }

  if (visiveis === 0) {
    const procura = pesquisa.trim();
    if (procura.length > 0) return { kind: "filtro-sem-resultados", total, pesquisa: procura };
    // Snapshot com linhas mas nenhuma visível sem pesquisa: os PIDs removidos
    // ainda não foram confirmados pelo serviço. Não é lista vazia.
    return { kind: "a-confirmar-remocao" };
  }

  return { kind: "ok" };
}

export interface RotuloEstadoLista {
  titulo: string;
  detalhe: string;
  /** `true` quando a UI deve mostrar o indicador de carregamento. */
  carregando: boolean;
}

export function rotuloDoEstadoDaLista(estado: EstadoListaProcessos): RotuloEstadoLista | null {
  switch (estado.kind) {
    case "sem-resposta":
      return {
        titulo: "Sem leitura de processos",
        detalhe:
          "O serviço de proteção não está ligado. Não há resposta válida: esta lista não prova que existam ou não processos.",
        carregando: false,
      };
    case "a-carregar":
      return {
        titulo: "A ler a lista de processos",
        detalhe: "Ainda não chegou uma resposta válida do serviço. Isto não é uma lista vazia.",
        carregando: true,
      };
    case "vazio":
      return {
        titulo: "Nenhum processo encontrado",
        detalhe: "O serviço respondeu com uma lista vazia.",
        carregando: false,
      };
    case "filtro-sem-resultados":
      return {
        titulo: "Nenhum processo corresponde à pesquisa",
        detalhe: `${estado.total} ${estado.total === 1 ? "processo" : "processos"} na máquina; limpa a pesquisa para os ver.`,
        carregando: false,
      };
    case "a-confirmar-remocao":
      return {
        titulo: "A confirmar a lista",
        detalhe: "Os processos removidos ainda não foram confirmados pelo serviço.",
        carregando: true,
      };
    case "a-enumerar":
      return {
        titulo: "A ler os processos do Windows",
        detalhe: "A enumeração está em curso. Ainda não há resposta: isto não é uma lista vazia.",
        carregando: true,
      };
    case "falha-enumeracao":
      return {
        titulo: "Não foi possível ler os processos do Windows",
        detalhe:
          "A enumeração falhou — não é o computador não ter processos, é o Windows não ter respondido. " +
          "Veja o motivo na barra acima da lista.",
        carregando: false,
      };
    case "sem-leitura-afirmada":
      return {
        titulo: "Sem leitura de processos confirmada",
        detalhe:
          "O serviço que respondeu não informa quando a leitura foi feita. Não se afirma que " +
          "não há processos, e não se afirma que a lista está actual.",
        carregando: false,
      };
    case "ok":
      return null;
  }
}

/**
 * Aviso a mostrar SOBRE a tabela, com linhas presentes ou não. É um eixo
 * separado do `estadoDaListaDeProcessos`: aquele decide o que a área vazia
 * diz; este garante que uma enumeração que rebentou continua a ser dita quando
 * há linhas antigas em ecrã — senão a tabela tapava a falha.
 */
export interface AvisoEnumeracao {
  titulo: string;
  detalhe: string;
}

export function avisoDeEnumeracao(
  verdade?: ProcessEnumerationTruth | null,
  total = 0,
): AvisoEnumeracao | null {
  if (!verdade) return null;
  if (verdade.state === "ok" || verdade.state === "in-progress" || verdade.state === "never") return null;

  if (verdade.state === "unreported") {
    return {
      titulo: "Frescura da lista não afirmada",
      detalhe:
        "O serviço que respondeu não reporta quando a foto do Windows foi tirada. " +
        `${total} ${total === 1 ? "linha" : "linhas"} em ecrã; podem ser antigas.`,
    };
  }

  const motivo = verdade.attempt?.error?.message?.trim() || "motivo não reportado pelo serviço";
  const idade =
    verdade.enumeratedAt !== null
      ? ` Últimas ${total} ${total === 1 ? "linha" : "linhas"} de uma foto com ${Math.max(
          0,
          Math.round((verdade.asOf - verdade.enumeratedAt) / 1000),
        )} s.`
      : " Não existe foto anterior: a lista está vazia porque não houve leitura.";
  return {
    titulo: "A enumeração de processos falhou",
    detalhe:
      `Motivo: ${motivo}.${idade} O serviço está ligado e respondeu — o que não respondeu foi o Windows. ` +
      "Isto não é «sem processos».",
  };
}

/**
 * Uma lista com linhas em ecrã e SEM leitura válida registada é uma leitura
 * ANTIGA — independentemente de a ligação estar desligada, ligada (janela
 * após reconexão, antes de chegar leitura nova) ou por confirmar.
 *
 * R1 (2026-10-25): a primeira versão exigia `servicoLigado === false`, e por
 * isso o banner desaparecia exactamente na janela em que o App já marcou
 * `serviceConnected = true` mas ainda conserva as linhas antigas — essas linhas
 * passavam a ser lidas como actuais.
 */
export function listaDesactualizada(entrada: {
  total: number;
  servicoLigado: boolean | null;
  observadoEm: number | null;
}): boolean {
  return entrada.total > 0 && entrada.observadoEm === null;
}

/**
 * Texto do rótulo de leitura antiga, coerente com o estado REAL da ligação.
 * Nunca diz "desligado" quando o serviço está ligado ou por confirmar.
 */
export function rotuloDaLinhaAntiga(entrada: { servicoLigado: boolean | null }): string {
  if (entrada.servicoLigado === false) {
    return "Última leitura conhecida — o serviço está desligado. Os processos em baixo podem já não existir; isto não é actual.";
  }
  if (entrada.servicoLigado === true) {
    return "Última leitura conhecida — o serviço voltou a ligar e ainda não chegou uma leitura nova. Os processos em baixo podem já não existir; isto não é actual.";
  }
  return "Última leitura conhecida — a ligação ao serviço está por confirmar e ainda não chegou uma leitura nova. Os processos em baixo podem já não existir; isto não é actual.";
}
