import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseClamavOutput } from "../dist/index.js";

/**
 * P1 — CLAMAV_EICDAR_EXIT2: o contrato de resultado.
 *
 * Causa raiz provada em `output/p0-clamav-resource-exhaustion/CHECKPOINT-3-REVIEW-AND-EICAR.md`:
 * o Windows Defender apaga o ficheiro no instante em que o clamscan o abre, e o
 * clamscan sai com 2 (erro) sem nunca ter lido o ficheiro.
 *
 * Regras que estes testes fixam, por decisão do utilizador (2026-10-02):
 *
 *  - Um ficheiro que desapareceu NUNCA é reportado como "limpo".
 *  - Se existe evidência de deteção, a deteção é PRESERVADA e o facto de o
 *    ficheiro ter sido removido é reportado à parte.
 *  - Sem evidência de quem removeu, diz-se "análise não concluída / ficheiro
 *    removido durante a análise" — sem mencionar o Defender.
 *  - `exit 2` NUNCA significa "infectado": é um erro de I/O.
 *
 * A função é pura: recebe o output e responde. Não arranja ficheiros, não
 * spawna nada. É por isso que se testa sem clamscan e sem disco.
 */

const FOUND_SUMMARY = (infected, errors) => `
----------- SCAN SUMMARY -----------
Known viruses: 3628114
Engine version: 1.5.2
Scanned directories: 0
Scanned files: 1
Infected files: ${infected}
Total errors: ${errors}
Data scanned: 68 B
`.trimStart();

describe("parseClamavOutput — deteção", () => {
  it("um FOUND no stdout é deteção, mesmo com exit 1", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\a.txt"],
      stdout: "C:\\tmp\\a.txt: Eicar-Signature FOUND\n",
      stderr: "",
      code: 1,
      fileExists: () => true,
    });
    assert.equal(out.files[0].verdict, "detected");
    assert.equal(out.files[0].signature, "Eicar-Signature");
    assert.equal(out.files[0].file, "C:\\tmp\\a.txt");
    assert.equal(out.detected, true);
  });

  it("preserva a deteção MESMO com exit 2 e erros (deteção + erro juntos)", () => {
    // Regra que o utilizador exigiu: se há evidência de deteção, a deteção
    // vence; o erro é reportado, não convertido em "limpo".
    const out = parseClamavOutput({
      files: ["C:\\tmp\\a.txt", "C:\\tmp\\b.txt"],
      stdout:
        "C:\\tmp\\a.txt: Eicar-Signature FOUND\n" + FOUND_SUMMARY(1, 1),
      stderr: "WARNING: Can't access file C:\\tmp\\b.txt: Invalid argument\n",
      code: 2,
      fileExists: (f) => f.endsWith("a.txt"),
    });
    assert.equal(out.files[0].verdict, "detected", "a deteção não pode ser perdida");
    assert.equal(out.files[1].verdict, "error", "o ficheiro ilegível é erro, não clean");
    assert.equal(out.detected, true);
    assert.equal(out.errorCount, 1);
  });

  it("se o resumo diz Infected files > 0 mas não há FOUND, NADA é clean", () => {
    // Detecção que não conseguimos atribuir é o pior caso: dizer "limpo" seria
    // uma mentira. Dizemos "erro" e preservamos o facto de houve deteção.
    const out = parseClamavOutput({
      files: ["C:\\tmp\\a.txt"],
      stdout: FOUND_SUMMARY(1, 0),
      stderr: "",
      code: 1,
      fileExists: () => true,
    });
    assert.equal(out.files[0].verdict, "error");
    assert.equal(out.files[0].reason, "detection-unattributed");
    assert.equal(out.detected, true, "houve deteção, mesmo sem linha FOUND");
  });
});

