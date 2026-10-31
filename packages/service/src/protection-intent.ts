import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Intenção do utilizador, nunca evidência de proteção operacional. Datas UTC canónicas. */
export interface ProtectionIntent {
  version: 1;
  desired: "enabled" | "disabled";
  pausedUntil: string | null;
  updatedAt: string;
}
export type UnknownReason = "documento_ausente" | "documento_corrompido" |
  "documento_legado" | "versao_desconhecida" | "documento_invalido" | "leitura_falhou";
export type IntentRead =
  | { estado: "known"; intencao: ProtectionIntent }
  | { estado: "unknown"; motivo: UnknownReason };
export type StartupDecision = {
  decisao: "unknown" | "arrancar" | "ficar_desligado" | "retomar_pausa_expirada";
  motivo: UnknownReason | "relogio_invalido" | "relogio_recuado" |
    "off_manual" | "intencao_enabled" | "pausa_em_curso" | "prazo_expirado";
};
interface IntentIO {
  readFile(file: string, encoding: "utf8"): Promise<string>;
  writeFile(file: string, data: string, options: { encoding: "utf8"; flag: "wx"; mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
}

function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** Não migra documentos legados nem escolhe enabled quando falta intenção. */
export function validarIntencao(value: unknown): IntentRead {
  if (value == null) return { estado: "unknown", motivo: "documento_ausente" };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { estado: "unknown", motivo: "documento_invalido" };
  }
  const raw = value as Record<string, unknown>;
  if (!("version" in raw) || raw.version === 0) return { estado: "unknown", motivo: "documento_legado" };
  if (raw.version !== 1) return { estado: "unknown", motivo: "versao_desconhecida" };
  const keys = Object.keys(raw);
  if (keys.length !== 4 || keys.some(key => !["version", "desired", "pausedUntil", "updatedAt"].includes(key)) ||
      (raw.desired !== "enabled" && raw.desired !== "disabled") ||
      !isCanonicalDate(raw.updatedAt) || (raw.pausedUntil !== null && !isCanonicalDate(raw.pausedUntil))) {
    return { estado: "unknown", motivo: "documento_invalido" };
  }
  return { estado: "known", intencao: {
    version: 1, desired: raw.desired, pausedUntil: raw.pausedUntil, updatedAt: raw.updatedAt,
  } };
}

/** Puro: apenas recomenda. Não inicia motores, timers ou adapters. agora em epoch ms. */
export function decidirArranque(intencao: unknown, agora: number): StartupDecision {
  const validated = validarIntencao(intencao);
  if (validated.estado === "unknown") return { decisao: "unknown", motivo: validated.motivo };
  const doc = validated.intencao;
  // Uma ordem off válida não precisa do relógio para continuar desligada.
  if (doc.desired === "disabled") return { decisao: "ficar_desligado", motivo: "off_manual" };
  if (!Number.isFinite(agora) || Math.abs(agora) > 8640000000000000) {
    return { decisao: "unknown", motivo: "relogio_invalido" };
  }
  if (agora < Date.parse(doc.updatedAt)) return { decisao: "unknown", motivo: "relogio_recuado" };
  if (doc.pausedUntil === null) return { decisao: "arrancar", motivo: "intencao_enabled" };
  return Date.parse(doc.pausedUntil) > agora
    ? { decisao: "ficar_desligado", motivo: "pausa_em_curso" }
    : { decisao: "retomar_pausa_expirada", motivo: "prazo_expirado" };
}

function sameIntent(a: ProtectionIntent, b: ProtectionIntent): boolean {
  return a.version === b.version && a.desired === b.desired &&
    a.pausedUntil === b.pausedUntil && a.updatedAt === b.updatedAt;
}

// Partilhada entre instâncias deste módulo, não entre processos. Um writer por ficheiro.
const pendingWrites = new Map<string, Promise<void>>();

export class ProtectionIntentStore {
  private readonly file: string;
  private readonly queueKey: string;
  private readonly io: IntentIO;
  constructor(file: string, io: IntentIO = fs) {
    if (!path.isAbsolute(file)) throw new Error("Caminho absoluto de intenção obrigatório.");
    this.file = path.normalize(file);
    this.queueKey = process.platform === "win32" ? this.file.toLowerCase() : this.file;
    this.io = io;
  }

