import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HardwareHealthEngine } from "../dist/hardware.js";

/**
 * P0 ARMAZENAMENTO — O PRIMEIRO SNAPSHOT JÁ TEM DE TRAZER A LEITURA.
 *
 * ── Bug MEDIDO pelo humano (2026-10-10) ────────────────────────────────────
 * Dashboard e PC Center presos em "Ainda sem leitura do armazenamento desde o
 * arranque" / "—", enquanto a Saúde do Windows mostrava o C: a 89% e 106,4 GB
 * livres. A causa imediata era a cache do handler (ver
 * `packages/service/test/hardware-snapshot-freshness.test.js`); a causa de
 * fundo, esta: o tick médio é `fire-and-forget`, portanto o PRIMEIRO snapshot
 * era sempre construído ANTES de a leitura dos volumes existir e publicava
 * "ainda sem leitura" — que era depois a única fotografia que os consumidores
 * viam.
 *
 * A regra agora é: a primeira leitura do armazenamento é ESPERADA (com prazo de
 * 4 s), para que a primeira resposta já diga a verdade medida. As seguintes
 * continuam assíncronas, ao ritmo do tick médio (5 s).
 *
 * Este teste corre contra o motor REAL (systeminformation → volumes do SO): é a
 * única forma de provar que a primeira fotografia não sai da fábrica vazia. Se a
 * leitura do SO falhar, o teste falha — e tem de falhar, porque o contrato é
 * "nunca publicar 'ainda sem leitura' quando o SO reporta volumes".
 */
describe("armazenamento — o PRIMEIRO snapshot já publica a leitura", () => {
  test("a primeira leitura dos volumes é esperada e sai no primeiro snapshot", async () => {
    const engine = new HardwareHealthEngine();
    const snap = await engine.getSnapshot([]);

    assert.doesNotMatch(
      snap.disk.reason ?? "",
      /Ainda sem leitura/,
      "o primeiro snapshot publicou o estado inicial sem sequer tentar ler os volumes",
    );
    assert.equal(snap.disk.readStatus, "ok", `leitura do armazenamento falhou: ${snap.disk.reason}`);
    assert.ok(snap.disk.volumes.length > 0, "nenhum volume publicado");
    assert.ok(snap.disk.primary, "sem volume principal não há percentagem a mostrar");
    assert.equal(typeof snap.disk.primary.mount, "string");
    assert.equal(snap.disk.usagePercent, snap.disk.primary.usagePercent);
    assert.equal(
      snap.disk.reason,
      null,
      "uma leitura boa não pode trazer motivo de falha",
    );
  });

  test("a chamada seguinte continua a publicar a mesma leitura (não regride para unavailable)", async () => {
    const engine = new HardwareHealthEngine();
    const first = await engine.getSnapshot([]);
    const second = await engine.getSnapshot([]);

    assert.equal(second.disk.readStatus, "ok");
    assert.equal(
      second.disk.primary?.mount,
      first.disk.primary?.mount,
      "o volume principal não muda entre snapshots do mesmo arranque",
    );
    assert.equal(second.disk.reason, null);
  });
});
