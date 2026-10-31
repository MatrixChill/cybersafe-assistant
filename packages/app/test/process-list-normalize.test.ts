/**
 * P1-PROCESS-TRUTH (fronteira da renderer) — o que chega do serviço é
 * normalizado antes de alimentar estado de frescura.
 *
 * A normalização vive no consumidor (`App.acceptProcesses` / painéis que lêem a
 * lista) e não no `registerIpc`, por duas razões medidas nesta lane:
 *  · o corpo de `registerIpc` é extraído e corrido em `vm` por testes de
 *    segurança que não conhecem nomes de módulos — um nome novo ali dentro
 *    rebenta a baseline (e foi `dev-windows-readonly-boundary` que o mostrou);
 *  · quem tem de decidir «posso afirmar frescura?» é precisamente quem a mostra.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeProcessListResult } from "@cybersafe/shared-types";

const APP = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const linha = { pid: 1234, name: "a.exe" };

describe("normalizeProcessListResult", () => {
  it("contrato novo passa tal e qual", () => {
    const verdade = {
      state: "ok",
      enumeratedAt: 111,
      servedFrom: "snapshot",
      attempt: null,
      asOf: 112,
    } as const;
    const saida = normalizeProcessListResult({ processes: [linha], truth: verdade });
    assert.deepEqual(saida.processes, [linha]);
    assert.equal(saida.truth.state, "ok");
    assert.equal(saida.truth.enumeratedAt, 111);
  });

  it("array nu de um serviço antigo: as linhas existem, a frescura não é afirmada", () => {
    const saida = normalizeProcessListResult([linha, { pid: 2, name: "b.exe" }] as never);
    assert.equal(saida.processes.length, 2);
    assert.equal(saida.truth.state, "unreported");
    assert.equal(saida.truth.enumeratedAt, null);
    assert.equal(saida.truth.attempt, null);
  });

  it("resposta oca não se transforma em «zero processos» silenciosos", () => {
    for (const valor of [null, undefined, {}, { processes: null }]) {
      const saida = normalizeProcessListResult(valor as never);
      assert.deepEqual(saida.processes, []);
      assert.equal(saida.truth.state, "unreported", "sem contrato não se afirma leitura válida");
    }
  });

  it("o instante de referência é o da resposta, não um Date.now() escondido", () => {
    assert.equal(normalizeProcessListResult([], 555).truth.asOf, 555);
    assert.equal(normalizeProcessListResult([linha], 999).truth.asOf, 999);
  });

  it("truth malformado NÃO é aceite como frescura: linhas ficam, idade não", () => {
    const casos = [
      { state: "aconteceu-tudo-bem", enumeratedAt: 5, servedFrom: "snapshot", attempt: null, asOf: 6 },
      { state: "ok", enumeratedAt: "5", servedFrom: "snapshot", attempt: null, asOf: 6 },
      { state: "ok", enumeratedAt: 5, servedFrom: "ar", attempt: null, asOf: 6 },
      { state: "ok", enumeratedAt: 5, servedFrom: "cache", attempt: null },
      { state: "ok", enumeratedAt: 5, servedFrom: "cache", attempt: { startedAt: 1, ok: true }, asOf: 6 },
    ] as const;
    for (const truth of casos) {
      const saida = normalizeProcessListResult({ processes: [linha], truth } as never);
      assert.equal(saida.processes.length, 1, "as linhas não se deitam fora por um shape inválido");
      assert.equal(saida.truth.state, "unreported", `shape inválido aceito: ${JSON.stringify(truth)}`);
      assert.equal(saida.truth.enumeratedAt, null);
    }
  });

  it("controle de mutação: o shape válido passa (senão o guarda acima era sempre-verdadeiro)", () => {
    const bom = { state: "ok", enumeratedAt: 5, servedFrom: "snapshot", attempt: null, asOf: 6 } as const;
    assert.equal(normalizeProcessListResult({ processes: [linha], truth: bom }).truth.state, "ok");
  });
});

describe("conteúdo do erro antes de chegar à UI", () => {
  it("mensagem longa é cortada e os espaços colapsados", async () => {
    const { classifyProcessEnumerationError, PROCESS_ENUMERATION_ERROR_MESSAGE_MAX } =
      await import("@cybersafe/shared-types");
    const sujo = new Error(`C:\\Users\\alguem\\x.exe falhou\n${" ".repeat(40)}  ${"detalhe ".repeat(400)}`);
    const { message, code } = classifyProcessEnumerationError(sujo);
    assert.ok(message.length <= PROCESS_ENUMERATION_ERROR_MESSAGE_MAX, `mensagem com ${message.length} caracteres`);
    assert.doesNotMatch(message, /[\n\r\t]/, "sem quebras de linha vindas do stderr");
    assert.equal(code, "unknown");
  });

  it("a causa CIM continua reconhecível depois do corte", async () => {
    const { classifyProcessEnumerationError } = await import("@cybersafe/shared-types");
    const r = classifyProcessEnumerationError(
      new Error("Enumeração de processos indisponível (CIM falhou)\n" + "x".repeat(500)),
    );
    assert.equal(r.code, "cim");
    assert.match(r.message, /CIM falhou/);
  });
});

describe("a renderer usa o normalizador", () => {
  it("o App normaliza antes de afirmar frescura", () => {
    assert.match(APP, /normalizeProcessListResult\(next\)/, "acceptProcesses normaliza a resposta");
    assert.match(APP, /const observedAt = instanteDeLeituraValida\(truth\)/, "e a idade vem da verdade normalizada");
  });
});
