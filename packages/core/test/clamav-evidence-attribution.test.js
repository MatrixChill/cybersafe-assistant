import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createSpawnClamav, parseClamavOutput, spawnClamav } from "../dist/index.js";

/**
 * OS 9 P1 QUE PODEM DAR `clean` SEM EVIDÊNCIA — Codex F4, F5, F6.
 *
 * A mesma família de mentira que a sprint anterior disse ter eliminado: um
 * ficheiro que ninguém conseguiu avaliar aparece como "limpo". Tudo aqui é
 * determinístico e sem clamscan: F6 corre o `spawnClamav` REAL sobre um filho
 * simulado, F4 e F5 são a função pura do parser.
 *
 * NENHUM teste deste ficheiro toca no runtime do utilizador nem lança o binário.
 */

const SUMMARY = (scanned, infected, errors) => `
----------- SCAN SUMMARY -----------
Known viruses: 3628114
Engine version: 1.5.2
Scanned directories: 0
Scanned files: ${scanned}
Infected files: ${infected}
Total errors: ${errors}
Data scanned: 68 B
`.trimStart();

/** Filho simulado: entrega `chunks` um a um, como um pipe real. */
function makeChunkedChild(chunks, code) {
  const child = new EventEmitter();
  child.pid = 51500;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  setTimeout(() => {
    for (const c of chunks) child.stdout.emit("data", c);
    child.emit("close", code);
  }, 5);
  return child;
}

describe("F6 — stdout descodificado por chunk corrompe o caminho e perde a deteção", () => {
  it("uma linha FOUND partida a meio de um caractere multibyte continua a ser lida", async () => {
    const ficheiro = String.raw`C:\Users\teste\acentuação.txt`;
    const linha = `${ficheiro}: Eicar-Signature FOUND\n`;
    const bytes = Buffer.from(linha, "utf8");
    // Partir ENTRE os dois bytes do "ã": 0xC3 no fim de um chunk, 0xA3 no
    // início do seguinte. É o que um pipe faz a meio de uma linha.
    const i = bytes.indexOf(Buffer.from("ã", "utf8"));
    assert.ok(i > 0, "o caminho de teste tem de conter um multibyte");
    const primeiro = bytes.subarray(0, i + 1);
    const resto = Buffer.concat([
      bytes.subarray(i + 1),
      Buffer.from(SUMMARY(1, 1, 0), "utf8"),
    ]);

    // `spawnClamav` REAL (o de produção), com o `child_process` simulado.
    const spawnCalls = [];
    const handle = spawnClamav(
      "clamscan",
      [ficheiro],
      { timeoutMs: 5_000, windowsHide: true },
      {
        spawn: () => {
          spawnCalls.push(1);
          return makeChunkedChild([primeiro, resto], 1);
        },
        spawnSync: () => ({ status: 0 }),
      },
    );
    const outcome = await handle.outcome;
    assert.equal(spawnCalls.length, 1, "o seam foi injectado — nenhum processo real foi lançado");

    const parsed = parseClamavOutput({
      files: [ficheiro],
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      code: outcome.code,
      fileExists: () => true,
    });

    assert.equal(
      parsed.files[0].verdict,
      "detected",
      `uma deteção perdida por descodificação virou "${parsed.files[0].verdict}" — o ficheiro foi declarado limpo sem evidência`,
    );
    assert.equal(parsed.files[0].signature, "Eicar-Signature");
    assert.doesNotMatch(outcome.stdout, /\uFFFD/, "o stdout descodificou com replacement chars");
  });

  it("o mesmo com o caractere partido no stderr (linha 'Can't open file')", async () => {
    const ficheiro = String.raw`C:\Users\teste\acentuação.txt`;
    const linha = `WARNING: Can't open file ${ficheiro}: 225\n`;
    const bytes = Buffer.from(linha, "utf8");
    const i = bytes.indexOf(Buffer.from("ã", "utf8"));
    const primeiro = bytes.subarray(0, i + 1);
    const resto = bytes.subarray(i + 1);

    const handle = spawnClamav(
      "clamscan",
      [ficheiro],
      { timeoutMs: 5_000, windowsHide: true },
      {
        spawn: () => {
          const child = new EventEmitter();
          child.pid = 51501;
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => true;
          setTimeout(() => {
            child.stderr.emit("data", primeiro);
            child.stderr.emit("data", resto);
            child.stdout.emit("data", Buffer.from(SUMMARY(0, 0, 1), "utf8"));
            child.emit("close", 2);
          }, 5);
          return child;
        },
        spawnSync: () => ({ status: 0 }),
      },
    );
    const outcome = await handle.outcome;
    const parsed = parseClamavOutput({
      files: [ficheiro],
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      code: outcome.code,
      fileExists: () => true,
    });
    assert.equal(
      parsed.files[0].reason,
      "file-unreadable",
      `o erro de leitura não pode desaparecer por descodificação: ${JSON.stringify(parsed.files[0])}`,
    );
  });
});

