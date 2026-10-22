/**
 * DIST-CLAMAV13OUT — RESOLUÇÃO DO MOTOR ClamAV (PATH vs instalação instalada).
 *
 * ── O que este ficheiro prova, e o que NÃO prova ────────────────────────────
 * Prova a parte PURA e read-only da causa medida: com um PATH LIMPO (o cenário
 * da distribuição instalada) o motor continua a ser encontrado numa fixture
 * ISOLADA que imita uma instalação real, e quando não existe nada o resultado é
 * `null` — nunca um caminho inventado. Prova também que encontrar o binário NÃO
 * fabrica `active`: sem base de assinaturas válida a classificação continua
 * `degraded`.
 *
 * NÃO prova — de propósito — que a app arranca o motor: nenhum teste aqui lança
 * um processo, descarrega nada, toca na rede, corre como admin, instala
 * globalmente ou cria/quarentena um ficheiro de malware. A fixture é um ficheiro
 * vazio com o NOME certo; a resolução só olha para a existência, por isso é
 * exactamente isso que ela mede.
 *
 * Uso: node --test packages/core/test/dist-clamav-binary-resolution.test.js
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CLAMAV_BINARY_ENV,
  clamavBinaryName,
  clamavBinaryCandidates,
  firstExistingClamavBinary,
  clamavSpawnFile,
  diagnoseClamavBinary,
  classifyClamavHealth,
} from "../dist/index.js";

const VERSION_OK = "ClamAV 1.5.2\n";

let tmp;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-dist-clamav-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/** Cria um ficheiro vazio com o nome de binário — fixture, nunca execução. */
async function makeBinary(dir, name = "clamscan.exe") {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, "");
  return file;
}

const sourceOf = (candidates, source) => candidates.filter((c) => c.source === source);

describe("clamavBinaryCandidates — precedência das fontes", () => {
  it("PATH vazio e nenhuma raiz conhecida ⇒ zero candidatos (nada inventado)", () => {
    const candidates = clamavBinaryCandidates({ PATH: "" }, "win32");
    assert.deepEqual(candidates, [], "sem PATH e sem raízes não há por onde inventar");
  });

  it("o pin explícito é a PRIMEIRA autoridade, antes do PATH", () => {
    const pinned = path.join(tmp, "pin", "clamscan.exe");
    const candidates = clamavBinaryCandidates(
      { [CLAMAV_BINARY_ENV]: pinned, PATH: "C:\\algures\\bin" },
      "win32",
    );
    assert.equal(candidates[0].path, pinned);
    assert.equal(candidates[0].source, "explicit");
    assert.equal(candidates[1].source, "path", "o PATH mantém-se como segunda autoridade");
  });

  it("o PATH do processo continua a ser uma fonte (comportamento de DEV preservado)", () => {
    const candidates = clamavBinaryCandidates({ PATH: "C:\\a;C:\\b" }, "win32");
    assert.deepEqual(
      candidates.map((c) => c.source),
      ["path", "path"],
    );
    assert.equal(candidates[0].path, path.join("C:\\a", "clamscan.exe"));
  });

  it("as raízes conhecidas do Windows entram quando o PATH não resolve", () => {
    const candidates = clamavBinaryCandidates(
      {
        PATH: "",
        ChocolateyInstall: "C:\\ProgramData\\chocolatey",
        ProgramData: "C:\\ProgramData",
        ProgramFiles: "C:\\Program Files",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
        USERPROFILE: "C:\\Users\\u",
      },
      "win32",
    );
    const sources = new Set(candidates.map((c) => c.source));
    for (const expected of ["chocolatey", "program-files", "scoop", "winget", "user-programs"]) {
      assert.ok(sources.has(expected), `a raiz ${expected} tem de ser um candidato`);
    }
  });

  it("UNIX não mistura raízes do Windows nem a extensão .exe", () => {
    const candidates = clamavBinaryCandidates({ PATH: "" }, "linux");
    assert.equal(clamavBinaryName("linux"), "clamscan");
    assert.ok(candidates.length > 0);
    for (const candidate of candidates) {
      assert.equal(candidate.source, "unix");
      assert.match(candidate.path, /clamscan$/);
    }
  });

  it("candidatos duplicados são colapsados, mantendo o de maior autoridade", () => {
    const dir = "C:\\ProgramData\\chocolatey\\bin";
    const candidates = clamavBinaryCandidates(
      { PATH: dir, ProgramData: "C:\\ProgramData" },
      "win32",
    );
    const samePath = candidates.filter(
      (c) => c.path.toLowerCase() === path.join(dir, "clamscan.exe").toLowerCase(),
    );
    assert.equal(samePath.length, 1, "o mesmo caminho não pode aparecer duas vezes");
    assert.equal(samePath[0].source, "path", "a primeira ocorrência é a que fica");
  });
});

