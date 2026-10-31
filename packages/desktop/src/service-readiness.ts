/**
 * Decisão de prontidão do serviço no arranque (TP-QA2-READINESS-20261025).
 *
 * Vive fora do `main.ts` por duas razões concretas:
 *  1. `main.ts` não é carregável sem o runtime Electron, por isso a decisão de
 *     "reutilizar o serviço que já está no pipe" não podia ser testada — e foi
 *     exatamente essa decisão que bloqueava o arranque (o estado reportado na VM QA1);
 *  2. a regra correta não é óbvia: um pipe que aceita uma ligação NÃO prova que
 *     o serviço é desta instalação. Só o handshake autenticado prova.
 *
 * Contrato: NUNCA lança. O arranque empacotado tem de receber um estado
 * discriminado e decidir com ele; uma rejeição a escapar daqui era o bug
 * original — apanhada no meio de `app.whenReady().then(...)` sem `.catch`,
 * deixava a janela aberta, sem serviço e sem nenhuma afirmação de prontidão
 * (o "modo limitado" com o gestor de tarefas vazio).
 *
 * Sem importações relativas de propósito: este módulo é a parte verificável do
 * arranque e corre em teste sem o runtime Electron.
 */

export type ExistingServiceStatus = "reused" | "no-service" | "foreign-service";

export interface ExistingServiceOutcome {
  status: ExistingServiceStatus;
  /** Razão legível nos estados que não permitem prosseguir. */
  reason?: string;
}

export interface ExistingServiceDeps {
  /** Presença crua: `net.createConnection` sem autenticar (o `probePipe` do main). */
  probePipe: () => Promise<boolean>;
  /** Ligação com handshake autenticado — é isto que decide a posse. */
  connect: () => Promise<void>;
  /** Fecha o que ficou meio-ligado antes de dar o estado como perdido. */
  teardown: () => void;
  log?: (message: string) => void;
}

function describeError(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

/**
 * Há um serviço NOSSO à escuta?
 *
 * - `reused` — o pipe respondeu E o handshake passou: é desta instalação.
 * - `foreign-service` — o pipe respondeu mas o handshake não passou: há um
 *   serviço vivo que não é nosso (órfão de outro regime ou de uma credência
 *   antiga). Reutilizá-lo era o lockout; lançar um segundo seria `EADDRINUSE`
 *   e um segundo motor a servir zero pedidos.
 * - `no-service` — nada à escuta (ou o probe avariou): o chamador pode arrancar
 *   o próprio serviço.
 */
export async function resolveExistingService(deps: ExistingServiceDeps): Promise<ExistingServiceOutcome> {
  const log = deps.log ?? ((message: string) => console.log(message));

  let present = false;
  try {
    present = await deps.probePipe();
  } catch (error) {
    log(`[Electron] Probe do pipe falhou: ${describeError(error)} — a tentar arrancar o próprio serviço.`);
    return { status: "no-service" };
  }
  if (!present) return { status: "no-service" };

  try {
    await deps.connect();
    return { status: "reused" };
  } catch (error) {
    deps.teardown();
    const reason = describeError(error);
    log(`[Electron] Serviço à escuta não completou o handshake: ${reason}`);
    return {
      status: "foreign-service",
      reason: `outro serviço está a servir o pipe e não completou o handshake desta instalação (${reason})`,
    };
  }
}
