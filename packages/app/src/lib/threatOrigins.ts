/**
 * Origem de uma ameaça, para as estatísticas "Origens Web / Origens Locais".
 * Valores possíveis em ThreatEvent["source"] (shared-types). Ameaças do
 * Scanner (`system-scanner`) e do próprio serviço (`service`) são locais —
 * antes não eram contadas em nenhum cartão, embora a página Ameaças seja o
 * destino para onde o Scanner envia o utilizador.
 */
export type ThreatOrigin = "web" | "local";

const LOCAL_SOURCES = new Set(["dashboard", "download-monitor", "system-scanner", "service"]);

export function classifyThreatOrigin(source: unknown): ThreatOrigin | null {
  if (source === "extension") return "web";
  if (typeof source === "string" && LOCAL_SOURCES.has(source)) return "local";
  return null;
}
