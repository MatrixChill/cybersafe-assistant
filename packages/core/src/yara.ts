import {
  createYaraClassicScanner,
  YaraClassicScanError,
  parseRuleMeta,
  resolveYaraClassicBinaries,
  validateYaraFile,
  validateYaraSource,
  type YaraClassicBinaries,
  type YaraClassicDiagnostic,
  type YaraClassicMatch,
  type YaraClassicScanner,
} from "./yara-classic.js";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { EngineSubsystemHealth } from "@cybersafe/shared-types";

export interface YaraMatch {
  ruleId: string;
  label: string;
  severity: "high" | "critical";
  evidence: "generic" | "strong";
}

export const MAX_YARA_SCAN_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Prazo por omissão de uma leitura YARA. Não é um tempo de deteção: é o
 * ponto a partir do qual o chamador prefere um resultado INCONCLUSIVO a ficar
 * preso. O adaptador recebe o prazo e aguarda o fim do subprocesso ou declara
 * explicitamente morte não confirmada; não há corrida exterior neste scan.
 */
export const DEFAULT_YARA_SCAN_TIMEOUT_MS = 10_000;

export type YaraScanStatus = "ok" | "timeout" | "cancelled" | "error" | "unavailable" | "too-large";

export interface YaraScanOutcome {
  status: YaraScanStatus;
  matches: YaraMatch[];
  durationMs: number;
  /** Diagnóstico adicional; nunca contém um veredicto de ficheiro limpo. */
  detail?: string;
  subprocess?: {
    pid?: number;
    terminationConfirmed: boolean;
    reason: "timeout" | "cancelled" | "output-limit" | "process-error";
  };
}

/**
 * Erro de leitura YARA com causa classificada. `scanFile` continua a lançar
 * (contrato antigo), mas o consumidor passa a poder distinguir "não havia
 * regras", "excedeu o prazo" e "cancelado" em vez de os tratar como o mesmo
 * "falhou". Zero deteções só é um resultado quando `status === "ok"`.
 */
export class YaraScanError extends Error {
  readonly code: YaraScanStatus;

  constructor(code: YaraScanStatus, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "YaraScanError";
    this.code = code;
  }
}

export type DeadlineOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "timeout" }
  | { status: "cancelled" };

/**
 * Fecha `work` com um prazo e um sinal, sem inventar cancelamento nativo.
 *
 * O `work` continua a correr quando o prazo vence — quem chamou recebe
 * `timeout`/`cancelled` e descarta o valor tardio. A rejeição tardia é
 * apanhada aqui para não se transformar num `unhandledRejection` que derruba
 * o serviço por causa de um scan que já ninguém esperava.
 */
export function enforceDeadline<T>(
  work: Promise<T>,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<DeadlineOutcome<T>> {
  work.catch(() => undefined);

  if (options.signal?.aborted) {
    return Promise.resolve({ status: "cancelled" });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (outcome: DeadlineOutcome<T>) => {
      if (settled) return;
      cleanup();
      resolve(outcome);
    };
    const onAbort = () => finish({ status: "cancelled" });
    const timer = setTimeout(() => finish({ status: "timeout" }), Math.max(0, options.timeoutMs));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish({ status: "ok", value }),
      (error) => {
        if (settled) return;
        cleanup();
        reject(error);
      },
    );
  });
}

export type YaraRuleClass = "production" | "test" | "reference";

/**
 * Manifesto de proveniência do corpus publicado pelo updater.
 *
 * Responde a "de onde veio cada regra e quantas são de produção?", que o
 * conteúdo sozinho não responde sem heurísticas sobre nomes. É escrito ao lado
 * das definições (não dentro da pasta `yara/`) e está ligado ao corpus por
 * `corpusSha256`: um manifesto que descreva outro ficheiro é ignorado.
 *
 * REGRA DE OURO: o manifesto só pode BAIXAR a cobertura. Uma afirmação
 * `production` num manifesto nunca transforma um corpus só-EICAR em cobertura
 * normal; o conteúdo continua a decidir o mínimo.
 *
 * CLASSES: `production` e `test` são regras do corpus de ameaça; `reference`
 * é material de identificação (estrutura PE, constantes criptográficas) que o
 * updater valida e registra mas NÃO publica no corpus. Um manifesto antigo,
 * só com production/test, continua válido sem reinterpretação: as classes
 * conhecidas mantêm-se e uma classe desconhecida invalida o manifesto em vez
 * de ser adivinhada (classificação conservadora).
 */
export interface YaraCorpusSource {
  /** Só o nome do ficheiro fonte (sem URL nem caminho local). */
  name: string;
  ruleClass: YaraRuleClass;
  rules: number;
  sha256: string;
}

