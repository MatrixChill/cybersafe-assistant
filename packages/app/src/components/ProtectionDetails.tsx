import { useEffect, useState } from "react";
import { X, ShieldAlert } from "lucide-react";
import type {
  EngineHealth,
  EngineSubsystemCoverage,
  EngineSubsystemHealth,
  EngineSubsystemStatus,
} from "@cybersafe/shared-types";
import { cn } from "@/lib/utils";
import { levelMeta, engineStatusText, wfpModuleDisplay, windowsFirewallDisplay, type ProtectionLevel } from "../lib/protectionHealth";
import { wfpHealth } from "@cybersafe/shared-types";

interface ProtectionDetailsProps {
  engine?: EngineHealth;
  level: ProtectionLevel;
  open: boolean;
  onClose: () => void;
  /** Pontuação de proteção (0–100) mostrada no Dashboard — mesma fonte. */
  score?: number;
}

const ENGINE_ROWS: { key: "yara" | "hashDb" | "clamav" | "nativeEngine"; label: string }[] = [
  { key: "yara", label: "YARA" },
  { key: "hashDb", label: "Hash DB" },
  { key: "clamav", label: "ClamAV" },
  { key: "nativeEngine", label: "Native Engine" },
];

/**
 * Contagens REAIS lidas do detail que o serviço mediu (protection.getState).
 * Sem número medido não há linha de cobertura — ausência de dado não se
 * converte em diagnóstico nem em número inventado.
 */