describe("parseClamavOutput — ficheiro removido durante a análise", () => {
  it("o caso EICAR: exit 2, 0 ficheiros varridos, ficheiro já não existe", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\eicar.txt"],
      stdout: FOUND_SUMMARY(0, 1),
      stderr:
        "LibClamAV Warning: Can't open file C:\\tmp\\eicar.txt: 225\n" +
        "WARNING: Can't open file C:\\tmp\\eicar.txt: Invalid argument\n",
      code: 2,
      fileExists: () => false,
    });
    const f = out.files[0];
    assert.equal(f.verdict, "error", "NUNCA clean");
    assert.equal(f.reason, "file-removed-during-scan");
    assert.equal(f.removedDuringScan, true);
  });

  it("o motivo NÃO menciona o Defender — não há evidência de quem removeu", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\eicar.txt"],
      stdout: FOUND_SUMMARY(0, 1),
      stderr: "WARNING: Can't open file C:\\tmp\\eicar.txt: Invalid argument\n",
      code: 2,
      fileExists: () => false,
    });
    const text = `${out.files[0].reason} ${out.files[0].detail ?? ""} ${out.status.detail ?? ""}`.toLowerCase();
    assert.ok(
      !text.includes("defender") && !text.includes("microsoft"),
      `não se pode atribuir a remoção ao Defender sem evidência: "${text}"`,
    );
  });

  it("ficheiro ilegível mas AINDA EXISTE é 'unreadable', não 'removido'", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\locked.bin"],
      stdout: FOUND_SUMMARY(0, 1),
      stderr: "WARNING: Can't open file C:\\tmp\\locked.bin: Permission denied\n",
      code: 2,
      fileExists: () => true,
    });
    assert.equal(out.files[0].verdict, "error");
    assert.equal(out.files[0].reason, "file-unreadable");
    assert.equal(out.files[0].removedDuringScan, false);
  });

  it("detecção + ficheiro removido: as duas coisas survive", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\eicar.txt"],
      stdout: "C:\\tmp\\eicar.txt: Eicar-Signature FOUND\n" + FOUND_SUMMARY(1, 1),
      stderr: "WARNING: Can't open file C:\\tmp\\eicar.txt: Invalid argument\n",
      code: 2,
      fileExists: () => false,
    });
    assert.equal(out.files[0].verdict, "detected", "a deteção é a informação principal");
    assert.equal(out.files[0].removedDuringScan, true, "e a remoção também é reportada");
    assert.equal(out.files[0].signature, "Eicar-Signature");
  });
});

describe("parseClamavOutput — base de assinaturas", () => {
  it("cl_load no stderr é erro de BASE, e a mensagem tem de dizer isso", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\a.txt"],
      stdout: FOUND_SUMMARY(0, 0),
      stderr: "LibClamAV Error: cl_load: No such file or directory: C:\\db\n",
      code: 2,
      fileExists: () => true,
    });
    assert.equal(out.files[0].verdict, "error");
    assert.equal(out.files[0].reason, "database-unavailable");
    assert.equal(out.status.status, "degraded");
    assert.match(out.status.detail ?? "", /base de assinaturas/i);
  });

  it("base em bom estado mas exit 2 por I/O NÃO é 'base em erro'", () => {
    // A regressão que o checkpoint 2 registou: a bridge dizia "não conseguiu
    // carregar a base" quando a base tinha carregado 3,6 milhões de virus.
    const out = parseClamavOutput({
      files: ["C:\\tmp\\a.txt"],
      stdout: FOUND_SUMMARY(0, 1),
      stderr: "LibClamAV Warning: Can't open file C:\\tmp\\a.txt: 225\n",
      code: 2,
      fileExists: () => false,
    });
    assert.notEqual(out.files[0].reason, "database-unavailable");
    assert.ok(
      !/carregar a base/.test(out.status.detail ?? ""),
      `a base carregou bem; a mensagem não pode dizer que não: "${out.status.detail}"`,
    );
  });
});

