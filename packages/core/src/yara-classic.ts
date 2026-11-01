/**
 * MOTOR YARA CLÁSSICO OFICIAL (VirusTotal) — substitui o binding Node-API anterior.
 *
 * ── Porque existe ──────────────────────────────────────────────────────────
 * O binding Node-API que este módulo substitui arrastava uma cadeia Rust cujo
 * último componente de parsing não tinha aviso de copyright recuperável de
 * fonte versionada. A prova dessa cadeia (crates, digests e a razão do
 * bloqueio) vive em `assets/licenses/resolutions/` — esse é um bloqueador
 * DOCUMENTAL do artefacto distribuível, não do produto.
 *
 * O YARA clássico é o motor C oficial da VirusTotal, licenciado BSD-3-Clause
 * com aviso publicado no repositório (`COPYING`, vendorizado em
 * `vendor/yara/COPYING.txt`), e não depende daquela árvore Rust.
 *
 * ── Contrato ───────────────────────────────────────────────────────────────
 * Este módulo é o adapter mínimo entre o `YaraEngine` (que mantém a API e a
 * lógica de saúde/cobertura) e o executável oficial:
 *
 *   • `resolveYaraClassicBinaries()` — encontra `yara64.exe`/`yarac64.exe`, por
 *     ordem: env `CYBERSAFE_YARA_BIN_DIR` → `resources/yara` (pacote) →
 *     `vendor/yara/<versão>` (dev). Sem binários devolve `null`: o motor fica
 *     indisponível e DIZ isso, nunca "sem deteções".
 *   • `validateYaraFile` / `validateYaraSource` — compilação com `yarac64`,
 *     exit code como verdade. Um `include` resolve-se no directório do próprio
 *     ficheiro (medido: `include` é relativo ao ficheiro que o declara).
 *   • `createYaraClassicScanner` — scans com espasmos separados de argumentos,
 *     sem shell, com prazo próprio (kill), `-z`/`-a`/`-N`/`-w` como limites de
 *     recurso, e `stderr`+exit code como contrato de erro: um erro de scan NUNCA
 *     volta como "ficheiro limpo" (lista vazia só existe com exit 0).
 *   • `scan(buffer)` — escreve exatamente os bytes num ficheiro exclusivo de
 *     um diretório temporário isolado, analisa-o como ficheiro e remove-o no
 *     fim. Nunca analisa memória de processos. O chamador não deve fornecer
 *     payloads de teste de antivírus no host.
 *
 * ── O que este módulo NÃO faz ──────────────────────────────────────────────
 * O adaptador aceita sinal e prazo por chamada; solicita kill e aguarda close,
 * ou declara morte não confirmada após a tolerância. O chamador tem de passar
 * essas opções: um Promise.race exterior não cancela o subprocesso.
 *
 * ── Diferenças medidas face ao motor anterior (a declarar, não a esconder) ──
 *   • `condition: true` não gera aviso (o motor anterior avisava);
 *   • string não referenciada é ERRO nas versões 4.5.5 e 4.6.0 (medido);
 *   • regras `private` nunca são reportadas — igual ao motor anterior;
 *   • regras `global` são reportadas — igual ao motor anterior;
 *   • códigos de erro do compilador são normalizados aqui (`unknown-module`,
 *     `duplicate-rule`, …) porque o compilador C não publica códigos `E0xx`.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstDiagnosticLine } from "./response.js";

/** Versão vendorizada (release oficial com binários win64 publicados). */
export const YARA_CLASSIC_VERSION = "4.6.0";

/** Sobrepõe o directório dos binários (usado no empacotamento e nos testes). */
export const YARA_BINARY_ENV = "CYBERSAFE_YARA_BIN_DIR";

/** Prazo por omissão de um scan do motor clássico (mesmo valor do engine). */
export const YARA_SCAN_TIMEOUT_MS = 10_000;

/** Prazo da compilação (yarac) — corpus de ~113 KB compila em dezenas de ms. */
export const YARA_COMPILE_TIMEOUT_MS = 30_000;

