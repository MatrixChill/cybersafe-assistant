import { SecurityEventMessage } from "../components/SecurityEventMessage";
import { securityEventPresentation } from "@/lib/securityEventPresentation";
import { useState } from "react";
import { Activity, AlertTriangle, Clock, Globe, Shield, Terminal, Lock, FileSearch, Download, Info, ChevronDown, ChevronRight } from "lucide-react";
import type {
  ConnectionSnapshot,
  ProcessSnapshot,
  ProtectionState,
  QuarantineEntry,
  SecurityEvent,
  ProcessEnumerationTruth,} from "@cybersafe/shared-types";
import { cn } from "@/lib/utils";
import { protectionStatusText } from "@/lib/protectionHealth";
import { buildEventRows, startedGroupLabel } from "@/lib/eventRows";
import { engineHealthPresentation } from "@/lib/engineHealthPresentation";
// A frescura da enumeração de processos tem UM avaliador em toda a aplicação:
// `lib/processListState`. O Monitor consome-o; não volta a decidir nada à mão.
// São DOIS eixos e os dois são obrigatórios: `estadoDaListaDeProcessos` diz o
// que a área vazia significa; `avisoDeEnumeracao`/`listaDesactualizada` dizem o
// que as LINHAS em ecrã significam — sem eles, uma foto antiga com 165 linhas
// passava por presente, porque com linhas `estadoDaLista` é `ok` por desenho.
import {
  avisoDeEnumeracao,
  estadoDaListaDeProcessos,
  listaDesactualizada,
  rotuloDoEstadoDaLista,
  rotuloDaLinhaAntiga,
} from "@/lib/processListState";

interface MonitorPageProps {
  events: SecurityEvent[];
  processes: ProcessSnapshot[];
  /**
   * Frescura da enumeração, vinda do MESMO estado que alimenta o Gestor de
   * Tarefas (`lib/processListState`). O Monitor não pergunta ao serviço nem
   * carimba a hora no cliente — apenas mostra o que a infra de processos
   * (ownership Freepi) já afirmou. Sem estas três entradas, «N processos no
   * sistema» seria lido como facto quando pode ser «nunca houve resposta».
   */
  processesObservedAt?: number | null;
  processTruth?: ProcessEnumerationTruth | null;
  serviceConnected?: boolean | null;
  connections: ConnectionSnapshot[];
  protection: ProtectionState | null;
  quarantine: QuarantineEntry[];
}

// Traduz os tipos de evento para mensagens legíveis por qualquer pessoa.
export type EventCategory = "all" | "security" | "processes" | "scans" | "system";

export const EVENT_CATEGORIES: { id: EventCategory; label: string }[] = [
  { id: "all", label: "Todos" },
  { id: "security", label: "Segurança" },
  { id: "processes", label: "Processos" },
  { id: "scans", label: "Ficheiros e Análises" },
  { id: "system", label: "Motores e Quarentena" },
];

export function getEventCategory(type: string): EventCategory {
  if (
    type.startsWith("threat.") ||
    type === "process.blocked" ||
    type === "process.killed" ||
    type === "process.suspicious" ||
    type === "persistence.detected"
  ) {
    return "security";
  }
  if (type === "process.started" || type === "process.exited") {
    return "processes";
  }
  if (
    type === "artifact.analyzed" ||
    type === "file.created" ||
    type === "file.modified" ||
    type === "scan.progress"
  ) {
    return "scans";
  }
  if (type === "engine.health" || type.startsWith("quarantine.") || type === "trust.updated") {
    return "system";
  }
  return "system";
}
const EVENT_LABELS: Record<string, { label: string; icon: typeof Info; tone: "danger" | "warning" | "info" | "ok" }> = {
  "threat.detected": { label: "Ameaça detetada", icon: AlertTriangle, tone: "danger" },
  "process.blocked": { label: "Processo bloqueado", icon: Lock, tone: "danger" },
  "process.killed": { label: "Processo encerrado", icon: Lock, tone: "danger" },
  // WS-2B: sinal heuristico de command line — NAO e ameaca confirmada, e um
  // sinal a rever. Sem kill automatico. Tone de atencao, nao info.
  "process.suspicious": { label: "Sinal a rever", icon: AlertTriangle, tone: "warning" },
  "process.started": { label: "Processo iniciado", icon: Activity, tone: "info" },
  "process.exited": { label: "Saída observada", icon: Activity, tone: "info" },
  "persistence.detected": { label: "Persistência suspeita", icon: AlertTriangle, tone: "warning" },
  "artifact.analyzed": { label: "Ficheiro analisado", icon: FileSearch, tone: "info" },
  "quarantine.added": { label: "Colocado em quarentena", icon: Shield, tone: "warning" },
  "quarantine.restored": { label: "Recuperado da quarentena", icon: Shield, tone: "ok" },
  "file.created": { label: "Novo ficheiro", icon: FileSearch, tone: "info" },
  "file.modified": { label: "Ficheiro modificado", icon: FileSearch, tone: "info" },
  "scan.progress": { label: "Análise em curso", icon: FileSearch, tone: "info" },
  "trust.updated": { label: "Confiança atualizada", icon: Shield, tone: "ok" },
  "engine.health": { label: "Estado do motor", icon: Download, tone: "warning" },
};