export interface YaraCorpusManifest {
  version: 1;
  generatedAt: string;
  corpusSha256: string;
  /**
   * Fontes aceites. `production`/`test` estão no corpus descrito por
   * `corpusSha256`; `reference` é proveniência de material que não entra no
   * corpus de ameaça.
   */
  sources: YaraCorpusSource[];
  /** Fontes rejeitadas, com motivo curto (sem caminhos nem tokens). */
  rejected: Array<{ name: string; reason: string }>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function isSafeSourceName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 128 &&
    !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

/** Lê e valida o manifesto; `null` significa "não há manifesto fiável". */
async function readManifest(manifestPath: string, corpusContent: string): Promise<YaraCorpusManifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf-8");
  } catch {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || parsed.version !== 1 || typeof parsed.corpusSha256 !== "string") return null;
  if (parsed.corpusSha256 !== sha256(corpusContent)) return null;
  if (!Array.isArray(parsed.sources) || !Array.isArray(parsed.rejected)) return null;

  const sources: YaraCorpusSource[] = [];
  for (const source of parsed.sources) {
    if (!source || !isSafeSourceName(source.name)) return null;
    if (
      source.ruleClass !== "production" &&
      source.ruleClass !== "test" &&
      source.ruleClass !== "reference"
    ) return null;
    if (!Number.isSafeInteger(source.rules) || source.rules < 0) return null;
    if (typeof source.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(source.sha256)) return null;
    sources.push({ name: source.name, ruleClass: source.ruleClass, rules: source.rules, sha256: source.sha256 });
  }

  const rejected: Array<{ name: string; reason: string }> = [];
  for (const entry of parsed.rejected) {
    if (!entry || !isSafeSourceName(entry.name) || typeof entry.reason !== "string") return null;
    rejected.push({ name: entry.name, reason: entry.reason.slice(0, 160) });
  }

  return {
    version: 1,
    generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
    corpusSha256: parsed.corpusSha256,
    sources,
    rejected,
  };
}

function classifyMatch(match: YaraClassicMatch): YaraMatch {
  const meta = match.meta as Record<string, unknown>;
  // The shipped EICAR definition predates the explicit evidence metadata.
  // Other unclassified rules (including the shell-string fallback) are generic.
  const legacyEicar = match.ruleIdentifier === "eicar" &&
    meta.hash1 === "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f";
  const strong = meta.cybersafe_evidence === "strong" || legacyEicar;
  return { ruleId: match.ruleIdentifier, label: match.ruleIdentifier, severity: strong ? "critical" : "high", evidence: strong ? "strong" : "generic" };
}

/**
 * Regra de último recurso, escritas em disco quando o corpus não pode ser
 * lido (vazio, JSON, HTML de um download falhado, ou ilegível).
 *
 * Este NÃO é um corpus de produção. Cada regra aqui é um canário de teste que
 * deteta material de teste conhecido, e nada mais. Uma regra que disparasse
 * sobre ficheiros legítimos seria pior do que não ter regra nenhuma: um
 * falso positivo de severidade alta destrói a confiança no produto mais
 * depressa do que uma ausência. Por isso o fallback é deliberadamente
 * mínimo e a UI tem de dizer que está a correr em modo canário.
 *
 * O corpus real vem de YARA_SOURCES (packages/service/src/updater.ts). Se ele
 * falhar, este ficheiro substitui-o apenas para o motor não morrer em silêncio
 * — e o estado `degraded` existe precisamente para dizer isso ao utilizador.
 */
/**
 * Assinatura do corpus de recurso. Distingue "o motor caiu para o canário"
 * de "o corpus real foi carregado" no arranque seguinte, porque o fallback é
 * gravado no path do corpus real e não volta a ser distinguível pelo nome.
 */
const FALLBACK_MARKER = "cybersafe-fallback-canary";

/**
 * CONTROL0 POSITIVO do pipeline: a string canónica de EICAR.
 *
 * Fica em texto porque é material de TESTE público, não malware. É a única
 * coisa que prova que o caminho regra→match→pipeline funciona: um corpus cheio
 * de regras que nunca dispararam não é evidência de deteção.
 *
 * É independente das fontes descarregadas de propósito: o corpus publicado
 * pode ter 178 regras de terceiros e nenhuma delas provar que o caminho de
 * deteção funciona. Medido com o corpus real: `eicar` + esta regra dispararam
 * no ficheiro de teste canónico, e um ficheiro benigno deu zero matches. Se
 * uma fonte mudar de escape, ou faltar, o controlo continua a provar o
 * pipeline.
 */
export const CYBERSAFE_EICAR_POSITIVE_CONTROL_BUFFER = Buffer.from(
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
  "ascii",
);

/**
 * Regra de controlo positivo, sem o marker do fallback: pode viver ao lado de
 * um corpus de produção sem o reclassificar como canário. `hash1` mantém a
 * classificação `strong` que o EICAR sempre teve no pipeline.
 */