/** Tecto de leitura alinhado com o `MAX_YARA_SCAN_FILE_BYTES` do engine. */
export const YARA_MAX_TARGET_BYTES = 100 * 1024 * 1024;

/** Tecto de saída capturada, para um corpus hostil não encher a memória. */
const MAX_CAPTURED_OUTPUT = 4 * 1024 * 1024;

/**
 * Dependência EXTERNA do executável oficial: o compilador publicado pela
 * VirusTotal é ligado ao runtime MSVC, não ao runtime do sistema. A tabela de
 * imports do `yarac64.exe` vendorizado (4.6.0, sha256 `1e9ff85a…8178`) declara
 * `VCRUNTIME140.dll`, que NÃO é componente inbox do Windows — vem do
 * Redistributable Microsoft Visual C++ 2015-2022 x64.
 */
export const YARA_CLASSIC_RUNTIME_DEPENDENCY =
  "VCRUNTIME140.dll (Microsoft Visual C++ 2015-2022 x64 Redistributable)";

/**
 * NTSTATUS do loader do Windows que significam "o processo nunca chegou a
 * `main`". O Node devolve o exit code do Windows sem o normalizar (0xC0000135
 * chega como 3221225781), por isso a comparação é feita em uint32.
 */
const WINDOWS_LOADER_FAILURES: ReadonlyMap<number, { name: string; meaning: string }> = new Map([
  [0xc0000135, { name: "STATUS_DLL_NOT_FOUND", meaning: "uma DLL exigida pelo executável não foi encontrada" }],
  [0xc0000142, { name: "STATUS_DLL_INIT_FAILED", meaning: "uma DLL exigida falhou a inicialização" }],
  [0xc0000139, { name: "STATUS_ENTRYPOINT_NOT_FOUND", meaning: "uma DLL carregada não exporta o símbolo exigido" }],
  [0xc000007b, { name: "STATUS_INVALID_IMAGE_FORMAT", meaning: "uma imagem executável ou DLL é inválida ou incompatível" }],
]);

/**
 * Traduz um exit code do Windows que seja falha de LOADER. Devolve `null` para
 * qualquer outro código (incluindo os códigos de compilação do yarac).
 *
 * Não nomeia a DLL em falta: o código diz que faltou uma, não qual. Atribuir
 * uma DLL concreta a um host que não foi medido seria inventar a prova.
 */
export function classifyWindowsLoaderFailure(
  status: number | null,
): { code: number; name: string; meaning: string } | null {
  if (typeof status !== "number" || !Number.isInteger(status)) return null;
  const code = status >>> 0;
  const entry = WINDOWS_LOADER_FAILURES.get(code);
  return entry ? { code, ...entry } : null;
}

export interface YaraClassicBinaries {
  yara: string;
  yarac: string;
  /** Directório de onde vieram (diagnóstico; sem caminhos de utilizador). */
  dir: string;
}

export type YaraClassicDiagnosticCode =
  | "unknown-module"
  | "duplicate-rule"
  | "unreferenced-string"
  | "syntax-error"
  | "slow-scan"
  | "compiler-warning"
  | "io-error"
  | "compile-error";

export interface YaraClassicDiagnostic {
  severity: "error" | "warning";
  code: YaraClassicDiagnosticCode;
  message: string;
  line?: number;
}

export interface YaraClassicMatch {
  ruleIdentifier: string;
  meta: Record<string, unknown>;
}

