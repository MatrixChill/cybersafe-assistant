import {
  PC_THERMAL_BANDS,
  PC_THERMAL_BAND_NOTE,
  PC_USAGE_BANDS,
  pcThermalBand,
  pcUsageBand,
  type PcThermalDevice,
  type PcUsageBand,
  type PcUsageMetric,
} from "@cybersafe/shared-types";

/**
 * Cor de utilização/temperatura, derivada das MESMAS bandas com que o motor de
 * saúde emite achados (`shared-types: PC_USAGE_BANDS`, lido por `pcstate.ts`).
 * Não há aqui nenhum limiar novo: este ficheiro só traduz uma banda num nome de
 * classe, para que a cor não possa discordar da palavra.
 *
 * O defeito que isto fecha: o Dashboard coloria RAM a partir de 75 %, o cartão
 * do PC Center a partir de 60 % e o disco a partir de 85 %, enquanto o motor só
 * dava «atenção» a partir de 90 % — o mesmo número medido tinha três cores
 * diferentes na mesma aplicação. E temperatura em °C era comparada com limiares
 * de percentagem.
 *
 * Regras:
 *  · `null` (não medido) nunca recebe cor de saúde: vai para neutro e o
 *    chamador diz o estado por letras;
 *  · `workload` (utilização de GPU) também nunca recebe cor de saúde: é
 *    trabalho, não doença — uma RX 5600 XT a 99 % está a fazer o que se lhe
 *    pediu. Quem o decide é o contrato (`pcUsageBand` devolve `null` para uma
 *    métrica sem limiares), não esta camada, para que nenhuma outra superfície
 *    possa ler `ok` onde não há saúde;
 *  · a banda térmica é uma referência genérica de apresentação; `notaTermica`
 *    acompanha o número para a cor não ser lida como diagnóstico.
 */

const TEXTO: Record<PcUsageBand, string> = {
  ok: "text-cyber-green",
  watch: "text-cyber-yellow",
  alert: "text-cyber-red",
};

const FUNDO: Record<PcUsageBand, string> = {
  ok: "bg-cyber-green",
  watch: "bg-cyber-yellow",
  alert: "bg-cyber-red",
};

const NEUTRO_TEXTO = "text-muted-foreground";
const NEUTRO_FUNDO = "bg-muted-foreground";

/** Métricas cujo texto nunca é linguagem de saúde, mesmo sem limiares. */
const SO_TRABALHO: ReadonlySet<PcUsageMetric> = new Set(["workload"]);

export function classeDeUso(metric: PcUsageMetric, percent: number | null | undefined): string {
  const banda = pcUsageBand(metric, percent);
  return banda ? TEXTO[banda] : NEUTRO_TEXTO;
}

export function fundoDeUso(metric: PcUsageMetric, percent: number | null | undefined): string {
  const banda = pcUsageBand(metric, percent);
  return banda ? FUNDO[banda] : NEUTRO_FUNDO;
}

/** «elevado — a partir de 80 %». A cor vem sempre acompanhada da razão. */
export function motivoDeUso(metric: PcUsageMetric, percent: number | null | undefined): string {
  if (SO_TRABALHO.has(metric)) return "carga de trabalho, não um indicador de saúde";
  if (typeof percent !== "number" || !Number.isFinite(percent)) return "sem leitura deste indicador";
  const limiar = PC_USAGE_BANDS[metric];
  if (pcUsageBand(metric, percent) === "alert" && limiar.alert !== null) {
    return `muito utilizado — a partir de ${limiar.alert} %`;
  }
  if (pcUsageBand(metric, percent) === "watch" && limiar.watch !== null) {
    return `elevado — a partir de ${limiar.watch} %`;
  }
  return "normal";
}

export function classeTermica(device: PcThermalDevice, celsius: number | null | undefined): string {
  const banda = pcThermalBand(device, celsius);
  return banda ? TEXTO[banda] : NEUTRO_TEXTO;
}

export function motivoTermico(device: PcThermalDevice, celsius: number | null | undefined): string {
  const banda = pcThermalBand(device, celsius);
  if (!banda) return "sem leitura de temperatura";
  const limiar = PC_THERMAL_BANDS[device];
  if (banda === "alert") return `possível sobreaquecimento — acima de ${limiar.alert} °C`;
  if (banda === "watch") return `quente — acima de ${limiar.watch} °C`;
  return "dentro da banda genérica de apresentação";
}

/** Nota obrigatória junto a qualquer cor térmica. */
export const notaTermica = PC_THERMAL_BAND_NOTE;
