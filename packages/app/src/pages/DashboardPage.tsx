import { Shield, AlertTriangle, Download, Activity, CheckCircle2, Cpu, HardDrive, MemoryStick, Wifi, Search, Play, FolderSearch, Database, FolderTree, Layers } from "lucide-react";
import { useEffect, useState } from "react";
import type { DashboardSummary, EngineHealth, HardwareSnapshot, PcState, PcStateLevel, ProtectionStatus, Severity, Finding } from "@cybersafe/shared-types";
// WS-5: a escala de prioridade e a construcao do DADO/SIGNIFICADO/ORIENTACAO
// vivem em shared-types (o motor deriva, a UI formata). Nao duplicam-se aqui.
import { buildFindingGuidance, FINDING_SEVERITY_LABEL, wfpHealth } from "@cybersafe/shared-types";
import { cn } from "@/lib/utils";
import { MatrixAvatar } from "../components/MatrixAvatar";
import ProtectionDetails from "../components/ProtectionDetails";
import { describeDiskSpace, deriveProtectionLevel, explainProtectionScore, levelMeta, realtimeProtectionCopy, type ProtectionLevel, type RealtimeProtectionInfo } from "../lib/protectionHealth";
import {
  diskReadLabel,
  diskUnavailableText,
  diskVolumeRows,
  formatGb,
  formatPercent,
  useNow,
} from "../lib/diskDisplay";
import ProtectionControl, { type ProtectionPending } from "../components/ProtectionControl";
import { MetricBarSkeleton } from "../components/Skeleton";
import { TelemetrySparkline, useTelemetryHistory } from "../components/TelemetrySparkline";
import { useTemperatureDisplay } from "../lib/temperature";
import { cpuUsageDisplay } from "../lib/cpuUsage";
import { ramUsageDisplay } from "../lib/ramUsageDisplay";
import { networkReadingDisplay } from "../lib/networkReadings";
import { useAppearance } from "../contexts/AppearanceContext";

interface DashboardPageProps {
  dashboard: DashboardSummary;
  isLoading: boolean;
  hardware?: HardwareSnapshot | null;
  pcState?: PcState | null;
  onScan?: (type: string, targetPath?: string) => void;
  /**
   * G2: leitura factual do tempo real, vinda do `ProtectionState`. Ausente ou
   * `undefined` = o serviço não leu — nada é afirmado por ausência de dado.
   */
  realtime?: RealtimeProtectionInfo;
  /** Liga/desliga a proteção pelo contrato real. Sem isto, a UI é só leitura. */
  onSetProtection?: (enabled: boolean) => void;
  /** Pausa pelo contrato real. */
  onPauseProtection?: (minutes: number) => void;
  /** Pedido em voo (feedback imediato, nunca estado confirmado). */
  protectionPending?: ProtectionPending;
  /** Ligação ao serviço; `false`/`null` => controlo não acionável. */
  serviceConnected?: boolean | null;
  /** Causa da última ativação falhada (GUI-TEST-18/19) — nunca rollback silencioso. */
  protectionError?: string | null;
  onDismissProtectionError?: () => void;
}

