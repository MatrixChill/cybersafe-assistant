import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DefinitionUpdater,
  recuperacaoYaraPermitida,
} from "../dist/updater.js";
import { WINDOWS_READONLY_ENV } from "../dist/dev-windows-readonly.js";
import { FIXTURE_SCAN_FLAG } from "../dist/dev-fixture-gate.js";

/**
 * RC22-ENGINES — GUARDA DA RECUPERAÇÃO YARA NO ARRANQUE.
 *
 * Achado da revisão: o recovery que o patch YARA corre no `init` faz rede e
 * escreve no directório de definições. Em `CYBERSAFE_DEV_WINDOWS_READONLY=1`
 * (lane sobre Windows real, só leitura) e em `CYBERSAFE_REALDEV_FIXTURE_SCAN=1`
 * (fixture controlada) isso é proibido, e o patch original não tinha guarda.
 *
 * O que este ficheiro prova, executado (não por leitura): nos dois modos
 * `updateYaraRules` — a função que faz a rede/escrita — é chamada ZERO vezes e
 * `refreshYaraCorpus` devolve `false`; no modo normal é chamada UMA vez. O spy
 * substitui `updateYaraRules` no objecto (nenhum I/O real acontece), portanto a
 * medida é sobre a decisão do guard, não sobre a rede.
 */

const temporarios = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-rc22-guard-"));
  temporarios.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of temporarios) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

async function medirChamadas() {
  const updater = new DefinitionUpdater(tmpdir(), {});
  let chamadas = 0;
  // Spy: a recuperação só pode chegar aqui quando o modo o permite.
  updater.updateYaraRules = async () => {
    chamadas += 1;
    return { errors: [], warnings: [] };
  };
  const resultado = await updater.refreshYaraCorpus();
  return { chamadas, resultado };
}

async function comEnv(vars, fn) {
  const chaves = [WINDOWS_READONLY_ENV, FIXTURE_SCAN_FLAG];
  const anterior = {};
  for (const chave of chaves) anterior[chave] = process.env[chave];
  try {
    for (const chave of chaves) delete process.env[chave];
    for (const [chave, valor] of Object.entries(vars)) process.env[chave] = valor;
    return await fn();
  } finally {
    for (const chave of chaves) {
      if (anterior[chave] === undefined) delete process.env[chave];
      else process.env[chave] = anterior[chave];
    }
  }
}

describe("RC22 guarda do recovery YARA — read-only e fixture não fazem rede/escrita", () => {
  test("contrato do predicado: só o modo normal permite", () => {
    assert.equal(recuperacaoYaraPermitida({}), true);
    assert.equal(recuperacaoYaraPermitida({ [WINDOWS_READONLY_ENV]: "1" }), false);
    assert.equal(recuperacaoYaraPermitida({ [FIXTURE_SCAN_FLAG]: "1" }), false);
    assert.equal(
      recuperacaoYaraPermitida({ [WINDOWS_READONLY_ENV]: "1", [FIXTURE_SCAN_FLAG]: "1" }),
      false,
    );
    assert.equal(recuperacaoYaraPermitida({ [WINDOWS_READONLY_ENV]: "0" }), true);
  });

  test("CYBERSAFE_DEV_WINDOWS_READONLY=1 => refreshYaraCorpus não chama updateYaraRules", async () => {
    const { chamadas, resultado } = await comEnv({ [WINDOWS_READONLY_ENV]: "1" }, medirChamadas);
    assert.equal(chamadas, 0, "modo read-only não pode fazer rede nem escrever definições");
    assert.equal(resultado, false);
  });

  test("CYBERSAFE_REALDEV_FIXTURE_SCAN=1 => refreshYaraCorpus não chama updateYaraRules", async () => {
    const { chamadas, resultado } = await comEnv({ [FIXTURE_SCAN_FLAG]: "1" }, medirChamadas);
    assert.equal(chamadas, 0, "modo fixture não pode substituir o corpus por download");
    assert.equal(resultado, false);
  });

  test("controlo normal (sem flags) => refreshYaraCorpus chama updateYaraRules uma vez", async () => {
    const { chamadas, resultado } = await comEnv({}, medirChamadas);
    assert.equal(chamadas, 1);
    assert.equal(resultado, true);
  });
});
