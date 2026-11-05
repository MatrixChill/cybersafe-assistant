import { useEffect, useRef, useState } from "react";
import { useAppUpdates } from "./useAppUpdateController";
import { UpdaterFlow } from "./UpdaterFlow";

/** Janela global: só aparece perante uma versão validada e realmente superior.
 * "Mais tarde" fecha e impede repetir o mesmo aviso durante esta sessão. */
export function AutomaticUpdatePrompt() {
  const { state, actions } = useAppUpdates();
  const [open, setOpen] = useState(false);
  const dismissed = useRef(new Set<string>());
  const pendingVersion = state.snapshot?.status === "available" ? state.snapshot.latest?.version : undefined;

  useEffect(() => {
    if (!pendingVersion || dismissed.current.has(pendingVersion)) return;
    setOpen(true);
  }, [pendingVersion]);

  if (!open || !pendingVersion) return null;

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
