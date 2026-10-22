import type { ScanState } from "@cybersafe/shared-types";

/**
 * Copy do menu da tray — módulo puro (sem Electron) para ser testável.
 *
 * Regra de produto: o utilizador nunca vê enums internos do backend
 * ("safe", "attention", "degraded", "critical", ...). Todo o estado é
 * traduzido para português apresentável e os valores vêm sempre do estado
 * REAL do serviço (nunca inventados).
 */

export interface TrayProtectionInfo {
  /** O serviço de proteção está vivo (motores a funcionar). */
  serviceRunning: boolean;
  /** Estado bruto do backend. Só serve para tradução/logs — nunca é mostrado cru. */
  status: string | null;
  /** Pontuação de proteção (100 − riskScore), 0–100, ou null se indisponível. */
  score: number | null;
  /** Eventos de severidade alta recentes. */
  threats: number | null;
  /** Itens em quarentena. */
  quarantine: number | null;
  /**
   * Facto real on/off lido do motor. `undefined`/`null` = não lido, e nesse caso
   * a tray NÃO pode afirmar "Protegido".
   */
  protectionEnabled?: boolean | null;
  /** ISO date até onde a proteção está em pausa, se estiver. */
  pausedUntil?: string | null;
  /**
   * Estado de análise publicado pelo motor (R7-L3). `null`/ausente =
   * nenhuma análise confirmada: a tray não mostra linha de análise.
   */
  scan?: TrayScanInfo | null;
  /**
   * Acção em curso, pedida pelo utilizador e AINDA NÃO confirmada pelo motor.
   * Não é estado confirmado: serve só para feedback imediato e para bloquear um
   * segundo clique enquanto o primeiro está em voo.
   */
  pendingAction?: TrayPendingAction | null;
}

/** Tradução dos estados internos. A chave em inglês nunca chega à UI. */
export const PROTECTION_STATUS_LABELS: Record<string, string> = {
  safe: "Protegida",
  attention: "Atenção",
  warning: "Atenção",
  degraded: "Precisa de atenção",
  critical: "Crítica",
  paused: "Pausada",
  unavailable: "Indisponível",
};

/** Estado desconhecido: mostramos indisponível em vez de vazar o enum. */
export const PROTECTION_STATUS_UNKNOWN = "Indisponível";

export function protectionStatusLabel(status?: string | null): string {
  if (typeof status !== "string") return PROTECTION_STATUS_UNKNOWN;
  return PROTECTION_STATUS_LABELS[status.trim().toLowerCase()] ?? PROTECTION_STATUS_UNKNOWN;
}

/**
 * Os três estados que a tray representa. São sobre a MÁQUINA, não sobre a
 * "proteção": o ícone responde "como está o meu computador?", não "o que
 * decidiu o motor?".
 */
export type TrayProtectionLevel = "protected" | "attention" | "unprotected";

export const TRAY_LEVEL_LABELS: Record<TrayProtectionLevel, string> = {
  protected: "Protegido",
  attention: "Precisa de atenção",
  unprotected: "Não protegido",
};

/**
 * Acção de proteção PEDIDA pelo utilizador e ainda NÃO confirmada pelo motor.
 *
 * Serve para a tray dar feedback imediato ao clique (o bug medido: o menu
 * continuava a mostrar "Ativar proteção" durante segundos, e o clique parecia
 * não fazer nada). NÃO é um estado: nunca muda `trayProtectionLevel`, porque o
 * motor ainda não falou. Só a confirmação do motor muda o estado.
 */
export type TrayPendingAction = "starting" | "stopping" | "pausing";

/** Copy do que está a acontecer. NUNCA afirma o resultado — isso é do motor. */
export const TRAY_PENDING_LABELS: Record<TrayPendingAction, string> = {
  starting: "A ativar proteção…",
  stopping: "A desativar proteção…",
  pausing: "A pausar proteção…",
};

