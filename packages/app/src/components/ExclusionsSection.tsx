import { useEffect, useRef, useState } from "react";
import type { ExclusionConfig, ExclusionRule } from "@cybersafe/shared-types";

const control = "rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50";
const button = "rounded-lg border border-border px-3 py-2 text-sm hover:border-primary/40 disabled:opacity-50";
const labels = { file: "Ficheiro", folder: "Pasta", extension: "Extensão" };

export default function ExclusionsSection() {
  const api = typeof window === "undefined" ? undefined : window.electronAPI;
  const available = Boolean(api?.getExclusions && api?.updateExclusions);
  const [config, setConfig] = useState<ExclusionConfig | null>(null);
  const [loading, setLoading] = useState(available);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<ExclusionRule["type"]>("file");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState<ExclusionRule[] | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    if (available && api) {
      api.getExclusions().then(snapshot => {
        if (!mounted.current) return;
        if (!snapshot || !Array.isArray(snapshot.rules)) throw new Error("unconfirmed");
        setConfig(snapshot);
      }).catch(() => {
        if (mounted.current) setError("Não foi possível ler as exclusões. Não afirmamos que a lista esteja vazia.");
      }).finally(() => { if (mounted.current) setLoading(false); });
    }
    return () => { mounted.current = false; };
  }, [available, api]);

  async function reload() {
    if (!api || inFlight.current) return;
    inFlight.current = true;
    setLoading(true); setError(null);
    try {
      const snapshot = await api.getExclusions();
      if (!snapshot || !Array.isArray(snapshot.rules)) throw new Error("unconfirmed");
      if (mounted.current) setConfig(snapshot);
    } catch {
      if (mounted.current) { setError("Não foi possível ler as exclusões. A lista anterior não confirma o estado atual."); setConfig(null); }
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }

  async function confirm() {
    if (!api || !pending || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await api.updateExclusions({ rules: pending });
      if (!mounted.current) return;
      if (!result?.success) {
        setError(result?.error ?? "Sem confirmação do serviço. Releia a lista antes de repetir.");
        setPending(null); setConfig(null);
        return;
      }
      setPending(null); setEditing(null); setValue(""); setReason("");
      setNotice("Alterações guardadas pelo serviço.");
      const snapshot = await api.getExclusions();
      if (!snapshot || !Array.isArray(snapshot.rules)) throw new Error("unconfirmed-read");
      if (mounted.current) setConfig(snapshot);
    } catch {
      if (mounted.current) {
        setError("O estado atual não foi confirmado. Releia as exclusões antes de repetir a operação.");
        setPending(null); setConfig(null);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function propose() {
    if (!config || !value.trim()) return;
    const previous = config.rules?.find(rule => rule.id === editing);
    const rule: ExclusionRule = {
      id: previous?.id ?? crypto.randomUUID(), type, value: value.trim(),
      enabled: previous?.enabled ?? true, createdAt: previous?.createdAt ?? new Date().toISOString(),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
    setNotice(null);
    setPending(previous ? (config.rules ?? []).map(item => item.id === rule.id ? rule : item) : [...(config.rules ?? []), rule]);
  }

  async function choose() {
    try {
      const selected = type === "folder" ? await api?.openFolderDialog() : await api?.openFileDialog();
      if (selected && mounted.current) setValue(selected);
    } catch { if (mounted.current) setError("Não foi possível abrir o seletor de caminhos."); }
  }

  const locked = !config || loading || busy || pending !== null;
  return (
    <section aria-labelledby="exclusions-title" className="surface-elevated cyber-border rounded-xl p-6 space-y-4">
      <div>
        <h2 id="exclusions-title" className="font-mono font-semibold text-foreground">Exclusões de análise</h2>
        <p className="text-sm text-muted-foreground mt-1">Os alvos excluídos não são analisados. Uma exclusão não significa que o ficheiro esteja limpo e reduz a cobertura dos motores.</p>
        <p className="text-xs text-muted-foreground mt-2">Regras do utilizador, separadas da política interna. Raízes de disco, pastas internas, ligações e extensões de risco elevado não são aceites.</p>
      </div>
      {!available && <p role="status" className="text-sm text-muted-foreground">Exclusões indisponíveis nesta janela. Abra a aplicação ligada ao serviço de ambiente de trabalho.</p>}
      {loading && <p role="status" className="text-sm text-muted-foreground">A ler as exclusões do serviço…</p>}
      {notice && <p role="status" className="text-sm text-foreground">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {config?.error && <p role="alert" className="text-sm text-destructive">{config.error}</p>}
      {available && <button type="button" disabled={loading || busy || pending !== null} onClick={() => void reload()} className={button}>Reler exclusões</button>}
      {config && !loading && <>
        <p className="text-xs text-muted-foreground">Última leitura confirmada: {config.rules?.length ?? 0} regra(s) do utilizador.</p>
        {!config.rules?.length && !config.error && <p className="text-sm text-muted-foreground">Nenhuma regra do utilizador. A política interna mantém-se.</p>}
        <ul className="space-y-3">
          {config.rules?.map(rule => <li key={rule.id} className="border border-border rounded-lg p-3 space-y-2">
            <div className="flex flex-wrap justify-between gap-2 text-sm"><strong>{labels[rule.type]}</strong><span>{rule.enabled ? "Ativa" : "Desativada"}</span></div>
            <p className="text-sm font-mono break-all select-text">{rule.value}</p>
            <p className="text-xs text-muted-foreground">Criada em {new Date(rule.createdAt).toLocaleString("pt-PT")}{rule.reason ? ` — ${rule.reason}` : ""}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={button} disabled={locked} onClick={() => { setEditing(rule.id); setType(rule.type); setValue(rule.value); setReason(rule.reason ?? ""); }}>Editar</button>
              <button type="button" className={button} disabled={locked} onClick={() => setPending((config.rules ?? []).map(item => item.id === rule.id ? { ...item, enabled: !item.enabled } : item))}>{rule.enabled ? "Desativar" : "Ativar"}</button>
              <button type="button" className={button} disabled={locked} onClick={() => setPending((config.rules ?? []).filter(item => item.id !== rule.id))}>Remover</button>
            </div>
          </li>)}
        </ul>
        <form className="space-y-3" onSubmit={event => { event.preventDefault(); propose(); }}>
          <fieldset disabled={locked} className="space-y-3">
            <legend className="text-sm font-semibold">{editing ? "Editar regra" : "Nova regra"}</legend>
            <label className="block text-sm">Tipo<select value={type} onChange={event => { setType(event.target.value as ExclusionRule["type"]); setValue(""); }} className={`${control} block mt-1 w-full`}><option value="file">Ficheiro exato</option><option value="folder">Pasta e descendentes</option><option value="extension">Extensão</option></select></label>
            <label className="block text-sm">{type === "extension" ? "Extensão, com ponto (por exemplo, .txt)" : "Caminho local absoluto"}
              <input required maxLength={1024} value={value} onChange={event => setValue(event.target.value)} className={`${control} block mt-1 w-full`} />
            </label>
            {type !== "extension" && <button type="button" className={button} onClick={() => void choose()}>Escolher {type === "folder" ? "pasta" : "ficheiro"}</button>}
            <label className="block text-sm">Motivo (opcional)
              <input maxLength={240} value={reason} onChange={event => setReason(event.target.value)} className={`${control} block mt-1 w-full`} />
            </label>
            <div className="flex gap-2">
              <button type="submit" className={button} disabled={!value.trim()}>{editing ? "Rever alteração" : "Rever nova regra"}</button>
              {editing && <button type="button" className={button} onClick={() => { setEditing(null); setValue(""); setReason(""); }}>Cancelar edição</button>}
            </div>
          </fieldset>
        </form>
      </>}
      {pending && <div role="group" aria-label="Confirmar exclusões" className="border border-border rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-semibold">Confirmar exclusões</h3>
        <p className="text-sm text-muted-foreground">Aplicar esta configuração de {pending.length} regra(s)? Os alvos das regras ativas ficam fora das análises. Remover ou desativar uma regra só repõe a cobertura nas próximas análises.</p>
        <ul className="text-xs space-y-1">{pending.map(rule => <li key={rule.id} className="break-all">{labels[rule.type]} — {rule.value} — {rule.enabled ? "Ativa" : "Desativada"}</li>)}</ul>
        <div className="flex gap-2">
          <button type="button" className={button} disabled={busy} onClick={() => void confirm()}>{busy ? "A guardar…" : "Confirmar e guardar"}</button>
          <button type="button" className={button} disabled={busy} onClick={() => setPending(null)}>Cancelar</button>
        </div>
      </div>}
    </section>
  );
}
