import { useRef, useEffect, useState } from "react"

export interface TelemetrySample {
  value: number;
  timestamp: number;
}

interface TelemetrySparklineProps {
  samples: TelemetrySample[];
  max?: number;
  color?: string;
  height?: number;
  width?: number;
  showArea?: boolean;
  label?: string;
  unit?: string;
  /**
   * Nome acessível do gráfico (leitor de ecrã). Distinto do `label` visível:
   * o rótulo curto («CPU») já aparece no cartão e repeti-lo não diz o que é o
   * desenho. Sem nome nenhum, o SVG tem de continuar a identificar-se — nunca
   * fica anónimo nem inventa uma métrica.
   */
  accessibleLabel?: string;
  /** Texto enquanto ainda não há amostras (estado inicial honesto). */
  emptyLabel?: string;
  /** Texto depois do prazo sem nenhuma amostra — nunca "a aguardar" eternamente. */
  unavailableLabel?: string;
  unavailableAfterMs?: number;
}

/** Estado inicial: ainda estamos a recolher (não inventamos valores). */
export const SPARKLINE_EMPTY_LABEL = "A recolher dados...";
/** Sem provider/valores dentro do prazo: o gráfico assume a ausência de dados. */
export const SPARKLINE_UNAVAILABLE_LABEL = "Sem dados disponíveis";
export const SPARKLINE_UNAVAILABLE_AFTER_MS = 15_000;
/**
 * Nome acessível de último recurso. Neutro de propósito: sem nome do chamador,
 * o gráfico declara que é telemetria — não se atreve a dizer que é CPU, RAM
 * ou rede.
 */
export const SPARKLINE_DEFAULT_ACCESSIBLE_NAME = "Histórico de telemetria";

export interface SparklineAccessibleNameInput {
  accessibleLabel?: string;
  label?: string;
  hasSamples: boolean;
  showUnavailable: boolean;
  emptyLabel?: string;
  unavailableLabel?: string;
}

/**
 * Nome acessível derivado dos FACTOS do componente.
 *
 *  · com amostras: só o nome da métrica — o valor atual já está no cartão, e
 *    repetir números no nome faria o leitor de ecrã anunciar cada actualização;
 *  · sem amostras: o nome + o estado real («A recolher dados...» ou «Sem dados
 *    disponíveis»), nunca um zero nem uma medição inventada;
 *  · sem nome do chamador: o neutro, nunca uma métrica escolhida por nós.
 */
export function getSparklineAccessibleName({
  accessibleLabel,
  label,
  hasSamples,
  showUnavailable,
  emptyLabel = SPARKLINE_EMPTY_LABEL,
  unavailableLabel = SPARKLINE_UNAVAILABLE_LABEL,
}: SparklineAccessibleNameInput): string {
  const nome = (accessibleLabel ?? label ?? "").trim() || SPARKLINE_DEFAULT_ACCESSIBLE_NAME;
  if (hasSamples) return nome;
  const estado = showUnavailable ? unavailableLabel : emptyLabel;
  return `${nome}: ${estado}`;
}

function getStats(samples: TelemetrySample[]): { min: number; max: number; avg: number; current: number } {
  if (samples.length === 0) return { min: 0, max: 0, avg: 0, current: 0 };
  const values = samples.map(s => s.value);
  const current = values[values.length - 1] ?? 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return { min, max, avg, current };
}

