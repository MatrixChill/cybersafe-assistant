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
      <svg width={width} height={height} className="overflow-visible">
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
  keyRef.current = key;

  useEffect(() => {
    const timer = setInterval(() => {
      setSamples([...getTelemetrySamples(keyRef.current)]);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return samples;
}
