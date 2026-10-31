/**
 * TP-POSTMANUAL-P0-UPDATES-TERMINAL (21/10) — o "A consultar o estado…" sem fim.
 *
 * Dois caminhos reproduzem o relato humano, SEM ponte real (mock explícito):
 *  1. React StrictMode (activo em main.tsx): monta → start() → dispose() →
 *     start() com a MESMA instância de controller (sobrevive no useRef). A primeira leitura
 *     fica pendente; o restart tem de arrancar uma leitura NOVA em vez de
 *     herdar o `busy` da anterior.
 *  2. A ponte que nunca resolve/rejeita: a leitura tem prazo FINITO, vira erro
 *     terminal e oferece retry explícito — retry que só relê o snapshot, nunca
 *     dispara check/download/install/automatic.
 *
 * Nada aqui prova GUI/cliques/teclado; SSR prova o painel real em estado
 * construído. Reteste humano continua necessário.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppUpdateBridge, AppUpdateResult, AppUpdateSnapshot } from "@cybersafe/shared-types";
import { createUpdatesController } from "../src/components/updates/appUpdateController";
import type { UpdatesActions, UpdatesViewState } from "../src/components/updates/appUpdateController";
import { UpdatesPanel } from "../src/components/updates/UpdatesPanel";

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

const unconfigured = snapshot({
  status: "unconfigured",
  automaticCheckEnabled: false,
});

const TIMEOUT_MS = 25;

interface ReadWaiter {
  resolve(value: AppUpdateSnapshot): void;
  reject(error: unknown): void;
}

interface ReadBridge {
  bridge: AppUpdateBridge;
  calls: string[];
  reads: ReadWaiter[];
  resolveRead(index: number, value: AppUpdateSnapshot): void;
  rejectRead(index: number, error: unknown): void;
  emit(value: AppUpdateSnapshot): void;
}

/** Mock explícito: getSnapshot fica SEMPRE pendente até o teste decidir. */
function createReadBridge(): ReadBridge {
  const calls: string[] = [];
  const reads: ReadWaiter[] = [];
  let listener: ((next: AppUpdateSnapshot) => void) | null = null;

  const bridge: AppUpdateBridge = {
    getSnapshot: () => {
      calls.push("getSnapshot");
      return new Promise<AppUpdateSnapshot>((resolve, reject) => {
        reads.push({ resolve, reject });
      });
    },
    check: (): Promise<AppUpdateResult> => {
      calls.push("check");
      return Promise.resolve({ ok: true, snapshot: snapshot({ status: "checking" }) });
    },
    download: (): Promise<AppUpdateResult> => {
      calls.push("download");
      return Promise.resolve({ ok: true, snapshot: snapshot({ status: "downloading" }) });
    },
    cancel: (): Promise<AppUpdateResult> => {
      calls.push("cancel");
      return Promise.resolve({ ok: true, snapshot: snapshot() });
    },
    defer: (): Promise<AppUpdateResult> => {
      calls.push("defer");
      return Promise.resolve({ ok: true, snapshot: snapshot({ status: "deferred" }) });
    },
    install: (): Promise<AppUpdateResult> => {
      calls.push("install");
      return Promise.resolve({ ok: true, snapshot: snapshot({ status: "installing" }) });
    },
    setAutomaticCheck: (): Promise<AppUpdateResult> => {
      calls.push("setAutomaticCheck");
      return Promise.resolve({ ok: true, snapshot: snapshot() });
    },
    onState: (callback) => {
      listener = callback;
      return () => {
        if (listener === callback) listener = null;
      };
    },
  };

  return {
    bridge,
    calls,
    reads,
    resolveRead: (index, value) => {
      reads[index]?.resolve(value);
    },
    rejectRead: (index, error) => {
      reads[index]?.reject(error);
    },
    emit: (value) => {
      listener?.(value);
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 600): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("tempo esgotado à espera do estado esperado");
    await sleep(5);
  }
}

/** O controller com prazo curto — o prazo é injetável, o default é de produção. */
function controllerWithBridge(bridge: AppUpdateBridge, snapshotReadTimeoutMs = TIMEOUT_MS) {
  return createUpdatesController(bridge, { snapshotReadTimeoutMs });
}

const NOOP_ACTIONS: UpdatesActions = {
  refresh() {},
  check() {},
  download() {},
  cancel() {},
  defer() {},
  install() {},
  setAutomaticCheck() {},
};

function mount(state: UpdatesViewState): string {
  return renderToStaticMarkup(createElement(UpdatesPanel, { state, actions: NOOP_ACTIONS }));
}

