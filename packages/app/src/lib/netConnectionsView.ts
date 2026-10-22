/**
 * Apresentação das conexões TCP do PC Center.
 *
 * ── O QUE FOI MEDIDO (15/10, nesta máquina, leitura real e read-only) ──────
 *
 * A fonte é `Get-NetTCPConnection | Select-Object … | ConvertTo-Json` e o
 * PowerShell serializa o enum `State` como **número**. Correlacionando o nome
 * com o número (`Group-Object State` vs `Group-Object { [int]$_.State }`):
 *
 *   Bound   x70  → 100      Established x66 → 5
 *   Listen  x49  → 2        TimeWait    x22 → 11
 *   CloseWait x1 → 8
 *
 * É este o mapa real do MIB_TCP_STATE — incluindo **100 = Bound**, o valor mais
 * frequente nesta máquina e que não existia em nenhum mapa do produto. Era por
 * isso que a coluna «Estado» mostrava um número solto («100») a quem olhava
 * para a tabela: não havia tradução e o código cru era impresso como se fosse
 * um estado.
 *
 * ⚠️ O mapa numérico de `packages/native-windows/src/index.ts` está DESALINHADO
 * (diz 1→Listen, 2→SynSent, 5→FinWait1, 12→Bound): nenhum desses pares
 * corresponde ao medido. Esse ficheiro é de outra lane (Kilo) e não foi tocado
 * — está reportado no handback.
 *
 * Regra de honestidade desta camada: um código que não esteja no mapa NÃO ganha
 * significado inventado nem é apresentado como estado. Mostra-se
 * «Desconhecido» e o código cru fica apenas como evidência secundária, em
 * tooltip. Nada aqui é formatado como percentagem.
 */

/** Nome canónico (como a fonte o devolve em algumas versões) → PT-PT. */
export const TCP_ESTADO_PT: Record<string, string> = {
  Closed: "Fechada",
  Listen: "À escuta",
  SynSent: "A conectar",
  SynReceived: "A conectar",
  Established: "Estabelecida",
  FinWait1: "A fechar",
  FinWait2: "A fechar",
  CloseWait: "Aguarda fecho",
  Closing: "A fechar",
  LastAck: "Último reconhecimento",
  TimeWait: "Em espera de fecho",
  DeleteTcb: "A remover",
  // 100 na fonte. A tomada está associada à porta local mas ainda não escuta
  // nem tem par — o nome canónico vai no tooltip, para não inventar semântica.
  Bound: "Porta reservada",
};

/** Código numérico REAL da fonte → nome canónico. Medido, não suposto. */
const TCP_ESTADO_POR_CODIGO: Record<string, string> = {
  "1": "Closed",
  "2": "Listen",
  "3": "SynSent",
  "4": "SynReceived",
  "5": "Established",
  "6": "FinWait1",
  "7": "FinWait2",
  "8": "CloseWait",
  "9": "Closing",
  "10": "LastAck",
  "11": "TimeWait",
  "12": "DeleteTcb",
  "100": "Bound",
};

/** Nome canónico em minúsculas → nome canónico (aceita qualquer capitalização). */
const TCP_ESTADO_POR_NOME: Record<string, string> = Object.fromEntries(
  Object.keys(TCP_ESTADO_PT).map((nome) => [nome.toLowerCase(), nome]),
);

export const ESTADO_DESCONHECIDO = "Desconhecido";

export interface EstadoTcp {
  /** O que se escreve na coluna. Nunca um número solto. */
  label: string;
  /** Nome canónico do estado, quando reconhecido. `null` = não reconhecido. */
  canonico: string | null;
  /** Código cru da fonte — só para evidência secundária (tooltip). */
  codigoCru: string | null;
}

function desconhecido(codigoCru: string | null): EstadoTcp {
  return { label: ESTADO_DESCONHECIDO, canonico: null, codigoCru };
}

function porCodigo(codigo: string): EstadoTcp {
  const canonico = TCP_ESTADO_POR_CODIGO[codigo];
  if (!canonico) return desconhecido(codigo);
  return { label: TCP_ESTADO_PT[canonico], canonico, codigoCru: codigo };
}

/**
 * Traduz o `state` que vem do snapshot. Aceita o número (como o PowerShell o
 * serializa) ou o nome do enum (como algumas versões o devolvem). Qualquer
 * outra coisa é «Desconhecido» — e o valor cru não se perde, vai para tooltip.
 */
export function estadoTcp(raw: unknown): EstadoTcp {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return desconhecido(String(raw));
    return porCodigo(String(Math.trunc(raw)));
  }
  if (typeof raw === "string") {
    const texto = raw.trim();
    if (texto === "") return desconhecido(null);
    if (/^\d+$/.test(texto)) return porCodigo(String(Number(texto)));
    const canonico = TCP_ESTADO_POR_NOME[texto.toLowerCase()];
    if (canonico) return { label: TCP_ESTADO_PT[canonico], canonico, codigoCru: texto };
    return desconhecido(texto);
  }
  return desconhecido(null);
}

/**
 * Texto de tooltip para o estado. Só existe quando há algo mais a dizer do que
 * o rótulo: código não reconhecido (evidência) ou nome canónico da fonte.
 */
export function estadoTcpTitle(estado: EstadoTcp): string | undefined {
  if (!estado.canonico) {
    return estado.codigoCru === null
      ? "A fonte não devolveu estado para esta ligação."
      : `Estado não reconhecido: a fonte devolveu o código ${estado.codigoCru}.`;
  }
  return `Estado devolvido pela fonte: ${estado.canonico}`;
}

function portaLegivel(porta: unknown): number | null {
  if (typeof porta === "number") return Number.isFinite(porta) ? Math.trunc(porta) : null;
  if (typeof porta === "string" && /^\d+$/.test(porta.trim())) return Number(porta.trim());
  return null;
}

/**
 * `endereço:porta` legível.
 *  · IPv6 com `:` ganha parênteses rectos — `::1:443` não se lê;
 *  · ausente é «—», nunca `0` nem `undefined`;
 *  · porta 0 ou ausente não se escreve: `:0` não é uma porta medida.
 */
export function formatEndpoint(address: unknown, porta: unknown): string {
  const endereco = typeof address === "string" ? address.trim() : "";
  const p = portaLegivel(porta);
  if (!endereco && (p === null || p <= 0)) return "—";
  const host = endereco ? (endereco.includes(":") ? `[${endereco}]` : endereco) : "—";
  if (p === null || p <= 0) return host;
  return `${host}:${p}`;
}

/**
 * Extremo remoto. Uma tomada à escuta ou apenas reservada **não tem par**: o
 * `0.0.0.0:0` que a fonte devolve é a ausência de par, não um destino. Só se
 * afirma isso quando o estado é reconhecido — com estado desconhecido mostram-se
 * os dados crus, sem interpretação.
 */
export function formatRemote(estado: EstadoTcp, address: unknown, porta: unknown): string {
  if (estado.canonico === "Listen" || estado.canonico === "Bound") return "—";
  return formatEndpoint(address, porta);
}

/**
 * Nome do processo dono. Sem nome, o PID ainda é informação real: diz-se
 * «PID 1234» em vez de o esconder; sem nada, «—».
 */
export function formatOwningProcess(nome: unknown, pid: unknown): string {
  const n = typeof nome === "string" ? nome.trim() : "";
  if (n) return n;
  const p = typeof pid === "number" && Number.isFinite(pid) ? Math.trunc(pid) : null;
  if (p !== null && p > 0) return `PID ${p}`;
  return "—";
}
