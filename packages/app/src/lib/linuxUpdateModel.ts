/**
 * Modelo PT-PT da secção «Atualizações» em Linux (pacote Arch).
 *
 * Os dados vêm do comando `cybersafe-linux-update` (via IPC dedicado). Este
 * módulo não decide nada sobre segurança: só traduz o estado verificado pelo
 * comando (assinatura Ed25519, versão, tamanho, SHA-256) em texto honesto.
 * Nunca diz «atualizado» sem uma verificação bem-sucedida.
 */
export interface LinuxUpdateWire {
  ok: boolean;
  result: Record<string, unknown> | null;
  error?: "not-linux" | "consent-required" | "not-installed" | "timeout" | "invalid-response";
}

export type LinuxUpdateTone = "ok" | "info" | "warn" | "error" | "neutral";

export interface LinuxUpdateView {
  title: string;
  detail: string | null;
  tone: LinuxUpdateTone;
  installed: string | null;
  available: string | null;
  sizeText: string | null;
  notes: string | null;
  checkedAt: string | null;
  signatureText: string | null;
  downloadText: string | null;
  canDownload: boolean;
  canInstall: boolean;
  packageSha256: string | null;
  channel: string | null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function formatBytes(n: unknown): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  const mb = n / (1024 * 1024);
  return `${mb.toFixed(1).replace(".", ",")} MB`;
}

const ERROR_TEXT: Record<NonNullable<LinuxUpdateWire["error"]>, string> = {
  "not-linux": "Disponível apenas no CyberSafe para Linux.",
  "consent-required": "A instalação precisa da sua confirmação.",
  "not-installed": "O comando de atualizações não está instalado nesta versão do pacote.",
  timeout: "A operação demorou demasiado e foi interrompida.",
  "invalid-response": "Resposta inesperada do atualizador.",
};

export function linuxUpdateView(wire: LinuxUpdateWire | null): LinuxUpdateView {
  const empty: LinuxUpdateView = {
    title: "Ainda não verificado", detail: "Use «Verificar atualizações» para consultar o canal oficial.", tone: "neutral",
    installed: null, available: null, sizeText: null, notes: null, checkedAt: null, signatureText: null,
    downloadText: null, canDownload: false, canInstall: false, channel: null, packageSha256: null,
  };
  if (!wire) return empty;
  if (!wire.result) return { ...empty, title: "Não foi possível verificar", detail: ERROR_TEXT[wire.error ?? "invalid-response"], tone: "error" };
  const r = wire.result;
  const available = obj(r.available);
  const download = obj(r.download);
  const install = obj(r.install);
  const base: LinuxUpdateView = {
    ...empty,
    installed: str(r.installed),
    available: str(available?.version),
    sizeText: formatBytes(available?.size),
    notes: str(available?.notes),
    checkedAt: str(r.checkedAt),
    channel: r.channel === "experimental" ? "Experimental" : r.channel === "stable" ? "Estável" : null,
    signatureText: available?.signature === "ed25519-verified" ? "Manifesto com assinatura Ed25519 verificada" : null,
    packageSha256: typeof available?.sha256 === "string" && /^[a-f0-9]{64}$/.test(available.sha256) ? available.sha256 : null,
  };
  if (install) {
    if (install.state === "terminal-requested") return { ...base, title: "Instalação solicitada", tone: "info",
      detail: "Termine as análises, saia pela tray e siga as instruções no terminal. A instalação ainda não foi confirmada." };
    if (install.error === "terminal-required") return {...base,title:"Terminal indisponível",tone:"warn",
      detail:"Abra um terminal e use cybersafe-linux-update install --consent. Confirme a versão apresentada antes de instalar."};
    if (install.error === "offered-package-changed") return {...base,title:"O pacote disponível mudou",tone:"warn",
      detail:"Volte a verificar e descarregar a versão agora disponível para confirmar a instalação."};
    const ok = install.ok === true;
    return { ...base, title: ok ? "Atualização instalada" : "Instalação não concluída", tone: ok ? "ok" : "error",
      detail: ok ? `Versão instalada agora: ${str(install.installedAfter) ?? "—"}. Reabra o CyberSafe para usar a nova versão.`
        : install.error === "consent-required" ? ERROR_TEXT["consent-required"] : "O pacman não concluiu a instalação (autorização recusada ou erro)." };
  }
  if (download) {
    const state = download.state;
    if (state === "verified") return { ...base, title: "Pronta a instalar", tone: "info", downloadText: "Descarregada e verificada (tamanho e SHA-256 do manifesto assinado).",
      detail: "A instalação usa o pacman e pede a autorização do sistema.", canInstall: base.packageSha256 !== null && base.signatureText !== null };
    return { ...base, title: "Download não concluído", tone: "warn", canDownload: true,
      detail: download.resumable === true ? "O download foi interrompido; pode retomar." : download.reason === "sha256" ? "O ficheiro não corresponde ao manifesto assinado e foi apagado." : "Não foi possível descarregar a atualização." };
  }
  switch (r.state) {
    case "available":
      return { ...base, title: `Nova versão disponível: ${base.available ?? "—"}`, tone: "info", detail: null, canDownload: true };
    case "up-to-date":
      return { ...base, title: "O CyberSafe está atualizado", tone: "ok", detail: null };
    case "not-configured":
      if(r.reason === "installed-package-unverified") return {...base,title:"Pacote instalado não confirmado",tone:"warn",
        detail:"A atualização assistida requer o pacote Arch oficial registado no pacman."};
      return { ...base, title: "Canal de atualizações não configurado", tone: "warn", detail: "Este pacote não tem chave pública de atualizações; instale uma versão mais recente manualmente." };
    case "no-release":
      return { ...base, title: "Sem versões neste canal", tone: "neutral", detail: "Ainda não há versões publicadas no canal escolhido." };
    case "downgrade-refused":
      return { ...base, title: "Sem atualização", tone: "neutral", detail: "A versão publicada no canal é anterior à instalada; não é oferecida." };
    case "invalid":
      return { ...base, title: "Atualização recusada", tone: "error", detail: r.reason === "signature" ? "A assinatura do manifesto não é válida; nada foi descarregado." : "O manifesto publicado é inválido; nada foi descarregado." };
    case "error":
      return { ...base, title: "Não foi possível consultar o canal", tone: "error", detail: "Verifique a ligação à Internet e tente novamente." };
    default:
      return { ...base, title: "Estado desconhecido", tone: "error", detail: ERROR_TEXT["invalid-response"] };
  }
}
