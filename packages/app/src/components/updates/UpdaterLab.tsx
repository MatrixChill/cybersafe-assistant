import { useState } from "react";
import { UpdaterExperience } from "./UpdaterExperience";
import {AppearanceProvider} from "../../contexts/AppearanceContext";
import { updaterCopy, type UpdaterPhase, type UpdaterWindowView } from "./updaterWindowModel";
import "./updater-window.css";
const phases: UpdaterPhase[] = ["checking", "available", "downloading", "verifying", "authenticating", "preparing", "confirming", "installing", "restarting", "completed", "error", "current"];
/** No updater hook, preload or network: explicit manual visual fixtures only. */
export default function UpdaterLab() {
  const [phase, setPhase] = useState<UpdaterPhase>("downloading");
  const [notice, setNotice] = useState("");
  const [unknown, setUnknown] = useState(false);
  const [forceStatic,setForceStatic]=useState(false);
  const view: UpdaterWindowView = { phase, currentVersion: "0.2.0-rc.1", nextVersion: "0.2.0 (exemplo)", percent: phase === "downloading" && !unknown ? 64 : null, cancelable: phase === "downloading" || phase === "verifying", primaryAction: phase === "confirming"?"install":phase === "available" ? "download" : phase === "completed" ? "open" : phase === "error" ? "retry" : phase === "current" ? "check" : undefined, detail: phase === "error" ? "Exemplo: a verificação de integridade falhou. A instalação foi bloqueada." : undefined, notes: phase === "available" ? "Exemplo de notas da versão.\nMelhorias de estabilidade e organização da interface." : undefined };
  return <AppearanceProvider><main className="updater-lab"><div className="updater-lab-controls"><label htmlFor="updater-demo-phase">Estado visual</label><select id="updater-demo-phase" value={phase} onChange={e => { setPhase(e.target.value as UpdaterPhase); setNotice(""); }}>{phases.map(p => <option key={p} value={p}>{updaterCopy[p].title}</option>)}</select><label><input type="checkbox" checked={unknown} onChange={e => setUnknown(e.target.checked)} /> Total desconhecido</label><label><input type="checkbox" checked={forceStatic} onChange={e=>setForceStatic(e.target.checked)}/> Sem WebGL (ensaio)</label><span role="status">{notice}</span></div><UpdaterExperience forceStatic={forceStatic} view={view} demo onAction={action => setNotice(`Ação demonstrativa: ${action}. Nada foi executado.`)} onCancel={() => setNotice("Cancelamento demonstrativo. Nenhuma operação real em curso.")} onClose={() => setNotice("Fecho demonstrativo. Use o separador do browser para sair.")} /></main></AppearanceProvider>;
}
