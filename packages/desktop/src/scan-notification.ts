import type {ScanState} from '@cybersafe/shared-types';
type CompletionState=Pick<ScanState,'status'|'filesTotal'|'filesScanned'|'filesAnalyzed'|'filesInconclusive'|'filesFailed'|'threatsFound'>;
const count=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.floor(value)):0;
/** Completion is not a clean verdict. Uses only the service's measured counters. */
export function scanCompletionNotification(state:CompletionState):string|null {
  if(state.status==='failed')return 'Não foi possível concluir a análise. Consulte o histórico para ver o motivo.';
  if(state.status==='cancelled')return 'Análise cancelada. Consulte o histórico para ver os resultados parciais.';
  if(state.status!=='completed')return null;
  const considered=count(state.filesTotal)>0?count(state.filesTotal):count(state.filesScanned);
  const hasAnalyzed=typeof state.filesAnalyzed==='number'&&Number.isFinite(state.filesAnalyzed);
  const analyzed=count(state.filesAnalyzed),inconclusive=count(state.filesInconclusive),failed=count(state.filesFailed),threats=count(state.threatsFound);
  const files=!hasAnalyzed?`${considered} ${considered===1?'ficheiro considerado':'ficheiros considerados'}`:considered>analyzed?`${analyzed} de ${considered} ficheiros analisados`:`${analyzed} ${analyzed===1?'ficheiro analisado':'ficheiros analisados'}`;
  const detections=threats===0?'nenhuma ameaça detetada':`${threats} ${threats===1?'ameaça detetada':'ameaças detetadas'}`;
  const limitations=[];
  if(inconclusive>0)limitations.push(`${inconclusive} ${inconclusive===1?'verificação inconclusiva':'verificações inconclusivas'}`);
  if(failed>0)limitations.push(`${failed} ${failed===1?'ficheiro não analisado':'ficheiros não analisados'}`);
  const prefix=limitations.length?'Análise parcial':hasAnalyzed&&analyzed>0?'Análise concluída':'Análise terminada';
  const unavailable=(!hasAnalyzed||analyzed===0)?'; não há análise de ficheiros confirmada':'';
  return `${prefix}: ${files}, ${detections}${limitations.length?'; '+limitations.join('; '):''}${unavailable}.`;
}
