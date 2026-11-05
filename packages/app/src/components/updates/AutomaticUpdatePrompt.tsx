import { useEffect, useRef, useState } from "react";
import { useAppUpdates } from "./useAppUpdateController";
import { shouldOpenAutomaticPrompt } from "./appUpdateModel";
import { UpdaterFlow } from "./UpdaterFlow";

/** Janela global: só aparece perante uma versão validada e realmente superior.
 * "Mais tarde" fecha e impede repetir o mesmo aviso durante esta sessão. */
export function AutomaticUpdatePrompt() {
  const { state, actions } = useAppUpdates();
  const [open, setOpen] = useState(false);
  const dismissed = useRef(new Set<string>());
  const automatic = state.snapshot?.automaticCheckEnabled === true;
  const status = state.snapshot?.status;
  const pendingVersion = status === "available" ? state.snapshot?.latest?.version : undefined;

  useEffect(() => {
    // A janela global é o braço da verificação AUTOMÁTICA. Uma verificação
    // manual continua a mostrar a atualização no painel de Definições, mas não
    // abre um modal por cima da página onde o utilizador a pediu.
    if (!shouldOpenAutomaticPrompt({ automaticCheckEnabled: automatic, status, version: pendingVersion, dismissed: dismissed.current })) return;
    setOpen(true);
  }, [automatic, status, pendingVersion]);

  if (!automatic || !open || !pendingVersion) return null;

  return (
    <UpdaterFlow
      state={state}
      actions={actions}
      onClose={() => {
        dismissed.current.add(pendingVersion);
        setOpen(false);
        actions.defer();
      }}
    />
  );
}
