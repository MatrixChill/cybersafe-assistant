import { securityEventPresentation } from "@/lib/securityEventPresentation";
/** Presentation structure from Design Lab src/SecurityPages.tsx Dashboard.
 * No service access or demo imports: the container supplies measured contracts.
 */
import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  FileSearch,
  Clock3,
  AlertTriangle,
} from "lucide-react";
import type {
  DashboardSummary,
  HardwareSnapshot,
  PcState,
  ScanHistoryEntry,
  SecurityEvent,
} from "@cybersafe/shared-types";
import {
  Badge,
  Button,
  Chart,
  Modal,
  PageHead,
  Panel,
  SectionTitle,
} from "../ui";
import { BrandScene, AuroraBackdrop } from "./effects/Effects";
import SpotlightCard from "./effects/SpotlightCard";
import { engineCards, dashboardVerdict, type VisualState } from "./model";
import type { RealtimeProtectionInfo } from "@/lib/protectionHealth";
import { cpuUsageDisplay } from "@/lib/cpuUsage";
import { gpuPresence, GPU_ABSENT_LABEL, GPU_PENDING_LABEL } from "@/lib/gpuDisplay";
import { ramUsageDisplay } from "@/lib/ramUsageDisplay";
import { useAppearance } from "@/contexts/AppearanceContext";
import { useTelemetryHistory } from "@/components/TelemetrySparkline";
import ProtectionControl, {
  type ProtectionPending,
} from "@/components/ProtectionControl";
import ProtectionDetails from "@/components/ProtectionDetails";
import { deriveProtectionLevel } from "@/lib/protectionHealth";
import { LabDiagnostics } from "./LabDiagnostics";
export type ReadPhase =
  | "a_consultar"
  | "pronto"
  | "sem_confirmacao"
  | "sem_ligacao"
  | "erro";
