/**
 * DIST-CLAMAV13OUT — O `freshclam` do update e o estado sem base.
 *
 * O que este ficheiro prova:
 *   1. RESOLUÇÃO DO `freshclam` com PATH LIMPO: sem pin devolve o nome simples
 *      (o PATH decide, comportamento antigo inalterado) e NÃO inventa caminhos;
 *      com pin cujo irmão existe usa o caminho absoluto (é o que faz o update
 *      funcionar numa máquina onde o motor é o bundle empacotado); com pin sem
 *      irmão volta ao nome simples, em vez de apontar para um fantasma;
 *   2. o irmão é `freshclam.exe` no Windows e `freshclam` fora dele;
 *   3. o bundle REAL (se já estiver vendorizado) resolve para o irmão do pin;
 *   4. SEM BASE DE ASSINATURAS o motor continua `degraded` — encontrar o
 *      binário não é ter detecção. NÃO se corre o freshclam nem se varre nada:
 *      só o probe do motor (que faz `clamscan --version`, isolado, sem base e
 *      sem analisar ficheiro nenhum).
 *
 * Uso: node --test packages/service/test/dist-clamav-freshclam-resolve.test.js
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveFreshclamBinary } from "../dist/updater.js";
import { ClamavBridge, CLAMAV_BINARY_ENV } from "@cybersafe/core";

/** O `clamscan` real existe? Se não, os testes que o usam são `skip`ped. */
const CLAMSCAN_AVAILABLE = (() => {
  try {
    const result = spawnSync("clamscan", ["--version"], { timeout: 5000, windowsHide: true, encoding: "utf-8" });
    return result.status === 0 && String(result.stdout ?? "").includes("ClamAV");
  } catch {
    return false;
  }
})();

let tmp;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-freshclam-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

const emptyEnv = () => ({ PATH: "" });

describe("resolveFreshclamBinary — PATH limpo, sem inventar caminhos", () => {
  it("sem pin ⇒ nome simples (o PATH volta a decidir; nada é inventado)", () => {
    const exists = () => {
      throw new Error("sem pin não se pode sondar o disco");
    };
    assert.equal(resolveFreshclamBinary({ env: emptyEnv(), platform: "win32", exists }), "freshclam");
    assert.equal(resolveFreshclamBinary({ env: { PATH: "", [CLAMAV_BINARY_ENV]: "   " }, platform: "linux", exists }), "freshclam");
    assert.equal(resolveFreshclamBinary({ env: emptyEnv(), platform: "win32", exists: () => false }), "freshclam");
  });

  it("com pin e irmão EXISTENTE ⇒ caminho absoluto do irmão", () => {
    const pinned = path.join(tmp, "clamav", "clamscan.exe");
    const seen = [];
    const resolved = resolveFreshclamBinary({
      env: { PATH: "", [CLAMAV_BINARY_ENV]: pinned },
      platform: "win32",
      exists: (candidate) => {
        seen.push(candidate);
        return candidate === path.join(tmp, "clamav", "freshclam.exe");
      },
    });
    assert.equal(resolved, path.join(tmp, "clamav", "freshclam.exe"));
    assert.equal(seen.length, 1, "sonda exactamente um candidato: o irmão");
  });

  it("com pin mas SEM irmão ⇒ nome simples (não aponta para um fantasma)", () => {
    const pinned = path.join(tmp, "clamav", "clamscan.exe");
    assert.equal(
      resolveFreshclamBinary({ env: { PATH: "", [CLAMAV_BINARY_ENV]: pinned }, platform: "win32", exists: () => false }),
      "freshclam",
    );
  });

  it("o nome do irmão depende da plataforma", () => {
    const pinned = "/opt/clamav/clamscan";
    const linux = resolveFreshclamBinary({
      env: { PATH: "", [CLAMAV_BINARY_ENV]: pinned },
      platform: "linux",
      exists: (candidate) => candidate === "/opt/clamav/freshclam",
    });
    assert.equal(linux, "/opt/clamav/freshclam");
  });

  it("o PATH limpo não é usado para adivinhar o irmão", () => {
    // Um `freshclam` a mais no PATH não muda nada: a autoridade é o pin.
    const pinned = path.join(tmp, "bundle", "clamscan.exe");
    const resolved = resolveFreshclamBinary({
      env: { PATH: path.join(tmp, "outro- sitio"), [CLAMAV_BINARY_ENV]: pinned },
      platform: "win32",
      exists: (candidate) => candidate.includes("outro"),
    });
    assert.equal(resolved, "freshclam", "sem irmão no bundle, devolve o nome simples");
  });
});

describe("o bundle REAL, quando existe, é o irmão escolhido", () => {
  it("vendor/clamav resolve para vendor/clamav/freshclam.exe", async () => {
    const vendorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "vendor", "clamav");
    const vendorPinned = path.join(vendorDir, "clamscan.exe");
    const sibling = path.join(vendorDir, "freshclam.exe");
    const hasBundle = await fs
      .access(sibling)
      .then(() => true)
      .catch(() => false);
    if (!hasBundle) {
      // Sem bundle vendorizado nesta máquina: o contrato já está coberto acima.
      return;
    }
    assert.equal(
      resolveFreshclamBinary({ env: { PATH: "", [CLAMAV_BINARY_ENV]: vendorPinned }, platform: "win32" }),
      sibling,
    );
  });
});

describe("sem base de assinaturas o motor continua degradado", () => {
  it("directório de base vazio ⇒ NÃO active (encontrar o binário não é detectar)", async (t) => {
    if (!CLAMSCAN_AVAILABLE) {
      t.skip("clamscan real ausente nesta máquina");
      return;
    }
    const definitionsDir = path.join(tmp, "definitions");
    await fs.mkdir(path.join(definitionsDir, "clamav"), { recursive: true });

    const bridge = new ClamavBridge({ definitionsDir });
    const available = await bridge.isAvailable(true);

    assert.equal(available, false, "sem .cvd/.cld não há detecção real");
    assert.notEqual(bridge.health.status, "active");
    assert.equal(bridge.health.status, "degraded");
    assert.match(bridge.health.detail, /freshclam/, "o diagnóstico tem de dizer o que resolve");
  });

  it("o estado degradado não é alterado por haver um binário resolvido", async (t) => {
    if (!CLAMSCAN_AVAILABLE) {
      t.skip("clamscan real ausente nesta máquina");
      return;
    }
    const definitionsDir = path.join(tmp, "definitions-sem-base");
    await fs.mkdir(path.join(definitionsDir, "clamav"), { recursive: true });

    const bridge = new ClamavBridge({ definitionsDir });
    const available = await bridge.isAvailable(true);

    assert.equal(available, false);
    assert.equal(bridge.health.status, "degraded");
    // A base escolhida (se alguma) NÃO pode ser a do utilizador: o probe é do
    // definitionsDir isolado, e nenhum caminho pessoal é tocado.
    if (bridge.datadir) {
      assert.ok(
        bridge.datadir.startsWith(tmp),
        `a base escolhida tem de ser a da fixture, não ${bridge.datadir}`,
      );
    }
  });
});