describe("firstExistingClamavBinary — existência, nunca invenção", () => {
  it("devolve null quando nada existe", () => {
    const candidates = [
      { path: "C:\\nao\\existe\\clamscan.exe", source: "program-files" },
      { path: "C:\\tambem\\nao\\clamscan.exe", source: "chocolatey" },
    ];
    assert.equal(firstExistingClamavBinary(candidates, () => false), null);
  });

  it("uma sondagem que rebenta não conta como existência", () => {
    const candidates = [{ path: "C:\\rebenta\\clamscan.exe", source: "path" }];
    assert.equal(
      firstExistingClamavBinary(candidates, () => {
        throw new Error("EPERM");
      }),
      null,
    );
  });

  it("devolve o PRIMEIRO que existe, respeitando a ordem de autoridade", () => {
    const candidates = [
      { path: "C:\\pri\\clamscan.exe", source: "path" },
      { path: "C:\\seg\\clamscan.exe", source: "chocolatey" },
    ];
    const found = firstExistingClamavBinary(candidates, (p) => p.includes("seg"));
    assert.equal(found.path, "C:\\seg\\clamscan.exe");
  });
});

describe("diagnoseClamavBinary — a instalação fora do PATH (cenário distribuição)", () => {
  it("PATH LIMPO + fixture isolada ⇒ o motor é encontrado, com a fonte certa", async () => {
    const root = path.join(tmp, "Program Files");
    const binary = await makeBinary(path.join(root, "ClamAV"));

    const diagnosis = diagnoseClamavBinary({ env: { PATH: "", ProgramFiles: root }, platform: "win32" });

    assert.equal(diagnosis.resolved, binary, "uma instalação fora do PATH tem de ser encontrável");
    assert.equal(diagnosis.resolvedSource, "program-files");
    assert.equal(diagnosis.candidates.filter((c) => c.exists).length, 1);
  });

  it("PATH LIMPO + NADA instalado ⇒ resolved fica null (não inventa um motor)", () => {
    const diagnosis = diagnoseClamavBinary({ env: { PATH: "" }, platform: "win32" });
    assert.equal(diagnosis.resolved, null);
    assert.equal(diagnosis.resolvedSource, null);
    assert.deepEqual(diagnosis.candidates, []);
  });

  it("o pin explícito vence o PATH e as raízes, mesmo com ClamAV a mais", async () => {
    const pinned = await makeBinary(path.join(tmp, "pin"));
    const onPath = await makeBinary(path.join(tmp, "no-path"));
    const inProgramFiles = await makeBinary(path.join(tmp, "pf", "ClamAV"));

    const diagnosis = diagnoseClamavBinary({
      env: {
        [CLAMAV_BINARY_ENV]: pinned,
        PATH: path.join(tmp, "no-path"),
        ProgramFiles: path.join(tmp, "pf"),
      },
      platform: "win32",
    });

    assert.equal(diagnosis.resolved, pinned, "o pin é a autoridade máxima");
    assert.equal(diagnosis.resolvedSource, "explicit");
    assert.ok(diagnosis.candidates.some((c) => c.path === onPath && c.exists));
    assert.ok(diagnosis.candidates.some((c) => c.path === inProgramFiles && c.exists));
  });

  it("o PATH ganha às raízes quando ambos existem (DEV inalterado)", async () => {
    const onPath = await makeBinary(path.join(tmp, "path-dir"));
    await makeBinary(path.join(tmp, "pf", "ClamAV"));

    const diagnosis = diagnoseClamavBinary({
      env: { PATH: path.join(tmp, "path-dir"), ProgramFiles: path.join(tmp, "pf") },
      platform: "win32",
    });

    assert.equal(diagnosis.resolved, onPath, "o PATH continua a ter precedência sobre as raízes fixas");
    assert.equal(diagnosis.resolvedSource, "path");
  });

  it("o diagnóstico é read-only: não cria nem apaga nada no disco", async () => {
    const dir = path.join(tmp, "pf", "ClamAV");
    await makeBinary(dir);
    const before = (await fs.readdir(dir)).sort();
    diagnoseClamavBinary({ env: { PATH: "", ProgramFiles: path.join(tmp, "pf") }, platform: "win32" });
    const after = (await fs.readdir(dir)).sort();
    assert.deepEqual(after, before, "o diagnóstico não pode mexer no que encontra");
  });
});

