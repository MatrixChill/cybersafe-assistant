import type {
  DefinitionsSourceState,
  DefinitionsSourceStatus,
  DefinitionsStatus,
} from "@cybersafe/shared-types";

/**
 * Apresentação do estado das definições de segurança, por fonte.
 *
 * Duas regras que este ficheiro existe para respeitar, ambas aprendidas com
 * defeitos embarcados noutros lados do produto:
 *
 *  1. **Um eixo por cada facto.** «Instalado» não é «operacional», e
 *     «desactualizado» não é «indisponível». Por isso os cinco estados do
 *     serviço chegam aqui distinctos e não são colapsados numa cor.
 *  2. **Nada mostra 0 quando não foi medido.** `itensCarregados === null` é
 *     «—», nunca «0»: zero assinaturas lidas é uma afirmação sobre o mundo, e o
 *     serviço não a fez.
 *
 * O `ultimoErro` do serviço **não é ecoado**. Um erro de transporte pode conter
 * URL, caminho ou chave; é classificado em categoria e apresentada a categoria.
 * (Mesma razão que `definitionUpdateResult.ts` já aplica.)
 */

const ROTULOS: Record<DefinitionsSourceState, string> = {
  actualizado: "Atualizado",
  desactualizado: "Desatualizado",
  degradado: "Degradado",
  indisponivel: "Indisponível",
  nunca_verificado: "Nunca verificado",
};

const NOMES: Record<DefinitionsSourceStatus["fonte"], string> = {
  clamav: "ClamAV",
  yara: "YARA",
  hashes: "Base de hashes",
};

/** Severidade visual: apenas `degradado`/`indisponivel`/`desactualizado` chamam a atenção. */
const SEVERIDADES: Record<DefinitionsSourceState, "ok" | "atencao" | "critico"> = {
  actualizado: "ok",
  desactualizado: "atencao",
  degradado: "atencao",
  indisponivel: "atencao",
  // Ausência de leitura não é evidência de falha: não escala.
  nunca_verificado: "ok",
};

/**
 * Categorias de causa, derivadas do texto do serviço sem o reproduzir.
 * Ordem importa: a primeira correspondência ganha.
 */
function categoriaDaCausa(erro: string | null): string | null {
  if (!erro) return null;
  if (/sem chave|missing api key/i.test(erro)) return "chave de acesso não configurada";
  if (/recusada|bad auth|unauthorized/i.test(erro)) return "chave de acesso recusada";
  if (/429|limite de pedidos|exceeding rate/i.test(erro)) return "limite de pedidos do fornecedor";
  if (/ECONNREFUSED|ENOTFOUND|sem ligação|interrompid|timeout/i.test(erro)) return "sem ligação ao fornecedor";
  if (/não é JSON|não reconhecido|Malformed|data não é/i.test(erro)) return "resposta do fornecedor não utilizável";
  return "falha não catalogada";
}

function tempo(ms: number | null, agora: number): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "—";
  const diff = Math.max(0, agora - ms);
  const minutos = Math.round(diff / 60000);
  if (minutos < 1) return "agora mesmo";
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.round(minutos / 60);
  if (horas < 48) return `há ${horas} h`;
  return `há ${Math.round(horas / 24)} d`;
}

function quando(ms: number, agora: number): string {
  const diff = ms - agora;
  if (diff <= 0) return "na próxima verificação";
  const minutos = Math.round(diff / 60000);
  if (minutos < 60) return `em ~${minutos} min`;
  return `em ~${Math.round(minutos / 60)} h`;
}

export interface LinhaDefinicoes {
  fonte: DefinitionsSourceStatus["fonte"];
  nome: string;
  rotulo: string;
  severidade: "ok" | "atencao" | "critico";
  /** Uma linha por fonte, pronta a renderizar; nunca contém texto do transporte. */
  texto: string;
}

export function linhaDasDefinicoes(f: DefinitionsSourceStatus, agora: number): LinhaDefinicoes {
  const carregados =
    f.itensCarregados === null
      ? "contagem não medida"
      : f.fonte === "hashes"
        ? `${f.itensCarregados} assinaturas de hash carregadas`
        : `${f.itensCarregados} ficheiros de base`;
  const causa = categoriaDaCausa(f.ultimoErro);
  const partes = [
    `última tentativa ${tempo(f.ultimaTentativaAtMs, agora)}`,
    f.ultimaBemSucedidaAtMs
      ? `última atualização bem sucedida ${tempo(f.ultimaBemSucedidaAtMs, agora)}`
      : "sem atualização bem sucedida registada",
    carregados,
    quando(f.proximaVerificacaoAtMs, agora),
  ];
  if (causa) partes.push(`causa: ${causa} (${f.tentativasConsecutivas} tentativa(s) consecutiva(s))`);
  return {
    fonte: f.fonte,
    nome: NOMES[f.fonte],
    rotulo: ROTULOS[f.estado],
    severidade: SEVERIDADES[f.estado],
    texto: `${NOMES[f.fonte]} — ${ROTULOS[f.estado]} · ${partes.join(" · ")}`,
  };
}

export function linhasDasDefinicoes(status: DefinitionsStatus | null | undefined, agora = Date.now()): LinhaDefinicoes[] {
  if (!status || !Array.isArray(status.fontes)) return [];
  return status.fontes
    .filter((f): f is DefinitionsSourceStatus => !!f && typeof f.fonte === "string" && f.fonte in NOMES && f.estado in ROTULOS)
    .map((f) => linhaDasDefinicoes(f, agora));
}

/**
 * Pior severidade entre fontes — e sem afirmação de proteção: nenhuma linha
 * «ok» diz que o PC está protegido, diz que aquela base está ao dia.
 */
export function resumoDasDefinicoes(
  status: DefinitionsStatus | null | undefined,
  agora = Date.now(),
): { severidade: "ok" | "atencao" | "critico"; linhas: LinhaDefinicoes[]; texto: string } {
  const linhas = linhasDasDefinicoes(status, agora);
  if (linhas.length === 0) {
    return {
      severidade: "ok",
      linhas,
      texto: "O serviço não devolveu estado das definições. Nada é afirmado sobre as bases.",
    };
  }
  const severidade = linhas.some((l) => l.severidade === "critico")
    ? "critico"
    : linhas.some((l) => l.severidade === "atencao")
      ? "atencao"
      : "ok";
  return { severidade, linhas, texto: linhas.map((l) => l.texto).join("\n") };
}
