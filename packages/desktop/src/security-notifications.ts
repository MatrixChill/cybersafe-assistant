/**
 * RECOVERY-SECURITY-20261014 (P0, qoder): decisao de notificacoes de
 * seguranca do desktop, separada do Electron para ser testavel com mocks
 * comportamentais. O shell (main.ts) injeta `notify`, que e o unico caminho
 * ate `new Notification(...).show()`; este modulo decide QUEM chegar ao
 * utilizador, com preferencia, dedup por fingerprint e copy PT-PT.
 *
 * Nada aqui alega toast real do Windows — prova a decisao, nao o SO.
 */

export const SECURITY_EVENT_TYPES = [
  "threat.detected",
  "quarantine.added",
  "quarantine.failed",
  "process.blocked",
  "process.suspicious",
  "protection.changed",
] as const;

type SecurityEventLike = {
  type: string;
  severity: string;
  summary: string;
  data?: unknown;
};

export type SecurityNotificationsDeps = {
  notify: (title: string, body: string) => void;
  notificationsEnabled: () => boolean;
  isQuitting: () => boolean;
  now?: () => number;
};

const DEFAULT_WINDOW_MS = 15_000;
const SUSPICIOUS_WINDOW_MS = 60_000;
const ENGINE_WINDOW_MS = 60_000;
const TITLE = "CyberSafe Assistant";

