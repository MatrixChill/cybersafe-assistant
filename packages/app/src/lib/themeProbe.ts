/**
 * INSTRUMENTACAO DE MEDIÇÃO — DEV ONLY, TEMPORARIA.
 *
 * Mede o custo real da troca de tema (dark/light) por partes: handler, re-render
 * do React, aplicaao da classe no document, pintura e frames.
 *
 * COMO REMOVER (3 passos, nada mais):
 *   1. apagar este ficheiro (packages/app/src/lib/themeProbe.ts)
 *   2. em packages/app/src/main.tsx, remover o import deste modulo, o <Profiler>
 *      que envolve <App /> e a chamada a installThemeProbe()
 *   3. correr npm run build -w @cybersafe/app e confirmar que o bundle nao contem
 *      a string csThemeProbe
 * Em producao nada corre: installThemeProbe() e onRootRender() estao atras de
 * import.meta.env.DEV, e o Profiler so e montado no mesmo guard.
 */

export interface FlipRecord {
  flip: number;
  de: string;
  para: string;
  t0: number;
  t1: number;
  t3: number;
  t5: number;
  t6: number;
  clickParaState: number | null;
  stateParaDom: number | null;
  domParaFrame1: number | null;
  frame1ParaFrame2: number | null;
  total: number | null;
  commits: { phase: string; actual: number; base: number }[];
  domMutacoes: number;
  animacoesAntes: number;
  animacoesEmT3: number;
  animacoesMais100ms: number;
  animacoesMais500ms: number;
  longtasks: { start: number; duration: number }[];
}

interface Probe {
  flips: FlipRecord[];
  pending: FlipRecord | null;
  observer: MutationObserver | null;
  rootObserver: MutationObserver | null;
  longtasks: { start: number; duration: number }[];
}

declare global {
  interface Window {
    __csThemeProbe?: Probe;
  }
}

function probe(): Probe {
  if (!window.__csThemeProbe) {
    window.__csThemeProbe = { flips: [], pending: null, observer: null, rootObserver: null, longtasks: [] };
  }
  return window.__csThemeProbe;
}

/** Callback do <Profiler> em main.tsx. Regista commits do flip em curso. */
export function onRootRender(
  _id: string,
  phase: "mount" | "update" | "nested-update",
  actualDuration: number,
  baseDuration: number,
): void {
  const p = probe();
  if (p.pending) p.pending.commits.push({ phase, actual: actualDuration, base: baseDuration });
}

export function installThemeProbe(): void {
  const p = probe();
  if (p.observer) return;

  if (typeof PerformanceObserver !== "undefined") {
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          p.longtasks.push({ start: Math.round(e.startTime), duration: Math.round(e.duration) });
        }
      });
      po.observe({ entryTypes: ["longtask"] });
    } catch {
      /* longtask nao suportado neste runtime — fica 0 e e reportado como tal */
    }
  }

  // T0/T1: captura no document; corre ANTES do onClick do React.
  document.addEventListener(
    "click",
    (ev) => {
      const target = ev.target as HTMLElement | null;
      const btn = target?.closest?.('button[aria-label^="Ativar modo"]');
      if (!btn) return;
      const now = performance.now();
      const de = document.documentElement.className;
      const pending: FlipRecord = {
        flip: p.flips.length + 1,
        de,
        para: de === "dark" ? "light" : "dark",
        t0: now,
        t1: now,
        t3: 0,
        t5: 0,
        t6: 0,
        clickParaState: null,
        stateParaDom: null,
        domParaFrame1: null,
        frame1ParaFrame2: null,
        total: null,
        commits: [],
        domMutacoes: 0,
        animacoesAntes: document.getAnimations().length,
        animacoesEmT3: 0,
        animacoesMais100ms: 0,
        animacoesMais500ms: 0,
        longtasks: [],
      };
      p.pending = pending;
      performance.mark("cs-theme-click");

      const root = document.getElementById("root") ?? document.body;
      p.rootObserver?.disconnect();
      p.rootObserver = new MutationObserver((rec) => {
        if (p.pending) p.pending.domMutacoes += rec.length;
      });
      p.rootObserver.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    },
    true,
  );

  // T3: a classe do <html> mudou.
  p.observer = new MutationObserver(() => {
    const pending = p.pending;
    if (!pending || pending.t3) return;
    pending.t3 = performance.now();
    pending.stateParaDom = pending.t3 - pending.t1;
    pending.animacoesEmT3 = document.getAnimations().length;
    performance.mark("cs-theme-dom");

    requestAnimationFrame(() => {
      const f1 = p.pending;
      if (!f1) return;
      f1.t5 = performance.now();
      f1.domParaFrame1 = f1.t5 - f1.t3;
      requestAnimationFrame(() => {
        const f = p.pending;
        if (!f) return;
        f.t6 = performance.now();
        f.frame1ParaFrame2 = f.t6 - f.t5;
        f.total = f.t6 - f.t0;
        f.longtasks = p.longtasks.filter((l) => l.start >= f.t0 - 5 && l.start <= f.t6 + 50);
        p.rootObserver?.disconnect();
        setTimeout(() => {
          if (!p.pending) return;
          p.pending.animacoesMais100ms = document.getAnimations().length;
          setTimeout(() => {
            if (!p.pending) return;
            p.pending.animacoesMais500ms = document.getAnimations().length;
            p.flips.push(p.pending);
            p.pending = null;
          }, 400);
        }, 100);
      });
    });
  });
  p.observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}

export function themeProbeSummary() {
  const p = probe();
  const r = (v: number | null) => (v === null ? null : Math.round(v));
  return {
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    flips: p.flips.map((f) => ({
      flip: f.flip,
      de: f.de,
      para: f.para,
      stateParaDom_ms: r(f.stateParaDom),
      domParaFrame1_ms: r(f.domParaFrame1),
      frame1ParaFrame2_ms: r(f.frame1ParaFrame2),
      total_ms: r(f.total),
      commits: f.commits,
      somaActualDuration_ms: r(f.commits.reduce((s, c) => s + c.actual, 0)),
      maxBaseDuration_ms: r(Math.max(0, ...f.commits.map((c) => c.base))),
      domMutacoes: f.domMutacoes,
      animacoes: [f.animacoesAntes, f.animacoesEmT3, f.animacoesMais100ms, f.animacoesMais500ms],
      longtasks: f.longtasks,
    })),
    longtasksTotais: p.longtasks.length,
  };
}
