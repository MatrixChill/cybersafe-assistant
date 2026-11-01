import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as https from "node:https";
import { spawn } from "node:child_process";
import {
  CLAMAV_BINARY_ENV,
  CYBERSAFE_EICAR_POSITIVE_CONTROL_RULE,
  countReportableYaraRules,
  validateYaraSource,
  type YaraClassicDiagnostic,
  type YaraCorpusManifest,
  type YaraRuleClass,
} from "@cybersafe/core";
import {
  ensureFreshclamConfig,
  buildFreshclamArgs,
  explainFreshclamError,
  FRESHCLAM_CONFIG_FILENAME,
  type EnsureConfigResult,
} from "./clamav-config.js";
import { ClamDatabaseGate } from "./clam-database-gate.js";
import type { UpdateDenialReason } from "./clam-database-gate.js";
import { downloadYaraRulesText } from "./yara-rules-download.js";
import { WINDOWS_READONLY_ENV } from "./dev-windows-readonly.js";
import { FIXTURE_SCAN_FLAG } from "./dev-fixture-gate.js";

/**
 * A recuperação do corpus YARA pode fazer rede e escrever definições?
 *
 * Nos modos em que a lane corre sobre um Windows real em LEITURA
 * (`CYBERSAFE_DEV_WINDOWS_READONLY=1`) ou sobre uma fixture controlada
 * (`CYBERSAFE_REALDEV_FIXTURE_SCAN=1`), não. O contrato é dos módulos que já
 * definem estes modos; aqui só se reutiliza a flag, sem inventar um segundo
 * significado para ela.
 */
export function recuperacaoYaraPermitida(env: NodeJS.ProcessEnv = process.env): boolean {
  return actualizacaoDefinicoesPermitida(env);
}

/**
 * Uma actualização de definições pode fazer rede e escrever em `definitionsDir`?
 *
 * A mesma superfície fechada pelos modos de leitura/ fixture. O agendador passou
 * a arrancar com o SERVIÇO (não só com a proteção), portanto a guarda deixa de
 * ser opcional: sem ela, um run de leitura começaria a descarregar assinaturas.
 */
export function actualizacaoDefinicoesPermitida(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WINDOWS_READONLY_ENV] !== "1" && env[FIXTURE_SCAN_FLAG] !== "1";
}

/**
 * O agendador pode nascer neste processo? A decisão vive aqui para o motor e
 * para os testes verem a MESMA matriz. Em `NODE_ENV=test` não nasce: os testes
 * instanciam o motor sem querer I/O de rede. Readonly/fixture fecham a mesma
 * superfície de escrita.
 */
export function agendadorDefinicoesDeveArrancar(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "test" && actualizacaoDefinicoesPermitida(env);
}

// ── Configuration ────────────────────────────────────────────────────────────
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 horas
/** Limite do corpo do feed de hashes. O feed real é pequeno; isto fecha DoS de memória. */
export const MAX_HASH_FEED_BYTES = 8 * 1024 * 1024;

/**
 * Cadência PRÓPRIA do feed de hashes, mais curta que as 6 h das outras bases.
 *
 * Não é preferência, é aritmética da fonte: a documentação do MalwareBazaar
 * define `selector=time` como «additions made within the past 60 minutes». Com
 * o scheduler de 6 h a pedir esse selector, tudo o que caía nas cinco horas
 * intermédias desaparecia para sempre — o `get_recent` não aceita cursor nem
 * paginação. 45 min deixa sobreposição suficiente para que a mesma adição seja
 * vista em dois pedidos consecutivos; a deduplicação por SHA-256 torna isso
 * idempotente.
 */
export const HASH_FEED_INTERVAL_MS = 45 * 60 * 1000;
/** Janela declarada do `selector=time`, na documentação oficial. */
export const MALWAREBAZAAR_WINDOW_MS = 60 * 60 * 1000;
/** Teto de registos em disco. O feed cresce; a base carregada em memória também não pode crescer sem limite. */
export const MAX_HASH_RECORDS = 50_000;
/**
 * Nome da variável de ambiente onde o DONO da máquina põe a chave. A chave não
 * vive no repositório, não é compilada no instalador e não é lida do `settings.json`
 * (que é JSON em claro — `desktop/src/main.ts:145-175`). O precedente de chave de
 * serviço é `engine.ts:510` (`VIRUSTOTAL_API_KEY`).
 */
export const MALWAREBAZAAR_AUTH_KEY_ENV = "MALWAREBAZAAR_AUTH_KEY";

type UpdateComponent = "yara" | "clamav" | "hashes";

interface FonteFalha {
  /** Tentativas falhadas CONSECUTIVAS; limpa-se no primeiro sucesso. */
  count: number;
  /** Epoch ms a partir do qual esta fonte pode ser tentada outra vez. */
  nextAllowedAtMs: number;
  /** Último erro observado, para o UI poder mostrar a tentativa e a causa. */
  lastError?: string;
  lastAttemptAtMs?: number;
}

/**
 * Backoff por fonte. Base = a cadência da própria fonte; duplica a cada falha
 * consecutiva até 6 h. Sem teto, um fornecedor em baixo seria attackado a cada
 * tick para sempre; sem escalonar por fonte, uma falha do YARA esconderia a
 * saúde dos hashes.
 */
export const FALHA_BACKOFF_TETO_MS = 6 * 60 * 60 * 1000;

/**
 * `.update-meta.json`. O timestamp global mantém-se (compatibilidade), mas a
 * decisão de pular passa a ser POR COMPONENTE.
 *
 * MEDIDO (TP-RETOMA-01, 2026-10-29): o timestamp global era escrito quando
 * QUALQUER componente actualizava. Um YARA que respondia (mesmo com erros de
 * fonte) renovava a data e impedia o ClamAV de tentar outra vez durante 6 h —
 * a base envelhecia sem que o agendador voltasse a chamar o freshclam. Cada
 * componente tem agora a sua própria prova de sucesso.
 */
interface UpdateMeta {
  timestamp?: number;
  iso?: string;
  components?: Partial<Record<UpdateComponent, number>>;
  /**
   * Histórico de FALHAS por fonte, para o backoff ser por fonte e não global.
   * Uma fonte que falha não pode arrastar as outras duas, e uma fonte em falha
   * permanente não pode martelar o fornecedor a cada tick.
   */
  falhas?: Partial<Record<UpdateComponent, FonteFalha>>;
  /**
   * Prova da última VERIFICAÇÃO do feed de hashes (não da última escrita).
   * distinguir «verifiquei e não havia nada» de «escrevi coisas novas» é o que
   * impede o UI de mostrar «atualizado» depois de uma tentativa sem alteraçoes.
   */
  hashesCheckedAt?: number;
  /**
   * Cursor de cobertura: o instante (ms) da adição mais recente que alguma vez
   * vimos no feed. Se `now - cursor > MALWAREBAZAAR_WINDOW_MS`, a janela dos
   * 60 min já não cobre o que passou — e isso declara-se como lacuna, em vez de
   * se fingir uma base completa.
   */
  hashesCursorMs?: number;
}

// Fontes de regras YARA — lista de fallback.
//
// `ruleClass` é proveniência declarada, não eficácia: `test` só deteta o
// ficheiro de teste do EICAR. Só com fontes `production` aceites é que um
// corpus deixa de ser "cobertura limitada".
//
// `reference` é material de IDENTIFICAÇÃO, não de deteção: as regras PECheck
// (IsPE64, HasOverlay, HasDigitalSignature, …) descrevem a estrutura de um PE
// e as de `crypto_signatures.yar` descrevem constantes/APIs criptográficas.
// São validadas e registadas no manifesto, mas NÃO entram no corpus de ameaça
// nem na contagem de production — um binário benigno não pode colecionar
// matches "high" só por ser um PE64 ou usar AES.
//
// A 4ª fonte era `MALW_Ransomware_Generic.yar`, que responde 404 desde há
// meses: o update reportava uma falha permanente e o corpus nunca teve
// ransomware. Trocada por uma fonte real do mesmo repositório, com 17 regras
// e compilação verificada contra o motor de regras.
/* yara:pinned-sources:inicio */
/* Mantido por `scripts/yara-pin.mjs`. Rever = correr `--write`, o que é um
   commit: nada entra no corpus sem um humano ter aprovado o diff. */
export const YARA_PIN: Array<{ id: string; repo: string; file: string; revision: string; sha256: string; ruleClass: YaraRuleClass }> = [
  { id: "MALW_Eicar.yar", repo: "Yara-Rules/rules", file: "malware/MALW_Eicar.yar", revision: "1edbe8e0ddc32dc47b76e370beb51db16c07f487", sha256: "1ba3175cebe28fc5d4d25c1caf604beda152766db268a3f159e4bf61c2eddf54", ruleClass: "test" },
  { id: "packer_compiler_signatures.yar", repo: "Yara-Rules/rules", file: "packers/packer_compiler_signatures.yar", revision: "0de1aee46db299e2af7c24d597df0679cc834fcd", sha256: "5c60ed67663f1077cb8987c541ce2e18235d25a2f1aec1f986e10ddb92abe5a8", ruleClass: "reference" },
  { id: "crypto_signatures.yar", repo: "Yara-Rules/rules", file: "crypto/crypto_signatures.yar", revision: "05500412959fb42710c64afa4c41c00b75991422", sha256: "886ffb7bff349189b4cfe6d7d702040f504d036fb02e66e2233e6554a9346145", ruleClass: "reference" },
  { id: "RANSOM_MS17-010_Wannacrypt.yar", repo: "Yara-Rules/rules", file: "malware/RANSOM_MS17-010_Wannacrypt.yar", revision: "15a21a2eee9409cb20dbb2d4044c392522a9457e", sha256: "af98f947ff400fe76f0d2f919749fba5f278d7a6d19c0f34de6eeddd44e52f91", ruleClass: "production" },
];
/* yara:pinned-sources:fim */