  async ler(): Promise<IntentRead> {
    let raw: string;
    try {
      raw = await this.io.readFile(this.file, "utf8");
    } catch (error) {
      return { estado: "unknown", motivo: (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "documento_ausente" : "leitura_falhou" };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { return { estado: "unknown", motivo: "documento_corrompido" }; }
    // JSON null em disco é inválido; ausência significa ENOENT, não conteúdo null.
    return parsed === null ? { estado: "unknown", motivo: "documento_invalido" } : validarIntencao(parsed);
  }

  /**
   * Compare-and-set obrigatório: null só permite criar quando o ficheiro falta.
   * Recuperação de corrupt/legacy e coordenação entre processos ficam fora desta fatia.
   * O diretório pai deve existir; nunca cria diretórios ou escolhe um caminho real default.
   */
  async guardar(intencao: ProtectionIntent, esperada: ProtectionIntent | null): Promise<void> {
    const next = validarIntencao(intencao);
    if (next.estado !== "known") throw new Error("Intenção inválida.");
    const expected = esperada === null ? null : validarIntencao(esperada);
    if (expected?.estado === "unknown") throw new Error("conflito: snapshot esperado inválido.");
    const previous = pendingWrites.get(this.queueKey) ?? Promise.resolve();
    const task = previous.then(async () => {
      const current = await this.ler();
      const matches = expected === null
        ? current.estado === "unknown" && current.motivo === "documento_ausente"
        : current.estado === "known" && sameIntent(current.intencao, expected.intencao);
      if (!matches) throw new Error("conflito: intenção alterada ou desconhecida; reler antes de decidir.");
      if (current.estado === "known" && Date.parse(next.intencao.updatedAt) < Date.parse(current.intencao.updatedAt)) {
        throw new Error("relógio recuado: escrita recusada.");
      }
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await this.io.writeFile(temp, JSON.stringify(next.intencao) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
        await this.io.rename(temp, this.file);
      } catch (error) {
        // EEXIST significa que o temp não foi criado por esta operação.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") await this.io.unlink(temp).catch(() => {});
        throw error;
      }
    });
    const tail = task.then(() => {}, () => {});
    pendingWrites.set(this.queueKey, tail);
    void tail.then(() => { if (pendingWrites.get(this.queueKey) === tail) pendingWrites.delete(this.queueKey); });
    await task;
  }
}

/** Ficheiro de intenção dentro da raiz de dados do serviço. Não cria diretórios. */
export function protectionIntentPath(baseDir: string): string {
  if (!path.isAbsolute(baseDir)) throw new Error("baseDir absoluta obrigatória.");
  return path.join(baseDir, "protection-intent.json");
}

export interface StartupAdapters {
  store: ProtectionIntentStore;
  /** Relógio injectável: em teste é fixo, no runtime é `Date.now`. */
  agora(): number;
  /**
   * O Serviço confirma. Devolve `true` só quando a proteção ficou de facto
   * ativa; `false` quando o motor recusou. Nunca é uma asserção do renderer.
   */
  iniciar(): Promise<boolean>;
}

export type StartupOutcome = {
  decisao: "unknown" | "arrancar" | "ficar_desligado" | "retomar_pausa_expirada";
  motivo: string;
  iniciado: boolean;
  /** Presente apenas quando `iniciar()` rebentou. Motivo sanitizado. */
  falha?: string;
};

export type EscritaResultado = { ok: boolean; guardado: boolean; motivo?: string };

/**
 * Ciclo de vida do opt-in de retoma ao arrancar.
 *
 * Separação deliberada, e é isto que torna a UI honesta:
 * - `desired:"enabled"` só é escrito por `definirOptin`, que só é chamado pelo
 *   controlo explícito em Definições. **Ligar a proteção (`monitor.start`) não
 *   escreve intenção nenhuma** — ver `avaliarAoArrancar`, que é leitura pura.
 * - `registrarOffManual` é a revogação: desligar à mão grava `disabled`.
 * - Falta de registo, registo ilegível ou relógio inválido resultam sempre em
 *   NÃO arrancar. O default é OFF; ausência nunca vale consentimento.
 * - `guardado:true` só é devolvido depois de reler o disco e confirmar o
 *   conteúdo. Uma escrita que falha afirma que falhou.
 */
export class ProtectionStartup {
  private readonly deps: StartupAdapters;

  constructor(deps: StartupAdapters) {
    this.deps = deps;
  }

  /** Lê e decide. Não escreve: ver o teste de leitura pura. */
  async avaliarAoArrancar(): Promise<StartupOutcome> {
    const leitura = await this.deps.store.ler();
    if (leitura.estado === "unknown") {
      return { decisao: "unknown", motivo: leitura.motivo, iniciado: false };
    }
    const decisao = decidirArranque(leitura.intencao, this.deps.agora());
    if (decisao.decisao === "unknown" || decisao.decisao === "ficar_desligado") {
      return { decisao: decisao.decisao, motivo: decisao.motivo, iniciado: false };
    }
    try {
      const confirmado = await this.deps.iniciar();
      return { decisao: decisao.decisao, motivo: decisao.motivo, iniciado: confirmado === true };
    } catch (error) {
      return { decisao: decisao.decisao, motivo: decisao.motivo, iniciado: false, falha: sanitizar(error) };
    }
  }

  /** O único caminho que escreve `enabled`. Chamar só a partir do controlo de Definições. */
  async definirOptin(enabled: boolean): Promise<EscritaResultado> {
    return this.escreverAtual(
      (atual) => ({ ...atual, desired: enabled ? "enabled" : "disabled" }),
      enabled ? { version: 1, desired: "enabled", pausedUntil: null } : { version: 1, desired: "disabled", pausedUntil: null },
    );
  }

  /** Revogação: um OFF manual tem de sobreviver ao arranque seguinte. */
  async registrarOffManual(): Promise<EscritaResultado> {
    return this.escreverAtual(
      (atual) => ({ ...atual, desired: "disabled" }),
      { version: 1, desired: "disabled", pausedUntil: null },
    );
  }

  /**
   * OFF manual: separa o que o motor OBSERVA do que se conseguiu GRAVAR.
   *
   * `vivo` é devolvido tal e qual — um OFF que não se persiste continua a ser
   * um OFF neste processo, e não se pode ligar nada "para compensar". O que não
   * pode acontecer é a resposta tratar a revogação como confirmada: se o
   * `enabled` anterior sobreviver no registo, o próximo arranque liga a
   * proteção contra a vontade do utilizador. Daí `revogacaoRetoma`, um campo
   * que fala só da persistência.
   */
  async ofManualConfirmado<T extends { ok: boolean; protectionEnabled: boolean }>(
    vivo: T,
  ): Promise<T & { revogacaoRetoma: "confirmada" | "nao_confirmada"; motivoRevogacao?: string }> {
    const escrita = await this.registrarOffManual()
      .catch((erro) => ({ ok: false, guardado: false, motivo: sanitizar(erro) }));
    return escrita.guardado
      ? { ...vivo, revogacaoRetoma: "confirmada" as const }
      : { ...vivo, revogacaoRetoma: "nao_confirmada" as const, motivoRevogacao: escrita.motivo ?? "escrita_falhou" };
  }

  /** Pausa com prazo. Sem registo anterior não se inventa intenção: recusa. */
  async registrarPausa(until: string | null): Promise<EscritaResultado> {
    if (until !== null && !isCanonicalDate(until)) return { ok: false, guardado: false, motivo: "prazo_invalido" };
    const leitura = await this.deps.store.ler();
    if (leitura.estado !== "known") return { ok: false, guardado: false, motivo: leitura.motivo };
    return this.gravar({ ...leitura.intencao, pausedUntil: until }, leitura.intencao);
  }

  /**
   * O que a UI pode mostrar. `protecaoAtiva` é observado pelo motor e passado
   * por quem sabe; este módulo nunca o deduz do registo — um `enabled` em disco
   * não significa proteção a correr.
   */
  async estado(protecaoAtiva = false): Promise<{
    optin: "enabled" | "disabled" | "unknown"; registoConhecido: boolean;
    protecaoAtiva: boolean; pausedUntil: string | null; motivo?: string;
  }> {
    const leitura = await this.deps.store.ler();
    if (leitura.estado === "unknown") {
      return { optin: "unknown", registoConhecido: false, protecaoAtiva, pausedUntil: null, motivo: leitura.motivo };
    }
    return {
      optin: leitura.intencao.desired, registoConhecido: true, protecaoAtiva,
      pausedUntil: leitura.intencao.pausedUntil,
    };
  }

  /** CAS a partir do snapshot lido agora; `criarSeAusente` cobre o primeiro opt-in. */
  private async escreverAtual(
    transformar: (atual: ProtectionIntent) => Omit<ProtectionIntent, "updatedAt">,
    criarSeAusente: Omit<ProtectionIntent, "updatedAt">,
  ): Promise<EscritaResultado> {
    const leitura = await this.deps.store.ler();
    if (leitura.estado === "known") return this.gravar({ ...transformar(leitura.intencao), updatedAt: this.instante() }, leitura.intencao);
    // Só se cria sobre ausência confirmada. Corrompido/legado/ilegível não se pisa.
    if (leitura.motivo !== "documento_ausente") return { ok: false, guardado: false, motivo: leitura.motivo };
    return this.gravar({ ...criarSeAusente, updatedAt: this.instante() } as ProtectionIntent, null);
  }

  private instante(): string {
    const agora = this.deps.agora();
    return Number.isFinite(agora) ? new Date(agora).toISOString() : new Date().toISOString();
  }

  /** `guardado` exige reler e confirmar; sem confirmação não há `ok`. */
  private async gravar(intencao: ProtectionIntent, esperada: ProtectionIntent | null): Promise<EscritaResultado> {
    try {
      await this.deps.store.guardar(intencao, esperada);
    } catch (error) {
      const motivo = sanitizar(error);
      return { ok: false, guardado: false, motivo: motivo.includes("conflito") ? "conflito" : "escrita_falhou" };
    }
    const relido = await this.deps.store.ler();
    const confirmado = relido.estado === "known" && sameIntent(relido.intencao, intencao);
    return confirmado
      ? { ok: true, guardado: true }
      : { ok: false, guardado: false, motivo: "confirmacao_falhou" };
  }
}

/** Motivos vão para log/UI: nunca caminhos de utilizador nem stack. */
function sanitizar(error: unknown): string {
  const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return msg.replace(/[A-Za-z]:[\\/](?:Users|users)[\\/][^\\/\s"']+/g, "C:\\Users\\<utilizador>").slice(0, 200);
}

export type OptInPayloadRead =
  | { ok: true; enabled: boolean }
  | { ok: false; motivo: "payload_ausente" | "payload_nao_objeto" | "chaves_inesperadas" | "enabled_nao_booleano" };

/**
 * unica forma aceite pelo canal de opt-in: exatamente `{ enabled: boolean }`.
 *
 * Existe porque o pedido chega de um renderer por cima de um named pipe JSON.
 * `undefined` NAO vale "ligar": a omissao nao e consentimento, e um payload
 * com campos a mais poderia reescrever o resto do registo a partir da UI.
 */
export function parseOptInPayload(payload: unknown): OptInPayloadRead {
  if (payload == null) return { ok: false, motivo: "payload_ausente" };
  if (typeof payload !== "object" || Array.isArray(payload)) return { ok: false, motivo: "payload_nao_objeto" };
  const raw = payload as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== "enabled") return { ok: false, motivo: "chaves_inesperadas" };
  if (typeof raw.enabled !== "boolean") return { ok: false, motivo: "enabled_nao_booleano" };
  return { ok: true, enabled: raw.enabled };
}

