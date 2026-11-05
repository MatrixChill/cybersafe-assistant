/**
 * Definições → "Atualizações": estado e verificação manual.
 * A janela de atualização é global e aparece apenas quando o updater confirma
 * uma versão realmente superior; não há botão para a abrir manualmente.
 */
import { useAppUpdates } from "./useAppUpdateController";
import { UpdatesPanel } from "./UpdatesPanel";

export function UpdatesSection() {
  const { state, actions } = useAppUpdates();
  return <UpdatesPanel state={state} actions={actions}/>;
}