export const CYBERSAFE_EICAR_POSITIVE_CONTROL_RULE = `
rule CyberSafe_Canary_EICAR
{
  meta:
    description = "CyberSafe positive control - test signature, not production detection"
    author = "CyberSafe"
    hash1 = "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f"

  strings:
    $eicar = "X5O!P%@AP[4\\\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*" ascii

  condition:
    $eicar
}
`;



const FALLBACK_RULES = `
// ${FALLBACK_MARKER}
// written when the real rules corpus could not be loaded
rule CyberSafe_Canary_EICAR
{
  meta:
    description = "CyberSafe test canary - not production detection"
    author = "CyberSafe"
    reference = "https://www.eicar.org/download-anti-malware-test-file/"

  strings:
    $eicar = "X5O!P%@AP[4\\\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*" ascii

  condition:
    $eicar
}
`;

/**
 * Assinaturas que sabemos serem material de TESTE e nunca deteção de malware.
 *
 * O `FALLBACK_MARKER` responde a "o CyberSafe escreveu isto?", que não é a
 * pergunta do contrato — a pergunta é "isto cobre malware?". Uma fonte pública
 * pode chegar sem marker e conter apenas regras de teste: é o caso de
 * `MALW_Eicar.yar`, uma entrada de `YARA_SOURCES`. O marker não prova
 * proveniência e a sua ausência também não comprova cobertura.
 *
 * A lista só permite reconhecer alguns corpora de teste como `limited`.
 * Qualquer corpus sem evidência de proveniência e eficácia fica `unknown`,
 * independentemente dos nomes das regras ou da contagem.
 */
const TEST_SIGNATURE = /eicar|canary|test[_\s-]?(file|signature|rule)/i;

/**
 * Uma declaração de regra REAL, tal como aparece no texto do corpus.
 *
 * `reportable` responde à única pergunta que interessa para o health: o
 * motor pode devolver esta regra num match? Medido no motor real:
 *   - `rule X` — reportada;
 *   - `global rule X` — reportada (e condiciona as restantes);
 *   - `private rule X` — NUNCA reportada (serve de helper para outras).
 * Logo uma regra `private` não conta como regra utilizável, mas a sua
 * presença não invalida o corpus enquanto houver uma regra que a use.
 */
interface YaraRuleDeclaration {
  name: string;
  reportable: boolean;
  /** Índice do início da declaração (inclui `private`/`global`). */
  start: number;
}

interface YaraSourceScan {
  declarations: YaraRuleDeclaration[];
  /** `include` reais no código. Regras vindas de outro ficheiro não são contáveis aqui. */
  includeDirectives: number;
}

/**
 * Lê as declarações de regra por ANÁLISE LEXICAL, não por regex sobre texto cru.
 *
 * ── O defeito que isto existe para impedir ─────────────────────────────────
 * `^rule\s+\w+` com `m` conta uma linha `rule Phantom` que vive DENTRO de um
 * comentário de bloco:
 *
 *     /*
 *     rule Phantom
 *     *\/
 *
 * O motor compila esse ficheiro com ZERO regras; a contagem textual dava 1 e
 * o health declarava `active`. Um comentário não deteta nada.
 *
 * O mesmo vale para a palavra `rule` dentro de strings (`description = "rule
 * Phantom"`), de literais regex (`/rule Phantom/`) e de comentários de linha.
 *
 * Implementação: percorre o texto e salta comentários (`//`, `/*...*\/`),
 * strings com aspas escapadas (`"..."`) e literais regex. Em YARA não há
 * divisão: um `/` abre regex como valor de uma string (`$x = /.../`) ou como
 * operando de `matches` (`"x" matches /.../`). Só tokens de código contam.
 * Modificadores `private`/`global` ficam pendentes até ao `rule` seguinte.
 *
 * Não bloqueia corpus válido: regras `global` contam (o addon reporta-as) e
 * `private` ao serviço de uma pública continuam a compilar e a ser usadas.
 */
