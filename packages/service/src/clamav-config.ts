import fs from "node:fs";
import path from "node:path";

/**
 * Config gerida do freshclam.
 *
 * ── O problema medido (nao hipotetizado) ────────────────────────────────────
 * O pacote Chocolatey do ClamAV 1.5.2 nao traz NENHUM `freshclam.conf`. Traz
 * apenas `conf_examples/freshclam.conf.sample`. Medido nesta maquina:
 *
 *   freshclam.exe --version
 *   ERROR: Can't open/parse the config file
 *   C:\ProgramData\chocolatey\lib\clamav\tools\clamav-1.5.2.win.x64\freshclam.conf
 *
 * Repara-se no `--version`: nao descarrega nada e mesmo assim falha. Nao e um
 * problema de rede, de espelho ou de base de dados — e o arranque. O freshclam
 * exige um ficheiro de configuracao e procura-o no directório do executável
 * (e no cwd). Sem ele, nunca chega a ler `--datadir`.
 *
 * ── A decisao ───────────────────────────────────────────────────────────────
 * A config e GERIDA pelo CyberSafe e vive ao lado da base de dados que ela
 * aponta, dentro de `definitionsDir`. Nao escrevemos nada em ProgramData: o
 * pacote Chocolatey e global, partilhado, e uma escrita la seria contestada
 * pela proxima actualizacao do pacote e exigiria admin.
 *
 * NOTA DE IDENTIDADE: o servico corre como SYSTEM (ver windows-service.ts:5), e
 * nesse caso `os.homedir()` NAO e o `%USERPROFILE%` do utilizador com sessao —
 * e o perfil do SYSTEM. Por isso este modulo nunca escreve `%USERPROFILE%` na
 * mao: usa sempre o `definitionsDir` que o servico ja calcula. Assim o caminho
 * e correcto em qualquer uma das identidades.
 */

/** Espelho oficial por defeito. CDN publico mantido pela Cisco Talos. */
export const DEFAULT_DATABASE_MIRROR = "database.clamav.net";

/** Nome do ficheiro. O freshclam procura exactamente este nome por omissao. */
export const FRESHCLAM_CONFIG_FILENAME = "freshclam.conf";

export interface FreshclamConfigOptions {
  /** Directorio onde a base de dados vive. TEM de existir e ser escrevivel. */
  databaseDirectory: string;
  /** Espelho a usar. Omitir usa o oficial. */
  databaseMirror?: string;
  /**
   * Tentativas por descarga. O default do freshclam e 5; bajamos porque este
   * update corre periodicamente e nao vale a pena passar 2 min a insistir num
   * espelho em baixo.
   */
  maxAttempts?: number;
  maxRetry?: number;
}

export interface FreshclamCommandOptions extends FreshclamConfigOptions {
  /** Path completo do `freshclam.conf` gerido. */
  configFile: string;
  /**
   * Diagnostico: NAO passa `--quiet`, para o freshclam escrever o erro real em
   * stderr. Em silencio, o servico so via "exit code 2" e nao se sabe porquê.
   */
  diagnostic?: boolean;
}

/**
 * Valida um valor que vai para o ficheiro de configuracao.
 *
 * NORMALIZAR CR/LF PARA ESPACO ERA UM BUG DE SEGURANCA. O ClamAV 1.5.2 aceita
 * `OnUpdateExecute` / `OnErrorExecute`, que sao hooks executados via system().
 * Um `databaseDirectory` com CR/LF permitiria injecar uma directiva nova a
 * partir de um valor, e o freshclam corre o servico como SYSTEM. Nao se corrige
 * o valor: REJEITA-SE. Um path de directorio nao tem CR/LF; se tem, ha algo
 * errado a montante e o certo e falhar visivelmente, nao silenciar.
 */
function assertNoControlChars(label: string, value: string): void {
  // eslint-disable-next-line no-control-regex
  const control = /[\u0000-\u001F\u007F]/.exec(value);
  if (control) {
    throw new Error(
      `buildFreshclamConfig: ${label} tem caracteres de controlo (0x${control[0].charCodeAt(0).toString(16).padStart(2, "0")}). ` +
        "Isto seria injeccao de directivas no ficheiro de configuracao; rejeitado.",
    );
  }
}

function escapeConfigValue(value: string): string {
  // Ja validado por assertNoControlChars(): nao ha CR/LF/controlos a normalizar.
  // Aqui so se apara o espaco nas pontas, que e inofensivo.
  return value.trim();
}

