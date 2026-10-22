import { isProtectedProcess, type HardwareSnapshot, type ProcessSnapshot, type ProcessIntelligenceContext } from '@cybersafe/shared-types';
import { cpuUsageForNarrative } from './cpuUsage';
export interface ProcessDiagnostic extends Omit<ProcessIntelligenceContext, 'version' | 'selectedProcess'> {
  observations: string[];
  recommendations: string[];
}

/**
 * PACOTE C (PROCESS-UX-HUMAN-FAIL-20261014): resumo honesto para o painel
 * colapsável. Cada linha afirma APENAS o que os factos medidos sustentam —
 * distinguir sem-identidade / sem-amostra-recente / amostras-a-acumular é o
 * pedido do Maestro; o tempo mostrado é derivado de `measuredAt` (medido),
 * nunca um temporizador inventado.
 */
export type EstadoResumo = "semDiagnostico" | "semAmostraRecente" | "semIdentidade" | "aAcumular" | "medido";
export function resumoDoDiagnostico(d: ProcessDiagnostic | null | undefined, agora?: number): { estado: EstadoResumo; linha: string } {
  if (!d) return { estado: "semDiagnostico", linha: "A recolher dados. Ainda não há uma amostra confirmada." };
  if (d.limitations.some((l) => l.startsWith("Sem amostra recente"))) {
    return { estado: "semAmostraRecente", linha: "Sem amostra recente dos processos; atualizar a lista para obter diagnóstico." };
  }
  if (d.trends.length === 0 && d.limitations.some((l) => l.startsWith("Processos sem instante"))) {
    return { estado: "semIdentidade", linha: "Há processos sem instante de início: sem identidade estável não há tendência (o PID pode ser reutilizado)." };
  }
  if (d.trends.length === 0) {
    return { estado: "aAcumular", linha: "Medições a acumular — ainda não há histórico suficiente: são necessárias 3 amostras da mesma instância ao longo de 30 s. Se persistir, é preciso verificar a continuidade das leituras e da identidade." };
  }
  const medidoHa = typeof agora === "number" && Number.isFinite(agora) ? Math.max(0, Math.round((agora - Date.parse(d.measuredAt)) / 1000)) : null;
  return { estado: "medido", linha: `Diagnóstico com ${d.trends.length} ${d.trends.length === 1 ? "tendência medida" : "tendências medidas"}${medidoHa !== null && medidoHa < 600 ? `, última amostra há ${medidoHa} s` : ""}.` };
}

/**
 * Identidade CONGELADA do pedido de explicação: o painel mostra uma instância
 * (pid + instante de início). Se essa instância desapareceu, ou se o PID foi
 * reutilizado por outra, a resposta da app tem de dizê-lo — nunca substituir
 * por "o processo com aquele PID que ainda existe". (review CODEX: o fallback
 * por PID simples podia trocar a instância.)
 */
