import { EventEmitter } from "node:events";
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";

export interface IsolatedFileWatcherOptions {
  /** Script do filho. Default: `./watcher-child.js` ao lado deste módulo. */
  childScript?: string | URL;
  /** Implementação de `fork` — substituída só em testes com duplo benigno. */
  forkImpl?: typeof fork;
  /**
   * Orçamento até ao `ready` do filho. 10 000 ms era o valor histórico e passou a
   * ser GENEROSO: com `fs.watch(recursive)` o `ready` é o attach do SO, medido em
   * milissegundos, e já não depende de enumerar a árvore. NÃO é uma alavanca para
   * "pagar" o defeito — o defeito era a primitiva (ver watcher-child.ts).
   */
  startupBudgetMs?: number;
}

/** Separate process: neither the event loop nor libuv's filesystem pool is shared. */
export class IsolatedFileWatcher extends EventEmitter {
  private child: ChildProcess | null = null;
  private transition: Promise<void> = Promise.resolve();
  private generation = 0;
  private readonly childScript: string | URL;
  private readonly forkImpl: typeof fork;
  private readonly startupBudgetMs: number;

  constructor(options: IsolatedFileWatcherOptions = {}) {
    super();
    this.childScript = options.childScript ?? new URL("./watcher-child.js", import.meta.url);
    this.forkImpl = options.forkImpl ?? fork;
    this.startupBudgetMs = options.startupBudgetMs ?? 10_000;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(paths: string[]): Promise<void> {
    const generation = ++this.generation;
    return this.enqueue(async () => {
      await this.closeChild();
      if (generation !== this.generation) return;
      const options: ForkOptions & { windowsHide: boolean } = {
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        execArgv: [],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      };
      const child = this.forkImpl(this.childScript, [], options);
      this.child = child;
      const inicio = Date.now();
      const vistas = new Set<string>();
      await new Promise<void>((resolve, reject) => {
        let started = false;
        const timer = setTimeout(() => {
          // Esta mensagem vai ao ecra (failures[] do motor -> ProtectionControl).
          // Dizer o orcamento e O QUE SE VIU e o que faltou quando o GUI-TEST-18
          // apanhou apenas "Watcher startup timed out": com `started` recebido, o
          // filho vive e fala; o que não chegou foi o `ready`.
          reject(
            new Error(
              `Watcher startup timed out (limite ${this.startupBudgetMs}ms; mensagens do filho: ${[...vistas].join(",") || "nenhuma"})`,
            ),
          );
        }, this.startupBudgetMs);
        const fail = (error: Error) => {
          clearTimeout(timer);
          if (!started) reject(error);
          else if (this.child === child && generation === this.generation) this.emit("error", error);
        };
        child.on("error", fail);
        child.once("exit", (code, signal) => {
          fail(new Error(`Watcher process exited (${code ?? signal})`));
          if (this.child === child) this.child = null;
        });
        child.on("message", (raw: unknown) => {
          if (this.child !== child) return;
          const message = raw as {
            type?: string;
            path?: string;
            message?: string;
            code?: string;
            aviso?: string;
            raizes?: number;
            falhas?: { path: string; message?: string }[];
            novos?: number;
            total?: number;
            motivo?: "overflow" | "raiz-desaparecida" | "raiz-inacessivel" | "raiz-excluida-validacao";
            eventosSemNome?: number;
          };
          if (typeof message.type === "string") vistas.add(message.type);
          // The child existing is not proof that its initial filesystem walk ended.
          // ignoreInitial would swallow files created between started and ready.
          if (message.type === "ready") {
            // Prontidao e um acontecimento, nao um fluxo: um `ready` repetido pelo
            // filho nao pode voltar a resolver nem re-emitir (a UI contaria
            // arranques falsos e o motor duplicaria a transicao).
            if (started) return;
            started = true;
            clearTimeout(timer);
            /* Degradação entregue DENTRO do ready e registada antes do resolve:
               é o buraco que a verificação do OpenCode mediu — ninguém subscreve
               `ready`, por isso um aviso à parte morria ali e o watcher passava a
               listar como vigiadas raízes que nunca attacharam. */
            for (const falha of message.falhas ?? []) {
              if (!falha || typeof falha.path !== "string") continue;
              this.emit("coverage", {
                motivo: "raiz-inacessivel",
                path: falha.path,
                message: `a raiz ${falha.path} não ficou vigiada (${falha.message ?? "falha de attach"})`,
                eventosSemNome: 0,
              });
            }
            if (generation === this.generation) {
              this.emit("ready", {
                elapsedMs: Date.now() - inicio,
                aviso: message.aviso,
                raizes: message.raizes ?? 0,
                raizesComFalha: (message.falhas ?? []).length,
              });
            }
            resolve();
          } else if (generation !== this.generation) return;
          else if (message.type === "gap") {
            /* Buraco de cobertura: o filho perdeu eventos, ou uma raiz deixou de
               existir em runtime. NÃO é falha de arranque, NÃO derruba a proteção
               (quem está vivo continua vigiado) e não pode ser calado — é o único
               sinal que o serviço tem de que a cobertura prometida deixou de ser
               toda. Só faz sentido depois do `ready`: um filho que nunca ficou
               pronto não vigiava nada, e o arranque já falha por si. */
            if (!started) return;
            this.emit("coverage", {
              motivo: message.motivo ?? "overflow",
              path: message.path ?? "",
              message: message.message ?? "cobertura degradada",
              // `novos`/`total` por raiz: o motor decide o delta. `eventosSemNome`
              // fica só para um serviço do outro lado do pipe que ainda não os envie.
              novos: message.novos ?? 0,
              total: message.total ?? 0,
              eventosSemNome: message.eventosSemNome ?? 0,
            });
          } else if (["add", "change", "unlink"].includes(message.type ?? "") && typeof message.path === "string") {
            this.emit(message.type!, message.path);
          } else if (message.type === "error") {
            fail(Object.assign(new Error(message.message ?? "watcher error"), { code: message.code, path: message.path }));
          }
        });
        child.send({ type: "start", paths }, (error) => {
          if (error) fail(error);
        });
      }).catch(async (error) => {
        await this.closeChild();
        throw error;
      });
    });
  }

  stop(): Promise<void> {
    ++this.generation; // Ignore queued events before awaiting process teardown.
    return this.enqueue(() => this.closeChild());
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.transition.then(action, action);
    this.transition = next.catch(() => undefined);
    return next;
  }

  private async closeChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 500);
      const deadline = setTimeout(() => reject(new Error("Watcher process did not exit")), 5000);
      child.once("exit", () => {
        clearTimeout(force);
        clearTimeout(deadline);
        if (this.child === child) this.child = null;
        resolve();
      });
      if (child.connected) child.send({ type: "stop" }, () => undefined);
      else child.kill();
    });
  }
}
