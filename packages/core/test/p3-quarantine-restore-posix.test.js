import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { QuarantineManager } from "../dist/response.js";

/**
 * §9 pede que a quarentena respeite «Permissões», «Restauro» e «Destino
 * existente». Os três têm lógica que só significa alguma coisa em POSIX: o
 * modo gravado na entrada, o `chmod 0o000` que fecha o ficheiro isolado, e a
 * recolha temporária de permissão de leitura que o restauro faz antes de copiar
 * e desfaz logo a seguir. Em Windows nada disso é observável — o NTFS ignora o
 * bit de POSIX e `chmod` só mexe no bit de leitura — por isso os casos que
 * afirmam sobre modos são `skip`ados lá, com a razão escrita, e não contados
 * como passagem.
 *
 * Corre sobre o `QuarantineManager` real e um diretório temporário próprio. O
 * manager lê e escreve ficheiros de verdade; é exatamente isso que se quer
 * medir. Nenhum caminho fora deste diretório é tocado.
 */

const CONTEUDO = "Benign disposable fixture for the POSIX quarantine round-trip.";
const MODO_ORIGINAL = 0o640;
const soPosix = process.platform === "win32" ? { skip: "o modo POSIX não é observável em NTFS" } : false;

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cs-p3-quarantine-posix-"));
  const dados = path.join(base, "service-data");
  const destino = path.join(base, "destino");
  await fs.mkdir(dados, { recursive: true });
  await fs.mkdir(destino, { recursive: true });
  const original = path.join(destino, "fixture.txt");
  await fs.writeFile(original, CONTEUDO);
  await fs.chmod(original, MODO_ORIGINAL);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sha256 = crypto.createHash("sha256").update(CONTEUDO).digest("hex");
  const analysis = {
    artifactPath: original, fileName: "fixture.txt", size: Buffer.byteLength(CONTEUDO), sha256,
    verdict: "malicious", severity: "critical", riskScore: 100, confidence: 0.99,
    rulesTriggered: ["known_bad_hash"], factors: [], recommendedAction: "quarantined",
    scanTimestamp: new Date().toISOString(),
  };
  const manager = new QuarantineManager(dados);
  await manager.init();
  return { manager, dados, original, sha256, analysis };
}

const modo = async (ficheiro) => (await fs.stat(ficheiro)).mode & 0o777;

test("isolamento e restauro devolvem o ficheiro e a entrada deixa de existir", async (t) => {
  const { manager, dados, original, analysis } = await fixture(t);
  const entrada = await manager.quarantine(analysis);
  assert.ok(entrada?.id, "o isolamento tem de ser confirmado");
  await assert.rejects(fs.stat(original), "e o caminho original fica vazio");

  // Reler por uma instância nova é o que prova que o restauro não depende de
  // memória de processo: a entrada tinha de ter sobrevivido ao manifest.
  const reiniciado = new QuarantineManager(dados);
  await reiniciado.init();
  const resultado = await reiniciado.restore(entrada.id);
  assert.equal(resultado.success, true, `restauro falhou: ${resultado.error}`);
  assert.equal(resultado.error, undefined, "restauro completo não pode ficar com limpeza pendente");
  assert.deepEqual(await fs.readFile(original), Buffer.from(CONTEUDO));
  assert.deepEqual(reiniciado.list(), [], "a entrada consumida sai do manifesto");
  await assert.rejects(fs.stat(entrada.quarantinePath), "a cópia em quarentena é removida depois do restauro");
});

test("destino já existente recusa o restauro sem tocar no que lá está", async (t) => {
  const { manager, original, analysis } = await fixture(t);
  const entrada = await manager.quarantine(analysis);
  assert.ok(entrada?.id);
  const bytes_alheios = "escrito por outra coisa entretanto — não pode ser substituído";
  await fs.writeFile(original, bytes_alheios);

  const resultado = await manager.restore(entrada.id);
  assert.equal(resultado.success, false, "um destino ocupado nunca é substituído");
  assert.match(resultado.error ?? "", /destino/i, "a recusa tem de dizer porquê");
  assert.equal(await fs.readFile(original, "utf8"), bytes_alheios);
  assert.equal(manager.list().some((x) => x.id === entrada.id), true, "a entrada continua em quarentena");
  assert.ok(await fs.stat(entrada.quarantinePath), "e a cópia isolada continua lá");
});

test("POSIX: o modo original volta a ser o modo do ficheiro restaurado", soPosix, async (t) => {
  const { manager, original, analysis } = await fixture(t);
  assert.equal(await modo(original), MODO_ORIGINAL, "a fixtura começa com o modo que dizemos");
  const entrada = await manager.quarantine(analysis);
  assert.ok(entrada?.id);
  assert.equal(await modo(entrada.quarantinePath), 0o000, "o ficheiro isolado fica sem qualquer permissão");

  const resultado = await manager.restore(entrada.id);
  assert.equal(resultado.success, true, `restauro falhou: ${resultado.error}`);
  assert.equal(await modo(original), MODO_ORIGINAL, "o modo com que o ficheiro foi apanhado é o modo com que volta");
});

test("POSIX: o que está isolado não se lê, e o restauro ainda assim lê", soPosix, async (t) => {
  const { manager, analysis } = await fixture(t);
  const entrada = await manager.quarantine(analysis);
  assert.ok(entrada?.id);

  await assert.rejects(fs.readFile(entrada.quarantinePath), (error) => error.code === "EACCES",
    "se o modo não protegesse nada, a alínea «Permissões» do §9 seria decorativa");
  assert.equal((await manager.restore(entrada.id)).success, true,
    "o restauro tem de conseguir ler o que acabou de confirmar que estava ilegível");
});
