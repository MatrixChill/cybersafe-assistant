import type {ReactNode} from "react";
import { ArrowDownToLine, ArrowRight, Check, RefreshCw, Shield, ShieldCheck, ShieldAlert, X } from "lucide-react";
import { publicAssetUrl } from "../../lib/publicAssetUrl";
import { updaterCopy, type UpdaterAction, type UpdaterWindowView } from "./updaterWindowModel";
export interface UpdaterWindowProps {
  illustration?: ReactNode; view: UpdaterWindowView; demo?: boolean; onAction?: (action: UpdaterAction) => void; onCancel?: () => void; onClose?: () => void;
}
const actionLabels: Record<UpdaterAction, string> = { check: "Procurar atualizações", download: "Descarregar atualização", install: "Rever instalação", retry: "Tentar novamente", open: "Abrir aplicação" };
export function UpdaterWindow({ view, demo = false, onAction, onCancel, onClose, illustration }: UpdaterWindowProps) {
  const copy = updaterCopy[view.phase];
  const busy = ["checking", "downloading", "verifying", "authenticating", "preparing", "installing", "restarting"].includes(view.phase);
  const percent = view.phase === "downloading" && view.percent !== null && Number.isFinite(view.percent) ? Math.max(0, Math.min(100, Math.floor(view.percent))) : null;
  const failed = view.phase === "error"; const complete = view.phase === "completed";
  return <section className="updater-window" aria-labelledby="updater-title" data-phase={view.phase}>
    <header className="updater-header"><div className="updater-brand"><img src={publicAssetUrl("branding", "cybersafe", "symbol-flat-48.png")} width="40" height="40" alt="" /><div><strong>CyberSafe Assistant</strong><span>Atualização da aplicação Windows</span></div></div><button className="updater-icon-button" onClick={onClose} disabled={!onClose} aria-label="Fechar janela de atualização"><X size={18} /></button></header>
    {demo && <div className="updater-demo" role="note">Demonstração visual · Nenhuma atualização real é executada</div>}
    <div className="updater-body">{illustration??<div className="updater-art" aria-hidden="true" data-moving={busy}><span className="updater-orbit updater-orbit-one" /><span className="updater-orbit updater-orbit-two" /><div className="updater-emblem"><img src={publicAssetUrl("branding", "cybersafe", "symbol-flat-256.png")} width="128" height="128" alt="" /></div><span className="updater-art-label">CYBERSAFE / UPDATE</span></div>}
      <div className="updater-content"><p className="updater-eyebrow">{failed ? "Operação interrompida" : complete ? "Pronto para continuar" : "ATUALIZAÇÃO / WINDOWS"}</p><div role="status" aria-live="polite" aria-atomic="true"><h1 id="updater-title">{copy.title}</h1><p className="updater-description">{copy.description}</p></div>
        <dl className="updater-versions"><div><dt>Versão atual</dt><dd>{view.currentVersion || "Não confirmada"}</dd></div><ArrowRight size={16} aria-hidden="true" /><div><dt>Nova versão</dt><dd>{view.nextVersion || "Por determinar"}</dd></div></dl>
        {busy && <div className="updater-progress-area"><div className="updater-progress-label"><span>{view.phase === "downloading" ? "Transferência" : "Operação em curso"}</span><span>{percent === null ? "Aguarde…" : `${percent}%`}</span></div><div className="updater-progress" role="progressbar" aria-label={copy.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}><span className={percent === null ? "is-indeterminate" : ""} style={percent === null ? undefined : { width: `${percent}%` }} /></div></div>}
        {view.detail && <p className="updater-detail" role={failed ? "alert" : undefined}>{view.detail}</p>}
        {view.notes && <details className="updater-notes"><summary>Novidades desta versão</summary><p>{view.notes}</p></details>}
        <p className="updater-helper">{copy.helper}</p>
      </div></div>
    <footer className="updater-footer"><div className="updater-security">{failed ? <ShieldAlert size={18} /> : complete ? <ShieldCheck size={18} /> : <Shield size={18} />}<span>{copy.security}</span></div><div className="updater-actions">{view.cancelable && <button className="updater-button" onClick={onCancel} disabled={!onCancel}>Cancelar</button>}{view.primaryAction && <button className="updater-button updater-primary" disabled={!onAction} onClick={() => onAction?.(view.primaryAction!)}>{complete ? <Check size={16} /> : view.primaryAction === "retry" ? <RefreshCw size={16} /> : <ArrowDownToLine size={16} />} {actionLabels[view.primaryAction]}</button>}</div></footer>
  </section>;
}
