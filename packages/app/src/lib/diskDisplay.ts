/**
 * ── ARMAZENAMENTO: dado → o que se LÊ no ecrã ────────────────────────────────
 *
 * Vive num módulo próprio por duas razões:
 *   1. **consistência**: Dashboard e PC Center respondem às mesmas perguntas
 *      ("há leitura?", "quanto está livre?", "qual é a unidade?") com as mesmas
 *      funções — antes cada ecrã inventava o seu formato e um deles escrevia
 *      `0.0%` quando não havia leitura nenhuma;
 *   2. **testabilidade**: puro e determinístico, portanto as regras de
 *      honestidade ("nunca 0% sem leitura", "partição reservada não é disco de
 *      trabalho") são verificadas por testes, não por inspeção visual.
 *
 * O tipo `DiskSnapshot` distingue `readStatus: "ok" | "stale" | "unavailable"` e
 * usa `null` (nunca 0) quando não há medição. Aqui só se formata — nenhuma
 * função deste ficheiro fabrica valores.
 */
import { useEffect, useState } from "react";
import type { DiskSnapshot, DiskVolumeSnapshot } from "@cybersafe/shared-types";

/**
 * Relógio de renderização para a idade de uma leitura ("há 2 min").
 *
 * Ler `Date.now()` dentro do render é impuro — e o lint está certo: um re-render
 * qualquer mudaria o texto sem o dado ter mudado. Com `useState` + intervalo, o
 * "agora" é estado normal, o render fica puro e a idade continua a atualizar-se
 * sozinha enquanto o serviço não publica uma leitura nova.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const nf1 = new Intl.NumberFormat("pt-PT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 0 });

/** Devolve o número se for finito, `null` caso contrário (NaN, Infinity, undefined, null). */
export function safeNumber(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) ? value : null;
}

/**
 * "953 GB" / "0,1 GB" — PT-PT. Nunca "NaN GB".
 *
 * Regra das duas réguas, igual à que `describeDiskSpace` já usa para o espaço
 * livre: a partir de 100 GB arredonda ao inteiro ("107 GB livres" lê-se melhor
 * que "106,8 GB livres" e não perde nada útil), abaixo disso mantém uma casa
 * decimal para não transformar uma partição pequena num zero.
 */
export const formatGb = (value: number): string => {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 100 ? nf0.format(value) : nf1.format(value)} GB`;
};

/** "88,8%" — nunca "NaN%". Sem leitura (null/undefined/NaN) passa por cima de "—". */
export const formatPercent = (value: number): string => {
  if (!Number.isFinite(value)) return "—";
  return `${nf1.format(value)}%`;
};

export type DiskReadTone = "ok" | "warn" | "unknown";

export function diskReadTone(disk: DiskSnapshot): DiskReadTone {
  if (disk.readStatus === "ok") return "ok";
  if (disk.readStatus === "stale") return "warn";
  return "unknown";
}

/** Etiqueta curta do estado da leitura. */
export function diskReadLabel(disk: DiskSnapshot): string {
  if (disk.readStatus === "ok") return "Medido agora";
  if (disk.readStatus === "stale") return "Última leitura válida";
  return "Indisponível";
}

/** Idade de uma leitura em linguagem de pessoa: "há 12 s", "há 3 min", "há 1 h 5 min". */
export function humanAge(ageMs: number): string | null {
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `há ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `há ${hours} h ${minutes % 60} min`;
}

/**
 * Porque não há (ou não é atual) a leitura, em PT-PT — e, quando existe um valor
 * bom retido, a idade desse valor. `null` quando a leitura está boa.
 */
export function diskUnavailableText(disk: DiskSnapshot, nowMs: number): string | null {
  if (disk.readStatus === "ok") return null;
  const reason = disk.reason ?? "Sem leitura do volume.";
  if (disk.readStatus === "stale" && disk.lastGoodAt) {
    const age = humanAge(nowMs - Date.parse(disk.lastGoodAt));
    if (age) return `${reason} Valores ${age}.`;
  }
  return reason;
}

/** Percentagem do volume principal: "—" quando não há leitura (NUNCA "0%"). */
export function diskUsagePercentText(disk: DiskSnapshot): string {
  return disk.usagePercent == null ? "—" : formatPercent(disk.usagePercent);
}

/** Espaço livre do volume principal: "107 GB livres" / "—" sem leitura. */
export function diskFreeText(disk: DiskSnapshot): string {
  if (!disk.primary || safeNumber(disk.primary.freeGb) === null) return "—";
  return `${formatGb(disk.primary.freeGb)} livres`;
}

/** Linha de detalhe do volume principal: "C: · 953 GB no total · 88,8% usado". */
export function diskDetailText(disk: DiskSnapshot): string {
  const primary = disk.primary;
  if (!primary || safeNumber(primary.totalGb) === null || safeNumber(primary.usagePercent) === null) {
    return "sem leitura do volume";
  }
  return `${primary.mount} · ${formatGb(primary.totalGb)} no total · ${formatPercent(primary.usagePercent)} usado`;
}

/** Outros volumes de trabalho (além do principal), numa linha compacta. */
export function diskOtherVolumesText(disk: DiskSnapshot): string | null {
  const others = disk.volumes.filter(
    (volume) => volume.kind === "working" && volume.mount !== disk.primary?.mount,
  );
  if (others.length === 0) return null;
  return others.map((volume) => `${volume.mount} ${formatGb(volume.freeGb)} livres`).join(" · ");
}

/** Partições reservadas do sistema (não são discos de trabalho e não geram alarme). */
export function diskReservedVolumesText(disk: DiskSnapshot): string | null {
  const reserved = disk.volumes.filter((volume) => volume.kind === "system-reserved");
  if (reserved.length === 0) return null;
  return reserved
    .map((volume) => `${volume.mount} partição de sistema (${formatGb(volume.totalGb)})`)
    .join(" · ");
}

export interface DiskVolumeRow {
  mount: string;
  fileSystem: string;
  kindLabel: string;
  usedText: string;
  totalText: string;
  freeText: string;
  usagePercentText: string;
  usagePercent: number;
  kind: DiskVolumeSnapshot["kind"];
  /**
   * Distinção explícita: volumes lógicos (letras de unidade C:, D:) vs discos
   * físicos (hardware). ESTE MODELO NUNCA contém dados de disco físico — não
   * há modelo, serial, SMART ou saúde aqui. Cada linha é sempre "logical".
   */
  volumeKind: "logical";
}

/** Linhas por unidade para o PC Center (capacidade, usado, livre e percentagem). */
export function diskVolumeRows(disk: DiskSnapshot): DiskVolumeRow[] {
  return disk.volumes.map((volume) => ({
    mount: volume.mount,
    fileSystem: volume.fileSystem,
    kindLabel: volume.kind === "system-reserved" ? "Partição de sistema" : "Volume de trabalho",
    usedText: formatGb(volume.usedGb),
    totalText: formatGb(volume.totalGb),
    freeText: formatGb(volume.freeGb),
    usagePercentText: formatPercent(volume.usagePercent),
    usagePercent: safeNumber(volume.usagePercent) ?? 0,
    kind: volume.kind,
    volumeKind: "logical",
  }));
}
