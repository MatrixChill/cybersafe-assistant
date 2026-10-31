import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as scanSessionReal from "../src/lib/scanSession";

// Mesmo arranque do `scanner-page-render.test.ts`: `tsx` compila JSX com runtime
// clássico e o módulo da página é lido à custa de globais mínimos sem DOM.
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const {
  createFolderConfirmationGate,
  confirmFolderSelection,
  folderConfirmationKeyAction,
  FolderConfirmationPanel,
  default: FileScannerPage,
} = await import("../src/pages/FileScannerPage");
const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");

/* ─────────────────────────────────────────────────────────────────────────────
 * Harness dos HANDLERS REAIS do componente: executa `handleFolderScan` e
 * `handleConfirmFolder`/`handleCancelFolder` como o utilizador os invoca (o
 * onClick do botão que está na árvore renderizada e os props do painel que a
 * página montou), com hooks determinísticos e sem DOM/Electron — o mesmo padrão
 * de `service-connection-app.test.ts`. Só as fronteiras são falsas: o diálogo
 * nativo e os componentes filhos (que não são executados). O `launchScan` que
 * corre é o do componente, por isso um `launchScan` direto no handler deixa de
 * poder passar despercebido.
 * ──────────────────────────────────────────────────────────────────────────── */
function scannerHarness(transformSource: (source: string) => string = (source) => source) {
  const cells: any[] = [];
  let cursor = 0;
  let dirty = true;
  let tree: any;
  /** Props do render atual (a página recebe `pendingScan`/`onScanConsumed`). */
  let props: Record<string, unknown> = {};
  const effects: (() => void)[] = [];
  const intervals = new Map<number, () => unknown>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  /** Cada `startScan` que o componente REAL chega a pedir. */
  const starts: { type: string; path?: string }[] = [];
  /** Respostas do diálogo nativo, por ordem (string, null ou Promise pendente). */
  const dialogs: unknown[] = [];

  const api = {
    openFolderDialog: async () => (await dialogs.shift()) as string | null,
    openFileDialog: async () => null,
    startScan: async (type: string, path?: string) => {
      starts.push({ type, path });
      return { success: true, id: "s1" };
    },
    getActiveScan: async () => null,
    getLastScan: async () => null,
    cancelScan: async () => ({ success: true }),
    onScanProgress: () => () => {},
    onScanSession: () => () => {},
    getPathForFile: () => undefined,
  };

  const same = (a: any[], b: any[]) =>
    a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(initial: any) {
      const i = cursor++;
      if (!cells[i]) cells[i] = { value: typeof initial === "function" ? initial() : initial };
      return [
        cells[i].value,
        (value: any) => {
          const next = typeof value === "function" ? value(cells[i].value) : value;
          if (!Object.is(next, cells[i].value)) {
            cells[i].value = next;
            dirty = true;
          }
        },
      ];
    },
    useRef(value: any) {
      const i = cursor++;
      return (cells[i] ??= { current: value });
    },
    useMemo(fn: () => any, deps: any[]) {
      const i = cursor++;
      if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { value: fn(), deps };
      return cells[i].value;
    },
    useCallback(fn: any, deps: any[]) {
      return hooks.useMemo(() => fn, deps);
    },
    useEffect(fn: () => any, deps: any[]) {
      const i = cursor++;
      if (!cells[i] || !same(cells[i].deps, deps)) {
        const previous = cells[i];
        cells[i] = { deps };
        effects.push(() => {
          previous?.cleanup?.();
          cells[i].cleanup = fn();
        });
      }
    },
    useId() {
      return `id-${cursor++}`;
    },
  };

  const modules: Record<string, any> = {
    react: hooks,
    "react/jsx-runtime": {
      jsx: (type: any, props: any) => ({ type, props }),
      jsxs: (type: any, props: any) => ({ type, props }),
    },
    "@/lib/utils": { cn: (...parts: unknown[]) => parts.filter(Boolean).join(" ") },
    "@/lib/shutdownState": { isAppShuttingDown: () => false, onAppShutdown: () => () => {} },
    "@/lib/scanSession": scanSessionReal,
    "@cybersafe/shared-types": {},
    "../components/MatrixAvatar": { MatrixAvatar: "MatrixAvatar" },
    "../components/ScanHistoryPanel": { ScanHistoryPanel: "ScanHistoryPanel" },
    "../components/UsbProtectionPanel": { UsbProtectionPanel: "UsbProtectionPanel" },
  };

  const exports: any = {};
  const source = transformSource(readFileSync(new URL("../src/pages/FileScannerPage.tsx", import.meta.url), "utf8"))
    .replace(/import\.meta\.env\?\.DEV/g, "undefined");
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    require: (name: string) =>
      modules[name] ?? new Proxy({ __esModule: true, default: name }, { get: (t: any, k) => t[k] ?? String(k) }),
    window: { electronAPI: api },
    console,
    setTimeout: (fn: () => void) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (fn: () => unknown) => {
      intervals.set(++timerId, fn);
      return timerId;
    },
    clearInterval: (id: number) => intervals.delete(id),
    Date,
    Promise,
    Math,
    Number,
    Object,
    String,
    Array,
    Error,
    Set,
    Map,
  });

  const textOf = (node: any): string => {
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (typeof node === "object" && node.props) return textOf(node.props.children);
    return "";
  };
  const walk = (node: any, visit: (n: any) => boolean): any => {
    if (!node || typeof node !== "object") return undefined;
    if (visit(node)) return node;
    for (const child of [node.props?.children].flat(Infinity)) {
      const found = walk(child, visit);
      if (found) return found;
    }
    return undefined;
  };
  const clickable = (text: string) =>
    walk(tree, (n) => n.type === "button" && typeof n.props?.onClick === "function" && textOf(n).includes(text));
  /** O painel que a PÁGINA montou, com a seleção que lhe passou e os handlers reais. */
  const panel = () => walk(tree, (n) => !!n.props && "selection" in n.props && typeof n.props.onConfirm === "function");

  async function flush() {
    for (let i = 0; i < 10; i++) {
      if (dirty) {
        dirty = false;
        cursor = 0;
        tree = exports.default(props);
      }
      effects.splice(0).forEach((fn) => fn());
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return {
    starts,
    flush,
    async boot(nextProps: Record<string, unknown> = {}) {
      props = nextProps;
      dirty = true;
      await flush();
    },
    /** Re-render com props novas (ou as mesmas), sem remontar as células. */
    async render(nextProps: Record<string, unknown>) {
      props = nextProps;
      dirty = true;
      await flush();
    },
    answer(answer: unknown) {
      dialogs.push(answer);
    },
    click(text: string) {
      const node = clickable(text);
      assert.ok(node, `botão «${text}» não está na árvore renderizada`);
      return node.props.onClick();
    },
    panel,
    text: () => textOf(tree),
    deferred() {
      let resolve!: (value: unknown) => void;
      const promise = new Promise((r) => {
        resolve = r;
      });
      return { promise, resolve };
    },
    dispose() {
      cells.forEach((cell) => cell?.cleanup?.());
      intervals.clear();
      timers.clear();
    },
  };
}

/* Verificação partilhada pelo teste do produto e pelo teste mutante. */
async function verifyDialogOnly(app: ReturnType<typeof scannerHarness>) {
  await app.boot();
  app.answer("C:\\Users\\caioc\\Downloads");
  await app.click("Analisar uma Pasta");
  await app.flush();

  // O diálogo devolveu caminho: nada foi analisado. Só há uma seleção em cena,
  // e é exatamente a que o diálogo devolveu — com os handlers reais ligados.
  assert.deepEqual(app.starts, [], "abrir o diálogo nunca inicia uma análise");
  const mostrado = app.panel();
  assert.ok(mostrado, "o painel de confirmação tem de estar montado");
  assert.equal(mostrado.props.selection.path, "C:\\Users\\caioc\\Downloads");
  assert.equal(mostrado.props.selection.name, "Downloads");
  assert.equal(typeof mostrado.props.onConfirm, "function");
  assert.equal(typeof mostrado.props.onCancel, "function");
}

describe("TP-A2 · handlers reais: diálogo não inicia, confirmação inicia uma", () => {
  test("resolver o diálogo dá zero startScan; confirmar dá exatamente um do caminho mostrado", async () => {
    const app = scannerHarness();
    try {
      await verifyDialogOnly(app);

      app.panel().props.onConfirm();
      await app.flush();

      assert.deepEqual(app.starts, [{ type: "custom", path: "C:\\Users\\caioc\\Downloads" }]);
      assert.equal(app.panel(), undefined, "o painel desaparece após confirmar");
    } finally {
      app.dispose();
    }
  });

  test("duplo clique no confirmar do componente continua a ser um único startScan", async () => {
    const app = scannerHarness();
    try {
      await app.boot();
      app.answer("C:\\Fotos");
      await app.click("Analisar uma Pasta");
      await app.flush();

      const { onConfirm } = app.panel().props;
      onConfirm();
      onConfirm();
      await app.flush();

      assert.deepEqual(app.starts, [{ type: "custom", path: "C:\\Fotos" }]);
    } finally {
      app.dispose();
    }
  });

  test("cancelar no componente deixa zero análises e limpa a pasta mostrada", async () => {
    const app = scannerHarness();
    try {
      await app.boot();
      app.answer("C:\\Documentos");
      await app.click("Analisar uma Pasta");
      await app.flush();

      app.panel().props.onCancel();
      await app.flush();

      assert.deepEqual(app.starts, []);
      assert.equal(app.panel(), undefined, "a seleção cancelada sai de cena");
    } finally {
      app.dispose();
    }
  });

  test("fechar o diálogo sem caminho não deixa confirmação nem análise", async () => {
    for (const semCaminho of [null, "", "   "]) {
      const app = scannerHarness();
      try {
        await app.boot();
        app.answer(semCaminho);
        await app.click("Analisar uma Pasta");
        await app.flush();

        assert.deepEqual(app.starts, []);
        assert.equal(app.panel(), undefined);
      } finally {
        app.dispose();
      }
    }
  });

  test("seleção A -> novo diálogo B: o handler antigo não analisa A nem B", async () => {
    const app = scannerHarness();
    try {
      await app.boot();
      app.answer("C:\\A");
      await app.click("Analisar uma Pasta");
      await app.flush();
      assert.equal(app.panel().props.selection.path, "C:\\A");
      // Handler real do render que mostrava A.
      const confirmarA = app.panel().props.onConfirm;

      app.answer("C:\\B");
      await app.click("Analisar uma Pasta");
      await app.flush();
      assert.equal(app.panel().props.selection.path, "C:\\B", "o ecrã passa a mostrar B");

      // O botão que mostrava A já foi substituído: o handler antigo não pode
      // analisar nem A nem B.
      confirmarA();
      await app.flush();
      assert.deepEqual(app.starts, []);

      app.panel().props.onConfirm();
      await app.flush();
      assert.deepEqual(app.starts, [{ type: "custom", path: "C:\\B" }]);
    } finally {
      app.dispose();
    }
  });

  test("resposta que chega depois do unmount não faz scan", async () => {
    const app = scannerHarness();
    try {
      await app.boot();
      const pending = app.deferred();
      app.answer(pending.promise);
      void app.click("Analisar uma Pasta");

      app.dispose();
      pending.resolve("C:\\DepoisDoUnmount");
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(app.starts, []);
    } finally {
      app.dispose();
    }
  });

  test("mutante: reintroduzir launchScan direto no handler faz a suite falhar", async () => {
    // Mutação apenas em memória — o ficheiro em disco não é tocado.
    const mutant = scannerHarness((source) =>
      source.replace(
        "setPendingFolder(folderGate.pending())",
        'setPendingFolder(null); void launchScan("custom", folderPath ?? undefined, "mutante", "folder")',
      ),
    );
    await assert.rejects(() => verifyDialogOnly(mutant), assert.AssertionError);
    mutant.dispose();
  });
});

describe("TP-A2 · pendingScan vindo do Dashboard não contorna a confirmação", () => {
  function pendingFolderScan(consumidos: () => number) {
    return {
      pendingScan: { type: "custom", targetPath: "C:\\Users\\caioc\\Desktop\\Projecto" },
      onScanConsumed: () => consumidos(),
    };
  }

  test("montar com pendingScan custom prepara a seleção e não arranca nada", async () => {
    let consumidos = 0;
    const app = scannerHarness();
    try {
      await app.boot(pendingFolderScan(() => (consumidos += 1)));

      assert.deepEqual(app.starts, [], "o alvo do Dashboard não pode arrancar sozinho");
      const mostrado = app.panel();
      assert.ok(mostrado, "tem de aparecer o painel de confirmação");
      assert.equal(mostrado.props.selection.path, "C:\\Users\\caioc\\Desktop\\Projecto");
      assert.equal(mostrado.props.selection.name, "Projecto");
      assert.equal(consumidos, 1, "a prop é consumida uma vez");
    } finally {
      app.dispose();
    }
  });

  test("confirmar o alvo do Dashboard arranca exatamente um scan desse caminho", async () => {
    let consumidos = 0;
    const app = scannerHarness();
    try {
      const props = pendingFolderScan(() => (consumidos += 1));
      await app.boot(props);

      app.panel().props.onConfirm();
      await app.flush();

      assert.deepEqual(app.starts, [{ type: "custom", path: "C:\\Users\\caioc\\Desktop\\Projecto" }]);
      assert.equal(consumidos, 1);
    } finally {
      app.dispose();
    }
  });

  test("cancelar o alvo do Dashboard não arranca nada", async () => {
    let consumidos = 0;
    const app = scannerHarness();
    try {
      await app.boot(pendingFolderScan(() => (consumidos += 1)));

      app.panel().props.onCancel();
      await app.flush();

      assert.deepEqual(app.starts, []);
      assert.equal(app.panel(), undefined);
      assert.equal(consumidos, 1);
    } finally {
      app.dispose();
    }
  });

  test("re-render com a mesma prop (ou objeto novo) não duplica seleção nem scan", async () => {
    let consumidos = 0;
    const app = scannerHarness();
    try {
      const props = pendingFolderScan(() => (consumidos += 1));
      await app.boot(props);
      const primeira = app.panel();

      await app.render(props);
      await app.render({ ...props, pendingScan: { ...props.pendingScan } });

      assert.deepEqual(app.starts, []);
      assert.equal(consumidos, 1, "a prop não é consumida outra vez");
      assert.equal(app.panel().props.selection.generation, primeira.props.selection.generation);
    } finally {
      app.dispose();
    }
  });

  test("quick/full mantêm o contrato: arrancam sem confirmação", async () => {
    let consumidos = 0;
    const app = scannerHarness();
    try {
      await app.boot({ pendingScan: { type: "quick" }, onScanConsumed: () => (consumidos += 1) });

      assert.deepEqual(app.starts, [{ type: "quick", path: undefined }]);
      assert.equal(app.panel(), undefined);
      assert.equal(consumidos, 1);
    } finally {
      app.dispose();
    }
  });
});

describe("TP-A2 · portão de confirmação (semântica pura)", () => {
  test("requestDialog abandona a seleção anterior", () => {
    const gate = createFolderConfirmationGate();
    const primeira = gate.requestDialog();
    gate.resolveDialog(primeira, "C:\\A");
    assert.equal(gate.pending()?.path, "C:\\A");

    gate.requestDialog();
    assert.equal(gate.pending(), null);
  });

  test("só se confirma a seleção mostrada; uma mostrada antiga não arranca nada", () => {
    const gate = createFolderConfirmationGate();
    const chamadas: string[] = [];
    const start = (s: { path: string }) => chamadas.push(s.path);
    const primeiro = gate.requestDialog();
    gate.resolveDialog(primeiro, "C:\\A");
    const mostradaA = gate.pending()!;

    const segundo = gate.requestDialog();
    gate.resolveDialog(segundo, "C:\\B");
    const mostradaB = gate.pending()!;

    assert.equal(confirmFolderSelection(gate, mostradaA, start), false);
    assert.deepEqual(chamadas, []);
    assert.equal(confirmFolderSelection(gate, mostradaB, start), true);
    assert.deepEqual(chamadas, ["C:\\B"]);
    // Segunda confirmação da mesma seleção: nada.
    assert.equal(confirmFolderSelection(gate, mostradaB, start), false);
    assert.deepEqual(chamadas, ["C:\\B"]);
  });

  test("respostas antigas são ignoradas e nunca trocam o alvo", () => {
    const gate = createFolderConfirmationGate();
    const primeiro = gate.requestDialog();
    const segundo = gate.requestDialog();
    assert.equal(gate.resolveDialog(segundo, "C:\\Segunda"), "pending");
    assert.equal(gate.resolveDialog(primeiro, "C:\\Primeira"), "ignored");
    assert.equal(gate.pending()?.path, "C:\\Segunda");
  });

  test("cancelar/invalidate invalidam a resposta em voo", () => {
    const gate = createFolderConfirmationGate();
    const chamadas: string[] = [];
    const start = (s: { path: string }) => chamadas.push(s.path);
    const pedido = gate.requestDialog();
    const mostrada = gate.pending();

    gate.cancel();
    assert.equal(gate.resolveDialog(pedido, "C:\\Tarde"), "ignored");
    assert.equal(confirmFolderSelection(gate, mostrada, start), false);

    const outro = gate.requestDialog();
    gate.resolveDialog(outro, "C:\\Viva");
    gate.invalidate();
    assert.equal(gate.pending(), null);
    assert.equal(confirmFolderSelection(gate, gate.pending(), start), false);
    assert.deepEqual(chamadas, []);
  });

  test("Esc/fechar/vazio limpam sem analisar", () => {
    for (const vazio of [null, undefined, "", "   "]) {
      const gate = createFolderConfirmationGate();
      assert.equal(gate.resolveDialog(gate.requestDialog(), vazio), "cleared");
      assert.equal(gate.pending(), null);
    }
    assert.equal(folderConfirmationKeyAction("Escape"), "cancel");
    assert.equal(folderConfirmationKeyAction("Esc"), "cancel");
    assert.equal(folderConfirmationKeyAction("Tab"), null);
    assert.equal(folderConfirmationKeyAction("Enter"), null);
  });
});

describe("TP-A2 · painel de confirmação mostra a pasta exata", () => {
  test("mostra caminho, nome e os dois botões explícitos", () => {
    const html = renderToStaticMarkup(
      createElement(FolderConfirmationPanel, {
        selection: { path: "C:\\Users\\caioc\\Downloads", name: "Downloads", generation: 1 },
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );

    assert.match(html, /Confirmar análise da pasta/);
    assert.match(html, /C:\\Users\\caioc\\Downloads/);
    assert.match(html, /Analisar esta pasta/);
    assert.match(html, /Cancelar/);
    assert.match(html, /Nada é analisado antes de confirmar/i);
    assert.equal((html.match(/<button/g) ?? []).length, 2);
    assert.match(html, /role="group"/);
    assert.match(html, /aria-labelledby="/);
    assert.match(html, /aria-describedby="/);
  });

  test("sem seleção pendente a página não mostra nenhuma confirmação", () => {
    const html = renderToStaticMarkup(
      createElement(AppearanceProvider, null, createElement(FileScannerPage, {})),
    );

    assert.equal(html.includes("Confirmar análise da pasta"), false);
    assert.equal(html.includes("Analisar esta pasta"), false);
  });
});
