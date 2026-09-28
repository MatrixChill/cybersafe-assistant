import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { snapshotProcesses } from "../dist/index.js";

/**
 * FRONTEIRA DE VERDADE da enumeração de processos (P0).
 *
 * `snapshotProcesses()` tem duas fases:
 *   (a) PRIMÁRIA — CIM/PowerShell: é a ÚNICA fonte da lista;
 *   (b) ENRIQUECIMENTO — systeminformation: acrescenta cpu/mem/path/user.
 *
 * Bug P0 (código defeituoso, anteriores a este patch): um `catch` genérico
 * envolvia as duas fases e devolvia o `map` — vazio quando (a) falhava. O
 * `list()` do service nunca rejeitava, logo o `catch` de `listProcesses()`
 * (`engine.ts`) nunca servia o cache: a UI recebia `processes: []` e
 * apresentava-a como "Nenhum processo encontrado".
 *
 * Estes testes atravessam o código real (mesmo `snapshotProcesses` exportado),
 * injetando apenas as duas fontes — sem mocks de módulo.
 */

/** CIM sintético: o formato real é JSON do Get-CimInstance (array ou objeto). */
const CIM_ROWS = JSON.stringify([
  { ProcessId: 4, Name: "System", CommandLine: "" },
  { ProcessId: 1234, Name: "notepad.exe", CommandLine: "notepad.exe notas.txt" },
  { ProcessId: 4321, Name: "chrome.exe", CommandLine: '"chrome.exe" --type=renderer' },
]);

describe("snapshotProcesses — fronteira de verdade da enumeração", () => {
  it("(a) enumeração primária que LANÇA rejeita — nunca resolve com lista vazia", async () => {
    // Este é o teste que FALHAVA antes do patch: o catch devolvia map vazio.
    await assert.rejects(
      () =>
        snapshotProcesses({
          runPrimary: async () => {
            throw new Error("Get-CimInstance falhou: acesso negado");
          },
          enrich: async () => {
            throw new Error("o enriquecimento nem deve ser alcançado");
          },
        }),
      /Enumeração de processos indisponível|CIM/i,
      "a primária falhou ⇒ a função tem de rejeitar, não devolver []",
    );
  });

  it("(a) payload primário corrompido (JSON inválido) também rejeita", async () => {
    // Saída vazia do ConvertTo-Json ⇒ JSON.parse("") lança. Não é lista vazia: é ausência de verdade.
    await assert.rejects(
      () => snapshotProcesses({ runPrimary: async () => "" }),
      /indisponível|CIM|zero registos/i,
    );
    await assert.rejects(
      () => snapshotProcesses({ runPrimary: async () => "{not-json" }),
      /indisponível|CIM|zero registos/i,
    );
  });

  it("(a) primária que devolve zero processos utilizáveis rejeita (nunca 'o SO está vazio')", async () => {
    for (const stdout of ["null", "[]", JSON.stringify([{ ProcessId: 0, Name: "x" }])]) {
      await assert.rejects(
        () => snapshotProcesses({ runPrimary: async () => stdout }),
        /zero registos|indisponível|CIM/i,
        `stdout=${stdout} não pode virar lista vazia silenciosa`,
      );
    }
  });

  it("(b) só o ENRIQUECIMENTO a falhar resolve com a lista populada e não rejeita", async () => {
    const map = await snapshotProcesses({
      runPrimary: async () => CIM_ROWS,
      enrich: async () => {
        throw new Error("si.processes() indisponível");
      },
    });

    assert.equal(map.size, 3, "a lista primária é verdadeira e tem de ser preservada");
    const notepad = map.get(1234);
    assert.ok(notepad, "o processo real continua presente");
    assert.equal(notepad.name, "notepad.exe");
    assert.equal(notepad.commandLine, "notepad.exe notas.txt");
    // Sem cpu/mem enriquecidos — e isso NÃO é motivo para perder a lista.
    assert.equal(notepad.cpu, 0);
    assert.equal(notepad.memoryMb, 0);
  });

  it("(b) enriquecimento bem-sucedido continua a aplicar cpu/mem à lista", async () => {
    const map = await snapshotProcesses({
      runPrimary: async () => CIM_ROWS,
      enrich: async (target) => {
        const notepad = target.get(1234);
        assert.ok(notepad, "o enrichimento recebe a lista já populada");
        notepad.cpu = 12.3;
        notepad.memoryMb = 88;
      },
    });

    assert.equal(map.size, 3);
    assert.equal(map.get(1234).cpu, 12.3);
    assert.equal(map.get(1234).memoryMb, 88);
  });

  it("a primária tem precedência: um objeto único (não array) continua a ser lista válida", async () => {
    const map = await snapshotProcesses({
      runPrimary: async () => JSON.stringify({ ProcessId: 7, Name: "Idle", CommandLine: "" }),
      enrich: async () => {},
    });
    assert.equal(map.size, 1);
    assert.equal(map.get(7).name, "Idle");
  });
});
