import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  TEMPERATURE_UNAVAILABLE_HINT,
  TEMPERATURE_UNAVAILABLE_TEXT,
  TEMPERATURE_WAITING_TEXT,
  isValidTemperature,
  temperatureDisplay,
} from "../src/lib/temperature";

/**
 * Regressão da UX de temperatura.
 *
 * Sem provider seguro (o WinRing0 foi removido) não existe leitura de CPU/GPU
 * em alguns computadores. A UI não pode ficar eternamente em "A aguardar
 * dados..." nem mostrar 0 °C: passa a "A recolher dados..." e, depois do prazo,
 * a "Temperatura indisponível" — a mesma copy no Dashboard e no PC Center.
 */

describe("temperatureDisplay — estados", () => {
  test("sem leitura e sem prazo esgotado → 'A recolher dados...'", () => {
    for (const value of [null, undefined]) {
      const display = temperatureDisplay(value);
      assert.equal(display.state, "waiting");
      assert.equal(display.value, null);
      assert.equal(display.text, TEMPERATURE_WAITING_TEXT);
    }
  });

  test("sem leitura depois do prazo → 'Temperatura indisponível' (não fica a aguardar)", () => {
    const display = temperatureDisplay(null, { timedOut: true });
    assert.equal(display.state, "unavailable");
    assert.equal(display.value, null);
    assert.equal(display.text, TEMPERATURE_UNAVAILABLE_TEXT);
    assert.equal(display.hint, TEMPERATURE_UNAVAILABLE_HINT);
  });

  test("a copy de indisponível explica de forma honesta", () => {
    assert.match(TEMPERATURE_UNAVAILABLE_HINT, /sensor/i);
    assert.notEqual(TEMPERATURE_WAITING_TEXT, TEMPERATURE_UNAVAILABLE_TEXT);
  });
});

describe("temperatureDisplay — nunca 0 °C artificial", () => {
  test("0 e valores não finitos não são temperatura válida", () => {
    for (const bad of [0, -1, -20, Number.NaN, Infinity, -Infinity, undefined, null, "55" as unknown as number]) {
      assert.equal(isValidTemperature(bad), false, `${String(bad)} não pode ser válido`);
      assert.equal(temperatureDisplay(bad).value, null);
    }
  });

  test("0 °C nunca aparece como texto", () => {
    assert.notEqual(temperatureDisplay(0, { timedOut: true }).text, "0°C");
    assert.equal(temperatureDisplay(0, { timedOut: true }).state, "unavailable");
  });

  test("uma leitura real é apresentada tal como vem do provider", () => {
    const display = temperatureDisplay(62.5);
    assert.equal(display.state, "available");
    assert.equal(display.value, 62.5);
    assert.equal(display.text, "62.5°C");
    assert.equal(display.hint, null);
  });

  test("leitura real depois do prazo continua a mandar", () => {
    assert.equal(temperatureDisplay(48, { timedOut: true }).state, "available");
  });
});

describe("temperatureDisplay — consistência Dashboard/PC Center", () => {
  test("as duas páginas usam a mesma função, logo o mesmo texto", () => {
    const cpu = temperatureDisplay(null, { timedOut: true });
    const gpu = temperatureDisplay(null, { timedOut: true });
    assert.deepEqual(cpu, gpu);
  });

  test("o estado degrada de waiting para unavailable (o utilizador vê progresso)", () => {
    assert.equal(temperatureDisplay(null).state, "waiting");
    assert.equal(temperatureDisplay(null, { timedOut: true }).state, "unavailable");
  });
});