export type EstadoIdentidade = "semAlvo" | "presente" | "sumido" | "reutilizado";
export function estadoDeIdentidade(processes: ProcessSnapshot[], alvo: { pid?: number; startedAt?: string | null } | null | undefined): EstadoIdentidade {
  if (!alvo || alvo.pid === undefined) return "semAlvo";
  const mesmos = processes.filter((p) => p.pid === alvo.pid);
  if (mesmos.length === 0) return "sumido";
  const bate = mesmos.some((p) => (p.startedAt || null) === (alvo.startedAt || null));
  if (bate) return "presente";
  return alvo.startedAt ? "reutilizado" : "sumido";
}
type Sample = { at: number; mb: number };
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const identity = (p: ProcessSnapshot) => p.startedAt && Number.isFinite(Date.parse(p.startedAt)) ? `${p.pid}:${p.startedAt}` : null;
/** History of successful existing process reads; no additional OS polling. */
export function criarHistoricoProcessos(options: {maxSamples?: number; maxProcesses?: number; maxAgeMs?: number} = {}) {
  const history = new Map<string, Sample[]>();
  const maxSamples = Math.max(3, Math.min(options.maxSamples ?? 30, 60));
  // Preserve at least 30 seconds even when event bursts exceed the sample cap.
  const minSampleIntervalMs = Math.ceil(30000 / (maxSamples - 1));
  const maxProcesses = Math.max(1, Math.min(options.maxProcesses ?? 256, 1024));
  const maxAge = Math.max(30000, Math.min(options.maxAgeMs ?? 300000, 600000));
  let observedAt: number | null = null;
  return {
    limpar() { history.clear(); observedAt = null; },
    registar(processes: ProcessSnapshot[], at = Date.now()) {
      if (!Number.isFinite(at) || (observedAt !== null && at <= observedAt)) return;
      observedAt = at;
      const current = new Set(processes.map(identity).filter((key): key is string => !!key));
      for (const [key, samples] of history) {
        const recent = samples.filter(s => at - s.at <= maxAge);
        if (!current.has(key) || !recent.length) history.delete(key);
        else history.set(key, recent);
      }
      // FASE 1 — séries existentes: amostra nova em cima, SEM re-inserir no
      // Map. O `delete`+`set` antigo movia cada chave para o fim a cada poll
      // e, com a ordem da lista a variar e >maxProcesses identidades vivas,
      // o "oldest-first" do evict expulsava séries alheias em cascata — o
      // FAIL humano das tendências presas em "A recolher dados".
      const candidatos: ProcessSnapshot[] = [];
      for (const p of processes) {
        const key = identity(p);
        if (!key || p.pid <= 0 || !finite(p.memoryMb)) continue;
        const samples = history.get(key);
        if (!samples) { candidatos.push(p); continue; }
        if (samples.length && at - samples[samples.length - 1].at < minSampleIntervalMs) continue;
        samples.push({ at, mb: p.memoryMb });
        if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
      }
      // FASE 2 — admissão PRESERVADORA (cap inalterado, sem aumento cego):
      // candidatos novos por DESCIDA de memória (o conjunto prioritário —
      // é o top5 por memória que o painel mostra — admitido antes de os
      // fracos gastarem o cap). À vontade do cap, só entra quem for mais
      // sinal que o PIOR da casa; o pior sai, ninguém mais é tocado.
      // Estável-grande madura nunca é expulsa por pequeno, e pequeno novo
      // é recusado — a cascata que prendia o painel em 'A recolher dados'
      // deixa de ter origem.
      candidatos.sort((a, b) => b.memoryMb - a.memoryMb);
      for (const p of candidatos) {
        const key = identity(p)!;
        if (history.size < maxProcesses) { history.set(key, [{ at, mb: p.memoryMb }]); continue; }
        let victimKey: string | undefined;
        let victimMb = Number.POSITIVE_INFINITY;
        for (const [k, series] of history) {
          const lastMb = series[series.length - 1]?.mb ?? 0;
          if (lastMb < victimMb) { victimMb = lastMb; victimKey = k; }
        }
        // O candidato só entra se for ESTRITAMENTE mais sinal que o pior da
        // casa — quem está a amadurecer mas é grande nunca é expulsado por um
        // pequeno, e um pequeno nunca gera cascata: fica recusado.
        if (!victimKey || !(p.memoryMb > victimMb)) continue;
        history.delete(victimKey);
        history.set(key, [{ at, mb: p.memoryMb }]);
      }
    },
    diagnosticar(hardware: HardwareSnapshot | null, processes: ProcessSnapshot[], now = Date.now()): ProcessDiagnostic {
      const fresh = observedAt !== null && now >= observedAt && now - observedAt <= 30000;
      const current = fresh ? processes.filter(p => p.pid > 0) : [];
      const topProcesses = current.filter(p => finite(p.memoryMb)).sort((a,b) => b.memoryMb-a.memoryMb).slice(0,5)
        .map(p => ({pid:p.pid,name:p.name,startedAt:p.startedAt || null,cpuPercent:finite(p.cpu) && p.cpu <= 100 ? p.cpu : null,workingSetMb:p.memoryMb}));
      const trends: ProcessDiagnostic['trends'] = [];
      for (const p of current) {
        const key=identity(p);const samples=key ? history.get(key)?.filter(s => now-s.at<=maxAge) : undefined;
        if (!samples || samples.length < 3) continue;
        const first=samples[0],last=samples[samples.length-1];
        if(last.at-first.at < 30000) continue;
        trends.push({pid:p.pid,startedAt:p.startedAt,previousMb:first.mb,currentMb:last.mb,deltaMb:last.mb-first.mb,intervalMs:last.at-first.at,samples:samples.length});
      }
      // Ranking com PRIORIDADE topRAM (revisão CODEX, pacote A): o corte por
      // |delta| sozinho deitava fora a tendência de um processo maduro que é o
      // próprio top5 por memória quando os deltas empatam (mundo plano) ou
      // quando 5 pequenos crescem mais — e o painel voltava a "A recolher
      // dados" sobre séries que existiam. As instâncias apresentadas no top5
      // são ordenadas primeiro entre si (por |delta|), e o resto entra a
      // seguir; o contrato continua a ser no máximo 5, sem rutura partilhada.
      const ehTop = (t: ProcessDiagnostic['trends'][number]) =>
        topProcesses.some((p) => p.pid === t.pid && (p.startedAt || null) === (t.startedAt || null));
      const porDelta = (a: ProcessDiagnostic['trends'][number], b: ProcessDiagnostic['trends'][number]) =>
        Math.abs(b.deltaMb) - Math.abs(a.deltaMb) || b.currentMb - a.currentMb || b.pid - a.pid;
      const ranking = [...trends].sort((a, b) => {
        const ta = ehTop(a) ? 0 : 1;
        const tb = ehTop(b) ? 0 : 1;
        return ta - tb || porDelta(a, b);
      });
      const total=hardware?.ram?.totalGb,used=hardware?.ram?.usedGb;
      const validRam=finite(total) && total > 0 && finite(used) && used <= total;
      const cpu=cpuUsageForNarrative(hardware?.cpu);
      const limitations=['Working Set não é memória privada ou exclusiva. A soma dos processos não explica toda a RAM.',
        'Uma subida não prova fuga de memória. CPU global e RAM são leituras independentes da lista de processos.',
        'Amostras registadas à receção; a fonte de processos não publica o instante exato de medição.'];
      if(!fresh) limitations.push('Sem amostra recente de processos; atualizar para obter diagnóstico.');
      if(current.some(p=>!identity(p))) limitations.push('Processos sem instante de início não têm tendência: o PID pode ser reutilizado.');
      const observations=topProcesses.length ? [`Maior Working Set observado: ${topProcesses[0].name}, ${Math.round(topProcesses[0].workingSetMb)} MB.`] : ['Informação insuficiente sobre os consumidores atuais.'];
      const recommendations=['Guardar o trabalho antes de fechar normalmente uma aplicação que já não seja necessária.', 'Não encerrar processos críticos ou protegidos do Windows. Observar mais amostras antes de concluir.'];
      if(current.some(p=>isProtectedProcess(p))) recommendations.push('Existem processos protegidos na medição; não se recomenda terminá-los.');
      return {measuredAt:new Date(observedAt ?? now).toISOString(),ram:{totalMb:validRam?total*1024:null,usedMb:validRam?used*1024:null,availableMb:validRam?(total-used)*1024:null},cpuPercent:cpu,topProcesses,trends:ranking.slice(0,5),limitations,observations,recommendations};
    },
  };
}
