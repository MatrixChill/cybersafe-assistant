import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  YARA_CLASSIC_RUNTIME_DEPENDENCY,
  classifyWindowsLoaderFailure,
  diagnosticsFromRun,
} from "../dist/yara-classic.js";

/**
 * TP-VM016 — O COMPILADOR QUE NUNCA CHEGOU A CORRER.
 *
 * ── O que foi observado (captura manual, VM Windows 11) ─────────────────────
 * O cartão YARA ficou em `Erro`, e a saída do compilador era o código Windows
 * `3221225781` (0xC0000135, STATUS_DLL_NOT_FOUND). O manifesto registava
 * "compilador terminou com código 3221225781 sem diagnóstico legível": verdade
 * literal, mas indistinguível de "o corpus não compila" — e não era o corpus.
 *
 * ── O que este ficheiro fixa ───────────────────────────────────────────────
 *  1. Um NTSTATUS de loader é reconhecido como falha de AMBIENTE, com nome
 *     estável, e o diagnóstico diz que NENHUMA regra foi avaliada.
 *  2. O diagnóstico nomeia a dependência que o binário oficial DECLARA na sua
 *     tabela de imports (`VCRUNTIME140.dll`, runtime MSVC 2015-2022 x64) e diz
 *     explicitamente que a DLL em falta no host não se conclui daqui.
 *  3. Um código de compilação normal (1) continua a produzir o diagnóstico
 *     antigo — a classificação nova não engole o caminho antigo.
 *
 * O que este ficheiro NÃO afirma: que a DLL em falta na VM seja a
 * `VCRUNTIME140.dll`. Essa prova exige ler o host medido; a captura não a traz.
 * A verificação de imports/transitivas vive em `out/TP-VM016/pe-runtime-deps`.
 */

describe("falha de loader do Windows — ambiente, não corpus", () => {
  it("reconhece 0xC0000135 nos dois sinais com que o Node o pode devolver", () => {
    const unsigned = classifyWindowsLoaderFailure(3221225781);
    const signed = classifyWindowsLoaderFailure(-1073741515);

    assert.equal(unsigned?.name, "STATUS_DLL_NOT_FOUND");
    assert.equal(unsigned?.code, 0xc0000135);
    assert.deepEqual(signed, unsigned, "o código é o mesmo em uint32; só muda a representação");
  });

  it("não classifica como loader um código de compilação normal", () => {
    assert.equal(classifyWindowsLoaderFailure(1), null);
    assert.equal(classifyWindowsLoaderFailure(0), null);
    assert.equal(classifyWindowsLoaderFailure(null), null, "sem exit code não inventa falha do loader");
    assert.equal(classifyWindowsLoaderFailure(0xc000013a), null, "0xC000013A é saída por Ctrl-C, não falha de loader");
    assert.equal(classifyWindowsLoaderFailure(3221225794)?.name, "STATUS_DLL_INIT_FAILED", "0xC0000142 também é loader");
  });

  it("o diagnóstico diz que nada foi avaliado, nomeia a dependência declarada e não inventa a DLL em falta", () => {
    const diagnostics = diagnosticsFromRun({ status: 3221225781, signal: null, stdout: "", stderr: "" });

    assert.equal(diagnostics.length, 1, "uma falha de loader é uma causa, não um diagnóstico por linha vazia");
    const [diagnostic] = diagnostics;
    assert.equal(diagnostic.severity, "error");
    assert.equal(diagnostic.code, "io-error", "falha de ambiente partilha o código da indisponibilidade declarada");
    assert.match(diagnostic.message, /STATUS_DLL_NOT_FOUND/);
    assert.match(diagnostic.message, /0xC0000135/);
    assert.match(diagnostic.message, /não chegou a correr/);
    assert.match(diagnostic.message, /nenhuma regra foi avaliada/);
    assert.match(diagnostic.message, /falha de AMBIENTE, não do corpus/);
    assert.ok(
      diagnostic.message.includes(YARA_CLASSIC_RUNTIME_DEPENDENCY),
      "o diagnóstico tem de nomear a dependência que o binário declara",
    );
    assert.match(diagnostic.message, /só se prova olhando para o host/, "a DLL em falta não se assume daqui");
    assert.doesNotMatch(diagnostic.message, /sem diagnóstico legível/, "o código já tem nome; não é ilegível");
    assert.doesNotMatch(diagnostic.message, /corpus (inválido|não compila)/);
  });

  it("um código de compilação não relacionado mantém o caminho antigo", () => {
    const diagnostics = diagnosticsFromRun({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "error: syntax error, unexpected '}' (3)\n",
    });

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, "syntax-error");
    assert.match(diagnostics[0].message, /unexpected/);
    assert.doesNotMatch(diagnostics[0].message, /loader do Windows/);
  });

  it("exit 0 sem diagnóstico continua a não produzir erro", () => {
    assert.deepEqual(diagnosticsFromRun({ status: 0, signal: null, stdout: "", stderr: "" }), []);
  });
});