function scanYaraSource(content: string): YaraSourceScan {
  const declarations: YaraRuleDeclaration[] = [];
  let includeDirectives = 0;
  const length = content.length;
  const isIdentStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isIdentChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);

  /** Salta um literal delimitado, respeitando `\\` como escape. */
  const skipLiteral = (from: number, quote: string): number => {
    let k = from + 1;
    while (k < length) {
      const ch = content[k];
      if (ch === "\\") {
        k += 2;
        continue;
      }
      if (ch === quote) return k + 1;
      if (quote === "/" && ch === "\n") return k; // regex não atravessa linhas
      k += 1;
    }
    return length;
  };

  let i = 0;
  let modifiers: string[] = [];
  let modifierStart = -1;
  let lastSignificant = "";

  while (i < length) {
    const ch = content[i];

    if (ch === "/" && content[i + 1] === "/") {
      const end = content.indexOf("\n", i + 2);
      i = end === -1 ? length : end;
      continue; // comentário de linha: não conta e não quebra modificadores
    }
    if (ch === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      i = end === -1 ? length : end + 2;
      continue; // comentário de bloco: o texto lá dentro nunca é código
    }
    if (ch === '"') {
      i = skipLiteral(i, '"');
      modifiers = [];
      modifierStart = -1;
      lastSignificant = '"';
      continue;
    }
    // Em YARA um `/` inicia regex como valor de uma string (`$x = /.../`) ou
    // como operando do operador `matches` (`"x" matches /.../`). Em qualquer
    // outro sítio é pontuação. Sem o caso `matches`, um literal regex com a
    // palavra `rule` contava como declaração — falso ACTIVE.
    if (ch === "/" && (lastSignificant === "=" || lastSignificant === "matches")) {
      i = skipLiteral(i, "/");
      modifiers = [];
      modifierStart = -1;
      lastSignificant = "/";
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < length && isIdentChar(content[j])) j += 1;
      const word = content.slice(i, j);
      if (word === "rule") {
        let k = j;
        while (k < length && /\s/.test(content[k])) k += 1;
        const nameStart = k;
        while (k < length && isIdentChar(content[k])) k += 1;
        const name = content.slice(nameStart, k);
        if (name) {
          declarations.push({
            name,
            reportable: !modifiers.includes("private"),
            start: modifiers.length > 0 ? modifierStart : i,
          });
        }
        modifiers = [];
        modifierStart = -1;
        lastSignificant = "rule";
        i = k;
        continue;
      }
      if (word === "private" || word === "global") {
        if (modifiers.length === 0) modifierStart = i;
        modifiers.push(word);
      } else {
        if (word === "include") includeDirectives += 1;
        modifiers = [];
        modifierStart = -1;
      }
      lastSignificant = word;
      i = j;
      continue;
    }
    if (!/\s/.test(ch)) {
      modifiers = [];
      modifierStart = -1;
      lastSignificant = ch;
    }
    i += 1;
  }

  return { declarations, includeDirectives };
}


/**
 * Conta regras REPORTÁVEIS com o mesmo parser lexical que o motor usa
 * (`scanYaraSource`), não com uma regex paralela sobre o texto.
 *
 * Uma regex `^rule\s+\w+` perde declarações indentadas e conta `private` que
 * nunca é reportada. O updater publica este número no manifesto; usar aqui o
 * parser do motor mantém a contagem do manifesto e a do `ruleCount` coerentes.
 */
export function countReportableYaraRules(content: string): number {
  return scanYaraSource(content).declarations.filter((declaration) => declaration.reportable)
    .length;
}

export class YaraEngine {
  private scanner: YaraClassicScanner | null = null;
  private rulesPath: string;
  private manifestPath: string;
  private readonly explicitManifestPath?: string;
  private _manifest: YaraCorpusManifest | null = null;
  private _health: EngineSubsystemHealth = {
    status: "unavailable",
    detail: "Not initialized",
    // Sem corpus carregado, a cobertura não foi medida. `unknown` é a única
    // resposta honesta: afirmar "limited" seria afirmar que medimos pouco.
    coverage: "unknown",
  };
  private _ruleCount = 0;

  constructor(rulesPath?: string, manifestPath?: string) {
    this.rulesPath = rulesPath || path.join(process.cwd(), "definitions", "yara", "default.yar");
    // Por omissão fica ao lado da pasta do corpus: <definitions>/.yara-corpus.json.
    this.explicitManifestPath = manifestPath;
    this.manifestPath = manifestPath ?? path.join(path.dirname(this.rulesPath), "..", ".yara-corpus.json");
  }

  /** Manifesto de proveniência usado na última classificação (null = ausente/inválido). */
  get manifest(): YaraCorpusManifest | null {
    return this._manifest;
  }

  get health(): EngineSubsystemHealth {
    return this._health;
  }

  get ruleCount(): number {
    return this._ruleCount;
  }

  get isAvailable(): boolean {
    return this.scanner !== null;
  }

  markUnavailable(detail: string): void {
    this.scanner = null;
    this._ruleCount = 0;
    this._manifest = null;
    this._health = { status: "error", detail, coverage: "unknown" };
  }

  async load(filePath: string) {
    this.rulesPath = filePath;
    // O manifesto acompanha o corpus carregado. Sem isto, o motor do serviço
    // (`new YaraEngine()` + `load(definitionsDir/...)`) procuraria o manifesto
    // no cwd de arranque e a proveniência publicada nunca era lida.
    if (!this.explicitManifestPath) {
      this.manifestPath = path.join(path.dirname(filePath), "..", ".yara-corpus.json");
    }
    await this.ensureRules();
  }

