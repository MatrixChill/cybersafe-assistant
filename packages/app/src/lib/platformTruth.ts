/**
 * Verdades de plataforma para o texto de ecrã.
 *
 * Duas frases do produto afirmam mecanismos que só existem num sistema:
 * «Camada de Contenção de Rede» (a contenção é o WFP do Windows; no Linux Lite
 * não bloqueamos ligações) e «Proteção em tempo real» no onboarding (aí o
 * mecanismo é uma consulta periódica, não uma vigilância contínua). Ditas numa
 * máquina onde não há mecanismo, são a mesma classe de defeito que já apanhámos
 * em «Análise em Tempo Real» — um título que promete o que o motor não faz.
 *
 * A plataforma vem do serviço (`hardware.system.platform`, o `osInfo()` do
 * `systeminformation`), nunca do aspeto dos caminhos nem de um `process.platform`
 * que o renderer isolado não tem. Sem publicação, nada se reescreve: as frases
 * ficam como estão, porque reescrevê-las por suposição seria inventar.
 */

export type PlataformaPublicada = "windows" | "linux" | "desconhecida";

export function plataformaPublicada(plataforma: string | null | undefined): PlataformaPublicada {
  if (typeof plataforma !== "string") return "desconhecida";
  const p = plataforma.trim().toLowerCase();
  if (p === "linux") return "linux";
  if (p.startsWith("windows")) return "windows";
  return "desconhecida";
}

export interface CopyCamadaDeRede {
  titulo: string;
  nota: string;
}

/**
 * A reescrita do bloco de rede, só quando a máquina é Linux. `null` diz «a
 * frase escrita pelo produto mantém-se» — é o que acontece em Windows, onde a
 * contenção existe, e em qualquer plataforma não publicada, onde não se sabe.
 * Devolver a cópia de Windows daqui seria ter a mesma frase em dois sítios.
 */
export function camadaDeRedeLinux(plataforma: string | null | undefined): CopyCamadaDeRede | null {
  if (plataformaPublicada(plataforma) !== "linux") return null;
  return {
    titulo: "Ligações de rede observadas",
    nota: "observação; esta versão não bloqueia ligações",
  };
}

export interface CopyProtecao {
  title: string;
  description: string;
}

/**
 * A reescrita da primeira página do onboarding — a que nomeia o mecanismo de
 * proteção. Em Linux não há vigilância contínua nem contenção, por isso a
 * frase escrita para o Windows não pode ser dita tal e qual.
 */
export function protecaoLinux(plataforma: string | null | undefined): CopyProtecao | null {
  if (plataformaPublicada(plataforma) !== "linux") return null;
  return {
    title: "Proteção em segundo plano",
    description:
      "O CyberSafe lê o estado do teu computador — processos, espaço em disco e os motores de análise disponíveis — e mostra o que encontrou. Não bloqueia ficheiros nem ligações por iniciativa própria.",
  };
}
