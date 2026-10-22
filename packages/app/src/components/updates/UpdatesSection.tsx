/**
 * TP-UPDATE-UI (17/10) — liga o controller REAL ao painel de apresentação.
 *
 * Definições → "Atualizações" usa este componente; os testes renderizam o
 * painel diretamente (injeção de estado), sem preload nem cliques.
 */
import { useAppUpdates } from "./useAppUpdateController";
import { UpdatesPanel } from "./UpdatesPanel";

export function UpdatesSection() {
  const { state, actions } = useAppUpdates();
  return <UpdatesPanel state={state} actions={actions} />;
}