/** Linha do pedido em curso, ou null quando não há nada pendente. */
export function trayPendingLine(pending?: TrayPendingAction | null): string | null {
  if (!pending) return null;
  return TRAY_PENDING_LABELS[pending] ?? null;
}

/**
 * Deriva o estado da tray a partir de factos, nunca de ausência de notícias.
 *
 * Regras, pela ordem em que são testadas:
 *
 *  1. `protectionEnabled === false` → não protegido. É o único facto que
 *     significa "desligada": veio do motor.
 *  2. Serviço parado → não protegido. Sem motor não há proteção; isto é um
 *     facto, não uma falta de informação.
 *  3. `status` desconhecido → precisa de atenção. Desconhecido NÃO é desligado,
 *     mas também não permite dizer "protegido".
 *  4. `status === "critical"` → não protegido.
 *  5. `degraded` / `attention` → precisa de atenção. Degradado não é ativo:
 *     parte dos motores vigia, e a máquina não está protegida por inteiro.
 *  6. Só `status === "safe"` **e** `protectionEnabled === true` dá protegido.
 *
 * O ponto 6 é o que impede "Protegido" por ausência de ameaças: o status sozinho
 * diz "safe" quando não há nada para reportar, mesmo com a proteção desligada.
 */
export function trayProtectionLevel(info: TrayProtectionInfo): TrayProtectionLevel {
  if (info.protectionEnabled === false) return "unprotected";
  if (!info.serviceRunning) return "unprotected";

  const status = typeof info.status === "string" ? info.status.trim().toLowerCase() : null;
  if (!status) return "attention";
  if (status === "critical") return "unprotected";
  if (status === "degraded" || status === "attention" || status === "warning") {
    return "attention";
  }
  if (status === "safe" && info.protectionEnabled === true) return "protected";
  // "safe" sem o motor confirmar a proteção: não afirmamos o que não medimos.
  return "attention";
}

/** Variante de ficheiro por estado. `active` = protegido. */
export type TrayIconVariant = "active" | "warning" | "critical";

export const TRAY_ICON_VARIANT: Record<TrayProtectionLevel, TrayIconVariant> = {
  protected: "active",
  attention: "warning",
  unprotected: "critical",
};

/**
 * Variante usada quando o nível não é um valor de `TrayProtectionLevel`.
 *
 * Deliberadamente NUNCA `active`: um nível desconhecido que caísse em
 * "protegido" pintaria uma garantia que não medimos — exactamente o que
 * `trayProtectionLevel` recusa em todo o resto do módulo. Desconhecido é,
 * para esta máquina, "precisa de atenção".
 */
export const UNKNOWN_LEVEL_ICON_VARIANT: TrayIconVariant = "warning";

/**
 * Qual asset de tray usar, em ordem de preferência.
 *
 * 1. `tray-symbol-<estado>-<slot>.png` — dedicado ao slot (16/20/24/32), 1:1,
 *    sem resize. É o que dá nitidez na bandeja do Windows.
 * 2. `tray-icon-<estado>.png` — 32 px, redimensionado.
 * 3. `tray-icon-active.png` — último recurso, e **só quando o ficheiro em disco
 *    não existe**. Uma tray sem ícone é pior do que uma tray com o ícone do
 *    estado errado, mas isto nunca é o caminho de um estado desconhecido: esse
 *    resolve para `warning` no passo 1 e, com os assets presentes, nunca chega
 *    aqui.
 *
 * `exists` é injetado para esta função continuar pura e testável sem disco.
 */
