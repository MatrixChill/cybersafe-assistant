/** Diagnóstico desde o início do processo. recovered conta admissões, não análises. */
export interface RealtimeRecoverySnapshot {
  metadataRejections: number; analysisRejections: number;
  pending: number; running: boolean; recovered: number; exhausted: number;
  expired: number; dropped: number; suppressed: number; cancelled: number;
  distinctPaths: number; pathsCapped: boolean; affectedPaths: string[];
  lastEventAt: string | null; lastStage: "metadata" | "analysis" | null; lastEventId: number;
  metadataInFlight: number; analysisQueueDepth: number;
}
