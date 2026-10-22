/**
 * R8 — RUNTIME DA PROTECAO USB no servico: ciclo de vida, poll bounded e
 * ligacao do monitor ao estado REAL do scan global.
 *
 * O que este modulo faz (e o que se prova nele):
 *  - `iniciar()` executa a prova de read-only ANTES de qualquer auto-scan e
 *    arranca o monitor; sem prova o monitor nao arranca analises nenhumas
 *    (a limitacao por dispositivo explica-o).
 *  - `ciclo()` alimenta o monitor com o ESTADO REAL do scan (ScanManager) e
 *    depois faz um passo de enumeracao. O resultado de uma analise so' entra
 *    pelo `aplicarResultado`: nada de resultados inventados.
 *  - `dispose()` para o timer: o poll nao sobrevive ao serviço.
 *  - O poll e' bounded: um ciclo em curso nao admite outro (o monitor ja'
 *    dedupa enumeracoes; aqui evita-se tambem o empilhamento de timers).
 *
 * O OPT-IN (`usb.configure`) NAO toca em Windows Firewall nem em
 * startProtection: e' uma preferencia propria, com o seu eixo.
 */
import path from "node:path";
import type {
  UsbCancelResult,
  UsbProtectionConfig,
  UsbProtectionSnapshot,
  UsbScanResult,
} from "@cybersafe/shared-types";
import {
  UsbConfigStore,
  UsbProtectionMonitor,
  type PortaAnaliseUsb,
  type UsbDispositivoDetetado,
} from "./usb-protection.js";

/** Intervalo do poll. Inserecoes muito curtas podem escapar — declarado. */
export const USB_POLL_INTERVAL_MS = 5_000;

/** TTL da idempotência de `usb.scan` (ms): repetir o MESMO pedido devolve o MESMO resultado. */
export const USB_REQUEST_TTL_MS = 60_000;

/** Tecto de pedidos memorizados (bounded; os mais antigos caem primeiro). */
export const USB_REQUEST_MAX = 32;

/** Limite das strings de identidade do IPC (bounded). */
export const USB_STRING_MAX = 200;

/** `requestId` é do gesto do renderer: limite mais curto. */
export const USB_REQUEST_ID_MAX = 100;

export interface OpcoesRuntimeUsb {
  baseDir: string;
  monitor: UsbProtectionMonitor;
  /** Estado real do scan global (ScanManager.getScan) para alimentar fins de analise. */
  estadoDoScan: (scanId: string) => { status?: string } | undefined | null;
  /**
   * Capacidade estrutural do caminho read-only (sincrona, sem I/O). Serve
   * para registar o estado e, se faltar, o auto-scan fica bloqueado pelo
   * proprio adapter — nunca se corre ensaio de scanner no arranque.
   */
  verificarCapacidade?: () => { ok: boolean; motivo?: string };
  /**
   * Porta de analise USB (arranca SEMPRE `readOnly: true`). Usada pela analise
   * MANUAL (`usb.scan`); ausente => a analise manual e' recusada com motivo.
   */
  analise?: PortaAnaliseUsb;
  /** Enumeracao FRESCA para resolver as raizes do `deviceId` — nunca vem do renderer. */
  enumerar?: () => Promise<UsbDispositivoDetetado[]>;
  /** O slot global esta' ocupado (analise do utilizador ou auto-scan a correr)? */
  slotOcupado?: () => boolean;
  /** Relogio (ms) injectavel para o TTL da idempotencia. */
  agora?: () => number;
  intervaloMs?: number;
  registar?: (mensagem: string, detalhe?: unknown) => void;
}

const ESTADOS_TERMINAIS = new Set(["completed", "cancelled", "failed"]);

/** Ficheiro do opt-in: no baseDir do servico, como o contrato exige. */
export function caminhoConfigUsb(baseDir: string): string {
  return path.join(baseDir, "usb-protection.json");
}

