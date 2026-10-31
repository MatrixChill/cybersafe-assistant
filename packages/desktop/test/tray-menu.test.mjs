import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTrayMenuTemplate,
  protectionLine,
  protectionStatusLabel,
  quarantineLine,
  serviceStatusLine,
  threatsLine,
  handleQuickScanRequest,
  trayPendingLine,
  trayProtectionLevel,
} from "../src/tray-menu.ts";

/**
 * Regressão de UX da tray.
 *
 * Bug manual: o menu mostrava "Proteção: 55/100 (degraded)" — um enum interno
 * do backend vazava para o utilizador. A copy (e a tradução) vive agora em
 * tray-menu.ts, testável sem Electron.
 */

const STATUSES = ["safe", "attention", "warning", "degraded", "critical", "paused", "unavailable"];
// Enums internos em inglês. \b evita falsos positivos como "CyberSafe".
const ENUM_PATTERN = new RegExp(`\\b(safe|attention|warning|degraded|critical|paused|unavailable)\\b`, "i");

const info = (overrides = {}) => ({
  serviceRunning: true,
  status: "safe",
  score: 100,
  threats: 0,
  quarantine: 0,
  ...overrides,
});

const handlers = { open() {}, exit() {} };

describe("tray — tradução dos estados", () => {
  it("cada estado interno tem rótulo em português", () => {
    assert.equal(protectionStatusLabel("safe"), "Protegida");
    assert.equal(protectionStatusLabel("degraded"), "Precisa de atenção");
    assert.equal(protectionStatusLabel("attention"), "Atenção");
    assert.equal(protectionStatusLabel("warning"), "Atenção");
    assert.equal(protectionStatusLabel("critical"), "Crítica");
    assert.equal(protectionStatusLabel("paused"), "Pausada");
    assert.equal(protectionStatusLabel("unavailable"), "Indisponível");
  });

  it("estado desconhecido ou ausente nunca vaza o enum", () => {
    for (const value of [null, undefined, "", "weird-state", "  "]) {
      assert.equal(protectionStatusLabel(value), "Indisponível");
    }
  });

  it("aceita variações de caixa/espaços vindas do backend", () => {
    assert.equal(protectionStatusLabel("  DEGRADED "), "Precisa de atenção");
  });

  it("linha de proteção tem o formato pedido", () => {
    assert.equal(protectionLine(info({ status: "degraded", score: 55 })), "Proteção: Precisa de atenção · 55/100");
  });

  it("sem pontuação real a linha não inventa um número", () => {
    assert.equal(protectionLine(info({ status: "degraded", score: null })), "Proteção: Precisa de atenção");
  });
});

describe("tray — linhas de estado", () => {
  it("serviço ativo/parado", () => {
    assert.equal(serviceStatusLine(true), "● Serviço ativo");
    assert.equal(serviceStatusLine(false), "○ Serviço parado");
  });

  it("contadores só aparecem com valor real", () => {
    assert.equal(threatsLine(0), "Ameaças recentes: 0");
    assert.equal(quarantineLine(6), "Em quarentena: 6");
    assert.equal(threatsLine(null), null);
    assert.equal(quarantineLine(undefined), null);
  });
});

describe("tray — Quick Scan result", () => {
  it("não anuncia sucesso quando scan.start devolve rejection de negócio", async () => {
    const notices = [];
    const started = await handleQuickScanRequest(
      async () => ({ id: "", success: false, error: "Já existe uma análise em curso." }),
      () => notices.push("started"),
      (message) => notices.push(message),
    );

    assert.equal(started, false);
    assert.deepEqual(notices, ["Já existe uma análise em curso."]);
  });

  it("anuncia início apenas com success=true e scan id", async () => {
    const notices = [];
    const started = await handleQuickScanRequest(
      async () => ({ id: "scan-1", success: true }),
      () => notices.push("started"),
      (message) => notices.push(message),
    );

    assert.equal(started, true);
    assert.deepEqual(notices, ["started"]);
  });
});

