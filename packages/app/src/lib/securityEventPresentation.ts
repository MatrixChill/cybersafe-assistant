import type { SecurityEvent } from "@cybersafe/shared-types";

/**
 * Atividade do Painel: a mesma analise publica um `scan.progress` por
 * atualizacao de estado. O historico guarda-os todos (auditoria), mas a lista
 * curta nao pode gastar as suas 3 linhas no mesmo scan. Mantem-se a versao
 * mais recente por `scanId`; eventos de tipos diferentes nao sao tocados.
 */
export function activityEventsForDisplay(events: readonly SecurityEvent[], limit = 3): SecurityEvent[] {
  const ordered = [...events].sort((a, b) => b.sequence - a.sequence);
  const seenScans = new Set<string>();
  const visible: SecurityEvent[] = [];
  for (const event of ordered) {
    if (event.type === "scan.progress") {
      const data = event.data as { id?: unknown } | undefined;
      const key = typeof event.scanId === "string" && event.scanId.length > 0
        ? event.scanId
        : typeof data?.id === "string" && data.id.length > 0 ? data.id : event.id;
      if (seenScans.has(key)) continue;
      seenScans.add(key);
    }
    visible.push(event);
    if (visible.length >= limit) break;
  }
  return visible;
}
export type ProcessEventProvenance = "observed" | "requested" | "confirmed" | "unknown" | "other";
/** Presentation only. Historical summaries and event payloads are never rewritten. */
export function securityEventPresentation(event: Pick<SecurityEvent,"type"|"summary"> & Partial<Pick<SecurityEvent,"data">>): {
  text:string; note:string; observedExit:boolean; provenance:ProcessEventProvenance;
} {
  const original=event.summary??"";
  if(event.type==="process.exited") {
    const prefix="Processo terminado:";
    const data=event.data as Record<string,unknown>|undefined;
    const name=typeof data?.name === "string" ? data.name : original.startsWith(prefix)?original.slice(prefix.length).trim():"";
    return {text:name?`Saída do processo observada: ${name}`:"Saída de processo observada",note:"Causa e autor da saída não confirmados; isto não indica uma ação do CyberSafe.",observedExit:true,provenance:"observed"};
  }
  if(event.type==="process.killed") {
    const data=event.data as Record<string,unknown>|undefined;
    if(data?.confirmed===true && data.source==="user-confirmed" && data.scope==="single-process" && Number.isInteger(data.pid) && (data.pid as number)>0 && (data.pid as number)<=0xffffffff)
      return {text:`Processo terminado pelo CyberSafe (PID ${data.pid})`,note:"Operação individual confirmada pelo serviço após observar a saída do processo.",observedExit:false,provenance:"confirmed"};
    if(data?.status==="requested")
      return {text:"Terminação de processo solicitada",note:"O pedido não confirma que o processo tenha saído.",observedExit:false,provenance:"requested"};
    return {text:"Registo de terminação de processo",note:"Proveniência e execução não confirmadas neste registo histórico.",observedExit:false,provenance:"unknown"};
  }
  return {text:original||event.type.replace(/[._]/g," "),note:"Evento registado pelo serviço",observedExit:false,provenance:"other"};
}
