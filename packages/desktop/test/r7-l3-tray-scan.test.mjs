/**
 * R7-L3 — PROGRESSO DE ANÁLISE NA TRAY.
 *
 * Regras de produto medidas no pacote L3:
 *  - em curso SEM número real → "Análise em curso — <fase>";
 *  - "0%" e "100%" NUNCA são progresso (0 é o arranque, 100 só
 *    existe no estado terminal);
 *  - terminada → "Última análise: concluída" (com ameaças, se > 0)
 *    ou "Última análise: falhou";
 *  - uma análise cancelada não vira "concluída": quem alimenta o
 *    campo decide não a apresentar;
 *  - nenhenum enum interno do backend (fases em inglês) vaza.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanLine, buildTrayMenuTemplate } from "../src/tray-menu.ts";

const info = (overrides = {}) => ({
  serviceRunning: true,
  status: "safe",
  score: 100,
  threats: 0,
  quarantine: 0,
  ...overrides,
});

const handlers = { open() {}, exit() {} };

describe("R7-L3 — scanLine (copy da linha de análise)", () => {
  it("sem análise confirmada não há linha", () => {
    assert.equal(scanLine(null), null);
    assert.equal(scanLine(undefined), null);
  });

  it("em curso: fase traduzida, sem número inventado", () => {
    assert.equal(scanLine({ status: "running" }), "Análise em curso");
    assert.equal(
      scanLine({ status: "running", phase: "gathering" }),
      "Análise em curso — a reunir ficheiros",
    );
    assert.equal(
      scanLine({ status: "running", phase: "scanning" }),
      "Análise em curso — a analisar ficheiros",
    );
    assert.equal(
      scanLine({ status: "running", phase: "preparing" }),
      "Análise em curso — a preparar",
    );
    assert.equal(
      scanLine({ status: "running", phase: "finalizing" }),
      "Análise em curso — a finalizar",
    );
    // Fase desconhecida: só o facto "em curso", nunca o enum.
    assert.equal(scanLine({ status: "running", phase: "weird" }), "Análise em curso");
  });

  it("em curso: número só quando real e estritamente entre 0 e 100", () => {
    assert.equal(
      scanLine({ status: "running", phase: "scanning", progress: 42 }),
      "Análise em curso — a analisar ficheiros · 42%",
    );
    // 0 é o arranque e 100 só existe no terminal: nenhum dos dois é progresso.
    assert.equal(scanLine({ status: "running", progress: 0 }), "Análise em curso");
    assert.equal(scanLine({ status: "running", progress: 100 }), "Análise em curso");
    assert.equal(scanLine({ status: "running", progress: null }), "Análise em curso");
    assert.equal(scanLine({ status: "running", progress: Number.NaN }), "Análise em curso");
  });

  it("terminada: concluída, com ameaças apenas quando > 0", () => {
    assert.equal(scanLine({ status: "completed" }), "Última análise: concluída");
    assert.equal(
      scanLine({ status: "completed", threatsFound: 0 }),
      "Última análise: concluída",
    );
    assert.equal(
      scanLine({ status: "completed", threatsFound: 1 }),
      "Última análise: concluída — 1 ameaça detetada",
    );
    assert.equal(
      scanLine({ status: "completed", threatsFound: 3 }),
      "Última análise: concluída — 3 ameaças detetadas",
    );
  });

  it("falhada e estados desconhecidos", () => {
    assert.equal(scanLine({ status: "failed" }), "Última análise: falhou");
    // Um status fora do contrato nunca vira "concluída".
    assert.equal(scanLine({ status: "cancelled" }), null);
    assert.equal(scanLine({ status: "weird" }), null);
  });
});

describe("R7-L3 — linha de análise no menu da tray", () => {
  it("sem scan confirmado o menu não tem linha de análise", () => {
    const template = buildTrayMenuTemplate(info(), handlers);
    assert.equal(
      template.some((item) => /Análise em curso|Última análise/.test(item.label ?? "")),
      false,
    );
  });

  it("scan em curso aparece EXACTAMENTE uma vez, com a fase real", () => {
    const template = buildTrayMenuTemplate(
      info({ scan: { status: "running", phase: "gathering" } }),
      handlers,
    );
    const lines = template.filter((item) =>
      /Análise em curso|Última análise/.test(item.label ?? ""),
    );
    assert.equal(lines.length, 1);
    assert.equal(lines[0].label, "Análise em curso — a reunir ficheiros");
  });

  it("scan concluído com ameaças e scan falhado", () => {
    const done = buildTrayMenuTemplate(
      info({ scan: { status: "completed", threatsFound: 2 } }),
      handlers,
    );
    assert.ok(done.some((item) => item.label === "Última análise: concluída — 2 ameaças detetadas"));
    const failed = buildTrayMenuTemplate(info({ scan: { status: "failed" } }), handlers);
    assert.ok(failed.some((item) => item.label === "Última análise: falhou"));
  });

  it("nenhum enum interno (fases em inglês) vaza para o menu", () => {
    for (const scan of [
      { status: "running", phase: "gathering", progress: 42 },
      { status: "running", phase: "scanning" },
      { status: "completed", threatsFound: 1 },
      { status: "failed" },
    ]) {
      const template = buildTrayMenuTemplate(info({ scan }), handlers);
      for (const item of template) {
        assert.equal(
          /\b(gathering|scanning|preparing|finalizing|running|completed|failed)\b/.test(
            item.label ?? "",
          ),
          false,
          `enum interno vazou: ${item.label}`,
        );
      }
    }
  });
});
