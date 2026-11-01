import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { gerarSomas, sha256Ficheiro, verificarSomas } from "../scripts/release-checksums.mjs";

async function pastaTemporaria(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-checksums-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("o hash em fluxo coincide com o valor conhecido de 'abc'", async (t) => {
  const dir = await pastaTemporaria(t);
  const ficheiro = path.join(dir, "abc.txt");
  await fs.writeFile(ficheiro, "abc");
  assert.equal(
    await sha256Ficheiro(ficheiro),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("as somas são determinísticas, ordenadas e excluem o próprio ficheiro", async (t) => {
  const dir = await pastaTemporaria(t);
  await fs.writeFile(path.join(dir, "b-instalador.exe"), "conteúdo b");
  await fs.writeFile(path.join(dir, "a-manifesto.json"), "{}");
  const primeiro = await gerarSomas(dir);
  const segundo = await gerarSomas(dir);
  assert.equal(primeiro.corpo, segundo.corpo, "dois runs produzem ficheiros diferentes");
  const linhas = primeiro.corpo.trim().split("\n");
  assert.equal(linhas.length, 2);
  assert.match(linhas[0], /^[0-9a-f]{64}  a-manifesto\.json$/);
  assert.match(linhas[1], /^[0-9a-f]{64}  b-instalador\.exe$/);
  assert.equal(primeiro.corpo.includes("SHA256SUMS.txt"), false, "o ficheiro de somas soma-se a si próprio");
  assert.deepEqual(await verificarSomas(dir).then((r) => [r.ok, r.resultados.length]), [true, 2]);
});

test("ficheiro alterado depois de somar é 'divergente', não uma passividade", async (t) => {
  const dir = await pastaTemporaria(t);
  await fs.writeFile(path.join(dir, "instalador.exe"), "um");
  await gerarSomas(dir);
  await fs.writeFile(path.join(dir, "instalador.exe"), "dois");
  const r = await verificarSomas(dir);
  assert.equal(r.ok, false);
  assert.equal(r.resultados[0].estado, "divergente");
});

test("ficheiro em falta e ficheiro não listado chumbam a verificação", async (t) => {
  const dir = await pastaTemporaria(t);
  await fs.writeFile(path.join(dir, "a.bin"), "a");
  await fs.writeFile(path.join(dir, "b.bin"), "b");
  await gerarSomas(dir);
  await fs.rm(path.join(dir, "a.bin"));
  await fs.writeFile(path.join(dir, "c.bin"), "c");
  const r = await verificarSomas(dir);
  assert.equal(r.ok, false);
  assert.equal(r.resultados.find((x) => x.nome === "a.bin").estado, "em_falta");
  assert.deepEqual(r.naoListados, ["c.bin"], "um ficheiro novo passa despercebido");
});

test("um nome que tenta sair do diretório é recusado, não seguido", async (t) => {
  const dir = await pastaTemporaria(t);
  const fora = path.join(dir, "..", `${path.basename(dir)}-fora.txt`);
  await fs.writeFile(fora, "vítima");
  t.after(() => fs.rm(fora, { force: true }));
  const somas = path.join(dir, "SHA256SUMS.txt");
  await fs.writeFile(somas, `${"0".repeat(64)}  ../${path.basename(fora)}\n`);
  const r = await verificarSomas(dir);
  assert.equal(r.ok, false);
  assert.equal(r.resultados[0].estado, "inseguro");
});

test("linha ilegível é um erro, não uma linha ignorada", async (t) => {
  const dir = await pastaTemporaria(t);
  await fs.writeFile(path.join(dir, "a.bin"), "a");
  await fs.writeFile(path.join(dir, "SHA256SUMS.txt"), "não é uma soma\n");
  const r = await verificarSomas(dir);
  assert.equal(r.ok, false);
  assert.equal(r.resultados[0].estado, "formato");
});

test("diretório sem artefactos não produz um ficheiro de somas vazio", async (t) => {
  const dir = await pastaTemporaria(t);
  await assert.rejects(() => gerarSomas(dir), /nada foi somado/i);
  await assert.rejects(() => verificarSomas(dir), /ENOENT/);
});