describe("tray — menu final", () => {
  it("degraded nunca aparece literalmente no menu", () => {
    const template = buildTrayMenuTemplate(
      info({ status: "degraded", score: 55, threats: 0, quarantine: 6 }),
      handlers,
    );
    const dump = JSON.stringify(template);
    assert.doesNotMatch(dump, ENUM_PATTERN, `menu não pode expor enums internos: ${dump}`);
    assert.match(dump, /Proteção: Precisa de atenção · 55\/100/);
  });

  it("nenhum estado interno vaza para o menu", () => {
    for (const status of STATUSES) {
      const dump = JSON.stringify(buildTrayMenuTemplate(info({ status }), handlers));
      assert.doesNotMatch(dump, ENUM_PATTERN, `estado ${status} vazou para o menu`);
    }
  });

  it("estrutura do menu é a pedida (estado → ações)", () => {
    // Mudança de contrato (2026-10-05, tray 3 estados): o cabeçalho deixou de
    // dizer "CyberSafe" + estado do SERVIÇO e passou a dizer o produto + o
    // ESTADO DA PROTEÇÃO. Motivo: "● Serviço ativo" não diz se o computador
    // está protegido — o serviço pode estar de pé com a proteção desligada,
    // e era exactamente esse o engano que esta evolução veio fechar.
    const template = buildTrayMenuTemplate(
      info({ status: "degraded", score: 55, threats: 0, quarantine: 6 }),
      handlers,
    );
    assert.deepEqual(
      template.map((item) => item.label ?? (item.type === "separator" ? "---" : "")),
      [
        "CyberSafe Assistant",
        // "degraded" sem protectionConfirmed = atenção: não afirmamos proteção
        // sem o motor a dizer que a proteção está ligada.
        "Precisa de atenção",
        "Proteção: Precisa de atenção · 55/100",
        "Ameaças recentes: 0",
        "Em quarentena: 6",
        "---",
        "Abrir CyberSafe",
        // "Sair" ficou no seu próprio grupo, como no Windows Security. Com o
        // menu anterior (2 ações) não havia porquê; com o menu de segurança
        // completo, "Sair" colado a "Abrir" mistura o que se usa e o que fecha.
        "---",
        "Sair do CyberSafe...",
      ],
    );
    // As duas únicas ações clicáveis ligam-se aos handlers reais.
    const clickable = template.filter((item) => typeof item.click === "function");
    assert.equal(clickable.length, 2);
  });

  it("sem dados reais omite as linhas de contadores (não mostra lixo)", () => {
    const template = buildTrayMenuTemplate(
      info({ serviceRunning: false, status: null, score: null, threats: null, quarantine: null }),
      handlers,
    );
    const labels = template.map((item) => item.label).filter(Boolean);
    // Serviço parado = não protegido: é um facto, não falta de informação.
    assert.deepEqual(labels, [
      "CyberSafe Assistant",
      "Não protegido",
      "Proteção: Indisponível",
      "Abrir CyberSafe",
      "Sair do CyberSafe...",
    ]);
  });

  it("o botão de saída chama o handler (que pede a confirmação)", () => {
    let exits = 0;
    const template = buildTrayMenuTemplate(info(), { open() {}, exit: () => { exits += 1; } });
    const exitItem = template.find((item) => item.label === "Sair do CyberSafe...");
    exitItem.click();
    assert.equal(exits, 1);
  });
});

/**
 * Feedback imediato do clique na tray.
 *
 * Bug medido: entre o clique em "Ativar proteção" e a confirmação do motor
 * passavam segundos em que a tray não mudava — o item continuava a dizer
 * "Ativar proteção", e o clique parecia não fazer nada. O pedido pendente é
 * agora visível de imediato, SEM tocar no estado confirmado pelo motor.
 */