/**
 * URL imutável da fonte: o `revision` é um commit, não uma branch. Buscar por
 * `master` era o que o pedido recusava — aceitava-se o que a branch publicasse
 * desde que compilasse, e compilar não é revisar.
 */
function urlDaFonte(pino: (typeof YARA_PIN)[number]): string {
  return `https://raw.githubusercontent.com/${pino.repo}/${pino.revision}/${pino.file}`;
}

/** Pin malformado não é «fonte em falha», é configuração errada: recusa-se antes de tocar na rede. */
export function pinoInvalido(pino: { revision: string; sha256: string; file: string; repo: string }): string | null {
  if (!/^[0-9a-f]{40}$/.test(pino.revision)) return "revision não é um commit SHA-1 de 40 hex";
  if (!/^[0-9a-f]{64}$/.test(pino.sha256)) return "sha256 não é um digest de 64 hex";
  if (!pino.repo || !/^[\w.-]+\/[\w.-]+$/.test(pino.repo)) return "repo fora da forma <dono>/<projeto>";
  if (!pino.file || pino.file.startsWith("/") || pino.file.includes("..")) return "caminho da fonte fora do repositório";
  return null;
}

/**
 * Motivo curto e sem detalhe sensível para o manifesto. Uma mensagem de erro
 * de fetch pode trazer a URL inteira; o manifesto é lido por consumidores de
 * estado e não deve transportar infraestrutura.
 */
function rejectionReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const http = /HTTP (\d{3})/.exec(message);
  if (http) return `HTTP ${http[1]}`;
  if (/não compilam|compile|compilador|E\d{3}/i.test(message)) return "compile-error";
  if (/Conteúdo baixado|válido/i.test(message)) return "invalid-content";
  return "fetch-error";
}

// MalwareBazaar API endpoint
const HASH_FEED_URL = "https://mb-api.abuse.ch/api/v1/";

/**
 * Chave de acesso: só aceito ASCII imprimível sem espaços, 16..128 caracteres.
 *
 * A regra não é cosmética. O valor vai direito para um header HTTP, por isso um
 * CR/LF seria injeção de header; e uma string vazia ou de dois caracteres não é
 * uma chave — é um typo que o feed pagaria com `missing api key` para sempre.
 * Devolver `null` faz o caminho de update recusar-se ANTES da rede.
 */
export function normalizarAuthMalwareBazaar(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length < 16 || value.length > 128) return null;
  if (!/^[!-~]+$/.test(value)) return null;
  return value;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * O que o feed devolve NÃO é uma base: é material bruto que tem de ser
 * validado antes de tocar em disco. Cada rejeição é contada e reportada —
 * uma base que silenciosamente «ignora» 90% do feed parece saudável e não é.
 *
 * Política de severidade (o motivo do `severity` ter saído do `"critical"`
 * automático): o `get_recent` devolve amostras com `signature` muitas vezes
 * `null` — é um fluxo de NOVOS envios, não uma lista de famílias confirmadas.
 * Marcar tudo como crítico seria afirmar uma certificação que a fonte não dá.
 * Nota honesta sobre o efeito real: hoje a severidade guardada NUNCA é lida
 * pela deteção — `analysis.ts:191` colapsa o registo num booleano e
 * `scoring.ts:47,170-178` soma sempre 95 — por isso esta mudança não altera
 * nenhum veredicto; altera a veracidade do que fica escrito em disco.
 */
export function parsearFeedMalwareBazaar(
  corpo: string,
): { status: string; registos: Array<{ sha256: string; family: string; severity: "high"; source: string }>; rejeitados: number; semAlteracoes: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(corpo);
  } catch {
    throw new Error("MalwareBazaar: resposta não é JSON utilizável.");
  }
  const obj = parsed as { query_status?: unknown; data?: unknown };
  const status = typeof obj?.query_status === "string" ? obj.query_status : "(ausente)";
  if (status === "missing api key") {
    throw new Error("MalwareBazaar: a API recusou o pedido por falta de Auth-Key.");
  }
  if (status === "bad auth" || status === "unauthorized") {
    throw new Error(`MalwareBazaar: Auth-Key recusada (${status}).`);
  }
  if (status === "exceeding rate" || status === "rate limited") {
    throw new Error(`MalwareBazaar: limite de pedidos atingido (${status}).`);
  }
  if (status !== "ok") {
    throw new Error(`MalwareBazaar: query_status não reconhecido (${status}).`);
  }
  if (obj.data === null || obj.data === undefined) {
    return { status, registos: [], rejeitados: 0, semAlteracoes: true };
  }
  if (!Array.isArray(obj.data)) {
    throw new Error("MalwareBazaar: data não é um array.");
  }
  const vistos = new Set<string>();
  const registos: Array<{ sha256: string; family: string; severity: "high"; source: string }> = [];
  let rejeitados = 0;
  for (const item of obj.data as Array<Record<string, unknown>>) {
    const hash = typeof item?.sha256_hash === "string" ? item.sha256_hash.toLowerCase() : "";
    if (!SHA256_HEX.test(hash)) {
      rejeitados += 1;
      continue;
    }
    if (vistos.has(hash)) {
      rejeitados += 1;
      continue;
    }
    vistos.add(hash);
    const family = typeof item?.signature === "string" && item.signature.trim()
      ? item.signature.trim().slice(0, 120)
      : "Unknown";
    registos.push({ sha256: hash, family, severity: "high", source: "malwarebazaar" });
  }
  return { status, registos, rejeitados, semAlteracoes: registos.length === 0 };
}

/**
 * Categorias do PRODUTO a partir dos códigos estáveis do adapter clássico.
 * O compilador C não publica códigos `E0xx`; o adapter normaliza-os
 * (`unknown-module`, `duplicate-rule`, …) e a categoría que o manifesto do
 * corpus regista continua a ser esta: `incompatible-module`, `duplicate-rule`
 * ou `compile-error`.
 */
function classifyYaraCompilerError(error: YaraClassicDiagnostic): string {
  return error.code === "unknown-module"
    ? "incompatible-module"
    : error.code === "duplicate-rule"
      ? "duplicate-rule"
      : "compile-error";
}

function describeYaraCompilerError(source: string, error: YaraClassicDiagnostic): string {
  const category = classifyYaraCompilerError(error);
  const location = error.line === undefined ? "" : `:${error.line}`;
  return `${source}${location}: ${category} (${error.code})`;
}

export interface UpdateResult {
  yaraUpdated: boolean;
  clamUpdated: boolean;
  hashesUpdated: boolean;
  errors: string[];
  warnings: string[];
  timestamp: string;
}

/**
 * O adiamento, escrito pela CAUSA certa.
 *
 * CODEX (2026-10-03), oitava ronda. Antes havia uma frase única para os três
 * casos, e ela era falsa em dois deles. Um adiamento por scans activos pede
 * tempo; um adiamento porque já está outro update a escrever pede outra
 * coisa; um adiamento porque o serviço está a encerrar não pede nada — quem
 * Reinicia resolve.
 */
function descreverAdiamento(reason: UpdateDenialReason | undefined, orcamentoMs: number): string {
  switch (reason) {
    case "busy-scans":
      return (
        `actualizacao adiada: ha scans ClamAV activos que nao drenaram dentro do orcamento ` +
        `(${orcamentoMs} ms). A base actual continua valida.`
      );
    case "outro-escritor":
      return "actualizacao adiada: ja ha outra actualizacao de assinaturas em curso. A base actual continua valida.";
    case "servico-a-encerrar":
      return "actualizacao adiada: o servico de proteccao esta a encerrar. A base actual continua valida.";
    default:
      return "actualizacao adiada: a base de assinaturas esta ocupada. A base actual continua valida.";
  }
}

/**
 * O `freshclam` a LANÇAR.
 *
 * DIST-CLAMAV13OUT: quando o motor é o bundle empacotado, o `freshclam` vive
 * AO LADO do `clamscan` (medido: os dois no mesmo directório). Sem isto, o
 * `spawn("freshclam", …)` dependia do PATH e, numa máquina sem ClamAV no PATH,
 * o update de assinaturas falhava mesmo com o motor empacotado a funcionar.
 *
 * Sem pin — ou com um pin cujo irmão não existe — devolve o nome simples e o
 * PATH volta a decidir: o comportamento de antes, inalterado. NÃO se procura o
 * `freshclam` do sistema por conta própria: um pin explícito é uma decisão do
 * operador/deploy, e inventar caminhos aqui seria adivinhar.
 *
 * PURO (env/plataforma/existência injectáveis): é o que permite medi-lo com um
 * PATH limpo e uma fixture isolada, sem correr o freshclam nenhuma vez.
 */
