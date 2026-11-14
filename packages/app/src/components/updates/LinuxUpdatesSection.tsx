/**
 * Definições → «Atualizações» no CyberSafe para Linux (pacote Arch).
 * Usa o canal IPC `linuxUpdate` (cybersafe-linux-update). A instalação só
 * acontece depois de uma confirmação explícita e da autorização do sistema.
 */
import { useState } from "react";
import { linuxUpdateView, type LinuxUpdateWire } from "@/lib/linuxUpdateModel";

type Busy = null | "check" | "download" | "install";
const TONE: Record<string, string> = {
  ok: "text-cyber-green", info: "text-primary", warn: "text-cyber-yellow", error: "text-cyber-red", neutral: "text-foreground",
};

export function LinuxUpdatesSection() {
  const api = typeof window !== "undefined" ? window.electronAPI?.linuxUpdate : undefined;
  const [wire, setWire] = useState<LinuxUpdateWire | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirming, setConfirming] = useState(false);
  const view = linuxUpdateView(wire);

  const run = async (kind: Exclude<Busy, null>, call: () => Promise<LinuxUpdateWire>) => {
    setBusy(kind);
    try { setWire(await call()); } catch { setWire({ ok: false, result: null, error: "invalid-response" }); }
    finally { setBusy(null); }
  };

  if (!api) return null;
  return (
    <section data-linux-updates className="surface-elevated cyber-border rounded-xl p-6 space-y-3">
      <div>
        <h3 className={`font-semibold ${TONE[view.tone]}`}>{view.title}</h3>
        {view.detail && <p className="text-sm text-muted-foreground mt-1">{view.detail}</p>}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-mono text-muted-foreground">
        <dt>Versão instalada</dt><dd className="text-foreground">{view.installed ?? "—"}</dd>
        <dt>Versão disponível</dt><dd className="text-foreground">{view.available ?? "—"}</dd>
        {view.sizeText && (<><dt>Tamanho</dt><dd className="text-foreground">{view.sizeText}</dd></>)}
        {view.channel && (<><dt>Canal</dt><dd className="text-foreground">{view.channel}</dd></>)}
        <dt>Última verificação</dt><dd className="text-foreground">{view.checkedAt ? new Date(view.checkedAt).toLocaleString("pt-PT") : "—"}</dd>
      </dl>
      {view.signatureText && <p className="text-xs text-cyber-green">{view.signatureText}</p>}
      {view.downloadText && <p className="text-xs text-muted-foreground">{view.downloadText}</p>}
      {view.notes && <p className="text-xs text-muted-foreground whitespace-pre-line border-l-2 border-border pl-3">{view.notes}</p>}
      {busy === "download" && <p className="text-xs text-muted-foreground">A descarregar e a verificar… (pode demorar alguns minutos)</p>}

      {confirming ? (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <p className="text-sm">Instalar a versão {view.available ?? "nova"}? O sistema vai pedir a sua autorização e o pacman faz a instalação.</p>
          <div className="flex gap-2">
            <button type="button" className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm" disabled={busy !== null}
              onClick={() => { setConfirming(false); void run("install", () => api.install(true)); }}>Confirmar e instalar</button>
            <button type="button" className="px-3 py-1.5 rounded-md border border-border text-sm" onClick={() => setConfirming(false)}>Cancelar</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="px-3 py-1.5 rounded-md border border-border text-sm" disabled={busy !== null}
            onClick={() => void run("check", api.check)}>{busy === "check" ? "A verificar…" : "Verificar atualizações"}</button>
          {view.canDownload && (
            <button type="button" className="px-3 py-1.5 rounded-md border border-border text-sm" disabled={busy !== null}
              onClick={() => void run("download", api.download)}>Descarregar</button>
          )}
          {view.canInstall && (
            <button type="button" className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm" disabled={busy !== null}
              onClick={() => setConfirming(true)}>Atualizar</button>
          )}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Separado das atualizações de assinaturas antivírus. Preferências do canal: <code>cybersafe-linux-update prefs --stable | --experimental</code>.
      </p>
    </section>
  );
}
