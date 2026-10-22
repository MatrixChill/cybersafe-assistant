import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProtectionEngineService } from "../dist/engine.js";
import { WfpFilter } from "@cybersafe/native-windows";

/**
 * MAPEAMENTO do estado do filtro WFP para o que o pipe publica.
 *
 * O `wfp-state-truth.test.js` (native-windows) prova a máquina de estados da
 * classe. Este ficheiro prova o elo que estava em falta: que o `engine.ts`
 * publica ESSA origem em vez de achatar tudo em `isActive()`.
 *
 * Nada aqui toca o Windows: o executor do filtro é injectado, por isso não há
 * `New-`/`Set-`/`Remove-NetFirewallRule` reais, e `getProtectionState()` é
 * chamado sem `init()` — o `startProtection()` nunca corre, exactamente porque
 * o `start()` do filtro é uma operação privilegiada que o clique não dispara.
 */

const dirs = [];
async function motor() {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cybersafe-wfp-state-"));
  dirs.push(baseDir);
  const engine = new ProtectionEngineService(baseDir);
  return engine;
}

function executor({ falharCom = null } = {}) {
  const chamadas = [];
  return {
    chamadas,
    async executar(comando) {
      chamadas.push(String(comando));
      if (falharCom) throw Object.assign(new Error(falharCom), { name: "CommandFailed" });
      return { stdout: "", stderr: "" };
    },
  };
}

test.after(async () => {
  for (const d of dirs) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
});

describe("engine.wfp — a origem do estado chega ao pipe", () => {
  test("sem nenhuma tentativa: inativo, sem causa inventada", async () => {
    const engine = await motor();
    engine.wfpFilter = new WfpFilter({ executar: async () => ({}) });

    const bloco = engine.getProtectionState().engine.wfp;
    assert.equal(bloco.status, "unavailable");
    assert.equal(bloco.detail, "filtro WFP inativo");
    assert.equal(
      engine.getProtectionState().engine.firewall.detail,
      bloco.detail,
      "o alias `firewall` é o MESMO valor, nunca um segundo sentido",
    );
  });

  test("tentativa recusada: a causa sobrevive e o caminho pessoal não", async () => {
    const engine = await motor();
    engine.wfpFilter = new WfpFilter({
      executar: async () => {
        throw new Error("Acesso negado ao abrir C:\\Users\\caioc\\profile.txt");
      },
    });
    await engine.wfpFilter.start();

    const bloco = engine.getProtectionState().engine.wfp;
    assert.equal(bloco.status, "unavailable", "recusa não é um filtro ativo");
    assert.match(bloco.detail, /tentativa recusada/);
    assert.match(bloco.detail, /Acesso negado/, "a causa tem de chegar ao consumidor");
    assert.doesNotMatch(bloco.detail, /[A-Za-z]:[\\/](?:Users|users)[\\/]/i, "o detail vai ao ecrã");
  });

  test("comando bem-sucedido sem leitura de volta: NUNCA active", async () => {
    const engine = await motor();
    const exe = executor();
    engine.wfpFilter = new WfpFilter({ executar: exe.executar });
    await engine.wfpFilter.start();

    assert.equal(exe.chamadas.length, 1, "uma tentativa, um comando");
    const bloco = engine.getProtectionState().engine.wfp;
    assert.equal(bloco.status, "unavailable", "exit code não é uma observação do Windows");
    assert.match(bloco.detail, /estado não lido de volta/);
  });

  test("read-back verdadeiro é o único caminho para active", async () => {
    const engine = await motor();
    engine.wfpFilter = new WfpFilter({ executar: async () => ({}), verificar: async () => true });
    await engine.wfpFilter.start();

    const bloco = engine.getProtectionState().engine.wfp;
    assert.equal(bloco.status, "active");
    assert.equal(bloco.detail, "filtro WFP ativo");
  });
});