export function resolveFreshclamBinary(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    exists?: (path: string) => boolean;
  } = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const pinned = env[CLAMAV_BINARY_ENV]?.trim();
  if (!pinned) return "freshclam";
  // A plataforma INJECTADA manda nas regras de caminho, não a do host: com
  // `path.join` (do host) um `/opt/clamav/clamscan` "linux" validado em Windows
  // dava `/opt/clamav\\freshclam`, e um irmão existente era dado como ausente.
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const sibling = pathImpl.join(
    pathImpl.dirname(pinned),
    platform === "win32" ? "freshclam.exe" : "freshclam",
  );
  return exists(sibling) ? sibling : "freshclam";
}

export class DefinitionUpdater {
  private readonly definitionsDir: string;
  private readonly yaraPath: string;
  private readonly hashesPath: string;
  private readonly metaPath: string;
  private timer: NodeJS.Timeout | null = null;
  /** Cancela downloads em voo no encerramento; recriado se o scheduler voltar. */
  private abortController = new AbortController();
  /**
   * P1-1 (1) — QUANDO A BASE DE ASSINATURAS ESTÁ A SER TROCADA.
   *
   * MEDIDO: `checkAndUpdate` e o scan não tinham NENHUMA coordenação. O scan
   * aponta `--database=<defs>/clamav` e o freshclam escreve no MESMO directório.
   * Um clamscan que começa durante a troca pode ler a base a meio — e o
   * resultado é um veredicto sobre uma base que não existia em nenhum momento.
   *
   * A coordenação é uma JANELA, não um lock: o update declara que a base está a
   * mudar, e o scan que chega durante a janela responde `unavailable`. Não há
   * espera, não há fila, não há deadlock — um clamscan bloqueado à espera de
   * outro a terminar era um deadlock esperando a acontecer, e a vaga do
   * semáforo do core não pode ser usada aqui porque o update não passa por ela.
   *
   * `unavailable` é a resposta honesta: o utilizador vê "motor indisponível" e
   * o scan seguinte, já com a base parada, funciona. Um scan que finge ter
   * lido uma base em metamorfose é pior que um scan que não aconteceu.
   *
   * ── SUBSTITUÍDO PELO GATE (2026-10-03) ──────────────────────────────────────
   *
   * O que estava aqui era `clamDbSwapDepth`: um contador e uma janela
   * DECLARATIVA, consultada pelo scan com `isDatabaseSwapping()`. Isso era um
   * CHECK, e um check separado do uso não fecha uma corrida bidireccional:
   *
   *   scan lê `false` → (await) → freshclam arranca → scan entra na base
   *   scan já activo   → freshclam escreve por cima dele
   *
   * A autoridade passou a ser `ClamDatabaseGate` (`clam-database-gate.ts`): a
   * lease que o scan segura é o ÚNICO ponto de decisão, e o update só escreve
   * depois de todas as leases libertarem. O mecanismo antigo foi REMVIDO para
   * não deixar duas autoridades independentes para o mesmo estado — o que é a
   * forma mais segura de reintroduzir o bug que acabámos de fechar.
   *
   * A window de troca é agora o gate, e a sua janela é mais correcta: abre
   * ANTES de o freshclam nascer (quando o update é pedido) e fecha DEPOIS de
   * ele morrer, o que inclui o `spawn` a lançar.
   */
  /**
   * P1-1 (2) — o que fazer DEPOIS de uma troca, seja ela de onde vier.
   *
   * MEDIDO: `updateDefinitions()` (manual) chamava `isAvailable(true)`, mas o
   * scheduler — que corre de 6 em 6 horas e é o caminho normal — nunca o
   * fazia. Ou seja: o caminho que actualiza quase sempre deixava o motor a
   * reportar o estado de ANTES, que é exactamente o defeito que o parâmetro
   * `force` do `isAvailable` foi criado para fechar.
   *
   * Regra: só corre quando o freshclam REALMENTE correu com sucesso. Se o
   * freshclam não nasceu (drain falhado) ou falhou, não há base nova para
   * reavaliar — e re-sondar nesse caso seria publicar um estado que ninguém
   * pediu.
   */
  private afterSwap?: (result: UpdateResult) => Promise<void> | void;
  private afterYaraUpdated?: () => Promise<void> | void;
  private afterYaraRollbackFailed?: (error: unknown) => Promise<void> | void;
  private afterDefinitionsUpdated?: (result: UpdateResult) => Promise<void> | void;

  /**
   * O gate da base de assinaturas. Uma instância por serviço, partilhada com o
   * `ClamavBridge` pelo motor — é a MESMA instância nos dois lados, que é o que
   * faz a coordenação ser real e não duas autoridades concordando por sorte.
   */
  readonly gate: ClamDatabaseGate;
  /** Fontes pinadas desta instância (ver `YARA_PIN`). */
  private readonly yaraPin: typeof YARA_PIN;
  /** Como o `freshclam` é criado. Ver a nota no construtor. */
  private readonly spawnFreshclam: typeof spawn;
  private readonly renameYaraRules: typeof fsPromises.rename;
  /**
   * Seam de teste da escrita da base de hashes. É SEPARADO do seam do YARA de
   * propósito: um duplo que simula o rename do corpus não pode governar a
   * escrita de outra base. Em produção é `fsPromises.rename`.
   */
  private readonly renameHashes: typeof fsPromises.rename;
  /** Seam de teste; em produção é `https.request`. */
  private readonly hashFeedRequest: typeof https.request;
  /**
   * Chave de acesso do MalwareBazaar, resolvida NO CONSTRUCTOR a partir de
   * ambiente/config injectável. `null` é um estado legítimo e declarado: sem
   * chave o feed recusa-se antes de tocar na rede, e isso reporta-se como
   * «não configurado», não como falha de formato nem como sucesso.
   */
  private readonly hashAuthKey: string | null;