function describeEvent(event: SecurityEvent): string {
  if (event.type === "engine.health") return engineHealthPresentation(event).description;
  if (event.type === "process.exited" || event.type === "process.killed") return securityEventPresentation(event).text;
  if (event.summary) return event.summary;
  return event.type.replace(/[._]/g, " ");
}

/**
 * O estado vazio do HISTÓRICO DE SEGURANÇA, dito pelo único facto que a página
 * tem: o estado de proteção confirmado pelo serviço.
 *
 * Porque isto existe: a página mostrava «Sem dados de telemetria» a piscar ao lado
 * de 496 processos, e a leitura natural era «o Monitor está partido». Não está.
 * As duas coisas são eixos diferentes:
 *   · `processes` é o INVENTÁRIO lido ao sistema a pedido — existe com proteção
 *     ligada ou desligada;
 *   · `events` é o REPLAY recente do serviço (memória de 500 eventos), alimentado
 *     pelo `bindEventBus()`. Não é um arquivo completo, e não é a lista de
 *     processos.
 * Dizer «sem eventos» sem dizer de que eixo se trata é a mentira por omissão.
 *
 * Duas asneiras que este texto não pode cometer, ambas refutadas no próprio
 * serviço:
 *  1. proteção contínua desligada NÃO quer dizer «não há eventos». Um scan manual
 *     publica `scan.progress` e `artifact.analyzed`; `engine.health`, quarentena e
 *     ameaças chegam ao bus com a proteção desligada — os rótulos desta página
 *     listam esses tipos. Era a mentira na direção contrária.
 *  2. `events.list` é replay limitado a 500, portanto vazio NÃO prova «nenhum
 *     evento desde que o serviço iniciou»; prova que não há nenhum no que o
 *     serviço retém em memória.
 *
 * `protectionEnabled` é a flag que o próprio tipo documenta: `undefined` quer
 * dizer NÃO LIDO, nunca «desligado». Por isso há três saídas e a desconhecida é
 * dita como desconhecida.
 */
export function estadoVazioEventos(protection: ProtectionState | null): { titulo: string; detalhe: string } {
  if (protection?.protectionEnabled === true) {
    return {
      titulo: "Sem eventos no replay recente",
      detalhe: "O serviço mostra os últimos eventos que retém em memória, até 500 — não um arquivo completo. Um evento aparece assim que algo é analisado, observado ou bloqueado.",
    };
  }
  if (protection?.protectionEnabled === false) {
    return {
      titulo: "A proteção contínua está desligada",
      detalhe: "Isso não quer dizer que não possa haver eventos: análises manuais, estado dos motores e quarentena também publicam eventos. A lista de processos em baixo é uma leitura separada, feita ao sistema.",
    };
  }
  return {
    titulo: "Estado da proteção não confirmado",
    detalhe: "O serviço não confirmou se a proteção contínua está a correr, por isso não se sabe o que estará a ser observado. O inventário de processos é independente desta leitura.",
  };
}

