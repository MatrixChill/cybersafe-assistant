/**
 * Uma só autoridade para as cores de utilização e de temperatura (§2.8).
 *
 * O defeito real, lido no código antes deste turno: os limiares estavam escritos à mão
 * em três sítios que não conversavam entre si — o Dashboard coloria a RAM a
 * partir de 75 % e o disco a partir de 85 %, o PC Center usava 60/85 para
 * TUDO (CPU, RAM, disco, score de stress e temperatura), e o motor de saúde só
 * dava «atenção» a partir de 90 %. O mesmo número medido tinha três cores
 * diferentes na mesma aplicação, e a cor não tinha relação com o achado que o
 * utilizador podia ler abaixo. Por cima disso, °C era comparado com limiares de
 * percentagem: uma GPU aos 60 °C saía pintada como se estivesse doente.
 *
 * Este ficheiro fixa três coisas:
 *  · as fronteiras de cada banda, nos números que o motor usa;
 *  · que a ausência de leitura e a carga de trabalho não têm cor de saúde;
 *  · que os dois ecrãs já não escrevem limiares à mão (lock por texto-fonte,
 *    porque um regresso silencioso do literal é exatamente o defeito).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PC_THERMAL_BANDS,
  PC_USAGE_BANDS,
  pcThermalBand,
  pcUsageBand,
} from "@cybersafe/shared-types";
import {
  classeDeUso,
  classeTermica,
  fundoDeUso,
  motivoDeUso,
  motivoTermico,
  notaTermica,
} from "../src/lib/healthBands";

const VERDE = "text-cyber-green";
const AMARELO = "text-cyber-yellow";
const VERMELHO = "text-cyber-red";
const NEUTRO_TEXTO = "text-muted-foreground";
const NEUTRO_FUNDO = "bg-muted-foreground";

describe("bandas de utilização: fronteiras exatas", () => {
  test("ram: watch no limiar, alert no limiar, nada abaixo", () => {
    assert.equal(classeDeUso("ram", 0), VERDE);
    assert.equal(classeDeUso("ram", PC_USAGE_BANDS.ram.watch! - 1), VERDE);
    assert.equal(classeDeUso("ram", PC_USAGE_BANDS.ram.watch), AMARELO);
    assert.equal(classeDeUso("ram", PC_USAGE_BANDS.ram.alert! - 1), AMARELO);
    assert.equal(classeDeUso("ram", PC_USAGE_BANDS.ram.alert), VERMELHO);
    assert.equal(classeDeUso("ram", 100), VERMELHO);
  });

  test("cpu e disco seguem a mesma autoridade, com os seus números", () => {
    assert.equal(classeDeUso("cpu", 74), VERDE);
    assert.equal(classeDeUso("cpu", 75), AMARELO);
    assert.equal(classeDeUso("cpu", 89), AMARELO);
    assert.equal(classeDeUso("cpu", 90), VERMELHO);
    assert.equal(classeDeUso("disk", 79), VERDE);
    assert.equal(classeDeUso("disk", 80), AMARELO);
    assert.equal(classeDeUso("disk", 90), VERMELHO);
  });

  test("stress: banda própria (60/85), não a banda da RAM", () => {
    assert.equal(classeDeUso("stress", 59), VERDE);
    assert.equal(classeDeUso("stress", 60), AMARELO);
    assert.equal(classeDeUso("stress", 84), AMARELO);
    assert.equal(classeDeUso("stress", 85), VERMELHO);
  });

  test("os números da interface são os números do contrato", () => {
    for (const metric of ["cpu", "ram", "disk", "stress"] as const) {
      const banda = PC_USAGE_BANDS[metric];
      assert.equal(pcUsageBand(metric, banda.watch as number), "watch", metric);
      assert.equal(pcUsageBand(metric, banda.alert as number), "alert", metric);
      assert.equal(pcUsageBand(metric, (banda.watch as number) - 1), "ok", metric);
    }
  });
});

describe("ausência de leitura e carga de trabalho não têm cor de saúde", () => {
  test("null, undefined e NaN nunca ficam verde (o defeito era pintá-los)", () => {
    for (const valor of [null, undefined, NaN]) {
      assert.equal(classeDeUso("ram", valor as number | null | undefined), NEUTRO_TEXTO, String(valor));
      assert.equal(fundoDeUso("cpu", valor as number | null | undefined), NEUTRO_FUNDO, String(valor));
    }
  });

  test("workload (uso de GPU) é trabalho, não doença: 0 % e 99 % ficam neutros", () => {
    assert.equal(classeDeUso("workload", 0), NEUTRO_TEXTO);
    assert.equal(classeDeUso("workload", 99), NEUTRO_TEXTO);
    assert.equal(fundoDeUso("workload", 100), NEUTRO_FUNDO);
    // É o contrato que recusa a afirmação, não só esta camada: `ok` leria «saúde
    // normal» numa grandeza que não mede saúde, e qualquer outra superfície
    // herdaria essa mentira.
    assert.equal(pcUsageBand("workload", 99), null);
    assert.notEqual(pcUsageBand("workload", 99), "ok");
  });

  test("o fundo acompanha o texto métrica a métrica", () => {
    for (const [percent, esperado] of [[10, "ok"], [80, "watch"], [95, "alert"]] as const) {
      const texto = classeDeUso("ram", percent);
      const fundo = fundoDeUso("ram", percent);
      const mapa = { ok: [VERDE, "bg-cyber-green"], watch: [AMARELO, "bg-cyber-yellow"], alert: [VERMELHO, "bg-cyber-red"] } as const;
      assert.deepEqual([texto, fundo], mapa[esperado], `${percent}%`);
    }
  });
});

describe("temperatura em °C não usa a escala de percentagem", () => {
  test("gpu: 60 °C é normal — antes era pintado como «atenção»", () => {
    assert.equal(classeTermica("gpu", 60), VERDE);
    assert.equal(classeTermica("gpu", PC_THERMAL_BANDS.gpu.watch - 1), VERDE);
    assert.equal(classeTermica("gpu", PC_THERMAL_BANDS.gpu.watch), AMARELO);
    assert.equal(classeTermica("gpu", PC_THERMAL_BANDS.gpu.alert - 1), AMARELO);
    assert.equal(classeTermica("gpu", PC_THERMAL_BANDS.gpu.alert), VERMELHO);
  });

  test("cpu: 90 °C é alerta térmico, não 90 % de utilização", () => {
    assert.equal(classeTermica("cpu", 79), VERDE);
    assert.equal(classeTermica("cpu", 80), AMARELO);
    assert.equal(classeTermica("cpu", 94), AMARELO);
    assert.equal(classeTermica("cpu", 95), VERMELHO);
  });

  test("storage: banda mais baixa que a do processador", () => {
    assert.equal(classeTermica("storage", 54), VERDE);
    assert.equal(classeTermica("storage", 55), AMARELO);
    assert.equal(classeTermica("storage", 70), VERMELHO);
  });

  test("temperatura sem leitura fica neutra e diz que não há leitura", () => {
    assert.equal(classeTermica("cpu", null), NEUTRO_TEXTO);
    assert.equal(motivoTermico("cpu", null), "sem leitura de temperatura");
  });

  test("a banda térmica é sempre apresentada como genérica", () => {
    assert.match(notaTermica, /genérica/);
    assert.match(notaTermica, /não é exposto pelo sensor/);
  });
});

describe("cada cor vem com a razão escrita", () => {
  test("utilização diz a partir de quantos por cento", () => {
    assert.equal(motivoDeUso("ram", 85), "elevado — a partir de 80 %");
    assert.equal(motivoDeUso("ram", 92), "muito utilizado — a partir de 90 %");
    assert.equal(motivoDeUso("cpu", 10), "normal");
  });

  test("workload recusa a linguagem de saúde", () => {
    const texto = motivoDeUso("workload", 99);
    assert.match(texto, /carga de trabalho/);
    assert.doesNotMatch(texto, /a partir de/);
  });

  test("sem leitura não inventa um limiar", () => {
    assert.equal(motivoDeUso("disk", null), "sem leitura deste indicador");
  });

  test("térmico: nomeia sobreaquecimento só no alert", () => {
    assert.equal(motivoTermico("cpu", 96), "possível sobreaquecimento — acima de 95 °C");
    assert.equal(motivoTermico("gpu", 85), "quente — acima de 80 °C");
    assert.doesNotMatch(motivoTermico("gpu", 40), /sobreaquecimento/);
  });
});

describe("lock de texto-fonte: nenhum ecrã volta a escrever limiares à mão", () => {
  // Quem PINTA cor a partir de um número tem de ir buscar a escala a
  // `@/lib/healthBands`. São os únicos ficheiros com esta obrigação.
  const PINTAM_COR = [
    "../src/pages/PCCenterPage.tsx",
    "../src/components/PCHealthSection.tsx",
  ];
  // Migração V2-FIRST: o Painel deixou de pintar barras — a cadeia V2 mostra
  // VALORES através dos helpers canónicos de leitura. A obrigação passa a ser
  // (a) usar os helpers, (b) não escrever limiares/cor à mão, (c) não comparar
  // °C com %. O `@/lib/healthBands` continua exigido a quem colore.
  const CADEIA_PAINEL = [
    "../src/v2/dashboard/LabDashboard.tsx",
    "../src/v2/dashboard/LabDiagnostics.tsx",
  ];

  for (const url of PINTAM_COR) {
    test(`${url} lê as bandas partilhadas e não compara °C com %`, () => {
      const texto = readFileSync(new URL(url, import.meta.url), "utf8");
      assert.match(texto, /@\/lib\/healthBands/);
      assert.match(texto, /classeDeUso|classeTermica|fundoDeUso/);
      // literal de limiar a colorir: `>= 85 ? "text-cyber-…` ou `< 60) return "text-cyber-…`
      assert.doesNotMatch(texto, />=\s*\d+\s*\?\s*"text-cyber/);
      assert.doesNotMatch(texto, /<\s*\d+\s*\)\s*return\s*"text-cyber/);
      // Mesma forma para barras preenchidas: o Dashboard pinta `bg-cyber-*`, e
      // era exatamente por aí que os limiares locais continuavam vivos depois de
      // este lock existir — a regra só cobria texto.
      assert.doesNotMatch(texto, /<\s*\d+\s*\)\s*return\s*"bg-cyber/);
      assert.doesNotMatch(texto, />=\s*\d+\s*\?\s*"bg-cyber/);
      assert.doesNotMatch(texto, /getUsageColor\((cpu|gpu)Temperature/);
      assert.doesNotMatch(texto, /getUsageColor\(hardware\.(cpu|gpu)\.temperature/);
    });
  }

  for (const url of CADEIA_PAINEL) {
    test(`${url} não pinta cor nem limiar: mostra o valor do helper canónico`, () => {
      const texto = readFileSync(new URL(url, import.meta.url), "utf8");
      assert.doesNotMatch(texto, /@\/lib\/healthBands/, "a cor do Painel V2 não se decide aqui");
      assert.doesNotMatch(texto, /text-cyber-|bg-cyber-|getUsageColor/, "limiar ou cor local no Painel");
      assert.doesNotMatch(texto, />=\s*\d+\s*\?[\s\S]{0,20}"|<\s*\d+\s*\)[\s\S]{0,20}return\s*"/, "cor por limiar literal");
      if (url.includes("LabDiagnostics")) {
        // Os números vêm dos helpers que já tratam de `null` ≠ `0`.
        assert.match(texto, /cpuUsageDisplay/);
        assert.match(texto, /ramUsageDisplay/);
        assert.match(texto, /networkReadingDisplay/);
        assert.doesNotMatch(texto, /temperature[\s\S]{0,80}%/, "temperatura não se compara com percentagem");
      }
    });
  }

  test("a exceção é assumida: a carga de bateria (<20 / <50) continua local", () => {
    // Deliberadamente fora deste unidade: «bateria fraca» é um estado de energia
    // com semântica própria, não uma banda de utilização de hardware; e o
    // computador de referência é desktop, sem bateria. Fica registado aqui para
    // que a exceção seja uma decisão, não um esquecimento.
    const texto = readFileSync(new URL("../src/pages/PCCenterPage.tsx", import.meta.url), "utf8");
    assert.match(texto, /percent < 20 \? "text-cyber-red"/);
  });
});
