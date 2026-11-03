/**
 * TP-UPDATE-UI (17/10) — liga o controller REAL ao painel de apresentação.
 *
 * Definições → "Atualizações" usa este componente; os testes renderizam o
 * painel diretamente (injeção de estado), sem preload nem cliques.
 */
import {lazy,Suspense,useState} from "react";
import { useAppUpdates } from "./useAppUpdateController";
import { UpdatesPanel } from "./UpdatesPanel";

// Keep CSS and the 3D presentation out of Settings SSR and initial rendering.
const UpdaterFlow=lazy(()=>import("./UpdaterFlow").then(module=>({default:module.UpdaterFlow})));

export function UpdatesSection() {
  const { state, actions } = useAppUpdates();
  const [flowOpen,setFlowOpen]=useState(false);
  return <>
    <UpdatesPanel state={state} actions={actions}/>
    <button type="button" className="rounded-lg border border-border bg-secondary px-4 py-2 text-sm font-semibold text-foreground focus-visible:ring-2 focus-visible:ring-primary" onClick={()=>setFlowOpen(true)}>Abrir janela de atualização</button>
    {flowOpen&&<Suspense fallback={<p role="status">A abrir a janela de atualização…</p>}><UpdaterFlow state={state} actions={actions} onClose={()=>setFlowOpen(false)}/></Suspense>}
  </>;
}
