import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  EXIT_CONFIRM_CANCEL_LABEL,
  EXIT_CONFIRM_CONFIRM_LABEL,
  EXIT_CONFIRM_DESCRIPTION,
  EXIT_CONFIRM_TITLE,
  exitConfirmKeyAction,
  exitConfirmResponse,
  nextFocusIndex,
  type ExitConfirmAction,
} from "../lib/exitConfirm";
import { beginAppShutdown } from "../lib/shutdownState";

export interface ExitConfirmDialogProps {
  open: boolean;
  onRespond: (action: ExitConfirmAction) => void;
  /** true depois de o utilizador confirmar: a app está a encerrar. */
  busy?: boolean;
}

/**
 * Confirmação de saída integrada no CyberSafe (substitui o diálogo nativo
 * branco do Windows). Usa os tokens do tema, por isso funciona em dark e light.
 *
 * Acessibilidade: role="dialog" + aria-modal, focus trap entre os dois botões,
 * foco inicial em "Cancelar" (opção segura) e ESC a cancelar.
 */
export function ExitConfirmDialog({ open, onRespond, busy = false }: ExitConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Focar "Cancelar" é o default seguro: Enter sem intenção não encerra nada.
    const raf = requestAnimationFrame(() => cancelRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (busy) return; // Encerramento em curso: nada a cancelar.

      if (exitConfirmKeyAction(event.key) === "cancel") {
        event.preventDefault();
        event.stopPropagation();
        onRespond("cancel");
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        const container = event.currentTarget;
        const buttons = Array.from(
          container.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
        );
        if (buttons.length === 0) return;
        const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const nextIndex = nextFocusIndex(currentIndex, buttons.length, event.shiftKey);
        buttons[nextIndex]?.focus();
      }
    },
    [busy, onRespond],
  );

  return (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center p-6 bg-background/70 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) onRespond("cancel");
          }}
          onKeyDown={handleKeyDown}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="cybersafe-exit-confirm-title"
            aria-describedby="cybersafe-exit-confirm-description"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            className="cyber-border w-full max-w-md rounded-2xl bg-card/95 shadow-2xl overflow-hidden"
          >
            <div className="flex gap-4 p-6">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyber-red/30 bg-cyber-red/10">
                <ShieldAlert className="h-6 w-6 text-cyber-red" />
              </div>
              <div className="min-w-0">
                <h2
                  id="cybersafe-exit-confirm-title"
                  className="font-mono text-lg font-bold text-foreground"
                >
                  {EXIT_CONFIRM_TITLE}
                </h2>
                <p
                  id="cybersafe-exit-confirm-description"
                  className="mt-1 text-sm leading-relaxed text-muted-foreground"
                >
                  {EXIT_CONFIRM_DESCRIPTION}
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-3 border-t border-border bg-secondary/20 px-6 py-4">
              <button
                ref={cancelRef}
                type="button"
                disabled={busy}
                onClick={() => onRespond("cancel")}
                className={cn(
                  "cyber-border rounded-lg px-4 py-2 font-mono text-sm text-foreground transition-colors",
                  "hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  "disabled:opacity-50",
                )}
              >
                {EXIT_CONFIRM_CANCEL_LABEL}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onRespond("confirm")}
                className={cn(
                  "rounded-lg border border-destructive/50 bg-destructive/90 px-4 py-2 font-mono text-sm font-semibold text-destructive-foreground transition-all",
                  "hover:bg-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/60",
                  "disabled:opacity-60",
                )}
              >
                {busy ? "A encerrar..." : EXIT_CONFIRM_CONFIRM_LABEL}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

/**
 * Liga o modal ao processo principal do Electron. Fica ao nível da App (e não
 * dentro da área autenticada) para o pedido da tray/do menu funcionar em
 * qualquer ecrã — login, boot ou onboarding.
 */
export function ExitConfirmHost() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onExitConfirmRequest) return;
    return api.onExitConfirmRequest((next) => {
      setOpen(next);
      if (!next) setBusy(false);
    });
  }, []);

  // Modal apresentado (o React já comprometeu o render): avisar o main, que
  // para os reenvios e revela a janela já pintada. Só depois da confirmação
  // de render é que a janela escondida é mostrada — evita a janela branca.
  useEffect(() => {
    if (!open) return;
    void window.electronAPI?.ackExitConfirm?.()?.catch(() => {});
  }, [open]);

  const respond = useCallback((action: ExitConfirmAction) => {
    const answer = exitConfirmResponse(action);
    if (answer === null) return;
    // Cancelar fecha já; confirmar mantém o modal em "A encerrar...".
    if (answer) setBusy(true);
    else setOpen(false);

    // Ordem do shutdown: (1) marcar o encerramento no renderer e na bridge do
    // preload — os pollers param e nenhum pedido IPC novo é iniciado — e só
    // depois (2) avisar o main, que corre o quitCyberSafe() (o disconnect do
    // ServiceClient deixa de apanhar pedidos do renderer em voo).
    if (answer) {
      beginAppShutdown();
      window.electronAPI?.beginShutdown?.();
    }
    void window.electronAPI?.respondExitConfirm?.(answer)?.catch(() => {});
  }, []);

  return <ExitConfirmDialog open={open} onRespond={respond} busy={busy} />;
}
