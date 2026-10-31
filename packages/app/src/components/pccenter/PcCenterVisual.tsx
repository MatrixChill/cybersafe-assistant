import type { ReactNode } from "react";
import { Cpu, HardDrive, MemoryStick, Monitor, Thermometer } from "lucide-react";
import { cn } from "@/lib/utils";
import type { HardwareSnapshot, PcState } from "@cybersafe/shared-types";
import { cpuUsageDisplay } from "@/lib/cpuUsage";
import { ramUsageDisplay } from "@/lib/ramUsageDisplay";
import { networkReadingDisplay } from "@/lib/networkReadings";
import { temperatureDisplay } from "@/lib/temperature";
import { gpuPresence, GPU_ABSENT_LABEL, GPU_PENDING_LABEL } from "@/lib/gpuDisplay";
import { TelemetrySparkline, useTelemetryHistory } from "@/components/TelemetrySparkline";
import { leiturasDe, type HelpersLeitura, type LeituraTemperatura, type LeiturasResolvidas } from "@/lib/pccenter/explanations";
import { SECOES_VISUAIS, secoesPorModo } from "@/lib/pccenter/visualMap";

export type ModoVisual = "simples" | "avancado";
export type OrigemDados = "LIVE" | "CACHED" | "UNAVAILABLE";

interface PcCenterVisualProps {
  hardware: HardwareSnapshot | null;
  pcState?: PcState | null;
  dataOrigin?: OrigemDados;
  modo?: ModoVisual;
  /** Vistas originais (SimpleView/AdvancedView): o port NÃO as substitui. */
  children?: ReactNode;
}

const HELPERS: HelpersLeitura = {
  cpuUsage: (cpu) => cpuUsageDisplay(cpu as never),
  ramUsage: (ram) => ramUsageDisplay(ram as never),
  rede: (rede) => networkReadingDisplay(rede as never),
  temperatura: (valor) => temperatureDisplay(valor),
  presencia: (gpu) => gpuPresence(gpu as never),
};

/** Badges em PT-PT — nunca os estados internos em inglês. */
const ETIQUETA: Record<string, string> = {
  available: "medido",
  stale: "cache",
  unavailable: "indisponível",
  pending: "a ler",
  waiting: "a recolher",
  present: "detetada",
  absent: "não detetada",
  error: "erro de leitura",
  unconfirmed: "não confirmado",
};

function tomDe(estado: string): "ok" | "cache" | "unknown" {
  if (estado === "available" || estado === "present") return "ok";
  if (estado === "stale") return "cache";
  return "unknown";
}

function Etiqueta({ estado }: { estado: string }) {
  const tom = tomDe(estado);
  return (
    <span className={cn(
      "rounded px-1.5 py-0.5 text-[10px] font-mono uppercase",
      tom === "ok" && "bg-primary/10 text-primary",
      tom === "cache" && "bg-secondary/60 text-muted-foreground",
      tom === "unknown" && "bg-secondary/40 text-muted-foreground/70",
    )}>{ETIQUETA[estado] ?? estado}</span>
  );
}

/** Estado honesto da utilização da GPU: `usageStatus` manda; presence é eixo próprio. */
function estadoUsoGpu(gpu: HardwareSnapshot["gpu"], presence: string): { estado: string; valor: number | null } {
  if (!gpu || presence !== "present") return { estado: presence, valor: null };
  const s = gpu.usageStatus ?? null;
  const v = typeof gpu.usagePercent === "number" && Number.isFinite(gpu.usagePercent) ? gpu.usagePercent : null;
  if (s === "error" || s === "unavailable") return { estado: "unavailable", valor: null };
  if (s === "stale") return v != null ? { estado: "stale", valor: v } : { estado: "unavailable", valor: null };
  return v != null ? { estado: "available", valor: v } : { estado: "unavailable", valor: null };
}

function Metrica(props: { icone: ReactNode; nome: string; valor: string; unidade?: string; detalhe: string; estado: string; amostras: { value: number; timestamp: number }[]; max?: number; acessivel: string }) {
  return (
    <div className="bg-card cyber-border rounded-xl p-4 space-y-2">
      <div className="flex items-center gap-2 text-muted-foreground">
        {props.icone}
        <span className="text-xs uppercase font-mono">{props.nome}</span>
        <span className="ml-auto"><Etiqueta estado={props.estado} /></span>
      </div>
      <p className="font-mono tabular-nums text-2xl text-foreground">
        {props.valor}{props.unidade ? <span className="text-sm text-muted-foreground"> {props.unidade}</span> : null}
      </p>
      <TelemetrySparkline samples={props.amostras} max={props.max} height={36} label={props.nome} accessibleLabel={props.acessivel} color="var(--primary)" />
      <p className="text-[11px] text-muted-foreground font-mono truncate" title={props.detalhe}>{props.detalhe}</p>
    </div>
  );
}

