interface HealthEvent {
  severity: string;
  summary?: string;
  data?: unknown;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function engineHealthPresentation(event: HealthEvent) {
  const data = isRecord(event.data) ? event.data : undefined;
  const tone = event.severity === 'critical' || event.severity === 'high'
    ? 'danger' as const : event.severity === 'medium' ? 'warning' as const : 'info' as const;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
  if (data?.reason === 'queue-overflow-outcome') {
    // Só `coverageState: recovered` (versão atual analisada em todos os
    // caminhos) é positivo. Admissão recuperada sozinha não chega.
    const confirmed = data.coverageState === 'recovered';
    return {label: confirmed ? 'Fila de análise recuperada' : 'Lacuna do tempo real', tone,
      description: event.summary?.trim() || (confirmed
        ? 'Os caminhos afetados foram analisados na versão atual.'
        : 'A cobertura dos caminhos afetados não ficou confirmada. Faz uma análise manual das pastas afetadas.')};
  }
  if (data?.reason === 'queue-overflow') {
    // `rejectedAttempts` (serviço novo) ou `droppedEvents` (serviço antigo): ambos
    // contam TENTATIVAS rejeitadas, não ficheiros.
    const count = num(data.rejectedAttempts) ?? num(data.droppedEvents);
    const paths = typeof data.distinctPaths === 'number' && Number.isFinite(data.distinctPaths) ? data.distinctPaths : null;
    return {label:'Fila de análise cheia',tone,description: count === null
      ? 'A fila de análise atingiu o limite. A quantidade de tentativas rejeitadas está indisponível.'
      : `${count} tentativas de análise rejeitadas pela fila${paths === null ? '' : `, em ${data.capped === true ? 'pelo menos ' : ''}${paths} caminhos distintos`}. Alguns ficheiros podem precisar de análise manual.`};
  }
  if (data?.reason === 'watcher-coverage') return {label:'Cobertura limitada',tone,
    description: event.summary?.trim() || 'Lacuna de cobertura possível. A quantidade de ficheiros afetados é desconhecida.'};
  if (data?.essentialUnavailable === true) return {label:'Motor indisponível',tone,
    description:event.summary?.trim() || `O ${typeof data.engine === 'string' ? data.engine : 'motor'} deixou de conseguir analisar; os resultados podem ser inconclusivos.`};
  if (typeof data?.updatedAt === 'string') return {label:'Definições atualizadas',tone,description:event.summary?.trim() || 'O serviço reportou uma atualização das definições.'};
  return {label:'Estado do motor',tone,description:event.summary?.trim() || 'Estado do motor alterado.'};
}
