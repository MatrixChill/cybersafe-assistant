// Apresentação da saúde FÍSICA dos discos no PC Center.
//
// Regras que este módulo garante (revisão do Codex):
// - «Healthy» do Windows NÃO significa que os atributos SMART estão
//   disponíveis: são duas informações distintas e aparecem em linhas distintas.
// - Sem contadores não há percentagem nem 0% de desgaste — há «Indisponível» ou
//   «Sem permissões», com o motivo.
// - O estado físico nunca se mistura com espaço livre (esse já tem o seu cartão).
// - A data mostrada é a da última leitura REAL; quando expira, diz-se expirada.

import type { DiskSnapshot, StorageDiskSnapshot } from "@cybersafe/shared-types";
import { snapshotAgeText } from "./batteryDisplay";

export interface StorageReading {
  label: string;
  value: string;
}

export interface StorageDiskView {
  deviceId: string;
  title: string;
  subtitle: string;
  windowsHealthText: string;
  countersText: string;
  /** Estado bruto do disco; o painel só repete o aviso global quando DIFERE. */
  countersStatus: StorageDiskSnapshot["countersStatus"];
  countersHint: string | null;
  readings: StorageReading[];
  missingReadingNote: string | null;
}

export interface StorageHealthView {
  available: boolean;
  /** Estado global dos contadores, sem inventar `available` quando falta leitura. */
  overallStatus: NonNullable<DiskSnapshot["physicalStatus"]>;
  overallText: string;
  overallHint: string | null;
  updatedText: string | null;
  staleText: string | null;
  errorText: string | null;
  disks: StorageDiskView[];
  /**
   * A ocupação é medida por volume; o contrato não a liga a um disco físico.
   * Quando ambos existem, este texto explica por que não se atribui espaço a um disco.
   */
  occupationNote: string | null;
}

const mediaLabel = (media: StorageDiskSnapshot["mediaType"]): string => {
  if (media === "ssd") return "SSD";
  if (media === "hdd") return "HDD";
  return "Tipo não reportado";
};

const healthLabel = (status: StorageDiskSnapshot["healthStatus"]): string => {
  if (status === "healthy") return "saudável";
  if (status === "warning") return "aviso";
  if (status === "unhealthy") return "degradado";
  return "desconhecido";
};

/** "596,2 GB" — vírgula PT, sem decimal quando é inteiro. */
function formatGb(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const text = value.toFixed(1);
  return `${text.endsWith(".0") ? text.slice(0, -2) : text.replace(".", ",")} GB`;
}

const countersTextOf = (status: StorageDiskSnapshot["countersStatus"]): string => {
  if (status === "available") return "Contadores de fiabilidade: disponíveis";
  if (status === "partial") return "Contadores de fiabilidade: parciais";
  if (status === "invalid") return "Contadores de fiabilidade: sem valores utilizáveis";
  if (status === "denied") return "Contadores de fiabilidade: sem permissões";
  if (status === "unsupported") return "Contadores de fiabilidade: não suportados";
  return "Contadores de fiabilidade: indisponíveis";
};

