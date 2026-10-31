import { useState } from "react";
import { cn } from "@/lib/utils";
import type { RealtimeProtectionInfo } from "@/lib/protectionHealth";

export type ProtectionPending = null | "starting" | "stopping" | "pausing";

interface ProtectionControlProps {
  /** Facto factual lido do serviço. undefined/`{}` = sem leitura. */
  realtime: RealtimeProtectionInfo | undefined | null;
  /** Estado do pedido em voo. NÃO é estado confirmado: é feedback de clique. */
  pending: ProtectionPending;
  /** Ligação ao serviço. `false`/`null` => nada é acionável. */
  connected: boolean | null;
  /** Contrato real de ativação/desativação (renderer -> main -> monitor.start/stop). */
  onSet: (enabled: boolean) => void;
  /** Contrato real de pausa (monitor.pause). */
  onPause: (minutes: number) => void;
  /** Causa sanitizada da ultima tentativa falhada (GUI-TEST-18/19). */
  error?: string | null;
  /** Fechar o aviso de erro apos nova tentativa bem sucedida ou leitura do usuario. */
  onDismiss?: () => void;
}

type ControlState = "ativa" | "pausada" | "desativada" | "indisponivel";

const PENDING_LABEL: Record<Exclude<ProtectionPending, null>, string> = {
  starting: "A ativar…",
  stopping: "A desligar…",
  pausing: "A pausar…",
};

const STATE_LABEL: Record<ControlState, string> = {
  ativa: "Ativa",
  pausada: "Em pausa",
  desativada: "Desativada",
  indisponivel: "Indisponível",
};

const STATE_TEXT: Record<ControlState, string> = {
  ativa: "text-cyber-green",
  pausada: "text-cyber-yellow",
  desativada: "text-cyber-red",
  indisponivel: "text-muted-foreground",
};

const STATE_DOT: Record<ControlState, string> = {
  ativa: "bg-cyber-green",
  pausada: "bg-cyber-yellow",
  desativada: "bg-cyber-red",
  indisponivel: "bg-muted-foreground",
};

function controlState(realtime: RealtimeProtectionInfo | undefined | null): ControlState {
  if (!realtime || realtime.disponivel === false) return "indisponivel";
  const paused = typeof realtime.pausedUntil === "string" && realtime.pausedUntil.trim() !== "";
  if (paused) return "pausada";
  if (realtime.enabled === true) return "ativa";
  if (realtime.enabled === false) return "desativada";
  return "indisponivel";
}

/** "até <data legível>", só com o prazo real do serviço. Sem prazo, sem frase. */
function pausedDetail(pausedUntil: string | null | undefined): string {
  const raw = typeof pausedUntil === "string" ? pausedUntil.trim() : "";
  if (!raw) return "";
  const when = new Date(raw);
  return Number.isNaN(when.getTime()) ? raw : when.toLocaleString("pt-PT");
}

const BASE_BTN =
  "px-3 py-1.5 rounded-lg font-mono text-xs font-semibold whitespace-nowrap transition-all border";

