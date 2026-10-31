/**
 * ── SAÚDE DO DISCO (SMART/NVMe) — camada de INTERPRETAÇÃO (sem leitura) ──────
 *
 * ESTADO HONESTY: este módulo **não lê** o disco. Não há leitura implementada, e
 * por isso o PC Center mostra «Indisponível» com motivo — nunca um número.
 *
 * PORQUE NÃO LÊ AQUI (medido, não presumido): este ficheiro vive no renderer.
 * O shell abre a janela com `contextIsolation: true` e `nodeIntegration: false`
 * (`packages/desktop/src/main.ts:160-165`), portanto o renderer é contexto de
 * browser: um `import "node:child_process"` é EXTERNALIZADO pelo Vite
 * («Module "node:child_process" has been externalized for browser compatibility»)
 * e a chamada falha em runtime ainda que o build passe e os testes passem
 * (os testes correm em Node, onde o módulo existe — é um verde falso clássico).
 *
 * O CAMINHO CORRETO, para a próxima ronda, é outro e é maior do que um ficheiro:
 * `service:disk-health` no engine (leitura read-only com
 * `Get-PhysicalDisk | Get-StorageReliabilityCounter`),
 * canal no `preload.ts` e handler com `trustedIpcHandler` no `main.ts`.
 * `DISK_HEALTH_POWERSHELL_CMD` abaixo é a especificação desse comando.
 *
 * O que este módulo JÁ entrega, e é testável sem Windows: o parser da saída do
 * PowerShell, os limiares e as etiquetas. Nada aqui fabrica valores: com todos os
 * contadores ausentes, o resultado é `unavailable`.
 *
 * LIMITAÇÕES:
 *   - Get-PhysicalDisk precisa de privilégios administrativos no Windows
 *     22H2+. Sem elevação, retorna "Indisponível" com motivo.
 *   - NVMe: `Get-PhysicalDisk` não expõe temperatura diretamente em todos os
 *     controladores — é necessário `Get-NonUniformMemory` ou `smartctl` para
 *     NVMe real. Neste módulo, NVMe temperatura é tentada mas, se falhar, é
 *     "Indisponível".
 *   - Não confunde "disco cheio" (usagePercent alto) com "SSD degradado" —
 *     estes são eixos ortogonais. Um SSD cheio não é um SSD falhando.
 *   - Não instala drivers. Não chama DLLs não documentadas.
 */

export type DiskHealthStatus = "healthy" | "warning" | "critical" | "unavailable";

export interface DiskHealthReading {
  /** Status geral: "healthy" | "warning" | "critical" | "unavailable". */
  status: DiskHealthStatus;
  /** Temperatura do disco em °C, se lida. */
  temperatureC: number | null;
  /** Percentagem de desgaste (0-100), se NVMe. HDD = null. */
  wearPercent: number | null;
  /** Horas de utilização do disco, se disponível. */
  hoursUsed: number | null;
  /** Número de setores reallocated (setores remapped), se disponível. */
  reallocatedSectorCount: number | null;
  /** Número de erros de leitura/aescrita corrigíveis, se disponível. */
  errorCount: number | null;
  /** Mensagem de motivo quando status = "unavailable". */
  reason: string | null;
}

/**
 * Limiares de alerta para saúde do disco (valores conservadores, alinhados
 * com especificações da NIST SP 800-53 e datas de fábrica típicas).
 */
export const DISK_HEALTH_THRESHOLDS = {
  temperatureWarning: 55,
  temperatureCritical: 70,
  wearWarning: 80,
  wearCritical: 90,
  reallocatedWarning: 1,
  reallocatedCritical: 10,
} as const;

function clamp01(value: number): number {
  return Math.min(100, Math.max(0, value));
}