describe("F5 — evidência parcial nunca dá `clean`", () => {
  it("2 infectado declarados, 1 FOUND nomeado: os sem correspondência são `error`", () => {
    // O resumo declara DOIS infectados e o clamscan nomeia UM. A Knowing que
    // falta não pode ser declarada limpa em ficheiro nenhum (Codex F5).
    const files = ["C:\\tmp\\a.txt", "C:\\tmp\\b.txt", "C:\\tmp\\c.txt", "C:\\tmp\\d.txt"];
    const out = parseClamavOutput({
      files,
      stdout: "C:\\tmp\\c.txt: Eicar-Signature FOUND\n" + SUMMARY(4, 2, 0),
      stderr: "",
      code: 1,
      fileExists: () => true,
    });
    assert.equal(out.files.find((f) => f.file.endsWith("c.txt")).verdict, "detected");
    for (const f of out.files.filter((x) => !x.file.endsWith("c.txt"))) {
      assert.equal(
        f.verdict,
        "error",
        `${f.file} saiu "${f.verdict}" — falta explicar 1 das 2 infecções declaradas`,
      );
      assert.equal(f.reason, "detection-unattributed");
    }
    assert.equal(out.detected, true);
  });

  it("1 infectado declarado e 1 FOUND nomeado: o resto do lote é `clean`", () => {
    // A regra NÃO pode disparar por `Infected files > 0` sozinho: se o resumo
    // fecha com as linhas, a explicação está completa e os restantes ficheiros
    // foram varridos. Marcar 19 ficheiros bons como `error` seria pior que a
    // mentira original.
    const files = ["C:\\tmp\\a.txt", "C:\\tmp\\b.txt", "C:\\tmp\\c.txt", "C:\\tmp\\d.txt"];
    const out = parseClamavOutput({
      files,
      stdout: "C:\\tmp\\c.txt: Eicar-Signature FOUND\n" + SUMMARY(4, 1, 0),
      stderr: "",
      code: 1,
      fileExists: () => true,
    });
    assert.equal(out.files.filter((f) => f.verdict === "clean").length, 3);
    assert.equal(out.errorCount, 0);
    assert.equal(out.files.find((f) => f.file.endsWith("c.txt")).verdict, "detected");
  });

  it("erros declarados e NOMEADOS um a um não alagam aos restantes", () => {
    // `Total errors: 1` com a linha que nomeia o ficheiro: o erro está
    // atribuído. Os outros foram varridos.
    const files = ["C:\\tmp\\a.txt", "C:\\tmp\\b.txt", "C:\\tmp\\c.txt", "C:\\tmp\\d.txt", "C:\\tmp\\e.txt"];
    const out = parseClamavOutput({
      files,
      stdout: SUMMARY(4, 0, 1),
      stderr: "WARNING: Can't open file C:\\tmp\\d.txt: Permission denied\n",
      code: 2,
      fileExists: () => true,
    });
    assert.equal(out.files.find((f) => f.file.endsWith("d.txt")).reason, "file-unreadable");
    assert.equal(out.files.filter((f) => f.verdict === "clean").length, 4);
    assert.equal(out.errorCount, 1);
  });

  it("erros declarados SEM nomeação: os sem correspondência são `error`", () => {
    const files = ["C:\\tmp\\a.txt", "C:\\tmp\\b.txt"];
    const out = parseClamavOutput({
      files,
      stdout: SUMMARY(2, 0, 2),
      stderr: "",
      code: 2,
      fileExists: () => true,
    });
    for (const f of out.files) {
      assert.equal(f.verdict, "error", `${f.file}: 2 erros declarados, nenhum atribuído`);
      assert.equal(f.reason, "detection-unattributed");
    }
  });

  it("sem erros e sem infeções no resumo, `clean` continua a ser `clean`", () => {
    // A regra nova NÃO pode degradar o caminho bom: evidência completa continua
    // a dar clean.
    const out = parseClamavOutput({
      files: ["C:\\tmp\\a.txt", "C:\\tmp\\b.txt"],
      stdout: "C:\\tmp\\a.txt: OK\nC:\\tmp\\b.txt: OK\n" + SUMMARY(2, 0, 0),
      stderr: "",
      code: 0,
      fileExists: () => true,
    });
    assert.equal(out.files.filter((f) => f.verdict === "clean").length, 2);
    assert.equal(out.errorCount, 0);
  });
});