  constructor(
    definitionsDir: string,
    options: {
      afterSwap?: (result: UpdateResult) => Promise<void> | void;
      afterYaraUpdated?: () => Promise<void> | void;
      afterYaraRollbackFailed?: (error: unknown) => Promise<void> | void;
      afterDefinitionsUpdated?: (result: UpdateResult) => Promise<void> | void;
      gate?: ClamDatabaseGate;
      /**
       * Lista de fontes pinadas. Por omissão é o bloco revisto em código
       * (`YARA_PIN`); injectável só para os testes poderem exercer o caminho de
       * recusa por digesto — o produto nunca a passa.
       */
      yaraPin?: typeof YARA_PIN;
      /**
       * Seam de teste: como o `freshclam` é criado. A produção nunca injecta
       * nada; é `spawn` do `node:child_process`.
       *
       * Existe pela mesma razão que o `createSpawnClamav` existe no core: a
       * decisão que interessa — se `error` devolve a posse ou se espera pelo
       * `close` — só se prova com um filho que NÃO MORRE, e um freshclam real
       * que se recusa a morrer não se fabrica. Sem este seam, o teste teria de
       * substituir o `runFreshclam` inteiro, e então passaria a provar o
       * dublê em vez do código.
       */
      spawnFreshclam?: typeof spawn;
      renameYaraRules?: typeof fsPromises.rename;
      renameHashes?: typeof fsPromises.rename;
      hashFeedRequest?: typeof https.request;
      /**
       * Chave do MalwareBazaar. `undefined` = ler do ambiente; `null` = declarar
       * explicitamente que não há chave (testes); string = injectada por config
       * segura. Nunca há valor embutido no código.
       */
      hashAuthKey?: string | null;
    } = {},
  ) {
    this.definitionsDir = definitionsDir;
    this.yaraPath = path.join(definitionsDir, "yara", "default.yar");
    this.hashesPath = path.join(definitionsDir, "hashes", "default.json");
    this.metaPath = path.join(definitionsDir, ".update-meta.json");
    this.gate = options.gate ?? new ClamDatabaseGate();
    this.yaraPin = options.yaraPin ?? YARA_PIN;
    this.spawnFreshclam = options.spawnFreshclam ?? spawn;
    this.renameYaraRules = options.renameYaraRules ?? fsPromises.rename;
    this.renameHashes = options.renameHashes ?? fsPromises.rename;
    this.hashFeedRequest = options.hashFeedRequest ?? https.request;
    this.hashAuthKey =
      options.hashAuthKey === undefined
        ? normalizarAuthMalwareBazaar(process.env[MALWAREBAZAAR_AUTH_KEY_ENV])
        : normalizarAuthMalwareBazaar(options.hashAuthKey);
    DefinitionUpdater.liveGates.add(this.gate);
    // P1-1 (2) — o gancho é do CICLO, não do update manual: quem o regista é o
    // motor, e tanto o scheduler como o `updateDefinitions` o atravessam. Por
    // isso é uma opção do construtor e não um método — não há caminho que o
    // instale num caso e o esqueça no outro.
    this.afterSwap = options.afterSwap;
    this.afterYaraUpdated = options.afterYaraUpdated;
    this.afterYaraRollbackFailed = options.afterYaraRollbackFailed;
    this.afterDefinitionsUpdated = options.afterDefinitionsUpdated;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Verifica se já passou o intervalo e, se sim, atualiza.
   * Retorna o resultado da operação.
   */
  private activeOperations = 0;
  get operationInProgress(): boolean { return this.activeOperations > 0; }
  async checkAndUpdate(force = false): Promise<UpdateResult> {
    if (this.activeOperations > 0) {
      // Dois ciclos em paralelo escreveriam sobre as MESMAS bases: o gate do
      // ClamAV protege a LEITURA de uma escrita, não duas escritas uma contra a
      // outra. Recusar com aviso explícito é mais honesto do que serializar em
      // silêncio ou enfileirar pedidos que ninguém pediu.
      return {
        yaraUpdated: false,
        clamUpdated: false,
        hashesUpdated: false,
        errors: [],
        warnings: ["Já existe um ciclo de atualização de definições em curso; este pedido foi recusado para não escrever duas vezes sobre as mesmas bases."],
        timestamp: new Date().toISOString(),
      };
    }
    ++this.activeOperations;
    try { return await this.runCheckAndUpdate(force); }
    finally { --this.activeOperations; }
  }
  private async runCheckAndUpdate(force = false): Promise<UpdateResult> {
    const result: UpdateResult = {
      yaraUpdated: false,
      clamUpdated: false,
      hashesUpdated: false,
      errors: [],
      warnings: [],
      timestamp: new Date().toISOString(),
    };

    if (this.abortController.signal.aborted) {
      console.log("[Updater] Encerrado: actualização não começa.");
      return result;
    }

    // Cada componente decide por si. `force` continua a significar tudo.
    const stale = {
      yara: force || this.componentStale("yara"),
      clamav: force || this.componentStale("clamav"),
      hashes: force || this.componentStale("hashes"),
    };
    if (!stale.yara && !stale.clamav && !stale.hashes) {
      console.log("[Updater] Definições ainda frescas, pulando atualização.");
      return result;
    }

    const updated: Partial<Record<UpdateComponent, boolean>> = {};
    console.log(
      "[Updater] Iniciando atualização de definições...",
      JSON.stringify({ yara: stale.yara, clamav: stale.clamav, hashes: stale.hashes }),
    );

    // 1. YARA Rules
    if (stale.yara) {
      try {
        const yaraResult = await this.updateYaraRules();
        result.yaraUpdated = true;
        this.limparFalha("yara");
        updated.yara = true;
        result.errors.push(...yaraResult.errors.map((error) => `YARA source: ${error}`));
        result.warnings.push(...yaraResult.warnings.map((warning) => `YARA warning: ${warning}`));
        console.log("[Updater] Regras YARA atualizadas.");
      } catch (err: any) {
        result.errors.push(`YARA: ${err.message}`);
        this.registarFalha("yara", err.message);
        const sourceErrors = err?.sourceErrors;
        if (Array.isArray(sourceErrors)) {
          result.errors.push(...sourceErrors.map((detail: string) => `YARA source: ${detail}`));
        }
        console.error("[Updater] Falha ao atualizar YARA:", err.message);
      }
    }

    // Um download abortado no encerramento não pode continuar para ClamAV,
    // hashes ou escrita de metadados.
    if (this.abortController.signal.aborted) return result;

    // 2. ClamAV via freshclam. O sucesso é o freshclam a sair com 0; falha não
    // renova a prova deste componente (o próximo ciclo volta a tentar).
    if (stale.clamav) {
      try {
        await this.updateClamAV();
        result.clamUpdated = true;
        this.limparFalha("clamav");
        updated.clamav = true;
        console.log("[Updater] ClamAV atualizado via freshclam.");
      } catch (err: any) {
        // ClamAV não é obrigatório — freshclam pode não estar instalado
        result.errors.push(`ClamAV: ${err.message}`);
        this.registarFalha("clamav", err.message);
        console.warn("[Updater] freshclam indisponível ou falhou:", err.message);
      }
    }

    // 3. Hash feed
    if (stale.hashes) {
      try {
        const feed = await this.updateHashFeed();
        // Dois factos separados, porque são dois factos diferentes:
        // `hashesUpdated` = a base em disco mudou (é isto que manda recarregar
        // o SignatureDatabase); `updated.hashes` = houve uma verificação bem
        // sucedida (é isto que avança o timestamp do componente e evita
        // repassar o feed a cada minuto). Uma tentativa sem alterações não é
        // «base atualizada», e o UI não pode recebê-la como tal.
        result.hashesUpdated = feed.alterou;
        this.limparFalha("hashes");
        updated.hashes = true;
        if (feed.rejeitados > 0) {
          result.errors.push(`Hashes: ${feed.rejeitados} registos do feed rejeitados na validação.`);
        }
        if (feed.lacunaCobertura) {
          result.errors.push(
            "Hashes: lacuna de cobertura — passaram mais de 60 minutos desde a última adição observada e o get_recent não tem cursor; o feed só cobre a janela oficial.",
          );
        }
        console.log(
          `[Updater] Feed de hashes verificado: ${feed.novos} novos, ${feed.total} no total${feed.alterou ? "" : " (sem alterações)"}.`,
        );
      } catch (err: any) {
        result.errors.push(`Hashes: ${err.message}`);
        this.registarFalha("hashes", err.message);
        console.warn("[Updater] Falha ao atualizar hashes:", err.message);
      }
    }

    if (this.abortController.signal.aborted) return result;

    // Salva a prova POR COMPONENTE; o timestamp global só avança se algo mudou.
    if (updated.yara || updated.clamav || updated.hashes) {
      this.saveUpdateTimestamp(updated);
    }

    // P1-1 (2) — O GANCHO SÓ CORRE QUANDO A BASE MUDOU DE VERDADE.
    //
    // `clamUpdated` é a prova de que o freshclam nasceu E saiu com 0. Sem ele —
    // freshclam ausente, drain falhado, exit != 0 — não há base nova para
    // reavaliar, e re-sondar seria publicar um estado que ninguém mudou.
    //
    // O gancho corre no FIM do ciclo, tanto no caminho manual como no periódico:
    // é o MESMO `checkAndUpdate` nos dois, que é o que evita dois caminhos
    // parallelos com comportamentos diferentes.
    //
    // Uma falha aqui NÃO apaga o facto de que o update ocorreu. `clamUpdated`
    // continua true; o que se regista é um erro pós-update, e o health do motor
    // é que tem de continuar honesto.
    if (this.afterSwap && result.clamUpdated) {
      try {
        await this.afterSwap(result);
      } catch (err: any) {
        result.errors.push(`pos-update: ${err.message}`);
        console.warn("[Updater] Pós-update falhou:", err.message);
      }
    }

    if (
      this.afterDefinitionsUpdated &&
      (result.yaraUpdated || result.clamUpdated || result.hashesUpdated)
    ) {
      try {
        await this.afterDefinitionsUpdated(result);
      } catch (err: any) {
        result.errors.push(`definitions-reload: ${err.message}`);
        console.warn("[Updater] Recarregamento das definições falhou:", err.message);
      }
    }

    console.log("[Updater] Ciclo finalizado.", JSON.stringify(result));
    return result;
  }

  /**
   * Inicia o scheduler periódico. Roda um check imediato + setInterval.
   */
  startScheduler(): void {
    if (this.timer) return;
    if (this.abortController.signal.aborted) this.abortController = new AbortController();
    // O "tick" é a cadência MAIS curta entre as fontes (hoje a do feed de
    // hashes); quem decide o que corre em cada tick é `componentStale`, com o
    // limite por componente. Um único `setInterval` de 6 h não conseguia
    // cumprir a janela de 60 min do MalwareBazaar; um `setInterval` por fonte
    // criaria três concorrentes sem necessidade.
    console.log(
      `[Updater] Scheduler iniciado (tick: ${HASH_FEED_INTERVAL_MS / 60000}min; YARA/ClamAV: ${UPDATE_INTERVAL_MS / 3600000}h; hashes: ${HASH_FEED_INTERVAL_MS / 60000}min).`,
    );

    // Check imediato (non-blocking)
    void this.checkAndUpdate().catch((err) =>
      console.error("[Updater] Erro no check inicial:", err),
    );

    this.timer = setInterval(() => {
      void this.checkAndUpdate().catch((err) =>
        console.error("[Updater] Erro no check periódico:", err),
      );
    }, HASH_FEED_INTERVAL_MS);
  }

  /**
   * Para o scheduler e cancela download em voo.
   *
   * O `dispose()` do serviço chama isto e depois o `DefinitionUpdater.dispose()`
   * estático mata os `freshclam` vivos. Sem abortar, um download YARA de 30 s
   * podia terminar e escrever definições DEPOIS de o serviço dizer que fechou.
   */
  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.abortController.abort();
  }

  // ── Private: YARA ──────────────────────────────────────────────────────────

