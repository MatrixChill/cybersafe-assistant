import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendDesktopLog, DESKTOP_LOG_MAX_BYTES } from "../src/desktop-log.ts";

/**
 * O log do ciclo de saída existe para dar evidência à próxima ocorrência
 * intermitente (o stdout do pacote não é observável). Contratos:
 *   - escreve uma linha JSONL com data, evento e detalhes;
 *   - roda para `<ficheiro>.1` quando passa o teto (uma geração);
 *   - nunca lança e nunca rebenta o produto por falha de escrita.
 */

function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    existsSync: (p) => files.has(p),
    statSync: (p) => ({ size: files.get(p).length }),
    renameSync: (from, to) => {
      const value = files.get(from);
      files.delete(from);
      files.set(to, value);
    },
    rmSync: (p) => {
      files.delete(p);
    },
    mkdirSync: () => {},
    appendFileSync: (p, data) => {
      files.set(p, (files.get(p) ?? "") + data);
    },
  };
}

describe("desktop-log — evidência persistente do ciclo de saída", () => {
  it("acrescenta uma linha JSONL com data, evento e detalhes", () => {
    const fs = fakeFs();
    const when = new Date("2026-10-10T22:00:00.000Z");

    assert.equal(appendDesktopLog("C:/data/logs/exit.log", "quit-start", { service: true }, { fsImpl: fs, now: () => when }), true);

    const written = fs.files.get("C:/data/logs/exit.log");
    const line = JSON.parse(written.trim());
    assert.equal(line.event, "quit-start");
    assert.equal(line.service, true);
    assert.equal(line.at, when.toISOString());
  });

  it("roda para .1 quando o ficheiro excede o teto", () => {
    const big = "x".repeat(DESKTOP_LOG_MAX_BYTES + 1);
    const fs = fakeFs({ "C:/data/logs/exit.log": big, "C:/data/logs/exit.log.1": "antigo" });

    appendDesktopLog("C:/data/logs/exit.log", "renderer-gone", {}, { fsImpl: fs });

    assert.equal(fs.files.get("C:/data/logs/exit.log.1"), big, "a geração anterior fica no .1");
    const line = JSON.parse(fs.files.get("C:/data/logs/exit.log").trim());
    assert.equal(line.event, "renderer-gone");
  });

  it("falha de escrita não lança (devolve false)", () => {
    const fs = fakeFs();
    fs.appendFileSync = () => {
      throw new Error("disco cheio");
    };

    assert.equal(appendDesktopLog("C:/data/logs/exit.log", "quit-start", {}, { fsImpl: fs }), false);
  });
});