describe("Atualizações — StrictMode: start/dispose/start com leitura pendente", () => {
  it("o restart arranca uma leitura NOVA e não herda o busy do primeiro start", async () => {
    const fake = createReadBridge();
    const controller = controllerWithBridge(fake.bridge);

    controller.start();
    await flush();
    assert.equal(fake.reads.length, 1, "o primeiro start devia pedir o snapshot");
    assert.equal(controller.getState().busy, "refresh");
    assert.equal(controller.getState().loading, true);

    // StrictMode em dev: cleanup + efeito outra vez, com a MESMA instância.
    controller.dispose();
    controller.start();
    await flush();

    assert.equal(fake.reads.length, 2, "depois do restart tem de existir uma leitura nova");
    assert.equal(controller.getState().busy, "refresh", "o busy é o da leitura nova, não um resto da anterior");
    assert.equal(controller.getState().loading, true);

    fake.resolveRead(1, snapshot({ status: "up-to-date" }));
    await flush();
    const state = controller.getState();
    assert.equal(state.snapshot?.status, "up-to-date");
    assert.equal(state.loading, false, "sem spinner eterno depois de a leitura responder");
    assert.equal(state.busy, null);
    assert.equal(state.actionError, null);
  });

  it("depois do restart as ações voltam a estar disponíveis (o busy não fica preso)", async () => {
    const fake = createReadBridge();
    const controller = controllerWithBridge(fake.bridge);

    controller.start();
    await flush();
    controller.dispose();
    controller.start();
    await flush();

    // A leitura nova ainda está em curso: uma ação espera por ela (é o
    // `busy` exclusivo normal). Depois de responder, as ações têm de voltar.
    fake.resolveRead(1, snapshot({ status: "idle" }));
    await flush();
    assert.equal(controller.getState().busy, null);

    await controller.check();
    assert.ok(fake.calls.includes("check"), "com o busy preso, o check nunca chegava à ponte");
    assert.equal(controller.getState().busy, null);
    assert.equal(controller.getState().snapshot?.status, "checking");
  });
});

describe("Atualizações — leitura getSnapshot pendente vira erro terminal com prazo finito", () => {
  it("sem resposta, o estado deixa de estar 'a consultar' e declara timeout", async () => {
    const fake = createReadBridge();
    const controller = controllerWithBridge(fake.bridge);

    controller.start();
    await flush();
    assert.equal(controller.getState().loading, true, "antes do prazo há mesmo uma leitura em curso");

    await waitFor(() => controller.getState().loading === false);
    const state = controller.getState();
    assert.equal(state.snapshot, null);
    assert.equal(state.busy, null, "o busy não pode ficar ocupado para sempre");
    assert.equal(state.actionError?.code, "timeout", "o prazo esgotado é um erro REAL e nomeado");
    assert.match(state.actionError?.message ?? "", /prazo/);
    assert.equal(fake.calls.length, 1, "sem retry automático: uma única leitura");
  });

  it("se o onState entregar o snapshot real antes do prazo, o timeout fecha a leitura sem inventar erro", async () => {
    const fake = createReadBridge();
    const controller = controllerWithBridge(fake.bridge);

    controller.start();
    await flush();

    fake.emit(snapshot({ status: "available" }));
    assert.equal(controller.getState().snapshot?.status, "available");

    await waitFor(() => controller.getState().busy === null);
    const state = controller.getState();
    assert.equal(state.actionError, null, "há estado real: o prazo não pode carimbar um erro");
    assert.equal(state.snapshot?.status, "available");
    assert.equal(state.loading, false);
  });

  it("rejeição da leitura é erro terminal, sem nova tentativa automática", async () => {
    const fake = createReadBridge();
    const controller = controllerWithBridge(fake.bridge);

    controller.start();
    await flush();
    fake.rejectRead(0, new Error("canal morto"));
    await flush();

    let state = controller.getState();
    assert.equal(state.loading, false);
    assert.equal(state.busy, null);
    assert.equal(state.actionError?.code, "internal");
    assert.match(state.actionError?.message ?? "", /canal morto/);

    await sleep(TIMEOUT_MS * 3);
    state = controller.getState();
    assert.equal(fake.reads.length, 1, "um erro de leitura não pode entrar em retry automático");
    assert.equal(state.actionError?.code, "internal");
  });

  it("a resposta tardia depois do prazo é ignorada (não escreve estado nem notifica)", async () => {
    const fake = createReadBridge();
    const controller = controllerWithBridge(fake.bridge);

    controller.start();
    await flush();
    await waitFor(() => controller.getState().loading === false);

    let notifications = 0;
    controller.subscribe(() => {
      notifications += 1;
    });

    fake.resolveRead(0, snapshot({ status: "available" }));
    await flush();

    assert.equal(controller.getState().snapshot, null, "resposta tardia não pode aparecer como estado actual");
    assert.equal(controller.getState().actionError?.code, "timeout");
    assert.equal(notifications, 0, "uma resposta tardia não pode notificar a UI");
  });

  it("retry explícito só relê o snapshot — nunca check/download/install/automatic", async () => {
    const fake = createReadBridge();
    const controller = controllerWithBridge(fake.bridge);

    controller.start();
    await flush();
    await waitFor(() => controller.getState().loading === false);
    assert.equal(fake.reads.length, 1);

    const retry = controller.refresh();
    await flush();
    assert.equal(fake.reads.length, 2, "o retry tem de pedir o snapshot outra vez");
    for (const proibido of ["check", "download", "install", "setAutomaticCheck", "cancel", "defer"]) {
      assert.ok(!fake.calls.includes(proibido), `o retry não pode chamar ${proibido}`);
    }

    fake.resolveRead(1, snapshot({ status: "idle", checkedAt: "2026-10-21T20:00:00Z" }));
    await retry;
    const state = controller.getState();
    assert.equal(state.snapshot?.status, "idle");
    assert.equal(state.loading, false);
    assert.equal(state.busy, null);
    assert.equal(state.actionError, null, "o retry bem-sucedido limpa o erro da leitura");
  });

  it("dispose durante a leitura: nada é escrito e nenhum timer fica pendente", async () => {
    const fake = createReadBridge();
    // Prazo longo de propósito: se o timer não fosse limpo no dispose, este
    // teste ficaria preso no processo. O dispose tem de o anular.
    const controller = controllerWithBridge(fake.bridge, 30_000);

    controller.start();
    await flush();
    controller.dispose();

    let notifications = 0;
    controller.subscribe(() => {
      notifications += 1;
    });
    fake.resolveRead(0, snapshot({ status: "up-to-date" }));
    await flush();

    assert.equal(controller.getState().snapshot, null, "nada pode ser escrito depois do dispose");
    assert.equal(notifications, 0);
  });
});