export interface YaraClassicScanner {
  readonly rulesPath: string;
  /** Scan síncrono dos bytes exatos através de um ficheiro temporário isolado. */
  scan(buffer: Buffer): YaraClassicMatch[];
  /** Scan assíncrono de um ficheiro, com kill no prazo. */
  scanFileAsync(filePath: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<YaraClassicMatch[]>;
}

const WINDOWS_EXECUTABLES = { yara: "yara64.exe", yarac: "yarac64.exe" } as const;

function isUsableFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Directórios candidatos, por ordem de precedência. Inclui o caminho
 * empacotado (`resources/yara`) e a árvore de desenvolvimento (`vendor/yara`),
 * esta última encontrada subindo a partir do módulo compilado.
 *
 * `CYBERSAFE_YARA_BIN_DIR` é AUTORITATIVO: quando está definido, só esse
 * directório é considerado. Um override explícito que não tenha os binários é
 * uma indisponibilidade declarada, não uma licença para carregar outro
 * executável encontrado por acaso na máquina — a proveniência do binário que
 * corre tem de ser determinística.
 */
function candidateDirectories(env: NodeJS.ProcessEnv): string[] {
  const fromEnv = env[YARA_BINARY_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return [path.resolve(fromEnv), path.join(path.resolve(fromEnv), YARA_CLASSIC_VERSION)];
  }

  const candidates: string[] = [];
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (typeof resources === "string" && resources !== "") {
    candidates.push(path.join(resources, "yara", YARA_CLASSIC_VERSION));
    candidates.push(path.join(resources, "yara"));
  }

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(path.join(dir, "vendor", "yara", YARA_CLASSIC_VERSION));
    candidates.push(path.join(dir, "vendor", "yara"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

/**
 * Resolve os dois executáveis oficiais. Devolve `null` quando NÃO há binários:
 * o chamador tem de transformar isso em indisponibilidade explícita.
 */
export function resolveYaraClassicBinaries(env: NodeJS.ProcessEnv = process.env): YaraClassicBinaries | null {
  for (const dir of candidateDirectories(env)) {
    const yara = path.join(dir, WINDOWS_EXECUTABLES.yara);
    const yarac = path.join(dir, WINDOWS_EXECUTABLES.yarac);
    if (isUsableFile(yara) && isUsableFile(yarac)) return { yara, yarac, dir };
  }
  return null;
}

/**
 * Classificação estável de uma linha de diagnóstico do compilador C.
 * O YARA clássico não publica códigos `E0xx`; a categoría é derivada da
 * mensagem e é ESTA que o manifesto do corpus regista.
 */
function classifyDiagnosticCode(severity: "error" | "warning", body: string): YaraClassicDiagnosticCode {
  if (/unknown module|could not find module|module .* not found/i.test(body)) return "unknown-module";
  if (/duplicated identifier|duplicate rule/i.test(body)) return "duplicate-rule";
  if (/unreferenced string/i.test(body)) return "unreferenced-string";
  if (/syntax error|unexpected |unterminated/i.test(body)) return "syntax-error";
  if (/slow down scanning/i.test(body)) return "slow-scan";
  if (/could not open|cannot open|no such file/i.test(body)) return "io-error";
  return severity === "warning" ? "compiler-warning" : "compile-error";
}

/** Lê os diagnósticos de `stdout`+`stderr` do compilador. Nunca lança. */
export function parseYaraDiagnostics(text: string): YaraClassicDiagnostic[] {
  const diagnostics: YaraClassicDiagnostic[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^(warning|error): (.*)$/.exec(rawLine.trim());
    if (!match) continue;
    const severity = match[1] === "warning" ? "warning" : "error";
    const body = match[2].trim();
    const lineMatch = /\((\d+)\)\s*:/.exec(body);
    const line = lineMatch ? Number(lineMatch[1]) : undefined;
    diagnostics.push({
      severity,
      code: classifyDiagnosticCode(severity, body),
      message: body,
      ...(line === undefined ? {} : { line }),
    });
  }
  return diagnostics;
}

function missingBinaryDiagnostic(): YaraClassicDiagnostic {
  return {
    severity: "error",
    code: "io-error",
    message:
      `YARA clássico ${YARA_CLASSIC_VERSION} não encontrado (procurado em ${YARA_BINARY_ENV}, ` +
      `resources/yara e vendor/yara). Sem compilador, nenhuma fonte pode ser aceite.`,
  };
}

export interface YaracRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

function runYarac(binaries: YaraClassicBinaries, rulesFile: string, scratchDir: string): YaracRun {
  const outFile = path.join(scratchDir, "corpus.yarc");
  const result = spawnSync(binaries.yarac, [rulesFile, outFile], {
    encoding: "utf8",
    timeout: YARA_COMPILE_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: MAX_CAPTURED_OUTPUT,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    spawnError: result.error ? String(result.error.message) : undefined,
  };
}

export function diagnosticsFromRun(run: YaracRun): YaraClassicDiagnostic[] {
  const diagnostics = parseYaraDiagnostics(`${run.stdout}\n${run.stderr}`);
  if (run.spawnError) {
    diagnostics.push({ severity: "error", code: "io-error", message: run.spawnError });
    return diagnostics;
  }
  if (run.signal) {
    diagnostics.push({
      severity: "error",
      code: "compile-error",
      message: `compilador terminou por sinal ${run.signal} (prazo do compilador excedido?)`,
    });
    return diagnostics;
  }
  if (run.status !== 0) {
    // Uma falha de LOADER não é uma falha de compilação: o processo não chegou
    // a correr, logo nenhuma regra foi avaliada. Sem esta distinção o manifesto
    // registava "código 3221225781 sem diagnóstico legível" e o utilizador
    // ficava sem saber se o corpus estava errado — não foi avaliado.
    const loaderFailure = classifyWindowsLoaderFailure(run.status);
    if (loaderFailure) {
      diagnostics.push({
        severity: "error",
        code: "io-error",
        message:
          `o compilador ${YARA_CLASSIC_VERSION} não chegou a correr: o loader do Windows recusou o processo com ` +
          `${loaderFailure.name} (0x${loaderFailure.code.toString(16).toUpperCase()}). ${loaderFailure.meaning}. ` +
          `O executável oficial importa ${YARA_CLASSIC_RUNTIME_DEPENDENCY}, que não é componente inbox do Windows. ` +
          `É uma falha de AMBIENTE, não do corpus: nenhuma regra foi avaliada. ` +
          `Qual a DLL em falta neste host só se prova olhando para o host — não se assume daqui.`,
      });
      return diagnostics;
    }
    if (diagnostics.length === 0) {
      diagnostics.push({
        severity: "error",
        code: "compile-error",
        message: `compilador terminou com código ${run.status} sem diagnóstico legível`,
      });
    }
    // Uma linha de diagnóstico "warning" não faz um exit != 0; se acontecer,
    // o exit manda: nunca transformar uma falha em aviso.
    if (!diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      diagnostics.push({
        severity: "error",
        code: "compile-error",
        message: `compilador terminou com código ${run.status} apesar de só ter emitido avisos`,
      });
    }
  }
  return diagnostics;
}

/**
 * Compila um ficheiro de regras JÁ em disco (`include` resolve no directório
 * dele). Devolve SEMPRE os diagnósticos; o chamador decide pelo `severity`.
 */
export function validateYaraFile(
  rulesPath: string,
  options: { binaries?: YaraClassicBinaries | null; scratchDir?: string } = {},
): YaraClassicDiagnostic[] {
  const binaries = options.binaries ?? resolveYaraClassicBinaries();
  if (!binaries) return [missingBinaryDiagnostic()];

  let scratch = options.scratchDir;
  let createdScratch = false;
  if (!scratch) {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-yarac-"));
    createdScratch = true;
  }
  try {
    return diagnosticsFromRun(runYarac(binaries, rulesPath, scratch));
  } finally {
    if (createdScratch) {
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
      } catch {}
    }
  }
}

/**
 * Compila um TEXTO de regras (sem ficheiro de origem). Usado pelo updater:
 * o conteúdo desce da rede e tem de provar que compila ANTES de ser publicado.
 */
export function validateYaraSource(
  content: string,
  options: { binaries?: YaraClassicBinaries | null } = {},
): YaraClassicDiagnostic[] {
  const binaries = options.binaries ?? resolveYaraClassicBinaries();
  if (!binaries) return [missingBinaryDiagnostic()];

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-yarac-src-"));
  try {
    const rulesFile = path.join(scratch, "rules.yar");
    fs.writeFileSync(rulesFile, content, "utf-8");
    return diagnosticsFromRun(runYarac(binaries, rulesFile, scratch));
  } finally {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Metadados por nome de regra, lidos do PRÓPRIO corpus compilado.
 *
 * Porque não `--print-meta`: a linha de saída do `-m` junta meta e alvo na mesma
 * linha (`regra [chave="valor"] alvo`), o que é ambíguo para caminhos com
 * espaços/aspas. Como o corpus é nosso e é o mesmo que é compilado, a tabela
 * sai daqui e o output do scan fica só `regra alvo`.
 */
export function parseRuleMeta(content: string): Map<string, Record<string, unknown>> {
  const table = new Map<string, Record<string, unknown>>();
  const declaration = /^[ \t]*(?:(?:private|global)[ \t]+)*rule[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gm;
  const starts: Array<{ name: string; index: number }> = [];
  for (let match = declaration.exec(content); match !== null; match = declaration.exec(content)) {
    starts.push({ name: match[1], index: match.index });
  }

  for (let i = 0; i < starts.length; i += 1) {
    const block = content.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : content.length);
    const meta = extractMetaSection(block);
    if (Object.keys(meta).length > 0 || !table.has(starts[i].name)) table.set(starts[i].name, meta);
  }
  return table;
}

function extractMetaSection(block: string): Record<string, unknown> {
  // O `meta:` pode viver na MESMA linha do `rule` e do `strings:`
  // (`rule x { meta: k = "v" strings: $a = "y" condition: $a }`), por isso a
  // busca não exige início de linha — medido: exigir `^` perdia o metadado e a
  // classificação de evidência forte caía para genérica.
  const metaStart = /\bmeta[ \t]*:/.exec(block);
  if (!metaStart || metaStart.index === undefined) return {};
  const afterMeta = block.slice(metaStart.index + metaStart[0].length);
  const endMatch = /(?:^|[\s;{}])(?:strings|condition)[ \t]*:/m.exec(afterMeta);
  const section = endMatch ? afterMeta.slice(0, endMatch.index) : afterMeta;

  const meta: Record<string, unknown> = {};
  const stringValue = /([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"/g;
  for (let match = stringValue.exec(section); match !== null; match = stringValue.exec(section)) {
    meta[match[1]] = match[2].replace(/\\(.)/g, "$1");
  }
  const boolValue = /([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(true|false)\b/g;
  for (let match = boolValue.exec(section); match !== null; match = boolValue.exec(section)) {
    meta[match[1]] = match[2] === "true";
  }
  const numberValue = /([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(-?\d+)\b/g;
  for (let match = numberValue.exec(section); match !== null; match = numberValue.exec(section)) {
    meta[match[1]] = Number(match[2]);
  }
  return meta;
}

/** Lê as linhas `regra alvo` do output do scan. Lista vazia ≠ erro (ver exit). */
export function parseYaraScanOutput(
  stdout: string,
  meta?: Map<string, Record<string, unknown>>,
  expectedTarget?: string,
): YaraClassicMatch[] {
  if (stdout !== "" && !stdout.endsWith("\n")) throw new Error("YARA output incompleto; parser recusou a saída.");
  const matches: YaraClassicMatch[] = [];
  const lines = stdout === "" ? [] : stdout.slice(0, -1).split("\n");
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = /^([A-Za-z_][A-Za-z0-9_]*) (.+)$/.exec(line);
    if (!match || (expectedTarget !== undefined && match[2] !== expectedTarget)) {
      throw new Error("YARA output inválido ou alvo inesperado; ficheiro NÃO avaliado.");
    }
    const ruleIdentifier = match[1];
    matches.push({ ruleIdentifier, meta: meta?.get(ruleIdentifier) ?? {} });
  }
  return matches;
}

export interface YaraClassicScannerOptions {
  rulesPath: string;
  binaries: YaraClassicBinaries;
  meta?: Map<string, Record<string, unknown>>;
  timeoutMs?: number;
  /** Teto conjunto stdout + stderr; nunca truncar resultados silenciosamente. */
  maxOutputBytes?: number;
}

export class YaraClassicScanError extends Error {
  constructor(
    readonly code: "timeout" | "cancelled" | "output-limit" | "process-error",
    message: string,
    readonly pid: number | undefined,
    readonly terminationConfirmed: boolean,
  ) {
    super(message);
    this.name = "YaraClassicScanError";
  }
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`YARA ${name} inválido.`);
  return value;
}

/**
 * O diagnóstico que o PRÓPRIO yara escreveu, para colar na excepção.
 *
 * ── Porque é preciso ───────────────────────────────────────────────────────
 * Um exit code 1 não distingue "o yara não conseguiu abrir o alvo" (é o que
 * fazem os antivírus da máquina: negam ao processo filho a leitura de um ficheiro
 * com conteúdo de teste de malware) de "prazo vencido" ou "processo morto". O
 * operador fica com `1` e não pode concluir nada. A mensagem continua a dizer
 * que o ficheiro NÃO foi avaliado — nada disto transforma a falha em limpo.
 *
 * O aparamento é o de `firstDiagnosticLine` (primeira linha não vazia, 400
 * caracteres): `MAX_CAPTURED_OUTPUT` (4 MiB) é o tecto do que se CAPTA do
 * subprocesso, não o que se pode escrever numa excepção. Medido com o corpus
 * vendorizado: um ficheiro de regras com 30 erros escreve 4 811 caracteres.
 */
function yaraDiagnostic(stdout: string | null | undefined, stderr: string | null | undefined): string {
  return firstDiagnosticLine(stdout ?? "", stderr ?? "");
}

/** Um alvo é sempre um ficheiro; diretórios e PIDs não fazem parte deste contrato. */
function checkedTarget(filePath: string): string {
  const target = path.resolve(filePath);
  if (/[\r\n]/.test(target)) throw new Error("YARA alvo com quebra de linha; ficheiro NÃO avaliado.");
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.size > YARA_MAX_TARGET_BYTES) {
    throw new Error("YARA alvo não regular ou demasiado grande; ficheiro NÃO avaliado.");
  }
  return target;
}

export function createYaraClassicScanner(options: YaraClassicScannerOptions): YaraClassicScanner {
  const timeoutMs = positiveLimit(options.timeoutMs ?? YARA_SCAN_TIMEOUT_MS, "prazo");
  const outputLimit = positiveLimit(options.maxOutputBytes ?? MAX_CAPTURED_OUTPUT, "limite de output");
  const rulesPath = path.resolve(options.rulesPath);
  const argsFor = (target: string, deadline: number): string[] => [
    "-w", "-N", "-a", String(Math.max(1, Math.ceil(deadline / 1000))), rulesPath, target,
  ];
  const parseResult = (stdout: string, stderr: string, target: string): YaraClassicMatch[] => {
    if (stderr !== "") {
      const diagnostic = yaraDiagnostic(stdout, stderr);
      throw new Error(
        `YARA stderr não vazio; ficheiro NÃO avaliado${diagnostic ? ` — yara: ${diagnostic}` : ""}.`,
      );
    }
    return parseYaraScanOutput(stdout, options.meta, target);
  };

  function scanBuffer(buffer: Buffer): YaraClassicMatch[] {
    if (buffer.length > YARA_MAX_TARGET_BYTES) throw new Error("YARA buffer demasiado grande; NÃO avaliado.");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-yara-buffer-"));
    const target = path.join(scratch, "target.bin");
    try {
      fs.writeFileSync(target, buffer, { flag: "wx", mode: 0o600 });
      const result = spawnSync(options.binaries.yara, argsFor(target, timeoutMs), {
        encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL",
        windowsHide: true, shell: false, maxBuffer: outputLimit,
      });
      if (result.error || result.signal || result.status !== 0) {
        // Falhou ANTES de qualquer parsing: o resultado não existe e o erro tem
        // de dizer o que o yara escreveu, não apenas o código de saída.
        const diagnostic = yaraDiagnostic(result.stdout, result.stderr);
        throw new Error(
          `YARA scan falhou (prazo/processo/output); ficheiro NÃO avaliado: ` +
            `${result.error?.message ?? result.signal ?? result.status}` +
            (diagnostic ? ` — yara: ${diagnostic}` : ""),
        );
      }
      if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > outputLimit) {
        throw new Error("YARA output excedeu o limite; ficheiro NÃO avaliado.");
      }
      return parseResult(result.stdout, result.stderr, target);
    } finally {
      // Só a pasta criada por esta chamada; nunca seguir junctions nem limpar pais.
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } finally {
        fs.rmdirSync(scratch);
      }
    }
  }

  async function scanFileAsync(
    filePath: string,
    callOptions: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<YaraClassicMatch[]> {
    const deadline = positiveLimit(callOptions.timeoutMs ?? timeoutMs, "prazo");
    if (callOptions.signal?.aborted) {
      throw new YaraClassicScanError("cancelled", "YARA cancelado antes do arranque.", undefined, true);
    }
    let target: string;
    try { target = checkedTarget(filePath); }
    catch (error) { throw new Error("YARA alvo inválido; ficheiro NÃO avaliado.", { cause: error }); }
    return new Promise<YaraClassicMatch[]>((resolve, reject) => {
      const child = spawn(options.binaries.yara, argsFor(target, deadline), {
        windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      let failure: { code: "timeout" | "cancelled" | "output-limit" | "process-error"; message: string } | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        callOptions.signal?.removeEventListener("abort", onAbort);
      };
      const rejectFailure = (confirmed: boolean) => {
        if (settled || !failure) return;
        settled = true;
        cleanup();
        reject(new YaraClassicScanError(failure.code,
          `${failure.message}; ${confirmed ? "fim do subprocesso confirmado" : "morte não confirmada"}; ficheiro NÃO avaliado.`,
          child.pid, confirmed));
      };
      const stop = (code: NonNullable<typeof failure>["code"], message: string) => {
        if (settled || failure) return;
        failure = { code, message };
        // child.killed apenas confirma envio do sinal, nunca a morte.
        killTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          rejectFailure(false);
        }, 1000);
        try { child.kill("SIGKILL"); } catch { /* close ou tolerância decide a confirmação */ }
      };
      const onAbort = () => stop("cancelled", "YARA cancelado pelo chamador");
      const timer = setTimeout(() => stop("timeout", `YARA excedeu o prazo de ${deadline} ms`), deadline);
      callOptions.signal?.addEventListener("abort", onAbort, { once: true });
      if (callOptions.signal?.aborted) onAbort();
      const capture = (chunks: Buffer[]) => (chunk: Buffer) => {
        if (settled || failure) return;
        totalBytes += chunk.length;
        if (totalBytes > outputLimit) { stop("output-limit", "YARA output excedeu o limite"); return; }
        chunks.push(chunk);
      };
      child.stdout.on("data", capture(stdout));
      child.stderr.on("data", capture(stderr));
      child.stdout.on("error", () => stop("process-error", "YARA erro de leitura de stdout"));
      child.stderr.on("error", () => stop("process-error", "YARA erro de leitura de stderr"));
      child.on("error", () => stop("process-error", "YARA erro do subprocesso"));
      child.on("close", (code, signal) => {
        if (settled) return;
        if (failure) { rejectFailure(true); return; }
        settled = true;
        cleanup();
        if (signal || code !== 0) {
          // Mesmo contrato do `scanBuffer`: o `detail` deste desfecho chega ao
          // operador, por isso leva o que o yara escreveu e não só o exit code.
          const diagnostic = yaraDiagnostic(
            Buffer.concat(stdout).toString("utf8"),
            Buffer.concat(stderr).toString("utf8"),
          );
          reject(new YaraClassicScanError(
            "process-error",
            `YARA terminou com erro${diagnostic ? ` — yara: ${diagnostic}` : ""}; ficheiro NÃO avaliado.`,
            child.pid,
            true,
          ));
          return;
        }
        try { resolve(parseResult(Buffer.concat(stdout).toString("utf8"), Buffer.concat(stderr).toString("utf8"), target)); }
        catch (error) { reject(error); }
      });
    });
  }

  return { rulesPath, scan: scanBuffer, scanFileAsync };
}
