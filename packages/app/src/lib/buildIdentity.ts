/**
 * Identidade REAL da aplicação: versão (package.json do renderer) + build ID
 * (carimbo do `vite build`) + commit git da árvore de build. Nada é inventado:
 * quando o carimbo não existe (dev/tsx/testes), os valores são declarados como
 * "desconhecida"/"desenvolvimento" — nunca um número bonito fingido.
 */

export interface BuildIdentity {
  version: string;
  buildId: string;
  commit: string;
  sourceState?: "modified" | "clean" | "unknown";
}

declare const __BUILD__: BuildIdentity | undefined;

export function resolveIdentity(): BuildIdentity {
  if (typeof __BUILD__ !== "undefined" && __BUILD__ && __BUILD__.version) {
    return __BUILD__;
  }
  return { version: "desconhecida", buildId: "desenvolvimento", commit: "desconhecido" };
}

/** Chip curto para a barra lateral: `v0.1.1 · build 20261016-0945`. */
export function formatBuildBadge(i: BuildIdentity): string {
  return `v${i.version} · build ${i.buildId}`;
}

function sourceStateText(i: BuildIdentity): string {
  if (i.sourceState === "modified") return "Alterações locais; o commit identifica apenas a base";
  if (i.sourceState === "clean") return "Sem alterações locais no momento da compilação";
  return "Não verificado";
}

/** Linhas da secção "Sobre o CyberSafe" — rótulo/valor já em PT-PT. */
export function aboutIdentityLines(i: BuildIdentity): { label: string; value: string }[] {
  return [
    { label: "Versão", value: `v${i.version}` },
    { label: "Compilação", value: i.buildId },
    { label: "Código (commit)", value: i.commit },
    ...(i.sourceState ? [{ label: "Estado do código", value: sourceStateText(i) }] : []),
  ];
}

/**
 * Versão Electron lida do user-agent do renderer — sem IPC nem tocar no main.
 * Fora do Electron (browser/dev) devolve "não aplicável"; nunca um número fingido.
 */
export function electronVersionFromUserAgent(ua: string): string {
  const m = ua.match(/Electron\/([\d.]+)/);
  return m ? m[1] : "não aplicável";
}

/** Payload do botão "copiar informações técnicas" — só identidade, zero dados pessoais. */
export function technicalInfoText(i: BuildIdentity, electronVersion: string): string {
  return [
    `CyberSafe Assistant v${i.version}`,
    `Compilação: ${i.buildId}`,
    `Commit: ${i.commit}`,
    `Estado do código: ${sourceStateText(i)}`,
    `Electron: ${electronVersion}`,
  ].join("\n");
}
