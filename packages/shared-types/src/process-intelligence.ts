export interface ProcessIntelligenceContext {
  version: 1;
  measuredAt: string;
  ram: {
    totalMb: number | null;
    usedMb: number | null;
    availableMb: number | null;
  };
  cpuPercent: number | null;
  topProcesses: Array<{
    pid: number;
    name: string;
    startedAt: string | null;
    cpuPercent: number | null;
    workingSetMb: number | null;
  }>;
  selectedProcess: {
    pid: number;
    name: string;
    startedAt: string | null;
    cpuPercent: number | null;
    workingSetMb: number | null;
  } | null;
  trends: Array<{
    pid: number;
    startedAt: string | null;
    previousMb: number;
    currentMb: number;
    deltaMb: number;
    intervalMs: number;
    samples: number;
  }>;
  limitations: string[];
}