  private async ensureRules(): Promise<void> {
    let ruleSource: "file" | "fallback" | null = null;
    let shouldWriteFallback = false;
    let ruleContent: string | null = null;
    // Distingue o canário canónico (a constante, que sabemos que compila) de
    // um canário que foi lido do disco. Um canário lido do disco pode estar
    // corrompido, truncado ou editado — logo tem de ser revalidado e, se não
    // compilar, reescrito a partir da constante. Tratar os dois como iguais
    // fazia um ficheiro inválido no disco matar o motor.
    let ruleFromCanonicalConstant = false;

    if (existsSync(this.rulesPath)) {
      try {
        const content = await fs.readFile(this.rulesPath, "utf-8");

        // Rejeita conteúdo JSON (ex.: default.json carregado acidentalmente como regras)
        // e conteúdo HTML (download corrompido). JSON válido começa com "[" ou "{".
        const trimmed = content.trim();
        const looksLikeJson = trimmed.startsWith("[") || trimmed.startsWith("{");
        if (
          trimmed === "" ||
          content.includes("<!DOCTYPE html>") ||
          content.includes("<html") ||
          looksLikeJson
        ) {
          console.warn(`[YARA] Conteúdo de ${this.rulesPath} não parece YARA válido. Correção por fallback.`);
          shouldWriteFallback = true;
        } else {
          // Qualquer ficheiro não-vazio que não seja JSON/HTML é entregue ao
          // compilador como corpus. A decisão "tem regras usáveis?" passou para
          // DEPOIS da compilação (análise lexical) — nunca se reescreve o
          // ficheiro só por ele não declarar regras reportáveis.
          //
          // Proveniência do canário: o fallback é gravado no path do corpus
          // real, por isso no arranque seguinte o motor lê um ficheiro YARA
          // perfeitamente válido e reportaria "active" — o canário apresentado
          // como corpus de produção, com a deteção de malware ainda desligada.
          //
          // O marker, sozinho, decide. Antes exigia-se também que o ficheiro
          // tivesse no máximo uma declaração `rule`, e essa verificação era
          // textual: um bloco de comentário `/* ... rule x ... */` contava
          // como regra, e um `rule` a meio de uma linha não contava. Um
          // corpus real que trouxesse a nossa regra canário ao lado de
          // regras reais era lido como produção. Contagem textual de regras
          // não é um mecanismo fiável de proveniência — daí ter saído.
          //
          // O marker identifica o fallback local; a sua ausência não valida
          // a proveniência nem a eficácia das regras. A compilação pode tornar
          // o motor operacional, mas a cobertura permanece desconhecida até
          // haver evidência independente.
          //
          // Se o conteúdo com marker não compilar, o caminho de recuperação
          // abaixo reescreve-o com as FALLBACK_RULES canónicas, que são a
          // única coisa que sabemos garantir que compilam.
          ruleSource = content.includes(FALLBACK_MARKER) ? "fallback" : "file";
          ruleContent = content;
        }
      } catch {
        shouldWriteFallback = true;
      }
    } else {
      shouldWriteFallback = true;
    }

    if (shouldWriteFallback) {
      try {
        await fs.mkdir(path.dirname(this.rulesPath), { recursive: true });
        await fs.writeFile(this.rulesPath, FALLBACK_RULES, "utf-8");
        ruleSource = "fallback";
        ruleContent = FALLBACK_RULES;
        ruleFromCanonicalConstant = true;
        console.log("[YARA] Regras fallback escritas em", this.rulesPath);
      } catch (err) {
        console.error("[YARA] Não foi possível escrever fallback:", err);
      }
    }

    if (!ruleContent) {
      this._manifest = null;
      this._health = { status: "error", detail: "No rules content available", coverage: "unknown" };
      this.scanner = null;
      return;
    }

    // Lido aqui, depois de o conteúdo final estar decidido: o manifesto liga-se
    // por hash ao corpus, por isso um manifesto de outro ficheiro (ou de um
    // corpus que caiu para o canário) não é usado.
    this._manifest = await readManifest(this.manifestPath, ruleContent);

    const buildScanner = (): { scanner: YaraClassicScanner } => {
      const binaries = resolveYaraClassicBinaries();
      if (!binaries) {
        throw new Error(
          "YARA clássico não encontrado (CYBERSAFE_YARA_BIN_DIR, resources/yara ou vendor/yara). " +
            "Sem o motor oficial nenhuma regra pode ser carregada.",
        );
      }
      // A validação corre sobre o FICHEIRO quando é ele que está a ser usado:
      // o `include` resolve-se no directório do próprio corpus. Só quando o
      // conteúdo em memória não corresponde ao que está em disco — escrita do
      // fallback falhada — é que o texto é validado num temporário.
      const diagnostics = this.validateCorpus(ruleContent, binaries);
      const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      if (errors.length > 0) {
        const first = errors[0];
        const location = first.line === undefined ? "" : `:${first.line}`;
        throw new Error(`YARA não compila o corpus (${first.code}${location}): ${first.message}`);
      }
      // Metadados (hash1, cybersafe_evidence) lidos do corpus que foi compilado.
      const meta = parseRuleMeta(ruleContent ?? "");
      return { scanner: createYaraClassicScanner({ rulesPath: this.rulesPath, binaries, meta }) };
    };

    try {
      const built = buildScanner();
      this.scanner = built.scanner;
    } catch (loadErr: any) {
      if (ruleSource === "fallback" && ruleFromCanonicalConstant) {
        // O canário canónico em si não compila. É um defeito nosso, não do
        // ficheiro em disco: nada seguro a fazer. Um motor morto é pior do
        // que um canário, e mentir sobre o canário seria pior ainda. Falha
        // visível, nunca silêncio.
        console.error("[YARA] Erro fatal: o corpus de fallback não compila:", loadErr?.message);
        this.scanner = null;
        this._health = {
          status: "error",
          detail: `YARA load failed: ${loadErr?.message ?? "unknown"}`,
          coverage: "unknown",
        };
        return;
      }

      // Canário lido do disco que não compila (o marker foi visto, portanto
      // sabemos que é nosso, mas o conteúdo está corrompido/truncado/editado).
      // A recuperação correta é reescrever a partir da constante canónica e
      // compilar ISSO. Sem esta distinção, um ficheiro de texto que por
      // qualquer motivo ficou por escrever em disco matava o motor, quando a
      // constante que o originou está a dois metros e é válida.
      if (ruleSource === "fallback") {
        console.warn(
          `[YARA] Canário persistido em ${this.rulesPath} não compila (${loadErr?.message ?? loadErr}). ` +
            `Reescreve a partir do canário canónico.`
        );
        try {
          await fs.mkdir(path.dirname(this.rulesPath), { recursive: true });
          await fs.writeFile(this.rulesPath, FALLBACK_RULES, "utf-8");
        } catch (writeErr: any) {
          console.error("[YARA] Não foi possível reescrever o canário:", writeErr?.message ?? writeErr);
        }
        ruleContent = FALLBACK_RULES;
        ruleFromCanonicalConstant = true;
        try {
          this.scanner = buildScanner().scanner;
        } catch (canonicalErr: any) {
          // Aqui sim é o nosso defeito: a constante não compila.
          console.error("[YARA] Erro fatal ao carregar o YARA clássico:", canonicalErr?.message ?? canonicalErr);
          this.scanner = null;
          this._health = {
            status: "error",
            detail: `YARA load failed: ${canonicalErr?.message ?? "unknown"}`,
            coverage: "unknown",
          };
          return;
        }
      } else {
        // YARA sintaticamente inválido que ainda assim contém "rule " passa a
        // verificação textual e era aceite como corpus de produção — até
        // rebentar na compilação, deixando o motor em "error". O comportamento
        // seguro é o mesmo de qualquer outro corpus ilegível: gravar o canário,
        // ficar degradado, e dizer que a análise por regras está inativa.
        console.warn(
          `[YARA] Corpus em ${this.rulesPath} não compila (${loadErr?.message ?? loadErr}). Cai para o canário.`
        );
        ruleSource = "fallback";
        ruleContent = FALLBACK_RULES;
        ruleFromCanonicalConstant = true;
        try {
          await fs.mkdir(path.dirname(this.rulesPath), { recursive: true });
          await fs.writeFile(this.rulesPath, FALLBACK_RULES, "utf-8");
        } catch (err) {
          console.error("[YARA] Não foi possível escrever fallback:", err);
        }
        try {
          this.scanner = buildScanner().scanner;
        } catch (fallbackErr: any) {
          console.error("[YARA] Erro fatal ao carregar o YARA clássico:", fallbackErr?.message ?? fallbackErr);
          this.scanner = null;
          this._health = {
            status: "error",
            detail: `YARA load failed: ${fallbackErr?.message ?? "unknown"}`,
            coverage: "unknown",
          };
          return;
        }
      }
    }

    this._ruleCount = this.countRules(ruleContent);

    // Zero regras reportáveis: o corpus NÃO é reescrito (pode conter regras
    // privadas legítimas ou documentação que o utilizador não quer perder) e
    // NÃO é declarado `active` — zero regras não é evidência de ficheiro
    // limpo. Fica `degraded` com `coverage: "unknown"`. O único caso em que o
    // scanner fica carregado é um corpus com `include`, cujas regras vivem
    // noutro ficheiro e não são contáveis a partir desta fonte.
    if (this._ruleCount === 0) {
      const includes = scanYaraSource(ruleContent).includeDirectives;
      if (includes > 0) {
        this._health = {
          status: "degraded",
          detail:
            `Corpus em ${this.rulesPath} usa include: as regras vêm de outro ficheiro ` +
            `e não são contáveis a partir desta fonte. Cobertura desconhecida; ` +
            `o corpus não foi alterado.`,
          coverage: "unknown",
        };
        console.warn(
          `[YARA] Corpus com include em ${this.rulesPath}: contagem de regras nao verificavel; health degradado.`,
        );
        return; // scanner fica carregado: as regras incluídas podem existir
      }
      // Sem scanner: `scanFile`/`match` recusam com `unavailable` em vez de
      // devolverem "zero matches" como se o ficheiro tivesse sido avaliado.
      // `this.rulesPath` fica intacto — nada foi escrito.
      this.scanner = null;
      this._manifest = null;
      this._health = {
        status: "degraded",
        detail:
          `Corpus em ${this.rulesPath} não declara nenhuma regra utilizável ` +
          `(0 regras reportáveis: só comentários, texto ou regras private). ` +
          `A análise por regras está inativa; o ficheiro não foi alterado.`,
        coverage: "unknown",
      };
      console.warn(
        `[YARA] Corpus sem regras reportaveis em ${this.rulesPath}: analise por regras inativa; ficheiro preservado.`,
      );
      return;
    }

    const coverage = this.classifyCoverage(ruleSource, ruleContent);
    const accepted = this._manifest?.sources ?? [];
    const productionSources = accepted.filter((source) => source.ruleClass === "production");
    const testSources = accepted.filter((source) => source.ruleClass === "test");
    const referenceSources = accepted.filter((source) => source.ruleClass === "reference");
    const rejectedProduction = (this._manifest?.rejected ?? [])
      .filter((entry) => entry.reason.length > 0).length;

    if (coverage === "limited") {
      // Degradado é o estado honesto aqui: o motor funciona, mas só com
      // canários de teste. O detalhe diz isso explicitamente, porque "a
      // analisar com regras de teste" e "a analisar com regras de malware"
      // são afirmações muito diferentes e o utilizador não pode adivinhar qual
      // delas está a acontecer.
      this._health = {
        status: "degraded",
        detail:
          "Corpus de regras só com assinaturas de teste (EICAR/canário). " +
          "A análise por regras de malware está inativa até as regras reais " +
          "serem descarregadas com sucesso.",
        // Quem decide isto é o CONTEÚDO, não a proveniência do ficheiro: uma
        // regra que só deteta o ficheiro de teste não sustenta `normal`, com
        // marker ou sem ele. O marker é o atalho para o mesmo fact: o canário
        // é, por construção, só-teste.
        coverage: "limited",
      };
    } else if (this._manifest) {
      // Há proveniência registada. Continua a ser `unknown`: um manifesto diz
      // de onde vieram as regras, não que elas detetem ameaças. Mas agora o
      // detalhe pode dizer quantas fontes de produção contribuíram e quantas
      // foram rejeitadas — o que distingue "corpus só de teste" de "corpus
      // parcial".
      const rejectedNote = rejectedProduction > 0
        ? ` ${rejectedProduction} fonte(s) rejeitada(s) no último update.`
        : "";
      // Referência não é deteção: fica de fora do corpus e da contagem de
      // cobertura. O detalhe só acrescenta a nota quando existem fontes desta
      // classe, para não mudar o texto de manifestos antigos sem motivo.
      const referenceNote = referenceSources.length > 0
        ? ` ${referenceSources.length} reference source(s) excluded from the threat corpus.`
        : "";
      this._health = {
        status: "active",
        detail:
          `Loaded ${this._ruleCount} rule(s) from ${productionSources.length} production ` +
          `and ${testSources.length} test source(s); efficacy not verified.` +
          referenceNote +
          rejectedNote,
        coverage,
      };
    } else {
      this._health = {
        status: "active",
        detail: `Loaded ${this._ruleCount} rule(s) from file; source and efficacy not verified`,
        // Compilar prova que o scanner está operacional, não que as regras
        // sejam eficazes ou tenham proveniência validada.
        coverage,
      };
    }

    console.log(`[YARA] Scanner carregado (${ruleSource}). Regras: ${this._ruleCount}`);
  }

