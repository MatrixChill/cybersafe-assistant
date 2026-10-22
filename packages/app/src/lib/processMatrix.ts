import type { ProcessIntelligenceContext, ProcessSnapshot } from '@cybersafe/shared-types';
import type { ProcessDiagnostic } from './processIntelligence';

function processName(name: string): string {
  return name.split(/[\\/]/).pop()?.replace(/[\r\n\u0000-\u001f]/g, '').slice(0, 80) || 'Processo';
}

/** Explicit allowlist: never spread a ProcessSnapshot into an outbound payload. */
export function buildProcessMatrixContext(diagnostic: ProcessDiagnostic, selectedPid?: number, selected?: ProcessSnapshot): ProcessIntelligenceContext {
  const topProcesses = diagnostic.topProcesses.slice(0, 5).map(p => ({
    pid: p.pid, name: processName(p.name), startedAt: p.startedAt,
    cpuPercent: p.cpuPercent, workingSetMb: p.workingSetMb,
  }));
  return {
    version: 1, measuredAt: diagnostic.measuredAt,
    ram: {totalMb: diagnostic.ram.totalMb, usedMb: diagnostic.ram.usedMb, availableMb: diagnostic.ram.availableMb},
    cpuPercent: diagnostic.cpuPercent, topProcesses,
    selectedProcess: selected && selected.pid === selectedPid ? {
      pid: selected.pid, name: processName(selected.name), startedAt: selected.startedAt || null,
      cpuPercent: Number.isFinite(selected.cpu) && selected.cpu >= 0 ? selected.cpu : null,
      workingSetMb: Number.isFinite(selected.memoryMb) && selected.memoryMb >= 0 ? selected.memoryMb : null,
    } : topProcesses.find(p => p.pid === selectedPid) ?? null,
    trends: diagnostic.trends.filter(t=>topProcesses.some(p=>p.pid===t.pid && p.startedAt===t.startedAt) || (selected?.pid===t.pid && selected.startedAt===t.startedAt)).slice(0, 5).map(t => ({
      pid: t.pid, startedAt: t.startedAt, previousMb: t.previousMb, currentMb: t.currentMb,
      deltaMb: t.deltaMb, intervalMs: t.intervalMs, samples: t.samples,
    })),
    limitations: diagnostic.limitations.slice(0, 8).map(s => s.slice(0, 240)),
  };
}

export function matrixTelemetryContext(context: string, consent: boolean): string {
  return consent ? context : '';
}

export function processPayload(context: ProcessIntelligenceContext | null, consent: boolean): {processIntelligence?: ProcessIntelligenceContext; processConsent?: true} {
  return context && consent ? {processIntelligence: context, processConsent: true} : {};
}

/** Revoking consent also excludes previously displayed process measurements. */
export function processChatHistory<T extends {role: string; content: string; privateProcessData?: boolean}>(history: T[], consent: boolean): Array<{role: string; content: string}> {
  return history.filter(message => consent || !message.privateProcessData)
    .map(({role, content}) => ({role, content}));
}

export function isProcessQuestion(text: string): boolean {
  return /\b(ram|cpu|mem[oó]ria|processo[s]?|programa|chrome|firefox|msedge|memory compression|msmpeng(?:\.exe)?|lento|lentid[aã]o|encerrar|fechar|consum[oie]|working set)\b/i.test(text);
}

