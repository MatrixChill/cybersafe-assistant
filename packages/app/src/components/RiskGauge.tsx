import { useEffect, useState } from "react";

interface RiskGaugeProps {
  score: number;
}

export default function RiskGauge({ score }: RiskGaugeProps) {
  const [animated, setAnimated] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setAnimated(score), 100);
    return () => clearTimeout(timer);
  }, [score]);

  const radius = 70;
  const cx = 90;
  const cy = 90;
  const startAngle = 180;
  const endAngle = 360;
  const totalAngle = endAngle - startAngle;

  function polarToCartesian(angleDeg: number) {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
  }

  function arcPath(start: number, end: number) {
    const s = polarToCartesian(start);
    const e = polarToCartesian(end);
    const largeArc = end - start > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${radius} ${radius} 0 ${largeArc} 1 ${e.x} ${e.y}`;
  }

  const circumference = (Math.PI * radius * totalAngle) / 180;
  const offset = circumference * (1 - animated / 100);

  let gaugeColor: string;
  if (animated >= 80) gaugeColor = "var(--severity-low)";
  else if (animated >= 50) gaugeColor = "var(--severity-medium)";
  else if (animated >= 25) gaugeColor = "var(--severity-high)";
  else gaugeColor = "var(--severity-critical)";

  let statusLabel: string;
  if (animated >= 80) statusLabel = "Seguro";
  else if (animated >= 50) statusLabel = "Moderado";
  else if (animated >= 25) statusLabel = "Risco alto";
  else statusLabel = "Crítico";

  return (
    <div className="gauge-container">
      <svg className="gauge-svg" viewBox="0 0 180 110">
        <path d={arcPath(startAngle, endAngle)} className="gauge-track" />
        <path
          d={arcPath(startAngle, endAngle)}
          className="gauge-fill"
          stroke={gaugeColor}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
        <text x={cx} y={cy - 5} textAnchor="middle" className="gauge-score">
          {animated}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" className="gauge-label">
          {statusLabel}
        </text>
      </svg>
    </div>
  );
}