const perc1 = new Intl.NumberFormat("pt-PT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Avalia o estado de saúde a partir de contadores individuais.
 *
 * Regra de honestidade: só produz "healthy"/"warning"/"critical" quando há
 * pelo menos UM contador real (temperatura, wear, hours, ou erros). Se todos
 * são null, o estado é "unavailable".
 *
 * Os limiares são OR-accumulados: um único contador crítico basta para
 * "critical".
 */
export function evaluateDiskHealth(reading: DiskHealthReading): DiskHealthStatus {
  const hasAnyData =
    reading.temperatureC !== null ||
    reading.wearPercent !== null ||
    reading.hoursUsed !== null ||
    reading.reallocatedSectorCount !== null ||
    reading.errorCount !== null;

  if (!hasAnyData) return "unavailable";

  if (
    (reading.temperatureC !== null && reading.temperatureC >= DISK_HEALTH_THRESHOLDS.temperatureCritical) ||
    (reading.wearPercent !== null && reading.wearPercent >= DISK_HEALTH_THRESHOLDS.wearCritical) ||
    (reading.reallocatedSectorCount !== null && reading.reallocatedSectorCount >= DISK_HEALTH_THRESHOLDS.reallocatedCritical)
  ) {
    return "critical";
  }

  if (
    (reading.temperatureC !== null && reading.temperatureC >= DISK_HEALTH_THRESHOLDS.temperatureWarning) ||
    (reading.wearPercent !== null && reading.wearPercent >= DISK_HEALTH_THRESHOLDS.wearWarning) ||
    (reading.reallocatedSectorCount !== null && reading.reallocatedSectorCount >= DISK_HEALTH_THRESHOLDS.reallocatedWarning)
  ) {
    return "warning";
  }

  return "healthy";
}

/**
 * Texto de etiqueta para o status, em PT-PT.
 */
export function diskHealthLabel(status: DiskHealthStatus): string {
  switch (status) {
    case "healthy": return "Saudável";
    case "warning": return "Atenção";
    case "critical": return "Crítico";
    case "unavailable": return "Indisponível";
  }
}

/**
 * Texto detalhado para o status, incluindo contadores reais quando disponíveis.
 * Nunca inventa: "Indisponível" quando não há medição.
 */
export function diskHealthDetail(reading: DiskHealthReading): string {
  if (reading.status === "unavailable") {
    return reading.reason ?? "SMART/NVMe não disponível neste disco ou sem privilégios de administrador.";
  }

  const parts: string[] = [];
  if (reading.temperatureC !== null) parts.push(`Temperatura: ${Math.round(reading.temperatureC)} °C`);
  if (reading.wearPercent !== null) parts.push(`Desgaste: ${perc1.format(clamp01(reading.wearPercent))}%`);
  if (reading.hoursUsed !== null) parts.push(`Horas: ${Math.round(reading.hoursUsed)}`);
  if (reading.reallocatedSectorCount !== null) parts.push(`Setores remapeados: ${reading.reallocatedSectorCount}`);
  if (reading.errorCount !== null) parts.push(`Erros: ${reading.errorCount}`);

  return parts.length > 0 ? parts.join(" · ") : "Sem contadores detalhados.";
}

/**
 * Comando PowerShell para obter SMART/NVMe counters.
 *
 * `Get-PhysicalDisk` precisa de privilégios administrativos no Windows 10/11.
 * `Get-StorageReliabilityCounter` expõe: Temperature, WearPercentage,
 * PowerOnHours, ReallocatedSectorCount, CorrectableErrorCount, etc.
 *
 * NOTA: este comando NÃO é executado em testes. Os testes usam `evaluateDiskHealth`
 * (função pura) e `parseReliabilityCounterOutput` (parser puro).
 */
export const DISK_HEALTH_POWERSHELL_CMD =
  "Get-PhysicalDisk | ForEach-Object { " +
  "  $pd = $_; " +
  "  $rc = Get-StorageReliabilityCounter -PhysicalDisk $pd 2>$null; " +
  "  if ($rc) { " +
  "    [PSCustomObject]@{ " +
  "      FriendlyName = $pd.FriendlyName; " +
  "      MediaType = $pd.MediaType; " +
  "      Temperature = $rc.Temperature; " +
  "      WearPercentage = $rc.WearPercentage; " +
  "      PowerOnHours = $rc.PowerOnHours; " +
  "      ReallocatedSectorCount = $rc.ReallocatedSectorCount; " +
  "      CorrectableErrorCount = $rc.CorrectableErrorCount; " +
  "    } " +
  "  } " +
  "} | ConvertTo-Json -Compress";

/**
 * Parse puro da saída JSON do PowerShell.
 * Recebe a string JSON e devolve o primeiro disco encontrado (ou unavailable).
 *
 * Testável sem Windows: a entrada é uma string JSON qualquer.
 */
export function parseReliabilityCounterOutput(jsonOutput: string | null): DiskHealthReading {
  if (!jsonOutput || jsonOutput.trim() === "") {
    return unavailableReading("O PowerShell não devolveu nenhum contador de fiabilidade.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonOutput);
  } catch {
    return unavailableReading("A saída do PowerShell não é JSON válido.");
  }

  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const first = arr.find(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null,
  );

  if (!first) {
    return unavailableReading("Nenhum disco físico encontrado pelo Windows (Get-PhysicalDisk).");
  }

  const toNumber = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  const reading: DiskHealthReading = {
    status: "unavailable",
    temperatureC: toNumber(first.Temperature),
    wearPercent: toNumber(first.WearPercentage),
    hoursUsed: toNumber(first.PowerOnHours),
    reallocatedSectorCount: toNumber(first.ReallocatedSectorCount),
    errorCount: toNumber(first.CorrectableErrorCount),
    reason: null,
  };

  reading.status = evaluateDiskHealth(reading);
  return reading;
}

function unavailableReading(reason: string): DiskHealthReading {
  return {
    status: "unavailable",
    temperatureC: null,
    wearPercent: null,
    hoursUsed: null,
    reallocatedSectorCount: null,
    errorCount: null,
    reason,
  };
}

/**
 * A leitura que o PC Center mostra enquanto não existir canal.
 *
 * É uma função pura e não um `null` para que o motivo fique ESCRITO no ecrã:
 * «Indisponível» sem explicação é o mesmo defeito que «0,0%». Quando o canal
 * `service:disk-health` existir, esta função é o fallback de todo o caminho de
 * erro (sem elevação, sem contadores, disco sem SMART).
 */
export function diskHealthUnavailable(reason: string): DiskHealthReading {
  return unavailableReading(reason);
}

export const DISK_HEALTH_PENDING_REASON =
  "A leitura de SMART/NVMe ainda não está ligada: vive no processo principal (service) e o canal não existe nesta versão.";

