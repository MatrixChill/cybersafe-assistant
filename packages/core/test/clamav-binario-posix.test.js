import test from "node:test";
import assert from "node:assert/strict";
import {
  selecionaClamavBinario,
  diagnoseClamavBinary,
  classifyClamavHealth,
  CLAMAV_BINARY_ENV,
} from "../dist/clamav.js";

/**
 * A seleção do binário ClamAV em POSIX: «está no disco» não é «é o motor».
 * Nada aqui toca no disco — o leitor é injectado, e é isso que permite afirmar
 * que um `.exe` ou um ficheiro sem bit de execução são recusados numa máquina
 * onde eles existem mesmo.
 */
function leitor({ ficheiros = [], executaveis = [], magics = {} } = {}) {
  const existem = new Set(ficheiros);
  const podeExecutar = new Set(executaveis);
  return {
    isFile: (caminho) => existem.has(caminho),
    executavel: (caminho) => podeExecutar.has(caminho),
    magic: (caminho) => (caminho in magics ? magics[caminho] : existem.has(caminho) ? "\u007fE" : null),
  };
}

const PIN = "/mnt/c/Program Files/ClamAV/clamscan.exe";
const BOM = "/usr/bin/clamscan";

test("um pin .exe não é motor em Linux, e o motivo é nomeado", () => {
  const l = leitor({ ficheiros: [PIN], executaveis: [PIN] });
  const { escolhido, recusados } = selecionaClamavBinario(
    [{ path: PIN, source: "explicit" }],
    "linux",
    l,
  );
  assert.equal(escolhido, null);
  assert.equal(recusados.length, 1);
  assert.match(recusados[0].motivo, /\.exe/);
});

test("um PE com nome POSIX é recusado pela assinatura, não pelo nome", () => {
  const l = leitor({ ficheiros: [BOM], executaveis: [BOM], magics: { [BOM]: "MZ" } });
  const { escolhido, recusados } = selecionaClamavBinario(
    [{ path: BOM, source: "unix" }],
    "linux",
    l,
  );
  assert.equal(escolhido, null);
  assert.match(recusados[0].motivo, /PE de Windows/);
});

test("sem bit de execução é recusado; um ELF executável é escolhido", () => {
  const semBit = leitor({ ficheiros: [BOM] });
  assert.match(
    selecionaClamavBinario([{ path: BOM, source: "unix" }], "linux", semBit).recusados[0].motivo,
    /permissão de execução/,
  );
  const ok = leitor({ ficheiros: [BOM], executaveis: [BOM] });
  assert.equal(
    selecionaClamavBinario([{ path: BOM, source: "unix" }], "linux", ok).escolhido?.path,
    BOM,
  );
});

test("o candidato recusado não tapa o seguinte: a ordem de autoridade mantém-se", () => {
  const l = leitor({
    ficheiros: [PIN, "/usr/local/bin/clamscan"],
    executaveis: [PIN, "/usr/local/bin/clamscan"],
  });
  const { escolhido, recusados } = selecionaClamavBinario(
    [
      { path: PIN, source: "explicit" },
      { path: "/usr/local/bin/clamscan", source: "unix" },
    ],
    "linux",
    l,
  );
  assert.equal(escolhido.source, "unix");
  assert.deepEqual(recusados.map((r) => r.path), [PIN]);
});

test("nada no disco ⇒ escolhido null, sem invenção de caminho", () => {
  const { escolhido, recusados } = selecionaClamavBinario(
    [{ path: BOM, source: "unix" }],
    "linux",
    leitor({}),
  );
  assert.equal(escolhido, null);
  assert.deepEqual(recusados, []);
});

test("Windows continua a escolher pelo nome: a verificação é de POSIX", () => {
  const l = leitor({ ficheiros: [BOM], executaveis: [] });
  assert.equal(
    selecionaClamavBinario([{ path: BOM, source: "program-files" }], "win32", l).escolhido?.path,
    BOM,
  );
});

test("diagnóstico em Linux diz «recusado», não «não encontrado»", () => {
  const l = leitor({ ficheiros: [PIN], executaveis: [PIN] });
  const d = diagnoseClamavBinary({
    env: { PATH: "", [CLAMAV_BINARY_ENV]: PIN },
    platform: "linux",
    exists: (c) => c === PIN,
    leitor: l,
  });
  assert.equal(d.resolved, null, "um binário Windows não é o motor resolvido");
  assert.equal(d.recusados.length, 1);
  assert.equal(d.recusados[0].path, PIN);
  assert.match(d.recusados[0].motivo, /\.exe/);
  assert.equal(d.candidates.find((c) => c.path === PIN)?.exists, true, "existe, mas foi recusado");
});

test("diagnóstico em Linux com ClamAV real resolve e não recusa nada", () => {
  const l = leitor({ ficheiros: [BOM], executaveis: [BOM] });
  const d = diagnoseClamavBinary({
    env: { PATH: "", [CLAMAV_BINARY_ENV]: BOM },
    platform: "linux",
    exists: (c) => c === BOM,
    leitor: l,
  });
  assert.equal(d.resolved, BOM);
  assert.equal(d.resolvedSource, "explicit");
  assert.deepEqual(d.recusados, []);
});

const semMotor = { versionOutput: null, dbDir: null, dbFiles: null };

test("o estado do motor diz «existe mas não é desta plataforma», não «não encontrado»", () => {
  const { health } = classifyClamavHealth({
    ...semMotor,
    binarioRecusado: [{ nome: "clamscan.exe", motivo: "é um executável Windows (.exe)" }],
  });
  assert.equal(health.status, "unavailable");
  assert.match(health.detail, /existe no disco mas não é motor desta plataforma/);
  assert.match(health.detail, /clamscan\.exe é um executável Windows/);
  assert.doesNotMatch(health.detail, /not found/, "«não encontrado» mandaria instalar o que já lá está");
  assert.match(health.detail, /CYBERSAFE_CLAMSCAN_PATH/, "tem de dizer o remédio");
});

test("sem recusa, o texto continua «not found or failed» — Windows não mudou", () => {
  const comErro = classifyClamavHealth({ ...semMotor, versionError: "spawn clamscan EACCES" });
  assert.equal(comErro.health.status, "unavailable");
  assert.equal(comErro.health.detail, "clamscan not found or failed: spawn clamscan EACCES");
  assert.equal(
    classifyClamavHealth({ ...semMotor, binarioRecusado: [] }).health.detail,
    "clamscan not found or failed: unknown",
    "lista vazia não é uma recusa inventada",
  );
});
