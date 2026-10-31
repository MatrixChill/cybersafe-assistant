/**
 * TP-AUTO-02 · explicações locais do PROCESSO SELECIONADO (modelo puro).
 *
 * Regras do review:
 *  - Só factos MEDIDOS; ausência é `desconhecido` com motivo.
 *  - NUNCA se valida/descarta dado do utilizador por palavra: o guard de malware
 *    corre apenas sobre texto AUTORAL deste módulo, nunca sobre nome/caminho.
 *  - Sem duplicar a guidance existente: criticalidade/proteção vem de fora
 *    (`isProtectedProcess` no call-site); aqui não há lista de nomes.
 *  - Sem `signer`: este incremento não apresenta assinante; `signatureStatus` não
 *    é assinante e não é mapeado.
 *  - Sem hipóteses de "anormal": não há baseline nem duração nesta amostra.
 *  - `startedAt` inválido/no futuro não vira idade; fica desconhecido.
 */

export type Certeza = "medido" | "desconhecido";

export interface Facto {
  id: string;
  rotulo: string;
  valor: string | number | null;
  unidade: string | null;
  certeza: Certeza;
  motivo?: string;
}

export interface Risco {
  id: string;
  descricao: string;
  reversibilidade: string;
}

export interface Matriz {
  disponivel: false;
  requerConsentimento: true;
  estado: "NAO_ATIVADA";
  nota: string;
}

export interface ExplicacoesProcesso {
  alvo: { nome: string; pid: number } | null;
  fatos: Facto[];
  riscos: Risco[];
  avisos: string[];
  matriz: Matriz;
}

export interface ProcessoMedido {
  pid?: number | null;
  ppid?: number | null;
  name?: string | null;
  path?: string | null;
  cpu?: number | null;
  memoryMb?: number | null;
  startedAt?: string | null;
}

const ASSOCIACAO_MALWARE = /\bmalware\b|\bv[ií]rus\b|infetad|infe[cç][aã]o|ransomware|trojan|cavalo de tr[oó]ia/i;

/** Guard aplicado SÓ a texto autoral (nunca a nome/caminho do utilizador). */
export function textoAtribuiMalware(texto: string): boolean {
  return ASSOCIACAO_MALWARE.test(String(texto ?? ""));
}

const num = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

const AVISOS_AUTORAIS = [
  "Estas explicações descrevem o que foi medido; não identificam intenção nem reputação do processo.",
  "Esta vista não encerra processos nem altera prioridades. Nenhuma ação é executada a partir daqui.",
];

const RISCOS: Risco[] = [
  {
    id: "encerrar.perda",
    descricao: "Encerrar um processo pode perder trabalho não guardado e interromper serviços.",
    reversibilidade: "Não garantida: guardar primeiro; reabrir a aplicação não recupera o estado perdido.",
  },
  {
    id: "sem.acao",
    descricao: "Esta vista é só explicativa; não encerra, não suspende e não altera prioridades.",
    reversibilidade: "Nenhuma alteração é feita.",
  },
];

function matriz(): Matriz {
  return {
    disponivel: false,
    requerConsentimento: true,
    estado: "NAO_ATIVADA",
    nota: "MATRIX é uma opção consentida e futura; não está ligada e nada é enviado sem consentimento explícito.",
  };
}

function inicioValido(iso: string | null | undefined, agoraMs: number): { iso: string; idadeMin: number } | null {
  if (typeof iso !== "string" || iso.trim() === "") return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  if (t > agoraMs + 60_000) return null; // futuro: relógio/valor inválido
  return { iso, idadeMin: Math.max(0, Math.round((agoraMs - t) / 60_000)) };
}

export function buildExplicacoesProcesso({ processo, agoraMs = Date.now() }: { processo: ProcessoMedido | null; agoraMs?: number }): ExplicacoesProcesso {
  // Guard só do texto autoral; nada aqui depende do nome/caminho do utilizador.
  const autoral = [...AVISOS_AUTORAIS, ...RISCOS.map((r) => r.descricao + " " + r.reversibilidade), matriz().nota].join(" ");
  if (textoAtribuiMalware(autoral)) {
    throw new Error("TEXTO_ASSOCIA_MALWARE: o gerador produziu uma associação proibida pelo contrato");
  }

  const p = processo;
  if (!p || !num(p.pid) || !p.name) {
    return {
      alvo: null,
      fatos: [],
      riscos: RISCOS,
      avisos: [...AVISOS_AUTORAIS, "Sem processo selecionado ou sem identidade medida (nome+PID)."],
      matriz: matriz(),
    };
  }

  const inicio = inicioValido(p.startedAt, agoraMs);
  const fatos: Facto[] = [
    { id: "proc.nome", rotulo: "Nome", valor: String(p.name), unidade: null, certeza: "medido" },
    { id: "proc.pid", rotulo: "PID", valor: p.pid, unidade: null, certeza: "medido" },
    num(p.ppid) && p.ppid > 0
      ? { id: "proc.ppid", rotulo: "Processo pai", valor: p.ppid, unidade: "PID", certeza: "medido" }
      : { id: "proc.ppid", rotulo: "Processo pai", valor: null, unidade: null, certeza: "desconhecido", motivo: "PID do pai não medido" },
    num(p.cpu)
      ? { id: "proc.cpu", rotulo: "CPU", valor: Math.round(p.cpu * 10) / 10, unidade: "%", certeza: "medido" }
      : { id: "proc.cpu", rotulo: "CPU", valor: null, unidade: "%", certeza: "desconhecido", motivo: "sem leitura de CPU nesta amostra" },
    num(p.memoryMb)
      ? { id: "proc.ram", rotulo: "RAM", valor: Math.round(p.memoryMb), unidade: "MB", certeza: "medido" }
      : { id: "proc.ram", rotulo: "RAM", valor: null, unidade: "MB", certeza: "desconhecido", motivo: "sem leitura de memória nesta amostra" },
    inicio
      ? { id: "proc.inicio", rotulo: "Início", valor: `${inicio.iso} · há ${inicio.idadeMin} min`, unidade: null, certeza: "medido" }
      : { id: "proc.inicio", rotulo: "Início", valor: null, unidade: null, certeza: "desconhecido", motivo: "instante inválido ou no futuro" },
    typeof p.path === "string" && p.path.trim()
      ? { id: "proc.caminho", rotulo: "Caminho", valor: p.path, unidade: null, certeza: "medido" }
      : { id: "proc.caminho", rotulo: "Caminho", valor: null, unidade: null, certeza: "desconhecido", motivo: "caminho não publicado" },
  ];

  return {
    alvo: { nome: String(p.name), pid: Number(p.pid) },
    fatos,
    riscos: RISCOS,
    avisos: [...AVISOS_AUTORAIS, "Assinatura/editor não é apresentada nesta secção; não se infere identidade."],
    matriz: matriz(),
  };
}

export const VERSAO_MODELO_PROCESSOS = "process-explanations-v2";