export interface DashboardProps {
  dashboard: DashboardSummary;
  isLoading: boolean;
  hardware?: HardwareSnapshot | null;
  pcState?: PcState | null;
  onScan?: (type: string, targetPath?: string) => void;
  onOpenScanner?: () => void;
  onOpenPC?: () => void;
  realtime?: RealtimeProtectionInfo;
  onSetProtection?: (enabled: boolean) => void;
  onPauseProtection?: (minutes: number) => void;
  protectionPending?: ProtectionPending;
  serviceConnected?: boolean | null;
  serviceGeneration?: number;
  protectionError?: string | null;
  onDismissProtectionError?: () => void;
  events?: SecurityEvent[];
  eventsReadPhase?: ReadPhase;
}
export type HistoryReading = {
  phase: ReadPhase;
  entry: ScanHistoryEntry | null;
};
const readingCopy: Record<ReadPhase, string> = {
  a_consultar: "A consultar o serviço…",
  pronto: "Consulta confirmada",
  sem_confirmacao: "Leitura não confirmada",
  sem_ligacao: "Sem ligação ao serviço",
  erro: "Não foi possível consultar o serviço",
};
export default function LabDashboard(
  p: DashboardProps & { history: HistoryReading },
) {
  const { animate } = useAppearance();
  const [details, setDetails] = useState(false),
    [control, setControl] = useState(false),
    [engine, setEngine] = useState<string | null>(null);
  const engines = engineCards(p.dashboard.engineHealth, p.serviceConnected);
  const verdict = dashboardVerdict(p.dashboard, p.realtime, p.serviceConnected);
  const cpu = cpuUsageDisplay(
      p.serviceConnected === true ? p.hardware?.cpu : null,
    ),
    ram = ramUsageDisplay(p.serviceConnected === true ? p.hardware?.ram : null);
  const samples = useTelemetryHistory("cpu", 2000);
  // GPU has the same measured-percentage/status contract; reuse the canonical
  // formatter without introducing another availability or percentage policy.
  const gpuUsage = cpuUsageDisplay(
    p.serviceConnected === true && p.hardware?.gpu
      ? {
          usage: p.hardware.gpu.usagePercent ?? NaN,
          usageStatus: p.hardware.gpu.usageStatus,
          usageUpdatedAt: p.hardware.gpu.usageUpdatedAt,
        }
      : null,
  );
  const presence = gpuPresence(p.serviceConnected === true ? p.hardware?.gpu : null);
  const gpuText = presence === "absent"
    ? GPU_ABSENT_LABEL
    : presence === "pending" ? GPU_PENDING_LABEL : gpuUsage.text;
  const current = p.history.phase === "pronto" ? p.history.entry : null;
  const eventPhase =
    p.serviceConnected === false
      ? "sem_ligacao"
      : (p.eventsReadPhase ?? "a_consultar");
  const events =
    eventPhase === "pronto"
      ? [...(p.events ?? [])]
          .sort((a, b) => b.sequence - a.sequence)
          .slice(0, 3)
      : [];
  const selected = engines.find((e) => e.key === engine);
  const active = engines.filter((e) => e.state === "ACTIVE").length;
  const states = Object.fromEntries(
    engines.map((e) => [e.key, e.state]),
  ) as Record<string, VisualState>;
  return (
    <div
      className="v2-dashboard"
      data-testid="v2-dashboard"
      data-reduced={!animate}
    >
      <PageHead
        eyebrow="CENTRO DE SEGURANÇA"
        title="O essencial, sob controlo."
        description="Uma leitura clara da proteção e do desempenho do teu computador."
      >
        <details className="scan-options">
          <summary className="text-link">Outras análises</summary>
          <div className="inset">
            <Button
              data-testid="scan-quick"
              disabled={!p.onScan || p.serviceConnected !== true}
              onClick={() => p.onScan?.("quick")}
            >
              Análise Rápida
            </Button>
            <Button
              data-testid="scan-full"
              disabled={!p.onScan || p.serviceConnected !== true}
              onClick={() => p.onScan?.("full")}
            >
              Análise Profunda
            </Button>
            <Button
              data-testid="scan-custom"
              disabled={
                !p.onScan ||
                p.serviceConnected !== true ||
                typeof window === "undefined" ||
                !window.electronAPI
              }
              onClick={async () => {
                if (
                  !p.onScan ||
                  p.serviceConnected !== true ||
                  typeof window === "undefined" ||
                  !window.electronAPI
                )
                  return;
                const path = await window.electronAPI.openFolderDialog();
                if (path) p.onScan("custom", path);
              }}
            >
              Analisar uma Pasta
            </Button>
          </div>
        </details>
        {p.onOpenScanner && (
          <Button
            variant="primary"
            onClick={p.onOpenScanner}
            data-testid="dashboard-nova-analise"
          >
            <FileSearch size={16} />
            Nova análise
          </Button>
        )}
      </PageHead>
      {p.protectionPending && (
        <p className="notice subtle" role="status">
          {p.protectionPending === "starting"
            ? "A ativar…"
            : p.protectionPending === "stopping"
              ? "A desligar…"
              : "A pausar…"}{" "}
          Pedido de proteção em curso.
        </p>
      )}
      {p.protectionError && (
        <div className="notice" role="alert">
          <p>Não foi possível aplicar: {p.protectionError}</p>
          {p.onSetProtection && p.onPauseProtection && (
            <Button onClick={() => setControl(true)}>
              Ver controlo de proteção
            </Button>
          )}
          {p.onDismissProtectionError && (
            <Button variant="ghost" onClick={p.onDismissProtectionError}>
              Fechar aviso
            </Button>
          )}
        </div>
      )}
      <div className="dashboard-top">
        <Panel className="protection-hero">
          <AuroraBackdrop />
          <div className="hero-copy">
            <div className="eyebrow">
              <span className="tiny-square" />
              ESTADO DA PROTEÇÃO
            </div>
            <h2>{p.isLoading ? "A consultar a proteção…" : verdict.title}</h2>
            <p>{verdict.description}</p>
            <div className="hero-actions">
              <Button
                onClick={() => {
                  setDetails(true);
                  document.getElementById("dashboard-engines")?.scrollIntoView({
                    behavior: animate ? "smooth" : "instant",
                    block: "nearest",
                  });
                }}
              >
                Ver estado dos motores
                <ArrowRight size={15} />
              </Button>
              {p.onSetProtection && p.onPauseProtection && (
                <Button variant="ghost" onClick={() => setControl(true)}>
                  Controlar proteção
                </Button>
              )}
              <span className="caption">
                {p.serviceConnected === true && p.dashboard.engineHealth
                  ? `Relatório do serviço · ${active} de 4 sem degradação reportada`
                  : "Motores sem leitura"}
              </span>
            </div>
          </div>
          <BrandScene states={states} />
        </Panel>
        <Panel className="last-scan">
          <div className="metric-label">
            <span>ÚLTIMA ANÁLISE</span>
            <Clock3 size={16} />
          </div>
          {current ? (
            <>
              <h2>
                {current.type === "quick"
                  ? "Análise rápida"
                  : current.type === "full"
                    ? "Análise completa"
                    : "Análise personalizada"}
              </h2>
              <p>{new Date(current.endedAt).toLocaleString("pt-PT")}</p>
              <div className="scan-number">
                {Number.isFinite(current.filesAnalyzed)
                  ? current.filesAnalyzed
                  : "—"}
                <span>ficheiros analisados</span>
              </div>
              <Badge
                tone={
                  current.status === "failed"
                    ? "crit"
                    : current.status === "cancelled"
                      ? "na"
                      : current.engineLimitations?.length
                        ? "warn"
                        : "ok"
                }
              >
                {current.status === "failed"
                  ? "Falhou"
                  : current.status === "cancelled"
                    ? "Cancelada"
                    : current.engineLimitations?.length
                      ? "Cobertura parcial"
                      : "Concluída"}
              </Badge>
            </>
          ) : (
            <>
              <h2>
                {p.history.phase === "pronto"
                  ? "Ainda sem análises registadas"
                  : readingCopy[p.history.phase]}
              </h2>
              <p>
                {p.history.phase === "pronto"
                  ? "O serviço confirmou uma lista vazia."
                  : "A ausência de leitura não significa que o histórico esteja vazio."}
              </p>
              <div className="scan-number">
                —<span>ficheiros</span>
              </div>
            </>
          )}
          {p.onOpenScanner && (
            <button className="text-link" onClick={p.onOpenScanner}>
              Consultar resultados
              <ArrowUpRight size={14} />
            </button>
          )}
        </Panel>
      </div>
      <div id="dashboard-engines">
        <SectionTitle
          title="Os teus motores de análise"
          detail="Estados independentes. Nenhuma suposição de proteção."
          onLink={() => setDetails(true)}
          linkLabel="Explorar motores"
        />
      </div>
      <div
        className="engine-grid"
        data-testid="engine-grid"
        data-conexao={
          p.serviceConnected === true ? "confirmada" : "nao-confirmada"
        }
      >
        {engines.map((e) => (
          <SpotlightCard
            key={e.key}
            intensity={animate ? 0.12 : 0}
            borderGlow={animate ? 0.4 : 0}
            proximity={0}
            className="engine-card"
            data-engine={e.key}
            data-state={e.report?.status ?? "sem-leitura"}
            data-coverage={e.report?.coverage ?? "unknown"}
          >
            <div className="engine-top">
              <span className="engine-symbol">{e.symbol}</span>
              <Badge
                tone={
                  e.state === "ACTIVE"
                    ? "ok"
                    : e.state === "DEGRADED"
                      ? "warn"
                      : e.state === "ERROR"
                        ? "crit"
                        : "na"
                }
              >
                {e.label}
              </Badge>
            </div>
            <h3>{e.name}</h3>
            <p>{e.kind}</p>
            <div className="engine-resource">{e.coverage}</div>
            <button className="engine-bottom" onClick={() => setEngine(e.key)}>
              <span>Último relatório recebido</span>
              <ArrowUpRight size={15} />
              <span className="sr-only">Detalhes de {e.name}</span>
            </button>
          </SpotlightCard>
        ))}
      </div>
      <div className="dashboard-bottom">
        <Panel>
          <SectionTitle
            title="Atividade recente"
            detail={readingCopy[eventPhase]}
          />
          <div className="activity-list">
            {events.map((e) => {
              const presentation = securityEventPresentation(e);
              return (
              <div className="activity" key={e.id}>
                <span
                  className={`activity-icon ${["observed","requested","unknown"].includes(presentation.provenance) ? "state-na" : e.severity === "high" ? "state-error" : "state-loading"}`}
                >
                  <Clock3 size={14} />
                </span>
                <div className="activity-body">
                  <strong className="activity-message" tabIndex={0}>{presentation.text}</strong>
                  <p>{presentation.note}</p>
                  {presentation.provenance !== "other" && e.summary && (
                    <details className="activity-original">
                      <summary>Ver registo original</summary>
                      <pre tabIndex={0}>{e.summary}</pre>
                    </details>
                  )}
                </div>
                <time>
                  {new Date(e.timestamp).toLocaleTimeString("pt-PT", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              );
            })}
            {!events.length && (
              <p>
                {eventPhase === "pronto"
                  ? "Sem eventos nesta consulta confirmada."
                  : "Sem uma lista atual confirmada. Nenhum evento é inventado."}
              </p>
            )}
          </div>
        </Panel>
        <Panel className="pc-summary">
          <SectionTitle
            title="O teu computador"
            onLink={p.onOpenPC}
            linkLabel="PC Center"
          />
          <div className="mini-metrics">
            {[
              ["CPU", cpu.text],
              ["Memória", ram.text],
              ["GPU", gpuText],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          {cpu.state === "available" && p.serviceConnected === true ? (
            <Chart
              values={samples.map((s) => s.value)}
              label="CPU: amostras medidas pelo serviço"
            />
          ) : (
            <p>
              {cpu.state === "stale"
                ? "Gráfico suspenso: última leitura de CPU."
                : "Ainda sem série de telemetria confirmada."}
            </p>
          )}
          <div className="panel-foot">
            <span>Telemetria do serviço</span>
            <span>
              {cpu.updatedAt
                ? new Date(cpu.updatedAt).toLocaleTimeString("pt-PT")
                : "Instante não comunicado"}
            </span>
          </div>
        </Panel>
      </div>
      <LabDiagnostics {...p} />
      {p.dashboard.alerts.length > 0 && (
        <details className="dashboard-alerts">
          <summary>
            <AlertTriangle size={14} />
            Alertas reportados ({p.dashboard.alerts.length})
          </summary>
          {p.dashboard.alerts.map((a) => (
            <p key={a.id}>
              {a.title}: {a.description}
            </p>
          ))}
        </details>
      )}
      {selected && (
        <Modal title={selected.name} onClose={() => setEngine(null)}>
          <Badge
            tone={
              selected.state === "ERROR"
                ? "crit"
                : selected.state === "DEGRADED"
                  ? "warn"
                  : selected.state === "ACTIVE"
                    ? "ok"
                    : "na"
            }
          >
            {selected.label}
          </Badge>
          <p className="dialog-copy">
            {selected.coverage}. Este estado descreve o último relatório
            recebido; a sua idade não é afirmada.
          </p>
          <div className="inset">
            <p>
              {selected.report?.detail ??
                "Sem detalhe confirmado pelo serviço."}
            </p>
          </div>
          <div className="dialog-actions">
            <Button
              onClick={() => {
                setEngine(null);
                setDetails(true);
              }}
            >
              Ver diagnóstico completo
            </Button>
          </div>
        </Modal>
      )}
      {control && p.onSetProtection && p.onPauseProtection && (
        <Modal title="Controlo de proteção" onClose={() => setControl(false)}>
          <ProtectionControl
            realtime={p.realtime}
            pending={p.protectionPending ?? null}
            connected={p.serviceConnected ?? null}
            onSet={p.onSetProtection}
            onPause={p.onPauseProtection}
            error={p.protectionError}
            onDismiss={p.onDismissProtectionError}
          />
        </Modal>
      )}
      <ProtectionDetails
        engine={p.dashboard.engineHealth}
        level={deriveProtectionLevel(
          p.dashboard.systemStatus,
          p.dashboard.engineHealth,
          p.realtime,
        )}
        open={details}
        onClose={() => setDetails(false)}
        score={p.dashboard.riskScore ?? undefined}
      />
    </div>
  );
}
