import type { WindowsFirewallState, WindowsHealthSnapshot } from "@cybersafe/shared-types";
import { windowsFirewallDisplay, WINDOWS_FIREWALL_UNKNOWN_DETAIL } from "./protectionHealth";

/**
 * O ciclo de vida REAL da leitura do Windows Firewall dentro de uma vista.
 * Vive fora do React porque tem de ser testável com promises adiadas, sem DOM
 * (o package não tem jsdom) — é o mesmo padrão do `orquestradorUsb`.
 *
 * Os estados que existiam antes deste módulo e a mentira que cada um produzia:
 *  · o efeito partia de `state: null` em CADA abertura → a reabertura repedia
 *    e a primeira pintura era "Não verificado" com uma leitura a caminho — o
 *    flicker NÃO VERIFICADO → ATIVO que o utilizador viu;
 *  · não havia estado de pedido em voo: dois `open` próximos disparavam duas
 *    consultas, e a `cancelado` da primeira deitava fora a resposta dela;
 *  · sem bridge (`window.electronAPI` ausente) o encadeamento opcional
 *    CURTO-CIRCUITA a expressão inteira — nem `.then` nem `.catch` correm.
 *    O bug não é um crash: é a ausência silenciosa, nenhum estado, nenhum
 *    pedido, "Não verificado" para sempre sem frase própria;
 *  · uma resposta que chegava depois de o dialog fechar era deitada fora, e a
 *    reabertura começava do zero.
 *
 * REGRA: nenhuma frase aqui afirma algo sobre o Windows sem uma leitura real.
 * "Desativado" só existe no ramo `lido` com `enabled: false`. Nunca se escreve
 * no estado do sistema — este módulo só lê.
 */

export type FaseLeituraFirewall = "a_consultar" | "lido" | "erro";

export interface EstadoLeituraFirewall {
  fase: FaseLeituraFirewall;
  /**
   * Última leitura REAL. Sobrevive a fecho/reabertura precisamente para a
   * vista não regredir para "Não verificado" enquanto mostra uma leitura
   * que já tem. `erro` conserva a leitura anterior: falhou a RENOVAÇÃO, não
   * se apaga o que foi medido.
   */
  leitura: WindowsFirewallState | null;
  /** Motivo da última falha, ou da ausência de bridge. */
  motivo: string | null;
}

export interface LeitorFirewallDeps {
  /**
   * `windows.getWindowsHealth`, ou `null` quando a janela não tem bridge.
   * `null` é um estado próprio, não uma falha de consulta.
   */
  obterEstado?: (() => Promise<WindowsHealthSnapshot>) | null;
  aoEstado: (estado: EstadoLeituraFirewall) => void;
}

export interface LeitorFirewall {
  /**
   * Chamar em CADA abertura do dialog. Revalida por abertura — NÃO é cache
   * one-shot: com leitura confirmada a reabertura volta a pedir, mas a
   * leitura anterior fica VISÍVEL durante o pedido («a tentar atualizar»), o
   * in-flight é coalescido (um pedido em voo, não dois), e nenhuma fase fora
   * de `lido` apresenta a leitura como certeza do presente.
   */
  garantirLeitura(): void;
  /** Desmontagem: nenhuma resposta em voo escreve depois daqui. */
  desmontar(): void;
  /**
   * React StrictMode (ativo em main.tsx) faz setup→cleanup→setup na mesma
   * instância de componente: o `ref` sobrevive, logo um `desmontar()`
   * permanente mataria o leitor para sempre no dev. `reativar()` é chamado
   * pelo setup do efeito de montagem: a instância volta a poder consultar, e
   * a geração sobe — o que estivesse em voo da montagem anterior continua
   * calado. Reativação nunca repõe leituras nem fabrica estados.
   */
  reativar(): void;
  /**
   * Há ponte para consultar? A primeira pintura do dialog PRECISA disto:
   * `renderToStaticMarkup` não corre efeitos, e o P0 do fecho quer que a
   * primeira pintura REAL, COM bridge, diga «A verificar…» antes do efeito —
   * porque o efeito vai partir exatamente esse pedido. Sem bridge a primeira
   * pintura é o não-iniciado «Não verificado» (frase do packet, pin ws-b).
   */
  temPonte(): boolean;
  estado(): EstadoLeituraFirewall | null;
}

function firewallDaResposta(bruto: unknown): WindowsFirewallState | null {
  if (!bruto || typeof bruto !== "object") return null;
  const firewall = (bruto as { firewall?: unknown }).firewall;
  if (!firewall || typeof firewall !== "object") return null;
  const f = firewall as { available?: unknown; enabled?: unknown; profiles?: unknown };
  if (f.available !== true && f.available !== false) return null;
  // `{ available: true }` sem `enabled`/`profiles` não é uma leitura: é o
  // envelope partido. Não se pinta "Não verificado" como se tivesse resposta.
  if (f.available === true && (typeof f.enabled !== "boolean" || !Array.isArray(f.profiles))) return null;
  return firewall as WindowsFirewallState;
}