  private async updateYaraRules(): Promise<{ errors: string[]; warnings: string[] }> {
    if (this.yaraPin.length === 0) {
      // Lista de pin vazia é ficheiro de revisão por preencher, não «nenhuma fonte
      // falhou». Ir à rede sem pin seria exatamente o comportamento que foi
      // recusado na decisão D4.
      return { errors: ["YARA: nenhuma fonte pinada para rever; corpus anterior preservado."], warnings: [] };
    }
    await fsPromises.mkdir(path.dirname(this.yaraPath), { recursive: true });

    const validSources: string[] = [];
    const accepted: Array<{ name: string; ruleClass: YaraRuleClass; content: string }> = [];
    const rejected: Array<{ name: string; reason: string }> = [];
    const sourceErrors: string[] = [];
    const sourceWarnings: string[] = [];
    let lastError: Error | null = null;
    for (const descriptor of this.yaraPin) {
      const url = urlDaFonte(descriptor);
      const name = descriptor.id;
      const problemaDoPin = pinoInvalido(descriptor);
      if (problemaDoPin) {
        // Configuração errada nunca é «fonte que falhou na rede»: não se vai à
        // rede com um commit ou digest ilegível.
        sourceErrors.push(`${name}: pin inválido (${problemaDoPin})`);
        rejected.push({ name, reason: "pin-invalid" });
        lastError = new Error(`YARA pin inválido (${name}).`);
        continue;
      }
      try {
        const content = await this.downloadText(url);
        const source = new URL(url).pathname;
        // Integridade antes de sintaxe: o conteúdo do commit pinado tem de ser o
        // conteúdo revisto. Um `raw.githubusercontent.com` que sirva outra coisa
        // (ou um espelho intermédio) é recusado aqui, não compilado e aceite.
        const digesto = createHash("sha256").update(content, "utf8").digest("hex");
        if (digesto !== descriptor.sha256) {
          throw new Error(`Conteúdo não corresponde ao pin revisto (${name}); corpus anterior preservado.`);
        }
        // Validação: regras YARA devem conter "rule " e compilar com o YARA
        // clássico oficial (yarac). Só escrevemos no disco o que compila.
        if (!content.includes("rule ") || content.includes("<!DOCTYPE html>")) {
          throw new Error("Conteúdo baixado não parece ser YARA válido.");
        }
        const compilerDiagnostics = validateYaraSource(content);
        const compilerErrors = compilerDiagnostics.filter((diagnostic) => diagnostic.severity === "error");
        if (compilerErrors.length > 0) {
          sourceErrors.push(...compilerErrors.map((error) => describeYaraCompilerError(source, error)));
          rejected.push({ name, reason: "compile-error" });
          const codes = compilerErrors.map((error) => error.code).join(",");
          lastError = new Error(`YARA source rejected (${source}; ${codes}).`);
          const categories = compilerErrors
            .map((error) => `${classifyYaraCompilerError(error)} (${error.code})`)
            .join(", ");
          console.warn(`[Updater] Fonte YARA rejeitada (${source}): ${categories}`);
          continue;
        }
        for (const warning of compilerDiagnostics.filter((diagnostic) => diagnostic.severity === "warning")) {
          const location = warning.line === undefined ? "" : `:${warning.line}`;
          sourceWarnings.push(`${new URL(url).pathname}${location}: ${warning.code}`);
        }

        // Referência: já compilou sozinha acima. Não se junta ao corpus de
        // ameaça (nem ao teste de compatibilidade entre fontes): um conflito
        // com uma regra de deteção não existe se o ficheiro nunca é carregado.
        if (descriptor.ruleClass === "reference") {
          accepted.push({ name, ruleClass: descriptor.ruleClass, content });
          continue;
        }

        const candidate = [...validSources, content].join("\n");
        const candidateErrors = validateYaraSource(candidate).filter(
          (diagnostic) => diagnostic.severity === "error",
        );
        if (candidateErrors.length > 0) {
          sourceErrors.push(
            ...candidateErrors.map((error) => `${source}: incompatible-with-accepted-rules (${error.code})`),
          );
          rejected.push({ name, reason: "incompatible-with-accepted-rules" });
          lastError = new Error(`YARA source conflicts with accepted rules (${source}).`);
          console.warn(`[Updater] Fonte YARA incompatível com regras aceites (${source}).`);
          continue;
        }
        validSources.push(content);
        accepted.push({ name, ruleClass: descriptor.ruleClass, content });
      } catch (err: any) {
        lastError = err;
        const source = new URL(url).pathname;
        rejected.push({ name, reason: rejectionReason(err) });
        sourceErrors.push(`${source}: ${err.message}`);
        console.warn(`[Updater] Fonte YARA falhou (${source}):`, err.message);
      }
    }
    if (validSources.length === 0) {
      const failure =
        lastError instanceof Error ? lastError : new Error("Todas as fontes YARA falharam.");
      // O detalhe por fonte não pode desaparecer no `throw`: sem isto o
      // `definitions.update` só mostrava o último erro e escondia as outras
      // fontes que falharam (HTTP, compilação ou conflito).
      (failure as Error & { sourceErrors?: string[] }).sourceErrors = sourceErrors;
      throw failure;
    }

    // Controlo positivo: sem ele, um corpus com dezenas de regras que nunca
    // dispararam é indistinguível de um pipeline partido. A regra é NOSSA,
    // sem marker de fallback, e entra sempre como fonte de teste.
    const positiveControl = {
      name: "cybersafe-eicar-control.yar",
      ruleClass: "test" as YaraRuleClass,
      content: CYBERSAFE_EICAR_POSITIVE_CONTROL_RULE,
    };
    validSources.push(positiveControl.content);
    accepted.push(positiveControl);
    let corpusContent = validSources.join("\n");
    try {
      const controlErrors = validateYaraSource(corpusContent).filter(
        (diagnostic) => diagnostic.severity === "error",
      );
      if (controlErrors.length > 0) {
        throw new Error(controlErrors[0].message);
      }
    } catch (controlError: any) {
      // Um corpus real que já declare `CyberSafe_Canary_EICAR` colidiria. Nesse
      // caso o controlo positivo já existe (é o da fonte) e não se duplica.
      console.warn(
        "[Updater] Controlo positivo não pôde ser acrescentado:",
        controlError?.message ?? controlError,
      );
      validSources.pop();
      accepted.pop();
      corpusContent = validSources.join("\n");
    }
    await this.publishYaraRules(corpusContent, this.afterYaraUpdated);
    // Proveniência publicada DEPOIS do corpus, e ligada a ele por hash. Se
    // falhar, o corpus continua válido e o motor classifica-o pelo conteúdo:
    // perder o manifesto degrada o detalhe, nunca a proteção.
    await this.publishYaraManifest(corpusContent, accepted, rejected);
    return { errors: sourceErrors, warnings: sourceWarnings };
  }

  /**
   * Recuperação do corpus YARA no arranque.
   *
   * Existe por uma razão medida: `checkAndUpdate` salta tudo quando a última
   * actualização tem menos de 6 horas, INCLUINDO um corpus que ficou só com a
   * assinatura de teste. O utilizador via "Degradado" e o serviço só tentava
   * outra vez horas depois. Isto corre apenas o YARA — não toca em freshclam,
   * hashes, proteção ou configuração — e nunca lança: falhar aqui é voltar ao
   * estado em que já estava.
   */
  async refreshYaraCorpus(): Promise<boolean> {
    // Guarda de MODO. Esta recuperação faz rede e escreve no directório de
    // definições; nos modos read-only e fixture isso é exactamente o que não
    // pode acontecer. A recusa é total e acontece ANTES de qualquer I/O —
    // devolver `false` sem tocar em nada é a única resposta honesta.
    if (!recuperacaoYaraPermitida()) {
      console.log("[Updater] Recuperação YARA recusada: modo read-only/fixture.");
      return false;
    }
    try {
      const result = await this.updateYaraRules();
      console.log("[Updater] Recuperação do corpus YARA concluída.", JSON.stringify({
        errors: result.errors.length,
        warnings: result.warnings.length,
      }));
      return true;
    } catch (err: any) {
      console.warn("[Updater] Recuperação do corpus YARA falhou:", err?.message ?? err);
      return false;
    }
  }

  private async publishYaraManifest(
    corpusContent: string,
    accepted: Array<{ name: string; ruleClass: YaraRuleClass; content: string }>,
    rejected: Array<{ name: string; reason: string }>,
  ): Promise<void> {
    const manifestPath = path.join(this.definitionsDir, ".yara-corpus.json");
    const manifest: YaraCorpusManifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      corpusSha256: createHash("sha256").update(corpusContent, "utf-8").digest("hex"),
      sources: accepted.map((source) => ({
        name: source.name,
        ruleClass: source.ruleClass,
        // Mesmo parser do `ruleCount` do motor: inclui declarações indentadas
        // e `global`, exclui `private`. Uma regex `^rule` dava 17 onde o
        // motor conta 18.
        rules: countReportableYaraRules(source.content),
        sha256: createHash("sha256").update(source.content, "utf-8").digest("hex"),
      })),
      rejected,
    };

