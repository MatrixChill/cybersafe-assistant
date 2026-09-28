import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTrayMenuTemplate,
  protectionLine,
  protectionStatusLabel,
  quarantineLine,
  serviceStatusLine,
  threatsLine,
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
    const template = buildTrayMenuTemplate(
      info({ status: "degraded", score: 55, threats: 0, quarantine: 6 }),
      handlers,
    );
    assert.deepEqual(
      template.map((item) => item.label ?? (item.type === "separator" ? "---" : "")),
      [
        "CyberSafe",
        "● Serviço ativo",
        "Proteção: Precisa de atenção · 55/100",
        "Ameaças recentes: 0",
        "Em quarentena: 6",
        "---",
        "Abrir CyberSafe",
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
    assert.deepEqual(labels, [
      "CyberSafe",
      "○ Serviço parado",
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