describe("parseClamavOutput — limpos, timeout e abort", () => {
  it("exit 0 sem FOUND é clean", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\a.txt"],
      stdout: "C:\\tmp\\a.txt: OK\n" + FOUND_SUMMARY(0, 0),
      stderr: "",
      code: 0,
      fileExists: () => true,
    });
    assert.equal(out.files[0].verdict, "clean");
    assert.equal(out.errorCount, 0);
  });

  it("timeout nunca é clean", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\enorme.bin"],
      stdout: "",
      stderr: "",
      code: null,
      timedOut: true,
      fileExists: () => true,
    });
    assert.equal(out.files[0].verdict, "error");
    assert.equal(out.files[0].reason, "timeout");
  });

  it("abort nunca é clean", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\a.txt"],
      stdout: "",
      stderr: "",
      code: null,
      killed: true,
      fileExists: () => true,
    });
    assert.equal(out.files[0].verdict, "error");
    assert.equal(out.files[0].reason, "aborted");
  });

  it("exit 1 sem FOUND é inconsistente, nunca clean", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\a.txt"],
      stdout: FOUND_SUMMARY(0, 0),
      stderr: "",
      code: 1,
      fileExists: () => true,
    });
    assert.equal(out.files[0].verdict, "error");
    assert.equal(out.files[0].reason, "inconsistent-exit");
  });

  it("um exit 2 genérico sem stderr legível ainda é error, nunca clean", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\a.txt"],
      stdout: "",
      stderr: "",
      code: 2,
      fileExists: () => true,
    });
    assert.equal(out.files[0].verdict, "error");
  });
});

describe("parseClamavOutput — batch", () => {
  it("atribui cada resultado ao ficheiro certo, num batch", () => {
    const files = ["C:\\tmp\\a.txt", "C:\\tmp\\b.txt", "C:\\tmp\\c.txt", "C:\\tmp\\d.txt"];
    const out = parseClamavOutput({
      files,
      stdout:
        "C:\\tmp\\a.txt: OK\n" +
        "C:\\tmp\\c.txt: Eicar-Signature FOUND\n" +
        FOUND_SUMMARY(1, 0),
      stderr: "",
      code: 1,
      fileExists: () => true,
    });
    assert.deepEqual(
      out.files.map((f) => [path0(f.file), f.verdict]),
      [
        ["a.txt", "clean"],
        ["b.txt", "clean"],
        ["c.txt", "detected"],
        ["d.txt", "clean"],
      ],
    );
    assert.equal(out.detected, true);
    assert.equal(out.files.find((f) => f.file.endsWith("c.txt")).signature, "Eicar-Signature");
  });

  it("devolve sempre um resultado por ficheiro pedido, pela mesma ordem", () => {
    const files = ["C:\\tmp\\a.txt", "C:\\tmp\\b.txt"];
    const out = parseClamavOutput({ files, stdout: "", stderr: "", code: 0, fileExists: () => true });
    assert.equal(out.files.length, 2);
    assert.equal(out.files[0].file, files[0]);
    assert.equal(out.files[1].file, files[1]);
  });

  it("um erro de base marca TODOS os ficheiros como error", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\a.txt", "C:\\tmp\\b.txt", "C:\\tmp\\c.txt"],
      stdout: "",
      stderr: "LibClamAV Error: cl_load: No such file or directory: C:\\db\n",
      code: 2,
      fileExists: () => true,
    });
    assert.equal(out.files.filter((f) => f.verdict === "error").length, 3);
    assert.equal(out.files.filter((f) => f.verdict === "clean").length, 0, "nada pode ser clean");
  });

  it("o path impresso pelo clamscan casa mesmo com barras diferentes", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\sub\\a.txt"],
      stdout: "C:/tmp/sub/a.txt: Eicar-Signature FOUND\n" + FOUND_SUMMARY(1, 0),
      stderr: "",
      code: 1,
      fileExists: () => true,
    });
    assert.equal(out.files[0].verdict, "detected", "caminho com / tem de casar com \\");
  });
});

function path0(p) {
  return p.split(/[\\/]/).pop();
}
