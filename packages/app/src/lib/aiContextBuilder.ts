export interface ProcessContextRaw {
  pid: number;
  name: string;
  commandLine?: string;
  path?: string;
  memoryBytes?: number;
  cpuPercent?: number;
  userName?: string;
}

export interface EngineStateRaw {
  clamav?: { status: string; engineVersion?: string; signaturesDate?: string };
  yara?: { status: string; rulesCount?: number; coverage?: string };
  hashdb?: { status: string; lookupCount?: number };
}

/**
 * Higieniza caminhos pessoais e de utilizador (ex.: C:\Users\caioc\... -> C:\Users\<utilizador>\...).
 */
export function sanitizeUserPaths(text: string): string {
  if (!text) return text;
  // Oculta caminhos Windows de perfil de utilizador
  return text.replace(/[a-zA-Z]:\\Users\\[^\\]+/gi, "C:\\Users\\<utilizador>");
}

/**
 * Remove argumentos com segredos, tokens e passwords da linha de comando de processos.
 */
export function sanitizeCommandLine(cmd: string): string {
  if (!cmd) return "";
  let clean = sanitizeUserPaths(cmd);
  clean = clean.replace(/(--password|--token|--key|-p)\s+([^\s]+)/gi, "$1 [REDACTED]");
  clean = clean.replace(/(password|token|key|secret)=([^\s&]+)/gi, "$1=[REDACTED]");
  return clean;
}

/**
 * Sanitiza o contexto de processo para envio seguro à IA.
 * Apenas campos essenciais e agregados são preservados.
 */
export function buildSafeProcessContext(proc: ProcessContextRaw): string {
  const parts: string[] = [
    `Processo: ${proc.name}`,
    `PID: ${proc.pid}`,
  ];

  if (typeof proc.cpuPercent === "number" && Number.isFinite(proc.cpuPercent) && proc.cpuPercent >= 0) {
    parts.push(`Consumo de CPU: ${proc.cpuPercent.toFixed(1)}%`);
  }
  if (typeof proc.memoryBytes === "number" && Number.isFinite(proc.memoryBytes) && proc.memoryBytes >= 0) {
    const mb = (proc.memoryBytes / (1024 * 1024)).toFixed(1);
    parts.push(`Consumo de Memória: ${mb} MB`);
  }

  return parts.join("\n");
}

/**
 * Constrói o contexto factual de estado dos motores para envio à IA.
 */
export function buildSafeEngineContext(engines: EngineStateRaw): string {
  const parts: string[] = ["Estado dos Motores de Segurança:"];

  if (engines.clamav) {
    parts.push(`- ClamAV: Estado=${engines.clamav.status}${engines.clamav.signaturesDate ? ` (Assinaturas: ${engines.clamav.signaturesDate})` : ""}`);
  }
  if (engines.yara) {
    parts.push(`- YARA: Estado=${engines.yara.status}${engines.yara.coverage ? ` (Cobertura: ${engines.yara.coverage})` : ""}`);
  }
  if (engines.hashdb) {
    parts.push(`- HashDB: Estado=${engines.hashdb.status}`);
  }

  return parts.join("\n");
}

/**
 * Lista de ações privilegiadas estritamente proibidas para execução autónoma da IA.
 */
export const FORBIDDEN_AI_ACTIONS = [
  "terminate_process",
  "kill_process",
  "delete_file",
  "restore_quarantine",
  "disable_protection",
  "install_update",
  "execute_system_command",
] as const;

export function isActionAllowedForAI(_action: string): boolean { return false; }

/** General telemetry crosses the existing consent gate before minimisation. */
export function minimizeContextForAi(text: string, consent: boolean): string {
  if (!consent) return "";
  return sanitizeUserPaths(text).split(/\r?\n/)
    .filter((line) => !/password|passwd|token|secret|api.?key|command.?line|linha de comando/i.test(line))
    .join("\n").slice(0, 4000);
}