describe("tray — pedido pendente (feedback imediato, sem otimismo)", () => {
  it("a copy do pedido em curso existe para as três ações e nunca afirma o resultado", () => {
    assert.equal(trayPendingLine("starting"), "A ativar proteção…");
    assert.equal(trayPendingLine("stopping"), "A desativar proteção…");
    assert.equal(trayPendingLine("pausing"), "A pausar proteção…");
    assert.equal(trayPendingLine(null), null);
    assert.equal(trayPendingLine(undefined), null);
    for (const line of [trayPendingLine("starting"), trayPendingLine("stopping"), trayPendingLine("pausing")]) {
      assert.ok(!/ativad[ao]/i.test(line) || /^A /.test(line), `copy não pode afirmar sucesso: ${line}`);
      assert.ok(line.endsWith("…"), "estado em curso termina em reticências");
    }
  });

  it("um pedido pendente NÃO muda o nível confirmado", () => {
    // Proteção confirmada ligada + pedido de paragem em curso: o nível continua
    // a ser o facto do motor, não o desejo do utilizador.
    assert.equal(
      trayProtectionLevel(info({ status: "safe", protectionEnabled: true, pendingAction: "stopping" })),
      "protected",
    );
    // Proteção confirmada desligada + pedido de arranque em curso: ainda não
    // está protegida — o motor não confirmou nada.
    assert.equal(
      trayProtectionLevel(info({ status: "safe", protectionEnabled: false, pendingAction: "starting" })),
      "unprotected",
    );
  });

  it("o menu mostra a linha do pedido em curso e desativa a ação", () => {
    const starting = buildTrayMenuTemplate(
      info({ protectionEnabled: false, pendingAction: "starting" }),
      { ...handlers, startProtection() {}, stopProtection() {}, pauseProtection() {} },
    );
    const labels = starting.map((i) => i.label).filter(Boolean);
    assert.ok(labels.includes("A ativar proteção…"), `linha pendente ausente: ${labels.join(" | ")}`);
    const start = starting.find((i) => i.label === "Ativar proteção");
    assert.ok(start, "a ação de ativar continua visível (não desaparece)");
    assert.equal(start.enabled, false, "a ação fica desativada enquanto o pedido está em voo");
  });

  it("com um pedido pendente há UMA só ativação, e fica desativada (nunca duas)", () => {
    const template = buildTrayMenuTemplate(
      info({ status: "critical", protectionEnabled: false, pendingAction: "starting" }),
      { ...handlers, startProtection() {} },
    );
    const activations = template.filter(
      (i) => i.label === "Ativar proteção" || i.label === "Ativar proteção agora",
    );
    assert.equal(
      activations.length,
      1,
      `uma só ativação esperada: ${JSON.stringify(template.map((i) => i.label))}`,
    );
    assert.equal(activations[0].label, "Ativar proteção", "a ação de topo duplicada desapareceu");
    assert.equal(activations[0].enabled, false, "desativada enquanto o pedido está em voo");
  });

  it("com pedido de pausa, as ações de pausa e paragem ficam desativadas", () => {
    const template = buildTrayMenuTemplate(
      info({ status: "safe", protectionEnabled: true, pendingAction: "pausing" }),
      { ...handlers, pauseProtection() {}, stopProtection() {} },
    );
    assert.ok(template.some((i) => i.label === "A pausar proteção…"));
    for (const label of ["Pausar 15 minutos", "Pausar 1 hora", "Desligar até ativação manual"]) {
      const item = template.find((i) => i.label === label);
      assert.ok(item, `item ausente: ${label}`);
      assert.equal(item.enabled, false, `${label} devia estar desativado`);
    }
  });

  it("sem pedido pendente as ações continuam ativas (regressão)", () => {
    const template = buildTrayMenuTemplate(
      info({ status: "safe", protectionEnabled: true }),
      { ...handlers, startProtection() {}, stopProtection() {}, pauseProtection() {} },
    );
    for (const label of ["Pausar 15 minutos", "Pausar 1 hora", "Desligar até ativação manual"]) {
      const item = template.find((i) => i.label === label);
      assert.ok(item);
      assert.notEqual(item.enabled, false, `${label} não pode nascer desativado sem pedido em curso`);
      assert.equal(typeof item.click, "function");
    }
  });
});
