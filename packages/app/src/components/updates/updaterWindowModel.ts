import type { AppUpdateSnapshot } from "@cybersafe/shared-types";
import { errorCodeMessage, progressInfo } from "./appUpdateModel";
export type UpdaterPhase = "authenticating" | "confirming" | "restarting" | "idle" | "checking" | "available" | "downloading" | "verifying" | "preparing" | "installing" | "completed" | "error" | "current" | "unavailable" | "ready";
export type UpdaterAction = "check" | "download" | "install" | "retry" | "retry-check" | "retry-download" | "open";
export interface UpdaterWindowView {
  phase: UpdaterPhase; currentVersion: string; nextVersion?: string; percent: number | null;
  cancelable: boolean; primaryAction?: UpdaterAction; detail?: string; notes?: string;
}
export const updaterCopy: Record<UpdaterPhase, { title: string; description: string; helper: string; security: string }> = {
  authenticating: {title:"A verificar autenticidade",description:"A validar a origem e a assinatura do instalador.",helper:"Só prossiga após confirmação das verificações pelo atualizador.",security:"Autenticidade por confirmar"},
  confirming: {title:"A aguardar a sua confirmação",description:"Reveja a atualização antes de autorizar a instalação.",helper:"Nada será instalado sem consentimento.",security:"A autorização será revalidada pelo atualizador"},
  restarting: {title:"A aguardar reinício",description:"A instalação ainda precisa de confirmação após o arranque.",helper:"Siga a indicação do atualizador para reabrir a aplicação.",security:"Versão instalada ainda não confirmada"},
  idle: { title: "Atualizador CyberSafe", description: "Procure uma versão mais recente quando quiser.", helper: "Nenhuma atualização está em curso.", security: "Nenhuma transferência ou instalação em curso" },
  checking: { title: "A procurar atualizações", description: "A consultar a disponibilidade de uma nova versão do CyberSafe.", helper: "Pode continuar a utilizar a aplicação.", security: "Verificações de segurança ainda não concluídas" },
  available: { title: "Uma nova versão está disponível", description: "Reveja a versão e as novidades antes de descarregar.", helper: "A instalação requer a sua confirmação.", security: "O instalador será verificado após a transferência" },
  downloading: { title: "A descarregar a atualização", description: "A transferir os ficheiros necessários para este computador.", helper: "Pode cancelar a transferência.", security: "Integridade e autenticidade por verificar" },
  verifying: { title: "A verificar a atualização", description: "A verificar integridade e autenticidade do instalador.", helper: "A instalação permanece bloqueada até às verificações necessárias.", security: "Verificações de segurança em curso" },
  preparing: { title: "A preparar a instalação", description: "A preparar os ficheiros e a verificar as condições de instalação.", helper: "Aguarde pela confirmação do atualizador.", security: "A aguardar confirmação das condições de instalação" },
  installing: { title: "A instalar a atualização", description: "A aplicar a nova versão do CyberSafe Assistant.", helper: "Não desligue o computador. O reinício será indicado pelo atualizador.", security: "Instalação em curso — conclusão por confirmar" },
  completed: { title: "Atualização concluída", description: "A nova versão foi confirmada após o arranque.", helper: "Pode abrir o CyberSafe Assistant.", security: "Versão instalada confirmada" },
  error: { title: "Não foi possível concluir a atualização", description: "A operação foi interrompida. Consulte o motivo antes de tentar novamente.", helper: "Nenhuma conclusão de instalação foi confirmada.", security: "Atualização não confirmada" },
  current: { title: "Sem atualização disponível", description: "A consulta não encontrou uma versão mais recente.", helper: "Pode voltar a verificar mais tarde.", security: "Consulta concluída; não foi instalado nenhum ficheiro" },
  unavailable: { title: "Atualizações indisponíveis", description: "Este ambiente ainda não permite atualizar a aplicação.", helper: "Os controlos de produção permanecem bloqueados.", security: "Nenhuma transferência ou instalação autorizada" },
  ready: { title: "Atualização descarregada", description: "Reveja as condições antes de confirmar a instalação.", helper: "A autorização final pertence ao atualizador.", security: "Consulte as condições de instalação" },
};
/** Conservative adapter: the existing snapshot cannot prove preparation or post-boot completion. */
export function mapUpdaterSnapshot(snapshot: AppUpdateSnapshot): UpdaterWindowView {
  const phases: Record<AppUpdateSnapshot["status"], UpdaterPhase> = { unconfigured: "unavailable", unsupported: "unavailable", idle: "idle", checking: "checking", "up-to-date": "current", available: "available", downloading: "downloading", verifying: "verifying", downloaded: snapshot.canInstall?"confirming":"ready", deferred: "idle", installing: "installing", error: "error" };
  const status = snapshot.status;
  const primaryAction: UpdaterAction | undefined = status === "available" ? "download" : status === "downloaded" && snapshot.canInstall ? "install" : ["idle", "deferred", "up-to-date"].includes(status) ? "check" : status === "error" ? "retry-check" : undefined;
  return {
phase: phases[status], currentVersion: snapshot.installed.version, nextVersion: snapshot.latest?.version,
    percent: status === "downloading" && snapshot.progress ? progressInfo(snapshot.progress).percent : null,
    cancelable: status === "downloading", primaryAction, notes: snapshot.latest?.notes,
    detail: snapshot.error ? errorCodeMessage(snapshot.error.code) : snapshot.channel === "preview" ? "Canal Preview: Setup sem Authenticode; editor não verificado pelo Windows. A instalação é interativa e requer a sua confirmação." : status === "downloaded" && !snapshot.canInstall ? "A instalação está bloqueada pelas condições de segurança." : status === "idle" || status === "deferred" ? "Nenhuma atualização em curso." : undefined
};
}
