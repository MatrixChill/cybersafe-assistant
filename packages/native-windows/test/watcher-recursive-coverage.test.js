import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IsolatedFileWatcher } from "../dist/watcher-process.js";

/**
 * P0 WATCHER (15/10) — o que a primitiva nova tem de garantir no mundo real.
 *
 * O defeito medido no Windows físico não foi "falta de timeout": foi a prontidão
 * depender de ENUMERAR a árvore toda (487 404 entradas / 122 982 diretórios nas 6
 * raízes default; 11,4 s quente, 32,1 s frio) dentro de um orçamento de 10 000 ms.
 * Estas provas atiram diretamente a esse par relação custo/garantia:
 *   1. prontidão NÃO escala com o tamanho da árvore (não há walk inicial);
 *   2. o buraco do `ignoreInitial` fechou: uma pasta criada DEPOIS do start
 *      também é vigiada, e o ficheiro lá dentro emite `add`;
 *   3. a quietude de 3000 ms continua a dar UMA emissão por ficheiro em escrita,
 *      não uma por chunk (equivalência com o `stabilityThreshold` do chokidar).
 *
 * Só usa pastas temporárias do próprio teste: nada de perfis reais, nada de API
 * do Windows, nada de instalar ou executar a app.
 */

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-watcher-rec-"));
  const watcher = new IsolatedFileWatcher();
  t.after(async () => {
    await watcher.stop().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, watcher };
}

async function semearArvore(dir, pastas, porPasta) {
  for (let p = 0; p < pastas; p++) {
    const sub = path.join(dir, `seed-${p}`);
    await fs.mkdir(sub, { recursive: true });
    await Promise.all(
      Array.from({ length: porPasta }, (_, i) => fs.writeFile(path.join(sub, `f-${i}.dat`), "seed")),
    );
  }
}

test("ready nao depende do tamanho da arvore: attacha em <2s com 4000 entradas", async (t) => {
  const { dir, watcher } = await fixture(t);
  await semearArvore(dir, 400, 10); // 400 pastas + 4000 ficheiros: o antigo modelo varria tudo antes do ready

  const inicio = Date.now();
  await watcher.start([dir]);
  const decorrido = Date.now() - inicio;
  assert.ok(decorrido < 2000, `ready demorou ${decorrido}ms — a prontidão voltou a depender de enumerar`);
  assert.ok(watcher.pid, "o filho tem de estar vivo depois do ready");
});

test("pasta criada DEPOIS do start e vigiada: ficheiro la dentro emite add", async (t) => {
  const { dir, watcher } = await fixture(t);
  await watcher.start([dir]);

  const nova = path.join(dir, `depois-${process.pid}`, "carga.exe");
  await fs.mkdir(path.dirname(nova), { recursive: true });
  const added = once(watcher, "add", { signal: AbortSignal.timeout(15000) });
  await fs.writeFile(nova, "payload");
  const [recebido] = await added;
  assert.equal(recebido, nova, "o ficheiro dentro de uma pasta criada apos o attach tem de chegar a analise");
});

test("escrita em dois chunks da UMA emissao (quietude preservada, nao por chunk)", async (t) => {
  const { dir, watcher } = await fixture(t);
  await watcher.start([dir]);
  const alvo = path.join(dir, "download-binario.dat");

  const eventos = [];
  watcher.on("add", (p) => eventos.push(p));
  watcher.on("change", (p) => eventos.push(p));

  await fs.writeFile(alvo, "primeira-metade-");
  await new Promise((r) => setTimeout(r, 500)); // 2.º chunk ainda dentro da janela de quietude
  await fs.appendFile(alvo, "segunda-metade");

  await new Promise((r) => setTimeout(r, 5500)); // > QUIETUDE_MS (3000) com folga
  const nossos = eventos.filter((p) => path.basename(p) === path.basename(alvo));
  assert.equal(nossos.length, 1, `esperava 1 emissao apos a quietude, recebi ${nossos.length}: ${nossos.join(", ")}`);
  assert.equal(nossos[0], alvo);
});

test("um unlink de ficheiro visto emite unlink (remocao nao e change)", async (t) => {
  const { dir, watcher } = await fixture(t);
  await watcher.start([dir]);
  const alvo = path.join(dir, "a-remover.dat");

  const adicionado = once(watcher, "add", { signal: AbortSignal.timeout(15000) });
  await fs.writeFile(alvo, "x");
  await adicionado;

  const removido = once(watcher, "unlink", { signal: AbortSignal.timeout(15000) });
  await fs.rm(alvo);
  const [recebido] = await removido;
  assert.equal(recebido, alvo);
});
