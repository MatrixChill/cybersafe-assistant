/**
 * TP-UPDATE-UI (17/10) — controller REAL da secção de atualizações.
 *
 * Testa o controller diretamente (sem React, sem IPC): ponte ausente, ciclo de
 * subscrição, exclusão mútua de ações (`busy`), respostas stale, rejeições,
 * `install` com `{ confirmed, expectedVersion }` e a preferência automática.
 * A ponte é um mock EXPLÍCITO definido aqui — nada toca o preload real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createUpdatesController } from "../src/components/updates/appUpdateController";
import type { AppUpdateBridge, AppUpdateResult, AppUpdateSnapshot } from "@cybersafe/shared-types";

function snapshot(overrides: Partial<AppUpdateSnapshot> = {}): AppUpdateSnapshot {
  return {
    status: "idle",
    channel: "stable",
    installed: { version: "0.1.1" },
    canInstall: false,
    automaticCheckEnabled: true,
    ...overrides,
  };
}

interface FakeBridge {
  bridge: AppUpdateBridge;
  calls: string[];
  installPayloads: Array<{ confirmed: true; expectedVersion: string }>;
  automaticPayloads: boolean[];
  emit(next: AppUpdateSnapshot): void;
  unsubscribeCount(): number;
  resolve(index: number, result: AppUpdateResult): void;
  reject(index: number, error: unknown): void;
  resolveCancel(index: number, result: AppUpdateResult): void;
  rejectCancel(index: number, error: unknown): void;
}

/** Mock explícito: registra chamadas, permite resolver/rejeitar à mão. */
function createFakeBridge(options: { initial?: AppUpdateSnapshot; getSnapshotRejects?: boolean } = {}): FakeBridge {
  const calls: string[] = [];
  const installPayloads: Array<{ confirmed: true; expectedVersion: string }> = [];
  const automaticPayloads: boolean[] = [];
  const waiters: Array<{ resolve: (r: AppUpdateResult) => void; reject: (e: unknown) => void }> = [];
  // O cancel real pode ficar pendente enquanto a transferência original corre —
  // o mock tem de o permitir resolver/rejeitar à mão (regressão do defeito).
  const cancelWaiters: Array<{ resolve: (r: AppUpdateResult) => void; reject: (e: unknown) => void }> = [];
  let listener: ((next: AppUpdateSnapshot) => void) | null = null;
  let unsubscribes = 0;
  const initial = options.initial ?? snapshot();

  const bridge: AppUpdateBridge = {
    getSnapshot: () => {
      calls.push("getSnapshot");
      return options.getSnapshotRejects ? Promise.reject(new Error("ipc em baixo")) : Promise.resolve(initial);
    },
    check: () => {
      calls.push("check");
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    download: () => {
      calls.push("download");
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    cancel: () => {
      calls.push("cancel");
      return new Promise((resolve, reject) => {
        cancelWaiters.push({ resolve, reject });
      });
    },
    defer: () => {
      calls.push("defer");
      return Promise.resolve({ ok: true, snapshot: snapshot({ status: "deferred" }) });
    },
    install: (request) => {
      calls.push("install");
      installPayloads.push(request);
      return Promise.resolve({ ok: true, snapshot: snapshot({ status: "installing" }) });
    },
    setAutomaticCheck: (enabled) => {
      calls.push("setAutomaticCheck");
      automaticPayloads.push(enabled);
      return Promise.resolve({ ok: true, snapshot: snapshot({ automaticCheckEnabled: enabled }) });
    },
    onState: (callback) => {
      listener = callback;
      return () => {
        unsubscribes += 1;
        listener = null;
      };
    },
  };

  return {
    bridge,
    calls,
    installPayloads,
    automaticPayloads,
    emit: (next) => {
      listener?.(next);
    },
    unsubscribeCount: () => unsubscribes,
    resolve: (index, result) => {
      waiters[index]?.resolve(result);
    },
    reject: (index, error) => {
      waiters[index]?.reject(error);
    },
    resolveCancel: (index, result) => {
      cancelWaiters[index]?.resolve(result);
    },
    rejectCancel: (index, error) => {
      cancelWaiters[index]?.reject(error);
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("Controller de atualizações — ponte ausente", () => {
  it("sem ponte (browser/dev): estado honesto e ações inertes", async () => {
    const controller = createUpdatesController(null);
    assert.equal(controller.getState().bridgeAvailable, false);
    assert.equal(controller.getState().loading, false);
    await controller.check();
    await controller.refresh();
    assert.equal(controller.getState().snapshot, null);
    assert.equal(controller.getState().actionError, null);
  });
});

describe("Controller de atualizações — subscrição e ciclo de vida", () => {
  it("start liga o onState e aplica o snapshot inicial REAL", async () => {
    const fake = createFakeBridge();
    const controller = createUpdatesController(fake.bridge);
    controller.start();
    await flush();
    assert.ok(fake.calls.includes("getSnapshot"));
    assert.equal(controller.getState().snapshot?.status, "idle");
    assert.equal(controller.getState().loading, false);

    fake.emit(snapshot({ status: "available", latest: { version: "0.2.0", publishedAt: "2026-10-01T00:00:00Z", notes: "n" } }));
    assert.equal(controller.getState().snapshot?.status, "available");
  });

  it("subscrição notifica mudanças e o unsubscribe para de notificar", async () => {
    const fake = createFakeBridge();
    const controller = createUpdatesController(fake.bridge);
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => {
      notifications += 1;
    });
    controller.start();
    await flush();
    const afterStart = notifications;
    assert.ok(afterStart > 0, "start devia notificar (loading→snapshot)");

    fake.emit(snapshot({ status: "checking" }));
    assert.ok(notifications > afterStart, "emit devia notificar");

    unsubscribe();
    const frozen = notifications;
    fake.emit(snapshot({ status: "idle" }));
    assert.equal(notifications, frozen, "após unsubscribe não pode haver notificações");
  });

  it("dispose cancela a subscrição da ponte e bloqueia respostas stale", async () => {
    const fake = createFakeBridge();
    const controller = createUpdatesController(fake.bridge);
    controller.start();
    await flush();
    void controller.check();
    controller.dispose();
    assert.equal(fake.unsubscribeCount(), 1, "dispose tem de cancelar o onState");

    let notificationsAfterDispose = 0;
    controller.subscribe(() => {
      notificationsAfterDispose += 1;
    });
    fake.resolve(0, { ok: true, snapshot: snapshot({ status: "up-to-date" }) });
    await flush();
    assert.equal(controller.getState().snapshot?.status, "idle", "resposta stale não pode escrever estado");
    assert.equal(notificationsAfterDispose, 0);
  });

  it("start depois de dispose volta a subscrever (StrictMode dev)", async () => {
    const fake = createFakeBridge();
    const controller = createUpdatesController(fake.bridge);
    controller.start();
    await flush();
    controller.dispose();
    controller.start();
    await flush();
    fake.emit(snapshot({ status: "available", latest: { version: "0.3.0", publishedAt: "2026-10-02T00:00:00Z", notes: "" } }));
    assert.equal(controller.getState().snapshot?.status, "available");
  });
});

describe("Controller de atualizações — ações", () => {
  it("busy é exclusivo: um pedido concorrente é ignorado", async () => {
    const fake = createFakeBridge();
    const controller = createUpdatesController(fake.bridge);
    controller.start();
    await flush();

    void controller.check();
    void controller.download();
    assert.ok(!fake.calls.includes("download"), "com check pendente, download tem de ser ignorado");

    fake.resolve(0, { ok: true, snapshot: snapshot({ status: "up-to-date" }) });
    await flush();
    assert.equal(controller.getState().busy, null);

    void controller.download();
    assert.ok(fake.calls.includes("download"), "depois de libertar, a ação corre");
    fake.resolve(1, { ok: true, snapshot: snapshot({ status: "downloading", progress: { downloadedBytes: 10 } }) });
    await flush();
    assert.equal(controller.getState().snapshot?.status, "downloading");
  });

  it("rejeição da ponte vira erro honesto, sem crash nem unhandled rejection", async () => {
    const fake = createFakeBridge();
    const controller = createUpdatesController(fake.bridge);
    controller.start();
    await flush();
    void controller.check();
    fake.reject(0, new Error("canal morto"));
    await flush();
    const state = controller.getState();
    assert.equal(state.actionError?.code, "internal");
    assert.match(state.actionError?.message ?? "", /canal morto/);
    assert.equal(state.busy, null);
  });

  it("ok:false preserva o snapshot e o código REAIS do contrato", async () => {
    const fake = createFakeBridge();
    const controller = createUpdatesController(fake.bridge);
    controller.start();
    await flush();
    void controller.check();
    fake.resolve(0, {
      ok: false,
      error: "offline",
      snapshot: snapshot({ status: "error", error: { code: "offline", message: "sem rede real" } }),
    });
    await flush();
    const state = controller.getState();
    assert.equal(state.snapshot?.status, "error");
    assert.deepEqual(state.actionError, { code: "offline", message: "sem rede real" });
  });

  it("install envia confirmed+expectedVersion exatos; versão vazia nem chega à ponte", async () => {
    const fake = createFakeBridge();
    const controller = createUpdatesController(fake.bridge);
    controller.start();
    await flush();

    await controller.install("");
    assert.equal(fake.installPayloads.length, 0, "versão vazia não pode chegar à ponte");

    void controller.install("0.2.0");
    await flush();
    assert.deepEqual(fake.installPayloads, [{ confirmed: true, expectedVersion: "0.2.0" }]);
    assert.equal(controller.getState().snapshot?.status, "installing");
    assert.equal(controller.getState().busy, null);
  });

  it("setAutomaticCheck envia o boolean real e aplica o snapshot devolvido", async () => {
    const fake = createFakeBridge();
    const controller = createUpdatesController(fake.bridge);
    controller.start();
    await flush();
    void controller.setAutomaticCheck(false);
    await flush();

    assert.deepEqual(fake.automaticPayloads, [false]);
    assert.equal(controller.getState().snapshot?.automaticCheckEnabled, false);
  });
});

describe("Controller de atualizações — cancelamento com operação pendente", () => {
  it("com download PENDENTE, cancel chega à ponte e o busy só sai quando o original termina", async () => {
    const fake = createFakeBridge();
    const controller = createUpdatesController(fake.bridge);
    controller.start();
    await flush();

    void controller.download();
    await flush();
    assert.equal(controller.getState().busy, "download");

    const cancelamento = controller.cancel();
    await flush();
    assert.equal(
      fake.calls.filter((c) => c === "cancel").length,
      1,
      "cancel tem de ser invocado ANTES de o download resolver (era o defeito)",
    );
    assert.equal(controller.getState().busy, "cancel", "o busy fica em cancel — nunca fica livre a meio");

    fake.resolveCancel(0, { ok: true, snapshot: snapshot({ status: "idle" }) });
    await cancelamento;
    await flush();
    assert.equal(
      controller.getState().busy,
      "cancel",
      "a resposta do cancel não pode libertar o busy — quem o liberta é a operação original",
    );

    void controller.download();
    assert.equal(
      fake.calls.filter((c) => c === "download").length,
      1,
      "nenhum download novo pode arrancar enquanto a operação original não termina",
    );

    fake.resolve(0, {
      ok: false,
      error: "cancelled",
      snapshot: snapshot({ status: "idle", error: { code: "cancelled", message: "Operação cancelada." } }),
    });
    await flush();
    assert.equal(controller.getState().busy, null, "a operação original termina e só então liberta o busy");
    assert.equal(controller.getState().actionError?.code, "cancelled", "o desfecho real (cancelled) é preservado");
  });

  it("cancel durante um check pendente também chega à ponte", async () => {
    const fake = createFakeBridge();
    const controller = createUpdatesController(fake.bridge);
    controller.start();
    await flush();

    void controller.check();
    await flush();
    assert.equal(controller.getState().busy, "check");

    const cancelamento = controller.cancel();
    await flush();
    assert.equal(fake.calls.filter((c) => c === "cancel").length, 1, "cancel tem de chegar à ponte com o check pendente");

    fake.resolveCancel(0, { ok: true, snapshot: snapshot({ status: "idle" }) });
    await cancelamento;
    await flush();
    assert.equal(controller.getState().busy, "cancel", "busy mantém-se até o check original terminar");

    fake.resolve(0, { ok: true, snapshot: snapshot({ status: "up-to-date" }) });
    await flush();
    assert.equal(controller.getState().busy, null);
    assert.equal(controller.getState().snapshot?.status, "up-to-date");
  });

  it("duplo cancelamento: o segundo clique não reentra na ponte", async () => {
    const fake = createFakeBridge();
    const controller = createUpdatesController(fake.bridge);
    controller.start();
    await flush();

    void controller.download();
    await flush();
    void controller.cancel();
    await flush();
    assert.equal(controller.getState().busy, "cancel");

    await controller.cancel();
    assert.equal(fake.calls.filter((c) => c === "cancel").length, 1, "com cancel em curso, não se repete o pedido");

    fake.resolveCancel(0, { ok: true, snapshot: snapshot({ status: "idle" }) });
    fake.resolve(0, { ok: false, error: "cancelled", snapshot: snapshot({ status: "idle", error: { code: "cancelled", message: "cancelado" } }) });
    await flush();
    assert.equal(controller.getState().busy, null);
  });

  it("rejeição do cancel vira erro honesto e o busy da operação original mantém-se", async () => {
    const fake = createFakeBridge();
    const controller = createUpdatesController(fake.bridge);
    controller.start();
    await flush();

    void controller.download();
    await flush();
    const cancelamento = controller.cancel();
    await flush();
    fake.rejectCancel(0, new Error("canal morto"));
    await cancelamento;
    await flush();

    const state = controller.getState();
    assert.equal(state.actionError?.code, "internal");
    assert.match(state.actionError?.message ?? "", /canal morto/);
    assert.equal(state.busy, "cancel", "a operação original continua pendente: o busy não é fingido");

    fake.resolve(0, { ok: false, error: "cancelled", snapshot: snapshot({ status: "idle", error: { code: "cancelled", message: "cancelado" } }) });
    await flush();
    assert.equal(controller.getState().busy, null);
  });

  it("cancel com o controller livre (transferência em segundo plano do main) usa e liberta o seu próprio busy", async () => {
    const fake = createFakeBridge();
    const controller = createUpdatesController(fake.bridge);
    controller.start();
    await flush();
    fake.emit(snapshot({ status: "downloading", progress: { downloadedBytes: 10 } }));

    const cancelamento = controller.cancel();
    await flush();
    assert.equal(fake.calls.filter((c) => c === "cancel").length, 1);
    assert.equal(controller.getState().busy, "cancel");

    fake.resolveCancel(0, { ok: true, snapshot: snapshot({ status: "idle" }) });
    await cancelamento;
    await flush();
    assert.equal(controller.getState().busy, null, "sem operação pendente, o cancel é dono do seu busy");
    assert.equal(controller.getState().snapshot?.status, "idle");
  });

  it("dispose durante um cancel pendente: nenhuma escrita de estado (unmount seguro)", async () => {
    const fake = createFakeBridge();
    const controller = createUpdatesController(fake.bridge);
    controller.start();
    await flush();

    void controller.download();
    await flush();
    void controller.cancel();
    await flush();
    controller.dispose();

    fake.resolveCancel(0, { ok: true, snapshot: snapshot({ status: "up-to-date" }) });
    fake.resolve(0, { ok: true, snapshot: snapshot({ status: "up-to-date" }) });
    await flush();
    assert.equal(controller.getState().snapshot?.status, "idle", "respostas após dispose não escrevem estado");
  });
});