export default function DashboardPage({ dashboard, isLoading, hardware, pcState, onScan, realtime, onSetProtection, onPauseProtection, protectionPending = null, serviceConnected = null, protectionError = null, onDismissProtectionError }: DashboardPageProps) {
  const { surface } = useAppearance();
  const level = realtime?.disponivel === false ? "critical" : deriveProtectionLevel(dashboard.systemStatus, dashboard.engineHealth, realtime ?? {});
  const monitoringLabel = realtime?.pausedUntil ? "Monitorização em pausa" : realtime?.enabled === false ? "Monitorização desligada" : realtime?.enabled !== true ? "Monitorização não verificada" : null;
  const meta = monitoringLabel && level !== "critical" ? {...levelMeta(level),label:monitoringLabel,shortLabel:monitoringLabel,answer:monitoringLabel,answerDetail:"O serviço pode estar operacional sem analisar automaticamente novos ficheiros."} : levelMeta(level);
  // A linha DISTINTA do tempo real: só existe quando há leitura real. O
  // status/score atuais mantêm-se — isto acrescenta informação, não substitui.
  const realtimeCopy = realtimeProtectionCopy(realtime);
  // A pontuação explicada com os pesos REAIS do backend (explicação em
  // lib/protectionHealth, que é a mesma fonte dos pisos) — sem inventar número.
  const scoreInfo = dashboard.riskScore === null || !dashboard.engineHealth
    ? null
    : explainProtectionScore(dashboard.riskScore, dashboard.engineHealth);
  // Porque é que o nível é este. São factos já lidos, por ordem do mais
  // específico para o mais geral: o primeiro que se verificar é a resposta.
  const motivo = motivoDoNivel(level, dashboard.systemStatus, dashboard.engineHealth, realtime);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [displayScore, setDisplayScore] = useState(0);

  const cpuSamples = useTelemetryHistory("cpu", 2000);
  const ramSamples = useTelemetryHistory("ram", 2000);
  const netRxSamples = useTelemetryHistory("net-rx", 2000);

  // Temperaturas: nunca 0 °C artificial. "A recolher dados..." e, passado o
  // prazo sem leitura segura, "Temperatura indisponível" (igual ao PC Center).
  const cpuTemp = useTemperatureDisplay(hardware?.cpu?.temperature ?? null, { channel: "cpu" });
  const cpuUsage = cpuUsageDisplay(hardware?.cpu);
  const ramUsage = ramUsageDisplay(hardware?.ram);
  const netReading = networkReadingDisplay(hardware?.network);
  const gpuTemp = useTemperatureDisplay(hardware?.gpu?.temperature ?? null, { channel: "gpu" });

  useEffect(() => {
    const target = dashboard.riskScore;
    // null = sem leitura do servico: nao se anima nem se mostra numero que nao
    // foi medido. O circulo fica parado e a legenda diz "Sem leitura".
    if (target === null) {
      setDisplayScore(0);
      return;
    }
    const step = Math.ceil(Math.max(target, 1) / 20);
    const interval = setInterval(() => {
      setDisplayScore((prev) => {
        if (prev >= target) {
          clearInterval(interval);
          return target;
        }
        return Math.min(prev + step, target);
      });
    }, 50);
    return () => clearInterval(interval);
  }, [dashboard.riskScore]);

  if (isLoading) {
    return (
      <div className="p-8 h-full flex flex-col items-center justify-center font-mono text-primary animate-pulse space-y-4">
        <Shield className="w-12 h-12" />
        <span className="tracking-[0.3em]">A Sincronizar Estado de Proteção...</span>
      </div>
    );
  }

  const matrixMood = level === "protected" ? "safe" : level === "attention" ? "guide" : "alert";
  const statusLabel = monitoringLabel && level !== "critical" ? monitoringLabel : level === "protected" ? "Monitorização ligada" : level === "attention" ? "Atenção" : level === "degraded" ? "Precisa de atenção" : "Crítico";

  return (
    <div className="dashboard-page p-4 lg:p-6 space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">

      {/* ═══ CAMADA 1 — A PERGUNTA E A RESPOSTA ═══
          Dois veredictos com nomes próprios, porque são duas medidas diferentes:
          a PROTEÇÃO (o que o CyberSafe está a vigiar) e a SAÚDE DO PC (o que o
          motor de estado do Windows mediu). Antes havia uma resposta só e
          quatro etiquetas ao lado sem fonte — era daí que vinha o "não se
          percebe o que é quê". Nada aqui é misturado: nenhum número soma as
          duas coisas, e cada bloco diz de onde vem.

          TP-UI-01: primeira aplicação real do material L3 Showcase em uma
          superfície só do Dashboard (o hero-banner), sem alterar estado, sem
          mexer em motores e sem afetar outras zonas. */}
      <section className="hero-banner relative overflow-hidden rounded-2xl px-5 py-4 lg:px-6 lg:py-5" data-material={surface}>
        {/* TP-UI-01/02 · TP-DASHBOARD-SURFACE-FIX: o material do hero-banner
            vem do eixo de superfície — deixou de ser o literal "reduced" e lê
            agora a preferência guardada pelo AppearanceContext (`surface`).
            O atributo `data-material` é o contrato que o CSS do eixo lê. */}
        <div className="hero-gradient" />

        <div className="relative z-10 space-y-4">
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
            <div className="flex min-w-[268px] flex-1 items-start gap-3">
              <MatrixAvatar mood={matrixMood} size="md" />
              <div className="min-w-0">
                <h1 className="font-sans text-xl lg:text-2xl font-semibold tracking-tight text-foreground leading-tight">
                  O meu computador está bem?
                </h1>
                <p className="copy-human mt-1 text-foreground">
                  <span className={cn("font-semibold", meta.textClass)}>{meta.answer}</span>{" "}
                  <span className="text-muted-foreground">{meta.answerDetail}</span>
                </p>
                {/* O nível não se pede por confiança: vem escrito porque está
                    assim, a partir do que o serviço reportou. */}
                {motivo && (
                  <p className="copy-human mt-0.5 text-muted-foreground">
                    Porque <span className="text-foreground">{motivo}</span>.
                  </p>
                )}
                {/* G2: "Desativada" e "Pausada" sao estados DISTINTOS de "Crítico".
                    Sem leitura do campo, esta linha simplesmente nao existe. */}
                {realtimeCopy && (
                  <p className="mt-1 text-xs font-mono text-muted-foreground">
                    Proteção em tempo real:{" "}
                    <span
                      className={cn(
                        "font-bold",
                        realtimeCopy.tone === "ok" ? "text-cyber-green"
                          : realtimeCopy.tone === "warn" ? "text-cyber-yellow"
                          : "text-cyber-red",
                      )}
                    >
                      {realtimeCopy.text}
                    </span>
                  </p>
                )}
              </div>
            </div>

            {/* PONTUAÇÃO DE PROTEÇÃO — o número com o sujeito escrito ao lado,
                dentro de uma pastilha e não como círculo solto no canto. A
                queixa era «80/100 ao lado de Crítico sem explicação»: aqui o
                rótulo diz o que é medido, a linha por baixo diz de onde vem o
                teto, e o chip diz PORQUE está no nível que está.
                TP-V2-VISUAL: o bloco cresceu para leitura imediata (aro 14 +
                valor 2xl) e a explicação da nota passou a mostrar também a
                penalização — os mesmos números que `explainProtectionScore`
                devolve, sem calcular nada na UI. */}
            <div className="flex shrink-0 items-center gap-3" data-testid="score-dial">
              <div className="relative h-16 w-16 shrink-0">
                <svg className="h-full w-full -rotate-90" viewBox="0 0 100 100" aria-hidden>
                  <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="10" className="text-secondary" />
                  <circle
                    cx="50" cy="50" r="40" fill="none" stroke="url(#hero-risk-gradient)" strokeWidth="10"
                    strokeLinecap="round" strokeDasharray={`${(displayScore / 100) * 251.2} 251.2`}
                    className="motion-safe:transition-all motion-safe:duration-500"
                  />
                  <defs>
                    <linearGradient id="hero-risk-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor={level === "protected" ? "var(--cyber-green)" : level === "attention" ? "var(--cyber-yellow)" : "var(--cyber-red)"} />
                      <stop offset="100%" stopColor="var(--primary)" />
                    </linearGradient>
                  </defs>
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="font-mono text-base font-bold leading-none tabular-nums text-foreground">
                    {dashboard.riskScore === null ? "—" : displayScore}
                  </span>
                </div>
              </div>
              <div className="min-w-0 leading-tight">
                <span
                  className="block font-sans text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  title="Nota de proteção: 100 menos o risco efetivo (ameaças recentes e confiança que falta nos motores de análise). É outra coisa: não é o estado geral do computador."
                >
                  Pontuação de proteção
                </span>
                <span className="block max-w-64 font-sans text-xs text-muted-foreground">
                  Indicador de risco observado. Não confirma cobertura completa.
                </span>
                {(dashboard.engineHealth?.realtimeLoss?.queueRejections ?? dashboard.engineHealth?.realtimeDroppedEvents ?? 0) > 0 && (
                  <span className="mt-1 block max-w-64 font-sans text-xs text-cyber-yellow" role="status">
                    {dashboard.engineHealth?.realtimeLoss?.queueRejections ?? dashboard.engineHealth?.realtimeDroppedEvents} tentativas de análise rejeitadas. Cobertura incompleta ou não confirmada.
                  </span>
                )}
                <span className={cn("block font-mono text-2xl font-bold tabular-nums", meta.textClass)}>
                  {dashboard.riskScore === null ? "sem leitura" : `${dashboard.riskScore}/100`}
                </span>
                {scoreInfo && dashboard.engineHealth ? (
                  <span className="mt-0.5 block font-mono text-xs tabular-nums text-muted-foreground">
                    {scoreInfo.activeEngines} de {scoreInfo.totalEngines} motores ativos · máximo possível {scoreInfo.maxPossible}
                    {scoreInfo.threatPenalty > 0 && ` · −${scoreInfo.threatPenalty} por ameaças`}
                  </span>
                ) : (
                  <span className="mt-0.5 block font-sans text-xs text-muted-foreground">Motores sem leitura: o teto não se calcula</span>
                )}
              </div>

              <button
                onClick={() => setDetailsOpen(true)}
                title={motivo ? `Porquê: ${motivo}` : `Estado da proteção: ${meta.label}`}
                className={cn(
                  "ml-1 flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 font-sans text-xs font-semibold whitespace-nowrap transition-all hover:brightness-110",
                  meta.chipClass,
                  meta.textClass,
                )}
              >
                <span className={cn("h-2 w-2 shrink-0 rounded-full cyber-pulse", meta.dotClass)} />
                {statusLabel}
              </button>
            </div>
          </div>

          {/* Estado do PC: o veredicto do motor de estado, em bloco à parte.
              Não soma nem empresta número à nota de proteção. */}
          {pcState && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
              <div className="flex items-baseline gap-2">
                <span
                  className="text-xs font-mono uppercase tracking-wider text-muted-foreground"
                  title="Medido pelo motor de estado do computador (segurança, desempenho, sistema, privacidade). É outra medida: não é a nota de proteção."
                >
                  Estado do PC
                </span>
                <span className={cn("text-sm font-mono font-bold", LEVEL_META[pcState.overall].textClass)}>
                  {OVERALL_LABEL[pcState.overall]}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {([
                  { key: "security" as const, label: "Segurança" },
                  { key: "performance" as const, label: "Desempenho" },
                  { key: "system" as const, label: "Sistema" },
                  { key: "privacy" as const, label: "Privacidade" },
                ]).map(({ key, label }) => {
                  const catMeta = LEVEL_META[pcState[key]];
                  return (
                    <span
                      key={key}
                      title={`${label}: ${catMeta.label}`}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-secondary/50 border border-border"
                    >
                      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", catMeta.dotClass)} />
                      <span className="text-xs font-mono text-muted-foreground">{label}</span>
                    </span>
                  );
                })}
              </div>
              <span className="text-xs font-mono text-muted-foreground">
                {dashboard.engineHealth?.definitionsUpdatedAt
                  ? `Definições: ${new Date(dashboard.engineHealth.definitionsUpdatedAt).toLocaleDateString("pt-PT")}`
                  : "Definições: sem data"}
              </span>
            </div>
          )}

          {/* AÇÃO PRIMÁRIA no topo: o caminho mais óbvio (Análise Rápida) vive na
              faixa principal, visível sem scroll. As variantes Profunda e Pasta
              continuam no grupo "Procurar ameaças" abaixo. */}
          <div className="flex flex-wrap items-center gap-2 border-t border-primary/15 pt-3">
            <ScanButton label="Análise Rápida" sub="Áreas onde os problemas costumam estar" icon={Search} tone="primary" scanType="quick" onScan={onScan} />
            <span className="copy-human text-muted-foreground">demora uns minutos; podes continuar a usar o PC</span>
          </div>
        </div>
      </section>

      {/* TP-V2-VISUAL — CAMADA DE EVIDÊNCIA.
          Cinco factos que o serviço leu, cada um com a sua origem escrita. É a
          diferença entre "está protegido" (conclusão) e "porque é que sabemos"
          (evidência). Sem leitura, escreve "Sem leitura" — nunca zero. */}
      <section aria-label="Evidência da proteção" data-testid="evidence-strip" className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <EvidenceTile
          icon={Shield}
          label="Motores ativos"
          value={dashboard.engineHealth && scoreInfo ? `${scoreInfo.activeEngines} de ${scoreInfo.totalEngines}` : "Sem leitura"}
          source="Contagem de subsistemas ativos no último relatório do serviço."
          tone={dashboard.engineHealth && scoreInfo && scoreInfo.activeEngines === scoreInfo.totalEngines ? "ok" : "muted"}
        />
        <EvidenceTile
          icon={Activity}
          label="Tempo real"
          value={
            realtime?.disponivel === false
              ? "Não reportado"
              : realtime?.pausedUntil
                ? "Em pausa"
                : realtime?.enabled === true
                  ? "Ligado"
                  : realtime?.enabled === false
                    ? "Desligado"
                    : "Sem leitura"
          }
          source="Estado da monitorização em tempo real reportado pelo serviço."
          tone={realtime?.enabled === true && !realtime?.pausedUntil ? "ok" : realtime?.enabled === false || realtime?.pausedUntil ? "warn" : "muted"}
        />
        <EvidenceTile
          icon={Database}
          label="Definições"
          value={dashboard.engineHealth?.definitionsUpdatedAt ? new Date(dashboard.engineHealth.definitionsUpdatedAt).toLocaleDateString("pt-PT") : "Sem data"}
          source="Data da última atualização das definições de análise."
          tone={dashboard.engineHealth?.definitionsUpdatedAt ? "ok" : "muted"}
        />
        <EvidenceTile
          icon={FolderTree}
          label="Caminhos"
          value={dashboard.engineHealth?.monitoredPaths?.length ? `${dashboard.engineHealth.monitoredPaths.length} vigiados` : "Sem leitura"}
          source="Pastas que o watcher confirmou estar a vigiar."
          tone={dashboard.engineHealth?.monitoredPaths?.length ? "ok" : "muted"}
        />
        <EvidenceTile
          icon={Layers}
          label="Fila"
          value={typeof dashboard.engineHealth?.realtimeQueueDepth === "number" ? `${dashboard.engineHealth.realtimeQueueDepth} em fila` : "Sem leitura"}
          source="Profundidade da fila de eventos em tempo real no último relatório."
          tone={typeof dashboard.engineHealth?.realtimeQueueDepth === "number" && dashboard.engineHealth.realtimeQueueDepth > 50 ? "warn" : "muted"}
        />
      </section>

      {/* Controlo real de proteção: só aparece com o contrato de escrita ligado.
          O estado mostrado vem SEMPRE do serviço; "A ativar…" é feedback do
          clique, nunca estado confirmado. Sem `onSetProtection` a página é só
          leitura (é o caso dos testes de render, que não passam o callback). */}
      {onSetProtection && (
        <ProtectionControl
          realtime={realtime}
          pending={protectionPending}
          connected={serviceConnected}
          onSet={onSetProtection}
          onPause={(m) => onPauseProtection?.(m)}
          error={protectionError}
          onDismiss={onDismissProtectionError}
        />
      )}

      {/* ═══ CAMADA 2 — PRIORIDADES (a única vez que as frases de aviso aparecem) ═══
          As contagens vêm de `pcState.counts`, derivadas no serviço: a UI não
          conta nada nem ordena por conta própria. */}
      {pcState && (pcState.counts.urgent + pcState.counts.attention > 0) && (
        <section>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-2">
            <AlertTriangle className="w-4 h-4 text-cyber-yellow shrink-0" />
            <h2 className="font-sans text-base font-semibold text-foreground">O que precisa de atenção</h2>
            <span className="text-xs font-mono text-muted-foreground">
              {pcState.counts.urgent} agora · {pcState.counts.attention} problema(s)
            </span>
          </div>
          <PcStateAttention
            pcState={pcState}
            engine={dashboard.engineHealth}
            realtime={realtime}
            onSetProtection={onSetProtection}
            serviceConnected={serviceConnected}
            protectionPending={protectionPending}
          />
        </section>
      )}

      {/* ═══ CAMADA 3 — O QUE O PC ESTÁ A FAZER AGORA ═══
          TP-V2-VISUAL: telemetria com hierarquia real — CPU e RAM lideram
          (duas colunas, sparkline maior); GPU, Disco e Rede são cartões de
          apoio. Todos os valores continuam a vir do `HardwareSnapshot`; sem
          leitura, cada cartão di-lo por palavras. */}
      <section className="dash-secondary space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          {/* Chamava-se «Estado do computador» e colidia com o veredicto do
              estado do PC no topo: duas coisas diferentes com o mesmo nome.
              Isto é uso medido agora, e diz-lo. */}
          <h2 className="font-sans text-base font-semibold text-foreground">A usar agora</h2>
          <span className="text-xs font-mono text-muted-foreground">medido agora pelo serviço</span>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {hardware ? (
            <>
              <MetricBar label="CPU" subValue={`${cpuTemp.text}${hardware.cpu.model ? ` · ${hardware.cpu.model}` : ""}`} value={cpuUsage.value ?? 0} valueText={cpuUsage.text} hint={cpuUsage.hint ?? undefined} icon={Cpu} alertTitle={hardware.alerts.find((a) => a.category === "cpu")?.title} sparkline={<TelemetrySparkline samples={cpuSamples} height={44} width={260} showArea accessibleLabel="Histórico de utilização da CPU" />} />
              <MetricBar label="RAM" subValue={ramSubUsed(hardware.ram)} value={ramUsage.value ?? 0} valueText={ramUsage.text} hint={ramUsage.hint ?? undefined} icon={MemoryStick} alertTitle={hardware.alerts.find((a) => a.category === "ram")?.title} sparkline={<TelemetrySparkline samples={ramSamples} height={44} width={260} showArea accessibleLabel="Histórico de utilização da RAM" />} />
            </>
          ) : (
            <>
              <MetricBarSkeleton />
              <MetricBarSkeleton />
            </>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {hardware ? (
            <>
              {hardware.gpu && <GpuMetric gpu={hardware.gpu} temperatureText={gpuTemp.text} alertTitle={hardware.alerts.find((a) => a.category === "gpu")?.title} />}
              <DiskMetric disk={hardware.disk} alertTitle={hardware.alerts.find((a) => a.category === "disk")?.title} />
              <MetricBar label="Rede" valueText={netReading.rxSec != null ? formatThroughput(netReading.rxSec) : netReading.label} subValue={netReading.interfaceName ?? (netReading.state === "pending" ? "A medir…" : "Sem leitura")} value={netReading.rxSec != null ? Math.min(100, netReading.rxSec / 1024 / 100) : 0} hint={netReading.hint ?? "Barra relativa: corresponde a 10 MB/s no máximo."} icon={Wifi} sparkline={<TelemetrySparkline samples={netRxSamples} height={28} width={150} showArea accessibleLabel="Histórico de tráfego de rede recebido" />} />
            </>
          ) : (
            <>
              <MetricBarSkeleton />
              <MetricBarSkeleton />
              <MetricBarSkeleton />
            </>
          )}
        </div>

        {/* Contagem de atividade — discretos, ao lado um do outro. Cada número
            diz de onde vem. A etiqueta antiga contava TODOS os achados do
            estado do PC sob um nome que sugeria apenas uma prioridade; agora o
            cartão lê `counts.recommended`, que é exatamente o que mostra. */}
        <div className="flex flex-wrap items-stretch gap-3">
          <StatCard label="Eventos" value={dashboard.totalEvents.toString()} icon={Activity} color="foreground" fonte="Contagem do serviço de proteção desde que arrancou." />
          <StatCard label="Ameaças graves" value={dashboard.highSeverityEvents.toString()} icon={AlertTriangle} color={dashboard.highSeverityEvents > 0 ? "red" : "green"} fonte="Ameaças de severidade alta ou crítica medidas pelo serviço." />
          <StatCard label="Downloads" value={DOWNLOAD_RISK_LABEL[dashboard.downloadRisk]} icon={Download} color={dashboard.downloadRisk === "low" ? "green" : dashboard.downloadRisk === "medium" ? "yellow" : "red"} isText fonte="O mais grave detetado em downloads vigiados; não é uma média." />
          <StatCard label="Melhorias" value={pcState ? `${pcState.counts.recommended}` : "—"} icon={Shield} color="foreground" isText fonte="Achados do estado do PC na prioridade Melhoria — sugere, não avisa." />
        </div>

        {/* Variantes mais profundas. A Análise Rápida já vive na faixa principal
            (topo), por isso não se repete aqui — só as duas opções além dela. */}
        <div className="stat-card p-3">
          <div className="flex items-baseline justify-between gap-3 mb-2">
            <h3 className="font-sans text-sm font-semibold text-foreground">Outras análises</h3>
            <span className="text-xs font-mono text-muted-foreground">demoram uns minutos; podes continuar a usar o PC</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ScanButton label="Análise Profunda" sub="Pastas do seu utilizador e arranques automáticos" icon={Play} tone="ghost" scanType="full" onScan={onScan} />
            <ScanButton label="Analisar uma Pasta" sub="Escolhes a pasta e só ela é vista" icon={FolderSearch} tone="ghost" scanType="custom" onScan={onScan} />
          </div>
        </div>

        {/* Alertas + Ameaças: só listas com conteúdo ganham espaço. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <ListPanel
            title="Alertas recentes"
            icon={Activity}
            empty="Nenhum alerta grave. Não há nada aqui para ver."
            count={`${dashboard.alerts.length}`}
          >
            {dashboard.alerts.map((alert) => (
              <div key={alert.id} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-secondary/50 border border-border">
                <span className="text-xs font-mono text-foreground truncate">{alert.title}</span>
                <span className="text-xs font-mono text-cyber-red uppercase shrink-0">{alert.severity}</span>
              </div>
            ))}
          </ListPanel>

          <ListPanel
            title="Ameaças recentes"
            icon={Shield}
            empty="Nenhuma ameaça detetada. Continua tranquilo."
            count={`${dashboard.recentThreats.length}`}
          >
            {dashboard.recentThreats.slice(0, 5).map((threat, i) => (
              <div key={`${threat.createdAt}-${i}`} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-secondary/50 border border-border">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={cn("w-1.5 h-1.5 rounded-full shrink-0",
                    threat.severity === "critical" ? "bg-cyber-red"
                      : threat.severity === "high" ? "bg-cyber-yellow" : "bg-cyber-cyan",
                  )} />
                  <span className="text-xs font-mono text-foreground truncate">{threat.domain}</span>
                </div>
                <span className={cn(
                  "text-xs font-mono uppercase px-1.5 py-0.5 rounded border shrink-0",
                  threat.severity === "critical" ? "bg-cyber-red/10 text-cyber-red border-cyber-red/30"
                    : threat.severity === "high" ? "bg-cyber-yellow/10 text-cyber-yellow border-cyber-yellow/30"
                      : "bg-cyber-cyan/10 text-cyber-cyan border-cyber-cyan/30",
                )}>
                  {threat.severity}
                </span>
              </div>
            ))}
          </ListPanel>
        </div>

        <p className="-mt-1 text-xs font-mono text-muted-foreground">
          Estes cartões são o que o serviço leu. O histórico completo de eventos e ameaças está em
          <a href="/threats" className="underline hover:text-foreground">Ameaças</a>; o estado atual de proteção está acima, no "Estado de proteção".
        </p>
      </section>

      <ProtectionDetails engine={dashboard.engineHealth} level={level} open={detailsOpen} onClose={() => setDetailsOpen(false)} score={dashboard.riskScore ?? undefined} />
    </div>
  );
}

/**
 * O fato que explica o nível apresentado, do mais específico para o mais
 * geral. Não calcula estado novo: lê exatamente os mesmos campos de que
 * `deriveProtectionLevel` e `realtimeProtectionCopy` já dependem. Sem
 * candidato, devolve vazio e a linha não existe — explicar com uma hipótese
 * seria inventar uma causa.
 */
function motivoDoNivel(
  level: ProtectionLevel,
  status: ProtectionStatus,
  engine: EngineHealth | undefined,
  realtime: RealtimeProtectionInfo | undefined | null,
): string {
  if (realtime?.disponivel === false) return "o serviço não reportou o estado da proteção em tempo real";
  if (engine && engine.serviceRunning === false) return "o serviço de proteção não está a responder";
  if (realtime?.pausedUntil) return "a proteção em tempo real está em pausa";
  if (realtime?.enabled === false) return "a proteção em tempo real está desligada";
  const emErro = [engine?.yara, engine?.hashDb, engine?.clamav, engine?.nativeEngine, wfpHealth(engine)]
    .some((motor) => motor?.status === "error");
  if (emErro) return "um motor de análise está em erro";
  if (status === "critical") return "o estado medido pelo serviço é crítico";
  if (engine?.anyEngineDegraded) return "há motores de análise indisponíveis ou degradados";
  // Só afirma «todos ativos» quando os motores foram lidos e estão todos ativos;
  // sem leitura dos motores, o contador mostra 0 de N e o texto não contradiz.
  if (level === "protected") {
    const motores = explainProtectionScore(0, engine);
    return motores.activeEngines > 0 && motores.activeEngines === motores.totalEngines
      ? "todos os motores de análise estão ativos"
      : "o serviço não reportou o estado dos motores de análise";
  }
  return "";
}

interface EvidenceTileProps {
  icon: React.ElementType;
  label: string;
  value: string;
  /** De onde vem o facto. Vai para `title` — a UI não esconde a origem. */
  source: string;
  tone: "ok" | "warn" | "muted";
}

/**
 * Facto observado, com origem escrita. `Sem leitura` é um valor de primeira
 * classe: quando o serviço não reportou, o cartão di-lo em vez de mostrar zero.
 */
function EvidenceTile({ icon: Icon, label, value, source, tone }: EvidenceTileProps) {
  const iconTone =
    tone === "ok" ? "text-cyber-green" : tone === "warn" ? "text-cyber-yellow" : "text-muted-foreground";
  return (
    <div className="surface-lift flex items-center gap-2 px-2.5 py-2" title={source}>
      <Icon className={cn("h-3.5 w-3.5 shrink-0", iconTone)} aria-hidden />
      <div className="min-w-0 leading-tight">
        <span className="block font-mono text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className={cn("block truncate font-mono text-xs font-semibold", tone === "muted" ? "text-muted-foreground" : "text-foreground")}>
          {value}
        </span>
      </div>
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  icon: React.ElementType;
  color: "cyan" | "green" | "red" | "yellow" | "foreground";
  isText?: boolean;
  /** De onde vem o número. Passa ao `title`, para não deixar adivinhar. */
  fonte?: string;
}

/** Contagem discreta: o valor é que interessa, não a cor do ícone. */
function StatCard({ label, value, icon: Icon, color, isText, fonte }: StatCardProps) {
  const colorClasses: Record<StatCardProps["color"], string> = {
    cyan: "text-cyber-cyan",
    green: "text-cyber-green",
    red: "text-cyber-red",
    yellow: "text-cyber-yellow",
    foreground: "text-foreground",
  };

  return (
    <div className="stat-card px-3 py-2 flex items-center gap-2.5 min-w-[150px] flex-1" title={fonte}>
      <Icon className={cn("w-4 h-4 shrink-0", colorClasses[color])} />
      <div className="min-w-0">
        <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider block">{label}</span>
        <span className={cn("text-base font-bold font-mono", !isText && "tabular-nums", colorClasses[color])}>{value}</span>
      </div>
    </div>
  );
}

/** "MEDIUM" a gritar em maiúsculas não é linguagem de pessoa. */
const DOWNLOAD_RISK_LABEL: Record<Severity, string> = {
  low: "Baixo",
  medium: "Médio",
  high: "Alto",
  critical: "Crítico",
};

interface ScanButtonProps {
  label: string;
  sub: string;
  icon: React.ElementType;
  tone: "primary" | "ghost";
  scanType: "quick" | "full" | "custom";
  onScan?: (type: string, targetPath?: string) => void;
}

function ScanButton({ label, sub, icon: Icon, tone, scanType, onScan }: ScanButtonProps) {
  const handleClick = async () => {
    if (scanType === "custom") {
      // Botão "Pasta": tem de abrir o seletor de PASTAS, não de ficheiros.
      if (!window.electronAPI) return;
      const path = await window.electronAPI.openFolderDialog();
      if (!path) return;
      onScan?.("custom", path);
    } else {
      onScan?.(scanType);
    }
  };

  return (
    <button
      onClick={handleClick}
      title={sub}
      className={cn(
        "flex items-center gap-2 rounded-lg px-3 py-2 font-mono text-xs transition-all border",
        tone === "primary"
          ? "bg-primary/15 border-primary/40 text-[color:var(--hero-cta-ink)] font-semibold hover:bg-primary/25"
          : "bg-secondary/50 border-border text-foreground hover:bg-secondary",
      )}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      {label}
    </button>
  );
}

interface MetricBarProps {
  label: string;
  value: number;
  subValue?: string;
  icon: React.ElementType;
  /**
   * Aviso calculado pelo motor. Não se imprime aqui — a lista de prioridades
   * já o diz, e repeti-lo em cada cartão era a fonte do "ecrã todo em alerta".
   * Continua acessível no `title` da barra.
   */
  alertTitle?: string;
  hint?: string;
  sparkline?: React.ReactNode;
  /**
   * Valor a escrever no lugar da percentagem. A rede não é uma percentagem de
   * nada: é tráfego por segundo, e mostrá-la como "37%" inventava uma escala.
   */
  valueText?: string;
  /** Hierarquia: os dois cartões principais ocupam mais espaço no ecrã largo. */
  className?: string;
}

/**
 * Decimal em PT-PT: o separador é vírgula, sempre. `toFixed` devolve ponto
 * ("500.0 KB/s", "7.0 de 16 GB"), que no resto do produto já se corrige
 * (shared-types `numero()`, `toLocaleString("pt-PT")` no disco).
 */
function decimalPt(valor: number, casas = 1): string {
  if (!Number.isFinite(valor)) return "—";
  return valor.toFixed(casas).replace(".", ",");
}

function ramSubUsed(ram: HardwareSnapshot["ram"]): string {
  const used = typeof ram.usedGb === "number" && Number.isFinite(ram.usedGb) ? decimalPt(ram.usedGb) : "—";
  const total = typeof ram.totalGb === "number" && Number.isFinite(ram.totalGb) ? decimalPt(ram.totalGb) : "—";
  return `${used} de ${total} GB usados`;
}

function formatThroughput(bytes: number): string {
  if (!bytes) return "0 B/s";
  if (bytes < 1024) return `${bytes.toFixed(0)} B/s`;
  if (bytes < 1024 * 1024) return `${decimalPt(bytes / 1024)} KB/s`;
  return `${decimalPt(bytes / 1024 / 1024)} MB/s`;
}

function metricColor(val: number) {
  if (val < 60) return "bg-cyber-green";
  if (val < 85) return "bg-cyber-yellow";
  return "bg-cyber-red";
}

function MetricBar({ label, value, subValue, icon: Icon, alertTitle, hint, sparkline, valueText, className }: MetricBarProps) {
  const safeValue = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;

  return (
    <div className={cn("stat-card p-3 flex flex-col justify-between gap-1", className)} title={alertTitle}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          <span className="font-mono text-xs text-foreground font-semibold">{label}</span>
        </div>
        <span className="font-mono text-sm text-foreground font-semibold tabular-nums">{valueText ?? `${safeValue.toFixed(0)}%`}</span>
      </div>

      <div className="text-xs font-mono text-muted-foreground truncate">{subValue}</div>

      {sparkline && <div className="mt-1">{sparkline}</div>}

      <div className="mt-1">
        <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
          <div className={cn("h-full transition-all duration-500", metricColor(safeValue))} style={{ width: `${safeValue}%` }} />
        </div>
        {hint && <div className="text-xs font-mono text-muted-foreground mt-1 leading-snug">{hint}</div>}
      </div>
    </div>
  );
}

/**
 * Disco (FASE 3): por defeito a unidade do SISTEMA, DETETADA pelo motor
 * (`disk.primary`) e não assumida como "C:"; usado e livre, indicador de
 * ocupação, recomendação contextual, seletor para os outros volumes e detalhe
 * expansível.
 *
 * Fronteira de vocabulário: o que a leitura entrega são VOLUMES lógicos (partições
 * com letra). Não existe qualquer leitura de discos físicos no `HardwareSnapshot`,
 * por isso a lista diz "volume" e o cartão nunca afirma «disco 0» nem «SSD» —
 * misturar os dois era inventar uma topologia que ninguém mediu.
 *
 * Sem leitura não há número: a barra fica vazia e o motivo é escrito
 * (`diskReadLabel` + `diskUnavailableText`); "0%" e "sem leitura" voltavam a
 * confundir-se antes de 2026-10-09 e continuam separados.
 */
/**
 * GPU como cartão de apoio (TP-V2-VISUAL): deixa de ser uma linha "Secundário"
 * e passa a ler-se como os outros, sem inventar percentagem quando o motor não
 * a tem — nesse caso a barra fica vazia e o texto diz "sem leitura".
 */
function GpuMetric({
  gpu,
  temperatureText,
  alertTitle,
}: {
  gpu: NonNullable<HardwareSnapshot["gpu"]>;
  temperatureText: string;
  alertTitle?: string;
}) {
  const usage =
    typeof gpu.usagePercent === "number" ? Math.min(100, Math.max(0, gpu.usagePercent)) : null;
  const vramTotal = typeof gpu.vramTotalMb === "number" &&
    Number.isFinite(gpu.vramTotalMb) && gpu.vramTotalMb > 0 ? gpu.vramTotalMb : null;
  const vramUsed = typeof gpu.vramUsedMb === "number" &&
    Number.isFinite(gpu.vramUsedMb) && gpu.vramUsedMb >= 0 &&
    (vramTotal === null || gpu.vramUsedMb <= vramTotal) ? gpu.vramUsedMb : null;
  const vram = vramTotal !== null
    ? vramUsed !== null
      ? `${decimalPt(vramUsed / 1024)} de ${decimalPt(vramTotal / 1024)} GB`
      : `capacidade ${decimalPt(vramTotal / 1024)} GB · uso sem leitura`
    : vramUsed !== null ? `${decimalPt(vramUsed / 1024)} GB usados · capacidade sem leitura` : null;
  const sub = [vram ? `VRAM ${vram}` : "VRAM sem leitura", temperatureText].filter(Boolean).join(" · ");

  return (
    <div className="stat-card p-3 flex flex-col justify-between gap-1" title={alertTitle}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Layers className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          <span className="font-mono text-xs text-foreground font-semibold whitespace-nowrap">GPU</span>
          {gpu.model && <span className="font-mono text-xs text-muted-foreground truncate">{gpu.model}</span>}
        </div>
        <span className="font-mono text-sm font-semibold tabular-nums text-foreground whitespace-nowrap">
          {usage === null ? "sem leitura" : `${usage.toFixed(0)}%`}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-secondary overflow-hidden" aria-hidden>
        <div className="h-full rounded-full bg-primary" style={{ width: `${usage ?? 0}%` }} />
      </div>
      <div className="text-xs font-mono text-muted-foreground">{sub}</div>
    </div>
  );
}

function DiskMetric({ disk, alertTitle }: { disk: HardwareSnapshot["disk"]; alertTitle?: string }) {
  // `useNow` em vez de `Date.now()` no corpo do render (ver lib/diskDisplay).
  const agora = useNow();
  const trabalho = disk.volumes.filter((volume) => volume.kind === "working");
  const reservadas = disk.volumes.filter((volume) => volume.kind !== "working");
  const montagemDoSistema = disk.primary?.mount ?? null;
  const [montagem, setMontagem] = useState<string | null>(montagemDoSistema);
  // A escolha só se mantém se o volume continuar listado; senão volta ao que o
  // motor deteta como sistema — nunca a uma letra hardcoded.
  const alvo =
    trabalho.find((volume) => volume.mount === montagem) ??
    trabalho.find((volume) => volume.mount === montagemDoSistema) ??
    trabalho[0] ??
    null;
  const guidance = alvo ? describeDiskSpace(alvo.usedGb, alvo.totalGb) : null;
  const problema = diskUnavailableText(disk, agora);
  const linhas = diskVolumeRows(disk);
  const ocupacao = alvo ? Math.min(100, Math.max(0, alvo.usagePercent)) : null;

  return (
    <div className="stat-card p-3 flex flex-col justify-between gap-1" title={alertTitle}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <HardDrive className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          <span className="font-mono text-xs text-foreground font-semibold whitespace-nowrap">Disco</span>
          {alvo && (
            <>
              <span className="font-mono text-xs text-muted-foreground shrink-0">{alvo.mount}</span>
              {alvo.mount === montagemDoSistema && (
                <span className="rounded border border-border px-1 font-mono text-xs uppercase tracking-wide text-muted-foreground">
                  sistema
                </span>
              )}
            </>
          )}
        </div>
        <span
          className={cn(
            "font-mono text-sm font-semibold tabular-nums whitespace-nowrap",
            !guidance
              ? "text-muted-foreground"
              : guidance.urgency === "critical"
                ? "text-cyber-red"
                : guidance.urgency === "tight"
                  ? "text-cyber-yellow"
                  : "text-foreground",
          )}
        >
          {alvo ? `${formatGb(alvo.freeGb)} livres` : "—"}
        </span>
      </div>

      {alvo ? (
        <>
          <div className="text-xs font-mono text-muted-foreground truncate">
            usado {formatGb(alvo.usedGb)} de {formatGb(alvo.totalGb)} · {formatPercent(alvo.usagePercent)}
          </div>

          <div className="mt-1">
            <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
              {/* Barra só com medição: sem leitura, fica vazia (não a 0% "cheia de certeza"). */}
              {ocupacao !== null && (
                <div
                  className={cn("h-full transition-all duration-500", metricColor(ocupacao))}
                  style={{ width: `${ocupacao}%` }}
                />
              )}
            </div>
          </div>

          {/* A orientação é texto, não botão: não há ação de limpeza no backend. */}
          <div
            className={cn(
              "text-xs font-mono mt-1 leading-snug",
              guidance?.action ? "text-cyber-yellow" : "text-muted-foreground",
            )}
          >
            {guidance?.action || guidance?.meaning}
          </div>
        </>
      ) : (
        <div className="text-xs font-mono mt-1 leading-snug text-cyber-yellow">
          {diskReadLabel(disk)}: {problema ?? "sem volumes lidos"}
        </div>
      )}

      {/* Seletor de unidades: só aparece quando há mesmo mais do que um volume
          de trabalho, para não ser um controlo a mandar para lado nenhum. */}
      {trabalho.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 mt-1.5" role="group" aria-label="Escolher volume">
          {trabalho.map((volume) => (
            <button
              key={volume.mount}
              type="button"
              onClick={() => setMontagem(volume.mount)}
              aria-pressed={alvo?.mount === volume.mount}
              className={cn(
                "px-2 py-0.5 rounded border font-mono text-xs tabular-nums transition-colors",
                alvo?.mount === volume.mount
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-secondary/40 text-muted-foreground hover:text-foreground",
              )}
            >
              {volume.mount}
            </button>
          ))}
        </div>
      )}

      <details className="mt-1">
        <summary className="cursor-pointer list-none text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground">
          Detalhe das unidades
        </summary>
        {problema && (
          <p className="mt-1 text-xs font-mono text-cyber-yellow leading-snug">
            {diskReadLabel(disk)}: {problema}
          </p>
        )}
        <ul className="mt-1 space-y-0.5">
          {linhas.map((linha) => (
            <li key={linha.mount} className="text-xs font-mono text-muted-foreground">
              {`${linha.mount} · ${linha.totalText} no total · ${linha.usagePercentText} usado` +
                ` · ${linha.freeText} livres${linha.fileSystem ? ` · ${linha.fileSystem}` : ""}` +
                `${linha.kind === "system-reserved" ? " · " + linha.kindLabel : ""}`}
            </li>
          ))}
        </ul>
        {reservadas.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground leading-snug">
            As partições de sistema não se escolhem: não têm espaço para libertar.
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground leading-snug">
          São volumes lógicos (partições com letra). O CyberSafe não lê discos físicos, por isso não
          indica modelo nem «disco 0».
        </p>
      </details>
    </div>
  );
}

interface ListPanelProps {
  title: string;
  icon: React.ElementType;
  count: string;
  /** Copy do empty state — uma linha, sem ícone gigante. */
  empty: string;
  children: React.ReactNode;
}

function ListPanel({ title, icon: Icon, count, empty, children }: ListPanelProps) {
  const hasItems = Array.isArray(children) ? children.length > 0 : !!children;

  return (
    <div className="stat-card p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-mono text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-2">
          <Icon className="w-3.5 h-3.5 text-muted-foreground" />
          {title}
        </h3>
        <span className="text-xs font-mono text-muted-foreground tabular-nums">{count}</span>
      </div>
      {hasItems ? (
        <div
          className="space-y-1.5 max-h-36 overflow-y-auto pr-1"
          style={{ scrollbarWidth: "thin", scrollbarColor: "color-mix(in oklch, var(--muted-foreground) 30%, transparent) transparent" }}
        >
          {children}
        </div>
      ) : (
        <p className="flex items-center gap-2 py-2 text-xs font-mono text-muted-foreground">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-cyber-green" />
          {empty}
        </p>
      )}
    </div>
  );
}

// ── PC State / Findings Overview ──
// Os dados vêm já calculados do backend (PcStateEngine). A UI apenas apresenta.

const LEVEL_META: Record<PcStateLevel, { label: string; chipClass: string; textClass: string; dotClass: string }> = {
  good: {
    label: "Boa",
    chipClass: "bg-cyber-green/10 border-cyber-green/30",
    textClass: "text-cyber-green",
    dotClass: "bg-cyber-green",
  },
  attention: {
    label: "Atenção",
    chipClass: "bg-cyber-yellow/10 border-cyber-yellow/30",
    textClass: "text-cyber-yellow",
    dotClass: "bg-cyber-yellow",
  },
  critical: {
    label: "Crítico",
    chipClass: "bg-cyber-red/10 border-cyber-red/30",
    textClass: "text-cyber-red",
    dotClass: "bg-cyber-red",
  },
  unknown: {
    label: "Desconhecida",
    chipClass: "bg-secondary/40 border-border",
    textClass: "text-muted-foreground",
    dotClass: "bg-muted-foreground",
  },
};

/**
 * Palavra para o veredicto global do motor de estado (`pcState.overall`). É a
 * mesma escala do motor, só com substantivo neutro: as etiquetas por categoria
 * são femininas ("Boa") e colá-las a "Estado do PC" dava frases tortas.
 */
const OVERALL_LABEL: Record<PcStateLevel, string> = {
  good: "Estável",
  attention: "Atenção",
  critical: "Crítico",
  unknown: "Sem leitura",
};

function severityChip(f: Finding) {
  const base = "text-xs font-mono uppercase px-2 py-1 rounded border";
  if (f.severity === "urgent") {
    return cn(base, "bg-cyber-red/10 text-cyber-red border-cyber-red/30");
  }
  if (f.severity === "attention") {
    return cn(base, "bg-cyber-yellow/10 text-cyber-yellow border-cyber-yellow/30");
  }
  if (f.severity === "recommended") {
    return cn(base, "bg-cyber-cyan/10 text-cyber-cyan border-cyber-cyan/30");
  }
  return cn(base, "bg-secondary/40 text-muted-foreground border-border");
}

/**
 * Quantos achados partilham a prioridade de um achado. Lê `pcState.counts`,
 * que o service derivou — a UI não conta nada, só mostra.
 */
function contagemPrioridade(severity: Finding["severity"], counts: PcState["counts"]): number {
  return counts[severity];
}

/** Rótulo de um bloco, com o nome visível — o utilizador tem de saber o que lê. */function Bloco({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="mt-1.5">
      <div className="text-xs font-mono uppercase tracking-widest text-muted-foreground/70">{titulo}</div>
      {children}
    </div>
  );
}

/**
 * WS-B — DADO humano dos motores, RENDERIZADO pela página.
 * Uma linha por componente que o serviço mediu como não-operacional: nome +
 * estado em PT-PT + o que significa. Nenhum token interno ("degraded",
 * "unavailable"), nenhum path do provider, nenhuma mensagem crua. As
 * condições vêm do `engineHealth` medido — nada é afirmado sem leitura.
 */
function engineDadoLinhas(engine: EngineHealth): string[] {
  const linhas: string[] = [];

  if (engine.clamav && engine.clamav.status !== "active") {
    if (engine.clamav.status === "degraded") {
      linhas.push("ClamAV: Degradado — Motor instalado, mas a base de assinaturas antivírus ainda não está disponível.");
      linhas.push("As assinaturas precisam de ser instaladas ou atualizadas antes de o ClamAV poder contribuir plenamente para a análise.");
    } else if (engine.clamav.status === "unavailable") {
      linhas.push("ClamAV: Indisponível — o motor antivírus não está disponível neste computador.");
    } else {
      linhas.push("ClamAV: Erro — o motor antivírus reporta um erro.");
    }
  }

  const wfp = wfpHealth(engine);
  if (wfp && wfp.status !== "active") {
    if (wfp.status === "degraded") {
      linhas.push("Filtro WFP do CyberSafe: Degradado — O filtro de rede próprio do CyberSafe não está a funcionar como esperado.");
    } else if (wfp.status === "unavailable") {
      linhas.push("Filtro WFP do CyberSafe: Indisponível — O filtro de rede próprio do CyberSafe não está ativo.");
    } else {
      linhas.push("Filtro WFP do CyberSafe: Erro — O filtro de rede próprio do CyberSafe reporta um erro.");
    }
    // O nosso filtro não diz nada do firewall da Microsoft — o disclaimer vai
    // com a linha, em todos os estados.
    linhas.push("Isto não significa que o Firewall do Windows esteja desligado.");
  }

  if (engine.yara && engine.yara.status !== "active") {
    linhas.push(
      engine.yara.status === "degraded"
        ? "YARA: Degradado — o motor de análise por regras não está totalmente operacional."
        : engine.yara.status === "unavailable"
          ? "YARA: Indisponível — o motor de análise por regras não está ativo."
          : "YARA: Erro — o motor de análise por regras reporta um erro.",
    );
  }

  if (engine.hashDb && engine.hashDb.status !== "active") {
    linhas.push(
      engine.hashDb.status === "degraded"
        ? "Base de assinaturas: Degradado — a base local de assinaturas não está totalmente operacional."
        : engine.hashDb.status === "unavailable"
          ? "Base de assinaturas: Indisponível — a base local de assinaturas não está carregada."
          : "Base de assinaturas: Erro — a base local de assinaturas reporta um erro.",
    );
  }

  if (engine.nativeEngine && engine.nativeEngine.status !== "active") {
    linhas.push(
      engine.nativeEngine.status === "degraded"
        ? "Motor nativo: Degradado — o motor nativo de análise não está totalmente operacional."
        : engine.nativeEngine.status === "unavailable"
          ? "Motor nativo: Indisponível — o motor nativo de análise não está disponível."
          : "Motor nativo: Erro — o motor nativo de análise reporta um erro.",
    );
  }

  return linhas;
}

export interface PcStateAttentionProps {
  pcState: PcState;
  engine?: EngineHealth;
  /**
   * Fato do tempo real (lido do serviço). Só com `enabled === false` ou pausa
   * real é que a ação "ativar" é oferta honesta; sem leitura não se oferece
   * nada, porque não se sabe o que está desligado.
   */
  realtime?: RealtimeProtectionInfo;
  /** O contrato real de ativação (`monitor.start`). Ausente => sem botão. */
  onSetProtection?: (enabled: boolean) => void;
  /** Ligação ao serviço e pedido em voo: sem isto o botão seria decorativo. */
  serviceConnected?: boolean | null;
  protectionPending?: ProtectionPending;
}

export function PcStateAttention({ pcState, engine, realtime, onSetProtection, serviceConnected = null, protectionPending = null }: PcStateAttentionProps) {
  const { principalFinding, findings } = pcState;
  const problems = findings.filter((f) => f.severity === "urgent" || f.severity === "attention");
  const principal = principalFinding ? buildFindingGuidance(principalFinding) : null;
  // A finding dos motores tem copy humana própria nesta página (WS-B); os
  // restantes achados continuam pelo caminho genérico do motor.
  const ehFindingMotores = !!principalFinding
    && principalFinding.source === "protection-engine"
    && String(principalFinding.id).startsWith("security:engine");
  const dadoLinhas = engine && ehFindingMotores ? engineDadoLinhas(engine) : principal?.dado ?? [];

  // A ação destacada só existe quando há um contrato real atrás dela: leitura
  // concreta de "desligada" ou "em pausa", serviço ligado e nenhum pedido voo.
  // O resto é texto de orientação — nunca um botão que não executa nada.
  const emPausa = typeof realtime?.pausedUntil === "string" && realtime.pausedUntil.trim() !== "";
  const desligada = realtime?.enabled === false;
  const podeAtivar = !!onSetProtection && (desligada || emPausa) && serviceConnected === true && protectionPending === null;

  return (
    <div className={cn(
      "rounded-xl border p-3 lg:p-4 space-y-2.5",
      pcState.overall === "critical"
        ? "border-cyber-red/30 bg-cyber-red/[0.03]"
        : "border-cyber-yellow/30 bg-cyber-yellow/[0.03]",
    )}>
      {principalFinding && principal && (
        <>
          {/* Uma linha: prioridade + título. O que costumava ser uma caixa de
              quatro blocos abertos passa a ser isto, e o resto é expansível. */}
          <div className="flex items-start gap-2.5">
            <span
              className={cn(
                "mt-1 w-2 h-2 rounded-full shrink-0",
                principalFinding.severity === "urgent" ? "bg-cyber-red" : "bg-cyber-yellow",
              )}
            />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className={cn(
                  "text-xs font-mono font-bold uppercase tracking-wider",
                  principalFinding.severity === "urgent" ? "text-cyber-red" : "text-cyber-yellow",
                )}>{FINDING_SEVERITY_LABEL[principalFinding.severity]}</span>
                <h3 className="text-sm font-mono font-semibold text-foreground leading-snug">{principalFinding.title}</h3>
              </div>
              {/* SIGNIFICADO — o `summary` do motor, verbatim. É a frase que
                  responde a "porque é que isto me diz alguma coisa?". */}
              <p className="mt-1 text-sm text-foreground leading-relaxed">{principal.significado}</p>
            </div>
          </div>

          {/* AÇÃO — só com contrato real. `type="button"` num ecrã que não é
              um formulário, e rótulo do que efetivamente acontece. */}
          {podeAtivar && (
            <div className="pl-[18px]">
              <button
                type="button"
                onClick={() => onSetProtection?.(true)}
                className="px-3 py-2 rounded-lg font-mono text-xs font-semibold border border-cyber-green/40 bg-cyber-green/10 text-cyber-green hover:brightness-110 transition-all"
              >
                {emPausa && !desligada ? "Retomar proteção agora" : "Ativar proteção"}
              </button>
              <p className="mt-1 text-xs text-muted-foreground">
                Usa o mesmo pedido do controlo de proteção; o estado volta a ser lido ao serviço, não é afirmado por aqui.
              </p>
            </div>
          )}

          {/* DETALHE TÉCNICO — colapsado por defeito. Nada é escondido do
              utilizador que quer ver: Dado, Prioridade e Orientação continuam
              todos aqui, verbatim. */}
          {(dadoLinhas.length > 0 || principal.orientacao) && (
            <details className="pl-[18px] group">
              <summary className="cursor-pointer list-none text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground">
                Detalhe técnico
              </summary>
              <div className="mt-2 space-y-2">
                {dadoLinhas.length > 0 && (
                  <Bloco titulo="Dado">
                    <ul className="mt-0.5 space-y-0.5">
                      {dadoLinhas.map((linha) => (
                        <li key={linha} className="text-xs font-mono text-foreground">{linha}</li>
                      ))}
                    </ul>
                  </Bloco>
                )}
                <Bloco titulo="Prioridade">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {principal.prioridade} — {contagemPrioridade(principalFinding.severity, pcState.counts)} achado(s) com esta prioridade.
                  </p>
                </Bloco>
                {/* ORIENTAÇÃO — o que o produto sabe mesmo fazer, e nada mais.
                    Não há botão aqui: a única ação executável está acima, e só
                    aparece com contrato real. */}
                {principal.orientacao && (
                  <Bloco titulo="Orientação">
                    <p className="text-xs text-muted-foreground leading-relaxed">{principal.orientacao}</p>
                  </Bloco>
                )}
              </div>
            </details>
          )}
        </>
      )}

      {problems.length > 1 && (
        <div className="space-y-1.5 pl-[18px]">
          {problems.filter((f) => f.id !== principalFinding?.id).slice(0, 3).map((f) => {
            const g = buildFindingGuidance(f);
            return (
              <div key={f.id} className="p-2 rounded-lg bg-secondary/50 border border-border space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono text-foreground">{f.title}</span>
                  <span className={severityChip(f)}>{FINDING_SEVERITY_LABEL[f.severity]}</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{g.significado}</p>
                {g.dado.length > 0 && (
                  <details>
                    <summary className="cursor-pointer list-none text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground">
                      Detalhe técnico
                    </summary>
                    <ul className="mt-1 space-y-0.5">
                      {g.dado.map((linha) => (
                        <li key={linha} className="text-xs font-mono text-foreground">{linha}</li>
                      ))}
                    </ul>
                    {g.orientacao && (
                      <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{g.orientacao}</p>
                    )}
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
