import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_PC_STATE_CONFIG } from "../dist/index.js";
import { PC_USAGE_BANDS, pcUsageBand } from "@cybersafe/shared-types";

/**
 * Uma só autoridade para os limiares de utilização (§2.8).
 *
 * Antes, o mesmo número vivia em três sítios: `pcstate.ts` (90 / 80 / 75 /
 * livre<10 / livre<20), o Dashboard (RAM 75/90, disco 85/95) e o PC Center
 * (60/85 para tudo). Nada obrigava os três a concordar, por isso discordavam: a
 * cor amarela aparecia onde o motor não dava nenhum achado, e o utilizador via
 * «atenção» sem que houvesse motivo escrito.
 *
 * Estes testes não provam comportamento do motor (isso já está em
 * `pcstate.test.js` e `pcstate-measurement-honesty.test.js`): provam que a
 * configuração do motor É `PC_USAGE_BANDS`, e que deixou de haver números à mão
 * para poderem voltar a divergir em silêncio.
 */

test("DEFAULT_PC_STATE_CONFIG deriva de PC_USAGE_BANDS, não de literais", () => {
  assert.equal(DEFAULT_PC_STATE_CONFIG.ramAttentionPercent, PC_USAGE_BANDS.ram.alert);
  assert.equal(DEFAULT_PC_STATE_CONFIG.ramRecommendedPercent, PC_USAGE_BANDS.ram.watch);
  assert.equal(DEFAULT_PC_STATE_CONFIG.cpuAttentionPercent, PC_USAGE_BANDS.cpu.alert);
  assert.equal(DEFAULT_PC_STATE_CONFIG.cpuRecommendedPercent, PC_USAGE_BANDS.cpu.watch);
  // O motor pensa em PERCENTAGEM LIVRE; a banda pensa em utilizada. A
  // conversão é 100 - banda, e é aqui que fica presa.
  assert.equal(DEFAULT_PC_STATE_CONFIG.diskAttentionFreePercent, 100 - PC_USAGE_BANDS.disk.alert);
  assert.equal(DEFAULT_PC_STATE_CONFIG.diskRecommendedFreePercent, 100 - PC_USAGE_BANDS.disk.watch);
});

test("as fronteiras do motor coincidem com a banda de apresentação", () => {
  const { ramAttentionPercent: alerta, ramRecommendedPercent: sugestao } = DEFAULT_PC_STATE_CONFIG;
  assert.equal(pcUsageBand("ram", sugestao - 1), "ok");
  assert.equal(pcUsageBand("ram", sugestao), "watch");
  assert.equal(pcUsageBand("ram", alerta - 1), "watch");
  assert.equal(pcUsageBand("ram", alerta), "alert");

  const discoAlerta = 100 - DEFAULT_PC_STATE_CONFIG.diskAttentionFreePercent;
  const discoSugestao = 100 - DEFAULT_PC_STATE_CONFIG.diskRecommendedFreePercent;
  assert.equal(pcUsageBand("disk", discoSugestao - 1), "ok");
  assert.equal(pcUsageBand("disk", discoSugestao), "watch");
  assert.equal(pcUsageBand("disk", discoAlerta), "alert");
});

test("pcstate.ts já não escreve os limiares à mão", () => {
  const fonte = readFileSync(new URL("../src/pcstate.ts", import.meta.url), "utf8");
  const bloco = fonte.slice(fonte.indexOf("DEFAULT_PC_STATE_CONFIG"));
  for (const campo of [
    "ramAttentionPercent",
    "ramRecommendedPercent",
    "cpuAttentionPercent",
    "cpuRecommendedPercent",
    "diskAttentionFreePercent",
    "diskRecommendedFreePercent",
  ]) {
    const linha = bloco.match(new RegExp(`${campo}:([^,\\n]*),`));
    assert.ok(linha, `${campo} existe na configuração`);
    assert.match(linha[1], /PC_USAGE_BANDS/, `${campo} tem de derivar das bandas`);
    // O único número permitido é o 100 da conversão «livre → utilizada»; um
    // limiar escrito aqui volta a poder divergir da cor em silêncio.
    const semConversao = linha[1].replace(/100\s*-/g, "");
    assert.doesNotMatch(semConversao, /\d/, `${campo} voltou a ter um limiar à mão: ${linha[1].trim()}`);
  }
});
