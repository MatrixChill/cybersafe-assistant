/** Publishes each confirmed read as it arrives; rejection remains a rejection. */
export async function observeRead<T>(read:()=>Promise<T>, publish:(value:T)=>void):Promise<PromiseSettledResult<T>> {
  try { const value=await read(); publish(value); return {status:'fulfilled',value}; }
  catch(reason) { return {status:'rejected',reason}; }
}
/** Overlapping callers share work; rejection never permanently poisons the flight. */
export function singleFlight<T>(read:()=>Promise<T>):()=>Promise<T> {
  let flight:Promise<T>|null=null;
  return ()=>{ if(flight)return flight; const next=Promise.resolve().then(read);flight=next;
    void next.finally(()=>{if(flight===next)flight=null;}).catch(()=>{});return next; };
}
/**
 * A ponte do Electron devolve `null` quando a leitura já não pode acontecer
 * (encerramento em curso, cliente desligado) — NÃO rejeita. Publicada como `null`,
 * uma lista torna-se «zero itens' para a página, e foi assim que o ErrorBoundary
 * apanhou «Erro no renderer» no F1 do harness de faults de 28/10. Estes dois
 * validadores correm ANTES do `publish`: o `null` vira uma rejeição registada, o
 * ciclo de sync rotula a leitura como falha, e a última leitura confirmada fica no
 * ecrã. Nenhum dos dois inventa um valor por cima do silêncio.
 */
export function exigirLista<T>(leitura: string, valor: unknown): T[] {
  if (!Array.isArray(valor)) {
    throw new Error(`Leitura de ${leitura} não confirmada: a ponte devolveu ${valor === null ? "null" : typeof valor}.`);
  }
  return valor as T[];
}

/** Para leituras de objeto (estado do PC, resultado de processos com frescura). */
export function exigirPresenca<T>(leitura: string, valor: T | null | undefined): T {
  if (valor === null || valor === undefined) {
    throw new Error(`Leitura de ${leitura} não confirmada: a ponte devolveu ${valor === null ? "null" : "undefined"}.`);
  }
  return valor;
}