export function TelemetrySparkline({
  samples,
  max: propMax,
  color,
  height = 48,
  width = 200,
  showArea = true,
  label,
  unit,
  accessibleLabel,
  emptyLabel = SPARKLINE_EMPTY_LABEL,
  unavailableLabel = SPARKLINE_UNAVAILABLE_LABEL,
  unavailableAfterMs = SPARKLINE_UNAVAILABLE_AFTER_MS,
}: TelemetrySparklineProps) {
  const { current } = getStats(samples);
  const maxVal = propMax ?? Math.max(100, ...samples.map(s => s.value));
  const padding = 2;

  // Sem amostras: "a recolher" durante o prazo, depois assumimos indisponível
  // em vez de ficar eternamente a aguardar dados.
  const hasSamples = samples.length > 0;
  const [noDataForAWhile, setNoDataForAWhile] = useState(false);

  useEffect(() => {
    if (hasSamples) return;
    const timer = setTimeout(() => setNoDataForAWhile(true), unavailableAfterMs);
    return () => clearTimeout(timer);
  }, [hasSamples, unavailableAfterMs]);

  const showUnavailable = noDataForAWhile && !hasSamples;

  // Nome acessível: identifica o gráfico (métrica + estado real). Sem
  // `aria-live` — o gráfico não anuncia cada amostra nova.
  const accessibleName = getSparklineAccessibleName({
    accessibleLabel,
    label,
    hasSamples,
    showUnavailable,
    emptyLabel,
    unavailableLabel,
  });

  const buildPath = () => {
    if (samples.length < 2) return { line: "", area: "" };
    const w = width - padding * 2;
    const h = height - padding * 2;
    const points = samples.map((s, i) => {
      const x = padding + (i / (samples.length - 1)) * w;
      const y = padding + h - (s.value / maxVal) * h;
      return { x, y };
    });
    const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const area = `${line} L${points[points.length - 1].x.toFixed(1)},${height} L${points[0].x.toFixed(1)},${height} Z`;
    return { line, area };
  };

  const { line, area } = buildPath();

  return (
    <div className="flex flex-col gap-1">
      {(label || unit) && (
        <div className="flex items-baseline justify-between text-[10px] font-mono text-muted-foreground">
          {label && <span className="uppercase tracking-wider">{label}</span>}
          {unit && <span>{unit}</span>}
        </div>
      )}
      <svg
        width={width}
        height={height}
        className="overflow-visible"
        role="img"
        aria-label={accessibleName}
      >
        <title>{accessibleName}</title>
        {showArea && area && (
          <path d={area} fill={color || "var(--primary)"} opacity={0.1} />
        )}
        {line && (
          <path d={line} fill="none" stroke={color || "var(--primary)"} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        )}
        {samples.length > 0 && (
          <circle
            cx={padding + (width - padding * 2)}
            cy={padding + (height - padding * 2) - (current / maxVal) * (height - padding * 2)}
            r={2.5}
            fill={color || "var(--primary)"}
            className="animate-pulse"
          />
        )}
        {samples.length === 0 && (
          <text x={width / 2} y={height / 2} textAnchor="middle" className="fill-muted-foreground text-[10px] font-mono" dominantBaseline="middle">
            {showUnavailable ? unavailableLabel : emptyLabel}
          </text>
        )}
      </svg>
    </div>
  );
}

/** Central telemetry history buffer. Add samples in App, consume in cards. */
const MAX_SAMPLES = 60;
const buffers: Map<string, TelemetrySample[]> = new Map();

export function addTelemetrySample(key: string, value: number) {
  const buf = buffers.get(key) || [];
  buf.push({ value, timestamp: Date.now() });
  if (buf.length > MAX_SAMPLES) buf.splice(0, buf.length - MAX_SAMPLES);
  buffers.set(key, buf);
}

export function getTelemetrySamples(key: string): TelemetrySample[] {
  return buffers.get(key) || [];
}

export function useTelemetryHistory(key: string, intervalMs = 2000): TelemetrySample[] {
  const [samples, setSamples] = useState<TelemetrySample[]>(() => getTelemetrySamples(key));
  const keyRef = useRef(key);

  // Sincronizar a ref fora da render: só é lida dentro do timer abaixo.
  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  useEffect(() => {
    const timer = setInterval(() => {
      setSamples([...getTelemetrySamples(keyRef.current)]);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return samples;
}