/**
 * Constroi o conteudo do `freshclam.conf`.
 *
 * Deliberadamente MINIMO. Cada directiva a mais e uma coisa que pode divergir do
 * que o runtime real espera, e o objectivo e que isto funcione, nao ser completo.
 */
export function buildFreshclamConfig(options: FreshclamConfigOptions): string {
  // ANTES de qualquer tratamento: um CR/LF aqui seria injecao de directivas.
  assertNoControlChars("databaseDirectory", options.databaseDirectory ?? "");
  assertNoControlChars("databaseMirror", options.databaseMirror ?? "");

  const dir = escapeConfigValue(options.databaseDirectory);
  const mirror = escapeConfigValue(options.databaseMirror || DEFAULT_DATABASE_MIRROR);
  const attempts = options.maxAttempts ?? 3;

  if (!dir) throw new Error("buildFreshclamConfig: databaseDirectory obrigatorio e vazio");
  if (!path.isAbsolute(dir)) {
    throw new Error(
      `buildFreshclamConfig: databaseDirectory tem de ser absoluto (o freshclam exige-o): "${dir}"`,
    );
  }

  return [
    "# Gerado pelo CyberSafe Assistant. NAO EDITAR A MAO — e reescrito a cada update.",
    "#",
    "# Existe porque o pacote ClamAV (Chocolatey) nao traz um freshclam.conf,",
    "# so um conf_examples/freshclam.conf.sample, e o freshclam aborta no",
    "# arranque sem configuracao. Este ficheiro e a configuracao do CyberSafe.",
    "",
    "# Base de dados do CyberSafe. Absoluta, tem de existir e ser escrevivel.",
    `# DatabaseDirectory aponta para ${dir}`,
    `DatabaseDirectory ${dir}`,
    "",
    `# Espelho oficial (CDN publico mantido pela Cisco Talos).`,
    `DatabaseMirror ${mirror}`,
    "",
    "# Nao exceder tentativas: este update corre de 6 em 6 horas e nao vale a pena",
    "# passar dois minutos a insistir num espelho em baixo.",
    // `MaxRetry` foi REMOVIDO em 2026-10-02. Nao existe no freshclam: a
    // directiva que limita o numero de tentativas chama-se `MaxAttempts` e e a
    // unica. O binario abortava com
    //   Parse error at freshclam.conf:17: Unknown option MaxRetry
    // e NAO descarregava base nenhuma — o ClamAV ficava degradado para sempre,
    // porque o produto reescrevia o mesmo ficheiro invalido a cada update.
    // Fonte autoritativa: conf_examples/freshclam.conf.sample do proprio
    // ClamAV 1.5.2 documenta `MaxAttempts 5` e nao menciona qualquer Retry.
    // Regra daqui para fora: so escrever directivas que o .sample documenta.
    // Ver test/clamav-config.test.js, que valida contra o .sample real.
    `MaxAttempts ${attempts}`,
    "",
    "# Foreground: nao fazer daemon, para stdout/stderr irem para o pipe do",
    "# servico e o erro real chegar ao log em vez de desaparecer.",
    "Foreground true",
    "",
    "# NotifyClamd NAO e usado de proposito: o CyberSafe nao corre um clamd",
    "# daemon, chama o clamscan por bridge. Notificar um socket inexistente",
    "# seria um erro novo e tambem precisaria de admin para o socket local.",
    "",
    "# (Sem `Example`: essa directiva e o que impede o .sample de arrancar.)",
    "",
  ].join("\n");
}

/**
 * Argumentos do comando. `--config-file` explicito e obrigatorio: sem ele o
 * freshclam procura a config onde lhe apetece e falha.
 */
export function buildFreshclamArgs(options: FreshclamCommandOptions): string[] {
  if (!options.configFile) throw new Error("buildFreshclamArgs: configFile obrigatorio");
  if (!path.isAbsolute(options.configFile)) {
    throw new Error(`buildFreshclamArgs: configFile tem de ser absoluto: "${options.configFile}"`);
  }
  const args: string[] = [];
  if (!options.diagnostic) args.push("--quiet");
  args.push(`--config-file=${options.configFile}`);
  // Redundante com o DatabaseDirectory do ficheiro, e de proposito: se o
  // ficheiro for substituido por outro, o CLI continua a fixar o directorio
  // do CyberSafe e a base nunca fca orfa.
  args.push(`--datadir=${options.databaseDirectory}`);
  return args;
}

export interface EnsureConfigResult {
  configFile: string;
  /** false quando ja existia e estava correcto — nao se reescreveu nada. */
  written: boolean;
  reason: "criado" | "ja-existe" | "corrigido" | "invalido";
}

