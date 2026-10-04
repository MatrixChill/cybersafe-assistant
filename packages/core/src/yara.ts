import { fromFile, compile, type YaraX, type RuleMatch } from "@litko/yara-x";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { EngineSubsystemHealth } from "@cybersafe/shared-types";

export interface YaraMatch {
  ruleId: string;
  label: string;
  severity: "high" | "critical";
  evidence: "generic" | "strong";
}

function classifyMatch(match: RuleMatch): YaraMatch {
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
 * de YARA rules legitimately chega sem marker e sem uma única regra de malware:
 * é o caso de `MALW_Eicar.yar`, a primeira entrada de `YARA_SOURCES`. O
 * marker não a apanha, e o corpus era apresentado como cobertura normal com uma
 * regra que só deteta o ficheiro de teste do EICAR.
 *
 * LIMITES, declarados: isto é uma lista de assinaturas de teste *conhecidas*.
 * Um corpus só-teste com nomes que não reconhecemos continua a ser lido como
 * `normal`. É o mesmo risco do marker, mais estreito — e o `detail` que
 * acompanha o estado leva sempre a contagem de regras, para que o número não
 * possa ser confundido com cobertura.
 */
const TEST_SIGNATURE = /eicar|canary|test[_\s-]?(file|signature|rule)/i;


export class YaraEngine {
  private scanner: YaraX | null = null;
  private rulesPath: string;
  private _health: EngineSubsystemHealth = {
    status: "unavailable",
    detail: "Not initialized",
    // Sem corpus carregado, a cobertura não foi medida. `unknown` é a única
    // resposta honesta: afirmar "limited" seria afirmar que medimos pouco.
    coverage: "unknown",
  };
  private _ruleCount = 0;

  constructor(rulesPath?: string) {
    this.rulesPath = rulesPath || path.join(process.cwd(), "definitions", "yara", "default.yar");
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

  async load(filePath: string) {
    this.rulesPath = filePath;
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
        } else if (content.includes("rule ")) {
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
          // A assimetria é deliberada: um marker presente é motivo para
          // desconfiar e ficar degradado; um marker ausente em conteúdo que
          // compila é motivo para confiar. O custo de errar no primeiro
          // sentido é mostrar "degradado" quando há corpus real — e o
          // detalhe diz isso, com o número de regras. O custo de errar no
          // segundo é o que aconteceu antes: o canário apresentado como
          // corpus de produção, com a deteção de malware declarada activa e
          // desligada ao mesmo tempo.
          //
          // Se o conteúdo com marker não compilar, o caminho de recuperação
          // abaixo reescreve-o com as FALLBACK_RULES canónicas, que são a
          // única coisa que sabemos garantir que compilam.
          if (content.includes(FALLBACK_MARKER)) {
            ruleSource = "fallback";
            ruleContent = content;
          } else {
            ruleSource = "file";
            ruleContent = content;
          }
        } else {
          shouldWriteFallback = true;
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
      this._health = { status: "error", detail: "No rules content available", coverage: "unknown" };
      this.scanner = null;
      return;
    }

    const buildScanner = (): any => {
      // 1. Tenta fromFile (o nativo lê diretamente o ficheiro).
      try {
        return { scanner: fromFile(this.rulesPath), viaCompile: false };
      } catch (fileErr: any) {
        // 2. Fallback: compile a partir do conteúdo lido via Node fs (contorna
        //    problemas de leitura de path nativo, ex.: dentro de ASAR).
        try {
          // Narrowing explícito: ruleContent é `string | null` porque só é
          // atribuído nos ramos que escrevem em disco. Se chegasse aqui sem
          // conteúdo, compilar `null` seria uma falha de tipo disfarçada de
          // corpus ilegível.
          const source = ruleContent ?? FALLBACK_RULES;
          return { scanner: compile(source), viaCompile: true, fileErr };
        } catch (compileErr: any) {
          const err: any = new Error(compileErr?.message ?? String(compileErr));
          err.fileErr = fileErr;
          throw err;
        }
      }
    };

    try {
      const built = buildScanner();
      this.scanner = built.scanner;
      if (built.viaCompile) {
        console.warn("[YARA] fromFile falhou; scanner criado via compile(string).", built.fileErr?.message);
      }
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
          detail: `YARA-X load failed: ${loadErr?.message ?? "unknown"}`,
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
          this.scanner = compile(FALLBACK_RULES);
        } catch (canonicalErr: any) {
          // Aqui sim é o nosso defeito: a constante não compila.
          console.error("[YARA] Erro fatal ao carregar YARA-X:", canonicalErr?.message ?? canonicalErr);
          this.scanner = null;
          this._health = {
            status: "error",
            detail: `YARA-X load failed: ${canonicalErr?.message ?? "unknown"}`,
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
          this.scanner = compile(FALLBACK_RULES);
        } catch (fallbackErr: any) {
          console.error("[YARA] Erro fatal ao carregar YARA-X:", fallbackErr?.message ?? fallbackErr);
          this.scanner = null;
          this._health = {
            status: "error",
            detail: `YARA-X load failed: ${fallbackErr?.message ?? "unknown"}`,
            coverage: "unknown",
          };
          return;
        }
      }
    }

    this._ruleCount = await this.countRules(this.rulesPath);
    const coverage = await this.classifyCoverage(ruleSource);
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
    } else {
      this._health = {
        status: "active",
        detail: `Loaded ${this._ruleCount} rule(s) from file`,
        // `normal` é a afirmação forte e só é alcançada aqui: o corpus não tem
        // o marker do canário, COMPILOU (a compilação correu acima e não caiu
        // para o fallback) e tem pelo menos uma regra que não é material de
        // teste. É evidência medida, não presunção.
        coverage: "normal",
      };
    }
    console.log(`[YARA] Scanner carregado (${ruleSource}). Regras: ${this._ruleCount}`);
  }

  /**
   * `limited` quando o corpus não sustenta a afirmação forte de cobertura:
   * vem do canário, ou não tem regra de deteção nenhuma, ou só tem assinaturas
   * de teste. O resto é `normal`.
   */
  private async classifyCoverage(ruleSource: "file" | "fallback" | null): Promise<"normal" | "limited"> {
    if (ruleSource === "fallback") return "limited";

    let content: string;
    try {
      content = await fs.readFile(this.rulesPath, "utf-8");
    } catch {
      return "normal";
    }

    // `split` deixa um primeiro elemento (tudo o que precede a 1ª regra) que
    // não é uma regra: `slice(1)` alinha os blocos com os identificadores.
    const identificadores = [...content.matchAll(/^rule\s+(\w+)/gm)].map((m) => m[1]);
    if (identificadores.length < 2) return "limited";

    const blocos = content.split(/^rule\s+\w+/gm).slice(1);
    const algumaDetetaMalware = blocos.some((bloco, i) => {
      const identificador = identificadores[i] ?? "";
      const descricao = /description\s*=\s*"([^"]*)"/i.exec(bloco)?.[1] ?? "";
      // O identificador sozinho não basta: a assinatura de teste da fonte
      // publica chama-se `eicar` mas descreve-se como deteção de malware. E a
      // descrição sozinha também não: o nosso canário diz "not production
      // detection" no mesmo campo onde o EICAR diz "detect Eicar pattern".
      return !TEST_SIGNATURE.test(identificador) && !TEST_SIGNATURE.test(descricao);
    });

    return algumaDetetaMalware ? "normal" : "limited";
  }

  private async countRules(filePath: string): Promise<number> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const matches = content.match(/^rule\s+\w+/gm);
      return matches ? matches.length : 0;
    } catch {
      return 0;
    }
  }

  match(buffer: Buffer): YaraMatch[] {
    if (!this.scanner) return [];

    try {
      const results = this.scanner.scan(buffer);
      return results.map(classifyMatch);
    } catch (error) {
      console.error("[YARA] Erro no scan de buffer:", error);
      return [];
    }
  }

  async scanFile(filePath: string): Promise<YaraMatch[]> {
    if (!this.scanner) {
      await this.ensureRules();
    }
    if (!this.scanner) return [];

    try {
      const matches = await this.scanner.scanFileAsync(filePath);
      return matches.map(classifyMatch);
    } catch (error) {
      console.error(`[YARA] Falha no scan do arquivo ${filePath}:`, error);
      return [];
    }
  }
}
