/**
 * DIST-CLAMAV13OUT — INTEGRAÇÃO: PIN do bundle + SEM base ⇒ estado HONESTO.
 *
 * Este é o teste que liga as duas metades do incremento: o `desktop` passa o
 * pin (`CYBERSAFE_CLAMSCAN_PATH` → `resources/clamav/clamscan.exe`) e o core
 * resolve o motor por ele. O que se mede aqui é o que o utilizador vê:
 *
 *   1. com o pin, o motor RESOLVIDO é o do bundle — `resolvedSource` é
 *      `"explicit"`, não o PATH nem uma raiz adivinhada;
 *   2. **sem base de assinaturas o estado NÃO é `active`** — encontrar o
 *      binário (ou trazê-lo empacotado) não é detectar. O estado honesto é
 *      `degraded`, com diagnóstico accionável;
 *   3. a base usada é a da fixture (dentro de %TEMP%), nunca o perfil do
 *      utilizador: este teste não toca em dados pessoais;
 *   4. nada é varrido nem actualizado — o único processo lançado é o
 *      `clamscan --version` da sonda, que não lê base nenhuma.
 *
 * Corre só quando o bundle está vendorizado; sem bundle, faz `skip` em vez de
 * fingir cobertura.
 *
 * Uso: node --test packages/service/test/dist-clamav-pin-no-db-integration.test.js
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ClamavBridge, CLAMAV_BINARY_ENV, diagnoseClamavBinary } from "@cybersafe/core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// HERE = packages/service/test ⇒ a raiz do repo está três níveis acima.
const BUNDLE_DIR = path.resolve(HERE, "..", "..", "..", "vendor", "clamav");
const BUNDLED_CLAMSCAN = path.join(BUNDLE_DIR, "clamscan.exe");
const BUNDLED_FRESHCLAM = path.join(BUNDLE_DIR, "freshclam.exe");

/** Só corre com o bundle real: sem ele, o contrato não é observável. */
const HAS_BUNDLE = fsSync.existsSync(BUNDLED_CLAMSCAN) && fsSync.existsSync(BUNDLED_FRESHCLAM);

let previousPin;
let tmp;

before(() => {
  if (!HAS_BUNDLE) return;
  // O pin é lido do ambiente do PROCESSO (é assim que o serviço o recebe do
  // Electron). Guardamos o valor anterior para não deixar rasto no ambiente.
  previousPin = process.env[CLAMAV_BINARY_ENV];
  process.env[CLAMAV_BINARY_ENV] = BUNDLED_CLAMSCAN;
});

after(() => {
  if (previousPin === undefined) delete process.env[CLAMAV_BINARY_ENV];
  else process.env[CLAMAV_BINARY_ENV] = previousPin;
});

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-clamav-pin-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe("pin do bundle no diagnóstico de binário", () => {
  it("o pin vence o PATH: resolvedSource é \"explicit\" e aponta ao bundle", async (t) => {
    if (!HAS_BUNDLE) {
      t.skip("bundle não vendorizado nesta máquina (node scripts/vendor-clamav.mjs)");
      return;
    }
    const diagnosis = diagnoseClamavBinary();
    assert.equal(diagnosis.resolved, BUNDLED_CLAMSCAN, "o pin é a autoridade máxima da resolução");
    assert.equal(diagnosis.resolvedSource, "explicit", "tem de declarar que veio do pin, não do PATH");
    const pinned = diagnosis.candidates.find((candidate) => candidate.path === BUNDLED_CLAMSCAN);
    assert.ok(pinned, "o pin tem de aparecer na lista de candidatos");
    assert.equal(pinned.exists, true, "e o candidato tem de ser confirmado no disco");
  });
});

