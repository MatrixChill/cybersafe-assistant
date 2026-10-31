/**
 * Fases da análise — a composição `.phase-list` do laboratório
 * (`v2/src/SecurityPages.tsx`, `Scanner`), com dados do produto.
 *
 * Diferença deliberada em relação ao lab, e corrigida na revisão de 20:30:
 *  · o lab avança as fases por um temporizador de demonstração (`progress >=
 *    i*25`). O produto emite `ScanState.phase`, que é a palavra do motor, e
 *    `progress` à parte;
 *  · **nada é inferido**. Uma fase só se apresenta como atual quando o motor a
 *    comunica naquele instante. Um estado terminal não prova que as fases
 *    anteriores tenham decorrido (`failed` pode chegar em `finalizing` antes de
 *    qualquer trabalho, e um cancelamento em fila não tem fase nenhuma), e uma
 *    fase atual não prova que as anteriores tenham sido percorridas — o snapshot
 *    não tem histórico. Portanto: sem `Check` de «concluída», sem «tudo verde».
 *  · com `phase` ausente (serviço antigo / não comunicada) diz-se isso mesmo, e
 *    a frase sobre a percentagem só afirma percentagem quando ela é um número.
 */
import type { ScanPhase } from "@cybersafe/shared-types";

/** Ordem do contrato `ScanPhase` em `shared-types`. */
export const FASES: { fase: ScanPhase; nome: string }[] = [
  { fase: "preparing", nome: "Preparar análise" },
  { fase: "gathering", nome: "Recolher ficheiros" },
  { fase: "scanning", nome: "Analisar" },
  { fase: "finalizing", nome: "Fechar relatório" },
];

const ORDEM: Record<ScanPhase, number> = {
  preparing: 0,
  gathering: 1,
  scanning: 2,
  finalizing: 3,
};

/**
 * A única coisa que um snapshot prova: qual é a fase que o motor comunica
 * AGORA. Estados terminais (`completed`/`failed`/`cancelled`) não são prova de
 * passagem por fase nenhuma — `failed` pode chegar sem nada ter sido analisado
 * e um cancelamento em fila chega sem fase.
 */
export function faseAtual(alvo: ScanPhase, phase: ScanPhase | undefined): boolean {
  return phase !== undefined && phase === alvo;
}

/** Percentagem só é afirmada se o número chegou válido. */
export function percentagemValida(progress: number): boolean {
  return Number.isFinite(progress) && progress >= 0 && progress <= 100;
}

export function ScanPhaseList({
  phase,
  status,
  progress,
}: {
  phase: ScanPhase | undefined;
  status: string;
  progress: number;
}) {
  const valida = percentagemValida(progress);
  const terminada = status === "completed" || status === "failed" || status === "cancelled";
  return (
    <div
      className="phase-list"
      data-fase={phase ?? "nao-comunicada"}
      data-estado={status}
      data-fases-inferidas="false"
    >
      {FASES.map(({ fase, nome }) => {
        const atual = faseAtual(fase, phase);
        return (
          <span
            key={fase}
            className={atual ? "current" : ""}
            data-fase-alvo={fase}
            data-atual={atual ? "true" : "false"}
          >
            <span>{atual ? "•" : ORDEM[fase] + 1}</span>
            {nome}
          </span>
        );
      })}
      {valida && <span className="mono">{Math.round(progress)}%</span>}
      {!phase && (
        <p className="caption" role="status">
          {valida
            ? "O serviço não comunica em que fase está; apenas a percentagem recebida é afirmada."
            : terminada
              ? "O serviço não comunicou as fases desta análise, nem uma percentagem válida. Nada é concluído sobre o que aconteceu."
              : "O serviço não comunicou a fase nem uma percentagem válida. Nada é afirmado sobre o progresso."}
        </p>
      )}
      {phase && !valida && (
        <p className="caption" role="status">
          Fase comunicada: {nomeDe(phase)}. Percentagem não recebida — não é desenhada.
        </p>
      )}
    </div>
  );
}

function nomeDe(phase: ScanPhase): string {
  return FASES.find((f) => f.fase === phase)?.nome ?? phase;
}
