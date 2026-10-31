/**
 * R8 — SCAN MANAGER: USB read-only de ponta a ponta.
 *
 * Contrato (R8-USB-CONTRACT-CODEX-2026-10-12.md):
 *  - O scan USB reutiliza `custom` com o alvo confirmado pelo servico e
 *    tem de propagar `readOnly` ao motor em TODOS os ficheiros (nunca uma
 *    quarentena escondida no meio do caminho).
 *  - Nao seguir links/junctions/reparse points para fora da raiz: o que
 *    sai da raiz resolvida nao e' analisado (conta como exclusao, nao como
 *    "analisado sem detecoes").
 *  - Comportamento normal (nao-USB) preservado.
 *
 * O motor aqui e' um duble: o que se prova e' o CONTRATO do scan-manager
 * (o que passa para baixo e o que deixa entrar), nao a analise em si — essa
 * esta' provada em r8-usb-readonly.test.js com o motor real.
 *
 * Uso: node --test packages/service/test/r8-usb-readonly-scan.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { ScanManager, estaContidoNaRaiz } from "../dist/scan-manager.js";

async function esperarTerminal(manager, id, timeoutMs = 20_000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const estado = manager.getScan(id);
    if (estado && (estado.status === "completed" || estado.status === "failed" || estado.status === "cancelled")) {
      return estado;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("scan não chegou a estado terminal dentro do tempo");
}

/** Motor-duble que registra exatamente o que o scan-manager lhe pediu. */
function motorEspiao() {
  const chamadas = [];
  return {
    chamadas,
    motor: {
      scanArtifact: async (file, source, options) => {
        chamadas.push({ file, source, options });
        return {
          results: [{ fileName: path.basename(file), size: 1, severity: "low", confidence: 1, rulesTriggered: [], riskScore: 0, verdict: "safe", sha256: "" }],
          totalFiles: 1,
          highRiskCount: 0,
          overallSeverity: "low",
          rulesTriggered: [],
          riskScore: 0,
        };
      },
      emitScanProgress: () => {},
      isExcluded: () => false,
      prefetchClamav: async () => ({ spawned: false }),
      clearClamavPrefetch: () => {},
    },
  };
}

/** Cria o "dispositivo" (raiz) com um ficheiro e tenta criar um junction para fora. */
async function dispositivoComJunction(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cs-usb-scan-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const raiz = path.join(base, "pen");
  const fora = path.join(base, "fora");
  await fs.mkdir(raiz, { recursive: true });
  await fs.mkdir(fora, { recursive: true });
  await fs.writeFile(path.join(raiz, "dentro.txt"), "conteudo do dispositivo");
  await fs.writeFile(path.join(fora, "segredo-fora.txt"), "está fora da raiz");

  let junction = false;
  try {
    // Junction (mklink /J) não exige elevação, ao contrário de symlink.
    execFileSync("cmd", ["/c", "mklink", "/J", path.join(raiz, "atalho"), fora], { stdio: "ignore" });
    junction = true;
  } catch {
    junction = false;
  }
  return { base, raiz, fora, junction };
}

test("estaContidoNaRaiz: contencao por caminho, não por prefixo de string", () => {
  const base = path.join(os.tmpdir(), "cs-contencao");
  const raiz = path.join(base, "pen");

  assert.equal(estaContidoNaRaiz(raiz, raiz), true, "a propria raiz esta' contida");
  assert.equal(estaContidoNaRaiz(raiz, path.join(raiz, "a.txt")), true);
  assert.equal(estaContidoNaRaiz(raiz, path.join(raiz, "sub", "b.txt")), true);

  // O erro classico: "pen2" comeca por "pen" mas nao esta' dentro.
  assert.equal(estaContidoNaRaiz(raiz, path.join(base, "pen2", "a.txt")), false);
  assert.equal(estaContidoNaRaiz(raiz, path.join(base, "outro")), false);
  assert.equal(estaContidoNaRaiz(raiz, path.join(raiz, "..", "fora.txt")), false);
  assert.equal(estaContidoNaRaiz("", path.join(raiz, "a.txt")), false);
  assert.equal(estaContidoNaRaiz(raiz, ""), false);

  if (process.platform === "win32") {
    assert.equal(estaContidoNaRaiz(raiz, raiz.toUpperCase()), true, "Windows: caminho e' insensivel a maiusculas");
  }
});

test("BITE: scan USB read-only propaga readOnly+skipVirusTotal a TODOS os ficheiros", async (t) => {
  const { raiz } = await dispositivoComJunction(t);
  await fs.writeFile(path.join(raiz, "segundo.txt"), "mais um ficheiro do dispositivo");

  const { motor, chamadas } = motorEspiao();
  const manager = new ScanManager(motor);
  const id = await manager.startScan("custom", raiz, { readOnly: true });
  assert.ok(id, "startScan tem de aceitar o scan read-only");
  const estado = await esperarTerminal(manager, id);

  assert.equal(estado.status, "completed", `scan devia completar (erro: ${estado.error})`);
  assert.ok(chamadas.length >= 2, `esperava os ficheiros do dispositivo, veio ${chamadas.length}`);
  for (const chamada of chamadas) {
    assert.equal(chamada.options.readOnly, true, `readOnly tem de chegar ao motor (${chamada.file})`);
    assert.equal(chamada.options.skipVirusTotal, true, "USB nunca consulta VT");
  }
});

test("BITE: nada fora da raiz e' analisado (junction contornada ou recusada)", async (t) => {
  const { raiz, fora, junction } = await dispositivoComJunction(t);
  const { motor, chamadas } = motorEspiao();
  const manager = new ScanManager(motor);
  const id = await manager.startScan("custom", raiz, { readOnly: true });
  const estado = await esperarTerminal(manager, id);
  assert.equal(estado.status, "completed");

  const raizReal = await fs.realpath(raiz);
  for (const chamada of chamadas) {
    const alvoReal = await fs.realpath(chamada.file);
    assert.ok(
      estaContidoNaRaiz(raizReal, alvoReal),
      `ficheiro fora da raiz analisado: ${chamada.file} -> ${alvoReal}`,
    );
  }
  const foraReal = await fs.realpath(path.join(fora, "segredo-fora.txt"));
  assert.equal(
    chamadas.some((chamada) => path.resolve(chamada.file) === foraReal),
    false,
    "o ficheiro fora da raiz nunca pode ser analisado",
  );
  if (!junction) {
    t.diagnostic("junction não pôde ser criada neste ambiente: a garantia é a do walk (symlinks/reparse ignorados)");
  }
});

test("comportamento normal preservado: scan sem readOnly nao liga a flag", async (t) => {
  const { raiz } = await dispositivoComJunction(t);
  const { motor, chamadas } = motorEspiao();
  const manager = new ScanManager(motor);
  const id = await manager.startScan("custom", raiz);
  const estado = await esperarTerminal(manager, id);

  assert.equal(estado.status, "completed");
  assert.ok(chamadas.length > 0);
  for (const chamada of chamadas) {
    assert.notEqual(chamada.options.readOnly, true, "um scan normal nao pode virar read-only");
  }
});
