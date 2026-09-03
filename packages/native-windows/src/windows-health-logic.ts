import type {
  WindowsDiskInfo,
  WindowsFirewallState,
  WindowsHealthRecommendation,
  WindowsHealthSnapshot,
  WindowsHealthStatus,
  WindowsServiceInfo,
  WindowsSystemInfo,
  WindowsTcpConnection,
  WindowsTopProcess,
} from "@cybersafe/shared-types";

/**
 * Lógica pura (determinística) de saúde/recomendações do Windows.
 * Separada da camada de execução PowerShell para permitir testes unitários
 * sem depender do Windows nem de comandos reais.
 *
 * NENHUMA funcionalidade destrutiva é gerada aqui. Apenas análise read-only.
 */

export interface WindowsHealthInput {
  system: WindowsSystemInfo;
  topCpu: WindowsTopProcess[];
  topRam: WindowsTopProcess[];
  services: WindowsServiceInfo[];
  connections: WindowsTcpConnection[];
  users: WindowsHealthSnapshot["users"];
  disks: WindowsDiskInfo[];
  firewall: WindowsFirewallState;
}

export function overallStatus(recommendations: WindowsHealthRecommendation[]): WindowsHealthStatus {
  if (recommendations.some((r) => r.status === "critical")) return "critical";
  if (recommendations.some((r) => r.status === "attention")) return "attention";
  return "good";
}

export function computeScore(recommendations: WindowsHealthRecommendation[]): number {
  let score = 100;
  for (const r of recommendations) {
    if (r.severity === "high") score -= 20;
    else if (r.severity === "medium") score -= 10;
    else score -= 5;
  }
  return Math.max(0, Math.min(100, score));
}

export function buildRecommendations(input: WindowsHealthInput): WindowsHealthRecommendation[] {
  const recommendations: WindowsHealthRecommendation[] = [];

  // RAM muito utilizada
  if (input.system.available && input.system.ramUsagePercent >= 90) {
    const top = input.topRam[0];
    recommendations.push({
      id: "ram-high",
      severity: "high",
      status: "critical",
      title: "Memória RAM crítica",
      description: `A memória RAM está a ${input.system.ramUsagePercent}% de utilização.`,
      suggestion: top
        ? `O processo ${top.name} (PID ${top.pid}) é o maior consumidor. Feche aplicações pesadas em segundo plano.`
        : "Feche aplicações pesadas em segundo plano.",
    });
  } else if (input.system.available && input.system.ramUsagePercent >= 75) {
    recommendations.push({
      id: "ram-attention",
      severity: "medium",
      status: "attention",
      title: "Memória RAM elevada",
      description: `A memória RAM está a ${input.system.ramUsagePercent}% de utilização.`,
      suggestion: "Considere fechar programas minimizados ou abas do navegador para libertar memória.",
    });
  }

  // Armazenamento quase cheio
  const fullDisk = [...input.disks].sort((a, b) => b.usagePercent - a.usagePercent)[0];
  if (fullDisk && fullDisk.usagePercent >= 95) {
    recommendations.push({
      id: "disk-critical",
      severity: "high",
      status: "critical",
      title: "Disco quase cheio",
      description: `O disco ${fullDisk.deviceId} (${fullDisk.volumeName || "sem nome"}) está a ${fullDisk.usagePercent}% cheio (${Math.round(fullDisk.freeGb)} GB livres).`,
      suggestion: "Apague ficheiros temporários, esvazie a reciclagem ou desinstale aplicações desnecessárias.",
    });
  } else if (fullDisk && fullDisk.usagePercent >= 85) {
    recommendations.push({
      id: "disk-attention",
      severity: "medium",
      status: "attention",
      title: "Espaço em disco baixo",
      description: `O disco ${fullDisk.deviceId} está a ${fullDisk.usagePercent}% cheio.`,
      suggestion: "Limpe ficheiros temporários e considere libertar espaço.",
    });
  }

  // Firewall desativado
  if (input.firewall.available && !input.firewall.enabled) {
    const disabled = input.firewall.profiles.filter((p) => !p.enabled);
    recommendations.push({
      id: "firewall-disabled",
      severity: "high",
      status: "critical",
      title: "Firewall desativado",
      description: `As seguintes políticas de firewall estão desativadas: ${disabled.map((p) => p.name).join(", ") || "todas"}.`,
      suggestion: "Ative o Firewall do Windows para proteger o sistema contra acesso de rede não autorizado.",
    });
  }

  // Muitos processos a consumir CPU
  const heavyCpu = input.topCpu.filter((p) => p.cpuPercent > 50);
  if (heavyCpu.length > 2 && input.system.available && input.system.ramUsagePercent >= 50) {
    recommendations.push({
      id: "many-cpu-processes",
      severity: "medium",
      status: "attention",
      title: "Muitos processos com CPU elevada",
      description: `${heavyCpu.length} processos estão a consumir mais de 50% de CPU.`,
      suggestion: heavyCpu.map((p) => `${p.name} (${p.cpuPercent}%)`).join(", "),
    });
  }

  // Serviço importante indisponível
  const criticalServices = ["Spooler", "WinDefend", "wuauserv", "mpssvc", "LanmanServer"];
  const unavailable = input.services.filter((s) => criticalServices.includes(s.name) && !s.running);
  if (unavailable.length > 0) {
    recommendations.push({
      id: "service-down",
      severity: "high",
      status: "attention",
      title: "Serviços importantes indisponíveis",
      description: unavailable.map((s) => s.displayName || s.name).join(", "),
      suggestion: "Verifique o estado destes serviços. Alguns podem estar desativados por outros programas.",
    });
  }

  return recommendations;
}

/** Compõe o snapshot final de saúde a partir dos inputs e recomendações. */
export function buildWindowsHealthSnapshot(
  input: WindowsHealthInput,
  collectedAt: string,
  errors: string[],
): WindowsHealthSnapshot {
  const recommendations = buildRecommendations(input);
  return {
    system: input.system,
    topProcessesByCpu: input.topCpu,
    topProcessesByRam: input.topRam,
    services: input.services,
    connections: input.connections,
    users: input.users,
    disks: input.disks,
    firewall: input.firewall,
    overallStatus: overallStatus(recommendations),
    score: computeScore(recommendations),
    recommendations,
    collectedAt,
    errors,
  };
}
