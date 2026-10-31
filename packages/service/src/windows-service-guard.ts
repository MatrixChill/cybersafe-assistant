/**
 * Identidade e posse do serviço Windows (node-windows).
 *
 * O SCM NÃO usa o DisplayName como chave: node-windows deriva
 * `id = name.replace(/[^\w]/gi, "").toLowerCase()` e cria
 * `<scriptDir>/daemon/<id>.exe` + `<scriptDir>/daemon/<id>.xml`.
 * Para "CyberSafe Engine" isso é `cybersafeengine` e
 * `.../daemon/cybersafeengine.exe` — exactamente a forma do registo órfão
 * observado (árvore de Downloads já inexistente). Consultar pelo DisplayName
 * ("CyberSafe Engine") falhava e o `catch` anterior mascarava o erro como
 * "ausente".
 *
 * Estas funções são puras: não consultam o SCM, não instalam nem removem nada.
 * O query é classificado como absent/present/error; erro NUNCA é ausência.
 */
import path from "node:path";

export const WINDOWS_SERVICE_NAME = "CyberSafe Engine";
export const DAEMON_DIR = "daemon";

export function serviceIdForName(name: string): string {
  return name.replace(/[^\w]/gi, "").toLowerCase();
}

export const WINDOWS_SERVICE_ID = serviceIdForName(WINDOWS_SERVICE_NAME);

/** Wrapper real criado por node-windows para um dado script. */
export function wrapperExecutableFor(scriptPath: string, name: string = WINDOWS_SERVICE_NAME): string {
  return path.join(path.dirname(scriptPath), DAEMON_DIR, `${serviceIdForName(name)}.exe`);
}

export function wrapperConfigFor(scriptPath: string, name: string = WINDOWS_SERVICE_NAME): string {
  return path.join(path.dirname(scriptPath), DAEMON_DIR, `${serviceIdForName(name)}.xml`);
}

export type ServiceQuery =
  | { state: "absent" }
  | { state: "present"; commandLine: string }
  | { state: "error"; detail: string };

export type ServiceDecision = { ok: true } | { ok: false; reason: string };

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * ImagePath é uma command line, não um caminho puro: quotes, argumentos,
 * `%SystemRoot%` e escapes de `"` têm de ser interpretados.
 */
export function parseWindowsCommandLine(
  commandLine: string,
  env: NodeJS.ProcessEnv = process.env,
): { executable: string | null; args: string[] } {
  const expanded = commandLine.replace(/%([^%]+)%/g, (whole, key: string) => {
    const value = env[key] ?? env[key.toUpperCase()] ?? env[key.toLowerCase()];
    return typeof value === "string" ? value : whole;
  });
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let inQuotes = false;
  let i = 0;
  while (i < expanded.length) {
    const ch = expanded[i];
    if (ch === "\\") {
      let slashes = 0;
      while (i < expanded.length && expanded[i] === "\\") {
        slashes += 1;
        i += 1;
      }
      if (i < expanded.length && expanded[i] === '"') {
        current += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) {
          current += '"';
        } else {
          inQuotes = !inQuotes;
        }
        i += 1;
      } else {
        current += "\\".repeat(slashes);
      }
      hasToken = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
      i += 1;
      continue;
    }
    if (!inQuotes && (ch === " " || ch === "\t")) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      i += 1;
      continue;
    }
    current += ch;
    hasToken = true;
    i += 1;
  }
  if (hasToken) tokens.push(current);
  return { executable: tokens[0] ?? null, args: tokens.slice(1) };
}

/**
 * Classifica a saída de `reg query`. Código != 0 só é "absent" quando a
 * mensagem é explicitamente de chave/valor inexistente; acesso negado e
 * qualquer outro erro são `error` (fail-closed).
 */
export function classifyRegQuery(result: { exitCode: number | null; stdout: string; stderr: string }): ServiceQuery {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.exitCode === 0) {
    const match = stdout.match(/ImagePath\s+REG_[A-Z_]+\s+(.+)/i);
    return match
      ? { state: "present", commandLine: match[1].trim() }
      : { state: "error", detail: "reg query devolveu 0 sem ImagePath" };
  }
  if (
    /(não é possível encontrar|nao e possivel encontrar|não foi possível encontrar|nao foi possivel encontrar|não conseguiu localizar|nao conseguiu localizar|não foi encontrado|unable to find|the system cannot find)/i.test(
      stderr,
    )
  ) {
    return { state: "absent" };
  }
  const line = stderr.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "reg query falhou";
  return { state: "error", detail: line.slice(0, 160) };
}

/** Instalação: ausência é ok; erro falha; presença exige o wrapper exacto. */
export function decideInstall(input: {
  platform: NodeJS.Platform;
  scriptPath: string;
  query: ServiceQuery;
  name?: string;
}): ServiceDecision {
  if (input.platform !== "win32") return { ok: false, reason: "serviço Windows só existe em win32" };
  if (!path.isAbsolute(input.scriptPath)) return { ok: false, reason: "script tem de ser absoluto" };
  if (path.extname(input.scriptPath).toLowerCase() === ".ts") {
    return { ok: false, reason: "entry point TypeScript não é um serviço válido" };
  }
  if (input.query.state === "error") {
    return { ok: false, reason: `consulta ao serviço falhou: ${input.query.detail}` };
  }
  if (input.query.state === "absent") return { ok: true };
  const parsed = parseWindowsCommandLine(input.query.commandLine);
  if (!parsed.executable) return { ok: false, reason: "ImagePath sem executável" };
  const expected = wrapperExecutableFor(input.scriptPath, input.name);
  if (normalize(parsed.executable) !== normalize(expected)) {
    return { ok: false, reason: "serviço com o mesmo id aponta para outro wrapper" };
  }
  return { ok: true };
}

/** Desinstalação: só o wrapper exacto desta instalação; erro falha. */
export function decideUninstall(input: {
  platform: NodeJS.Platform;
  scriptPath: string;
  query: ServiceQuery;
  name?: string;
}): ServiceDecision & { alreadyAbsent?: boolean } {
  if (input.platform !== "win32") return { ok: false, reason: "serviço Windows só existe em win32" };
  if (!path.isAbsolute(input.scriptPath)) return { ok: false, reason: "script tem de ser absoluto" };
  if (input.query.state === "error") {
    return { ok: false, reason: `consulta ao serviço falhou: ${input.query.detail}` };
  }
  if (input.query.state === "absent") return { ok: true, alreadyAbsent: true };
  const parsed = parseWindowsCommandLine(input.query.commandLine);
  if (!parsed.executable) return { ok: false, reason: "ImagePath sem executável: posse não provada" };
  const expected = wrapperExecutableFor(input.scriptPath, input.name);
  if (normalize(parsed.executable) !== normalize(expected)) {
    return { ok: false, reason: "serviço não pertence a esta instalação" };
  }
  return { ok: true };
}

/**
 * O CLI é legado e não é usado pelo NSIS nem pelo produto empacotado (que corre
 * o serviço como processo filho). Mutações ficam explicitamente desactivadas:
 * só diagnóstico, sem fingir uma instalação suportada.
 */
export function legacyMutationPolicy(): { allowed: false; reason: string } {
  return {
    allowed: false,
    reason:
      "CLI legacy fora do NSIS: instalar/desinstalar serviços está desactivado; use apenas status/diagnóstico",
  };
}