function diskView(disk: StorageDiskSnapshot): StorageDiskView {
  const size = formatGb(disk.sizeGb) ?? "Capacidade não reportada";
  const bus = disk.busType ? disk.busType : null;
  const subtitle = [mediaLabel(disk.mediaType), bus, size].filter(Boolean).join(" · ");

  // Só com contadores validados é que existem leituras para mostrar. Um
  // produtor que deixe números num disco `denied`/`unsupported` não os publica
  // por este caminho — o estado manda, não a presença do campo.
  const readings: StorageReading[] = [];
  if (disk.countersStatus === "available") {
    if (disk.temperatureC !== null) readings.push({ label: "Temperatura", value: `${disk.temperatureC} °C` });
    if (disk.wearPercent !== null) readings.push({ label: "Desgaste", value: `${disk.wearPercent}%` });
    if (disk.powerOnHours !== null) readings.push({ label: "Horas de utilização", value: `${disk.powerOnHours} h` });
    if (disk.readErrorsTotal !== null) readings.push({ label: "Erros de leitura", value: String(disk.readErrorsTotal) });
    if (disk.writeErrorsTotal !== null) readings.push({ label: "Erros de escrita", value: String(disk.writeErrorsTotal) });
  }

  const semLeituras =
    readings.length === 0
      ? disk.countersStatus === "denied"
        ? "Sem permissões para ler temperatura, desgaste e horas."
        : disk.countersStatus === "unsupported"
          ? "Este disco não expõe temperatura, desgaste nem horas."
          : "Os contadores não devolveram valores utilizáveis."
      : null;

  return {
    deviceId: disk.deviceId,
    title: disk.model || `Disco ${disk.deviceId}`,
    subtitle: subtitle || "Capacidade não reportada",
    // Linha separada de propósito: o estado do Windows não valida o SMART.
    windowsHealthText: `Windows: ${healthLabel(disk.healthStatus)}`,
    countersText: countersTextOf(disk.countersStatus),
    countersStatus: disk.countersStatus,
    countersHint: disk.countersDetail,
    readings,
    missingReadingNote: semLeituras,
  };
}

const overallOf = (
  status: NonNullable<DiskSnapshot["physicalStatus"]>,
  detail: string | null | undefined,
): { text: string; hint: string | null } => {
  switch (status) {
    case "available":
      return { text: "Contadores SMART disponíveis", hint: null };
    case "partial":
      return { text: "Contadores SMART parciais", hint: detail ?? null };
    case "invalid":
      return { text: "Contadores SMART sem valores utilizáveis", hint: detail ?? null };
    case "denied":
      return { text: "Sem permissões para contadores SMART", hint: detail ?? null };
    case "unsupported":
      return { text: "Contadores SMART não suportados", hint: detail ?? null };
    default:
      return { text: "Leitura da saúde física indisponível", hint: detail ?? null };
  }
};

export function storageHealthView(
  disk: DiskSnapshot | null | undefined,
  nowMs: number = Date.now(),
): StorageHealthView {
  const physical = disk?.physical;
  if (!disk || !physical) {
    return {
      available: false,
      overallStatus: "unavailable",
      overallText: "Saúde física indisponível",
      overallHint: "Ainda não há leitura da saúde física dos discos.",
      updatedText: null,
      staleText: null,
      errorText: null,
      disks: [],
      occupationNote: null,
    };
  }

  const status = disk.physicalStatus ?? "unavailable";
  const overall = overallOf(status, disk.physicalDetail);
  const age = snapshotAgeText(disk.physicalUpdatedAt, nowMs);
  const updatedText = age ? `Última leitura ${age}` : null;
  const staleText = disk.physicalStale
    ? age
      ? `Dados expirados: a última leitura foi ${age}. Não há uma medição nova.`
      : "Dados expirados: a hora da última leitura não está disponível."
    : null;

  return {
    available: physical.length > 0,
    overallStatus: status,
    overallText: overall.text,
    overallHint: overall.hint,
    updatedText,
    staleText,
    errorText: disk.physicalErrorDetail ?? null,
    disks: physical.map(diskView),
    // Sem um campo de contrato que ligue `volumes[]` a `physical[]`, casar por
    // nome, letra ou índice seria fabricar uma associação. A ocupação continua
    // na lista de volumes (acima) e a saúde física fica separada.
    occupationNote:
      physical.length > 0 && disk.volumes.length > 0
        ? "A ocupação e o espaço livre acima são medidos por volume. O contrato atual não associa cada volume a um disco físico, por isso não se atribui espaço livre a um disco."
        : null,
  };
}

/**
 * O resumo por disco repete o estado dos contadores quando ele DIFERE do global.
 * Com o global `denied` e o disco também `denied`, o aviso já foi dado uma vez;
 * não se repete a mesma frase em cada linha.
 */
export function estadoContadoresPorDisco(
  global: NonNullable<DiskSnapshot["physicalStatus"]>,
  disco: StorageDiskSnapshot["countersStatus"],
): string | null {
  return global === "denied" && disco === "denied" ? null : countersTextOf(disco);
}
