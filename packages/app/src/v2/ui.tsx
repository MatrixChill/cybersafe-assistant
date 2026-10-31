/**
 * Primitivas V2 — as peças de `v2/src/ui.tsx` do lab, ligadas ao produto.
 *
 * O que muda face ao lab é só a origem dos dados: nenhum componente aqui conhece
 * `demo.ts`, `EngineState` ou cenários. Um `Badge` recebe um TOM e o TEXTO que o
 * serviço disse; quem traduz estado do produto em tom é a página, porque só a
 * página sabe se a leitura foi confirmada.
 */
import { useEffect, useId, useRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AlertTriangle, ArrowUpRight, Check, Minus, X, LoaderCircle, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** Os cinco papéis do produto. `proc` é procedimento (ciano); `na` é não medido. */
export type V2Tone = "ok" | "warn" | "crit" | "proc" | "na";

const TONE_ICON: Record<V2Tone, typeof Check> = {
  ok: Check,
  warn: AlertTriangle,
  crit: X,
  proc: LoaderCircle,
  na: Minus,
};

export function Button({
  children,
  variant = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
}) {
  return (
    <button type="button" className={cn("button", variant, className)} {...props}>
      {children}
    </button>
  );
}

export function Badge({ tone, children }: { tone: V2Tone; children: ReactNode }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={cn("badge", `tone-${tone}`)}>
      <Icon size={12} aria-hidden="true" />
      {children}
    </span>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("panel", className)}>{children}</section>;
}

export function SectionTitle({
  title,
  detail,
  onLink,
  linkLabel = "Ver detalhes",
}: {
  title: string;
  detail?: string;
  /** A página decide para onde se vai; a primitiva não conhece rotas. */
  onLink?: () => void;
  linkLabel?: string;
}) {
  return (
    <div className="section-title">
      <div>
        <h2>{title}</h2>
        {detail ? <p>{detail}</p> : null}
      </div>
      {onLink ? (
        <button type="button" className="text-link" onClick={onLink}>
          {linkLabel}
          <ArrowUpRight size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function PageHead({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        {/* O foco vai para aqui quando a rota muda (o lab faz `main h1` focus). */}
        <h1 tabIndex={-1}>{title}</h1>
        <p>{description}</p>
      </div>
      {children ? <div className="head-actions">{children}</div> : null}
    </header>
  );
}

export function Chart({
  values,
  label,
  large = false,
}: {
  values: number[];
  label: string;
  large?: boolean;
}) {
  const id = useId().replaceAll(":", "");
  const width = 600;
  const height = large ? 170 : 65;
  if (values.length < 2) {
    // Uma amostra não é uma série: desenhar uma linha com um ponto afirmaria
    // uma evolução que ninguém mediu.
    return (
      <p className="caption" role="status">
        {label}: ainda sem série suficiente para desenhar ({values.length} leitura).
      </p>
    );
  }
  const points = values
    .map((v, i) => `${(i * width) / (values.length - 1)},${height - 8 - (Math.max(0, Math.min(100, v)) / 100) * (height - 16)}`)
    .join(" ");
  return (
    <svg
      className={cn("chart", large && "large")}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity=".2" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {large
        ? [0.25, 0.5, 0.75].map((y) => (
            <line
              key={y}
              x1="0"
              x2={width}
              y1={height * y}
              y2={height * y}
              stroke="currentColor"
              strokeOpacity=".12"
              strokeDasharray="3 5"
            />
          ))
        : null}
      <polygon points={`0,${height} ${points} ${width},${height}`} fill={`url(#${id})`} />
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog-head">
        <h2 id={id}>{title}</h2>
        <Button onClick={onClose} variant="ghost" aria-label="Fechar diálogo">
          <X size={18} />
        </Button>
      </div>
      {children}
    </dialog>
  );
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <Minus size={36} aria-hidden="true" />
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

export function RowLink({
  title,
  detail,
  onSelect,
}: {
  title: string;
  detail: string;
  onSelect: () => void;
}) {
  return (
    <button type="button" className="row-link" onClick={onSelect}>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      <ChevronRight size={18} aria-hidden="true" />
    </button>
  );
}

export function Metric({
  label,
  value,
  unit,
  values,
  detail,
}: {
  label: string;
  value: string;
  unit?: string;
  values: number[];
  detail?: string;
}) {
  return (
    <Panel className="metric">
      <div className="metric-label">
        {label}
        <ArrowUpRight size={14} aria-hidden="true" />
      </div>
      <div className="metric-value">
        {value}
        {unit ? <span>{unit}</span> : null}
      </div>
      <Chart values={values} label={label} />
      {detail ? <p>{detail}</p> : null}
    </Panel>
  );
}
