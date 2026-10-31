import { runHardwareQuery } from './hardware-query.js';
/**
 * ── ARMAZENAMENTO: saúde FÍSICA dos discos ──────────────────────────────────
 *
 * O `disk.ts` responde a "quanto espaço há". Isto responde a outra pergunta,
 * que o PC Center não sabia responder: "os discos estão a degradar-se?".
 * Espaço livre NÃO é saúde física — um SSD a 5% de vida pode estar a 20% de
 * ocupação, e um disco cheio pode estar perfeitamente saudável.
 *
 * Fontes, todas user-mode e documentadas:
 *   - `Get-PhysicalDisk` (Storage module): modelo, media type, bus, tamanho,
 *     HealthStatus. Disponível sem elevação.
 *   - `Get-StorageReliabilityCounter`: temperatura, desgaste, horas de
 *     funcionamento e erros. **Exige elevação**; sem ela o Windows devolve
 *     `PermissionDenied` ("Acesso a um recurso CIM não estava disponível").
 *     Isso é um estado próprio (`denied`), não "0 °C" nem "saúde boa".
 *
 * Regra: cada número só existe se foi devolvido. Um contador em falta é
 * `null` + motivo, nunca 0.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
  StorageCountersStatus,
  StorageDiskHealthStatus,
  StorageDiskSnapshot,
  StorageMediaType,
} from "@cybersafe/shared-types";

const execAsync = promisify(exec);

// O contrato público vive em `shared-types`; aqui só se reexporta para os
// consumidores do core não terem de o procurar noutro sítio.
export type { StorageCountersStatus, StorageDiskHealthStatus, StorageMediaType };
/** Alias local do contrato partilhado (uma única definição). */
export type StorageDiskHealth = StorageDiskSnapshot;

export interface StorageHealth {
  status: StorageCountersStatus;
  detail: string | null;
  disks: StorageDiskHealth[];
}

const PS_DISKS =
  "Get-PhysicalDisk | Select-Object DeviceId,FriendlyName,MediaType,BusType,Size,HealthStatus,OperationalStatus | ConvertTo-Json -Compress";

const PS_COUNTERS =
  "Get-PhysicalDisk | ForEach-Object { $c = $_ | Get-StorageReliabilityCounter -ErrorAction Stop; " +
  "[pscustomobject]@{ id = [string]$_.DeviceId; temperature = $c.Temperature; wear = $c.Wear; " +
  "hours = $c.PowerOnHours; readErr = $c.ReadErrorsTotal; readUnc = $c.ReadErrorsUncorrected; " +
  "writeErr = $c.WriteErrorsTotal; writeUnc = $c.WriteErrorsUncorrected } } | ConvertTo-Json -Compress";

const toFinite = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const asArray = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  if (value && typeof value === "object") return [value as Record<string, unknown>];
  return [];
};

