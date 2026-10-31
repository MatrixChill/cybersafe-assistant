import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProcessSnapshotFailure,
  processEnumerationDiagnosticsSnapshot,
  snapshotProcesses,
} from "../dist/index.js";

/**
 * TP-PAP-F1-RUNTIME-20261026 — F1b.
 *
 * Uma enumeração falhada tem de dizer ONDE falhou (spawn, execução, parse,
 * vazio) em vez de colapsar tudo em «CIM falhou». O enriquecimento
 * (systeminformation) é opcional: falhar perde cpu/mem, não a verdade da
 * lista, e por isso é contado à parte. `startedAt` vem SEMPRE da fonte
 * (CreationDate); sem ela fica `""`, nunca a hora do poll.
 */

const linha = (overrides = {}) => ({
  ProcessId: 4242,
  Name: "exemplo.exe",
  CommandLine: "exemplo.exe --x",
  CreatedIso: "2026-10-26T10:00:00.0000000Z",
  ...overrides,
});

test("spawn ENOENT: estágio spawn, mensagem CIM de execução", async () => {
  const erro = Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" });
  await assert.rejects(
    snapshotProcesses({ runPrimary: async () => { throw erro; } }),
    (error) => {
      assert.ok(error instanceof ProcessSnapshotFailure);
      assert.equal(error.stage, "spawn");
      assert.match(error.message, /CIM execução/i);
      return true;
    },
  );
});

test("timeout/killed: estágio execution com causa de tempo esgotado", async () => {
  const erro = Object.assign(new Error("Command failed: powershell"), { killed: true, signal: "SIGTERM" });
  await assert.rejects(
    snapshotProcesses({ runPrimary: async () => { throw erro; } }),
    (error) => {
      assert.equal(error.stage, "execution");
      assert.match(error.message, /tempo esgotado/i);
      return true;
    },
  );
});

test("falha de execução genérica preserva o estágio e não colapsa em parse", async () => {
  const erro = Object.assign(new Error("exit 1"), { code: 1 });
  await assert.rejects(
    snapshotProcesses({ runPrimary: async () => { throw erro; } }),
    (error) => {
      assert.equal(error.stage, "execution");
      assert.match(error.message, /código 1/i);
      return true;
    },
  );
});

test("JSON inválido: estágio parse (o classificador público vê parse, não cim)", async () => {
  await assert.rejects(
    snapshotProcesses({ runPrimary: async () => "isto não é json" }),
    (error) => {
      assert.equal(error.stage, "parse");
      assert.match(error.message, /JSON parse/i);
      return true;
    },
  );
});

test("zero registos: estágio empty, não uma lista vazia afirmada", async () => {
  await assert.rejects(
    snapshotProcesses({ runPrimary: async () => "[]" }),
    (error) => {
      assert.equal(error.stage, "empty");
      assert.match(error.message, /CIM vazio/i);
      return true;
    },
  );
});

test("startedAt vem da fonte; sem CreationDate fica vazio (nunca now)", async () => {
  const comFonte = await snapshotProcesses({
    runPrimary: async () => JSON.stringify([linha()]),
    enrich: async () => {},
  });
  assert.equal(comFonte.get(4242).startedAt, "2026-10-26T10:00:00.0000000Z");

  const semFonte = await snapshotProcesses({
    runPrimary: async () => JSON.stringify([linha({ CreatedIso: undefined })]),
    enrich: async () => {},
  });
  assert.equal(semFonte.get(4242).startedAt, "");
});

test("enriquecimento falha sem apagar a lista e é contado à parte", async () => {
  const antes = processEnumerationDiagnosticsSnapshot();
  const mapa = await snapshotProcesses({
    runPrimary: async () => JSON.stringify([linha()]),
    enrich: async () => { throw new Error("systeminformation indisponível"); },
  });
  assert.equal(mapa.size, 1, "a lista do CIM sobrevive à falha de enriquecimento");
  assert.equal(mapa.get(4242).cpu, 0);
  const depois = processEnumerationDiagnosticsSnapshot();
  assert.equal(depois.enrichment, antes.enrichment + 1);
  assert.ok(depois.lastEnrichmentFailureAt >= antes.lastEnrichmentFailureAt || antes.lastEnrichmentFailureAt === null);
});
