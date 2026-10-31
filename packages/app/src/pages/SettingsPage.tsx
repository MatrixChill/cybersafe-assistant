import { getAuthToken } from "../lib/authSession";
import { Bell, Check, Layers, MonitorCog, Palette, Power, ShieldCheck, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { CAMPOS_AUTORIZADOS } from "../lib/processMatrix";
import {
  lerConsentimento,
  revogarConsentimento,
  notificarRevogacaoDeConsentimento,
  subscreverRevogacaoDeConsentimento,
  contaDoTokenDeSessao,
  type MatrixConsentState,
} from "../lib/matrixExternalConsent";
import { useAppearance } from "../contexts/AppearanceContext";
import type { AccentMode, AppIdentity, SurfaceStyle, ThemeMode } from "../lib/appearance";
import { IDENTITY_LABELS, SURFACE_LABELS } from "../lib/appearance";
import { useState, useEffect } from "react";
import { aboutIdentityLines, electronVersionFromUserAgent, formatBuildBadge, resolveIdentity, technicalInfoText } from "../lib/buildIdentity";
import { UpdatesSection } from "../components/updates/UpdatesSection";
import { SurfaceHeroPreview } from "../components/visual/SurfaceHeroPreview";

/** Eixo 1 - identidade: cores, raio e letra. */
const IDENTITY_OPTIONS: { id: AppIdentity; name: string; description: string; swatch: string[] }[] = [
  {
    id: "cybersafe-core",
    name: IDENTITY_LABELS["cybersafe-core"],
    description: "Profissional e equilibrado. Verde-azulado profundo, ciano, cartões sólidos e boa densidade.",
    swatch: ["bg-cyber-cyan", "bg-[#0b3c4d]", "bg-[#111528]"],
  },
  {
    id: "cybersafe-neon",
    name: IDENTITY_LABELS["cybersafe-neon"],
    description: "Amigável e comercial. Ciano e rosa, indicadores suaves e cartões modernos.",
    swatch: ["bg-cyber-cyan", "bg-cyber-green", "bg-cyber-purple"],
  },
  {
    id: "matrix-terminal",
    name: IDENTITY_LABELS["matrix-terminal"],
    description: "Técnico de terminal. Preto e verde Matrix, linhas finas e letra monoespaçada.",
    swatch: ["bg-cyber-green", "bg-cyber-green/60", "bg-cyber-green/30"],
  },
  {
    id: "cybersafe-liquid",
    name: IDENTITY_LABELS["cybersafe-liquid"],
    description: "Painéis translúcidos com efeito de vidro, desfoque suave e profundidade por camadas.",
    swatch: ["bg-cyber-cyan", "bg-cyber-purple", "bg-cyber-pink"],
  },
  {
    id: "cybersafe-red-belbete",
    name: IDENTITY_LABELS["cybersafe-red-belbete"],
    description: "Red Velvet: veludo vermelho, bordô profundo, cacau, creme e rosé. Camadas quentes, elegante e imediatamente reconhecível.",
    swatch: ["bg-[#922c42]", "bg-[#431822]", "bg-[#f5e9dd]"],
  },
];

/** Eixo 2 - acabamento das superfícies. Aplica-se a qualquer identidade. */
const SURFACE_OPTIONS: { id: SurfaceStyle; description: string; descricaoCurta: string }[] = [
  {
    id: "glass",
    description: "As superfícies elevadas desfocam o fundo por trás delas. É o efeito completo e o que pede mais à máquina.",
    descricaoCurta: "O fundo aparece desfocado por dentro do cartão.",
  },
  {
    id: "reduced",
    description: "Mantêm a transparência e a borda, sem desfoque. Aspeto muito próximo, custo muito menor.",
    descricaoCurta: "Translúcido e nítido: o fundo passa sem desfoque.",
  },
  {
    id: "solid",
    description: "Superfícies opacas: nada do fundo se vê através delas. O modo mais leve e o de contraste mais alto.",
    descricaoCurta: "Opaco: o cartão é uma placa, o fundo não passa.",
  },
];

/** Cor de destaque - afeta primary, ring, accent, sidebar. NUNCA altera cores semânticas. */
const ACCENT_OPTIONS: { id: AccentMode; name: string; token: string }[] = [
  { id: "cyan", name: "Ciano", token: "--cyber-cyan" },
  { id: "matrix-green", name: "Verde Matrix", token: "--cyber-green" },
  { id: "blue", name: "Azul", token: "--accent-blue" },
  { id: "purple", name: "Roxo", token: "--cyber-purple" },
  { id: "pink", name: "Rosa", token: "--cyber-pink" },
  { id: "amber", name: "Âmbar", token: "--cyber-yellow" },
  { id: "red-wine", name: "Vinho", token: "--accent-wine" },
];

/** Eixo 0 - modo claro/escuro. É ortogonal à identidade: qualquer identidade
    pode ficar em claro ou em escuro. A lista é tipada por ThemeMode para que
    `setTheme(option.id)` só possa receber um valor que o contexto aceita. */
const THEME_MODE_OPTIONS: { id: ThemeMode; label: string }[] = [
  { id: "light", label: "Claro" },
  { id: "dark", label: "Escuro" },
];


const API_BASE =
  (typeof window !== "undefined" ? (window as unknown as { __CYBERSAFE_API_BASE__?: string }).__CYBERSAFE_API_BASE__ : undefined) ||
  "http://127.0.0.1:4000";

function tokenDeSessao(): string | null {
  try {
    return getAuthToken() ?? null;
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> {
  const token = tokenDeSessao();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function SettingsPage() {
  // Metadata do aviso local: o `sub` do token já emitido. Não é uma sessão
  // nova nem uma autorização — o DELETE continua a ser validado pelo servidor.
  const contaId = contaDoTokenDeSessao(tokenDeSessao());
  const { identity, setIdentity, theme, setThemeMode, accent, setAccent, surface, setSurface } = useAppearance();
  const [autoStart, setAutoStart] = useState(false);
  const [startMinimized, setStartMinimized] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  // Opt-in de retoma ao arrancar. Estado SEMPARA do "ligar a proteção agora":
  // é só a preferência de retomar no próximo arranque, e o único valor que a UI
  // mostra é o que o serviço confirmou em disco.
  const [retomaOptin, setRetomaOptin] = useState<"enabled" | "disabled" | "unknown">("unknown");
  const [retomaMotivo, setRetomaMotivo] = useState<string | undefined>(undefined);
  const [retomaAviso, setRetomaAviso] = useState<string | null>(null);
  const [retomaAGuardar, setRetomaAGuardar] = useState(false);
  const [consentimentoMatriz, setConsentimentoMatriz] = useState<MatrixConsentState | null>(null);
  const [consentimentoLeitura, setConsentimentoLeitura] = useState<"loading" | "ready" | "unavailable" | "no-session">("loading");
  const [consentimentoErro, setConsentimentoErro] = useState<string | null>(null);
  const [consentimentoAGuardar, setConsentimentoAGuardar] = useState(false)
  /** Uma revogação feita na MATRIX não deixa esta secção a afirmar o contrário. */
  const [consentimentoVersao, setConsentimentoVersao] = useState(0);

  useEffect(() => {
    if (window.electronAPI?.getAutoStart) {
      window.electronAPI.getAutoStart().then((config) => {
        setAutoStart(config?.enabled ?? false);
        setStartMinimized(config?.startMinimized ?? false);
      }).catch(() => {});
    }
    if (window.electronAPI?.getNotificationsEnabled) {
      window.electronAPI.getNotificationsEnabled().then((config) => {
        setNotificationsEnabled(config?.enabled ?? true);
      }).catch(() => {});
    }
  }, []);

  async function toggleAutoStart(checked: boolean) {
    setAutoStart(checked);
    if (window.electronAPI?.setAutoStart) {
      await window.electronAPI.setAutoStart({ enabled: checked, startMinimized });
    }
  }

  async function toggleStartMinimized(checked: boolean) {
    setStartMinimized(checked);
    if (window.electronAPI?.setAutoStart) {
      await window.electronAPI.setAutoStart({ enabled: autoStart, startMinimized: checked });
    }
  }

  async function toggleNotifications(checked: boolean) {
    setNotificationsEnabled(checked);
    if (window.electronAPI?.setNotificationsEnabled) {
      await window.electronAPI.setNotificationsEnabled(checked);
    }
  }

  // Preferência lida do serviço, não de um espelho local: sem resposta fica
  // `unknown`, que a UI mostra como desligado e ilegível — nunca como ligado.
  useEffect(() => {
    if (!window.electronAPI?.getProtectionIntent) return;
    window.electronAPI.getProtectionIntent()
      .then((estado) => { setRetomaOptin(estado.optin); setRetomaMotivo(estado.motivo); })
      .catch(() => { setRetomaOptin("unknown"); setRetomaMotivo("servico_indisponivel"); });
  }, []);

  // Consentimento persistente da MATRIX: lido da API local (descriptor/grant),
  // nunca de uma aceitação em cache. Sem sessão ou sem resposta, a UI não diz
  // que está autorizado nem oferece uma revogação que não pode confirmar.
  useEffect(() => {
    setConsentimentoLeitura("loading");
    setConsentimentoMatriz(null);
    setConsentimentoErro(null);
    const headers = authHeaders();
    if (!headers.Authorization) {
      setConsentimentoLeitura("no-session");
      return;
    }
    let vivo = true;
    lerConsentimento(API_BASE, headers).then((estado) => {
      if (!vivo) return;
      if (!estado) {
        setConsentimentoLeitura("unavailable");
        return;
      }
      setConsentimentoMatriz(estado);
      setConsentimentoLeitura("ready");
    });
    return () => { vivo = false; };
  }, [consentimentoVersao]);

  useEffect(() => subscreverRevogacaoDeConsentimento((aviso) => {
    // Metadata de conta: um aviso de outra conta não mexe nesta secção.
    if (aviso.accountId !== null && contaId !== null && aviso.accountId !== contaId) return
    if (aviso.phase === "confirmed") {
      // A MATRIX (ou outra montagem) confirmou o DELETE: reler em vez de
      // continuar a mostrar um grant que já não existe.
      setConsentimentoVersao((v) => v + 1)
      setConsentimentoErro(null)
      return
    }
    if (aviso.phase === "failed") {
      setConsentimentoErro("O serviço local não confirmou a revogação. A MATRIX ficou bloqueada para novos envios de medições até voltares a autorizar.")
    }
  }), [contaId]);

  async function toggleRetomaProtecao(checked: boolean) {
    if (!window.electronAPI?.setProtectionIntent) return;
    setRetomaAGuardar(true);
    setRetomaAviso(null);
    try {
      const resultado = await window.electronAPI.setProtectionIntent(checked);
      if (resultado.guardado) {
        // Só aqui é que a UI muda o interruptor: com confirmação de escrita.
        setRetomaOptin(checked ? "enabled" : "disabled");
        setRetomaMotivo(undefined);
        return;
      }
      setRetomaAviso(resultado.motivo === "conflito"
        ? "A preferência mudou entretanto. Volte a tentar."
        : "Não foi possível guardar. A preferência mantém-se como estava.");
      const relido = await window.electronAPI.getProtectionIntent?.().catch(() => undefined);
      if (relido) { setRetomaOptin(relido.optin); setRetomaMotivo(relido.motivo); }
    } catch {
      setRetomaAviso("Sem ligação ao serviço. Nada foi alterado.");
    } finally {
      setRetomaAGuardar(false);
    }
  }

  async function revogarConsentimentoMatriz() {
    setConsentimentoAGuardar(true);
    setConsentimentoErro(null);
    // A revogação INICIADA já fecha a MATRIX: entre este clique e a resposta do
    // DELETE não pode sair um envio com o grant que está a ser retirado.
    notificarRevogacaoDeConsentimento({ accountId: contaId, phase: "started", serverConfirmed: false });
    try {
      const resultado = await revogarConsentimento(API_BASE, authHeaders());
      if (!resultado.ok) {
        setConsentimentoErro("Não foi possível confirmar a revogação no serviço local. A MATRIX ficou bloqueada para novos envios de medições até voltares a autorizar.");
        // O servidor não confirmou: a MATRIX continua bloqueada. Não há reload
        // do GET que possa transformar este erro numa autorização outra vez.
        notificarRevogacaoDeConsentimento({ accountId: contaId, phase: "failed", serverConfirmed: false });
        return;
      }
      setConsentimentoMatriz((atual) => atual ? { ...atual, grant: null } : atual);
      // A MATRIX pode ter um stream/autorização pendente noutra montagem: o
      // evento confirmado fecha a autoridade local sem um segundo DELETE.
      notificarRevogacaoDeConsentimento({ accountId: contaId, phase: "confirmed", serverConfirmed: true });
    } finally {
      setConsentimentoAGuardar(false);
    }
  }

  return (
    <div className="page-shell max-w-5xl animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div>
        <h1 className="page-title text-2xl font-bold font-mono tracking-tight">
          Configurações
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Preferências da aplicação
        </p>
      </div>

      {/* === APARÊNCIA === */}
      <section className="surface-elevated cyber-border rounded-xl p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center">
            <MonitorCog className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-mono font-semibold text-foreground">Aparência</h2>
            <p className="text-xs text-muted-foreground">
              Quatro escolhas que se combinam: tema base, modo claro ou escuro, material das superfícies e cor de destaque.
            </p>
          </div>
        </div>

        {/* Controlos primeiro, comparação ao vivo logo abaixo. A comparação
            rola com a página (não fica presa a nada): é uma amostra, não uma
            barra de ferramentas. Ocupa a largura toda e, em janelas grandes,
            põe os três materiais e a miniatura do hero lado a lado. */}
        <div className="grid grid-cols-1 gap-6 items-start">
          <div className="space-y-6 min-w-0">
            {/* Eixo 1 - identidade */}
            <div>
              <div className="flex items-baseline gap-3 mb-1">
                <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Tema base</h3>
                <Layers className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden />
              </div>
              <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                Define as cores, os raios e a letra de toda a aplicação. Escolhe-se também na barra lateral, em baixo.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {IDENTITY_OPTIONS.map((option) => {
                  const selected = identity === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => setIdentity(option.id)}
                      aria-pressed={selected}
                      className={cn(
                        "text-left p-4 rounded-xl border transition-all",
                        selected
                          ? "border-primary bg-primary/10"
                          : "border-border hover:border-primary/40 hover:bg-primary/5",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span className={cn("font-mono font-semibold text-sm text-foreground", selected && "text-primary")}>
                          {option.name}
                        </span>
                        {selected ? (
                          <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
                            <Check className="w-3 h-3" />
                          </span>
                        ) : (
                          <span className="w-5 h-5 rounded-full border border-border shrink-0" />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{option.description}</p>
                      <div className="flex items-center gap-2 mt-3">
                        {option.swatch.map((cls) => (
                          <div key={cls} className={cn("w-4 h-4 rounded-full border border-border", cls)} />
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Eixo 0 - modo claro/escuro. É um eixo lateral ao dos identidades,
                  não um subtipo delas: qualquer identidade pode ficar em claro ou
                  em escuro, e o mesmo par morcego pode trocar de modo sem mudar
                  de identidade. Por isso são dois botões à parte, com o mesmo
                  padrão que o resto da secção. */}
              <div>
                <div className="flex items-baseline gap-3 mb-1">
                  <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Modo</h3>
                  <Palette className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden />
                </div>
                <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                  Alterna entre o aspeto claro e o aspeto escuro. Desde a camada V2 o claro é um tema próprio (Cyber Light Pro); voltar ao escuro reescolhe uma identidade.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" role="group" aria-label="Mudar entre modo claro e modo escuro">
                  {THEME_MODE_OPTIONS.map((option) => {
                    const selected = theme === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setThemeMode(option.id)}
                        aria-pressed={selected}
                        className={cn(
                          "text-left p-4 rounded-xl border transition-all",
                          selected
                            ? "border-primary bg-primary/10"
                            : "border-border hover:border-primary/40 hover:bg-primary/5",
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <span className={cn("font-mono font-semibold text-sm text-foreground", selected && "text-primary")}>
                          {option.label}
                          </span>
                          {selected ? (
                            <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
                              <Check className="w-3 h-3" />
                            </span>
                          ) : (
                            <span className="w-5 h-5 rounded-full border border-border shrink-0" />
                          )}
                        </div>
                        {selected && (
                          <p className="text-xs text-muted-foreground mt-2 leading-relaxed">A usar agora</p>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Eixo 2 - material. Não é um tema: aplica-se ao tema base
                escolhido acima. As amostras individuais saíram daqui porque
                cada uma tinha o SEU fundo: três amostras com fundos diferentes
                não se comparam. A comparação com o mesmo fundo está à direita. */}
            <div>
              <div className="flex items-baseline gap-3 mb-1">
                <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Material da interface</h3>
                <Sparkles className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden />
              </div>
              <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                Vidro, Reduzido e Sólido são três acabamentos do mesmo tema. Na amostra abaixo estão os
                três, no mesmo fundo, para poderes comparar em vez de confiar na descrição.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {SURFACE_OPTIONS.map((option) => {
                  const selected = surface === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => setSurface(option.id)}
                      aria-pressed={selected}
                      className={cn(
                        "text-left p-3 rounded-xl border transition-all",
                        selected
                          ? "border-primary bg-primary/10"
                          : "border-border hover:border-primary/40 hover:bg-primary/5",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className={cn("font-mono font-semibold text-sm text-foreground", selected && "text-primary")}>
                          {SURFACE_LABELS[option.id]}
                        </span>
                        {selected ? (
                          <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
                            <Check className="w-3 h-3" />
                          </span>
                        ) : (
                          <span className="w-5 h-5 rounded-full border border-border shrink-0" />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{option.description}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Eixo 3 - cor de destaque. Fica na mesma coluna dos outros
                controlos para que as quatro escolhas se leiam de seguida, sem
                uma secção solta abaixo da dobra. */}
            <div>
              <div className="flex items-baseline gap-3 mb-1">
                <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Cor de destaque</h3>
                <Palette className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden />
              </div>
              <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                Muda a cor de realce da aplicação: botões, contornos e focos. As cores de estado
                (verde, âmbar, vermelho) não mudam nunca com esta escolha.
              </p>
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
                {ACCENT_OPTIONS.map((option) => {
                  const selected = accent === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => setAccent(option.id)}
                      aria-pressed={selected}
                      className={cn(
                        "block w-full text-left p-3 rounded-lg border transition-all",
                        selected
                          ? "border-primary bg-primary/10"
                          : "border-border hover:border-primary/40 hover:bg-primary/5",
                      )}
                    >
                      {/* O tom é lido do MESMO token que a regra de acento usa. */}
                      <div
                        className="w-full h-6 rounded-lg mb-2 border border-border"
                        style={{ background: `color-mix(in oklch, var(${option.token}) 80%, transparent)` }}
                      />
                      <p className="text-xs font-mono text-foreground text-center">{option.name}</p>
                      {selected && (
                        <span className="flex items-center justify-center gap-1 mt-1 text-xs font-mono text-primary">
                          <Check className="w-3.5 h-3.5" />
                          Selecionado
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* COMPARAÇÃO AO VIVO. Um só pano de fundo, três cartões iguais com
              materiais diferentes: a diferença que se vê é o material, não o
              resto. O atributo `data-surface-preview` é o que impede o travão
              universal do eixo de apagar o desfoque desta amostra - sem ele,
              quem estivesse em Sólido veria três cartões iguais, que é
              exatamente a mentira que a pré-visualização não pode contar.
              Não há números nem estados de sistema aqui: era uma amostra, a
              comparação é de material. */}
          <aside className="surface-elevated cyber-border appearance-preview rounded-xl p-4">
            <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Os três materiais, no mesmo fundo</h3>
            <p className="copy-human mt-1 text-muted-foreground">
              Material em uso: <span className="copy-emphasis text-foreground">{SURFACE_LABELS[surface]}</span>
              {" · "}Identidade: <span className="copy-emphasis text-foreground">{IDENTITY_LABELS[identity]}</span>
            </p>
            <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] lg:items-start">
              <div>
            <div
              data-surface-preview=""
              role="group"
              aria-label="Pré-visualização dos três materiais, no mesmo fundo"
              className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 rounded-xl"
              style={{
                background: [
                  "repeating-linear-gradient(0deg, color-mix(in oklch, var(--foreground) 9%, transparent) 0 1px, transparent 1px 14px)",
                  "repeating-linear-gradient(90deg, color-mix(in oklch, var(--foreground) 9%, transparent) 0 1px, transparent 1px 40px)",
                  "radial-gradient(circle at 20% 15%, color-mix(in oklch, var(--primary) 55%, transparent) 0%, transparent 55%)",
                  "radial-gradient(circle at 85% 70%, color-mix(in oklch, var(--cyber-purple) 45%, transparent) 0%, transparent 50%)",
                  "var(--background)",
                ].join(", "),
              }}
            >
              {/* Cada cartão da amostra lê o token do SEU material (`data-surface`
                  no próprio cartão): sem isso, em Sólido/Reduzido o
                  `--surface-filter` herdado é `none` e o cartão de Vidro perde o
                  desfoque, ficando três iguais. */}
              {SURFACE_OPTIONS.map((option) => {
                const ativo = surface === option.id;
                return (
                  <div
                    key={option.id}
                    data-surface-preview=""
                    data-surface={option.id}
                    aria-current={ativo ? "true" : undefined}
                    className="rounded-lg p-3 border"
                    style={{
                      /* Os três lêem os MESMOS tokens que o eixo de superfície
                         aplica à app inteira: Vidro e Reduzido partilham o pano
                         translúcido (o que os separa é o desfoque e o aro), e
                         Sólido é o fundo do tema, opaco. Antes havia aqui um
                         76% inventado para a amostra, que não era o valor de
                         ninguém. */
                      background: option.id === "solid"
                        ? "var(--surface-card)"
                        : "var(--surface-translucent)",
                      borderColor: option.id === "glass"
                        ? "var(--material-glass-edge)"
                        : "color-mix(in oklch, var(--border) 70%, transparent)",
                      /* O raio é o do eixo (16px), não um mais pequeno para
                         caber na amostra: o que se compara tem de ser o que se
                         usa. */
                      /* O desfoque lê o token do cartão (o `data-surface` com o
                         id da opção), não o do modo ativo: acompanha o
                         reduced-motion sem perder o vidro nos outros modos. */
                      backdropFilter: option.id === "glass" ? "var(--surface-filter)" : "none",
                      WebkitBackdropFilter: option.id === "glass" ? "var(--surface-filter)" : "none",
                      boxShadow: option.id === "glass" ? "inset 0 1px 0 color-mix(in oklch, oklch(1 0 0) 22%, transparent)" : "none",
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-semibold text-foreground">{SURFACE_LABELS[option.id]}</span>
                      {ativo && (
                        <span className="text-xs font-mono uppercase tracking-wider text-primary">a usar</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      {option.descricaoCurta}
                    </p>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
              O que muda de um cartão para o outro é só o material: primeiro o desfoque do fundo, depois a
              transparência, e por fim o aro iluminado. Se dois cartões te parecerem iguais, diz qual - é
              esse o defeito que esta amostra existe para apanhar.
            </p>
              </div>

            {/* TP-V2-VISUAL: a comparação de materiais ganha contexto — o
                MESMO material aplicado a uma miniatura do hero do Dashboard.
                Valores fixos e rotulados como amostra; não lê serviço nem IPC. */}
            <div className="border-t border-border pt-3 lg:border-t-0 lg:border-l lg:border-border lg:pt-0 lg:pl-4">
              <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">No hero do Dashboard</h3>
              <SurfaceHeroPreview surface={surface} className="mt-2" />
              <p className="copy-human mt-2 text-muted-foreground">
                Mini composição com o material escolhido. Os números desta amostra são fixos: não são o
                estado do teu computador.
              </p>
            </div>
            </div>
          </aside>
        </div>

        <p className="text-xs text-muted-foreground font-mono">
          Aplica de imediato e fica guardado para o próximo arranque. Se o desfoque pesar no teu computador,
          escolhe Reduzido ou Sólido.
        </p>
      </section>

      {/* === INICIAR COM O WINDOWS === */}
      <section className="surface-elevated cyber-border rounded-xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center">
            <Power className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-mono font-semibold text-foreground">Iniciar com o Windows</h2>
            <p className="text-xs text-muted-foreground">O CyberSafe inicia automaticamente quando o computador arranca</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/50 border border-border">
            <div>
              <p className="text-sm font-mono text-foreground">Iniciar automaticamente</p>
              <p className="text-xs text-muted-foreground mt-0.5">Abre o CyberSafe quando o Windows inicia</p>
            </div>
            <button
              onClick={() => toggleAutoStart(!autoStart)}
              className={cn(
                "relative w-11 h-6 rounded-full transition-colors",
                autoStart ? "bg-primary" : "bg-secondary",
              )}
            >
              <div className={cn(
                "absolute top-0.5 w-5 h-5 rounded-full bg-card border border-border transition-transform",
                autoStart ? "translate-x-5.5" : "translate-x-0.5",
              )} />
            </button>
          </div>

          {autoStart && (
            <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/50 border border-border ml-4">
              <div>
                <p className="text-sm font-mono text-foreground">Iniciar minimizado</p>
                <p className="text-xs text-muted-foreground mt-0.5">Começa em segundo plano sem mostrar a janela</p>
              </div>
              <button
                onClick={() => toggleStartMinimized(!startMinimized)}
                className={cn(
                  "relative w-11 h-6 rounded-full transition-colors",
                  startMinimized ? "bg-primary" : "bg-secondary",
                )}
              >
                <div className={cn(
                  "absolute top-0.5 w-5 h-5 rounded-full bg-card border border-border transition-transform",
                  startMinimized ? "translate-x-5.5" : "translate-x-0.5",
                )} />
              </button>
            </div>
          )}
        </div>

        <p className="text-xs text-muted-foreground mt-4 font-mono">
          Requer que o CyberSafe esteja instalado no sistema. O registo no Windows é feito de forma segura.
        </p>
      </section>

      {/* === NOTIFICAÇÕES === */}
      <section className="surface-elevated cyber-border rounded-xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center">
            <Bell className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-mono font-semibold text-foreground">Notificações</h2>
            <p className="text-xs text-muted-foreground">Notificações do Windows para alertas de segurança importantes</p>
          </div>
        </div>

        <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/50 border border-border">
          <div>
            <p className="text-sm font-mono text-foreground">Notificações do sistema</p>
            <p className="text-xs text-muted-foreground mt-0.5">Avisos do Windows para ameaças detetadas e processos bloqueados</p>
          </div>
          <button
            onClick={() => toggleNotifications(!notificationsEnabled)}
            className={cn(
              "relative w-11 h-6 rounded-full transition-colors",
              notificationsEnabled ? "bg-primary" : "bg-secondary",
            )}
          >
            <div className={cn(
              "absolute top-0.5 w-5 h-5 rounded-full bg-card border border-border transition-transform",
              notificationsEnabled ? "translate-x-5.5" : "translate-x-0.5",
            )} />
          </button>
        </div>

        <p className="text-xs text-muted-foreground mt-4 font-mono">
          Apenas alertas críticos ou elevados geram uma notificação nativa. Alertas de baixa prioridade aparecem apenas dentro da aplicação.
        </p>
      </section>

      {/* === RETOMA AO ARRANCAR (opt-in separado da proteção viva) === */}
      <section className="surface-elevated cyber-border rounded-xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center">
            <Power className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-mono font-semibold text-foreground">Retomar proteção ao arrancar</h2>
            <p className="text-xs text-muted-foreground">Preferência guardada no disco, separada de ligar ou desligar a proteção</p>
          </div>
        </div>

        <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/50 border border-border">
          <div>
            <p className="text-sm font-mono text-foreground">Ligar a proteção automaticamente quando o serviço arranca</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {retomaOptin === "enabled"
                ? "Ativo. Ao arrancar, o serviço volta a ligar a proteção."
                : retomaOptin === "disabled"
                  ? "Desligado. Um OFF manual cancela sempre a retoma automática."
                  : "Sem preferência registada. Por omissão a proteção arranca desligada."}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={retomaOptin === "enabled"}
            disabled={retomaAGuardar}
            onClick={() => toggleRetomaProtecao(retomaOptin !== "enabled")}
            className={cn(
              "relative w-11 h-6 rounded-full transition-colors disabled:opacity-50",
              retomaOptin === "enabled" ? "bg-primary" : "bg-secondary",
            )}
          >
            <div className={cn(
              "absolute top-0.5 w-5 h-5 rounded-full bg-card border border-border transition-transform",
              retomaOptin === "enabled" ? "translate-x-5.5" : "translate-x-0.5",
            )} />
          </button>
        </div>

        {retomaAviso && (
          <p role="status" className="text-xs text-cyber-yellow mt-3 font-mono">{retomaAviso}</p>
        )}
        {!retomaAviso && retomaOptin === "unknown" && retomaMotivo && retomaMotivo !== "documento_ausente" && (
          <p role="status" className="text-xs text-cyber-yellow mt-3 font-mono">
            O registo de preferência não pôde ser lido ({retomaMotivo}). Nada foi assumido como ligado.
          </p>
        )}
        <p className="text-xs text-muted-foreground mt-4 font-mono">
          Este interruptor não liga nem desliga a proteção agora. Ligar a proteção à mão não ativa esta opção; desligar à mão cancela-a. Uma pausa sem prazo também conta como OFF ao próximo arranque.
        </p>
      </section>

      {/* === BOAS-VINDAS === */}
      <section className="surface-elevated cyber-border rounded-xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center">
            <Check className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-mono font-semibold text-foreground">Boas-vindas</h2>
            <p className="text-xs text-muted-foreground">Reveja a introdução à aplicação a qualquer momento</p>
          </div>
        </div>

        <button
          onClick={() => window.dispatchEvent(new Event("cybersafe:open-onboarding"))}
          className="px-5 py-2.5 bg-secondary text-foreground border border-border font-mono text-sm rounded-lg hover:border-primary/40 hover:bg-secondary/80 transition-all"
        >
          Reabrir boas-vindas
        </button>

        <p className="text-xs text-muted-foreground mt-4 font-mono">
          O ecrã de boas-vindas só é mostrado automaticamente na primeira utilização.
        </p>
      </section>

      {/* === CONSENTIMENTO DA MATRIX === */}
      <section data-settings-matrix-consent className="surface-elevated cyber-border rounded-xl p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-mono font-semibold text-foreground">Consentimento da Matrix</h2>
            <p className="text-xs text-muted-foreground">
              Autorização guardada nesta conta e computador para enviar medições de processos à IA externa.
            </p>
          </div>
        </div>

        <p data-settings-matrix-consent-status className="text-[11px] font-mono text-muted-foreground mb-3">
          {consentimentoLeitura === "ready"
            ? consentimentoErro
              ? "Revogação não confirmada — envio bloqueado"
              : consentimentoMatriz?.grant ? "Autorização ativa" : "Sem autorização guardada"
            : consentimentoLeitura === "no-session" ? "Sem sessão" : consentimentoLeitura === "unavailable" ? "Serviço local indisponível" : "A verificar…"}
        </p>

        {consentimentoLeitura === "loading" && (
          <p className="text-xs text-muted-foreground font-mono">A ler o consentimento guardado…</p>
        )}
        {consentimentoLeitura === "no-session" && (
          <p className="text-xs text-muted-foreground font-mono">Inicia sessão para ver ou revogar o consentimento guardado.</p>
        )}
        {consentimentoLeitura === "unavailable" && (
          <p role="status" className="text-xs text-cyber-yellow font-mono">
            Não foi possível ler o consentimento na API local. Nada foi assumido como autorizado.
          </p>
        )}
        {consentimentoLeitura === "ready" && !consentimentoMatriz?.grant && (
          <p className="text-xs text-muted-foreground font-mono">
            Sem consentimento guardado. A Matrix responde localmente e só pede autorização quando usares a opção de IA.
          </p>
        )}
        {consentimentoLeitura === "ready" && consentimentoMatriz?.grant && (
          <div className="space-y-3">
            <div className="rounded-lg bg-secondary/50 border border-border p-3 space-y-1">
              <p className="text-sm font-mono text-foreground">
                Fornecedor: {consentimentoMatriz.descriptor.providerLabel || "fornecedor externo"}
              </p>
              <p className="text-xs text-muted-foreground">
                Finalidade: explicação de processos. Vale até{" "}
                {new Date(consentimentoMatriz.grant.expiresAt).toLocaleDateString("pt-PT")}{" "}
                ({consentimentoMatriz.descriptor.validityDays} dias) e cobre futuras explicações de processos nesta instalação.
              </p>
              <p className="text-xs text-muted-foreground">
                Campos autorizados: {CAMPOS_AUTORIZADOS.join(", ")}.
              </p>
            </div>
            <button
              type="button"
              data-settings-matrix-consent-revoke
              disabled={consentimentoAGuardar}
              onClick={() => { void revogarConsentimentoMatriz(); }}
              className="px-3 py-1.5 bg-secondary border border-border font-mono text-xs rounded-lg hover:border-primary/40 transition-all disabled:opacity-50"
            >
              {consentimentoAGuardar ? "A revogar…" : "Revogar consentimento"}
            </button>
          </div>
        )}
        {consentimentoErro && (
          <p role="status" className="text-xs text-cyber-yellow mt-3 font-mono">{consentimentoErro}</p>
        )}
      </section>

      {/* Sobre o CyberSafe - identidade real da aplicação (P0-7). Nada é inventado:
          fora de um build com carimbo, os valores aparecem como "desconhecida/desenvolvimento". */}
      <section className="surface-elevated cyber-border rounded-xl p-6">
        <h2 className="text-lg font-semibold text-foreground mb-1">Sobre o CyberSafe</h2>
        <p className="text-sm text-muted-foreground mb-4">CyberSafe Assistant - assistência de segurança pessoal para Windows.</p>
        <dl className="space-y-2 font-mono text-sm">
          {aboutIdentityLines(resolveIdentity()).map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="text-foreground select-text">{row.value}</dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">Electron</dt>
            <dd className="text-foreground select-text">{electronVersionFromUserAgent(navigator.userAgent)}</dd>
          </div>
        </dl>
        <div className="flex items-center justify-between gap-4 mt-4">
          <p className="text-xs text-muted-foreground font-mono">
            {formatBuildBadge(resolveIdentity())} - estado de proteção e motores é mostrado em tempo real na barra lateral.
          </p>
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(technicalInfoText(resolveIdentity(), electronVersionFromUserAgent(navigator.userAgent)));
            }}
            className="shrink-0 px-3 py-1.5 bg-secondary border border-border font-mono text-xs rounded-lg hover:border-primary/40 transition-all"
          >
            Copiar informações técnicas
          </button>
        </div>
      </section>

      {/* === ATUALIZAÇÕES === */}
      <UpdatesSection />
    </div>
  );
}