describe("Atualizações — snapshot sem configuração continua terminal (sem retry)", () => {
  it("unconfigured é mostrado tal como veio, uma só leitura", async () => {
    const fake = createReadBridge();
    const controller = controllerWithBridge(fake.bridge);

    controller.start();
    await flush();
    fake.resolveRead(0, unconfigured);
    await flush();
    await sleep(TIMEOUT_MS * 3);

    const state = controller.getState();
    assert.equal(state.snapshot?.status, "unconfigured");
    assert.equal(state.actionError, null, "sem configuração não é um erro de leitura");
    assert.equal(state.busy, null);
    assert.equal(state.loading, false);
    assert.equal(fake.reads.length, 1, "estado terminal real não entra em retry");
    assert.ok(!fake.calls.includes("check"), "unconfigured nunca dispara um check");
  });

  it("unsupported também é terminal e não pede nada à ponte", async () => {
    const fake = createReadBridge();
    const controller = controllerWithBridge(fake.bridge);

    controller.start();
    await flush();
    fake.resolveRead(0, snapshot({ status: "unsupported", automaticCheckEnabled: false }));
    await flush();

    const state = controller.getState();
    assert.equal(state.snapshot?.status, "unsupported");
    assert.equal(state.actionError, null);
    assert.equal(fake.reads.length, 1);
  });
});

describe("Atualizações — painel real (SSR) sem spinner eterno", () => {
  it("leitura falhada: mostra erro e 'Tentar novamente' em vez de 'a consultar'", () => {
    const html = mount({
      bridgeAvailable: true,
      loading: false,
      snapshot: null,
      busy: null,
      actionError: { code: "timeout", message: "O atualizador não respondeu no prazo previsto." },
    });

    assert.match(html, /data-testid="app-update-read-error"/);
    assert.match(html, /role="alert"/);
    assert.ok(html.includes("Tentar novamente"), "sem botão de retry explícito");
    assert.match(html, /data-testid="app-update-retry"/);
    assert.ok(!html.includes("A consultar o estado das atualizações…"), "o spinner não pode continuar com um erro terminal");
    assert.ok(
      !html.match(/<button[^>]*data-testid="app-update-retry"[^>]*disabled=""/),
      "o retry tem de estar activo — não há nada em curso",
    );
  });

  it("a ler: mostra o texto de consulta e não oferece retry", () => {
    const html = mount({
      bridgeAvailable: true,
      loading: true,
      snapshot: null,
      busy: "refresh",
      actionError: null,
    });
    assert.match(html, /A consultar o estado das atualizações…/);
    assert.ok(!html.includes("data-testid=\"app-update-retry\""), "durante a leitura não há retry");
    assert.ok(!html.includes("data-testid=\"app-update-read-error\""));
  });

  it("unconfigured: honesto e sem retry (o estado real é terminal, não um erro)", () => {
    const html = mount({
      bridgeAvailable: true,
      loading: false,
      snapshot: unconfigured,
      busy: null,
      actionError: null,
    });
    assert.match(html, /data-status="unconfigured"/);
    assert.ok(!html.includes("data-testid=\"app-update-retry\""), "sem retry num estado terminal real");
    assert.ok(!html.includes("data-testid=\"app-update-read-error\""));
  });
});