function LinhaTemperatura({ rotulo, leitura, fonte, sensor, medidoEm, semIdentidade }: { rotulo: string; leitura: LeituraTemperatura; fonte: string | null; sensor: string | null; medidoEm: string | null; semIdentidade?: boolean }) {
  const valor = leitura.state === "available" || leitura.state === "stale" ? `${leitura.value}°C` : "—";
  const prov = [fonte, semIdentidade ? null : sensor, medidoEm ? `lido ${medidoEm}` : "instante não publicado"].filter(Boolean).join(" · ");
  return (
    <li className="flex items-baseline gap-2">
      <Thermometer className="w-4 h-4 text-muted-foreground self-center" />
      <span className="text-muted-foreground">{rotulo}</span>
      <strong className="font-mono tabular-nums">{valor}</strong>
      <Etiqueta estado={leitura.state} />
      <span className="ml-auto text-[11px] text-muted-foreground font-mono truncate" title={prov}>{prov}</span>
    </li>
  );
}

/**
 * Adaptação da composição LAB V2 para o PC Center: cabeçalho, faixa de métricas
 * e faixa de temperaturas ACIMA das vistas originais, que continuam a ser
 * renderizadas como `children` (nenhum detalhe é substituído).
 */
export default function PcCenterVisual({ hardware, dataOrigin, modo = "simples", children }: PcCenterVisualProps) {
  const leituras: LeiturasResolvidas = leiturasDe(hardware, HELPERS);
  const cpu = leituras.cpu;
  const ram = leituras.ram;
  const gpu = leituras.gpu;
  const presence = gpu?.presence ?? "pending";
  const usoGpu = estadoUsoGpu(hardware?.gpu ?? null, presence);

  const histCpu = useTelemetryHistory("cpu", 2000);
  const histGpu = useTelemetryHistory("gpu", 2000);
  const histRam = useTelemetryHistory("ram", 2000);
  const histDisk = useTelemetryHistory("disk", 2000);

  const secoes = secoesPorModo(modo, SECOES_VISUAIS);
  const tem = (id: string) => secoes.some((s) => s.id === id);

  const origem: OrigemDados = hardware ? dataOrigin ?? "LIVE" : "UNAVAILABLE";
  const emCache = origem === "CACHED";
  const semLeitura = origem === "UNAVAILABLE";
  // A origem global rebaixa a apresentação: CACHED mantém o último valor como
  // cache; UNAVAILABLE não publica valor atual. Snapshot/helpers não mudam.
  const est = (s: string) => (semLeitura ? "unavailable" : emCache && (s === "available" || s === "present") ? "stale" : s);
  const val = <T,>(v: T | null): T | null => (semLeitura ? null : v);
  const temp = (t: LeituraTemperatura): LeituraTemperatura =>
    semLeitura ? { state: "unavailable", value: null } : emCache && t.state === "available" ? { state: "stale", value: t.value } : t;

  const cpuEstado = est(cpu.state);
  const gpuEstado = est(usoGpu.estado);
  const ramEstado = est(ram.state);
  const discoEstado = est(hardware?.disk?.usagePercent != null ? "available" : "unavailable");
  const cpuValor = val(cpu.value);
  const gpuValor = val(usoGpu.valor);
  const ramPercent = val(ram.state === "available" ? ram.value : ram.state === "stale" ? ram.cachedValue : null);
  const discoValor = val(hardware?.disk?.usagePercent ?? null);

  const ramDisp = ramUsageDisplay(hardware?.ram ?? null);
  const ramDetalhe = `${ramEstado === "stale" ? "última leitura" : ramEstado === "available" ? "atual" : "sem leitura"} · ${semLeitura ? "—" : ramDisp.usedText} de ${ramDisp.totalText}`;
  const instante = hardware?.timestamp ?? null;
  const origemTexto = origem === "LIVE" ? "leitura atual" : origem === "CACHED" ? `última leitura guardada · ${instante ?? "instante não publicado"}` : "sem leitura nesta captura";
  const origemEstado = origem === "LIVE" ? "available" : origem === "CACHED" ? "stale" : "unavailable";

  return (
    <div className="w-full space-y-6" data-testid="pccenter-visual-lab">
      {tem("cabecalho") && (
        <header className="bg-card cyber-border rounded-xl p-6">
          <p className="text-xs font-mono uppercase text-muted-foreground">Computador / PC Center</p>
          <h2 className="text-2xl font-bold text-foreground">Conhece o ritmo do teu PC.</h2>
          <p className="text-sm text-muted-foreground">Recursos, utilização e disponibilidade. Tudo no mesmo lugar.</p>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs font-mono">
            <span className="flex items-center gap-1.5 text-muted-foreground"><Monitor className="w-4 h-4" />{hardware?.system?.platform ?? "sem leitura"}</span>
            <Etiqueta estado={origemEstado} />
            <span className="text-muted-foreground">{origemTexto}</span>
          </div>
        </header>
      )}

      {tem("metricas") && (
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4" aria-label="Recursos">
          <Metrica icone={<Cpu className="w-4 h-4" />} nome="Processador" valor={cpuValor != null ? String(Math.round(cpuValor)) : "—"} unidade={cpuValor != null ? "%" : undefined} detalhe={`${hardware?.cpu?.cores ?? "—"} núcleos · ${hardware?.cpu?.speed ?? "—"} MHz`} estado={cpuEstado} amostras={histCpu} max={100} acessivel="Histórico de utilização do processador" />
          <Metrica icone={<Monitor className="w-4 h-4" />} nome="Placa gráfica" valor={gpuValor != null ? String(Math.round(gpuValor)) : "—"} unidade={gpuValor != null ? "%" : undefined} detalhe={presence === "present" ? (hardware?.gpu?.model ?? "GPU") : presence === "pending" ? GPU_PENDING_LABEL : GPU_ABSENT_LABEL} estado={gpuEstado} amostras={histGpu} max={100} acessivel="Histórico de utilização da placa gráfica" />
          <Metrica icone={<MemoryStick className="w-4 h-4" />} nome="Memória" valor={ramPercent != null ? String(Math.round(ramPercent)) : "—"} unidade={ramPercent != null ? "%" : undefined} detalhe={ramDetalhe} estado={ramEstado} amostras={histRam} max={100} acessivel="Histórico de utilização da memória" />
          <Metrica icone={<HardDrive className="w-4 h-4" />} nome="Armazenamento" valor={discoValor != null ? String(Math.round(discoValor)) : "—"} unidade={discoValor != null ? "%" : undefined} detalhe={`${semLeitura ? "sem leitura" : hardware?.disk?.usedGb != null ? `${hardware.disk.usedGb.toFixed(1)} GB` : "—"} de ${hardware?.disk?.totalGb != null ? `${hardware.disk.totalGb} GB` : "—"}`} estado={discoEstado} amostras={histDisk} max={100} acessivel="Histórico de utilização do disco" />
        </section>
      )}

      {tem("temperaturas") && (
        <section className="bg-card cyber-border rounded-xl p-6 space-y-3" aria-label="Temperaturas e sensores">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Temperaturas e sensores</h3>
          <ul className="space-y-2 text-sm">
            <LinhaTemperatura rotulo="CPU" leitura={temp(leituras.cpuTemp)} fonte="snapshot do serviço" sensor={null} medidoEm={null} />
            {gpu ? (
              <>
                <LinhaTemperatura rotulo="GPU · núcleo" leitura={temp(gpu.core)} fonte={gpu.source} sensor={gpu.sensor} medidoEm={gpu.updatedAt} />
                <LinhaTemperatura rotulo="GPU · hotspot" leitura={temp(gpu.hotspot)} fonte={gpu.source} sensor={null} medidoEm={gpu.updatedAt} semIdentidade />
                <LinhaTemperatura rotulo="GPU · memory junction" leitura={temp(gpu.memoryJunction)} fonte={gpu.source} sensor={null} medidoEm={gpu.updatedAt} semIdentidade />
              </>
            ) : (
              <li className="text-xs text-muted-foreground font-mono">{presence === "pending" ? GPU_PENDING_LABEL : GPU_ABSENT_LABEL}</li>
            )}
          </ul>
        </section>
      )}

      {/* Vistas ORIGINAIS preservadas: SimpleView/AdvancedView com HardwareDetailPanel,
          perCore, frequência, discos físicos e demais detalhe. */}
      {children}
    </div>
  );
}