export function buildProcessLocalReply(diagnostic: ProcessDiagnostic | null, selectedPid?: number, selected?: ProcessIntelligenceContext['selectedProcess']): string {
  if (!diagnostic) return '**DIAGNÓSTICO BÁSICO OFFLINE**\n\n**INFORMAÇÃO INSUFICIENTE:** A recolher dados. Ainda não há medições disponíveis. A IA generativa não foi utilizada.';
  const chosen = selected ?? (selectedPid === undefined ? diagnostic.topProcesses[0] : diagnostic.topProcesses.find(p => p.pid === selectedPid));
  const observed = [`Medição: ${diagnostic.measuredAt}.`];
  const ram = diagnostic.ram;
  if (ram.usedMb !== null && ram.totalMb !== null) observed.push(`RAM utilizada: ${Math.round(ram.usedMb)} MB de ${Math.round(ram.totalMb)} MB.`);
  if (diagnostic.cpuPercent !== null) observed.push(`CPU global: ${diagnostic.cpuPercent.toFixed(1)}%.`);
  if (chosen) {
    observed.push(`${processName(chosen.name)} (PID ${chosen.pid}): Working Set ${chosen.workingSetMb === null ? 'sem leitura' : `${Math.round(chosen.workingSetMb)} MB`}; CPU ${chosen.cpuPercent === null ? 'sem leitura' : `${chosen.cpuPercent.toFixed(1)}%`}.`);
    const trend = diagnostic.trends.find(t => t.pid === chosen.pid && t.startedAt === chosen.startedAt);
    if (trend) observed.push(`Working Set: ${Math.round(trend.previousMb)} → ${Math.round(trend.currentMb)} MB (${trend.deltaMb >= 0 ? '+' : ''}${Math.round(trend.deltaMb)} MB em ${Math.round(trend.intervalMs / 1000)} s, ${trend.samples} amostras).`);
    else observed.push('Tendência deste processo: A recolher dados.');
  }
  else if (selectedPid !== undefined) observed.push('O processo selecionado não está nas medições disponíveis; não o substituí por outro.');
  const name = chosen ? processName(chosen.name).toLowerCase() : '';
  const isMemoryCompression = /^memory compression$/i.test(name);
  const explanation = isMemoryCompression
    ? 'Memory Compression é o gestor de memória do Windows que comprime páginas de memória menos usadas para reduzir paginação. O Working Set que observa inclui páginas partilhadas e limpas; um valor isolado não é o tamanho da memória comprimida, não confirma fuga, ameaça ou normalidade. Este é um componente do Windows; não encerrar.'
    : name === 'msmpeng.exe'
      ? 'MsMpEng.exe pertence ao Microsoft Defender. A sua presença não confirma uma análise em curso; atividade de proteção é uma possível explicação, não medida aqui. Não encerrar nem desativar este componente.'
      : 'Uma carga elevada pode contribuir para lentidão. Navegadores podem separar separadores e extensões em vários processos; estas medições não identificam a atividade interna de cada um.';
  const ramObs = diagnostic.ram.availableMb !== null ? `RAM medida: ${Math.round(diagnostic.ram.availableMb)} MB disponível.` : 'RAM: sem leitura de RAM disponível — não é possível confirmar pressão com as métricas actuais.';
  const normalOuPreocupante = isMemoryCompression
    ? `\n\nEstado: **não concludente**. Working Set isolado não prova problema nem normalidade — pode variar com páginas residentes e a causa desta amostra é desconhecida. ${ramObs} Sem falhas de página, memória comprometida (commit) ou memória comprimida efetiva, a pressão não é confirmável a partir destes dados.`
    : diagnostic.ram.availableMb !== null
      ? `\n\nEstado: **não concludente**. ${ramObs} Pressão de memória não é confirmável a partir de Working Set isolado.`
      : '\n\nEstado: **não concludente**. RAM sem leitura de RAM disponível — pressão não é confirmável.';
  const acoesSeguras = isMemoryCompression
    ? `Não encerrar este componente. Se necessário, feche aplicações do utilizador (navegadores, editores) normalmente; observar.`
    : 'Fechar aplicações do utilizador que já não sejam necessárias. Não encerrar processos críticos do Windows.';
  const faltaMedir = isMemoryCompression
    ? `Falta medir: memória comprimida efetiva, falhas de página/paginação, memória comprometida (commit), tendência de RAM. Working Set não é memória comprimida nem exclusiva; a soma dos processos não explica toda a RAM.`
    : 'Working Set não é memória privada ou exclusiva. A soma dos processos não explica toda a RAM.';
  return [
    '**DIAGNÓSTICO BÁSICO OFFLINE** — explicação determinística; a IA generativa não foi utilizada.',
    `**DADO OBSERVADO:**\n${observed.join('\n')}`,
    `**HIPÓTESE / CONTEXTO:** ${explanation}`,
    normalOuPreocupante,
    `**AÇÕES SEGURAS:**\n${acoesSeguras}`,
    `**FALTA MEDIR:** ${faltaMedir}`,
    `**RECOMENDAÇÃO:**\n${diagnostic.recommendations.join('\n') || 'Guardar o trabalho e observar mais amostras. Não encerrar processos críticos do Windows.'}`,
  ].join('\n\n');
}
