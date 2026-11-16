/**
 * Origem das leituras de hardware, dita pela plataforma publicada pelo serviço
 * (`hardware.system.platform`, ver `platformTruth`).
 *
 * Porque existe: o PC Center escrevia «Leitura do Windows», «o Windows não
 * devolveu…» e «Contadores de desempenho do Windows (PDH)» também numa máquina
 * Linux. Em Linux só se nomeiam fontes reais (kernel via /sys e /proc,
 * lm-sensors, serviço CyberSafe). Em Windows — e em plataforma não publicada —
 * o texto histórico mantém-se exatamente igual: esta camada não muda a UI
 * Windows.
 */
import { plataformaPublicada } from "./platformTruth";

const isLinux = (plataforma: string | null | undefined) => plataformaPublicada(plataforma) === "linux";

/** Linha de proveniência da temperatura do CPU com valor presente. */
export function cpuTemperatureProvenance(plataforma: string | null | undefined, stale: boolean): string {
  if (stale) return "Última leitura guardada";
  return isLinux(plataforma) ? "Sensores do kernel Linux (hwmon / lm-sensors)" : "Leitura do Windows";
}

/** Explicação quando não há temperatura. */
export function temperatureUnavailableHint(plataforma: string | null | undefined, windowsHint: string): string {
  return isLinux(plataforma)
    ? "O kernel Linux não expôs um sensor de temperatura legível (hwmon / lm-sensors)."
    : windowsHint;
}

/** Motivo por omissão quando o armazenamento não tem leitura e o serviço não disse porquê. */
export function diskNoReadReason(plataforma: string | null | undefined): string {
  return isLinux(plataforma)
    ? "O sistema não devolveu uma leitura do armazenamento (/proc/self/mountinfo)."
    : "O Windows não devolveu uma leitura do armazenamento.";
}

/** Fonte da atividade de disco; `null` em Linux, onde esta versão não a mede. */
export function diskActivitySource(plataforma: string | null | undefined, windowsSource: string): string | null {
  return isLinux(plataforma) ? null : windowsSource;
}

/**
 * Texto curto quando não há atividade de disco em Linux. O motivo técnico do
 * motor (ex.: `ffi-indisponivel`) não vai para a UI principal.
 */
export function diskActivityUnavailableLinux(plataforma: string | null | undefined): string | null {
  return isLinux(plataforma) ? "Atividade de disco não medida nesta versão para Linux." : null;
}