export function criarLeitorFirewall(deps: LeitorFirewallDeps): LeitorFirewall {
  const obterEstado = deps.obterEstado ?? null;
  let estado: EstadoLeituraFirewall | null = null;
  let emVoo = false;
  let parado = false;
  let geracao = 0;

  function emitir(): void {
    if (estado && !parado) deps.aoEstado(estado);
  }

  return {
    garantirLeitura() {
      if (parado) return;
      if (!obterEstado) {
        estado = { fase: "erro", leitura: null, motivo: "sem_bridge" };
        emitir();
        return;
      }
      if (emVoo) return;
      geracao += 1;
      const geracaoPedido = geracao;
      emVoo = true;
      estado = { fase: "a_consultar", leitura: estado?.leitura ?? null, motivo: null };
      emitir();
      Promise.resolve()
        .then(() => obterEstado())
        .then((bruto) => {
          if (parado || geracaoPedido !== geracao) return;
          const leitura = firewallDaResposta(bruto);
          if (!leitura) {
            // envelope ilegível NÃO apaga a última leitura real: conserva-a e
            // diz explicitamente que esta tentativa não é reconhecível.
            estado = { fase: "erro", leitura: estado?.leitura ?? null, motivo: "resposta_ilegivel" };
            return;
          }
          estado = { fase: "lido", leitura, motivo: null };
        })
        .catch(() => {
          if (parado || geracaoPedido !== geracao) return;
          estado = { fase: "erro", leitura: estado?.leitura ?? null, motivo: "falha_consulta" };
        })
        .finally(() => {
          if (parado || geracaoPedido !== geracao) return;
          emVoo = false;
          emitir();
        });
    },
    desmontar() {
      parado = true;
      geracao += 1;
      // A cadeia em voo foi invalidada pela geração acima; o seu `finally`
      // não corre por ela. Sem isto, um `reativar()` ficava para sempre
      // preso num `emVoo` que já não existe.
      emVoo = false;
    },
    reativar() {
      // React StrictMode setup→cleanup→setup na MESMA instância: reabrir a
      // escrita sem perder a leitura conservada. Respostas da geração anterior
      // já foram deitadas fora pelo bump de `desmontar()`.
      parado = false;
    },
    temPonte() {
      return obterEstado !== null;
    },
    estado() {
      return estado;
    },
  };
}

export interface CopiaChipFirewall {
  /** Eixo de CORREÇÃO do chip: só `active`/`inactive` vêm de leitura real. */
  status: "active" | "inactive" | "desconhecido" | "a_consultar";
  texto: string;
  detalhe: string;
  temLeitura: boolean;
}

/**
 * A única matriz de copy do chip. Cada frase existe porque há um estado de
 * leitura por trás dela — e nenhum ramo fora de `lido` pode dizer
 * "desligado". `a_consultar` SEM leitura anterior ainda não sabe de nada:
 * diz que está a consultar, não afirma "Não verificado" como resposta final.
 */
export function copyEstadoLeituraFirewall(estado: EstadoLeituraFirewall | null): CopiaChipFirewall {
  if (!estado) {
    return { status: "desconhecido", texto: "Não verificado", detalhe: WINDOWS_FIREWALL_UNKNOWN_DETAIL, temLeitura: false };
  }
  if (estado.fase === "lido" && estado.leitura) {
    const win = windowsFirewallDisplay(estado.leitura);
    return { status: win.status === "unknown" ? "desconhecido" : win.status, texto: win.text, detalhe: win.detail, temLeitura: win.status !== "unknown" };
  }
  if (estado.fase === "a_consultar" && estado.leitura) {
    const win = windowsFirewallDisplay(estado.leitura);
    return {
      status: win.status === "unknown" ? "desconhecido" : win.status,
      texto: win.text,
      detalhe: `${win.detail} — última leitura conhecida, a atualizar; o estado presente ainda não está confirmado.`,
      temLeitura: win.status !== "unknown",
    };
  }
  if (estado.fase === "a_consultar") {
    return {
      status: "a_consultar",
      texto: "A verificar…",
      detalhe: "O CyberSafe está a verificar o estado do Firewall do Windows nesta vista.",
      temLeitura: false,
    };
  }
  // ERRO COM LEITURA ANTERIOR: a leitura conservada é sempre mostrada COM a
  // ressalva da tentativa actual — nunca «ATIVO» liso como se fosse o presente.
  if (estado.leitura) {
    const win = windowsFirewallDisplay(estado.leitura);
    const ressalva =
      estado.motivo === "resposta_ilegivel"
        ? "a tentativa mais recente respondeu com um envelope que a app não sabe ler"
        : "a tentativa de atualização não respondeu";
    return {
      status: win.status === "unknown" ? "desconhecido" : win.status,
      texto: win.text,
      detalhe: `${win.detail} — ${ressalva}; a leitura mostrada é a última conhecida, não o estado atual confirmado.`,
      temLeitura: win.status !== "unknown",
    };
  }
  if (estado.motivo === "sem_bridge") {
    return {
      status: "desconhecido",
      texto: "Não verificado",
      detalhe: "Esta janela não tem acesso à consulta do estado do Firewall do Windows.",
      temLeitura: false,
    };
  }
  if (estado.motivo === "resposta_ilegivel") {
    return {
      status: "desconhecido",
      texto: "Não foi possível verificar",
      detalhe: "O serviço respondeu, mas sem um estado reconhecível do Firewall do Windows nesta vista.",
      temLeitura: false,
    };
  }
  return {
    status: "desconhecido",
    texto: "Não foi possível verificar",
    detalhe: "Não foi possível verificar o estado do Firewall do Windows nesta vista.",
    temLeitura: false,
  };
}

/**
 * A pintura ANTES de qualquer efeito, do componente real. Com ponte, o
 * `useEffect` de abertura vai partir exatamente este pedido — dizer outra
 * coisa seria esconder o que está a acontecer; sem ponte não há pedido
 * nenhum, e o único estado honesto continua a ser o não-iniciado.
 */
export function copiaPrimeiraPintura(temPonte: boolean): CopiaChipFirewall {
  return temPonte
    ? copyEstadoLeituraFirewall({ fase: "a_consultar", leitura: null, motivo: null })
    : copyEstadoLeituraFirewall(null);
}
