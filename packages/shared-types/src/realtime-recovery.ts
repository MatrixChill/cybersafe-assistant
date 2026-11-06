/** Diagnóstico desde o início do processo. recovered conta admissões, não análises. */
export interface RealtimeRecoverySnapshot {
  metadataRejections: number; analysisRejections: number;
  pending: number; running: boolean; recovered: number; exhausted: number;
  expired: number; dropped: number; suppressed: number; cancelled: number;
  distinctPaths: number; pathsCapped: boolean; affectedPaths: string[];
  lastEventAt: string | null; lastStage: "metadata" | "analysis" | null; lastEventId: number;
  metadataInFlight: number; analysisQueueDepth: number;
  /**
   * Desfecho por caminho afetado (opcional: serviços antigos não publicam).
   * `recovered` acima conta ADMISSÕES recuperadas. Só `analysisConfirmed`
   * significa versão atual analisada com veredicto.
   *  - waiting: rejeitado, repetição agendada;
   *  - unrecovered: nenhuma versão admitida (largado/expirado/esgotado/teto);
   *  - analysisPending: versão admitida, análise por concluir;
   *  - inconclusive: análise sem veredicto;
   *  - versionUnconfirmed: o ficheiro mudou depois da versão analisada.
   */
  waiting?: number; unrecovered?: number; analysisPending?: number; analysisConfirmed?: number;
  inconclusive?: number; versionUnconfirmed?: number; trackedCapped?: boolean;
  /** Afetados que deixaram de existir antes da análise (informativo, não é lacuna). */
  removed?: number;
}
