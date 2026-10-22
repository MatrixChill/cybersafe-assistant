/**
 * TP-UPDATE-UI (17/10) — modelo PURO da secção "Atualizações".
 *
 * Transforma o snapshot REAL do contrato (`AppUpdateSnapshot`,
 * `shared-types/src/app-update.ts`) em texto e decisões de UI. Regras:
 *  - sem `totalBytes` não há percentagem: o progresso é declarado
 *    indeterminado com os bytes reais que existirem;
 *  - o botão "Instalar" só fica ativo com `status === "downloaded"` e
 *    `canInstall === true` (é o main que verifica integridade/publicador —
 *    a UI nunca decide isso por si);
 *  - build/commit em falta dizem-se "desconhecida/desconhecido";
 *  - mensagens de erro saem do CÓDIGO real do contrato, não de texto livre.
 */
import type { AppUpdateErrorCode, AppUpdateSnapshot, AppUpdateStatus } from "@cybersafe/shared-types";

const STATUS_LABELS: Record<AppUpdateStatus, string> = {
  unconfigured: "Não configurado",
  unsupported: "Não suportado",
  idle: "Pronto",
  checking: "A verificar…",
  "up-to-date": "Atualizado",
  available: "Atualização disponível",
  downloading: "A transferir…",
  verifying: "A verificar integridade…",
  downloaded: "Transferida",
  deferred: "Adiada",
  installing: "A instalar…",
  error: "Erro",
};

const ERROR_MESSAGES: Record<AppUpdateErrorCode, string> = {
  offline: "Sem ligação à internet.",
  timeout: "A operação excedeu o tempo limite.",
  "invalid-manifest": "A resposta do servidor não é um manifesto válido.",
  "untrusted-metadata": "Os metadados da atualização não são de confiança.",
  integrity: "A verificação de integridade falhou.",
  publisher: "O publicador da atualização não é de confiança.",
  downgrade: "A versão disponível é mais antiga do que a instalada.",
  interrupted: "A transferência foi interrompida.",
  cancelled: "Operação cancelada.",
  busy: "Já existe uma operação em curso.",
  unsupported: "Operação não suportada nesta instalação.",
  unconfigured: "As atualizações ainda não estão configuradas neste build.",
  installation: "A instalação falhou.",
  internal: "Erro interno do atualizador.",
};

/** O código vem do IPC em runtime — a busca é defensiva, nunca lança. */
export function errorCodeMessage(code: AppUpdateErrorCode): string {
  const known = ERROR_MESSAGES as Record<string, string>;
  return known[code] ?? "Erro do atualizador.";
}

/** Rótulo do estado para o chip; um estado desconhecido mostra-se tal como veio. */
export function statusLabel(status: string): string {
  const known = STATUS_LABELS as Record<string, string>;
  return known[status] ?? status;
}

/** Formatação determinística (sem Intl): vírgula decimal, 1 casa daqui para cima. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(".", ",");
  return `${text} ${units[unit]}`;
}

export interface ProgressInfo {
  text: string;
  /** null = indeterminado (sem total real). Nunca uma percentagem inventada. */
  percent: number | null;
}

export function progressInfo(progress: { downloadedBytes: number; totalBytes?: number }): ProgressInfo {
  const downloaded = formatBytes(progress.downloadedBytes);
  if (typeof progress.totalBytes === "number" && progress.totalBytes > 0) {
    const raw = (progress.downloadedBytes / progress.totalBytes) * 100;
    const percent = Math.max(0, Math.min(100, Math.floor(raw)));
    return { text: `${downloaded} de ${formatBytes(progress.totalBytes)} (${percent}%)`, percent };
  }
  return { text: `${downloaded} transferidos — total ainda por determinar`, percent: null };
}

/** Frase principal do estado (região aria-live). */
export function statusSummary(snapshot: AppUpdateSnapshot): string {
  switch (snapshot.status) {
    case "unconfigured":
      return "As atualizações ainda não estão configuradas neste build — nada é transferido nem instalado.";
    case "unsupported":
      return "Esta instalação não suporta atualização automática.";
    case "idle":
      return "Podes verificar se existe uma versão mais recente.";
    case "checking":
      return "A verificar se existe uma versão mais recente…";
    case "up-to-date":
      return "Está na versão mais recente.";
    case "available":
      return snapshot.latest
        ? `Está disponível a versão v${snapshot.latest.version}.`
        : "Está disponível uma atualização.";
    case "downloading":
      return "A transferir a atualização…";
    case "verifying":
      return "A verificar a integridade da transferência…";
    case "downloaded":
      return snapshot.canInstall
        ? "Transferência concluída e verificada — podes instalar."
        : "Transferência concluída; as verificações de segurança ainda não permitem instalar.";
    case "deferred":
      return "Atualização adiada. Podes voltar a verificar quando quiseres.";
    case "installing":
      return "Instalação em curso. Não feches a aplicação.";
    case "error":
      return snapshot.error ? `Erro: ${errorCodeMessage(snapshot.error.code)}` : "Ocorreu um erro inesperado.";
  }
}

export interface InstalledInfo {
  version: string;
  build: string;
  commit: string;
}

/** Versão instalada REAL (vem do main); sem dados diz-se desconhecida. */
export function formatInstalled(installed: { version: string; build?: string; commit?: string }): InstalledInfo {
  return {
    version: installed.version ? `v${installed.version}` : "desconhecida",
    build: installed.build && installed.build.length > 0 ? installed.build : "desconhecida",
    commit: installed.commit && installed.commit.length > 0 ? installed.commit : "desconhecido",
  };
}

/** Data real da publicação; uma data inválida mostra-se tal como veio. */
export function formatPublishedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("pt-PT", { dateStyle: "medium" }).format(date);
  } catch {
    return iso;
  }
}

export interface UpdateControls {
  check: boolean;
  download: boolean;
  cancel: boolean;
  defer: boolean;
  install: boolean;
  automatic: boolean;
}

/** Regras de disponibilidade dos controlos, derivadas do estado REAL. */
export function deriveControls(
  snapshot: AppUpdateSnapshot | null,
  busy: string | null,
  bridgeAvailable: boolean,
): UpdateControls {
  const status = snapshot?.status ?? null;
  const idle = busy === null && bridgeAvailable && snapshot !== null;
  const blockedWhenIdle: string[] = ["unconfigured", "unsupported", "checking", "downloading", "verifying", "installing"];
  return {
    check: idle && status !== null && !blockedWhenIdle.includes(status),
    download: idle && status === "available",
    cancel: idle && (status === "downloading" || status === "verifying"),
    defer: idle && (status === "available" || status === "downloaded"),
    install: idle && status === "downloaded" && snapshot?.canInstall === true,
    automatic: idle && status !== "unconfigured" && status !== "unsupported",
  };
}

export function checkButtonLabel(snapshot: AppUpdateSnapshot): string {
  return snapshot.status === "up-to-date" || snapshot.status === "error" || snapshot.status === "deferred"
    ? "Verificar novamente"
    : "Verificar atualizações";
}