export class UsbProtectionRuntime {
  private readonly monitor: UsbProtectionMonitor;
  private readonly estadoDoScan: OpcoesRuntimeUsb["estadoDoScan"];
  private readonly verificarCapacidade?: OpcoesRuntimeUsb["verificarCapacidade"];
  private readonly analise?: PortaAnaliseUsb;
  private readonly enumerar?: OpcoesRuntimeUsb["enumerar"];
  private readonly slotOcupado?: OpcoesRuntimeUsb["slotOcupado"];
  private readonly agora: () => number;
  private readonly intervaloMs: number;
  private readonly registar?: OpcoesRuntimeUsb["registar"];
  private timer: ReturnType<typeof setInterval> | null = null;
  private cicloEmCurso = false;
  private parado = false;
  /** Idempotencia do gesto manual: `deviceId\0requestId` -> resultado (bounded, TTL). */
  private readonly pedidos = new Map<string, { expira: number; resultado: UsbScanResult }>();
  /** Analise manual em curso: o MESMO pedido devolve a MESMA promessa. */
  private manualEmCurso: { chave: string; promessa: Promise<UsbScanResult> } | null = null;
  /** Analises manuais arrancadas por nos: `scanId` -> `deviceId`. */
  private readonly manuais = new Map<string, string>();

  constructor(opcoes: OpcoesRuntimeUsb) {
    this.monitor = opcoes.monitor;
    this.estadoDoScan = opcoes.estadoDoScan;
    this.verificarCapacidade = opcoes.verificarCapacidade;
    this.analise = opcoes.analise;
    this.enumerar = opcoes.enumerar;
    this.slotOcupado = opcoes.slotOcupado;
    this.agora = opcoes.agora ?? Date.now;
    this.intervaloMs = opcoes.intervaloMs ?? USB_POLL_INTERVAL_MS;
    this.registar = opcoes.registar;
  }

  /** Arranque: capacidade, opt-in, primeira enumeracao e poll. */
  async iniciar(): Promise<UsbProtectionSnapshot> {
    if (this.verificarCapacidade) {
      const capacidade = this.verificarCapacidade();
      this.registar?.(
        capacidade.ok
          ? "USB: contrato de análise read-only presente — auto-scan permitido quando a proteção estiver ligada."
          : `USB: sem contrato de análise read-only — auto-scan bloqueado (${capacidade.motivo ?? "sem motivo"}).`,
      );
    }
    const snapshot = await this.monitor.iniciar();
    this.agendar();
    return snapshot;
  }

  private agendar(): void {
    if (this.parado || this.timer) return;
    this.timer = setInterval(() => {
      void this.ciclo().catch((erro) => this.registar?.("USB: ciclo falhou", erro));
    }, this.intervaloMs);
    // O poll nao segura o processo vivo durante o shutdown.
    this.timer.unref?.();
  }

  /** Um passo: alimenta resultados reais e corre uma enumeracao. */
  async ciclo(): Promise<UsbProtectionSnapshot> {
    if (this.cicloEmCurso) return this.monitor.snapshot();
    this.cicloEmCurso = true;
    try {
      this.alimentarResultados();
      this.limparManuais();
      const snapshot = await this.monitor.ciclo();
      // Depois da enumeracao: um scan pode ter terminado durante o ciclo e a
      // proxima enumeracao ja' pode confirmar presenca.
      this.alimentarResultados();
      return snapshot;
    } finally {
      this.cicloEmCurso = false;
    }
  }

  /**
   * Passa ao monitor o desfecho REAL das analises USB em curso. Só o que
   * esta' mesmo a correr entra: um estado terminal que nao corresponda a
   * nenhuma sessao viva nao muda nada (o monitor ignora-o).
   */
  private alimentarResultados(): void {
    for (const dispositivo of this.monitor.snapshot().devices) {
      if (dispositivo.status !== "scanning" || !dispositivo.scanId) continue;
      const estado = this.estadoDoScan(dispositivo.scanId);
      if (!estado || !estado.status || !ESTADOS_TERMINAIS.has(estado.status)) continue;
      const aplicado = this.monitor.aplicarResultado(dispositivo.scanId, estado);
      this.registar?.(
        `USB: análise ${dispositivo.scanId} terminou como ${estado.status}${aplicado ? "" : " (sessão já não estava activa)"}`,
      );
    }
  }

  snapshot(): UsbProtectionSnapshot {
    return this.monitor.snapshot();
  }

  /** Opt-in (validação estrita fica no monitor). Não mexe em firewall/proteção. */
  async configure(input: { enabled: unknown }): Promise<UsbProtectionSnapshot> {
    return this.monitor.configurar(input);
  }