    const staging = path.join(
      path.dirname(manifestPath),
      `.${path.basename(manifestPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await fsPromises.writeFile(staging, JSON.stringify(manifest, null, 2), "utf-8");
      await this.renameYaraRules(staging, manifestPath);
    } catch (err: any) {
      console.warn("[Updater] Manifesto do corpus YARA não publicado:", err?.message ?? err);
      try {
        await fsPromises.unlink(staging);
      } catch {}
    }
  }

  private async publishYaraRules(content: string, afterPublish?: () => Promise<void> | void): Promise<void> {
    let previousContent: string | null = null;
    try {
      previousContent = await fsPromises.readFile(this.yaraPath, "utf-8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    await this.writeYaraRulesAtomically(content);
    if (!afterPublish) return;

    try {
      await afterPublish();
    } catch (reloadError) {
      try {
        if (previousContent === null) {
          await fsPromises.unlink(this.yaraPath);
        } else {
          await this.writeYaraRulesAtomically(previousContent);
        }
      } catch (restoreError) {
        if (
          previousContent !== null ||
          !(restoreError instanceof Error && "code" in restoreError && restoreError.code === "ENOENT")
        ) {
          let recoveryHandlerError: unknown;
          try {
            await this.afterYaraRollbackFailed?.(restoreError);
          } catch (error) {
            recoveryHandlerError = error;
          }
          throw new AggregateError(
            [reloadError, restoreError, ...(recoveryHandlerError ? [recoveryHandlerError] : [])],
            "YARA reload failed and the previous corpus could not be restored.",
          );
        }
      }

      try {
        await afterPublish();
      } catch (restoreReloadError) {
        let recoveryHandlerError: unknown;
        try {
          await this.afterYaraRollbackFailed?.(restoreReloadError);
        } catch (error) {
          recoveryHandlerError = error;
        }
        throw new AggregateError(
          [reloadError, restoreReloadError, ...(recoveryHandlerError ? [recoveryHandlerError] : [])],
          "YARA reload failed and the previous corpus could not be reloaded.",
        );
      }
      throw reloadError;
    }
  }

  private async writeYaraRulesAtomically(content: string): Promise<void> {
    const stagingPath = path.join(
      path.dirname(this.yaraPath),
      `.${path.basename(this.yaraPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let stagingCreated = false;

    try {
      const stagingFile = await fsPromises.open(stagingPath, "wx");
      stagingCreated = true;
      try {
        await stagingFile.writeFile(content, "utf-8");
        await stagingFile.sync();
      } finally {
        await stagingFile.close();
      }
      await this.renameYaraRules(stagingPath, this.yaraPath);
    } catch (error) {
      if (stagingCreated) {
        try {
          await fsPromises.unlink(stagingPath);
        } catch (cleanupError) {
          if (
            !(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")
          ) {
            throw new AggregateError(
              [error, cleanupError],
              "YARA rule publication failed and its staging file could not be removed.",
            );
          }
        }
      }
      throw error;
    }
  }

  private downloadText(url: string): Promise<string> {
    return downloadYaraRulesText(url, undefined, this.abortController.signal);
  }

  // ── Private: ClamAV ────────────────────────────────────────────────────────

  public static activeProcesses = new Set<import("child_process").ChildProcess>();

  public static dispose() {
    console.log(`[Updater] Terminando ${this.activeProcesses.size} processos de update pendentes...`);
    for (const p of this.activeProcesses) {
      try { p.kill('SIGKILL'); } catch {}
    }
    this.activeProcesses.clear();
    // P1-1 — o gate tem de fechar MESMO que nenhum `close` chegue.
    //
    // O `dispose` mata o filho por fora. Nao ha garantia de que o `close` do
    // Node seja emitido depois de um SIGKILL — e sem `close`, o `release` da
    // posse nunca corria e o gate ficava `updateActive = true` para
    // sempre. O preco de um gate preso e o motor ClamAV indisponivel ate ao
    // reinicio do servico, com scans a receber `unavailable` sem razao.
    // CODEX (2026-10-03), achado 10: aqui NAO se declara `scansConfirmadosMortos`.
    //
    // O `dispose` matou os freshclam de `activeProcesses` — e o `close` de cada
    // um devolve a posse por conta propria. Mas ele NAO matou os clamscans:
    // esses vivem na bridge, noutro dono. Declarar os scans mortos aqui era uma
    // confirmacao que ninguem deu, e o efeito era um freshclam a nascer por
    // cima de um clamscan vivo. O `reset` sem opcoes e a posicao honesta.
    for (const gate of DefinitionUpdater.liveGates) {
      try { gate.reset(); } catch {}
    }
    DefinitionUpdater.liveGates.clear();
  }

  /**
   * Os gates vivos, para o `dispose` estatico os poder fechar.
   *
   * O `dispose` e estatico e o gate e de instancia: sem este registo, o
   * shutdown nao saberia que gates existem. E' uma estrutura de WeakRef seria
   * mais limpa, mas `Set` com remocao no `dispose` e' mais simples e a
   * dimensao e o numero de updaters vivos (um por servico).
   */
  private static liveGates = new Set<ClamDatabaseGate>();

  private updateClamAV(options: { diagnostic?: boolean } = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const clamDbDir = path.join(this.definitionsDir, "clamav");
      fs.mkdirSync(clamDbDir, { recursive: true });

      // Config GERIDA, ao lado da base que aponta. Sem isto o freshclam aborta
      // no arranque: o pacote Chocolatey nao traz freshclam.conf, so o .sample
      // em conf_examples/. Ver clamav-config.ts para a medicao.
      let config: EnsureConfigResult;
      try {
        config = ensureFreshclamConfig(
          path.join(clamDbDir, FRESHCLAM_CONFIG_FILENAME),
          { databaseDirectory: clamDbDir },
        );
        console.log(`[Updater] freshclam.conf ${config.reason}: ${config.configFile}`);
      } catch (err: any) {
        reject(new Error(`nao foi possivel preparar a config do freshclam: ${err.message}`));
        return;
      }

      const args = buildFreshclamArgs({
        configFile: config.configFile,
        databaseDirectory: clamDbDir,
        diagnostic: options.diagnostic,
      });

      // P1-1 — O GATE, e não uma janela local.
      //
      // `beginUpdate()` regista o pedido ANTES do primeiro await (fecha a
      // admissão de scans novos), adquire a posse (exclusiva), espera os scans
      // com lease activa drenarem, e só então devolve a POSSE. Devolver `null`
      // significa: a troca não pode acontecer com honestidade — os scans não
      // drenaram dentro do orçamento, ou o serviço está a sair — e por isso o
      // freshclam NÃO NASCE. A base actual fica intacta e o scan que estava a
      // correr continua: não se mata trabalho de utilizador para actualizar
      // assinaturas.
      //
      // A posse volta num ÚNICO sítio, o `release` idempotente do lease. Com
      // sucesso, com falha, com `spawn` a lançar, com `error` ou com exit != 0.
      void this.gate
        .beginUpdateComMotivo()
        .then(({ lease: posse, refusal }) => {
          if (!posse) {
            // CODEX (2026-10-03), oitava ronda: a causa do adiamento VEM no
            // resultado. A versão anterior escrevia sempre "ha scans ClamAV
            // activos que nao drenaram" — e depois de um shutdown, ou com outro
            // escritor a segurar a vez, isso era mentira com zero scans a correr.
            // O utilizador lia essa frase no painel.
            reject(new Error(descreverAdiamento(refusal?.reason, this.gate.drainBudgetMs)));
            return;
          }
          // CODEX (2026-10-03), achado 2: `beginUpdate` pode resolver e o
          // `reset` do shutdown correr na microtarefa SEGUINTE, antes de esta
          // linha. O gate estava certo; o spawn é que ia na mesma, numa base de
          // um serviço a parar. A posse é reconfirmada no próprio sítio que vai
          // escrever — um `.then` não é o dono da decisão.
          if (!posse.valid) {
            reject(new Error("actualizacao cancelada: o serviço esta a encerrar antes de o freshclam nascer"));
            return;
          }
          this.runFreshclam(args, clamDbDir, config.configFile, resolve, reject, options, posse);
        })
        .catch((err) => {
          // Sem posse não há nada a devolver: o pedido nunca chegou a ter a vez.
          reject(err);
        });
    });
  }

  /**
   * O freshclam a correr DEPOIS do gate ter dado luz verde.
   *
   * A posse volta por `posse.release()`, que é IDEMPOTENTE. Não há contador
   * para descer de propósito nem flag para não descer duas vezes: um duplo
   * `release` desligaria a posse do update SEGUINTE, que já a tinha recebido por
   * passagem de vez — que é exactamente o bug que a posse por token veio
   * fechar.
   */
  private freshclamBinary(): string {
    return resolveFreshclamBinary();
  }

  private runFreshclam(
    args: string[],
    clamDbDir: string,
    configFile: string,
    resolve: () => void,
    reject: (err: Error) => void,
    options: { diagnostic?: boolean },
    posse: NonNullable<Awaited<ReturnType<ClamDatabaseGate["beginUpdate"]>>>,
  ): void {
    try {
      const child = this.spawnFreshclam(this.freshclamBinary(), args, {
        stdio: "pipe",
        windowsHide: true,
        timeout: 120_000, // 2 min timeout
        // cwd explicito: sem isto o freshclam herdaria o do do servico e
        // procuraria a config num sitio imprevisivel.
        cwd: clamDbDir,
      });
      DefinitionUpdater.activeProcesses.add(child);

      let stderr = "";
      let stdout = "";
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      // O freshclam vai MESMO escrever. Só agora `updateActive` é verdade, e
      // só agora o snapshot diz a verdade. O `markWriting` só corre se a posse
      // ainda for válida — se o shutdown entretanto levou a gate, o spawn nem
      // chega a acontecer.
      if (!posse.valid) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* nunca chegou a correr */
        }
        DefinitionUpdater.activeProcesses.delete(child);
        reject(new Error("actualizacao cancelada: o servico esta a shuts down antes do freshclam nascer"));
        return;
      }
      posse.markWriting();

      // A posse volta num ÚNICO sítio, e o `release` é idempotente.
      const fecharGate = () => posse.release();

      // CODEX (2026-10-03), achado 1: `error` NAO É PROVA DE MORTE.
      //
      // O Node emite `error` também quando não consegue MATAR o filho — não
      // só quando o spawn falha. Devolver a posse aqui admitia um scan e um
      // segundo update por cima de um freshclam que continuava vivo a escrever
      // na base: exactamente a corrida que o gate existe para fechar.
      //
      // A distinção é o PID: sem `child.pid` o processo nunca chegou a nascer e
      // nada está a escrever, logo a posse pode voltar. Com `child.pid` há
      // processo, e a prova de que acabou é o `close`.
      child.on("error", (err) => {
        const semPid = child.pid === undefined;
        if (semPid) {
          fecharGate();
          DefinitionUpdater.activeProcesses.delete(child);
        } else {
          // Ainda a escrever, ou pelo menos sem prova de que parou. Tenta-se
          // matar uma vez; se o `close` não vier, a posse fica presa — que é o
          // estado honesto, e o mesmo pelo qual a vaga fica envenenada no
          // clamscan. O `dispose` do serviço fecha o gate à mesma.
          try {
            child.kill("SIGKILL");
          } catch {
            /* ja morreu, ou nunca chegou a nascer */
          }
        }
        reject(new Error(`freshclam não encontrado ou falhou: ${err.message}`));
      });

      child.on("close", (code) => {
        fecharGate();
        DefinitionUpdater.activeProcesses.delete(child);
        if (code === 0) resolve();
        else {
          // O `--quiet` e omitido em diagnostico, por isso o stderr tem o erro
          // real. Traduzir em vez de despejar o bruto no log.
          const detail = explainFreshclamError(stderr, configFile);
            const extra = options.diagnostic && stdout.trim() ? ` (stdout: ${stdout.trim().slice(0, 400)})` : "";
          reject(new Error(`freshclam exit code ${code}: ${detail}${extra}`));
        }
      });
    } catch (err: any) {
      // O `spawn` a lançar é o caminho que faltava no mecanismo antigo, e é o
      // que com mais probabilidades de acontecer numa máquina sem freshclam.
      posse.release();
      DefinitionUpdater.activeProcesses.clear();
      reject(new Error(`freshclam não encontrado ou falhou: ${err.message}`));
    }
  }

  // ── Private: Hash Feed ─────────────────────────────────────────────────────

  /**
   * Verificação do feed de hashes. Devolve o que aconteceu, porque «sucesso» e
   * «base alterada» não são a mesma coisa: sem esta distinção o UI mostrava
   * «atualizado» depois de uma simples tentativa, e o motor recarregava uma base
   * que não mudou.
   */
  private async updateHashFeed(): Promise<{
    alterou: boolean;
    novos: number;
    total: number;
    rejeitados: number;
    lacunaCobertura: boolean;
  }> {
    if (!this.hashAuthKey) {
      // Recusar ANTES da rede: sem Auth-Key a API responde `missing api key`,
      // e o caminho antigo transformava isso em «Formato não reconhecido» — uma
      // mensagem que apontava para o fornecedor quando o problema era a nossa
      // configuração. Não há escrita, não há recarga, não há dúvida.
      throw new Error(
        `MalwareBazaar: sem chave de acesso (define ${MALWAREBAZAAR_AUTH_KEY_ENV} ou um canal de config seguro). O pedido não foi enviado.`,
      );
    }
    await fsPromises.mkdir(path.dirname(this.hashesPath), { recursive: true });

    const metaAntes = this.readUpdateMeta();
    const cursor = Number(metaAntes.hashesCursorMs ?? 0);
    const agora = Date.now();
    // Lacuna declarada, não escondida: se não vemos uma adição há mais do que a
    // janela oficial de 60 min, o que passou nesse intervalo não é recuperável
    // por `get_recent` (não tem cursor nem paginação).
    const lacunaCobertura =
      Number.isFinite(cursor) && cursor > 0 && agora - cursor > MALWAREBAZAAR_WINDOW_MS;

    const paginaTime = await this.downloadMalwareBazaar("time");
    const parsedTime = parsearFeedMalwareBazaar(paginaTime);
    let registos = parsedTime.registos;
    let rejeitados = parsedTime.rejeitados;

    // Se há lacuna, pede-se também a lista das 100 adições mais recentes. Não é
    // backfill completo — é o máximo que a fonte permite — e é um pedido extra
    // por ciclo, não um loop: respeitar os limites do fornecedor é requisito.
    if (lacunaCobertura) {
      try {
        const pagina100 = await this.downloadMalwareBazaar("100");
        const parsed100 = parsearFeedMalwareBazaar(pagina100);
        registos = this.mesclarRegistosPorHash(registos, parsed100.registos);
        rejeitados += parsed100.rejeitados;
      } catch (error: any) {
        // A janela `time` já foi aceite; falhar aqui não pode deitar fora o que
        // ela trouxe. Regista-se a limitação e segue-se com o que há.
        console.warn("[Updater] Segundo pedido do MalwareBazaar falhou:", error?.message ?? error);
      }
    }

    let existing: unknown[] = [];
    try {
      const raw = await fsPromises.readFile(this.hashesPath, "utf-8");
      const parsedExisting = JSON.parse(raw);
      if (Array.isArray(parsedExisting)) existing = parsedExisting;
    } catch {
      // Ficheiro ausente ou inválido: começa-se do zero, mas a escrita abaixo é
      // atómica e o `SignatureDatabase.load()` valida o que receber.
    }

    const merged = this.mergeHashFeeds(existing, registos);
    const totalAntes = existing.length;
    const novos = Math.max(0, merged.length - totalAntes);
    const alterou = novos > 0;

    if (!alterou) {
      // Nada novo: não se escreve, não se recarrega, mas a VERIFICAÇÃO conta e
      // fica registada — é o que permite ao UI dizer «verificado há X, sem
      // alterações» em vez de «atualizado».
      this.guardarEstadoHashes(agora, cursor);
      return { alterou: false, novos: 0, total: merged.length, rejeitados, lacunaCobertura };
    }

    // Teto de crescimento: mais vale uma base truncada com o corte declarado,
    // do que um ficheiro e um Map em memória a crescerem sem limite com o feed.
    const limitado = merged.length > MAX_HASH_RECORDS;
    const final = limitado ? merged.slice(merged.length - MAX_HASH_RECORDS) : merged;
    if (limitado) {
      console.warn(
        `[Updater] Base de hashes limitada a ${MAX_HASH_RECORDS} registos (${merged.length - MAX_HASH_RECORDS} descartados por antiguidade).`,
      );
    }

    const staging = path.join(
      path.dirname(this.hashesPath),
      `.${path.basename(this.hashesPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await fsPromises.writeFile(staging, JSON.stringify(final, null, 2), "utf-8");
      // Seam próprio, não o do YARA: um duplo do corpus não pode governar a
      // escrita da base de hashes. Em produção continua a ser `fsPromises.rename`.
      await this.renameHashes(staging, this.hashesPath);
    } catch (error) {
      await fsPromises.rm(staging, { force: true }).catch(() => undefined);
      throw error;
    }

    const cursorNovo = Math.max(cursor, agora);
    this.guardarEstadoHashes(agora, cursorNovo);
    return {
      alterou: true,
      novos,
      total: final.length,
      rejeitados,
      lacunaCobertura,
    };
  }

  /** Dedupe por SHA-256 entre duas páginas da mesma fonte (o `100` sobrepõe-se ao `time`). */
  private mesclarRegistosPorHash(
    a: Array<{ sha256: string }>,
    b: Array<{ sha256: string }>,
  ): Array<{ sha256: string; family: string; severity: "high"; source: string }> {
    const map = new Map<string, any>();
    for (const item of a) map.set(item.sha256, item);
    for (const item of b) if (!map.has(item.sha256)) map.set(item.sha256, item);
    return Array.from(map.values());
  }

  /**
   * Prova de verificação do feed, separada da prova de escrita.
   * `hashesCheckedAt` avança mesmo quando não houve alterações; `hashesCursorMs`
   * guarda o instante da última cobertura. Os dois vivem no mesmo ficheiro de
   * metadados por uma razão: `saveUpdateTimestamp` reescreve esse ficheiro, e por
   * isso preserva explicitamente estes campos.
   */
  private guardarEstadoHashes(quando: number, cursor: number): void {
    const meta = this.readUpdateMeta();
    fs.mkdirSync(path.dirname(this.metaPath), { recursive: true });
    fs.writeFileSync(
      this.metaPath,
      JSON.stringify(
        { ...meta, timestamp: meta.timestamp ?? quando, hashesCheckedAt: quando, hashesCursorMs: cursor },
        null,
        2,
      ),
      "utf-8",
    );
  }

  private downloadMalwareBazaar(selector: "time" | "100" = "time"): Promise<string> {
    return new Promise((resolve, reject) => {
      const data = `query=get_recent&selector=${selector}`;
      const req = this.hashFeedRequest(HASH_FEED_URL, {
        signal: this.abortController.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data),
          // Obrigatório em TODA a interação com a API, segundo a documentação
          // oficial («Obtain an Auth-Key (Required)», «you must include the HTTP
          // header Auth-Key»). Sem ele o pedido nem sequer chega aos dados.
          'Auth-Key': this.hashAuthKey as string,
        },
        timeout: 30000
      }, (res) => {
        if (res.statusCode && res.statusCode === 429) {
          reject(new Error("MalwareBazaar HTTP 429: limite de pedidos do fornecedor."));
          return;
        }
        if (res.statusCode && res.statusCode !== 200) {
          reject(new Error(`MalwareBazaar HTTP ${res.statusCode}`));
          return;
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > MAX_HASH_FEED_BYTES) {
          reject(new Error(`Feed de hashes excede o limite de ${MAX_HASH_FEED_BYTES} bytes (content-length)`));
          res.destroy();
          return;
        }
        let body = "";
        let bytes = 0;
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        res.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
          if (bytes > MAX_HASH_FEED_BYTES) {
            fail(new Error(`Feed de hashes excede o limite de ${MAX_HASH_FEED_BYTES} bytes`));
            res.destroy();
            return;
          }
          body += chunk;
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve(body);
        });
        // Uma ligação cortada antes do `end` não pode deixar a promessa
        // pendurada: sem estes caminhos, o updater ficava à espera para sempre
        // (ou até ao timeout do pedido, que não cobre todos os cortes).
        res.on("aborted", () => {
          fail(new Error("Ligação interrompida durante o download do feed de hashes."));
          res.destroy();
        });
        res.on("close", () => {
          if (!settled) {
            fail(new Error("Ligação fechada antes do fim do feed de hashes."));
          }
        });
        res.on("error", (error: Error) => fail(error));
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Timeout MalwareBazaar")); });
      req.write(data);
      req.end();
    });
  }

  private mergeHashFeeds(local: any[], remote: any[]): any[] {
    const map = new Map<string, any>();
    for (const entry of local) map.set(entry.sha256?.toLowerCase(), entry);
    for (const entry of remote) map.set(entry.sha256?.toLowerCase(), entry);
    return Array.from(map.values());
  }

  // ── Private: Metadata ──────────────────────────────────────────────────────

  private readUpdateMeta(): UpdateMeta {
    try {
      const raw = fs.readFileSync(this.metaPath, "utf-8");
      const parsed = JSON.parse(raw) as UpdateMeta;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * Um componente está velho?
   *
   * O fallback para o timestamp GLOBAL só vale para metadados LEGADOS, sem
   * `components` nenhum, e só para YARA/hashes. Assim que um metadado tem
   * componentes, a ausência de prova de um deles é velhice — nunca herdada do
   * sucesso de outro. Sem esta regra, um YARA fresco renovava o global e o
   * ClamAV falhado ficava mais 6 h sem nova tentativa, para sempre.
   *
   * Na migração, o ClamAV é tentado já: o global histórico não é prova de que o
   * freshclam correu. YARA/hashes podem herdar o global uma vez.
   */
  /**
   * Cadência por componente, não uma cadência única para as três fontes.
   * YARA e ClamAV ficam nas 6 h; o feed de hashes obedece à janela de 60 min
   * que a própria fonte define (ver `HASH_FEED_INTERVAL_MS`).
   */
  /**
   * Estado POR FONTE, para a UI poder dizer «actualizado / desactualizado /
   * degradado / indisponível / nunca verificado» sem inventar nada.
   *
   * Porque é um método do updater e não do motor: o único registo de quando cada
   * fonte foi tentada e conseguiu vive no `.update-meta.json` que o updater escreve.
   * O motor acrescenta depois o que só ele sabe (contagem de assinaturas em
   * memória, saúde do YARA e do ClamAV).
   *
   * Distinções que importam e antes não existiam:
   *  - `nunca_verificado` ≠ `indisponivel`: a primeira nunca tentou, a segunda
   *    tentou e o motor não está lá;
   *  - `ultimaTentativa` ≠ `ultimaBemSucedida`: mostrar a tentativa como se fosse
   *    sucesso é a mentira que o requisito 4 proíbe explicitamente;
   *  - `proximaVerificacao` sai da cadência da fonte, EXCETO quando há backoff em
   *    vigor — nesse caso é o fim da recusa, que é o que realmente vai acontecer.
   */
  estadoDasFontes(now = Date.now()): Array<{
    fonte: UpdateComponent;
    ultimaBemSucedidaAtMs: number | null;
    ultimaTentativaAtMs: number | null;
    ultimoErro: string | null;
    tentativasConsecutivas: number;
    proximaVerificacaoAtMs: number;
    cadenciaMs: number;
    nuncaVerificado: boolean;
    emBackoff: boolean;
  }> {
    const meta = this.readUpdateMeta();
    const hashesTentado = Number(meta.hashesCheckedAt ?? 0);
    return (["clamav", "yara", "hashes"] as UpdateComponent[]).map((fonte) => {
      const sucesso = Number(meta.components?.[fonte] ?? 0) || null;
      const falha = meta.falhas?.[fonte];
      const cadenciaMs = this.intervaloDoComponente(fonte);
      const ultimaTentativa =
        Number.isFinite(falha?.lastAttemptAtMs ?? 0) && (falha?.lastAttemptAtMs ?? 0) > 0
          ? (falha as FonteFalha).lastAttemptAtMs as number
          : fonte === "hashes" && hashesTentado > 0
            ? hashesTentado
            : sucesso;
      const emBackoff = !!falha && Number.isFinite(falha.nextAllowedAtMs) && now < falha.nextAllowedAtMs;
      return {
        fonte,
        ultimaBemSucedidaAtMs: sucesso,
        ultimaTentativaAtMs: ultimaTentativa ?? null,
        ultimoErro: falha?.lastError ?? null,
        tentativasConsecutivas: falha?.count ?? 0,
        proximaVerificacaoAtMs: emBackoff
          ? (falha as FonteFalha).nextAllowedAtMs
          : (sucesso ?? 0) + cadenciaMs,
        cadenciaMs,
        // Uma fonte só é «nunca verificada» se não houver NEM sucesso NEM
        // tentativa registada — e, no caso dos hashes, a verificação conta mesmo
        // sem alteração escrita, porque foi isso que aconteceu.
        nuncaVerificado: sucesso === null && ultimaTentativa == null && !(fonte === "hashes" && hashesTentado > 0),
        emBackoff,
      };
    });
  }

  /**
   * Regista uma falha desta fonte e calcula quando pode ser tentada de novo.
   * Backoff = cadência da fonte × 2^(tentativas-1), com teto de 6 h.
   */
  private registarFalha(componente: UpdateComponent, erro: string): void {
    const meta = this.readUpdateMeta();
    const anterior = meta.falhas?.[componente];
    const count = (anterior?.count ?? 0) + 1;
    const base = this.intervaloDoComponente(componente);
    const espera = Math.min(FALHA_BACKOFF_TETO_MS, base * 2 ** (count - 1));
    const agora = Date.now();
    const falhas = { ...(meta.falhas ?? {}) };
    falhas[componente] = { count, nextAllowedAtMs: agora + espera, lastError: erro.slice(0, 400), lastAttemptAtMs: agora };
    fs.mkdirSync(path.dirname(this.metaPath), { recursive: true });
    fs.writeFileSync(this.metaPath, JSON.stringify({ ...meta, falhas }, null, 2), "utf-8");
    console.warn(`[Updater] Falha registada em ${componente} (tentativa ${count}): nova tentativa não antes de ${Math.round(espera / 60000)} min.`);
  }

  /** Um sucesso limpa o histórico dessa fonte — o backoff é de FALHAS consecutivas. */
  private limparFalha(componente: UpdateComponent): void {
    const meta = this.readUpdateMeta();
    if (!meta.falhas?.[componente]) return;
    const falhas = { ...meta.falhas };
    delete falhas[componente];
    fs.writeFileSync(this.metaPath, JSON.stringify({ ...meta, falhas }, null, 2), "utf-8");
  }

  private intervaloDoComponente(component: UpdateComponent): number {
    return component === "hashes" ? HASH_FEED_INTERVAL_MS : UPDATE_INTERVAL_MS;
  }

  private componentStale(component: UpdateComponent): boolean {
    const meta = this.readUpdateMeta();
    const limite = this.intervaloDoComponente(component);
    // Backoff em vigor: uma fonte em falha consecutiva NÃO é «velha» até o seu
    // intervalo de recusa passar. Assim o scheduler continua a tentar as outras
    // fontes na cadência normal em vez de repicar num fornecedor caído.
    const recusa = meta.falhas?.[component];
    if (recusa && Number.isFinite(recusa.nextAllowedAtMs) && Date.now() < recusa.nextAllowedAtMs) {
      return false;
    }
    const hasComponents = meta.components !== undefined && Object.keys(meta.components).length > 0;
    if (!hasComponents) {
      if (component === "clamav") return true;
      const legacy = Number(meta.timestamp ?? 0);
      return !(Number.isFinite(legacy) && legacy > 0 && Date.now() - legacy < limite);
    }
    const own = Number(meta.components?.[component] ?? 0);
    return !(Number.isFinite(own) && own > 0 && Date.now() - own < limite);
  }

  private saveUpdateTimestamp(updated: Partial<Record<UpdateComponent, boolean>>): void {
    const meta = this.readUpdateMeta();
    const now = Date.now();
    const components: Partial<Record<UpdateComponent, number>> = { ...(meta.components ?? {}) };
    if (updated.yara) components.yara = now;
    if (updated.clamav) components.clamav = now;
    if (updated.hashes) components.hashes = now;
    fs.mkdirSync(path.dirname(this.metaPath), { recursive: true });
    fs.writeFileSync(
      this.metaPath,
      JSON.stringify(
        // `...meta` primeiro: o metadado é um só ficheiro e este é o caminho que
        // o reescreve por inteiro. Sem o spread, a prova de verificação do feed
        // (`hashesCheckedAt`/`hashesCursorMs`) desaparecia a cada ciclo e o UI
        // perdia justamente o que permite distinguir «verificado» de «atualizado».
        { ...meta, timestamp: now, iso: new Date(now).toISOString(), components },
        null,
        2,
      ),
      "utf-8",
    );
  }

}
