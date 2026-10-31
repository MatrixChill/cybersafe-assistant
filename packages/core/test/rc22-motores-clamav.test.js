import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ClamavBridge, classifyClamavHealth, appClamavDatabaseDir } from "../dist/clamav.js";

/**
 * RC22 — CLAMAV: motor disponível ≠ cobertura efetiva.
 *
 * ── O que este ficheiro mediu antes de existir uma correção ──────────────────
 * `new ClamavBridge({ datadir: <pasta com uma .ndb> })` respondia
 * `active — "3 signature database file(s)"` e o scan usava a base da APP, não
 * a pasta pedida. Causa: só `.cvd/.cld/.cuv/.cud` contavam como assinatura, a
 * pasta ficava `empty`, o bridge caía em silêncio para outro candidato — e o
 * `datadir` documentado como prioridade máxima era ignorado sem uma palavra.
 *
 * Depois: a pasta com uma `.ndb` é `ready`; o motor REAL carrega-a
 * (`Known viruses: 1`) e deteta o marcador; e o estado diz `degraded` (motor
 * analisa, cobertura não é oficial) em vez de `active`.
 *
 * ── Sem EICAR ────────────────────────────────────────────────────────────────
 * Nada aqui escreve a assinatura EICAR: a política está em
 * `eicar-manual-opt-in.test.js` e existe porque o Defender do anfitrião
 * bloqueia esses ficheiros (medido outra vez em 2026-10-22: 225 / "Can't open
 * file"). O positivo é um marcador benigno nosso + uma `.ndb` nossa.
 *
 * ── Opt-in ──────────────────────────────────────────────────────────────────
 * `CYBERSAFE_REAL_CLAMSCAN=1` para os testes que arrancam o clamscan real.
 */

const REAL = process.env.CYBERSAFE_REAL_CLAMSCAN === "1";
const MARKER = "CYBERSAFE_RC22_TEST_MARKER";
const MARKER_HEX = Buffer.from(MARKER, "utf8").toString("hex");
const RULE = `RC22.Test.BenignMarker:0:*:${MARKER_HEX}`;

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rc22-clamav-${tag}-`));
}

/** Pasta de base com uma única assinatura local nossa (benigna). */
function localOnlyDatabase() {
  const dir = tmpdir("ndb");
  fs.writeFileSync(path.join(dir, "rc22.ndb"), `${RULE}\n`, "utf8");
  return dir;
}

describe("RC22 ClamAV — classificação: assinaturas locais não são base oficial", () => {
  it("pasta só com .ndb é `ready` para o motor mas `degraded` na cobertura", () => {
    const r = classifyClamavHealth({
      versionOutput: "ClamAV 1.5.2",
      candidates: [
        { dir: "C:\\base-teste", source: "explicit", state: "ready", signatureFiles: ["rc22.ndb"], newestMtimeMs: Date.now() },
      ],
    });
    assert.equal(r.available, true, "o motor carrega a assinatura: tem de poder analisar");
    assert.equal(r.health.status, "degraded", "uma .ndb não é cobertura de produção");
    assert.match(r.health.detail, /local/i);
    assert.match(r.health.detail, /freshclam/);
  });

  it("base oficial (.cvd/.cld) continua active com a contagem real", () => {
    const r = classifyClamavHealth({
      versionOutput: "ClamAV 1.5.2",
      candidates: [
        { dir: "C:\\base", source: "app-definitions", state: "ready", signatureFiles: ["main.cvd", "daily.cld"], newestMtimeMs: Date.now() },
      ],
    });
    assert.equal(r.available, true);
    assert.equal(r.health.status, "active");
    assert.match(r.health.detail, /2 signature database file\(s\)/);
  });

  it("as duas juntas contam 3 ficheiros e ficam active", () => {
    const r = classifyClamavHealth({
      versionOutput: "ClamAV 1.5.2",
      candidates: [
        { dir: "C:\\base", source: "app-definitions", state: "ready", signatureFiles: ["main.cvd", "daily.cld", "rc22.ndb"], newestMtimeMs: Date.now() },
      ],
    });
    assert.equal(r.health.status, "active");
    assert.match(r.health.detail, /3 signature database file\(s\)/);
  });

  it("sem assinaturas nenhumas continua sem `active`", () => {
    const r = classifyClamavHealth({
      versionOutput: "ClamAV 1.5.2",
      candidates: [{ dir: "C:\\vazia", source: "explicit", state: "empty", signatureFiles: [], newestMtimeMs: 0 }],
    });
    assert.equal(r.available, false);
    assert.equal(r.health.status, "degraded");
  });
});

describe("RC22 ClamAV — motor real (OPT-IN: CYBERSAFE_REAL_CLAMSCAN=1)", { skip: !REAL }, () => {
  it("datadir com .ndb nossa: deteta o positivo e deixa o benigno limpo", { timeout: 180_000 }, async () => {
    const dir = localOnlyDatabase();
    const positivo = path.join(dir, "positivo.txt");
    const negativo = path.join(dir, "negativo.txt");
    fs.writeFileSync(positivo, `prefixo ${MARKER} sufixo\n`, "utf8");
    fs.writeFileSync(negativo, "CyberSafe RC22 fixture benigna, sem malware\n", "utf8");

    const bridge = new ClamavBridge({ datadir: dir });
    try {
      const available = await bridge.isAvailable();
      assert.equal(available, true, "uma .ndb válida tem de deixar o motor utilizável");
      assert.equal(bridge.health.status, "degraded", "cobertura limitada não é active");
      assert.equal(bridge.datadir, dir, "o datadir pedido é o datadir usado");

      const pos = await bridge.scanFiles([positivo]);
      assert.equal(pos.detected, true, "o motor real tem de detetar a assinatura local");
      assert.match(String(pos.files[0]?.signature ?? ""), /RC22\.Test\.BenignMarker/);
      assert.equal(pos.files[0]?.verdict, "detected");

      const neg = await bridge.scanFiles([negativo]);
      assert.equal(neg.detected, false);
      assert.equal(neg.files[0]?.verdict, "clean");
    } finally {
      await bridge.dispose?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("base oficial da app, quando existe: active e benigno limpo", { timeout: 180_000 }, async () => {
    const dir = appClamavDatabaseDir();
    const hasArchive = (() => {
      try {
        return fs.readdirSync(dir).some((n) => /\.(cvd|cld)$/i.test(n));
      } catch {
        return false;
      }
    })();
    if (!hasArchive) return; // Nada a provar neste anfitrião; não se inventa cobertura.

    const bridge = new ClamavBridge({});
    const work = tmpdir("real");
    try {
      const disponivel = await bridge.isAvailable();
      assert.equal(disponivel, true);
      assert.equal(bridge.health.status, "active");
      assert.equal(bridge.datadir, dir);
      const benigno = path.join(work, "benigno.txt");
      fs.writeFileSync(benigno, "CyberSafe RC22 fixture benigna\n", "utf8");
      const r = await bridge.scanFiles([benigno]);
      assert.equal(r.detected, false);
      assert.equal(r.files[0]?.verdict, "clean");
    } finally {
      await bridge.dispose?.();
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