const HIGH_SEVERITIES = new Set(["medium", "high", "critical"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function textOf(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

/**
 * PRIVACIDADE (sessao final): um toast e visivel sobre ombros. Nenhum caminho
 * absoluto — com username, pasta de trabalho ou share de rede — pode chegar ao
 * corpo. O nome real do alvo fica apenas no fingerprint interno (RAM, com
 * teto), nunca no texto mostrado.
 */
export function safeBasename(value: unknown): string {
  if (typeof value !== "string") return "elemento";
  const cleaned = value.replace(/[\u0000-\u001f]/g, "").trim();
  if (!cleaned) return "elemento";
  const parts = cleaned.split(/[\\/]+/).filter((part) => part.length > 0);
  const last = parts[parts.length - 1] ?? cleaned;
  return last.length > 80 ? last.slice(0, 80) : last;
}

export function redactPaths(text: string): string {
  // Conservadora por desenho: o padrao engole o caminho ATE ao delimitador
  // duro (virgula, ponto-e-virgula, aspas, fim de linha), incluindo espacos.
  // Pode tragar alguma prosa depois do nome; nunca deixa sobrar prefixo ou
  // sufixo privado tipo "Doe\Downloads\file.exe". Rede de seguranca — os
  // toasts estruturados ja nao usam texto cru.
  return text
    .replace(/\\\\[^\r\n,;""']*/g, (match) => safeBasename(match))
    .replace(/[A-Za-z]:[\\/][^\r\n,;""']*/g, (match) => safeBasename(match))
    .replace(/(?:\/[^\r\n,;""'\\]+){2,}/g, (match) => safeBasename(match));
}

export function createSecurityNotifications(deps: SecurityNotificationsDeps) {
  const now = deps.now ?? (() => Date.now());
  const lastShown = new Map<string, number>();

  // Estado confirmado da protecao lido do ultimo protection.changed.
  // `undefined` = ainda nao vimos nenhum; a primeira leitura "ativa" e
  // baseline silenciosa (nao ha spam de "est tudo bem" no arranque).
  let protectionKnown: { enabled: boolean; paused: boolean } | undefined;

  // Ciclo de vida da ligacao ao motor: `undefined` antes da primeira
  // noticia, para o arranque ligado nao notificar.
  let motorDownKnown: boolean | undefined;

  // Review CODEX: o mapa crescia por ficheiro/processo sem limite. O teto
  // expira primeiro o que ja saiu da maior janela e, se ainda couber,
  // descarta o mais antigo — dentro das 512 entradas o dedup e identico.
  const MAX_TRACKED_KEYS = 512;
  const LONGEST_WINDOW = Math.max(DEFAULT_WINDOW_MS, SUSPICIOUS_WINDOW_MS, ENGINE_WINDOW_MS);

  function track(key: string, at: number): void {
    if (!lastShown.has(key) && lastShown.size >= MAX_TRACKED_KEYS) {
      for (const [tracked, shownAt] of lastShown) {
        if (at - shownAt > LONGEST_WINDOW) lastShown.delete(tracked);
      }
      while (lastShown.size >= MAX_TRACKED_KEYS) {
        const oldest = lastShown.keys().next().value;
        if (oldest === undefined) break;
        lastShown.delete(oldest);
      }
    }
    lastShown.set(key, at);
  }

  function suppressed(key: string, windowMs: number): boolean {
    const t = now();
    const prev = lastShown.get(key);
    if (prev !== undefined && t - prev <= windowMs) return true;
    track(key, t);
    return false;
  }

  function emit(key: string, windowMs: number, body: string): void {
    if (suppressed(key, windowMs)) return;
    deps.notify(TITLE, redactPaths(body));
  }

  function fingerprint(event: SecurityEventLike, data: Record<string, unknown>): string {
    const target =
      textOf(
        data.artifactPath,
        // ThreatEvent real publica filePath/url; artifactPath nao existe la.
        data.filePath,
        data.path,
        data.fileName,
        data.appName,
        data.name,
      ) ?? event.summary;
    return `${event.type}:${target}`;
  }

  /**
   * Copy estruturada: o toast e composto a partir do NOME medido
   * (safeBasename), nunca do summary cru do motor — que pode conter o caminho
   * completo com username e pastas. Sem nome, a frase fica generica; nao se
   * inventa verdict nem identificador.
   */
  function subjectOf(data: Record<string, unknown>, fallback: string): string {
    const raw = textOf(data.fileName, data.artifactPath, data.filePath, data.path, data.appName, data.name);
    return raw ? safeBasename(raw) : fallback;
  }

  function handleEvent(event: SecurityEventLike): void {
    if (deps.isQuitting() || !deps.notificationsEnabled()) return;

    const data = asRecord(event.data);

    switch (event.type) {
      case "threat.detected": {
        // O prefixo segue o verdict medido: nao se chama "ameaca" ao que o
        // motor classificou como suspeito ou desconhecido.
        const verdict = typeof data.verdict === "string" ? data.verdict : undefined;
        const prefix =
          verdict === "malicious" ? "Ameaça detetada em"
            : verdict === "suspicious" ? "Ficheiro suspeito detetado:"
              : "Deteção registada sobre";
        emit(fingerprint(event, data), DEFAULT_WINDOW_MS, `${prefix} ${subjectOf(data, "um ficheiro")}`);
        return;
      }

      case "process.blocked":
        // O bloqueio real e de EXECUCAO (script.blocked/AMSI); dizer
        // "processo bloqueado" inferiria que o processo inteiro foi terminado.
        emit(fingerprint(event, data), DEFAULT_WINDOW_MS, `Execução bloqueada: ${subjectOf(data, "processo")}`);
        return;

      case "process.suspicious": {
        // Suspeito de baixa severidade fica fora: o motor publica varios
        // por minuto e o utilizador deixaria de ler os que importam.
        if (!HIGH_SEVERITIES.has(event.severity)) return;
        emit(fingerprint(event, data), SUSPICIOUS_WINDOW_MS, `Comportamento suspeito: ${subjectOf(data, "processo")}`);
        return;
      }

      case "quarantine.added": {
        const file = safeBasename(textOf(data.fileName, data.artifactPath) ?? "ficheiro");
        emit(
          fingerprint(event, data),
          DEFAULT_WINDOW_MS,
          `Quarentena confirmada: ${file} foi colocado em quarentena.`,
        );
        return;
      }

      case "quarantine.failed": {
        const file = safeBasename(textOf(data.fileName, data.artifactPath) ?? "ficheiro");
        emit(
          fingerprint(event, data),
          DEFAULT_WINDOW_MS,
          `Falha ao colocar ${file} em quarentena; isolamento não confirmado. Verifique a quarentena antes de repetir.`,
        );
        return;
      }

      case "protection.changed": {
        const enabled = data.protectionEnabled;
        if (typeof enabled !== "boolean") return;
        const paused =
          typeof data.protectionPausedUntil === "string" && data.protectionPausedUntil.length > 0;
        const previous = protectionKnown;
        protectionKnown = { enabled, paused };
        // So mudancas REAIS notificam; estado repetido (evento atrasado ou
        // duplicado do motor) e silencio. A primeira leitura "ativa" e
        // baseline silenciosa; "desativada"/"pausa" logo ao chegar notifica.
        const changed =
          previous === undefined
            ? !enabled || paused
            : previous.enabled !== enabled || previous.paused !== paused;
        if (changed) {
          // A pausa manda primeiro: com `enabled=false` e pausa ativa, dizer
          // só "desativada" escondia o estado intermedio. A copy do OFF nao
          // infere Windows/Defender — fala so do CyberSafe.
          const body = paused
            ? "Proteção em tempo real em pausa."
            : !enabled
              ? "O CyberSafe deixou de monitorizar novos ficheiros."
              : "A proteção em tempo real foi reativada.";
          deps.notify(TITLE, body);
        }
        return;
      }

      case "engine.health": {
        // Informativo (definizoes atualizadas, degradacao leve) nao vira
        // toast. So falha de motor essencial, com severidade alta.
        if (!["high", "critical"].includes(event.severity)) return;
        const essential = data.essentialUnavailable;
        if (essential !== true) return;
        const name = safeBasename(textOf(data.name, data.engine) ?? "motor essencial");
        emit(
          `engine.health:${name}`,
          ENGINE_WINDOW_MS,
          `Motor essencial indisponível: ${name}. Proteção em modo degradado.`,
        );
        return;
      }

      default:
        // file.*, process.started/exited, scan.progress, artifact.*,
        // trust.updated, threat.resolved, quarantine.restored,
        // persistence/registry — benignos ou de baixa sinal: nunca toast.
        return;
    }
  }

  function handleConnectionState(connected: boolean): void {
    if (deps.isQuitting() || !deps.notificationsEnabled()) return;
    const down = !connected;
    if (motorDownKnown === undefined) {
      // Primeira noticia do motor no arranque: ligado e baseline silenciosa;
      // chegar ja em baixo e indisponibilidade real, notifica.
      motorDownKnown = down;
      if (down) {
        deps.notify(
          TITLE,
          "O motor de proteção deixou de responder — proteção essencial indisponível.",
        );
      }
      return;
    }
    if (motorDownKnown === down) return;
    motorDownKnown = down;
    deps.notify(
      TITLE,
      down
        ? "O motor de proteção deixou de responder — proteção essencial indisponível."
        : "O motor de proteção está restabelecido e disponível.",
    );
  }

  return { handleEvent, handleConnectionState, trackedSize: () => lastShown.size };
}