describe("clamavSpawnFile — o contrato do que o motor lança", () => {
  it("binário resolvido ⇒ caminho absoluto (é o que torna útil a descoberta)", () => {
    const absolute = path.join(tmp, "ClamAV", "clamscan.exe");
    assert.equal(clamavSpawnFile(absolute), absolute);
  });

  it("sem resolução ⇒ o nome simples, e o PATH volta a decidir (comportamento antigo)", () => {
    assert.equal(clamavSpawnFile(null, "win32"), "clamscan.exe");
    assert.equal(clamavSpawnFile(null, "linux"), "clamscan");
  });
});

describe("encontrar o binário NÃO é ter motor: sem base de assinaturas continua degradado", () => {
  it("directório de base ausente ⇒ degraded, nunca active", () => {
    const missing = path.join(tmp, "nao-existe");
    const outcome = classifyClamavHealth({
      versionOutput: VERSION_OK,
      dbDir: null,
      dbFiles: null,
      candidates: [
        { dir: missing, source: "platform-default", state: "missing", signatureFiles: [], newestMtimeMs: 0 },
      ],
    });
    assert.equal(outcome.available, false);
    assert.notEqual(outcome.health.status, "active", "o binário responder não é detecção real");
    assert.equal(outcome.health.status, "degraded");
  });

  it("directório vazio ⇒ degraded com instrução accionável", () => {
    const outcome = classifyClamavHealth({
      versionOutput: VERSION_OK,
      dbDir: null,
      dbFiles: null,
      candidates: [
        { dir: path.join(tmp, "vazia"), source: "app-definitions", state: "empty", signatureFiles: [], newestMtimeMs: 0 },
      ],
    });
    assert.equal(outcome.available, false);
    assert.equal(outcome.health.status, "degraded");
    assert.match(outcome.health.detail, /freshclam/, "o diagnóstico tem de dizer o que resolve");
  });

  it("só com assinaturas presentes é que a classificação pode ser active", () => {
    const outcome = classifyClamavHealth({
      versionOutput: VERSION_OK,
      dbDir: null,
      dbFiles: null,
      candidates: [
        {
          dir: path.join(tmp, "boa"),
          source: "app-definitions",
          state: "ready",
          signatureFiles: ["main.cvd", "daily.cld"],
          newestMtimeMs: Date.now(),
        },
      ],
    });
    assert.equal(outcome.available, true);
    assert.equal(outcome.health.status, "active");
  });
});
