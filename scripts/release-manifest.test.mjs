import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { construirManifesto } from "../scripts/release-manifest.mjs";
import { gerarSomas } from "../scripts/release-checksums.mjs";

async function pasta(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-manifest-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function instalador(dir, bytes = 4096) {
  const ficheiro = path.join(dir, "CyberSafeSetup-0.2.0.exe");
  await fs.writeFile(ficheiro, Buffer.alloc(bytes, 0x5a));
  return ficheiro;
}

const BASE = {
  url: "https://github.com/example/cybersafe/releases/download/v0.2.0/CyberSafeSetup-0.2.0.exe",
  version: "0.2.0",
  channel: "stable",
  notes: "Primeira release pública.",
};

test("o hash e o tamanho vêm do ficheiro real e batem certo com as somas da release", async (t) => {
  const dir = await pasta(t);
  const ficheiro = await instalador(dir);
  const manifesto = await construirManifesto({ ...BASE, ficheiro });

  assert.equal(manifesto.schema, "cybersafe.release-manifest/1");
  assert.equal(manifesto.file.sizeBytes, (await fs.stat(ficheiro)).size);
  assert.match(manifesto.file.sha256, /^[0-9a-f]{64}$/);

  const somas = await gerarSomas(dir);
  const linha = somas.corpo.trim().split(/\s+/);
  assert.equal(linha[0], manifesto.file.sha256, "as duas ferramentas discordam sobre o mesmo ficheiro");
});

test("canal estável recusa versão com pré-release (a armadilha medida em #16)", async (t) => {
  const dir = await pasta(t);
  const ficheiro = await instalador(dir);
  await assert.rejects(
    () => construirManifesto({ ...BASE, ficheiro, version: "0.1.11-internal.pap-r7.20261031" }),
    /pré-liberta.*stable/i,
  );
  // O mesmo interno é legítimo no canal interno: a guarda é sobre a afirmação,
  // não sobre a string.
  const interno = await construirManifesto({
    ...BASE, ficheiro, version: "0.1.11-internal.pap-r7.20261031", channel: "internal",
  });
  assert.equal(interno.channel, "internal");
});

test("sem assinatura no produto: o produtor não inventa canal de confiança", async (t) => {
  const dir = await pasta(t);
  const ficheiro = await instalador(dir);
  const manifesto = await construirManifesto({ ...BASE, ficheiro });
  assert.equal(manifesto.signature, undefined, "assinar é decisão #14, não output deste script");
});

test("HTTPS sem credenciais é obrigatório; notas vazias não passam", async (t) => {
  const dir = await pasta(t);
  const ficheiro = await instalador(dir);
  await assert.rejects(
    () => construirManifesto({ ...BASE, ficheiro, url: "http://exemplo/a.exe" }),
    /HTTPS/,
  );
  await assert.rejects(
    () => construirManifesto({ ...BASE, ficheiro, url: "https://user:pass@exemplo/a.exe" }),
    /HTTPS|credenciais/i,
  );
  await assert.rejects(() => construirManifesto({ ...BASE, ficheiro, notes: "   " }), /notas/i);
});

test("ficheiro ausente ou pasta em vez de ficheiro não produzem manifesto", async (t) => {
  const dir = await pasta(t);
  await assert.rejects(() => construirManifesto({ ...BASE, ficheiro: path.join(dir, "nao-existe.exe") }), /não legível/);
  await assert.rejects(() => construirManifesto({ ...BASE, ficheiro: dir }), /ficheiro regular/);
});

test("campos opcionais só entram quando declarados (bytes canónicos da assinatura)", async (t) => {
  const dir = await pasta(t);
  const ficheiro = await instalador(dir);
  const simples = await construirManifesto({ ...BASE, ficheiro });
  assert.equal("buildId" in simples, false);
  assert.equal("compatibility" in simples, false);

  const completo = await construirManifesto({
    ...BASE, ficheiro, buildId: "r7-20261101", sourceCommit: "082d862",
    minWindowsBuild: 19041, fromVersion: "0.1.11",
  });
  assert.equal(completo.buildId, "r7-20261101");
  assert.deepEqual(completo.compatibility, { minWindowsBuild: 19041, fromVersion: "0.1.11" });
});
