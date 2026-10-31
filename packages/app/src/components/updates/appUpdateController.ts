/**
 * TP-UPDATE-UI (17/10) — controller REAL da secção de atualizações.
 *
 * Sem React: é injetável (recebe a `AppUpdateBridge` real OU `null` para
 * testes e ambientes sem preload) e os testes exercitam-no diretamente.
 * Regras:
 *  - uma ação de cada vez (`busy`); pedidos concorrentes são ignorados;
 *  - respostas "stale" (chegaram depois de dispose/restart) nunca escrevem estado;
 *  - rejeições da ponte (IPC em baixo) viram erro honesto — nunca um unhandled
 *    rejection nem um estado fingido;
 *  - `install` envia SEMPRE `{ confirmed: true, expectedVersion }`.
 *
 * TP-POSTMANUAL-P0-UPDATES-TERMINAL (21/10) — o "A consultar o estado…" sem fim:
 *  - `start()` depois de `dispose()` (React StrictMode em dev) reinicia a
 *    geração e NÃO herda o `busy` da leitura interrompida — antes o segundo
 *    start desistia por "já existe uma operação em curso" e o painel ficava
 *    preso para sempre;
 *  - a leitura de `getSnapshot()` tem prazo FINITO e é cancelável no dispose;
 *  - sem resposta dentro do prazo o estado é TERMINAL (erro nomeado `timeout`),
 *    sem retry automático — o retry é explícito e só relê o snapshot;
 *  - respostas tardias (depois do prazo/dispose) são ignoradas pela geração.
 *
 * Nada aqui inicia verificação, transferência, instalação nem altera a
 * preferência automática por conta própria.
 */
import type { AppUpdateBridge, AppUpdateErrorCode, AppUpdateResult, AppUpdateSnapshot } from "@cybersafe/shared-types";
import { errorCodeMessage } from "./appUpdateModel";

export type AppUpdateActionName = "reveal" | "refresh" | "check" | "download" | "cancel" | "defer" | "install" | "automatic";

export interface UpdatesViewState {
  bridgeAvailable: boolean;
  loading: boolean;
  snapshot: AppUpdateSnapshot | null;
  busy: AppUpdateActionName | null;
  actionError: { code: AppUpdateErrorCode; message: string } | null;
}

export interface UpdatesActions {
  refresh(): void;
  check(): void;
  download(): void;
  revealDownload?(): void;
  cancel(): void;
  defer(): void;
  install(expectedVersion: string): void;
  setAutomaticCheck(enabled: boolean): void;
}

export interface UpdatesController {
  subscribe(listener: () => void): () => void;
  getState(): UpdatesViewState;
  start(): void;
  dispose(): void;
  refresh(): Promise<void>;
  check(): Promise<void>;
  download(): Promise<void>;
  revealDownload(): Promise<void>;
  cancel(): Promise<void>;
  defer(): Promise<void>;
  install(expectedVersion: string): Promise<void>;
  setAutomaticCheck(enabled: boolean): Promise<void>;
}

export interface UpdatesControllerOptions {
  /**
   * Prazo da leitura de `getSnapshot()` (arranque e retry). Só a LEITURA é
   * limitada: transferência/instalação continuam a ser operações do main, sem
   * timeout genérico nem promessa de cancelar efeitos remotos.
   */
  snapshotReadTimeoutMs?: number;
}

/** Prazo por omissão da leitura do snapshot (8 s). */
export const SNAPSHOT_READ_TIMEOUT_MS = 8_000;

export const SNAPSHOT_TIMEOUT_MESSAGE =
  "O atualizador não respondeu no prazo previsto. Nenhuma operação de atualização foi iniciada.";

const INTERNAL_FALLBACK = "Não foi possível contactar o atualizador.";

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return INTERNAL_FALLBACK;
}

class SnapshotReadTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotReadTimeoutError";
  }
}

class SnapshotReadCancelledError extends Error {
  constructor() {
    super("Leitura do estado cancelada.");
    this.name = "SnapshotReadCancelledError";
  }
}

interface PendingSnapshotRead {
  promise: Promise<AppUpdateSnapshot>;
  cancel(): void;
}