/**
 * Garante que existe uma config gerida, e que e INTEIRAMENTE a que geramos.
 *
 * ── P1 DE SEGURANCA (Codex review, NO-GO) ────────────────────────────────────
 * A versao anterior aceitava o ficheiro se (a) tivesse a linha
 * `DatabaseDirectory` esperada e (b) nao tivesse `Example`. Isso e insuficiente:
 * o ClamAV 1.5.2 aceita `OnUpdateExecute` / `OnErrorExecute`, hooks executados
 * via system(). Um ficheiro adulterado com a linha certa E um
 * `OnUpdateExecute /c whoami` sobrevivia com `written: false` — e o freshclam
 * corre-o, **como SYSTEM**.
 *
 * Por isso a regra agora e a mais estrita possivel e a unica defensavel: o
 * conteudo tem de ser IGUAL ao gerado, byte a byte. Qualquer divergencia
 * (comentario acrescentado, directiva nova, linha trocada, `Example` colado,
 * CRLF em vez de LF) reescreve o ficheiro inteiro.
 *
 * Nao se preserva nada do que esta no disco. O ficheiro e do CyberSafe, nao do
 * utilizador: nao ha customizacao legitima a proteger.
 *
 * Reescrever nao e caro (7 KB) e acontece uma vez por update, so quando algo
 * diverge. `ja-existe` continua a ser o caminho normal, byte-identico.
 */
export function ensureFreshclamConfig(
  configFile: string,
  options: FreshclamConfigOptions,
): EnsureConfigResult {
  // Lanca em qualquer valor com CR/LF/controlos, ANTES de tocar no disco.
  const expected = buildFreshclamConfig(options);

  if (!path.isAbsolute(configFile)) {
    throw new Error(`ensureFreshclamConfig: configFile tem de ser absoluto: "${configFile}"`);
  }
  // O directorio TEM de existir antes do arranque do freshclam: a directiva
  // DatabaseDirectory exige que ja exista.
  fs.mkdirSync(options.databaseDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(configFile), { recursive: true });

  let current: string | null = null;
  try {
    current = fs.readFileSync(configFile, "utf8");
  } catch {
    current = null;
  }

  if (current === null) {
    fs.writeFileSync(configFile, expected, "utf8");
    return { configFile, written: true, reason: "criado" };
  }

  // Igualdade integral. Sem excecoes.
  if (current === expected) {
    return { configFile, written: false, reason: "ja-existe" };
  }

  fs.writeFileSync(configFile, expected, "utf8");
  // `corrigido` SO quando a unica divergencia e o DatabaseDirectory (o perfil
  // mudou). Uma linha a mais, uma a menos, uma trocada, um comentario novo
  // ou CRLF sao um ficheiro que nao reconhecemos => `invalido`.
  const activeLines = (text: string) =>
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      // Qualquer linha DatabaseDirectory e ignorada, nao so a esperada: o que
      // se compara e o resto do ficheiro, para que "o perfil mudou" seja a
      // UNICA divergencia aceite.
      .filter((l) => l && !l.startsWith("#") && !/^DatabaseDirectory\b/i.test(l));
  const semDir = (text: string) => activeLines(text).slice().sort().join("\n");
  const soMudouODiretorio = semDir(current) === semDir(expected);

  return { configFile, written: true, reason: soMudouODiretorio ? "corrigido" : "invalido" };
}

/** Apanha a config de dentro de um stderr e explica, em vez de devolver o bruto. */
export function explainFreshclamError(stderr: string, configFile: string): string {
  const text = (stderr || "").trim();
  if (/can't open\/parse the config file|cannot open\/parse/i.test(text)) {
    return (
      `O freshclam nao leu a configuracao em "${configFile}". ` +
      "A config gerida pelo CyberSafe devia estar la; se ela existe, o ficheiro " +
      "esta corrompido ou a path mudou."
    );
  }
  if (/can't open the config file|unable to open/i.test(text)) {
    return `O freshclam nao encontrou a configuracao em "${configFile}".`;
  }
  if (/could not resolve host|dns|temporary failure in name resolution/i.test(text)) {
    return (
      "O freshclam falhou a resolver o espelho. Isto e REDE, nao configuracao: " +
      "sem ligacao nao ha como actualizar a base."
    );
  }
  if (/database directory.*(not exist|does not exist)/i.test(text)) {
    return "O directorio de base de dados indicado na config nao existe ou nao e escrevivel.";
  }
  return text || "(sem detalhe em stderr)";
}