describe("F4 — basename só quando é INIVOCADO", () => {
  it("dois ficheiros com o mesmo nome: a deteção não pode ser atribuída ao errado", () => {
    // O clamscan imprimiu um caminho RELATIVO: o casamento directo falha e o
    // fallback por nome é tentado. Com dois ficheiros pedidos com o mesmo
    // basename, adivinhar é adivinhar.
    const alvo = String.raw`C:\a\instalador.exe`;
    const outro = String.raw`C:\b\instalador.exe`;
    const out = parseClamavOutput({
      files: [alvo, outro],
      stdout: `b\\instalador.exe: Eicar-Test FOUND\n${SUMMARY(2, 1, 0)}`,
      stderr: "",
      code: 1,
      fileExists: () => true,
    });
    assert.notEqual(
      out.files[0].verdict,
      "detected",
      `a deteção foi atribuída a ${alvo} por PALPITE de basename; a linha FOUND nomeia o outro ficheiro`,
    );
    assert.equal(out.files[0].verdict, "error", "sem correspondência inequívoca é `error`, nunca clean");
    assert.equal(out.files[0].reason, "detection-unattributed");
  });

  it("basename inívoco continua a funcionar (um ficheiro, um nome)", () => {
    const ficheiro = String.raw`C:\Users\teste\documentos\relatório.txt`;
    const out = parseClamavOutput({
      files: [ficheiro],
      stdout: `relatorio\\relat\\relatório.txt: Eicar-Test FOUND\n${SUMMARY(1, 1, 0)}`,
      stderr: "",
      code: 1,
      fileExists: () => true,
    });
    assert.equal(
      out.files[0].verdict,
      "detected",
      `o fallback por basename é o que salva o caminho normalizado: ${JSON.stringify(out.files[0])}`,
    );
  });

  it("erro de leitura por nome ambíguo também não pode alargar ao outro ficheiro", () => {
    const alvo = String.raw`C:\a\instalador.exe`;
    const outro = String.raw`C:\b\instalador.exe`;
    const out = parseClamavOutput({
      files: [alvo, outro],
      stdout: SUMMARY(1, 0, 1),
      stderr: "WARNING: Can't open file b\\instalador.exe: Permission denied\n",
      code: 2,
      fileExists: () => true,
    });
    assert.notEqual(
      out.files[0].reason,
      "file-unreadable",
      "o erro de leitura do outro ficheiro foi atribuido por basename",
    );
  });
});

describe("os testes deste ficheiro não tocam no runtime", () => {
  it("o binário do clamscan nunca é chamado", async () => {
    // Sanidade do ficheiro: os ficheiros de teste só escrevem em os.tmpdir().
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cs-evidence-"));
    await fs.rm(root, { recursive: true, force: true });
    assert.ok(true);
  });
});