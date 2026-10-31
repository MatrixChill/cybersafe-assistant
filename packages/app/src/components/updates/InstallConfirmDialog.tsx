/**
 * TP-UPDATE-UI (17/10) / FINAL — modal de confirmação da instalação.
 *
 * O contrato exige `{ confirmed: true, expectedVersion }` — este modal é o
 * "confirma primeiro" da UI: mostra a versão exata que vai ser instalada e só
 * o botão "Instalar agora" chama a ponte. Teclado: `Escape` cancela, o foco
 * inicial vai para "Cancelar" (opção segura), o Tab fica preso no diálogo
 * (reutiliza o `nextFocusIndex` já testado do modal de saída) e o foco
 * anterior é restaurado ao fechar. Se a versão/capacidade mudar enquanto o
 * aviso está aberto, `podeConfirmar` fica falso e o "Instalar agora" desativa.
 * (SSR não prova foco/teclado — reteste humano.)
 */
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { nextFocusIndex } from "@/lib/exitConfirm";

export interface InstallConfirmDialogProps {
  version: string;
  /** false quando a versão ou a capacidade de instalar mudou depois de abrir. */
  podeConfirmar: boolean;
  requiresElevation?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function InstallConfirmDialog({ version, podeConfirmar, requiresElevation, onCancel, onConfirm }: InstallConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Foco inicial em "Cancelar" (default seguro) e restauro do foco anterior
    // ao fechar — mesmo contrato de teclado do ExitConfirmDialog da app.
    const anterior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      anterior?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
          return;
        }
        if (event.key === "Tab") {
          // Focus trap circular: só os botões ATIVOS do diálogo contam.
          event.preventDefault();
          const alvos = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
          if (alvos.length === 0) return;
          const atual = alvos.indexOf(document.activeElement as HTMLElement);
          alvos[nextFocusIndex(atual, alvos.length, event.shiftKey)]?.focus();
        }
      }}
    >
      <div className="absolute inset-0 bg-black/60" aria-hidden onClick={onCancel} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-update-install-title"
        aria-describedby="app-update-install-description"
        data-testid="app-update-install-dialog"
        className="surface-elevated cyber-border relative w-full max-w-md rounded-2xl p-6 shadow-2xl"
      >
        <h3 id="app-update-install-title" className="font-mono text-lg font-bold text-foreground">
          Instalar a atualização?
        </h3>
        <p id="app-update-install-description" className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Vais instalar a versão <span className="font-mono text-foreground">v{version}</span>. A instalação só
          avança com a tua confirmação.
        </p>
        {requiresElevation && (
          <p
            className="mt-3 rounded-lg border border-cyber-yellow/40 bg-cyber-yellow/10 px-3 py-2 text-xs leading-relaxed text-foreground"
            data-testid="app-update-dialog-elevation"
          >
            A instalação vai pedir permissões de administrador do Windows.
          </p>
        )}
        {!podeConfirmar && (
          <p
            className="mt-3 rounded-lg border border-cyber-yellow/40 bg-cyber-yellow/10 px-3 py-2 text-xs leading-relaxed text-foreground"
            data-testid="app-update-dialog-changed"
          >
            A versão disponível ou as verificações mudaram enquanto este aviso estava aberto. Fecha e confirma de
            novo.
          </p>
        )}
        <div className="mt-5 flex justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            data-testid="app-update-install-cancel"
            onClick={onCancel}
            className={cn(
              "cyber-border rounded-lg px-4 py-2 font-mono text-sm text-foreground transition-colors",
              "hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
            )}
          >
            Cancelar
          </button>
          <button
            type="button"
            data-testid="app-update-install-confirm"
            onClick={onConfirm}
            disabled={!podeConfirmar}
            className={cn(
              "rounded-lg border border-primary/50 bg-primary/90 px-4 py-2 font-mono text-sm font-semibold text-primary-foreground transition-all",
              "hover:bg-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              "disabled:opacity-50 disabled:pointer-events-none",
            )}
          >
            Instalar agora
          </button>
        </div>
      </div>
    </div>
  );
}
