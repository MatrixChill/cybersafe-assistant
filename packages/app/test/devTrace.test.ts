/**
 * Teste do `src/lib/devTrace.ts` — acompanha o patch TP-UI-TRACE-REAUTHOR.
 * Corre com `npm test -w @cybersafe/app` (tsx --test test/*.test.ts).
 *
 * O que garante, em uma linha: que os metadados DEV dizem a verdade do que está pintado —
 * e que não dizem nada quando não devem.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { devHwTraceAttrs, DEV_TRACE_ATTRS, type DevTraceConnection } from "../src/lib/devTrace";

const ISO = "2026-10-20T06:00:00.000Z";
const amostra = (extra = {}) => ({
  timestamp: ISO,
  cpu: { usage: 46, temperature: 61 },
  ram: { usedGb: 12.5, totalGb: 32, usagePercent: 46 },
  ...extra,
});
const conn = (connected: boolean | null, generation = 0): DevTraceConnection => ({ connected, generation });

test("DEV desligado não produz atributos nenhuns", () => {
  assert.deepEqual(devHwTraceAttrs({ dev: false, hardware: amostra(), origin: "LIVE", connection: conn(true, 1) }), {});
  assert.deepEqual(devHwTraceAttrs({ dev: false, hardware: null, origin: null, connection: null }), {});
});

test("LIVE: origem, conexão, geração e números vêm todos do que é mostrado", () => {
  const a = devHwTraceAttrs({ dev: true, hardware: amostra(), origin: "LIVE", connection: conn(true, 7) });
  assert.equal(a["data-cs-hw-ts"], ISO);
  assert.equal(a["data-cs-hw-origin"], "LIVE");
  assert.equal(a["data-cs-hw-conn"], "true");
  assert.equal(a["data-cs-hw-generation"], "7");
  assert.equal(a["data-cs-hw-cpu"], "46");
  assert.equal(a["data-cs-hw-ram-used"], "12.5");
  assert.deepEqual(Object.keys(a).sort(), [...DEV_TRACE_ATTRS].sort());
});

test("CACHED: última leitura real após queda marca CACHED e conn=false, sem inventar", () => {
  const a = devHwTraceAttrs({ dev: true, hardware: amostra(), origin: "CACHED", connection: conn(false, 8) });
  assert.equal(a["data-cs-hw-origin"], "CACHED");
  assert.equal(a["data-cs-hw-conn"], "false");
  assert.equal(a["data-cs-hw-ts"], ISO, "a amostra pintada continua a ser a última real");
});

test("conexão desconhecida é 'unknown' — nunca 'true' nem omissão", () => {
  assert.equal(devHwTraceAttrs({ dev: true, hardware: amostra(), origin: "LIVE", connection: null })["data-cs-hw-conn"], "unknown");
  assert.equal(devHwTraceAttrs({ dev: true, hardware: amostra(), origin: "LIVE", connection: conn(null) })["data-cs-hw-conn"], "unknown");
});

test("0 é leitura válida; NaN, Infinity e negativos em percentagem são omitidos", () => {
  const zeros = devHwTraceAttrs({
    dev: true,
    hardware: amostra({ cpu: { usage: 0, temperature: 0 }, ram: { usedGb: 0, totalGb: 0, usagePercent: 0 } }),
    origin: "LIVE",
    connection: conn(true, 0),
  });
  assert.equal(zeros["data-cs-hw-cpu"], "0");
  assert.equal(zeros["data-cs-hw-ram-pct"], "0");
  assert.equal(zeros["data-cs-hw-generation"], "0");

  const lixo = devHwTraceAttrs({
    dev: true,
    hardware: amostra({ cpu: { usage: Number.NaN, temperature: null }, ram: { usedGb: -1, totalGb: Number.POSITIVE_INFINITY, usagePercent: -7 } }),
    origin: "LIVE",
    connection: conn(true, -3),
  });
  for (const k of ["data-cs-hw-cpu", "data-cs-hw-cpu-temp", "data-cs-hw-ram-used", "data-cs-hw-ram-total", "data-cs-hw-ram-pct", "data-cs-hw-generation"]) {
    assert.ok(!(k in lixo), `${k} não pode ser publicado a partir de ${JSON.stringify(lixo[k])}`);
  }
});

test("temperatura negativa é leitura verdadeira, não centinela", () => {
  const a = devHwTraceAttrs({ dev: true, hardware: amostra({ cpu: { usage: 10, temperature: -12 } }), origin: "LIVE", connection: conn(true, 1) });
  assert.equal(a["data-cs-hw-cpu-temp"], "-12");
});

test("fora de domínio: timestamp não-ISO e origem DEMO não são publicados", () => {
  const a = devHwTraceAttrs({ dev: true, hardware: amostra({ timestamp: "ontem" }), origin: "DEMO", connection: conn(true, 1) });
  assert.ok(!("data-cs-hw-ts" in a));
  assert.ok(!("data-cs-hw-origin" in a));
});

test("sem amostra pintada: só conexão/geração, sem números nem timestamp inventados", () => {
  const a = devHwTraceAttrs({ dev: true, hardware: null, origin: "UNAVAILABLE", connection: conn(false, 2) });
  assert.deepEqual(Object.keys(a).sort(), ["data-cs-hw-conn", "data-cs-hw-generation", "data-cs-hw-origin"].sort());
  assert.equal(a["data-cs-hw-origin"], "UNAVAILABLE");
});

test("nada de identificadores: nem hostname, nem processos, nem caminhos, mesmo presentes no objecto", () => {
  const comLixo = {
    ...amostra(),
    system: { hostname: "MAQUINA-DO-USER" },
    topProcessesByCpu: [{ name: "chrome.exe", pid: 4242, path: "C:\\Users\\user\\chrome.exe" }],
    network: { interfaceName: "Wi-Fi" },
  };
  const a = devHwTraceAttrs({ dev: true, hardware: comLixo, origin: "LIVE", connection: conn(true, 1) });
  const serializado = JSON.stringify(a);
  for (const proibido of ["MAQUINA-DO-USER", "chrome.exe", "Wi-Fi", "4242", "Users", "pipe"]) {
    assert.ok(!serializado.includes(proibido), `não pode conter ${proibido}`);
  }
  assert.deepEqual(Object.keys(a).sort(), [...DEV_TRACE_ATTRS].sort());
});