export function resolveTrayIconAsset(
  level: TrayProtectionLevel,
  slotPx: number,
  exists: (p: string) => boolean,
  assetsPath: (...seg: string[]) => string,
): { path: string; dedicated: boolean } {
  // `??` e não indexação crua: um nível fora do enum não pode virar `undefined`
  // dentro do nome do ficheiro (`tray-symbol-undefined-20.png`, que não existe e
  // degradava para o ícone de "protegido").
  const variant = TRAY_ICON_VARIANT[level] ?? UNKNOWN_LEVEL_ICON_VARIANT;

  const symbol = assetsPath("cybersafe", `tray-symbol-${variant}-${slotPx}.png`);
  if (exists(symbol)) return { path: symbol, dedicated: true };

  const fallback = assetsPath("cybersafe", `tray-icon-${variant}.png`);
  if (exists(fallback)) return { path: fallback, dedicated: false };

  const last = assetsPath("tray-icon-active.png");
  return { path: last, dedicated: false };
}

/** "CyberSafe Assistant — Protegido". O prefixo é o produto; o estado é real. */
export function trayTooltip(level: TrayProtectionLevel, pausedUntil?: string | null): string {
  if (pausedUntil) {
    return `CyberSafe Assistant — Proteção em pausa até ${formatPauseRemaining(pausedUntil)}`;
  }
  return `CyberSafe Assistant — ${TRAY_LEVEL_LABELS[level]}`;
}

