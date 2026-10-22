import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PendingProtection,
  SnapshotCommitter,
  PENDING_DEADLINE_MS,
} from "../src/pending-protection.ts";

/**
 * RE-REVIEW CODEX — os três P1, todos com reprodutor aqui:
 *
 *  P1-A: `protection.changed` confirma ESTADO GLOBAL, nao "o meu pedido". Um
 *        evento ATRASADO de A nao pode libertar o pending de B. A maquina de
 *        pending passou a nao ter ANY path de libertacao por evento; o evento
 *        escreve so pelo SnapshotCommitter.
 *  P1-B: uma leitura velha nao pode sobrescrever um snapshot mais recente
 *        (commit so com geracao inalterada).
 *  P1-C: o helper de pausa ja nao refresca fora do guarda — o pintor e o
 *        settle com identidade (coberto pelo interleaving 2).
 *
 * Relogio falso + refresh de resolucao controlada, modulo real importado,
 * sem Electron.
 */

function makeHarness({ refreshHeld = false } = {}) {
  const timers = new Map();
  let nextTimerId = 1;
  const repaints = [];
  const notifications = [];
  const expiredLog = [];
  const staleLog = [];
  let refreshCalls = 0;
  const refreshResolvers = [];
  let quitting = false;

  const pm = new PendingProtection(
    {
      schedule: (fn, ms) => {
        const id = nextTimerId++;
        timers.set(id, { fn, ms });
        return () => timers.delete(id);
      },
      refreshState: () => {
        refreshCalls += 1;
        if (!refreshHeld) return Promise.resolve();
        return new Promise((resolve) => refreshResolvers.push(resolve));
      },
      repaint: () => repaints.push(pm.current),
      notify: (n) => notifications.push(n),
      isQuitting: () => quitting,
      onDeadlineExpired: (a) => expiredLog.push(a),
      onStaleResolution: (a, token) => staleLog.push({ a, token }),
    },
    25,
  );

  const fireNextDeadline = () => {
    const [id, t] = [...timers.entries()][0];
    timers.delete(id);
    t.fn();
  };
  const releaseRefreshes = () => {
    const all = refreshResolvers.splice(0);
    for (const r of all) r();
  };

  return {
    pm,
    fireNextDeadline,
    releaseRefreshes,
    repaints,
    notifications,
    expiredLog,
    staleLog,
    timerCount: () => timers.size,
    setQuitting: (v) => { quitting = v; },
    refreshCount: () => refreshCalls,
  };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("pending-protection — identidade por voo (P1 Codex r2)", () => {

  it("interleaving 1: deadline A com refresh preso liberta A -> B iniciado -> refresh tardio do RPC de A NÃO apaga B", async () => {
    const h = makeHarness({ refreshHeld: true });

    const tokenA = h.pm.begin("starting");
    // O deadline de A dispara e fica à espera do refresh (preso).
    h.fireNextDeadline();
    // O RPC de A tambem resolveu; o settle fica atras do mesmo refresh preso.
    const settlePromise = h.pm.settle(tokenA, true,
      { title: "Proteção em tempo real ativada", body: "..." },
      { title: "Não foi possível ativar a proteção", body: "..." });

    // Libertar o refresh: o expired de A completa primeiro e liberta A.
    h.releaseRefreshes();
    await tick();
    assert.equal(h.pm.current, null, "A libertou pelo seu proprio deadline");

    // B comeca enquanto o settle de A ainda esta em voo.
    const tokenB = h.pm.begin("stopping");
    await settlePromise;

    assert.equal(h.pm.current, "stopping", "o callback tardio de A nao pode apagar B");
    assert.equal(h.timerCount(), 1, "o deadline de B nao pode ter sido desarmado");
    assert.ok(h.notifications.every((n) => n.title !== "Proteção em tempo real ativada"),
      "A resolvido tarde nao notifica por B");
    assert.equal(tokenB !== tokenA, true);
  });

  it("interleaving 2: timeout A liberta -> B iniciado -> resposta RPC de A nao limpa B nem notifica", async () => {
    const h = makeHarness();

    const tokenA = h.pm.begin("starting");
    h.fireNextDeadline();
    await tick();
    assert.equal(h.pm.current, null);

    const tokenB = h.pm.begin("stopping");

    await h.pm.settle(tokenA, true,
      { title: "Proteção em tempo real ativada", body: "..." },
      { title: "Não foi possível ativar a proteção", body: "..." });

    assert.equal(h.pm.current, "stopping", "resposta atrasada de A não pode limpar B");
    assert.deepEqual(h.notifications, [], "resposta atrasada de A não pode notificar");
    assert.equal(h.staleLog.length, 1, "a resolução stale é registada para diagnóstico");

    await h.pm.settle(tokenB, true,
      { title: "Proteção em tempo real desativada", body: "..." },
      { title: "Não foi possível desativar a proteção", body: "..." });
    assert.equal(h.pm.current, null);
    assert.equal(h.notifications[0].title, "Proteção em tempo real desativada");
  });

  it("interleaving 3 (P1-A): timeout A -> B iniciado -> protection.changed ATRASADO de A nao toca em B", async () => {
    const h = makeHarness();
    const snapshot = new SnapshotCommitter();

    const tokenA = h.pm.begin("starting");
    h.fireNextDeadline();
    await tick();
    assert.equal(h.pm.current, null, "A expirou pelo seu deadline");

    const tokenB = h.pm.begin("stopping");

    // O caminho do evento em main.ts e' exatamente isto: pinta o snapshot e
    // redesenha. NAO existe chamada maquina que liberte pending por evento —
    // ate o metodo foi REMOVIDO (prova estatica abaixo).
    snapshot.paint({ ...snapshot.value, protectionEnabled: true });
    assert.ok(!("settleFromEvent" in Object.getPrototypeOf(h.pm)),
      "a maquina nao pode expor libertacao por evento (P1-A: o metodo desapareceu)");

    assert.equal(h.pm.current, "stopping", "evento atrasado de A nao apaga B");
    assert.equal(h.timerCount(), 1, "deadline de B continua armado");
    assert.deepEqual(h.notifications, []);

    // B completa o seu ciclo normal.
    await h.pm.settle(tokenB, true,
      { title: "Proteção em tempo real desativada", body: "..." },
      { title: "Não foi possível desativar a proteção", body: "..." });
    assert.equal(h.pm.current, null);
  });

  it("quit: depois de isQuitting, nenhuma resolução pinta ou notifica", async () => {
    const h = makeHarness();
    const token = h.pm.begin("starting");
    h.setQuitting(true);
    await h.pm.settle(token, true,
      { title: "Proteção em tempo real ativada", body: "..." },
      { title: "Não foi possível ativar a proteção", body: "..." });
    assert.deepEqual(h.notifications, [], "no encerramento nada é notificado");
    assert.equal(h.pm.current, "starting", "sem quit a tempo, o pending fica — mas abandon() fecha-o");

    h.pm.abandon();
    assert.equal(h.pm.current, null);
    assert.equal(h.timerCount(), 0, "o deadline do voo abandonado foi cancelado");

    await h.pm.settle(token, true, { title: "x", body: "y" }, { title: "x", body: "y" });
    assert.deepEqual(h.notifications, []);
  });

  it("fluxo normal: begin marca pending + deadline; settle(ok) liberta e notifica; settle(falha) diz a verdade", async () => {
    const h = makeHarness();
    assert.equal(PENDING_DEADLINE_MS, 20_000, "o prazo default é o aprovado (20 s)");

    const token = h.pm.begin("starting");
    assert.equal(h.pm.current, "starting");
    assert.equal(h.timerCount(), 1);
    assert.equal(h.repaints.at(-1), "starting", "o pintor vê o pending ao clicar");

    await h.pm.settle(token, false,
      { title: "sucesso", body: "..." },
      { title: "falhou", body: "o serviço não confirmou" });
    assert.equal(h.pm.current, null);
    assert.equal(h.timerCount(), 0, "o deadline liberta-se com o settle");
    assert.equal(h.notifications[0].title, "falhou", "sem confirmacao do motor o texto e de falha");
  });
});

describe("SnapshotCommitter — leitura velha não sobrescreve escrita nova (P1-B)", () => {
  it("commit com geração inalterada pinta; leitura mais nova vence a anterior", () => {
    const s = new SnapshotCommitter();
    const g1 = s.begin();
    const g2 = s.begin(); // segunda leitura abriu depois
    assert.equal(s.commit(g1, { protectionEnabled: false }), false,
      "a leitura velha nao pode commitar depois de uma nova");
    assert.equal(s.commit(g2, { protectionEnabled: true }), true);
    assert.deepEqual(s.value, { protectionEnabled: true });
  });

  it("paint de evento invalida leituras em curso; commit posterior da leitura é descartado", () => {
    const s = new SnapshotCommitter();
    const g1 = s.begin(); // leitura do poll em voo
    s.paint({ protectionEnabled: true }); // evento do motor chegou primeiro
    assert.equal(s.commit(g1, { protectionEnabled: null }), false,
      "snapshot velho nao sobrescreve o evento mais recente");
    assert.deepEqual(s.value, { protectionEnabled: true });
  });

  it("sem escrita, value é null e o default do shell é o que se mostra", () => {
    const s = new SnapshotCommitter();
    assert.equal(s.value, null);
  });
});