/** JSON do PowerShell pode vir vazio, com BOM ou com lixo de aviso. */
export function parseJsonOutput(text: unknown): unknown {
  if (typeof text !== "string") return null;
  const clean = text.replace(/^\uFEFF/, "").trim();
  if (!clean) return null;
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

export function mediaTypeOf(raw: unknown): StorageMediaType {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (text === "ssd") return "ssd";
  if (text === "hdd") return "hdd";
  // "Unspecified" é o que o Windows devolve para muitos HDD SATA. Chamar-lhe
  // HDD seria adivinhar; chamar-lhe SSD seria pior.
  return "unknown";
}

export function healthStatusOf(raw: unknown): StorageDiskHealthStatus {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (text === "healthy") return "healthy";
  if (text === "warning") return "warning";
  if (text === "unhealthy") return "unhealthy";
  return "unknown";
}

/**
 * Classifica a falha dos contadores. O caso real medido nesta máquina é
 * `PermissionDenied` sem elevação — o texto do PowerShell vem em PT e em EN
 * conforme a instalação, por isso os dois são reconhecidos.
 */
export function classifyCountersError(message: string | null | undefined): {
  status: StorageCountersStatus;
  detail: string;
} {
  const text = String(message ?? "");
  if (/PermissionDenied|Acesso a um recurso CIM|não estava disponível para o cliente|access denied|privilege/i.test(text)) {
    return {
      status: "denied",
      detail:
        "O Windows exige elevação para ler os contadores de fiabilidade (temperatura, desgaste, horas e erros dos discos). Sem isso, esses valores ficam indisponíveis.",
    };
  }
  if (/não é reconhecido|CommandNotFound|not recognized|não foi encontrado/i.test(text)) {
    return {
      status: "unsupported",
      detail:
        "Este Windows não expõe o módulo Storage necessário para ler contadores de fiabilidade.",
    };
  }
  return {
    status: "unavailable",
    detail: text.trim()
      ? `A leitura dos contadores de fiabilidade falhou: ${text.trim().slice(0, 200)}`
      : "A leitura dos contadores de fiabilidade falhou sem mensagem do sistema.",
  };
}

const sanitizeTemperature = (v: unknown): number | null => {
  const n = toFinite(v);
  return n !== null && n >= -40 && n <= 150 ? Math.round(n) : null;
};
const sanitizePercent = (v: unknown): number | null => {
  const n = toFinite(v);
  return n !== null && n >= 0 && n <= 100 ? Math.round(n) : null;
};
const sanitizeHours = (v: unknown): number | null => {
  const n = toFinite(v);
  return n !== null && Number.isInteger(n) && n >= 0 && n <= 10_000_000 ? n : null;
};
const sanitizeCounter = (v: unknown): number | null => {
  const n = toFinite(v);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
};

const emptyCounters = {
  temperatureC: null,
  wearPercent: null,
  powerOnHours: null,
  readErrorsTotal: null,
  readErrorsUncorrected: null,
  writeErrorsTotal: null,
  writeErrorsUncorrected: null,
} as const;

const roundGb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

/**
 * Constrói a saúde publicável a partir das duas leituras cruas.
 * Puro: sem I/O, sem PowerShell.
 */
export function describeStorageHealth(input: {
  physicalDisks: unknown;
  counters?: unknown;
  countersError?: string | null;
}): StorageHealth {
  const disksRaw = asArray(input.physicalDisks);
  if (disksRaw.length === 0) {
    return {
      status: "unavailable",
      detail: "O Windows não devolveu nenhum disco físico.",
      disks: [],
    };
  }

  const failure = input.countersError ? classifyCountersError(input.countersError) : null;
  const countersRaw = asArray(input.counters);
  const countersById = new Map<string, Record<string, unknown>>();
  for (const c of countersRaw) {
    const id = typeof c.id === "string" || typeof c.id === "number" ? String(c.id) : "";
    if (id) countersById.set(id, c);
  }

  const disks: StorageDiskHealth[] = [];
  for (const raw of disksRaw) {
    const deviceId =
      raw.DeviceId === undefined || raw.DeviceId === null ? "" : String(raw.DeviceId).trim();
    if (!deviceId) continue; // sem identificador não é um disco que se possa acompanhar

    const sizeBytes = toFinite(raw.Size);
    const model = typeof raw.FriendlyName === "string" ? raw.FriendlyName.trim() : "";
    const counters = countersById.get(deviceId);

    let countersStatus: StorageCountersStatus;
    let countersDetail: string | null;
    let values: {
      temperatureC: number | null;
      wearPercent: number | null;
      powerOnHours: number | null;
      readErrorsTotal: number | null;
      readErrorsUncorrected: number | null;
      writeErrorsTotal: number | null;
      writeErrorsUncorrected: number | null;
    } = { ...emptyCounters };

    if (failure) {
      countersStatus = failure.status;
      countersDetail = failure.detail;
    } else if (!counters) {
      countersStatus = "unsupported";
      countersDetail = "Este disco não expôs contadores de fiabilidade.";
    } else {
      values = {
        temperatureC: sanitizeTemperature(counters.temperature),
        wearPercent: sanitizePercent(counters.wear),
        powerOnHours: sanitizeHours(counters.hours),
        readErrorsTotal: sanitizeCounter(counters.readErr),
        readErrorsUncorrected: sanitizeCounter(counters.readUnc),
        writeErrorsTotal: sanitizeCounter(counters.writeErr),
        writeErrorsUncorrected: sanitizeCounter(counters.writeUnc),
      };
      // O contador respondeu, mas isso não basta: `available` exige pelo menos
      // um valor UTILIZÁVEL. Um disco que devolve só nulls não tem SMART lido.
      const temValor = Object.values(values).some((v) => v !== null);
      if (temValor) {
        countersStatus = "available";
        countersDetail = null;
      } else {
        countersStatus = "invalid";
        countersDetail =
          "Os contadores foram lidos mas não devolveram nenhum valor utilizável.";
      }
    }

    disks.push({
      deviceId,
      model,
      mediaType: mediaTypeOf(raw.MediaType),
      busType: typeof raw.BusType === "string" && raw.BusType.trim() ? raw.BusType.trim() : null,
      sizeGb: sizeBytes !== null && sizeBytes > 0 ? roundGb(sizeBytes) : null,
      healthStatus: healthStatusOf(raw.HealthStatus),
      operationalStatus:
        typeof raw.OperationalStatus === "string" && raw.OperationalStatus.trim()
          ? raw.OperationalStatus.trim()
          : null,
      ...values,
      countersStatus,
      countersDetail,
    });
  }

  if (disks.length === 0) {
    return {
      status: "unavailable",
      detail: "Os discos devolvidos pelo Windows não tinham identificador utilizável.",
      disks: [],
    };
  }

  disks.sort((a, b) => (b.sizeGb ?? 0) - (a.sizeGb ?? 0));

  return {
    status: summarizeStatus(disks, failure),
    detail: failure ? failure.detail : summaryDetail(disks),
    disks,
  };
}

/**
 * Resumo global. Uma leitura de contadores nunca é "available" se nenhum
 * disco tiver um valor utilizável, e uma mistura não se apresenta como
 * disponibilidade total.
 */
function summarizeStatus(
  disks: StorageDiskHealth[],
  failure: { status: StorageCountersStatus } | null,
): StorageCountersStatus {
  if (failure) return failure.status;
  const counts = { available: 0, invalid: 0, unsupported: 0 } as Record<string, number>;
  for (const d of disks) counts[d.countersStatus] = (counts[d.countersStatus] ?? 0) + 1;
  if (counts.available === disks.length) return "available";
  if (counts.available > 0) return "partial";
  if (counts.invalid > 0) return "invalid";
  return "unsupported";
}

/** Explicação do estado global — números reais, não uma vaga impressão. */
function summaryDetail(disks: StorageDiskHealth[]): string | null {
  const withCounters = disks.filter((d) => d.countersStatus === "available").length;
  if (withCounters === disks.length) return null;
  if (withCounters > 0) {
    return `Suporte parcial: ${withCounters} de ${disks.length} discos expõem contadores de fiabilidade.`;
  }
  if (disks.some((d) => d.countersStatus === "invalid")) {
    return "Os contadores responderam, mas nenhum disco devolveu um valor utilizável.";
  }
  return "Nenhum disco expôs contadores de fiabilidade neste sistema.";
}

export type StorageRunner = (script: string) => Promise<{ stdout: string; error: string | null }>;

/** Runner de produção: PowerShell sem janela; o erro é capturado, não lançado. */
export const powershellRunner: StorageRunner = (script) => runHardwareQuery('storage-smart', async () => {
  try {
    const { stdout } = await execAsync(`powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`, {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 20_000,
    });
    return { stdout, error: null };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { stdout: "", error: (e.stderr && e.stderr.trim()) || e.message || "erro desconhecido" };
  }
}).catch(() => ({ stdout: '', error: 'Consulta de saúde dos discos não admitida ou cancelada.' }));

/**
 * Lê a saúde física. Não lança: uma falha total devolve `unavailable` com
 * motivo, para o snapshot poder dizer a verdade em vez de ficar sem campo.
 */
export async function readStorageHealth(run: StorageRunner = powershellRunner): Promise<StorageHealth> {
  const disksRead = await run(PS_DISKS);
  const physicalDisks = parseJsonOutput(disksRead.stdout);
  if (disksRead.error && !physicalDisks) {
    return { status: "unavailable", detail: classifyCountersError(disksRead.error).detail, disks: [] };
  }

  const countersRead = await run(PS_COUNTERS);
  const counters = countersRead.error ? null : parseJsonOutput(countersRead.stdout);

  return describeStorageHealth({
    physicalDisks,
    counters,
    countersError: countersRead.error,
  });
}
