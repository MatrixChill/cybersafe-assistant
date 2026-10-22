import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PcStateEngine } from "../dist/pcstate.js";

/**
 * CG1 — PcState tinha de ser explicito quando o tempo real esta DESLIGADO.
 *
 * Antes, com `protectionEnabled: false` o finder era o generico
 * "Protecao em estado critico" (ou nada, se os sub-motores estivessem
 * saudaveis): o utilizador nunca soube que o problema era estar sem
 * protecao em tempo real.
 *
 * As tres regras que isto fixa:
 *  - `protectionEnabled === false` -> finding proprio, URGENT, e o generico
 *    "em estado critico" e suprimido (uma causa, um finding);
 *  - `protectionEnabled` ausente/undefined -> NUNCA se afirma desligado;
 *  - `protectionEnabled: true` -> nada muda em relacao ao comportamento antigo.
 */

const HEALTHY_ENGINE = {
  serviceRunning: true,
  yara: { status: "ok" },
  hashDb: { status: "ok" },
  clamav: { status: "ok" },
  nativeEngine: { status: "ok" },
  wfp: { status: "ok" },
};

function protection(overrides = {}) {
  return {
    status: "critical",
    stats: { threatsBlocked: 0, filesScanned: 0, lastUpdate: new Date().toISOString() },
    engine: { ...HEALTHY_ENGINE },
    ...overrides,
  };
}

function run(protectionInput) {
  return new PcStateEngine().update({
    hardware: null,
    protection: protectionInput,
    windowsHealth: null,
    threats: [],
    now: Date.now(),
  });
}

const titlesOf = (state) => state.findings.map((f) => f.title);

describe("CG1 — PcState diz quando o tempo real esta desligado", () => {
  it("protectionEnabled false -> finding proprio URGENT e sem o generico", () => {
    const state = run(protection({ protectionEnabled: false }));
    const realtime = state.findings.find((f) => f.id === "security:realtime-off");

    assert.ok(realtime, "tem de existir um finding proprio para o tempo real desligado");
    assert.equal(realtime.severity, "urgent");
    assert.equal(realtime.category, "security");
    assert.match(realtime.title, /tempo real/i);

    assert.ok(
      !titlesOf(state).includes("Proteção em estado crítico"),
      "o generico tem de ficar suprimido: uma causa, um finding",
    );
    assert.equal(state.security, "critical", "o tempo real desligado mantem a seguranca critica");
  });

  it("protectionEnabled ausente NUNCA vira 'desligado'", () => {
    const state = run(protection({ protectionEnabled: undefined }));
    assert.ok(
      !state.findings.some((f) => f.id === "security:realtime-off"),
      "sem leitura do campo nao se afirma desligado",
    );
    // O fallback generico continua a existir, como antes.
    assert.ok(titlesOf(state).includes("Proteção em estado crítico"));
  });

  it("protectionEnabled true nao introduz o finding novo", () => {
    const state = run(protection({ protectionEnabled: true }));
    assert.ok(!state.findings.some((f) => f.id === "security:realtime-off"));
    assert.ok(titlesOf(state).includes("Proteção em estado crítico"));
  });

  it("sem dados de motor, o tempo real desligado ainda se afirma", () => {
    const state = run({
      status: "critical",
      stats: {},
      protectionEnabled: false,
      engine: undefined,
    });
    assert.ok(state.findings.some((f) => f.id === "security:realtime-off"));
  });
});

/**
 * GUI-PAP-02 (16/10): com a protecao ATIVA o Painel continuava a mostrar o
 * finding do tempo real desligado — o grace generico (1) obrigava a DOIS
 * updates sem o candidato e, sem novos eventos, nao havia segundo update.
 * Os factos de estado confirmados saem agora no proprio update que os desmente.
 */
describe("GUI-PAP-02 — o finding do tempo real sai no MESMO update ao ativar", () => {
  const input = (protectionInput, now) => ({
    hardware: null,
    protection: protectionInput,
    windowsHealth: null,
    threats: [],
    now,
  });

  it("off -> on remove o finding no mesmo update (sem esperar o grace)", () => {
    const engine = new PcStateEngine();
    const t0 = Date.now();

    const before = engine.update(input(protection({ protectionEnabled: false }), t0));
    assert.ok(before.findings.some((f) => f.id === "security:realtime-off"));

    const after = engine.update(input(protection({ protectionEnabled: true }), t0 + 1));
    assert.ok(
      !after.findings.some((f) => f.id === "security:realtime-off"),
      "o alerta nao pode sobreviver ao update que o desmente",
    );
  });

  it("factos com grace por defeito continuam a esperar (sem regressao)", () => {
    const engine = new PcStateEngine();
    const t0 = Date.now();
    const stopped = { ...HEALTHY_ENGINE, serviceRunning: false };

    const s1 = engine.update(input(protection({ protectionEnabled: true, engine: stopped }), t0));
    assert.ok(s1.findings.some((f) => f.id === "security:service-stopped"));

    const s2 = engine.update(input(protection({ protectionEnabled: true }), t0 + 1));
    assert.ok(
      s2.findings.some((f) => f.id === "security:service-stopped"),
      "grace de 1 mantem o finding por um update",
    );

    const s3 = engine.update(input(protection({ protectionEnabled: true }), t0 + 2));
    assert.ok(
      !s3.findings.some((f) => f.id === "security:service-stopped"),
      "sai ao segundo update ausente",
    );
  });
});