  /**
   * Valida o corpus que vai ser usado.
   *
   * O caminho preferido é o FICHEIRO (o `include` resolve ao lado dele); o
   * texto só é validado num temporário quando não corresponde ao que está em
   * disco — o que só acontece quando a escrita do fallback falhou.
   */
  private validateCorpus(
    ruleContent: string | null,
    binaries: YaraClassicBinaries,
  ): YaraClassicDiagnostic[] {
    try {
      if (existsSync(this.rulesPath) && readFileSync(this.rulesPath, "utf-8") === ruleContent) {
        return validateYaraFile(this.rulesPath, { binaries });
      }
    } catch {
      // Sem leitura fiável do ficheiro, cai para a validação do texto.
    }
    return validateYaraSource(ruleContent ?? FALLBACK_RULES, { binaries });
  }

  private classifyCoverage(
    ruleSource: "file" | "fallback" | null,
    content: string,
  ): "unknown" | "limited" {
    if (ruleSource === "fallback") return "limited";

    // Segmentação pelas declarações REAIS (análise lexical): um comentário que
    // mencione `rule` já não cria uma “regra” fantasma nem desalinha os blocos
    // que decidem se o corpus é só-teste. Só as regras reportáveis contam — uma
    // helper `private` não é deteção, e não deve transformar um corpus canário
    // em “desconhecido” por ter um nome que não parece de teste.
    const { declarations } = scanYaraSource(content);
    const reportable = declarations.filter((declaration) => declaration.reportable);
    if (reportable.length === 0) return "unknown";

    const soAssinaturasDeTeste = reportable.every((declaration) => {
      const index = declarations.indexOf(declaration);
      const next = declarations[index + 1];
      const bloco = content.slice(declaration.start, next ? next.start : content.length);
      const descricao = /description\s*=\s*"([^"]*)"/i.exec(bloco)?.[1] ?? "";
      return TEST_SIGNATURE.test(declaration.name) || TEST_SIGNATURE.test(descricao);
    });

    return soAssinaturasDeTeste ? "limited" : "unknown";
  }

  /**
   * Regras que o motor pode REPORTAR (públicas + globais; nunca `private`).
   * É este o número que decide se há análise por regras: zero regras
   * reportáveis não é “ficheiro limpo”, é “não avaliado”.
   */
  private countRules(content: string): number {
    return countReportableYaraRules(content);
  }

  match(buffer: Buffer): YaraMatch[] {
    if (!this.scanner) {
      throw new Error("YARA scanner is unavailable; buffer was not evaluated.");
    }

    try {
      const results = this.scanner.scan(buffer);
      return results.map(classifyMatch);
    } catch (error) {
      throw new Error("YARA could not scan the buffer.", { cause: error });
    }
  }

  /**
   * Leitura com resultado classificado. NUNCA devolve `ok` sem que o scan
   * nativo tenha terminado; `matches` vazio com `status !== "ok"` significa
   * "não avaliado", não "limpo".
   */
  async scanFileOutcome(
    filePath: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<YaraScanOutcome> {
    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;

    if (!this.scanner) {
      await this.ensureRules();
    }
    if (!this.scanner) {
      return { status: "unavailable", matches: [], durationMs: elapsed() };
    }
    if (options.signal?.aborted) {
      return { status: "cancelled", matches: [], durationMs: elapsed() };
    }

    let fileSize: number;
    try {
      fileSize = (await fs.stat(filePath)).size;
    } catch {
      return { status: "error", matches: [], durationMs: elapsed() };
    }
    if (fileSize > MAX_YARA_SCAN_FILE_BYTES) {
      return { status: "too-large", matches: [], durationMs: elapsed() };
    }

    const scanner = this.scanner;
    try {
      // O adaptador detém o subprocesso: só ele pode confirmar close/kill.
      // Não competir com esta Promise através de enforceDeadline/Promise.race.
      const matches = await scanner.scanFileAsync(filePath, {
        timeoutMs: options.timeoutMs ?? DEFAULT_YARA_SCAN_TIMEOUT_MS,
        signal: options.signal,
      });
      return { status: "ok", matches: matches.map(classifyMatch), durationMs: elapsed() };
    } catch (error) {
      if (error instanceof YaraClassicScanError) {
        const status: YaraScanStatus = error.terminationConfirmed &&
          (error.code === "timeout" || error.code === "cancelled") ? error.code : "error";
        return {
          status, matches: [], durationMs: elapsed(), detail: error.message,
          subprocess: { pid: error.pid, terminationConfirmed: error.terminationConfirmed, reason: error.code },
        };
      }
      return {
        status: "error", matches: [], durationMs: elapsed(),
        detail: error instanceof Error ? error.message : "YARA não conseguiu avaliar o ficheiro.",
      };
    }
  }

  async scanFile(
    filePath: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<YaraMatch[]> {
    const outcome = await this.scanFileOutcome(filePath, options);
    switch (outcome.status) {
      case "ok":
        return outcome.matches;
      case "unavailable":
        throw new YaraScanError("unavailable", "YARA scanner is unavailable; file was not evaluated.");
      case "too-large":
        throw new YaraScanError("too-large", "YARA exceeds the 100 MiB scan limit; file was not evaluated.");
      case "timeout":
        throw new YaraScanError("timeout", "YARA exceeded the scan deadline; file was not fully evaluated.", outcome);
      case "cancelled":
        throw new YaraScanError("cancelled", "YARA scan was cancelled; file was not evaluated.", outcome);
      default:
        throw new YaraScanError("error", outcome.detail ?? "YARA could not scan the requested file.", outcome);
    }
  }
}