function formatPauseRemaining(until: string): string {
  const ms = new Date(until).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "reativação manual";
  if (ms <= 0) return "reativação iminente";
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `daqui a ${min} min`;
  const h = Math.floor(min / 60);
  return `daqui a ${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

export function serviceStatusLine(serviceRunning: boolean): string {
  return serviceRunning ? "● Serviço ativo" : "○ Serviço parado";
}

/** Linha de proteção: "Proteção: Precisa de atenção · 55/100". */
export function protectionLine(info: TrayProtectionInfo): string {
  const label = protectionStatusLabel(info.status);
  const score =
    typeof info.score === "number" && Number.isFinite(info.score)
      ? Math.round(info.score)
      : null;
  return score === null ? `Proteção: ${label}` : `Proteção: ${label} · ${score}/100`;
}

/** Linhas de contadores. null = sem dado real, a linha é omitida. */
export function threatsLine(threats: number | null): string | null {
  return typeof threats === "number" && Number.isFinite(threats)
    ? `Ameaças recentes: ${threats}`
    : null;
}

export function quarantineLine(quarantine: number | null): string | null {
  return typeof quarantine === "number" && Number.isFinite(quarantine)
    ? `Em quarentena: ${quarantine}`
    : null;
}

/**
 * Estado de análise para a tray (R7-L3). Só factos PUBLICADOS pelo
 * motor: o progresso só existe quando o motor deu um número real,
 * e uma análise cancelada não entra aqui (quem alimenta o campo
 * decide não a apresentar — "concluída" seria mentira).
 */
export interface TrayScanInfo {
  status: "running" | "completed" | "failed";
  /** Fase do motor (preparing/gathering/scanning/finalizing), se informada. */
  phase?: string;
  /** Progresso real 0–100, ou null quando o motor não publicou número. */
  progress?: number | null;
  /** Ameaças detetadas (só afirmado no fim da análise). */
  threatsFound?: number;
}

/** Fases do motor → frase em português. Fase desconhecida = sem fase. */
export const SCAN_PHASE_LABELS: Record<string, string> = {
  preparing: "a preparar",
  gathering: "a reunir ficheiros",
  scanning: "a analisar ficheiros",
  finalizing: "a finalizar",
};

/**
 * Uma linha de estado da análise, ou null quando não há análise
 * confirmada. NUNCA inventa: sem número real não há percentagem,
 * e "0%"/"100%" não são progresso — 0 é o arranque e 100 só
 * existe no estado terminal.
 */
export function scanLine(scan?: TrayScanInfo | null): string | null {
  if (!scan || typeof scan.status !== "string") return null;
  if (scan.status === "running") {
    const phase =
      typeof scan.phase === "string" ? SCAN_PHASE_LABELS[scan.phase] ?? null : null;
    const label = phase === null ? "Análise em curso" : `Análise em curso — ${phase}`;
    const progress =
      typeof scan.progress === "number" && Number.isFinite(scan.progress)
        ? Math.round(scan.progress)
        : null;
    if (progress !== null && progress > 0 && progress < 100) {
      return `${label} · ${progress}%`;
    }
    return label;
  }
  if (scan.status === "completed") {
    const threats =
      typeof scan.threatsFound === "number" && Number.isFinite(scan.threatsFound)
        ? Math.max(0, Math.round(scan.threatsFound))
        : 0;
    if (threats > 0) {
      return `Última análise: concluída — ${
        threats === 1 ? "1 ameaça detetada" : `${threats} ameaças detetadas`
      }`;
    }
    return "Última análise: concluída";
  }
  if (scan.status === "failed") {
    return "Última análise: falhou";
  }
  return null;
}

export interface TrayMenuItem {
  label?: string;
  enabled?: boolean;
  type?: "separator";
  click?: () => void;
}

export async function handleQuickScanRequest(
  request: () => Promise<{ id?: string; success?: boolean; error?: string }>,
  onStarted: () => void,
  onRejected: (message: string) => void,
): Promise<boolean> {
  try {
    const result = await request();
    if (result?.success !== true || !result.id) {
      onRejected(result?.error || "Não foi possível iniciar a verificação rápida.");
      return false;
    }
    onStarted();
    return true;
  } catch (error) {
    onRejected(error instanceof Error ? error.message : String(error));
    return false;
  }
}

export interface TrayMenuHandlers {
  open: () => void;
  exit: () => void;
  /** Verificação rápida. Só é oferecida quando o motor aceita o pedido. */
  quickScan?: () => void;
  /** Abre a página de estado da proteção na janela. */
  showProtection?: () => void;
  /** Abre as definições. */
  openSettings?: () => void;
  /** Abre a quarentena. */
  openQuarantine?: () => void;
  /** Pára a proteção (estado real, motor confirma). */
  stopProtection?: () => void;
  /** Liga a proteção. */
  startProtection?: () => void;
  /** Pausa por N minutos. */
  pauseProtection?: (minutes: number) => void;
}

/**
 * Template do menu da tray.
 *
 * O menu mostra o que o utilizador pode FAZER, não o que o motor sabe. Cada
 * ação existe aqui porque existe backend para a levar a cabo — uma acção sem
 * handler real não entra no menu, para não haver item que não faz nada.
 */
export function buildTrayMenuTemplate(
  info: TrayProtectionInfo,
  handlers: TrayMenuHandlers,
): TrayMenuItem[] {
  const level = trayProtectionLevel(info);
  // Acção pedida e ainda NÃO confirmada: dá feedback imediato ao clique sem
  // mudar o nível (que só a confirmação do motor pode mudar).
  const pending = info.pendingAction ?? null;
  const pendingLine = trayPendingLine(pending);
  const actionAllowed = pending === null;
  const items: TrayMenuItem[] = [
    { label: "CyberSafe Assistant", enabled: false },
    { label: TRAY_LEVEL_LABELS[level], enabled: false },
    { label: protectionLine(info), enabled: false },
  ];

  // A pausa NÃO tem linha própria aqui em cima: o tempo restante vive na única
  // linha de estado em tempo real, mais abaixo. Uma segunda linha a dizer
  // "em pausa" é o que contradizia "Desativada" no mesmo menu (Teste 3).

  const threats = threatsLine(info.threats);
  if (threats) items.push({ label: threats, enabled: false });

  const quarantine = quarantineLine(info.quarantine);
  if (quarantine) items.push({ label: quarantine, enabled: false });

  // Uma linha de estado da análise (R7-L3): só existe quando o motor
  // publicou um facto. Ausente = nenhuma análise confirmada.
  const scan = scanLine(info.scan);
  if (scan) items.push({ label: scan, enabled: false });

  pushSeparator(items);

  // Não há "ação de correcção" separada aqui. Oferecer "Ativar proteção agora"
  // além da ação do bloco de estado era a DUPLICAÇÃO que o Teste 3 mediu: dois
  // itens a chamar o mesmo `startProtection` no mesmo menu. A única ação de
  // ativação/retoma vive no bloco de estado em tempo real, mais abaixo.

  items.push({ label: "Abrir CyberSafe", click: handlers.open });
  if (handlers.quickScan) {
    items.push({ label: "Executar verificação rápida", click: handlers.quickScan });
  }
  if (handlers.showProtection) {
    items.push({ label: "Ver estado da proteção", click: handlers.showProtection });
  }

  // ── Proteção em tempo real: LIGADA não é o mesmo que tudo verde ──
  //
  // MEDIDO (2026-10-07, scripts/protection-toggle-probe.mjs, motor real):
  // `monitor.start` devolve `{ok:true, protectionEnabled:true}` e o
  // `protection.getState` seguinte diz `protectionEnabled:true` com
  // `status:"degraded"` — porque nesta máquina o YARA só tem corpus de teste e
  // o filtro WFP está inativo. A proteção LIGADA é um facto do motor; o que não
  // está é tudo saudável.
  //
  // Este bloco escolhia o ramo por `level === "protected"`, que exige
  // `status === "safe"`. Consequência medida: com a proteção ligada e um motor
  // degradado, o menu continuava a mostrar "Ativar proteção" DEPOIS de o
  // utilizador a ter ligado — o item não mudava de sítio nem de texto, e o
  // clique parecia não fazer nada (o bug reportado).
  //
  // O ramo passa a seguir o facto do MOTOR (`protectionEnabled`), e a saúde dos
  // motores continua a ser dita nas linhas acima ("Precisa de atenção",
  // "Proteção: ..."). São dois factos diferentes e os dois aparecem — não se
  // troca um pelo outro.
  const pauseHandler = handlers.pauseProtection;
  const startHandler = handlers.startProtection;
  const stopHandler = handlers.stopProtection;
  // Facto do motor lido? (true/false). `null` = leitura falhada, não é um facto.
  const protectionKnown = typeof info.protectionEnabled === "boolean";
  const enabled = info.protectionEnabled === true;
  // Pausa confirmada: `pausedUntil` é o facto mais forte e precede tanto
  // "Ativa" como "Desativada". Pausa NÃO é desligada — é um estado com prazo.
  // A retoma usa `startProtection` porque é esse o contrato efetivo em main.ts
  // (`startProtection` -> `monitor.start`, que termina a pausa); não existe
  // handler de retoma próprio.
  const pausedUntil =
    typeof info.pausedUntil === "string" && info.pausedUntil.trim() !== ""
      ? info.pausedUntil.trim()
      : null;

  // A linha aparece quando há um FACTO do motor ou uma AÇÃO real por trás dela.
  // Sem nenhum dos dois seria uma linha decorativa — o mesmo critério que o
  // resto do menu usa.
  if (protectionKnown || startHandler || pauseHandler || stopHandler || pendingLine) {
    pushSeparator(items);

    // EXATAMENTE UMA linha de estado em tempo real, mutuamente exclusiva:
    // Em pausa (com prazo real) > Ativa > Desativada > Indisponível.
    let realtimeLabel: string;
    if (pausedUntil) {
      realtimeLabel = `Proteção em tempo real — Em pausa (reativa ${formatPauseRemaining(pausedUntil)})`;
    } else if (enabled) {
      realtimeLabel = "Proteção em tempo real — Ativa";
    } else if (protectionKnown) {
      realtimeLabel = "Proteção em tempo real — Desativada";
    } else {
      // Sem leitura do motor não se afirma nenhum dos dois estados: "Desativada"
      // com a proteção a correr seria uma mentira, e "Ativa" não tem prova.
      realtimeLabel = "Proteção em tempo real — Indisponível";
    }
    items.push({ label: realtimeLabel, enabled: false });

    if (pendingLine) {
      // Prova de que o clique foi aceite, sem prometer o resultado. É
      // informação, não uma segunda ação.
      items.push({ label: pendingLine, enabled: false });
    }

    // EXATAMENTE UMA ação de mudança de estado por menu: nunca pausas a
    // duplicar enquanto já está pausado, nunca duas ativações.
    if (pausedUntil) {
      if (startHandler) {
        items.push({ label: "Retomar proteção agora", enabled: actionAllowed, click: startHandler });
      }
    } else if (enabled) {
      if (pauseHandler) {
        items.push({ label: "Pausar 15 minutos", enabled: actionAllowed, click: () => pauseHandler(15) });
        items.push({ label: "Pausar 1 hora", enabled: actionAllowed, click: () => pauseHandler(60) });
      }
      if (stopHandler) {
        items.push({ label: "Desligar até ativação manual", enabled: actionAllowed, click: stopHandler });
      }
    } else if (startHandler) {
      // Só aqui "Ativar proteção" faz sentido: com o motor a confirmar a proteção
      // ligada, este item seria um no-op que parece não fazer nada.
      items.push({ label: "Ativar proteção", enabled: actionAllowed, click: startHandler });
    }
  }

  if (handlers.openQuarantine || handlers.openSettings) {
    pushSeparator(items);
    if (handlers.openQuarantine) {
      items.push({ label: "Quarentena", click: handlers.openQuarantine });
    }
    if (handlers.openSettings) {
      items.push({ label: "Definições", click: handlers.openSettings });
    }
  }

  pushSeparator(items);
  items.push({ label: "Sair do CyberSafe...", click: handlers.exit });

  return items;
}

/**
 * Junta um separador, mas nunca dois seguidos: um separador colado a outro
 * desenha uma linha dupla e parece um separador esquecido.
 */
function pushSeparator(items: TrayMenuItem[]): void {
  if (items.length > 0 && items[items.length - 1].type !== "separator") {
    items.push({ type: "separator" });
  }
}


/** Uma ação em voo; o serviço continua a impor a exclusividade do worker. */
export function createTrayQuickScan(
  request: (topic: "scan.getActive" | "scan.start" | "scan.getLast", payload: any) => Promise<unknown>,
  onSession: (state: ScanState) => void,
  onError: (message: string) => void,
): () => Promise<boolean> {
  let pending: Promise<boolean> | null = null;
  const active = (value: unknown): value is ScanState => {
    const s = value as ScanState | null;
    return !!s?.id && (s.status === "running" || s.status === "queued");
  };
  return () => {
    if (pending) return pending;
    pending = (async () => {
      try {
        let state = await request("scan.getActive", undefined);
        if (!active(state)) {
          let result;
          try { result = await request("scan.start", { type: "quick" }) as { id?: string; success?: boolean }; }
          catch (error) {
            // Outro caller pode ter ganho a corrida: adotar, sem uma segunda criação.
            state = await request("scan.getActive", undefined);
            if (!active(state)) throw error;
          }
          if (result) {
            if (result.success !== true || !result.id) throw new Error("Pedido recusado");
            state = await request("scan.getActive", undefined);
            if ((state as ScanState | null)?.id !== result.id) state = await request("scan.getLast", {id:result.id});
            if ((state as ScanState | null)?.id !== result.id) throw new Error("Sessão não confirmada");
          }
        }
        if (!(state as ScanState | null)?.id) throw new Error("Sessão não confirmada");
        onSession(state as ScanState);
        return true;
      } catch {
        onError("Não foi possível comunicar com o serviço de análise. Tente novamente.");
        return false;
      }
    })().finally(() => { pending = null; });
    return pending;
  };
}
