/**
 * Copy do menu da tray — módulo puro (sem Electron) para ser testável.
 *
 * Regra de produto: o utilizador nunca vê enums internos do backend
 * ("safe", "attention", "degraded", "critical", ...). Todo o estado é
 * traduzido para português apresentável e os valores vêm sempre do estado
 * REAL do serviço (nunca inventados).
 */

export interface TrayProtectionInfo {
  /** O serviço de proteção está vivo (motores a funcionar). */
  serviceRunning: boolean;
  /** Estado bruto do backend. Só serve para tradução/logs — nunca é mostrado cru. */
  status: string | null;
  /** Pontuação de proteção (100 − riskScore), 0–100, ou null se indisponível. */
  score: number | null;
  /** Eventos de severidade alta recentes. */
  threats: number | null;
  /** Itens em quarentena. */
  quarantine: number | null;
}

/** Tradução dos estados internos. A chave em inglês nunca chega à UI. */
export const PROTECTION_STATUS_LABELS: Record<string, string> = {
  safe: "Protegida",
  attention: "Atenção",
  warning: "Atenção",
  degraded: "Precisa de atenção",
  critical: "Crítica",
  paused: "Pausada",
  unavailable: "Indisponível",
};

/** Estado desconhecido: mostramos indisponível em vez de vazar o enum. */
export const PROTECTION_STATUS_UNKNOWN = "Indisponível";

export function protectionStatusLabel(status?: string | null): string {
  if (typeof status !== "string") return PROTECTION_STATUS_UNKNOWN;
  return PROTECTION_STATUS_LABELS[status.trim().toLowerCase()] ?? PROTECTION_STATUS_UNKNOWN;
}

export function serviceStatusLine(serviceRunning: boolean): string {
  return serviceRunning ? "● Serviço ativo" : "○ Serviço parado";
}

/** Linha de proteção: "Proteção: Precisa de atenção · 55/100". */
export function protectionLine(info: TrayProtectionInfo): string {
  const label = protectionStatusLabel(info.status);
  const score =
    typeof info.score === "number" && Number.isFinite(info.score)
      ? Math.round(info.score)
      : null;
  return score === null ? `Proteção: ${label}` : `Proteção: ${label} · ${score}/100`;
}

/** Linhas de contadores. null = sem dado real, a linha é omitida. */
export function threatsLine(threats: number | null): string | null {
  return typeof threats === "number" && Number.isFinite(threats)
    ? `Ameaças recentes: ${threats}`
    : null;
}

export function quarantineLine(quarantine: number | null): string | null {
  return typeof quarantine === "number" && Number.isFinite(quarantine)
    ? `Em quarentena: ${quarantine}`
    : null;
}

export interface TrayMenuItem {
  label?: string;
  enabled?: boolean;
  type?: "separator";
  click?: () => void;
}

export interface TrayMenuHandlers {
  open: () => void;
  exit: () => void;
}

/**
 * Template do menu da tray:
 *
 *   CyberSafe
 *   ● Serviço ativo
 *   Proteção: Precisa de atenção · 55/100
 *   Ameaças recentes: 0
 *   Em quarentena: 6
 *   ────────────
 *   Abrir CyberSafe
 *   Sair do CyberSafe...
 */
export function buildTrayMenuTemplate(
  info: TrayProtectionInfo,
  handlers: TrayMenuHandlers,
): TrayMenuItem[] {
  const items: TrayMenuItem[] = [
    { label: "CyberSafe", enabled: false },
    { label: serviceStatusLine(info.serviceRunning), enabled: false },
    { label: protectionLine(info), enabled: false },
  ];

  const threats = threatsLine(info.threats);
  if (threats) items.push({ label: threats, enabled: false });

  const quarantine = quarantineLine(info.quarantine);
  if (quarantine) items.push({ label: quarantine, enabled: false });

  items.push({ type: "separator" });
  items.push({ label: "Abrir CyberSafe", click: handlers.open });
  items.push({ label: "Sair do CyberSafe...", click: handlers.exit });

  return items;
}
