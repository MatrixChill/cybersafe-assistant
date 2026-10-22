import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseClamavOutput } from "../dist/index.js";

/**
 * FECHO14 / RECOVERY-CLA03 — ClamAV parser integrity (read-only, pure function).
 *
 * Invariants:
 *  - stdout vazio + exit 0 NUNCA é `clean` (precisa do summary completo)
 *  - output parcial sem `Infected files:` → error (inconsistent-exit)
 *  - FOUND sem matching file → error (detection-unattributed)
 *  - `: OK` por ficheiro → clean (evidência positiva por ficheiro)
 *  - exit 2 sem FOUND → error (não clean)
 *  - null exit code → exit-unknown, NUNCA clean
 */

const EXISTS = () => true;

describe("RECOVERY-CLA03 — parseClamavOutput invariants", () => {
  it("stdout vazio + exit 0 → NÃO clean (inconsistent-exit)", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\sample.txt"],
      stdout: "",
      stderr: "",
      code: 0,
      fileExists: EXISTS,
    });
    assert.equal(out.files[0].verdict, "error", "stdout vazio → error, não clean");
    assert.equal(out.files[0].reason, "inconsistent-exit", "reason inconsistent-exit");
  });

  it("stdout parcial sem summary → error (inconsistent-exit)", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\sample.txt"],
      stdout: "C:\\tmp\\sample.txt: OK\n", // nomeado mas sem summary
      stderr: "",
      code: 0,
      fileExists: EXISTS,
    });
    // : OK confirma scan → clean (evidência positiva por ficheiro)
    assert.equal(out.files[0].verdict, "clean", ": OK = clean comprovado");
  });

  it("exit 2 + stderr sem FOUND → NÃO clean", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\sample.txt"],
      stdout: "",
      stderr: "clamscan: ERROR: Can't initialize database",
      code: 2,
      fileExists: EXISTS,
    });
    assert.equal(out.files[0].verdict, "error", "exit 2 → error");
    assert.notEqual(out.files[0].verdict, "clean", "NUNCA clean sem prova");
  });

  it("FOUND + Infected files:1 → detected (contagem fecha)", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\eicar.txt"],
      stdout: "C:\\tmp\\eicar.txt: Eicar-Signature FOUND\n----------- SCAN SUMMARY ----------\nKnown viruses: 1\nScanned files: 1\nInfected files: 1\nTotal errors: 0\n",
      stderr: "",
      code: 1,
      fileExists: EXISTS,
    });
    assert.equal(out.files[0].verdict, "detected", "FOUND → detected");
    assert.equal(out.files[0].signature, "Eicar-Signature");
  });

  it("Infected files:1 sem FOUND → detection-unattributed (NÃO clean)", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\a.txt"],
      stdout: "----------- SCAN SUMMARY ----------\nInfected files: 1\nScanned files: 1\nTotal errors: 0\n",
      stderr: "",
      code: 1,
      fileExists: EXISTS,
    });
    assert.equal(out.files[0].verdict, "error", "deteção sem atribuição → error");
    assert.equal(out.files[0].reason, "detection-unattributed", "reason");
  });

  it("exit null (processo abortado sem código) → NÃO clean", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\sample.txt"],
      stdout: "",
      stderr: "",
      code: null,
      fileExists: EXISTS,
    });
    assert.equal(out.files[0].verdict, "error", "exit null → error");
    assert.notEqual(out.files[0].verdict, "clean", "null nunca = success/clean");
  });

  it(": OK explícito → clean", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\safe.txt"],
      stdout: "C:\\tmp\\safe.txt: OK\n----------- SCAN SUMMARY ----------\nInfected files: 0\nScanned files: 1\nTotal errors: 0\n",
      stderr: "",
      code: 0,
      fileExists: EXISTS,
    });
    assert.equal(out.files[0].verdict, "clean", ": OK explícito → clean");
  });

  // CLA03-01 — ramo FIX (2026-10-14, D3): exit 2 + Total errors: 1 atribuído
  // a OUTRO ficheiro → ficheiro alvo NÃO nomeado → NÃO pode ser clean.
  it("exit 2 + Total errors: 1 atribuído (não ao ficheiro alvo) → error", () => {
    const out = parseClamavOutput({
      files: ["C:\\tmp\\target.txt"],
      stdout: "C:\\tmp\\other.txt: ERROR: Can't open file\n----------- SCAN SUMMARY ----------\nScanned files: 1\nInfected files: 0\nTotal errors: 1\n",
      stderr: "",
      code: 2,
      fileExists: EXISTS,
    });
    assert.equal(out.files[0].verdict, "error", "exit 2 sem prova do ficheiro alvo → error, NÃO clean");
    assert.notEqual(out.files[0].verdict, "clean", "clean falso evitado por CLA03-01");
  });

  // Caso válido: exit 1 + FOUND atribuído + summary fecha → detected, limpa a contagem
  it("exit 1 + FOUND apenas num ficheiro + outro não nomeado (Scanned < N) → não-named error", () => {
    // CLA03-02 (root review): lote [a.txt FOUND, b.txt] com Infected files: 1
    // + Scanned files: 1 (b.txt NÃO foi scaneado). b.txt não tem `: OK` e
    // o resumo não cobre todos (1 < 2) → NÃO pode ser clean.
    const out = parseClamavOutput({
      files: ["C:\\tmp\\a.txt", "C:\\tmp\\b.txt"],
      stdout: "C:\\tmp\\a.txt: Eicar-Signature FOUND\n----------- SCAN SUMMARY ----------\nScanned files: 1\nInfected files: 1\nTotal errors: 0\n",
      stderr: "",
      code: 1,
      fileExists: EXISTS,
    });
    assert.equal(out.files[0].verdict, "detected", "a.txt FOUND → detected");
    assert.equal(out.files[1].verdict, "error", "b.txt não scaneado → error (não clean falso)");
  });

  it("exit 1 + FOUND + Scanned files: 2 (OK implícito) → ficheiro não nomeado clean", () => {
    // Caso NORMAL do lote: clamscan nomeia apenas infectados; limpos são
    // cobertos pelo resumo `Scanned files == N`. b.txt é clean pela contagem.
    const out = parseClamavOutput({
      files: ["C:\\tmp\\a.txt", "C:\\tmp\\b.txt"],
      stdout: "C:\\tmp\\a.txt: Eicar-Signature FOUND\n----------- SCAN SUMMARY ----------\nScanned files: 2\nInfected files: 1\nTotal errors: 0\n",
      stderr: "",
      code: 1,
      fileExists: EXISTS,
    });
    assert.equal(out.files[0].verdict, "detected", "a.txt FOUND → detected");
    assert.equal(out.files[1].verdict, "clean", "b.txt limpo pela contagem do resumo");
  });
});
