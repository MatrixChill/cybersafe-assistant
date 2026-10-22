/**
 * Handlers de sinal do serviço — módulo SEM EFEITOS AO IMPORTAR.
 *
 * P1-5 (Codex): isto saía de `index.ts`, e isso custou caro. `index.ts` escreve
 * `boot-debug.log` e arranca o serviço no TOPO do módulo, portanto qualquer
 * teste que importasse `index.ts` parareachablear o handler ligava o serviço
 * inteiro e escrevia no runtime real do utilizador — foi o que aconteceu a
 * 2026-10-02 e o fingerprint do home denunciou.
 *
 * Aqui não há `process.on`, `main()`, nem escrita em disco. Recebe o que
 * precisa de fora. Um módulo que só se importa para ser testado tem de poder
 * ser importado sem consequências.
 */

export interface ShutdownTarget {
  shutdown: () => Promise<unknown>;
}

export interface SignalHandlerDeps {
  /** Termina o processo. Injetável para não matar o runner de testes. */
  exit?: (code: number) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string, err: unknown) => void;
  /** Sinais a instalar. Por omissão SIGINT e SIGTERM. */
  signals?: readonly NodeJS.Signals[];
  /** Promise de exit, para testes poderem esperar pelo fim. */
  onFinished?: (promise: Promise<number>) => void;
}

export interface SignalHandlers {
  /** Instala e devolve o uninstall. Idempotente sob surtos de sinal. */
  install: () => () => void;
  /** A promise do shutdown em curso, se existir (para testes). */
  current: () => Promise<number> | null;
}

/**
 * BUG A (fixado): o `uninstall` criava uma NOVA closure e passava-a ao
 * `process.off`, que nunca retirava o listener registado. Guardam-se as
 * referências reais e usam-se essas mesmas no `off`.
 */
export function installSignalHandlers(
  target: ShutdownTarget,
  deps: SignalHandlerDeps = {},
): () => void {
  const handlers = createSignalHandlers(target, deps);
  return handlers.install();
}

/** Mesma coisa, mas expõe também a promise em curso — o que os testes precisam. */
export function createSignalHandlers(
  target: ShutdownTarget,
  deps: SignalHandlerDeps = {},
): SignalHandlers {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? (() => {});
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const error = deps.error ?? ((m: string, e: unknown) => console.error(m, e));
  const signals = deps.signals ?? (["SIGINT", "SIGTERM"] as const);

  let inFlight: Promise<number> | null = null;
  let installed = false;
  let uninstall: () => void = () => {};

  const begin = (signal: string): Promise<number> => {
    if (inFlight) return inFlight;
    log(`Received ${signal} — EXPECTED DEV SHUTDOWN (dev runner)`);
    inFlight = (async (): Promise<number> => {
      let code = 0;
      try {
        await target.shutdown();
        log("Service stopped.");
      } catch (err: unknown) {
        // Um shutdown que falha tem de ser dito, e tem de-SEGUIR. Sair sem
        // tentar nada pior: um clamscan de ~1 GB ficaria vivo. O código de
        // saída é que se decide abaixo, com o resultado à vista.
        error("Falha no shutdown", err);
        code = 1;
      } finally {
        exit(code);
      }
      return code;
    })();
    deps.onFinished?.(inFlight);
    return inFlight;
  };

  // As MESMAS referências que vão ser passadas ao `off`. Cada sinal tem a sua.
  const registered = signals.map((signal) => {
    const handler = () => void begin(signal);
    return { signal, handler };
  });

  return {
    current: () => inFlight,
    install: () => {
      // BUG A (fixado, 2.ª volta): o `off` sem `off` repetido deixa listeners
      // pendurados. `EventEmitter` NÃO deduplica — `on` duas vezes com a MESMA
      // função regista-a duas vezes, e um `off` só tira uma. Um `install()`
      // chamado duas vezes deixava um handler vivo depois do `uninstall`.
      if (installed) return uninstall;
      installed = true;
      for (const { signal, handler } of registered) process.on(signal, handler);

      let uninstalled = false;
      uninstall = () => {
        if (uninstalled) return;
        uninstalled = true;
        for (const { signal, handler } of registered) process.off(signal, handler);
        warn("Signal handlers removidos.");
      };
      return uninstall;
    },
  };
}