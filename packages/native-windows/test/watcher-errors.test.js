import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isTransientWatcherError,
  watcherErrorKey,
  WatcherErrorDeduper,
} from "../dist/index.js";

/**
 * O watcher do Windows produz centenas de EPERM/ENOENT esperados em
 * junctions/reparse points (Documents\Meus Vídeos) e em pastas temporárias que
 * desaparecem (Temp\WinSAT, __PSScriptPolicyTest_*.ps1). Estes testes fixam a
 * política: tolerar + deduplicar (sem spam de stack trace), sem silenciar erros
 * inesperados.
 */
describe("Watcher transient error classification", () => {
  it("trata EPERM/ENOENT/EACCES/EBUSY como esperados", () => {
    for (const code of ["EPERM", "ENOENT", "EACCES", "EBUSY"]) {
      assert.equal(isTransientWatcherError({ code }), true, `${code} deve ser transitório`);
    }
  });

  it("não classifica erros desconhecidos como transitórios", () => {
    assert.equal(isTransientWatcherError({ code: "EIO" }), false);
    assert.equal(isTransientWatcherError(new Error("boom")), false);
    assert.equal(isTransientWatcherError(null), false);
  });

  it("agrupa caminhos temporários voláteis na mesma chave", () => {
    const a = watcherErrorKey({ code: "EPERM", path: "C:\\Users\\u\\AppData\\Local\\Temp\\WinSAT" });
    const b = watcherErrorKey({ code: "EPERM", path: "C:\\Users\\u\\AppData\\Local\\Temp\\WinSAT" });
    assert.equal(a, b);

    // Sufixos aleatórios não criam chaves distintas.
    const p1 = watcherErrorKey({ code: "EPERM", path: "C:\\Temp\\njhm4xe4" });
    const p2 = watcherErrorKey({ code: "EPERM", path: "C:\\Temp\\abc12345" });
    assert.equal(p1, p2);

    // Padrão __PSScriptPolicyTest_* é normalizado.
    const s1 = watcherErrorKey({ code: "ENOENT", path: "C:\\Temp\\__PSScriptPolicyTest_a1b2.ps1" });
    const s2 = watcherErrorKey({ code: "ENOENT", path: "C:\\Temp\\__PSScriptPolicyTest_z9y8.ps1" });
    assert.equal(s1, s2);
  });
});

describe("WatcherErrorDeduper", () => {
  it("reporta a primeira ocorrência e suprime as repetidas na janela", () => {
    const dedup = new WatcherErrorDeduper(60_000);
    const err = { code: "EPERM", path: "C:\\Temp\\WinSAT" };

    const first = dedup.record(err, 1000);
    assert.ok(first, "a primeira ocorrência deve ser reportada");
    assert.equal(first.suppressed, 0);

    for (let i = 0; i < 46; i++) {
      assert.equal(dedup.record(err, 1000 + i), null, "repetições imediatas são suprimidas");
    }

    // Depois da janela, volta a reportar e conta quantas foram suprimidas.
    const later = dedup.record(err, 1000 + 60_001);
    assert.ok(later, "passada a janela, reporta de novo");
    assert.equal(later.suppressed, 46);
  });

  it("chaves diferentes são contadas independentemente", () => {
    const dedup = new WatcherErrorDeduper(60_000);
    dedup.record({ code: "EPERM", path: "C:\\Temp\\WinSAT" }, 1000);
    const other = dedup.record({ code: "ENOENT", path: "C:\\Temp\\gone" }, 1000);
    assert.ok(other, "erro de outra assinatura continua visível");
    assert.equal(other.key.startsWith("ENOENT:"), true);
  });
});