/**
 * Leitura com prazo FINITO e cancelável.
 *  - o timer é sempre limpo (resposta, prazo ou cancelamento);
 *  - a promessa da ponte recebe sempre um handler: uma rejeição tardia depois
 *    de o prazo fechar nunca fica como unhandled rejection;
 *  - cancelar rejeita a leitura para o `await` do controller terminar — o
 *    controller ignora o desfecho quando já fez dispose.
 */
function readSnapshotWithDeadline(
  read: () => Promise<AppUpdateSnapshot>,
  timeoutMs: number,
): PendingSnapshotRead {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let rejectRead: ((error: unknown) => void) | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const rejectOnce = (error: unknown) => {
    if (settled) return;
    settled = true;
    clearTimer();
    rejectRead?.(error);
  };

  const promise = new Promise<AppUpdateSnapshot>((resolve, reject) => {
    rejectRead = reject;
    timer = setTimeout(() => rejectOnce(new SnapshotReadTimeoutError(SNAPSHOT_TIMEOUT_MESSAGE)), timeoutMs);
    let request: Promise<AppUpdateSnapshot>;
    try {
      request = read();
    } catch (error) {
      rejectOnce(error);
      return;
    }
    request.then(
      (snapshot) => {
        if (settled) return;
        settled = true;
        clearTimer();
        resolve(snapshot);
      },
      (error) => rejectOnce(error),
    );
  });

  return {
    promise,
    cancel: () => rejectOnce(new SnapshotReadCancelledError()),
  };
}

function normalizeTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return SNAPSHOT_READ_TIMEOUT_MS;
  return value;
}