  // ── Análise MANUAL (`usb.scan` / `usb.cancel`) ────────────────────────────
  //
  // Gestão explícita do utilizador sobre um dispositivo que ESTE serviço já
  // confirmou. Permitida com o opt-in DESLIGADO e sem o ligar (não arma o
  // auto-scan). A raiz NUNCA vem do renderer: resolve-se numa enumeração FRESCA
  // a partir do `deviceId`. O `readOnly: true` é imposto pelo adapter — zero
  // quarentena, zero VirusTotal, zero escrita.

  /**
   * `usb.scan`. Recusa DECLARADA (com motivo) quando o payload é inválido/fora
   * dos limites, `consent !== true`, falta a porta de análise, o slot global
   * está ocupado, ou o dispositivo está ausente/instável/sem volume. Nunca
   * finge fila nem "a correr": ou devolve o `scanId` real, ou um erro.
   */
  async scan(input: unknown): Promise<UsbScanResult> {
    this.limparManuais();
    const pedido = validarPedidoScan(input);
    if (!pedido.ok) return { ok: false, error: pedido.error };
    const chave = `${pedido.deviceId}\u0000${pedido.requestId}`;

    const memorizado = this.pedidos.get(chave);
    if (memorizado) {
      if (memorizado.expira > this.agora()) return memorizado.resultado;
      this.pedidos.delete(chave);
    }

    // LOCK síncrono ANTES de qualquer `await`: um duplo clique não enfileira
    // duas análises. O MESMO pedido (mesmo `requestId`) recebe a promessa em
    // curso — retry idempotente, nunca uma segunda análise.
    if (this.manualEmCurso) {
      if (this.manualEmCurso.chave === chave) return this.manualEmCurso.promessa;
      return { ok: false, error: "já existe uma análise USB em curso" };
    }
    if (!this.analise) return { ok: false, error: "sem porta de análise USB ligada no serviço" };
    if (!this.enumerar) return { ok: false, error: "sem enumeração de dispositivos ligada no serviço" };
    if (this.slotOcupado?.() ?? false) {
      // Slot único ocupado (análise do utilizador ou auto-scan): recusa dita,
      // sem transformar o gesto numa fila ou num estado inventado.
      return { ok: false, error: "análise global em curso — o slot está ocupado" };
    }
    // Já existe análise viva NESTE dispositivo (a que está a correr ou a que
    // espera na fila): recusa ANTES de arrancar nada. Arrancar para cancelar a
    // seguir ocupava o slot global sem necessidade e não é comportamento honesto.
    const atual = this.monitor.snapshot().devices.find((dispositivo) => dispositivo.id === pedido.deviceId);
    if (atual?.status === "scanning" || atual?.status === "queued") {
      return { ok: false, error: "já existe uma análise USB em curso neste dispositivo" };
    }

    const promessa = this.executarScanManual(pedido.deviceId, chave);
    this.manualEmCurso = { chave, promessa };
    try {
      return await promessa;
    } finally {
      if (this.manualEmCurso?.chave === chave) this.manualEmCurso = null;
    }
  }

  /**
   * `usb.cancel`. Cancela SÓ a análise USB indicada, e só com os DOIS ids a
   * coincidir com uma análise USB NOSSA ainda viva. Uma análise manual do
   * utilizador ou uma sessão nova nunca é tocada: a associação é revalidada no
   * momento e não é persistida.
   */
  async cancel(input: unknown): Promise<UsbCancelResult> {
    this.limparManuais();
    const pedido = validarPedidoCancel(input);
    if (!pedido.ok) return { ok: false, error: pedido.error };
    if (!this.analise) return { ok: false, error: "sem porta de análise USB ligada no serviço" };
    const { deviceId, scanId } = pedido;

    const dono = this.manuais.get(scanId);
    if (dono !== undefined) {
      if (dono !== deviceId) return { ok: false, error: "o scanId não pertence a esse dispositivo" };
      this.manuais.delete(scanId);
      await this.analise.cancelar(scanId);
      this.publicarDesfechoSeTerminal(scanId);
      this.registar?.(`USB: análise manual ${scanId} cancelada a pedido do utilizador`);
      return { ok: true };
    }

    // Análise arrancada pelo AUTO-SCAN do monitor: exige o MESMO scanId vivo.
    const alvo = this.monitor.snapshot().devices.find((dispositivo) => dispositivo.id === deviceId);
    if (!alvo || alvo.status !== "scanning" || alvo.scanId !== scanId) {
      return { ok: false, error: "nenhuma análise USB em curso com esses dois ids" };
    }
    await this.analise.cancelar(scanId);
    this.publicarDesfechoSeTerminal(scanId);
    this.registar?.(`USB: análise ${scanId} cancelada a pedido do utilizador`);
    return { ok: true };
  }