export default function ProtectionControl({ realtime, pending, connected, onSet, onPause, error = null, onDismiss }: ProtectionControlProps) {
  // Confirmação a dois passos só para DESLIGAR (ação destrutiva). Nunca otimista:
  // o estado confirmado vem sempre do refresh pós-resposta do serviço.
  const [confirmingOff, setConfirmingOff] = useState(false);
  const state = controlState(realtime);
  const actionable = connected === true && pending === null && state !== "indisponivel";
  const detail = state === "pausada" ? pausedDetail(realtime?.pausedUntil) : "";

  function attemptOff() {
    if (!actionable) return;
    if (!confirmingOff) {
      setConfirmingOff(true);
      return;
    }
    setConfirmingOff(false);
    onSet(false);
  }

  return (
    <div className="stat-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono font-semibold uppercase tracking-wider text-foreground">
            Controlo de proteção
          </span>
          <span className="flex items-center gap-1.5">
            <span className={cn("w-2 h-2 rounded-full shrink-0", STATE_DOT[state])} />
            <span className={cn("text-xs font-mono font-bold", STATE_TEXT[state])}>
              {pending ? PENDING_LABEL[pending] : STATE_LABEL[state]}
            </span>
          </span>
          {detail && (
            <span className="text-xs font-mono text-muted-foreground truncate">até {detail}</span>
          )}
        </div>
        {connected === false && (
          <span className="text-xs font-mono text-muted-foreground">
            Serviço indisponível — sem ações
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {state === "desativada" && (
          <button
            type="button"
            disabled={!actionable}
            onClick={() => actionable && onSet(true)}
            className={cn(
              BASE_BTN,
              "border-cyber-green/40 bg-cyber-green/10 text-cyber-green",
              actionable ? "hover:brightness-110" : "opacity-50 cursor-not-allowed",
            )}
          >
            {pending === "starting" ? PENDING_LABEL.starting : "Ativar proteção"}
          </button>
        )}

        {state === "ativa" && (
          <>
            <button
              type="button"
              disabled={!actionable}
              onClick={() => actionable && onPause(15)}
              className={cn(BASE_BTN, "border-border bg-secondary/50 text-foreground", actionable ? "hover:brightness-110" : "opacity-50 cursor-not-allowed")}
            >
              {pending === "pausing" ? PENDING_LABEL.pausing : "Pausar 15 min"}
            </button>
            <button
              type="button"
              disabled={!actionable}
              onClick={() => actionable && onPause(60)}
              className={cn(BASE_BTN, "border-border bg-secondary/50 text-foreground", actionable ? "hover:brightness-110" : "opacity-50 cursor-not-allowed")}
            >
              {pending === "pausing" ? PENDING_LABEL.pausing : "Pausar 1 hora"}
            </button>
          </>
        )}

        {state === "pausada" && (
          <button
            type="button"
            disabled={!actionable}
            onClick={() => actionable && onSet(true)}
            className={cn(
              BASE_BTN,
              "border-cyber-green/40 bg-cyber-green/10 text-cyber-green",
              actionable ? "hover:brightness-110" : "opacity-50 cursor-not-allowed",
            )}
          >
            {pending === "starting" ? PENDING_LABEL.starting : "Retomar proteção agora"}
          </button>
        )}

        {state === "ativa" && (
          confirmingOff ? (
            <>
              <button
                type="button"
                disabled={!actionable}
                onClick={attemptOff}
                className={cn(BASE_BTN, "border-cyber-red/50 bg-cyber-red/15 text-cyber-red", actionable ? "hover:brightness-110" : "opacity-50 cursor-not-allowed")}
              >
                {pending === "stopping" ? PENDING_LABEL.stopping : "Confirmar desligar"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingOff(false)}
                className={cn(BASE_BTN, "border-border bg-secondary/50 text-muted-foreground hover:brightness-110")}
              >
                Cancelar
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={!actionable}
              onClick={attemptOff}
              className={cn(BASE_BTN, "border-border bg-secondary/50 text-muted-foreground", actionable ? "hover:text-cyber-red hover:brightness-110" : "opacity-50 cursor-not-allowed")}
            >
              Desligar
            </button>
          )
        )}

        {state === "indisponivel" && (
          <span className="text-xs font-mono text-muted-foreground">
            Sem leitura do serviço — nada pode ser acionado.
          </span>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2 flex items-start justify-between gap-2 text-xs font-mono text-cyber-red border border-cyber-red/40 bg-cyber-red/5 rounded-lg px-3 py-2">
          <span className="min-w-0">Não foi possível aplicar: {error}</span>
          {onDismiss && (
            <button type="button" onClick={onDismiss} className="shrink-0 underline underline-offset-2 hover:brightness-125">
              fechar
            </button>
          )}
        </p>
      )}
    </div>
  );
}