export function createUpdatesController(
  bridge: AppUpdateBridge | null,
  options: UpdatesControllerOptions = {},
): UpdatesController {
  const snapshotReadTimeoutMs = normalizeTimeout(options.snapshotReadTimeoutMs);
  const listeners = new Set<() => void>();
  let state: UpdatesViewState = {
    bridgeAvailable: bridge !== null,
    loading: bridge !== null,
    snapshot: null,
    busy: null,
    actionError: null,
  };
  let unsubBridge: (() => void) | null = null;
  let pendingRead: PendingSnapshotRead | null = null;
  let started = false;
  let disposed = false;
  let seq = 0;

  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* um listener partido não derruba os restantes */
      }
    }
  };

  const patch = (partial: Partial<UpdatesViewState>) => {
    state = { ...state, ...partial };
    emit();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getState = () => state;

  /**
   * Leitura do estado REAL: única operação limitada por prazo. Nunca dispara
   * check/download/install/automatic — o retry do painel chama exactamente isto.
   */
  const refresh = async (): Promise<void> => {
    if (disposed || bridge === null || state.busy !== null) return;
    const current = ++seq;
    const read = readSnapshotWithDeadline(() => bridge.getSnapshot(), snapshotReadTimeoutMs);
    pendingRead = read;
    patch({ busy: "refresh", actionError: null });
    let outcome: Partial<UpdatesViewState> | null = null;
    try {
      const snapshot = await read.promise;
      outcome = { snapshot, loading: false };
    } catch (error) {
      if (error instanceof SnapshotReadTimeoutError) {
        // Um snapshot REAL já pode ter chegado pelo onState enquanto a leitura
        // pendia: nesse caso o prazo fecha a leitura sem inventar erro.
        outcome =
          state.snapshot === null
            ? { actionError: { code: "timeout", message: error.message }, loading: false }
            : { loading: false };
      } else if (error instanceof SnapshotReadCancelledError) {
        outcome = null;
      } else {
        outcome = { actionError: { code: "internal", message: describeError(error) }, loading: false };
      }
    } finally {
      if (pendingRead === read) pendingRead = null;
      // Sem retry automático e sem escrita depois de dispose/restart: a
      // geração (`seq`) é o único juiz de quem ainda pode escrever.
      if (!disposed && current === seq && outcome !== null) patch({ ...outcome, busy: null });
    }
  };

  const run = async (
    action: AppUpdateActionName,
    invoke: (b: AppUpdateBridge) => Promise<AppUpdateResult>,
  ): Promise<void> => {
    if (disposed || bridge === null || state.busy !== null) return;
    const current = ++seq;
    patch({ busy: action, actionError: null });
    try {
      const result = await invoke(bridge);
      if (disposed || current !== seq) return;
      patch(
        result.ok
          ? { snapshot: result.snapshot }
          : {
              snapshot: result.snapshot,
              actionError: {
                code: result.error,
                message: result.snapshot.error?.message ?? errorCodeMessage(result.error),
              },
            },
      );
    } catch (error) {
      if (disposed || current !== seq) return;
      patch({ actionError: { code: "internal", message: describeError(error) } });
    } finally {
      if (!disposed && current === seq) patch({ busy: null, loading: false });
    }
  };

  /**
   * O cancelamento NÃO passa por `run`: durante uma transferência/verificação
   * pendente o `busy` está ocupado pela PRÓPRIA operação a cancelar, e o `run`
   * recusaria a chamada (era o defeito: Cancelar nunca chegava à ponte).
   * Regras:
   *  - a ponte é chamada com o `busy` em `download`/`check` (ou livre);
   *  - o `busy` passa a `cancel` (feedback no painel) e NÃO é libertado pela
   *    resposta do cancel — quem o liberta é a operação original ao terminar;
   *  - `seq` não é incrementado: a operação original continua a poder escrever
   *    o desfecho real (cancelled) e a libertar o `busy`;
   *  - duplo cancelamento, dispose/unmount e rejeições são tratados sem
   *    estado fingido nem unhandled rejection.
   */
  const cancel = async (): Promise<void> => {
    if (disposed || bridge === null) return;
    const ocupado = state.busy;
    // `cancel` em curso = anti-duplo; `refresh`/`defer`/`install`/`automatic`
    // não são canceláveis por este caminho.
    if (ocupado !== null && ocupado !== "download" && ocupado !== "check") return;
    const operacaoPendente = ocupado !== null;
    const current = seq;
    patch({ busy: "cancel", actionError: null });
    try {
      const result = await bridge.cancel();
      if (disposed || current !== seq) return;
      patch(
        result.ok
          ? { snapshot: result.snapshot }
          : {
              snapshot: result.snapshot,
              actionError: {
                code: result.error,
                message: result.snapshot.error?.message ?? errorCodeMessage(result.error),
              },
            },
      );
    } catch (error) {
      if (disposed || current !== seq) return;
      patch({ actionError: { code: "internal", message: describeError(error) } });
    } finally {
      // Com uma operação pendente, o `busy` só sai quando essa operação
      // terminar (nunca aqui — libertá-lo agora deixaria arrancar outra ação).
      if (!disposed && current === seq && !operacaoPendente) patch({ busy: null, loading: false });
    }
  };

  const start = () => {
    if (bridge === null || started) return;
    started = true;
    disposed = false;
    // Restart depois de dispose (StrictMode em dev) é uma geração NOVA: a
    // leitura anterior é cancelada, o `busy` que ela deixou é libertado e uma
    // leitura nova arranca. Sem isto o refresh seguinte desistia com o `busy`
    // antigo preso e o painel ficava em "A consultar o estado…" para sempre.
    seq += 1;
    const anterior = pendingRead;
    pendingRead = null;
    anterior?.cancel();
    patch({ busy: null, loading: state.snapshot === null });
    try {
      unsubBridge = bridge.onState((snapshot) => {
        if (!disposed) patch({ snapshot, loading: false });
      });
    } catch (error) {
      patch({ actionError: { code: "internal", message: describeError(error) }, loading: false });
    }
    void refresh();
  };

  const dispose = () => {
    disposed = true;
    started = false;
    seq += 1;
    const read = pendingRead;
    pendingRead = null;
    // Anula a leitura e o respetivo timer: nada fica pendente depois do unmount.
    read?.cancel();
    const unsubscribe = unsubBridge;
    unsubBridge = null;
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        /* a ponte pode já estar em baixo — dispose nunca lança */
      }
    }
  };

  return {
    subscribe,
    getState,
    start,
    dispose,
    refresh,
    check: () => run("check", (b) => b.check()),
    download: () => run("download", (b) => b.download()),
    revealDownload: () => run("reveal", (b) => { if (!b.revealDownload) throw new Error("A ponte não suporta abertura da pasta"); return b.revealDownload(); }),
    cancel,
    defer: () => run("defer", (b) => b.defer()),
    install: (expectedVersion: string) =>
      expectedVersion.length === 0
        ? Promise.resolve()
        : run("install", (b) => b.install({ confirmed: true, expectedVersion })),
    setAutomaticCheck: (enabled: boolean) => run("automatic", (b) => b.setAutomaticCheck(enabled)),
  };
}