  /**
   * Desfaz uma análise arrancada por NÓS quando ela não pôde entrar no ciclo de
   * vida publicado. Devolve a verdade sobre o cancelamento, verificada no estado
   * REAL do motor (`estadoDoScan`), nunca por intenção:
   *  - chamada ao motor falhou ⇒ diz que FALHOU e mantém o `scanId` no texto,
   *    porque essa análise pode continuar a correr;
   *  - aceite mas sem terminal ⇒ "pedido — ainda NÃO confirmado pelo motor";
   *  - terminal real ⇒ reporta o estado que o motor devolveu, sem afirmar que
   *    o cancelamento causou esse desfecho.
   */
  private async desfazerAnaliseArrancada(scanId: string): Promise<string> {
    try {
      await this.analise!.cancelar(scanId);
    } catch (erro) {
      return `o cancelamento FALHOU (${textoDeErro(erro)}) — a análise ${scanId} pode continuar a correr no serviço`;
    }
    const estado = this.estadoDoScan(scanId);
    if (estado?.status && ESTADOS_TERMINAIS.has(estado.status)) {
      return `a análise terminou como ${estado.status} (confirmado pelo motor)`;
    }
    return `cancelamento da análise ${scanId} pedido — ainda NÃO confirmado pelo motor`;
  }

  /**
   * Republica o desfecho REAL de um scan depois de um cancelamento — só se o
   * estado do motor já for terminal (`completed`/`cancelled`/`failed`). Um
   * cancelamento PENDENTE não é terminal: nesse caso nada é publicado aqui e o
   * estado continua `scanning` até o poll ler a verdade (sem fingir desfecho e
   * sem fechar a porta a um cancelamento repetido).
   */
  private publicarDesfechoSeTerminal(scanId: string): void {
    const estado = this.estadoDoScan(scanId);
    if (!estado || !estado.status || !ESTADOS_TERMINAIS.has(estado.status)) return;
    this.monitor.aplicarResultado(scanId, estado);
  }

  private async executarScanManual(deviceId: string, chave: string): Promise<UsbScanResult> {
    let frescos: UsbDispositivoDetetado[];
    try {
      frescos = await this.enumerar!();
    } catch (erro) {
      return { ok: false, error: `enumeração de dispositivos falhou (${textoDeErro(erro)})` };
    }
    const alvo = (Array.isArray(frescos) ? frescos : []).find((dispositivo) => dispositivo && dispositivo.id === deviceId);
    if (!alvo) return { ok: false, error: "dispositivo não encontrado na enumeração fresca" };
    if (alvo.identityProvenance === "disk-index-fallback") {
      return { ok: false, error: "identidade do dispositivo não é estável (índice de disco)" };
    }
    const rootPath = typeof alvo.rootPath === "string" ? alvo.rootPath.trim() : "";
    if (rootPath === "") return { ok: false, error: "dispositivo sem volume (letra) publicado pelo Windows" };
    const rootPaths = Array.isArray(alvo.rootPaths) && alvo.rootPaths.length > 0 ? [...alvo.rootPaths] : [rootPath];
    let scanId: string;
    try {
      ({ scanId } = await this.analise!.iniciar({ id: deviceId, rootPath, rootPaths }));
    } catch (erro) {
      return { ok: false, error: `análise USB recusada: ${textoDeErro(erro)}` };
    }

    // LIGAÇÃO AO CICLO DE VIDA (P0 15/10): a análise que o utilizador autorizou
    // tem de aparecer no estado publicado — `scanning` + `scanId` — senão a UI
    // não tem progresso nem cancel, o desfecho real nunca passa pelo
    // `aplicarResultado` e a remoção a meio não cancela nada. Isto NÃO arma o
    // auto-scan: o opt-in continua como estava.
    const ligado = this.monitor.registarAnaliseManual({ id: deviceId, scanId, rootPath, rootPaths });
    if (!ligado.ok) {
      // Sem estado publicado não existe gesto honesto: desfaz-se a análise que
      // NÓS arrancámos, em vez de deixar um scan invisível a correr no serviço.
      // O texto do desfecho diz SEMPRE o que se sabe: pedido, confirmado pelo
      // estado real do motor, ou falhado — nunca "cancelada" por intenção.
      const motivo =
        ligado.motivo === "analise-viva"
          ? "já existe uma análise USB em curso neste dispositivo"
          : "dispositivo fora do estado do monitor (sem presença confirmada)";
      return { ok: false, error: `${motivo} — ${await this.desfazerAnaliseArrancada(scanId)}` };
    }
    this.manuais.set(scanId, deviceId);
    const resultado: UsbScanResult = { ok: true, deviceId, scanId };
    this.memorizar(chave, resultado);
    this.registar?.(`USB: análise manual ${scanId} arrancada para ${deviceId} (read-only, sem quarentena)`);
    return resultado;
  }