export function EventLine({ event }: { event: SecurityEvent }) {
  const provenance=securityEventPresentation(event).provenance;
  const meta = event.type === "process.killed"
    ? {label:provenance === "confirmed" ? "Terminação confirmada" : provenance === "requested" ? "Terminação solicitada" : "Proveniência desconhecida",icon:Info,tone:"info" as const}
    : event.type === "engine.health"
    ? { ...engineHealthPresentation(event), icon: Info }
    : EVENT_LABELS[event.type] ?? {
    label: event.type.replace(/[._]/g, " "),
    icon: Info,
    tone: "info" as const,
  };
  const Icon = meta.icon;
  return (
    <div className="flex flex-wrap items-start gap-2.5 hover:bg-secondary/50 px-2 py-1.5 rounded transition-colors group">
      <Icon className={cn(
        "w-3.5 h-3.5 shrink-0",
        meta.tone === "danger" ? "text-cyber-red"
          : meta.tone === "warning" ? "text-cyber-yellow"
          : meta.tone === "ok" ? "text-cyber-green"
          : "text-cyber-cyan",
      )} />
      <span className="text-muted-foreground shrink-0">{new Date(event.timestamp).toLocaleTimeString()}</span>
      <span className={cn(
        "shrink-0 px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase",
        meta.tone === "danger" ? "border-cyber-red/40 text-cyber-red"
          : meta.tone === "warning" ? "border-cyber-yellow/40 text-cyber-yellow"
          : meta.tone === "ok" ? "border-cyber-green/40 text-cyber-green"
          : "border-cyber-cyan/40 text-cyber-cyan",
      )}>
        {meta.label}
      </span>
      <div className="text-foreground min-w-0 grow basis-64">{event.type === "engine.health" ? <span tabIndex={0} className="block max-h-32 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{describeEvent(event)}</span> : <SecurityEventMessage event={event} />}</div>
    </div>
  );
}

export default function MonitorPage({
  events,
  processes,
  processesObservedAt = null,
  processTruth = null,
  serviceConnected = null,
  connections,
  protection,
  quarantine,
}: MonitorPageProps) {
  const [activeCategory, setActiveCategory] = useState<EventCategory>("all");
  const filteredEvents = events.filter((ev) => {
    if (activeCategory === "all") return true;
    return getEventCategory(ev.type) === activeCategory;
  });
  const latestEvents = [...filteredEvents].sort((a, b) => b.sequence - a.sequence).slice(0, 50);
  // Agregacao puramente apresentativa dos `process.started` do mesmo nome:
  // a lista cru (50) mantem-se, nenhum evento sai do store nem e filtrado.
  const rows = buildEventRows(latestEvents);
  // O que dizer quando o histórico está vazio depende do estado CONFIRMADO da
  // proteção, não de uma suposição — ver `estadoVazioEventos`.
  const vazio = estadoVazioEventos(protection);
  /**
   * A tabela é uma AMOSTRA, e o rótulo tinha de dizer isso. Porque isto existe:
   * a legenda dizia «N processos lidos ao sistema» sobre 20 linhas, e a leitura
   * natural era que aquelas 20 eram N. O número em cima e as linhas em baixo têm
   * de vir da mesma conta — `processes.length` é o inventário, `mostrados` é o
   * que está mesmo em ecrã. A lista completa e ordenada vive no Gestor de Tarefas.
   */
  const mostrados = processes.slice(0, 20);
  /**
   * O número «Processos no sistema» só diz o que parece quando há leitura
   * válida. Aqui não se decide nada de novo: chama-se o MESMO avaliador que o
   * Gestor de Tarefas usa, portanto as duas páginas não podem contradizer-se
   * sobre a mesma enumeração. Quando `rotulo` é `null` a leitura está confirmada
   * e não se acrescenta ruído.
   */
  const rotuloLista = rotuloDoEstadoDaLista(
    estadoDaListaDeProcessos({
      total: processes.length,
      visiveis: mostrados.length,
      pesquisa: "",
      servicoLigado: serviceConnected,
      observadoEm: processesObservedAt,
      verdade: processTruth,
    }),
  );
  /**
   * O segundo eixo, que faltava no v2. Com `total > 0` e linhas visíveis,
   * `estadoDaListaDeProcessos` devolve `ok` — é o desenho dele (decide a área
   * vazia) — e por isso a falha de enumeração e a idade da foto desapareciam da
   * página exactamente quando havia linhas para esconder essa verdade.
   *
   * Não se inventa nada aqui: chamam-se as mesmas funções que o Gestor de
   * Tarefas chama, com os mesmos três factos que já vinham do App. A idade vem
   * de `verdade.asOf - verdade.enumeratedAt`, carimbados pelo serviço; o Monitor
   * não lê relógio nenhum.
   */
  const avisoEnumeracao = avisoDeEnumeracao(processTruth, processes.length);
  const fotografiaAntiga =
    processes.length > 0 &&
    listaDesactualizada({
      total: processes.length,
      servicoLigado: serviceConnected,
      observadoEm: processesObservedAt,
    });
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tight">
            Eventos de Segurança
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Histórico de segurança em direto · o inventário de processos é uma leitura separada
          </p>
        </div>

        <div className="flex items-center gap-2 px-4 py-2 bg-secondary rounded-lg">
          <Clock className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-mono text-muted-foreground">Estado:</span>
          <span className="text-sm font-mono text-foreground font-bold">
            {protection?.status
              ? protectionStatusText(protection.status)
              : "Sem dados do serviço"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <MetricCard label="Eventos de segurança" value={events.length} />
        <MetricCard
          label="Processos no sistema"
          value={processes.length}
          // Sem leitura válida não há contagem: o número 0 aqui era lido como
          // «não há processos» quando significa «o serviço não respondeu».
          valorText={rotuloLista ? rotuloLista.carregando ? "…" : "sem leitura" : undefined}
          nota={
            rotuloLista?.titulo ??
            avisoEnumeracao?.titulo ??
            (fotografiaAntiga ? "Processos de uma leitura antiga" : undefined)
          }
        />
        <MetricCard label="Conexões" value={connections.length} />
        <MetricCard label="Quarentena" value={quarantine.length} />
      </div>

      {/*
        O aviso sobre as linhas, não sobre a área vazia. Vai acima dos cartões
        de conteúdo porque diz respeito ao número que se acabou de ler: «165
        processos» sem esta faixa é exactamente a contradição que a revisão
        apontou. `role="status"` porque é uma mudança de estado, não um texto
        estático da página.
      */}
      {(avisoEnumeracao || fotografiaAntiga) && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-cyber-yellow/40 bg-cyber-yellow/10 px-4 py-3"
        >
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-cyber-yellow" />
          <div className="text-sm font-mono space-y-0.5">
            <p className="text-foreground font-semibold">
              {avisoEnumeracao?.titulo ?? "A lista de processos é de uma leitura antiga"}
            </p>
            <p className="text-muted-foreground">
              {avisoEnumeracao?.detalhe ?? rotuloDaLinhaAntiga({ servicoLigado: serviceConnected })}
            </p>
          </div>
        </div>
      )}

      <div className="cyber-border relative flex min-h-[320px] flex-col overflow-hidden rounded-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 py-3 px-4 border-b border-border/50 bg-sidebar/30">
          <div className="flex items-center gap-2.5 text-sm font-semibold text-foreground">
            <Terminal className="w-4 h-4 text-primary" />
            Histórico de eventos
            <span className="font-mono text-xs font-normal text-muted-foreground">
              {activeCategory === "all" ? `últimos ${latestEvents.length}` : `${latestEvents.length} em ${EVENT_CATEGORIES.find((c) => c.id === activeCategory)?.label ?? activeCategory}`}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Filtro de categorias de eventos">
            {EVENT_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                role="tab"
                aria-selected={activeCategory === cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={cn(
                  "px-2.5 py-1 rounded text-xs font-mono transition-colors border",
                  activeCategory === cat.id
                    ? "bg-primary text-primary-foreground border-primary font-semibold shadow-sm"
                    : "bg-secondary/40 text-muted-foreground border-transparent hover:text-foreground hover:bg-secondary"
                )}
              >
                {cat.label}
              </button>
            ))}
          </div>
          {/* O nome do ficheiro deixa de ser o título da página e passa a
              diagnóstico consultável: quem precisa do detalhe técnico abre. */}
          <details className="ml-auto text-right">
            <summary className="cursor-pointer font-mono text-xs text-muted-foreground hover:text-foreground">
              Detalhes técnicos
            </summary>
            <code className="mt-1 block font-mono text-xs text-muted-foreground">
              security_event_bus.log
            </code>
          </details>
        </div>
        <div className="p-0 flex-1 flex flex-col bg-black/40 font-mono text-[11px] relative">
          <div className="flex-1 overflow-y-auto p-4 space-y-1.5 scrollbar-hide">
            {latestEvents.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center gap-1.5 px-6 py-10 text-center">
                <span className="text-sm font-medium">{vazio.titulo}</span>
                <span className="text-muted-foreground text-xs leading-relaxed max-w-[52ch]">{vazio.detalhe}</span>
                <span className="text-muted-foreground text-[11px] mt-1">
                  {processes.length} {processes.length === 1 ? "processo" : "processos"} no inventário recebido &nbsp;&middot;&nbsp; zero eventos de segurança em memória
                </span>
              </div>
            ) : (
              rows.map((row) => {
                if (row.kind === "single") {
                  return <EventLine key={row.key} event={row.event} />;
                }
                const expanded = expandedGroups.has(row.key);
                const latest = row.events[0];
                const Chevron = expanded ? ChevronDown : ChevronRight;
                return (
                  <div key={row.key}>
                    <div className="flex flex-wrap items-start gap-2.5 hover:bg-secondary/50 px-2 py-1.5 rounded transition-colors group">
                      <Activity className="w-3.5 h-3.5 shrink-0 text-cyber-cyan" />
                      <span className="text-muted-foreground shrink-0">{new Date(latest.timestamp).toLocaleTimeString()}</span>
                      <span className="shrink-0 px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase border-cyber-cyan/40 text-cyber-cyan">
                        {EVENT_LABELS["process.started"].label}
                      </span>
                      <span className="text-foreground shrink-0">{row.name}</span>
                      <span className="text-muted-foreground grow">{startedGroupLabel(row.events.length)}</span>
                      <button
                        type="button"
                        onClick={() => toggleGroup(row.key)}
                        aria-expanded={expanded}
                        className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded border border-border/60 text-[9px] uppercase tracking-wider text-muted-foreground hover:text-foreground hover:border-border transition-colors"
                      >
                        <Chevron className="w-3 h-3" />
                        {expanded ? "ocultar" : "expandir"}
                      </button>
                    </div>
                    {expanded && (
                      <div className="ml-6 pl-2 border-l border-border/40 space-y-1.5 py-1.5">
                        {row.events.map((event) => (
                          <EventLine key={event.id} event={event} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div className="cyber-border rounded-xl p-6">
        {/* Grupos por metadados reais do serviço. */}
        <div className="flex items-center justify-between mb-6">
          <h3 className="font-mono font-semibold text-foreground flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary" />
            Processos Ativos
          </h3>
          <span className="text-xs font-mono text-muted-foreground">
            {processes.length === 0
              ? "Nenhum processo no inventário recebido"
              : `${mostrados.length} de ${processes.length} ${
                  processes.length === 1 ? "processo" : "processos"
                } · a lista completa e ordenada está no Gestor de Tarefas`}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">Processo</th>
                <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">PID</th>
                <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">CPU</th>
                <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">Memória</th>
                <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">Confiança</th>
              </tr>
            </thead>
            <tbody>
              {mostrados.map((process) => (
                <tr key={process.pid} className="border-b border-border/50 hover:bg-secondary/30 transition-colors">
                  <td className="py-3 px-4"><span className="font-mono text-sm text-foreground">{process.name}</span></td>
                  <td className="py-3 px-4"><span className="font-mono text-xs text-muted-foreground">{process.pid}</span></td>
                  <td className="py-3 px-4"><span className="font-mono text-xs text-muted-foreground">{process.cpu.toFixed(1)}%</span></td>
                  <td className="py-3 px-4"><span className="font-mono text-xs text-muted-foreground">{process.memoryMb.toFixed(0)} MB</span></td>
                  <td className="py-3 px-4"><span className="font-mono text-xs uppercase text-primary">{process.trusted}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="cyber-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="font-mono font-semibold text-foreground flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" />
            Camada de Contenção de Rede
          </h3>
          <span className="text-xs font-mono text-muted-foreground">Contenção básica apenas</span>
        </div>

        <div className="space-y-2">
          {connections.length === 0 ? (
            <div className="text-sm text-muted-foreground">Sem conexões observadas.</div>
          ) : (
            connections.slice(0, 20).map((connection, index) => (
              <div key={`${connection.remoteAddress}-${index}`} className="p-3 rounded-lg bg-secondary/30 flex items-center justify-between">
                <div className="text-sm font-mono text-foreground">{connection.remoteAddress}</div>
                <div className="text-xs text-muted-foreground">{connection.protocol ?? "tcp"}:{connection.remotePort ?? "-"}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  valorText,
  nota,
}: {
  label: string;
  value: number;
  /** Sobrepõe o número quando contá-lo seria desonesto («sem leitura»). */
  valorText?: string;
  /** Uma linha a explicar o porquê — texto, não cor de saúde. */
  nota?: string;
}) {
  return (
    <div className="cyber-border rounded-xl p-6 relative overflow-hidden group">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
      <div className="flex items-center justify-between mb-4">
        <Activity className="w-5 h-5 text-primary" />
      </div>
      <div className="text-3xl font-bold font-mono text-foreground mb-1">{valorText ?? value}</div>
      <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{label}</div>
      {nota && (
        <div className="mt-1 text-xs font-mono leading-snug text-muted-foreground" role="status">
          {nota}
        </div>
      )}
    </div>
  );
}
