/**
 * Entrega da pergunta de saída ao renderer, com confirmação de apresentação.
 *
 * PROBLEMA REAL (teste humano do pacote, 10/10/2026): o pedido do modal era
 * enviado ao renderer UMA única vez e sem reconhecimento. Se o renderer não o
 * apresentasse — ainda a carregar, ocupado, ou a recuperar de um crash — o
 * clique em "Sair" ficava pendurado em silêncio até ao timeout de 30 s e a app
 * parecia ignorar o clique ("FAIL INTERMITENTE": primeiro clique sem efeito,
 * segunda tentativa a funcionar). A janela podia ainda ficar visível com o
 * renderer morto (página em branco) enquanto isso.
 *
 * Este módulo garante, por desenho:
 *   - o pedido é REENVIADO segundo prazos definidos até o renderer ACKAR que o
 *     modal está apresentado (ack idempotente);
 *   - desiste DEPRESSA com um estado explícito ("unavailable" quando a janela
 *     está morta/crashada; "gave-up" quando ninguém confirma), para o chamador
 *     cair na confirmação nativa em vez de deixar o utilizador sem feedback;
 *   - cada caminho resolve a promessa: nunca fica uma pendente sem resultado.
 *
 * Módulo puro (sem Electron): `send`, `isRendererAvailable` e `schedule` são
 * injetados, para poder ser testado sem janela.
 */

export type ExitDeliveryOutcome = "acked" | "unavailable" | "gave-up";

export interface ExitDeliveryOptions {
  /** Envia o pedido do modal (`app:exit-confirm` true). Pode lançar — é tratado. */
  send: () => void;
  /** false = janela morta/crashada: desiste já, sem gastar reenvios. */
  isRendererAvailable?: () => boolean;
  /** Prazos de reenvio, em ms desde o pedido. Default [0, 1200, 3000]. */
  retryDelaysMs?: number[];
  /** Graça depois do último envio à espera do ack. Default 800 ms. */
  ackGraceMs?: number;
  /** Diagnóstico: cada passo da entrega. */
  onEvent?: (event: string, details?: Record<string, unknown>) => void;
  /** Agendador injetável (testes usam um relógio falso). */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface ExitDelivery {
  /** Resolve com o desfecho da entrega (sempre resolve). */
  request: () => Promise<ExitDeliveryOutcome>;
  /** O renderer apresentou o modal. Idempotente. */
  ack: () => void;
  readonly isAcked: boolean;
  readonly isPending: boolean;
}

/** 0 / 1,2 s / 3 s + 0,8 s de graça ⇒ desistência em ~3,8 s (nunca 30 s). */
export const DEFAULT_EXIT_RETRY_DELAYS_MS = [0, 1200, 3000];
export const DEFAULT_EXIT_ACK_GRACE_MS = 800;

export function createExitDelivery(options: ExitDeliveryOptions): ExitDelivery {
  const retryDelays = options.retryDelaysMs ?? DEFAULT_EXIT_RETRY_DELAYS_MS;
  const ackGraceMs = options.ackGraceMs ?? DEFAULT_EXIT_ACK_GRACE_MS;
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  const isRendererAvailable = options.isRendererAvailable ?? (() => true);
  const onEvent = options.onEvent;

  let pending: Promise<ExitDeliveryOutcome> | null = null;
  let acked = false;
  let settleAcked: (() => void) | null = null;

  function run(): Promise<ExitDeliveryOutcome> {
    return new Promise<ExitDeliveryOutcome>((resolve) => {
      let settled = false;
      const cancels: Array<() => void> = [];

      const finish = (outcome: ExitDeliveryOutcome) => {
        if (settled) return;
        settled = true;
        settleAcked = null;
        for (const cancel of cancels) {
          try {
            cancel();
          } catch {
            /* agendador já correu */
          }
        }
        resolve(outcome);
      };

      // O ack pode chegar entre reenvios: resolve já como "acked".
      settleAcked = () => finish("acked");

      const attempt = (index: number) => {
        if (settled || acked) return;
        if (!isRendererAvailable()) {
          onEvent?.("exit-delivery:unavailable", { attempt: index });
          finish("unavailable");
          return;
        }
        try {
          options.send();
          onEvent?.("exit-delivery:sent", { attempt: index, delayMs: retryDelays[index] ?? null });
        } catch (error) {
          onEvent?.("exit-delivery:send-error", { attempt: index, error: String(error) });
        }

        const nextIndex = index + 1;
        if (nextIndex < retryDelays.length) {
          const gap = Math.max(0, (retryDelays[nextIndex] ?? 0) - (retryDelays[index] ?? 0));
          cancels.push(schedule(() => attempt(nextIndex), gap));
          return;
        }
        // Último envio feito: pequena graça para o ack antes de desistir.
        cancels.push(
          schedule(() => {
            if (settled || acked) return;
            onEvent?.("exit-delivery:gave-up", { sends: retryDelays.length });
            finish("gave-up");
          }, ackGraceMs),
        );
      };

      attempt(0);
    });
  }

  return {
    request() {
      if (!pending) {
        acked = false;
        pending = run().finally(() => {
          pending = null;
        });
      }
      return pending;
    },
    ack() {
      if (acked) return;
      acked = true;
      onEvent?.("exit-delivery:acked", {});
      settleAcked?.();
    },
    get isAcked() {
      return acked;
    },
    get isPending() {
      return pending !== null;
    },
  };
}
