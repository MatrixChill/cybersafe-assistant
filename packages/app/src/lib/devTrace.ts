/**
 * `devTrace.ts` — metadados de observabilidade DOM, DEV-only, derivados SÓ do que está a ser
 * mostrado. Preparado por qoder em cópia isolada (TP-UI-TRACE-REAUTHOR, FASE B); ainda NÃO
 * aplicado no servido.
 *
 * Porque existe: para ligar o número pintado no ecrã à linha `[ipc-timing]` do main, sem
 * tocar no poll, nos refs, na lógica de cache nem no tempo de render.
 *
 * Regras que este ficheiro não pode quebrar:
 * - `dev: false` ⇒ objecto vazio. Sem flag, sem atributos, sem custo, mesmo em produção.
 * - Nenhum valor é inventado nem forçado: `connected` vem do propag, `origin` vem do
 *   `dataOrigin` já calculado, os números vêm do `hardware` que a página pinta.
 * - Nada de `useMemo` sobre refs: quem chama passa o valor do commit actual.
 * - Nada de `Date.now()` obrigatório: o relógio de render é opt-in pelo chamador e o instante
 *   observado é do CDP, não daqui.
 * - Allowlist fechada: timestamp ISO, enum de origem, conexão, geração e números CPU/RAM.
 *   Sem dump de objecto, sem PII, sem hostname, sem caminhos, sem nomes de processo.
 * - `0` é um valor válido e é emitido. `NaN`, `Infinity`, negativos em percentagens e `null`
 *   são omitidos, não convertidos em zero.
 */

/** Estado de ligação real do serviço, lido no mesmo commit que pinta a amostra. */
export type DevTraceConnection = {
  connected: boolean | null;
  generation: number;
};

/** Parte do `HardwareSnapshot` que este helper lê. Estrutural, para ser testável sem tipo global. */
export type DevTraceHardware = {
  timestamp?: string | null;
  cpu?: { usage?: number | null; temperature?: number | null } | null;
  ram?: { usedGb?: number | null; totalGb?: number | null; usagePercent?: number | null } | null;
} | null;

/**
 * Nomes de atributo EMITIDOS por este helper. A ordem não interessa; o que importa é que o
 * teste do leitor (`runner/lib-dom-observer.test.mjs`) extrai esta lista do fonte e exige
 * que cada nome passe na allowlist do observador. Renomear aqui sem actualizar lá ⇒ teste
 * falha, e é exactamente esse o objectivo.
 */
export const DEV_TRACE_ATTRS = [
  "data-cs-hw-ts",
  "data-cs-hw-origin",
  "data-cs-hw-conn",
  "data-cs-hw-generation",
  "data-cs-hw-cpu",
  "data-cs-hw-cpu-temp",
  "data-cs-hw-ram-used",
  "data-cs-hw-ram-total",
  "data-cs-hw-ram-pct",
] as const;

/** Origens que o produto já usa (`SurfaceDataOrigin` sem DEMO para o PC Center). */
const ORIGIN_OK = new Set(["LIVE", "CACHED", "UNAVAILABLE"]);

function finiteOuNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Devolve os atributos a espalhar no root do PC Center. Vazio quando `dev` é falso — é o único
 * interruptor, e é explícito de propósito para o teste poder provar os dois lados sem ambiente.
 */
export function devHwTraceAttrs(args: {
  dev: boolean;
  hardware: DevTraceHardware;
  origin?: string | null;
  connection?: DevTraceConnection | null;
}): Record<string, string> {
  if (!args.dev) return {};
  const out: Record<string, string> = {};
  const hw = args.hardware;

  // conexão: sempre presente, porque «desconhecido» é informação, não ausência.
  const c = args.connection;
  const conn = c ? c.connected : null;
  out["data-cs-hw-conn"] = conn === true ? "true" : conn === false ? "false" : "unknown";

  if (c && Number.isInteger(c.generation) && c.generation >= 0) {
    out["data-cs-hw-generation"] = String(c.generation);
  }

  if (hw && typeof hw.timestamp === "string" && Number.isFinite(Date.parse(hw.timestamp))) {
    out["data-cs-hw-ts"] = hw.timestamp;
  }

  if (typeof args.origin === "string" && ORIGIN_OK.has(args.origin)) {
    out["data-cs-hw-origin"] = args.origin;
  }

  const pct = (v: unknown) => {
    const n = finiteOuNull(v);
    return n !== null && n >= 0 ? String(n) : null;
  };
  const gb = pct;
  // Temperatura é a única métrica onde um negativo pode ser leitura verdadeira; não a cortamos.
  const temp = finiteOuNull(hw?.cpu?.temperature);

  const cpu = pct(hw?.cpu?.usage);
  if (cpu !== null) out["data-cs-hw-cpu"] = cpu;
  if (temp !== null) out["data-cs-hw-cpu-temp"] = String(temp);
  const used = gb(hw?.ram?.usedGb);
  if (used !== null) out["data-cs-hw-ram-used"] = used;
  const total = gb(hw?.ram?.totalGb);
  if (total !== null) out["data-cs-hw-ram-total"] = total;
  const ramPct = pct(hw?.ram?.usagePercent);
  if (ramPct !== null) out["data-cs-hw-ram-pct"] = ramPct;

  return out;
}