describe("o pin vence um ClamAV que JÁ existe no PATH (o defeito real)", () => {
  it("BITE: com um clamscan no PATH e o bundle no pin, o bridge usa o BUNDLE", async (t) => {
    if (!HAS_BUNDLE) {
      t.skip("bundle não vendorizado nesta máquina");
      return;
    }
    // Cenário real de uma máquina que já tem ClamAV instalado: um `clamscan`
    // resolvivel pelo PATH. O "isca" é um ficheiro vazio com o nome certo (o
    // `where` procura por nome; não corre nada) por isso NÃO é um motor válido
    // — a sonda dele falha e o bridge ficaria sem binário nenhum. Com o pin a
    // vencer, a sonda corre sobre o bundle REAL e o motor fica resolvido.
    // ANTES do fix: `where` corria primeiro ⇒ binário = isca ⇒ sonda falha ⇒
    // `binaryPath === null` (o motor empacotado era ignorado em silêncio).
    const decoyDir = path.join(tmp, "isca-no-path");
    await fs.mkdir(decoyDir, { recursive: true });
    await fs.writeFile(path.join(decoyDir, "clamscan.exe"), "");

    const previousPath = process.env.PATH;
    const system32 = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32")
      : "C:\\Windows\\System32";
    // A isca primeiro; o System32 a seguir para o próprio `where.exe` continuar
    // alcançável (sem ele o teste não mediria a competição).
    process.env.PATH = `${decoyDir}${path.delimiter}${system32}`;
    t.after(() => {
      process.env.PATH = previousPath;
    });

    const databaseDirectory = path.join(tmp, "base-do-isca");
    await fs.mkdir(databaseDirectory, { recursive: true });
    const bridge = new ClamavBridge({ definitionsDir: path.join(tmp, "definitions"), datadir: databaseDirectory });
    await bridge.isAvailable(true);

    assert.equal(
      bridge.binaryPath,
      BUNDLED_CLAMSCAN,
      "um pin explícito é decisão do operador/deploy: não pode perder para o PATH",
    );
    assert.notEqual(bridge.binaryPath, path.join(decoyDir, "clamscan.exe"));
  });
});

describe("pin + SEM base de assinaturas ⇒ estado honesto, nunca ACTIVE", () => {
  it("o motor está resolvido mas o estado NÃO é active", async (t) => {
    if (!HAS_BUNDLE) {
      t.skip("bundle não vendorizado nesta máquina");
      return;
    }
    const databaseDirectory = path.join(tmp, "base-vazia");
    await fs.mkdir(databaseDirectory, { recursive: true });

    // definições isoladas + datadir explícito: nada aponta ao perfil do utilizador.
    const bridge = new ClamavBridge({ definitionsDir: path.join(tmp, "definitions"), datadir: databaseDirectory });
    const available = await bridge.isAvailable(true);

    assert.equal(available, false, "sem .cvd/.cld não há detecção real, mesmo com o motor empacotado");
    assert.notEqual(bridge.health.status, "active", "trazer o motor no pacote NÃO é estar activo");
    assert.equal(bridge.health.status, "degraded", "o estado honesto é degradado");
    assert.match(bridge.health.detail, /freshclam/, "o diagnóstico tem de dizer o que resolve (actualizar assinaturas)");
    assert.equal(bridge.binaryPath, BUNDLED_CLAMSCAN, "o binário usado é o do pin");
    if (bridge.datadir) {
      assert.ok(bridge.datadir.startsWith(tmp), `a base tem de ser a da fixture, não ${bridge.datadir}`);
    }
  });

  it("a base da fixture continua VAZIA depois da sonda (nada foi descarregado)", async (t) => {
    if (!HAS_BUNDLE) {
      t.skip("bundle não vendorizado nesta máquina");
      return;
    }
    const databaseDirectory = path.join(tmp, "base-intacta");
    await fs.mkdir(databaseDirectory, { recursive: true });

    const bridge = new ClamavBridge({ definitionsDir: path.join(tmp, "definitions"), datadir: databaseDirectory });
    await bridge.isAvailable(true);

    assert.deepEqual(await fs.readdir(databaseDirectory), [], "a sonda não pode criar nem descarregar assinaturas");
  });

  it("um motor descoberto não fabrica `active` (o detalhe não afirma disponibilidade)", async (t) => {
    if (!HAS_BUNDLE) {
      t.skip("bundle não vendorizado nesta máquina");
      return;
    }
    const databaseDirectory = path.join(tmp, "sem-assinaturas");
    await fs.mkdir(databaseDirectory, { recursive: true });
    const bridge = new ClamavBridge({ definitionsDir: path.join(tmp, "definitions"), datadir: databaseDirectory });
    await bridge.isAvailable(true);

    // O texto do estado degradado não pode prometer proteção: quem lê isto tem
    // de perceber que falta a base, não que está tudo bem.
    const detail = String(bridge.health.detail).toLowerCase();
    assert.ok(detail.length > 0, "estado degradado sem detalhe não é accionável");
    assert.ok(
      !/available \(.*signature/.test(detail),
      "não pode reutilizar o texto de \"active\" quando não há assinaturas",
    );
  });
});