function contagemRegras(detail?: string): number | null {
  const m = /Loaded\s+(\d+)\s+rule/i.exec(detail ?? "");
  return m ? Number(m[1]) : null;
}
function contagemAssinaturas(detail?: string): number | null {
  const m = /Loaded\s+(\d+)\s+signature/i.exec(detail ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * COBERTURA — o que o serviço mediu, em PT-PT.
 *
 * O campo `coverage` separa "o motor carregou" de "o que ele carregou cobre".
 * Um serviço antigo nao envia o campo: nesse caso é `unknown`, nunca `normal` —
 * um campo ausente nao é evidencia de cobertura, é ausência de evidencia.
 *
 * O que o utilizador lê nao e o token interno. Cada valor tem uma frase, e a
 * ausencia de dados tem a sua: nunca se traduz `unknown` como se fosse
 * cobertura suficiente.
 *
 * ── Porque `status` entra aqui ────────────────────────────────────────────
 * `coverage: "normal"` so e credivel com o motor `active`. Um motor
 * `unavailable` ou `degraded` a declarar cobertura normal e um estado
 * contraditorio: nenhuma das duas metades e confiavel, e a UI nao pode
 * escolher a. Nao existe caminho no servico que produza o par, mas a UI nao
 * deve depender de uma garantia do emissor para nao mentir — os dados chegam
 * por um named-pipe, e um emissor novo nao conhece esta regra.
 *
 * Nestes casos a cobertura desce para `unknown`: "nao determinada" e honesto,
 * "normal" seria uma affirmacao que o estado do motor nao sustenta.
 * Guard: test/yara-coverage-gate.test.ts.
 */
function coberturaUserCopy(
  coverage: EngineSubsystemCoverage | undefined,
  contagem: number | null,
  status: EngineSubsystemStatus,
): string {
  const n = contagem === null ? "" : contagem === 1 ? " (1 regra de teste)" : ` (${contagem} regras)`;
  // Plural PT-PT. Sem isto a linha de cobertura normal escrevia
  // "1 regras carregadas" — que era a frase que o utilizador viu.
  const carregadas =
    contagem === null
      ? "Cobertura normal."
      : `Cobertura normal: ${contagem} ${contagem === 1 ? "regra carregada" : "regras carregadas"}.`;
  // Um motor que nao esta `active` nao sustenta a affirmacao de cobertura
  // plena, aconteca o que acontecer no campo `coverage`.
  const efetiva: EngineSubsystemCoverage | undefined =
    status !== "active" && coverage === "normal" ? "unknown" : coverage;
  switch (efetiva) {
    case "limited":
      return `Cobertura limitada: só regras de canário de teste${n}. Não detetam malware.`;
    case "normal":
      return carregadas;
    case "unknown":
      return "Cobertura não determinada: o serviço não mediu o que está carregado.";
    default:
      // Serviço antigo, sem o campo. Não inventar cobertura — e nunca assumir
      // que a ausência do campo significa que a cobertura é boa.
      return "Cobertura não comunicada por este serviço.";
  }
}

/** O modulo WFP do CyberSafe, e o Windows Firewall, sao linhas diferentes. */
const WFP_MODULE_LABEL = "Filtro WFP (CyberSafe)";
const WINDOWS_FIREWALL_LABEL = "Windows Firewall";

const STATUS_META: Record<EngineSubsystemStatus, { text: string; cls: string }> = {
  active: { text: engineStatusText("active"), cls: "text-cyber-green border-cyber-green/40 bg-cyber-green/10" },
  degraded: { text: engineStatusText("degraded"), cls: "text-cyber-yellow border-cyber-yellow/40 bg-cyber-yellow/10" },
  unavailable: { text: engineStatusText("unavailable"), cls: "text-muted-foreground border-border bg-secondary/40" },
  error: { text: engineStatusText("error"), cls: "text-cyber-red border-cyber-red/40 bg-cyber-red/10" },
};

/**
 * Explicação da pontuação com os pesos REAIS do backend.
 * Espelha exatamente `effectiveRiskScore()` (@cybersafe/core):
 * risco efetivo = max(ameaças recentes, piso por motores de análise ativos),
 * piso = 75 (0 ativos) | 45 (1–2 ativos) | 20 (3–4 com algum degraded) | 0.
 * Pontuação apresentada = 100 − risco efetivo.
 */
const CORE_ENGINES: (keyof EngineHealth)[] = ["yara", "hashDb", "clamav", "nativeEngine"];

function explainScore(engine: EngineHealth | undefined, score: number) {
  const reported = CORE_ENGINES
    .map((key) => engine?.[key])
    .filter((sub): sub is EngineSubsystemHealth => !!sub);
  const active = reported.filter((sub) => sub.status === "active").length;
  const total = reported.length > 0 ? reported.length : CORE_ENGINES.length;
  const hasDegraded = reported.some((sub) => sub.status === "degraded");
  const riskFloor = active === 0 ? 75 : active <= 2 ? 45 : hasDegraded ? 20 : 0;
  const maxPossible = 100 - riskFloor;
  const threatPenalty = Math.max(0, maxPossible - score);
  return { active, total, maxPossible, threatPenalty };
}

/**
 * WS-B addendum — a copy humana vive aqui, neste componente renderizado.
 * O que o utilizador lê está no JSX; o detail cru do provider fica nos
 * detalhes técnicos expandidos. Estados fora do medido nesta máquina têm
 * frase própria honesta — nunca o token interno.
 */
function motorUserCopy(
  key: "yara" | "hashDb" | "clamav" | "nativeEngine",
  status: EngineSubsystemStatus,
): { texto: string; contexto?: string } {
  switch (key) {
    case "yara":
      if (status === "active") return { texto: "Motor de análise por regras ativo." };
      if (status === "unavailable") return { texto: "O motor de análise por regras não está ativo." };
      if (status === "degraded") return { texto: "O motor de análise por regras não está totalmente operacional." };
      return { texto: "O motor de análise por regras reporta um erro." };
    case "hashDb":
      if (status === "active") return { texto: "Base local ativa." };
      if (status === "unavailable") return { texto: "A base local de assinaturas não está carregada." };
      if (status === "degraded") return { texto: "A base local de assinaturas não está totalmente operacional." };
      return { texto: "A base local de assinaturas reporta um erro." };
    case "clamav":
      if (status === "degraded") {
        return {
          texto: "Motor instalado, mas a base de assinaturas antivírus ainda não está disponível.",
          contexto: "As assinaturas precisam de ser instaladas ou atualizadas antes de o ClamAV poder contribuir plenamente para a análise.",
        };
      }
      if (status === "active") return { texto: "Motor antivírus ativo e com base de assinaturas disponível." };
      if (status === "unavailable") return { texto: "O motor antivírus não está disponível neste computador." };
      return { texto: "O motor antivírus reporta um erro." };
    case "nativeEngine":
      if (status === "active") return { texto: "Motor nativo de análise disponível." };
      if (status === "unavailable") return { texto: "O motor nativo de análise não está disponível neste computador." };
      if (status === "degraded") return { texto: "O motor nativo de análise não está totalmente operacional." };
      return { texto: "O motor nativo de análise reporta um erro." };
  }
}

function wfpUserCopy(status: EngineSubsystemStatus): { texto: string; contexto: string } {
  const disclaimer = "Isto não significa que o Firewall do Windows esteja desligado.";
  if (status === "active") return { texto: "O filtro de rede próprio do CyberSafe está ativo.", contexto: disclaimer };
  if (status === "unavailable") return { texto: "O filtro de rede próprio do CyberSafe não está ativo.", contexto: disclaimer };
  if (status === "degraded") return { texto: "O filtro de rede próprio do CyberSafe não está a funcionar como esperado.", contexto: disclaimer };
  return { texto: "O filtro de rede próprio do CyberSafe reporta um erro.", contexto: disclaimer };
}

/** Um clique no estado geral abre os PROTECTION DETAILS. */
export default function ProtectionDetails({ engine, level, open, onClose, score }: ProtectionDetailsProps) {
  const [technical, setTechnical] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const meta = levelMeta(level);
  const reasons = engine?.degradedReasons ?? [];
  const scoreInfo = typeof score === "number" ? explainScore(engine, score) : null;

  // Cobertura REAL dos motores locais — só sai número que o serviço mediu.
  // "3 ativos" sem o 1 regra / 4 assinaturas dava a entender uma vigilancia
  // que estes dois motores, com esta base, nao oferecem.
  const regras = contagemRegras(engine?.yara?.detail);
  const assinaturas = contagemAssinaturas(engine?.hashDb?.detail);
  const coberturaRegras = regras === null ? null : regras === 1 ? "1 regra carregada." : `${regras} regras carregadas.`;
  const coberturaAssinaturas = assinaturas === null ? null : assinaturas === 1 ? "1 assinatura carregada." : `${assinaturas} assinaturas carregadas.`;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="cyber-border rounded-2xl w-full max-w-lg max-h-[80vh] overflow-y-auto bg-card p-5"
        style={{ scrollbarWidth: "thin", scrollbarColor: "color-mix(in oklch, var(--muted-foreground) 30%, transparent) transparent" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center shrink-0">
              <ShieldAlert className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h3 className="font-mono font-bold text-foreground">Estado da Proteção</h3>
              <p className="text-xs text-muted-foreground">Informação de saúde dos motores</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
            aria-label="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Linguagem simples (utilizador comum) */}
        <div className={cn("mt-5 p-4 rounded-xl border", meta.chipClass)}>
          <p className={cn("text-sm font-mono font-semibold uppercase tracking-wider", meta.textClass)}>
            {meta.label}
          </p>
          <p className="text-sm text-foreground mt-1 leading-relaxed">{meta.summary}</p>
        </div>

        {/* Explicação da pontuação — usa os pesos reais do backend (effectiveRiskScore). */}
        {scoreInfo && (
          <div className="mt-4 p-4 rounded-xl border border-border bg-secondary/30">
            <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              Porque é que a nota é {score}/100
            </p>
            <ul className="mt-2 space-y-1.5 text-sm text-foreground">
              <li>• Dos {scoreInfo.total} motores de análise, <b>{scoreInfo.active} estão ativos</b>.</li>
              {(coberturaRegras || coberturaAssinaturas) && (
                <li className="text-xs text-muted-foreground">
                  • Cobertura atual:{" "}
                  {[
                    coberturaRegras ? `YARA: ${coberturaRegras}` : null,
                    coberturaAssinaturas ? `Hash DB: ${coberturaAssinaturas}` : null,
                  ].filter(Boolean).join(" · ")}
                </li>
              )}
              <li>• Com isso, o máximo que podias ter aqui é <b>{scoreInfo.maxPossible}</b>.</li>
              {scoreInfo.threatPenalty > 0 ? (
                <li>• As ameaças recentes tiraram mais <b>{scoreInfo.threatPenalty}</b>.</li>
              ) : (
                <li>• Nenhuma ameaça recente tirou pontos — o teto vem dos motores em falta.</li>
              )}
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
              A nota é o contrário do risco: partimos de 100 e retiramos o maior dos dois
              perigos — as ameaças recentes, ou a confiança que falta nos motores.
            </p>
          </div>
        )}

        {/* Motores: a copy humana e o nivel de leitura do utilizador; o
            detail cru do provider (paths, "Loaded N ...", "corre freshclam")
            so aparece em "detalhes tecnicos" — continua acessivel, nao e
            removido. */}
        <div className="mt-4 space-y-2">
          {ENGINE_ROWS.map(({ key, label }) => {
            const sub = engine?.[key];
            const status: EngineSubsystemStatus = sub?.status ?? "unavailable";
            const copy = motorUserCopy(key, status);
            const coberturaLinha =
              key === "yara" ? coberturaRegras : key === "hashDb" ? coberturaAssinaturas : null;
            return (
              <div key={key} className="p-3 rounded-lg bg-secondary/40 border border-border">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm text-foreground">{label}</span>
                  <span className={cn("text-[10px] font-mono uppercase px-2 py-1 rounded border shrink-0", STATUS_META[status].cls)}>
                    {STATUS_META[status].text}
                  </span>
                </div>
                <p className="mt-1 text-xs text-foreground leading-relaxed">{copy.texto}</p>
                {/* A cobertura mostra-se em QUALQUER estado, não só em `active`.

                    A linha vivia atrás de `status === "active"`, e o caso que
                    mais importa é exatamente o oposto: o serviço semeia a
                    regra de canário e reporta `degraded` + `coverage:
                    "limited"`. Com o filtro, o utilizador lia "Motor ... não
                    está totalmente operacional" e NUNCA lia "Não detetam
                    malware" — a frase que diz o que ele precisa de saber. Um
                    `status` degradado que esconde a cobertura limitada é
                    metade de uma verdade.

                    Guard: test/yara-coverage-gate.test.ts. */}
                {key === "yara" && (
                  <p className="text-[11px] text-foreground leading-relaxed">
                    {coberturaUserCopy(engine?.yara?.coverage, regras, status)}
                  </p>
                )}
                {key === "hashDb" && (
                  <p className="text-[11px] text-foreground leading-relaxed">
                    {coberturaLinha ?? "Sem leitura do número de assinaturas."}
                  </p>
                )}
                {copy.contexto && (
                  <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">{copy.contexto}</p>
                )}
                {technical && sub?.detail && (
                  <p title={sub.detail} className="mt-1 text-[10px] text-muted-foreground font-mono break-all">— {sub.detail}</p>
                )}
              </div>
            );
          })}

          {/* O Windows Firewall e o modulo WFP do CyberSafe sao coisas
              diferentes. O servico so mede o segundo; sem leitura real do
              primeiro o unico estado honesto e "Não verificado". */}
          {(() => {
            const wfpSub = wfpHealth(engine);
            const wfp = wfpModuleDisplay(wfpSub);
            const win = windowsFirewallDisplay(null);
            const wfpCopy = wfpUserCopy(wfpSub?.status ?? "unavailable");
            return (
              <>
                <div className="p-3 rounded-lg bg-secondary/40 border border-border">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm text-foreground">{WINDOWS_FIREWALL_LABEL}</span>
                    <span className="text-[10px] font-mono uppercase px-2 py-1 rounded border text-muted-foreground border-border bg-secondary/40 shrink-0">
                      {win.text}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                    {win.status === "unknown"
                      ? "O CyberSafe ainda não consultou o estado do Firewall do Windows nesta vista."
                      : win.detail}
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-secondary/40 border border-border">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm text-foreground">{WFP_MODULE_LABEL}</span>
                    <span className={cn("text-[10px] font-mono uppercase px-2 py-1 rounded border shrink-0", STATUS_META[wfpSub?.status ?? "unavailable"].cls)}>
                      {wfp.text}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-foreground leading-relaxed">{wfpCopy.texto}</p>
                  {wfpCopy.contexto && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">{wfpCopy.contexto}</p>
                  )}
                  {technical && wfpSub?.detail && (
                    <p title={wfpSub.detail} className="mt-1 text-[10px] text-muted-foreground font-mono break-all">— {wfpSub.detail}</p>
                  )}
                </div>
              </>
            );
          })()}
        </div>

        <button
          onClick={() => setTechnical((v) => !v)}
          className="mt-4 px-4 py-2 rounded-lg text-xs font-mono uppercase tracking-wider bg-secondary hover:bg-secondary/70 text-secondary-foreground transition-colors"
        >
          {technical ? "Ocultar detalhes técnicos" : "Ver detalhes técnicos"}
        </button>

        {technical && reasons.length > 0 && (
          <div className="mt-4 p-3 rounded-lg bg-cyber-red/5 border border-cyber-red/20">
            <p className="text-[10px] font-mono uppercase tracking-wider text-cyber-red mb-2">Motivos da degradação</p>
            <ul className="space-y-1">
              {reasons.map((reason, i) => (
                <li key={i} className="text-xs font-mono text-muted-foreground">• {reason}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}