  private memorizar(chave: string, resultado: UsbScanResult): void {
    this.pedidos.set(chave, { expira: this.agora() + USB_REQUEST_TTL_MS, resultado });
    while (this.pedidos.size > USB_REQUEST_MAX) {
      const maisAntigo = this.pedidos.keys().next().value as string | undefined;
      if (maisAntigo === undefined) break;
      this.pedidos.delete(maisAntigo);
    }
  }

  /** Limpa as guardas de análises USB já terminais (remoção/reinserção/terminal). */
  private limparManuais(): void {
    if (this.manuais.size === 0) return;
    for (const scanId of [...this.manuais.keys()]) {
      const estado = this.estadoDoScan(scanId);
      if (!estado || (estado.status && ESTADOS_TERMINAIS.has(estado.status))) this.manuais.delete(scanId);
    }
  }

  /** Configuração lida do disco (para diagnóstico/handlers). */
  async lerConfig(store: UsbConfigStore): Promise<UsbProtectionConfig | null> {
    const leitura = await store.ler();
    return leitura.estado === "known" ? leitura.config : null;
  }

  async dispose(): Promise<void> {
    this.parado = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Guardas do gesto manual nao sobrevivem ao servico.
    this.pedidos.clear();
    this.manuais.clear();
    this.manualEmCurso = null;
  }
}

// ── Validacao estrita do IPC manual (strings bounded, `consent` literal) ──────

function textoBounded(valor: unknown, max: number): string | null {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();
  return limpo !== "" && limpo.length <= max ? limpo : null;
}

function validarPedidoScan(
  input: unknown,
): { ok: true; deviceId: string; requestId: string } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "pedido inválido: { deviceId, requestId, consent: true } é obrigatório" };
  }
  const bruto = input as Record<string, unknown>;
  const deviceId = textoBounded(bruto.deviceId, USB_STRING_MAX);
  if (!deviceId) return { ok: false, error: `deviceId inválido (string não vazia, máx. ${USB_STRING_MAX})` };
  const requestId = textoBounded(bruto.requestId, USB_REQUEST_ID_MAX);
  if (!requestId) return { ok: false, error: `requestId inválido (string não vazia, máx. ${USB_REQUEST_ID_MAX})` };
  if (bruto.consent !== true) return { ok: false, error: "consent tem de ser o literal true" };
  return { ok: true, deviceId, requestId };
}

function validarPedidoCancel(
  input: unknown,
): { ok: true; deviceId: string; scanId: string } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "pedido inválido: { deviceId, scanId } é obrigatório" };
  }
  const bruto = input as Record<string, unknown>;
  const deviceId = textoBounded(bruto.deviceId, USB_STRING_MAX);
  if (!deviceId) return { ok: false, error: `deviceId inválido (string não vazia, máx. ${USB_STRING_MAX})` };
  const scanId = textoBounded(bruto.scanId, USB_STRING_MAX);
  if (!scanId) return { ok: false, error: `scanId inválido (string não vazia, máx. ${USB_STRING_MAX})` };
  return { ok: true, deviceId, scanId };
}

function textoDeErro(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}
