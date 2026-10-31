import React, { useState, useEffect } from "react";
import { KeyRound, Eye, EyeOff, Check, X, ShieldAlert, Sparkles, Loader2, Trash2 } from "lucide-react";

export interface MatrixConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentProvider?: string;
  hasConfiguredKey?: boolean;
  providerState?: string;
  onVerify?: () => Promise<void>;
  onSaveKey?: (key: string, provider: string) => Promise<{ ok: boolean; error?: string }>;
  onClearKey?: () => Promise<{ ok: boolean }>;
}

export function MatrixConfigModal({
  isOpen,
  onClose,
  currentProvider = "groq",
  hasConfiguredKey = false,
  onSaveKey,
  providerState = "Ligação não verificada",
  onVerify,
  onClearKey,
}: MatrixConfigModalProps) {
  const [provider, setProvider] = useState<string>(currentProvider);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    setApiKey(""); setShowKey(false); setFeedback(null);
    if (isOpen) setProvider(currentProvider === "openai" ? "openai" : "groq");
  }, [isOpen, currentProvider]);
  if (!isOpen) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) {
      setFeedback({ type: "error", message: "Introduz uma chave de API válida." });
      return;
    }
    if (apiKey.trim().length < 16) {
      setFeedback({ type: "error", message: "A chave tem de ter pelo menos 16 caracteres." });
      return;
    }

    setLoading(true);
    setFeedback(null);
    try {
      if (onSaveKey) {
        const res = await onSaveKey(apiKey.trim(), provider);
        if (res.ok) {
          setFeedback({ type: "success", message: "Chave guardada com sucesso e protegida por DPAPI." });
          setApiKey("");
        } else {
          setFeedback({ type: "error", message: res.error || "Não foi possível guardar a chave." });
        }
      } else {
        setFeedback({ type: "error", message: "Armazenamento protegido indisponível." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: "Erro ao comunicar com o armazenamento seguro." });
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    setLoading(true);
    setFeedback(null);
    try {
      if (onClearKey) {
        const result = await onClearKey();
        if (!result.ok) throw new Error("clear failed");
      } else { throw new Error("bridge unavailable"); }
      setFeedback({ type: "success", message: "Configuração removida. A Matrix regressou ao modo local." });
    } catch {
      setFeedback({ type: "error", message: "Erro ao remover a chave." });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-labelledby="matrix-config-title"
      aria-modal="true"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
    >
      <div className="w-full max-w-md rounded-2xl border border-primary/30 bg-card p-6 shadow-2xl space-y-5">
        {/* Cabeçalho */}
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-primary/10 text-primary">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h2 id="matrix-config-title" className="text-sm font-bold font-mono text-foreground uppercase tracking-wider">
                Configurar MATRIX (IA)
              </h2>
              <p className="text-[11px] text-muted-foreground">
                Fornecedor online para inteligência generativa e contextual.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground rounded-lg transition-colors"
            aria-label="Fechar janela"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Estado Atual */}
        <div className="rounded-xl border border-border bg-secondary/30 p-3 text-xs space-y-1">
          <div className="flex items-center justify-between">
            <span className="font-mono text-muted-foreground">Estado atual:</span>
            <span className="font-mono font-semibold text-primary">
              {hasConfiguredKey ? "Chave guardada (não verifica a ligação)" : "Modo Local (Sem Chave)"}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {hasConfiguredKey
              ? "A tua chave está cifrada localmente com DPAPI/safeStorage e só é utilizada para contactar o fornecedor mediante escolha online explícita."
              : "Sem chave configurada, a Matrix funciona em modo determinístico local sem contactar servidores externos."}
          </p>
        </div>

        <p role="status" className="text-xs">{providerState}</p>
        <button type="button" disabled={!hasConfiguredKey || loading} onClick={async () => { setLoading(true); try { await onVerify?.(); } finally { setLoading(false); } }} className="text-xs underline disabled:opacity-50">Verificar ligação (contacta o fornecedor; não envia medições)</button>
        {/* Formulário de Configuração */}
        <form onSubmit={handleSave} className="space-y-4 text-xs">
          <div>
            <label htmlFor="matrix-provider-select" className="font-mono text-muted-foreground block mb-1">
              Fornecedor de IA:
            </label>
            <select
              id="matrix-provider-select"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/60"
            >
              <option value="groq">Groq (Recomendado — Ultrarrápido)</option>
              <option value="openai">OpenAI (Compatível)</option>
              <option value="custom" disabled>Custom indisponível — destino não autorizado</option>
            </select>
          </div>

          <div>
            <label htmlFor="matrix-api-key-input" className="font-mono text-muted-foreground block mb-1">
              Chave de API ({provider.toUpperCase()}):
            </label>
            <div className="relative">
              <input
                id="matrix-api-key-input"
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Ex.: gsk_..."
                className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-10 font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/60"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showKey ? "Ocultar chave" : "Mostrar chave"}
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">
              A chave introduzida é enviada à bridge protegida; a chave guardada nunca é devolvida a esta interface.
            </p>
          </div>

          {feedback && (
            <div
              className={`rounded-lg p-2.5 text-xs font-mono flex items-center gap-2 ${
                feedback.type === "success"
                  ? "bg-cyber-green/10 text-cyber-green border border-cyber-green/30"
                  : "bg-destructive/10 text-destructive border border-destructive/30"
              }`}
            >
              {feedback.type === "success" ? <Check className="w-4 h-4 shrink-0" /> : <ShieldAlert className="w-4 h-4 shrink-0" />}
              <span>{feedback.message}</span>
            </div>
          )}

          {/* Botões de Ação */}
          <div className="flex items-center justify-between pt-2">
            {hasConfiguredKey ? (
              <button
                type="button"
                onClick={handleClear}
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 font-mono text-xs text-destructive hover:bg-destructive/20 transition-colors disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Remover chave
              </button>
            ) : <div />}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-border bg-secondary px-3 py-1.5 font-mono text-xs text-foreground hover:bg-secondary/80 transition-colors"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={loading || !apiKey.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary/50 bg-primary px-3 py-1.5 font-mono text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Guardar chave
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
