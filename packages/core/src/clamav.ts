import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import * as path from "node:path";
import * as os from "node:os";
import { promisify } from "node:util";
import type { EngineSubsystemHealth } from "@cybersafe/shared-types";

/**
 * `exec` com STRING passa por `/bin/sh` (ou `cmd.exe`). `where clamscan` e
 * `clamscan --version` não têm nada de perigoso, mas a versão com SHELHAZO não
 * nos dá nada: o `execFile` com array é o mesmo mecanismo sem shell, e é o que o
 * resto da bridge já usa para os argumentos de scan.
 */
const execFileAsync = promisify(execFile);

export interface ClamavScanResult {
  detected: boolean;
  status: EngineSubsystemHealth;
  /**
   * O que o ClamAV disse SOBRE ESTE FICHEIRO. `error` não é `clean`
   * disfarçado: é "não foi possível concluir".
   */
  verdict?: ClamavVerdict;
  signature?: string;
  reason?: ClamavErrorReason;
  removedDuringScan?: boolean;
  detail?: string;
}

/**
 * O que o ClamAV diz sobre UM ficheiro.
 *
 * `error` é um estado de primeira classe e não um `clean` disfarçado. A razão
 * é medida, não teórica: quando o Windows Defender apaga o ficheiro no
 * instante em que o clamscan o abre, o clamscan devolve exit 2, `Scanned
 * files: 0`, e o CyberSafe reportava "não detectado" sobre um ficheiro que
 * nunca chegou a ser lido. Um veredicto sem exame é pior do que nenhum
 * veredicto.
 */
export type ClamavVerdict = "detected" | "clean" | "error";

/** Motivo legível por máquina. Nunca inclui uma atribuição sem evidência. */
export type ClamavErrorReason =
  | "database-unavailable"
  | "file-removed-during-scan"
  | "file-unreadable"
  | "detection-unattributed"
  | "inconsistent-exit"
  | "timeout"
  | "aborted"
  | "limits-exceeded"
  | "engine-missing"
  | "exit-0-with-errors"
  | "exit-unknown"
  | `exit-${number}`;

export interface ClamavFileOutcome {
  /** O caminho que pedimos, não o que o clamscan imprimiu. */
  file: string;
  verdict: ClamavVerdict;
  /** A assinatura nomeada na linha FOUND. Só quando `verdict === "detected"`. */
  signature?: string;
  reason?: ClamavErrorReason;
  /** Detalhe legível, PT-PT, sem atribuir a remoção a ninguém. */
  detail?: string;
  /**
   * O ficheiro já não existia quando o Terminámos. É um facto, não uma
   * hipótese sobre quem o removeu.
   */
  removedDuringScan?: boolean;
  exitCode?: number | null;
}

export interface ClamavBatchOutcome {
  /** Um resultado por ficheiro pedido, pela mesma ordem. */
  files: ClamavFileOutcome[];
  /** `true` se pelo menos um ficheiro foi detectado. */
  detected: boolean;
  errorCount: number;
  status: EngineSubsystemHealth;
}

export interface ClamavParseInput {
  /** Os ficheiros que pedimos, pela ordem em que os pedimos. */
  files: string[];
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut?: boolean;
  killed?: boolean;
  /** O ficheiro ainda existe? Chamado só quando é preciso distinguir. */
  fileExists?: (file: string) => boolean;
}

/**
 * Base de assinaturas que o clamscan não conseguiu carregar.
 *
 * A lista é-wide de propósito: o mesmo defeito chega com nomes diferentes
 * conforme a fase — `cl_load` (abrir), `cli_cvdparse` (parsear um .cvd
 * corrompido), `cli_loadhash`, `cl_caserc` (bytecode). E há ainda a regra
 * abaixo, que não depende do nome da mensagem.
 */
const DB_LOAD_FAILURE =
  /cl_load|cli_cvdparse|cli_loadhash|cl_caserc|can'?t load|unable to load|cannot load|can'?t initialize the database|no supported database files/i;
/** "Can't open file X" / "Can't access file X" — o clamscan não leu o ficheiro. */
const UNREADABLE = /can't (?:open|access) file\s+(.*)$/i;
/**
 * O ClamAV não chegou a avaliar o ficheiro por exceder os seus limites
 * internos (tamanho/entropia/contagem). Não é uma deteção: é uma lacuna.
 */
const CLAMAV_LIMITS_EXCEEDED = /^Heuristics\.Limits\.Exceeded\b/i;

/**
 * Separa `caminho: resto` pelo ÚLTIMO ": ".
 *
 * Uma regex com captura preguiçosa parte o path no `C:` do Windows e atribui a
 * deteção ao ficheiro errado — que é pior do que não atribuir. O separador
 * real do clamscan é ": " (dois pontos seguidos de espaço), e o "C:" nunca é
 * seguido de espaço.
 */
function splitOnLastColonSpace(line: string): { target: string; rest: string } | null {
  const sep = line.lastIndexOf(": ");
  if (sep <= 0) return null;
  return { target: line.slice(0, sep).trim(), rest: line.slice(sep + 2).trim() };
}

function firstLineOf(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
}

/**
 * Chave de comparação de caminhos. O clamscan imprime o caminho tal como lhe
 * foi dado, mas no Windows a barras e as maiúsculas variam — e um parser que
 * só casa por igualdade exacta atribui a detecção ao ficheiro errado, que é
 * pior do que não attributir.
 */
function pathKey(file: string): string {
  return file.replace(/\//g, "\\").replace(/^\\+/, "").toLowerCase();
}

function baseName(file: string): string {
  const parts = file.replace(/\//g, "\\").split("\\");
  return (parts[parts.length - 1] ?? file).toLowerCase();
}

/**
 * Deriva o veredicto a partir do OUTPUT, não do exit code.
 *
 * O exit code sozinho foi o defeito: `code === 2` significava "não conseguiu
 * carregar a base", e isso era falso num caso medido em que a base tinha
 * carregado 3 628 114 virus e o erro era um ficheiro que o Defender já tinha
 * removido. O exit code é UM sinal, e é o mais fraco deles.
 *
 * Ordem das regras (a primeira que casa ganha):
 *  1. linha `FOUND` no stdout  => detected, sempre, mesmo com erros
 *  2. `cl_load` no stderr      => todos error, e a mensagem é sobre a base
 *  3. `Can't open file X`      => esse ficheiro é error (removido ou ilegível)
 *  4. `Infected files > 0`     => deteção que não conseguimos atribuir: error
 *  5. timeout / abort          => error
 *  6. exit 0                   => clean
 *  7. qualquer outro exit      => error
 */
export function parseClamavOutput(input: ClamavParseInput): ClamavBatchOutcome {
  const { files, stdout = "", stderr = "", code = null } = input;
  const exists = input.fileExists ?? (() => true);

  // 1. Deteções: "C:\caminho\ficheiro.txt: Eicar-Signature FOUND"
  const foundByPath = new Map<string, string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const split = splitOnLastColonSpace(rawLine.trim());
    if (!split) continue;
    const signature = /^(.+?)\s+FOUND$/i.exec(split.rest);
    if (!signature) continue;
    foundByPath.set(pathKey(split.target), signature[1].trim());
  }
  // Linhas `<path>: OK` e `<path>: Empty file` — o clamscan nomeia cada
  // ficheiro que varreu e não encontrou nada. Isto NÃO é o mesmo que "não foi
  // nomeado": é evidência positiva, por ficheiro, de que a análise acabou. Sem
  // isto, um batch em que o clamscan nomeia 4 dos 5 ficheiros trataria os 4
  // nomeados como se também não tivessem sido avaliados (e o inverso: daria
  // `clean` a quem não foi nomeado só porque o resumo não falou em erros).
  //
  // MEDIDO 2026-10-16 (instalação real, pasta com um ficheiro vazio): o
  // clamscan imprime `<path>: Empty file` e NÃO conta o ficheiro em
  // `Scanned files` — sem o aceitar aqui, a aritmética de cobertura falhava e
  // o único ficheiro sem `: OK` era classificado `inconsistent-exit`,
  // degradando o motor por um lote que correu bem. Um ficheiro vazio foi
  // avaliado: não há nada a ler.
  const scannedByPath = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const split = splitOnLastColonSpace(rawLine.trim());
    if (!split) continue;
    if (/^(?:OK|Empty file)$/i.test(split.rest.trim())) scannedByPath.add(pathKey(split.target));
  }

  // Índice basename -> ficheiros PEDIDOS com esse nome. O basename só pode
  // servir de chave se for INÍVOCO DO LADO DOS PEDIDOS; caso contrário
  // `C:\a\instalador.exe` e `C:\b\instalador.exe` seriam o mesmo ficheiro
  // (Codex F4).
  const requestedByBase = new Map<string, string[]>();
  for (const f of files) {
    const key = baseName(f);
    const seen = requestedByBase.get(key);
    if (seen) seen.push(f);
    else requestedByBase.set(key, [f]);
  }
  const unambiguousBase = (file: string): string | undefined => {
    const wanted = baseName(file);
    return (requestedByBase.get(wanted)?.length ?? 0) === 1 ? wanted : undefined;
  };

  const signatureFor = (file: string): string | undefined => {
    const direct = foundByPath.get(pathKey(file));
    if (direct) return direct;
    // Segundo intento: só pelo nome, quando o clamscan imprimiu um caminho
    // relativo ou com normalização diferente. Só quando é inívoco dos dois
    // lados: um só ficheiro pedido com este nome E uma só linha FOUND com este
    // nome. Com dois ficheiros com o mesmo nome, atribuir a deteção a um deles
    // é um palpite — e o palpite vai para o ficheiro errado. Sem correspondência
    // o ficheiro fica sem deteção atribuída, e é a 5b que o transforma em
    // `error`: nunca `clean`.
    const wanted = unambiguousBase(file);
    if (wanted === undefined) return undefined;
    const byName = [...foundByPath.entries()].filter(([key]) => baseName(key) === wanted);
    return byName.length === 1 ? byName[0][1] : undefined;
  };

  /** O clamscan nomeou ESTE ficheiro com `: OK` (ou `: Empty file`)? Então foi avaliado. */
  const confirmedScanned = (file: string): boolean => {
    if (scannedByPath.has(pathKey(file))) return true;
    const wanted = unambiguousBase(file);
    if (wanted === undefined) return false;
    return [...scannedByPath.keys()].filter((key) => baseName(key) === wanted).length === 1;
  };

  // 2. Falha de base — o único caso em que "não carregou a base" é verdade.
  //
  // Duas detecções independentes, porque a mensagem de erro muda conforme a
  // fase da falha e não se pode depender dela. A segunda é a mais forte: se o
  // clamscan carregou ZERO assinaturas e não varreu NADA, e nós pediamos N
  // ficheiros, então não havia base. Isso é aritmética, nãointerpretation.
  const knownViruses = Number(/Known viruses:\s*(\d+)/i.exec(stdout)?.[1] ?? "-1");
  const scannedFiles = Number(/Scanned files:\s*(\d+)/i.exec(stdout)?.[1] ?? "-1");
  const dbBroken =
    DB_LOAD_FAILURE.test(stderr) ||
    (knownViruses === 0 && scannedFiles === 0 && files.length > 0);

  // 3. Ficheiros que o clamscan não conseguiu ler.
  const unreadable = new Set<string>();
  for (const rawLine of stderr.split(/\r?\n/)) {
    const m = UNREADABLE.exec(rawLine.trim());
    if (!m) continue;
    // O clamscan acrescenta o motivo (`": 225"`, `": Permission denied"`).
    const split = splitOnLastColonSpace(m[1].trim());
    unreadable.add(pathKey(split ? split.target : m[1].trim()));
  }
  const isUnreadable = (file: string) => {
    // Mesmo critério do `signatureFor`: por nome só quando o nome é inívoco
    // entre os ficheiros pedidos. Uma linha de erro que é de OUTRO ficheiro
    // não pode alargar-se a este por coincidência de basename (Codex F4) — o
    // veredicto errado é `error` aqui, mas é a ATRIBUIÇÃO errada que o produz.
    const wanted = unambiguousBase(file);
    if (wanted === undefined) return false;
    return [...unreadable].some((key) => baseName(key) === wanted);
  };

  // 4. Deteção no resumo sem linha FOUND: houve malware, não sabemos onde.
  const summaryInfected = /Infected files:\s*(\d+)/i.exec(stdout);
  const infectedCount = Number(summaryInfected?.[1] ?? "0");
  const unattributed = !dbBroken && infectedCount > 0 && foundByPath.size === 0;

  const timeoutOrAbort = input.timedOut === true || input.killed === true;
  const totalErrors = Number(/Total errors:\s*(\d+)/i.exec(stdout)?.[1] ?? "0");

  /**
   * DECLARADO vs ATRIBUÍDO (Codex F5).
   *
   * O resumo diz quantos; as linhas dizem quais. Só a diferença interessa:
   *
   *  - `Infected files: 1` com UMA linha FOUND → a explicação fecha. Os outros
   *    ficheiros do lote não são nomeados porque estão limpos, e é isso que o
   *    clamscan quer dizer. Declará-los `error` seria o antivírus a falhar em
   *    tudo.
*  - `Infected files: 2` com UMA linha FOUND → falta uma. Essa infecção não foi
    *    atribuída a nenhum ficheiro, e não pode ser declarada limpa: é
    *    `detection-unattributed`.
   *  - `Total errors: 1` com a linha `Can't open file X` que nomeia X → o erro
   *    está atribuído e não alarga a mais ninguém.
   */
  const attributedErrors = files.filter((f) => isUnreadable(f)).length;
  // Deteções que CAÍRAM num ficheiro nosso. `foundByPath.size` conta linhas,
  // não atribuições: uma linha `b\instalador.exe: FOUND` quando pedimos
  // `C:\a\instalador.exe` e `C:\b\instalador.exe` é ambígua (F4) e não é prova
  // de que nenhum dos dois é o infectado.
  const attributedInfections = files.filter((f) => signatureFor(f) !== undefined).length;
  const unattributedInfections = Math.max(0, infectedCount - attributedInfections);
  const unattributedErrors = Math.max(0, totalErrors - attributedErrors);

  /**
   * O resumo do clamscan explica TODOS os ficheiros que pedimos?
   *
   * Só quando `Scanned files` + `Total errors` = N pedido é que sabemos que
   * nenhum ficheiro ficou por avaliar. Sem esta aritmética, "clean" para os
   * ficheiros não nomeados seria uma suposição; com ela, é uma contagem.
   *
   * `Scanned directories` é separado e não conta: pediu-se ficheiros.
   */
  const summaryAccountsForEveryFile =
    scannedFiles >= 0 && totalErrors >= 0 && scannedFiles + totalErrors === files.length;

  const outcomes: ClamavFileOutcome[] = files.map((file) => {
    const base = { file, exitCode: code } as ClamavFileOutcome;
    const stillThere = () => {
      try {
        return exists(file);
      } catch {
        return true;
      }
    };

    // 1. Deteção — a informação principal nunca se perde.
    const signature = signatureFor(file);
    // O ClamAV nomeia os limites internos como "FOUND", mas isso não é uma
    // assinatura de malware: o ficheiro não foi avaliado por inteiro. Nunca
    // pode sair daqui como `detected`; é uma lacuna nomeada.
    if (signature && CLAMAV_LIMITS_EXCEEDED.test(signature)) {
      return {
        ...base,
        verdict: "error",
        reason: "limits-exceeded",
        detail: "Análise não concluída: o ficheiro excede os limites internos do ClamAV.",
      };
    }
    if (signature) {
      const removed = !stillThere();
      return {
        ...base,
        verdict: "detected",
        signature,
        removedDuringScan: removed,
        detail: removed
          ? `Detetado (${signature}); o ficheiro deixou de existir durante a análise.`
          : `Detetado: ${signature}`,
      };
    }

    // 2. Base de assinaturas indisponível — atinge todos.
    if (dbBroken) {
      return {
        ...base,
        verdict: "error",
        reason: "database-unavailable",
        detail: `O ClamAV não conseguiu carregar a base de assinaturas: ${firstLineOf(stderr)}`,
      };
    }

    // 3. Ficheiro que o clamscan não conseguiu ler.
    if (isUnreadable(file)) {
      const removed = !stillThere();
      return {
        ...base,
        verdict: "error",
        reason: removed ? "file-removed-during-scan" : "file-unreadable",
        removedDuringScan: removed,
        detail: removed
          ? "Análise não concluída: o ficheiro deixou de existir durante a análise."
          : "Análise não concluída: o ClamAV não conseguiu ler o ficheiro.",
      };
    }

    // 4. Houve deteção mas não sabemos qual ficheiro.
    if (unattributed) {
      return {
        ...base,
        verdict: "error",
        reason: "detection-unattributed",
        detail: "O ClamAV reportou ficheiros infectados mas não identificou quais — este ficheiro não pode ser declarado limpo.",
      };
    }

    // 5. O nosso deadline ou o cancelamento.
    if (timeoutOrAbort) {
      return {
        ...base,
        verdict: "error",
        reason: input.timedOut === true ? "timeout" : "aborted",
        detail:
          input.timedOut === true
            ? "Análise não concluída: o ClamAV excedeu o tempo limite."
            : "Análise não concluída: cancelada.",
      };
    }

    // 5c. O clamscan NOMEOU este ficheiro com `: OK` (ou `: Empty file`).
    // Evidência positiva e por ficheiro: foi varrido e não havia nada. Vale
    // acima de qualquer aritmética do resumo.
    if (confirmedScanned(file)) {
      return { ...base, verdict: "clean" };
    }

    // 5b. ATRIBUIÇÃO vs DECLARAÇÃO — Codex F5.
    //
    // O que o clamscan DECLARA no resumo (`Infected files: N`, `Total errors:
    // M`) tem de bater com o que ele ATRIBUIU linha a linha. Só a diferença é
    // que interessa:
    //
    //   atribuído == declarado  → a explicação fechou. Os restantes ficheiros
    //                             não foram nomeados porque não têm nada a
    //                             dizer, e são clean.
// atribuído <  declarado  → falta explicá-lo. O ficheiro sem
    //                             correspondência não pode ser limpo: é
    //                             `error` + `detection-unattributed`.
    //
    // A versão anterior desta regra disparava com `Infected files: 1 > 0`
    // SOZINHO e estragava o caso normal do lote: 1 deteção atribuída + 19
    // ficheiros bons davam 19 `error`. Isso é pior do que a mentira que se
    // queria tirar — um antivírus a falhar em tudo. O resumo já disse quantos
    // foram infectados; se o número fecha com as linhas FOUND, não há nada
    // em falta.
    if (unattributedInfections > 0 || unattributedErrors > 0) {
      return {
        ...base,
        verdict: "error",
        reason: "detection-unattributed",
        detail:
          `O ClamAV reportou ${infectedCount} ficheiro(s) infectado(s) e ${totalErrors} erro(s), ` +
          `mas só atribuiu ${attributedInfections} deteção(ões) e ${attributedErrors} erro(s) a ficheiros: ` +
          "este ficheiro não pode ser declarado limpo.",
      };
    }

    // 5d. O EXIT CODE ESTÁ EXPLICADO pelo que o clamscan declarou e atribuiu.
    //
    // Este é o caminho do lote normal, e é o que a regra do exit 1 substituía sem
    // base: o clamscan imprimiu `: <ficheiro>: <assinatura> FOUND` e
    // `Infected files: 1` — um e um. A explicação fechou. Os restantes ficheiros
    // do lote não são nomeados porque estão limpos, e declará-los `error` seria
    // pior do que a mentira original: um antivírus a falhar em tudo.
    //
    //  - exit 1 = "encontrei coisas": explicado quando o resumo DECLARA pelo
    //    menos uma infecção e nenhuma ficou por atribuir. Um exit 1 com
    //    `Infected files: 0` é contradição do próprio clamscan, e continua a ser
    //    `inconsistent-exit` como sempre.
    //  - exit > 1 = "algo correu mal": explicado quando os erros que ele DECLAROU
    //    estão todos nomeados. Um exit 2 sem nenhum erro declarado continua a ser
    //    inexplicado — e vai parar a `error`, como sempre.
    // CLA03-02: `clean` via summary exige EVIDÊNCIA. O ficheiro foi:
    //  - comprovadamente varrido (`: OK` na saída), OU
    //  - o resumo cobre TODOS os ficheiros pedidos (Scanned + Errors == N).
    // Basta uma destas provas de cobertura, além de explicar o exit e
    // atribuir todas as infeções/erros declarados aos ficheiros corretos.
    const evidenceCoversFile = confirmedScanned(file) || summaryAccountsForEveryFile;

    const declaredExplainsExit =
      (code === 1 && infectedCount > 0 && unattributedInfections === 0 && evidenceCoversFile) ||
      // CLA03-01: ramo code > 1 com mesma guarda.
      (typeof code === "number" && code > 1 && totalErrors > 0 && unattributedErrors === 0 && evidenceCoversFile);
    if (declaredExplainsExit) {
      return { ...base, verdict: "clean" };
    }

    // 6. Saída limpa: evidência COMPLETA — sem erros e sem infeções declaradas.
    if (code === 0 && totalErrors === 0 && summaryInfected !== null && infectedCount === 0 && scannedFiles >= files.length) {
      return { ...base, verdict: "clean" };
    }
    if (code === 0 && totalErrors === 0) {
      return {
        ...base,
        verdict: "error",
        reason: "inconsistent-exit",
        detail: "O ClamAV terminou com código 0, mas sem confirmação de análise deste ficheiro nem um resumo completo e limpo.",
      };
    }
    // 6b. Exit 0 com erros declarados contradiz o resultado global: a guarda
    // de cobertura dos exits explicados acima não autoriza este caso.
    if (code === 0) {
      // exit 0 com erros declarados: o clamscan é contraditório, e "clean"
      // seria afirmar mais do que ele próprio afirmou.
      return {
        ...base,
        verdict: "error",
        reason: "exit-0-with-errors",
        detail: `O ClamAV terminou com código 0 mas declarou ${totalErrors} erro(s).`,
      };
    }

    // 7. Qualquer outra saída: erro com o código à vista. Nunca clean.
    //
    // Aqui vivia uma regra que devolvia `clean` para quem não foi nomeado
    // sempre que `code === 1 && foundByPath.size > 0` (Codex F5). Um exit 1
    // significa que o clamscan encontrou alguma coisa; dizer que os restantes
    // ficheiros "estão limpos" é uma afirmação que o output não fez. Essa
    // resposta é agora a 5b (`error` + `detection-unattributed`).
    return {
      ...base,
      verdict: "error",
      reason: code === 1 ? "inconsistent-exit" : typeof code === "number" ? `exit-${code}` : "exit-unknown",
      detail: `O ClamAV terminou com código ${code ?? "desconhecido"}${firstLineOf(stderr) ? `: ${firstLineOf(stderr)}` : ""}`,
    };
  });

  const detected = outcomes.some((f) => f.verdict === "detected") || unattributed;
  const errorCount = outcomes.filter((f) => f.verdict === "error").length;
  return { files: outcomes, detected, errorCount, status: clamavStatusFrom(outcomes, code, stderr) };
}

/**
 * Estado do subsistema a partir dos resultados.
 *
 * Um erro é POR FICHEIRO, não do motor. Dez ficheiros limpos e um que não pôde
 * ser lido não tornam o ClamAV degradado — tornam aquele ficheiro incerto. Só
 * uma falha de base, ou um timeout, degradam o motor. Marcar o motor degradado
 * por causa de um ficheiro seriaapanhar o motor de mentira.
 */
function clamavStatusFrom(
  outcomes: ClamavFileOutcome[],
  code: number | null,
  stderr: string,
): EngineSubsystemHealth {
  if (outcomes.length === 0) return { status: "active", detail: "ClamAV não foi chamado" };
  const dbBroken = outcomes.some((f) => f.reason === "database-unavailable");
  if (dbBroken) {
    return {
      status: "degraded",
      detail: `ClamAV não conseguiu carregar a base de assinaturas: ${firstLineOf(stderr)}`,
    };
  }
  const timedOut = outcomes.some((f) => f.reason === "timeout");
  if (timedOut) {
    return { status: "degraded", detail: "Um scan do ClamAV excedeu o tempo limite e foi terminado." };
  }
  // Um clamscan que sai sem conseguir identificar um ficheiro está a
  // contradizer-se a si próprio. Anunciar o motor como `active` enquanto a
  // saída dele é inconsistente é a mesma classe de mentira que o result model
  // veio desfazer — noutro sítio. O CÓDIGO mostrado é o real: a mensagem antiga
  // dizia sempre "código 1" mesmo quando o clamscan tinha saído com 0 e o que
  // faltava era só evidência por ficheiro (medido 2026-10-16, instalação real).
  if (outcomes.some((f) => f.reason === "inconsistent-exit")) {
    return {
      status: "degraded",
      detail: `O ClamAV devolveu uma saída inconsistente (código ${code ?? "desconhecido"}) sem identificar nenhum ficheiro.`,
    };
  }
  // Sem código de saída e sem timeout nem kill, o processo morreu sem dizer
  // nada. Isso é uma avaria do MOTOR (e é diferente de um ficheiro ilegível):
  // aqui não houve sequer resultado para atribuir.
  if (code === null) {
    return {
      status: "degraded",
      detail: `O ClamAV terminou sem código de saída${firstLineOf(stderr) ? `: ${firstLineOf(stderr)}` : ""}.`,
    };
  }
  const uncertain = outcomes.filter((f) => f.verdict === "error");
  // Um ficheiro que o clamscan não conseguiu ler NÃO é uma avaria do motor.
  // O motor carregou a base (3 628 114 virus), o binário arrancou e terminou:
  // o que falhou foi a leitura de UM ficheiro. Degradar o ClamAV por isso era
  // repetir, noutra forma, a mentira que este result model veio desfazer — e
  // pior: `_health` é pegajoso, portanto contaminava todos os scans seguintes.
  if (uncertain.length === 0) {
    return { status: "active", detail: "ClamAV active; todos os ficheiro(s) obtiveram veredicto." };
  }
  return {
    status: "active",
    detail: `ClamAV active; ${uncertain.length} de ${outcomes.length} ficheiro(s) sem veredicto (código ${code ?? "desconhecido"}).`,
  };
}

/** Opções de um scan individual de ClamAV. */
export interface ClamavScanOptions {
  /**
   * Cancelamento cooperativo. `abort()` mata o clamscan em curso (ver
   * `ClamavBridge.dispose`) — sem isto, cancelar um scan deixava o processo a
   * trabalhar sozinho com ~1 GB de RAM, e o `ScanManager` nem reparava.
   */
  signal?: AbortSignal;
  /** Diagnostic correlation only; never changes scan behavior. */
  scanId?: string;
  /**
   * Classe de prioridade na vaga GLOBAL do ClamAV.
   *
   * Por omissão deriva do `scanId` (presente = scan do utilizador; ausente =
   * background), que é a impressão digital medida em produção. Só é preciso
   * declará-la quando um chamador de background precisar de subir de classe.
   * NUNCA muda quantos clamscans correm ao mesmo tempo (MAX_CLAMSCAN = 1).
   */
  priority?: ClamavJobPriority;
  /**
   * Quantos ficheiros o clamscan JÁ TERMINOU de analisar, em tempo real.
   *
   * O número vem das LINHAS PRÓPRIAS do clamscan (`<caminho>: OK` e
   * `<caminho>: <assinatura> FOUND`), contadas à medida que o stdout corre —
   * nunca de um temporizador e nunca de um estimador. O clamscan nomeia cada
   * ficheiro que varreu, uma linha de cada vez: se a linha existe, o ficheiro
   * foi avaliado. É o mesmo critério que `parseClamavOutput` usa para dizer
   * `clean`, usado aqui só para a contagem.
   *
   * Sem isto o batch é uma caixa preta: um Quick Scan de 765 ficheiros passava
   * minutos com 0/N e o temporizador a correr (P0 SCANNER_REAL_BATCH_STALL).
   */
  onProgress?: (processedFiles: number) => void;
}

/** Como o spawn termina — o suficiente para decidir detecção vs. diagnóstico. */
export interface ClamavSpawnOutcome {
  /** exit code do clamscan; null quando morreu por sinal ou timeout. */
  code: number | null;
  /** stdout do clamscan: linhas `FOUND` e o bloco SCAN SUMMARY. */
  stdout: string;
  stderr: string;
  /** O deadline foi atingido e matámos o processo. */
  timedOut: boolean;
  /** O processo foi morto por nós (timeout, abort, dispose). */
  killed: boolean;
  /**
   * Pedimos para matar, passou a tolerância, e o processo NÃO confirmou a
   * morte: nem o `taskkill` o tirou, nem o SO emitiu `close`.
   *
   * Isto NÃO é cosmético. O cap tem de saber a diferença entre "matámos" e
   * "pedi para matar e ninguém confirmou": só no primeiro caso a vaga pode
   * circular. Sem este sinal, `releaseClamavSlot()` corria no `finally` da
   * bridge com um clamscan de ~1 GB ainda vivo, e o scan seguinte arrancava
   * — o P0 original (2 clamscans em paralelo), reintroduzido pela própria
   * correcção que devia o impedir.
   */
  deathUnconfirmed?: boolean;
}

/**
 * Um clamscan vivo. `killTree()` tem de matar o PROCESSO E a descendência, e
 * tem de ser idempotente. `outcome` só resolve quando o processo morreu de
 * facto — nunca no momento em que pedimos para o matar. É essa distinção que
 * impede o cap de libertar a vaga enquanto o filho ainda detém ~1 GB.
 */
export interface ClamavSpawnHandle {
  readonly pid?: number;
  killTree(): void;
  readonly outcome: Promise<ClamavSpawnOutcome>;
  /**
   * CODEX (2026-10-03): morphological — chamado QUANDO o SO confirma que o
   * processo morreu de facto (o `close` do filho).
   *
   * Existe por causa de um buraco que o próprio Codex encontrou: quando
   * `deathUnconfirmed` é true, o clamsscan pode continuar VIVO — o grace
   * expirou sem prova de morte. O semáforo tratava disso (envenenava a vaga),
   * mas a lease da base era libertada na mesma, e o gate passava a achar que
   * ninguém tinha a base aberta. Um freshclam podia então escrever por cima de
   * um clamscan vivo.
   *
   * Com este registo, a lease da base só é libertada quando o SO confirma a
   * morte, e não quando o scan desistiu de esperar. O que o utilizador vê não
   * muda: `unavailable` com a mesma honestidade de antes.
   *
   * É um REGISTO, e não um callback para invocar. A primeira versão tinha
   * `whenDeathConfirmed()` e a bridge ASSIGNAVA-o — o que substituía o
   * mecanismo do spawner em vez de o usar, e o `close` nunca libertava nada.
   * O teste apanhou isso; a assinatura é agora a que não permite o erro.
   */
  onDeathConfirmed?(onConfirmed: () => void): void;
}

/**
 * Seam de teste: como o clamscan é lançado. A produção nunca injecta nada;
 * existe para que os testes possam contar concorrência e provar que o timeout
 * e o abort MATAM o processo, sem depender do binário real.
 */
export type ClamavSpawnFn = (
  file: string,
  args: string[],
  request: { timeoutMs: number; windowsHide: boolean; onProgress?: (processedFiles: number) => void; scanId?: string },
  /** Opcional: só os testes o usam. Ver `ClamavProcessHooks`. */
  hooks?: ClamavProcessHooks,
) => ClamavSpawnHandle;

/**
 * Tecto do argv do clamscan.
 *
 * MEDIDO (2026-10-05): com 765 caminhos reais o argv deu 65 166 caracteres e
 * o `spawn()` do Node LANÇOU `ENAMETOOLONG` — o Windows recusa uma command line
 * acima de 32 767 (CreateProcess). O clamscan nunca nasceu, e o `prefetchClamav`
 * do serviço tratou a excepção como "sem prefetch", devolvendo TODOS os
 * ficheiros ao clamscan individual: a cascata de ~981 MB por ficheiro que a
 * FASE 4 existia para impedir.
 *
 * O orçamento é deliberadamente MUITO abaixo do tecto do SO: 8 000 caracteres
 * dão folga para o caminho do executável, o `--database=` e o ambiente, e
 * continuam a ser legíveis num `Get-Process`. Acima disso os caminhos vão num
 * ficheiro de lista (`--file-list=`), que o ClamAV 1.5 aceita.
 */
const MAX_CLAMSCAN_ARGV_CHARS = 8000;

/** Custo de cada argumento na command line: aspas + separador. */
function argvChars(args: string[]): number {
  return args.reduce((n, a) => n + a.length + 3, 0);
}

/** Opt-in diagnostics only; details passed here must never contain source paths or file contents. */
function scanPerfLog(event: string, scanId?: string, details = ""): void {
  if (process.env.CYBERSAFE_DEBUG_SCAN !== "1") return;
  console.log(
    `[ScanPerf] ${event} scanId=${scanId ?? "n/a"} at=${new Date().toISOString()}${details ? ` ${details}` : ""}`,
  );
}

export interface ClamavBridgeOptions {
  /**
   * Directório da base de assinaturas quando o chamador já o conhece.
   * Tem a prioridade máxima — é o `--datadir` passado ao `clamscan`.
   */
  datadir?: string;
  /** Override do directório de definições gerido pela app (default `<home>/.cybersafe-service/definitions`). */
  definitionsDir?: string;
  /** Verified packaged, read-only database; never a freshclam target. Revalidated on probe. */
  fallbackDatabaseDir?: () => Promise<string | null>;
  /** Envelhecimento máximo aceite nas assinaturas. Default: 7 dias. */
  maxSignatureAgeMs?: number;
  /** Timeout de um scan individual. Default: 10 s. */
  scanTimeoutMs?: number;
  /**
   * Clamscans simultâneos permitidos NESTE bridge. Default: `GLOBAL`.
   *
   * `GLOBAL` (1) é o que resolve o P0: o limite tem de ser transversal a todos
   * os chamadores — o loop do ScanManager, o monitor de ficheiros, o monitor
   * de processos e o dashboard — e não só a um deles.
   */
  maxConcurrent?: number | "GLOBAL";
  /** Seam de teste. Nunca definido em produção. */
  spawn?: ClamavSpawnFn;
  /** Seam de teste da PROVA DE CARGA. Nunca definido em produção. */
  probeRun?: ClamavLoadRun;
  /**
   * Modo de operação. `false` nas políticas readonly/fixture do serviço: a
   * prova de carga NÃO faz spawn nem escreve fixture — o motor fica
   * `degraded` com a razão honesta ("prova de carga desativada neste modo"),
   * nunca `active` sem prova, nunca um clamscan fora da vida do bridge.
   * Default: `true`.
   */
  loadProofEnabled?: boolean;
  /** Timeout da PROVA DE CARGA (default: `CLAMAV_LOAD_PROBE_TIMEOUT_MS`). Testes injectam. */
  probeTimeoutMs?: number;
  /** Órçamento do `dispose()` à espera da morte dos filhos (default 5 s). Testes injectam. */
  disposeBudgetMs?: number;
  /**
   * P1-1 (1) — a base de assinaturas está a ser TROCADA agora?
   *
   * P1-1 — ADQUIRIR UMA LEASE SOBRE A BASE, não perguntar por ela.
   *
   * A versão anterior era `isDatabaseSwapping(): boolean` — um CHECK. E um check
   * separado do uso não fecha uma corrida: entre a consulta e o `--database=`
   * há awaits, e o freshclam pode arrancar nesse intervalo. Pior: um scan já
   * em curso não era considerado, e o freshclam escrevia por cima dele.
   *
   * A lease é o que fecha as duas. O gate do serviço é a ÚNICA autoridade:
   *  - devolve `null` se um update está pendente ou activo — e o scan responde
   *    `unavailable` sem spawn, sem fila, sem espera;
   *  - devolve uma lease com `release()` quando o scan entra. O update só
   *    escreve depois de todas as leases libertarem, o que significa que um
   *    freshclam NUNCA corre por cima de um clamscan vivo.
   *
   * A lease é mantida durante toda a região em que este scan pode iniciar OU
   * usar o clamscan com a base, e libertada no `finally`. Libertá-la antes do
   * processo terminar devolveria ao gate a mentira de que a base está livre
   * enquanto o clamscan ainda a tem aberta.
   *
   * A implementação vive em `service/src/clam-database-gate.ts`; aqui só se
   * consome o contrato, para o core não depender do serviço.
   */
  acquireDatabaseLease?: (scanId?: string) => ClamDatabaseLeaseHandle | ClamDatabaseLeaseRefusal | null;
}

/**
 * A lease foi recusada, E PORQUÊ.
 *
 * CODEX (2026-10-03), pergunta 9: o gate distingue três recusas — update a
 * chegar, update a escrever, serviço a encerrar — mas o motor descartava a
 * causa e a bridge anunciava SEMPRE "as assinaturas estão a ser actualizadas".
 * Para um utilizador cujo motor esta a encerrar, essa frase e uma mentira: nao
 * há actualização nenhuma a caminho, e esperar por ela não ajuda.
 */
export interface ClamDatabaseLeaseRefusal {
  readonly refused: true;
  /** `update-pending` | `update-active` | `gate-disposed`. */
  readonly reason: string;
}

/**
 * A recusa, dita em português de Portugal.
 *
 * São três frases distintas porque são três situações distintas, e o utilizador
 * Age diferente em cada uma: durante um update espera; com o serviço a encerrar,
 * reiniciar é o que resolve.
 */
function descreverRecusaDaBase(reason: string | null): string {
  switch (reason) {
    case "update-active":
      return (
        "ClamAV indisponível: as assinaturas estão a ser actualizadas neste momento. " +
        "Tenta de novo dentro de instantes — o scan não foi feito, e dizemos isso."
      );
    case "update-pending":
      // CODEX (2026-10-03), oitava ronda: a versão anterior dizia que o scan
      // "ia ficar a meio". Ia ser MENTIRA — o update ESPERA pelos scans
      // activos (o contrato B); é este scan que não entra, não o outro que se
      // estraga. Não se promete uma consequência que não acontece.
      return (
        "ClamAV indisponível: está a chegar uma actualização de assinaturas, e este scan não " +
        "entra agora para não ficar a meio. Tenta de novo dentro de instantes — o scan não foi " +
        "feito, e dizemos isso."
      );
    case "gate-disposed":
      return (
        "ClamAV indisponível: o serviço de protecção está a encerrar. " +
        "Este scan não foi feito — ao reiniciar o serviço, a análise volta a estar disponível."
      );
    default:
      return (
        "ClamAV indisponível: a base de assinaturas não pode ser usada neste momento. " +
        "O scan não foi feito, e dizemos isso."
      );
  }
}

/**
 * O que `acquireDatabaseLease` devolve.
 *
 * `release` é idempotente e chamado no `finally` do scan. `denialReason` existe
 * para o `unavailable` dizer a verdade correcta (update pendente vs activo) em
 * vez de uma frase genérica.
 */
export interface ClamDatabaseLeaseHandle {
  release(): void;
  readonly released: boolean;
}

/**
 * Binários do motor de scan do CyberSafe.
 *
 * NÃO é uma lista de "processos bons" — é exclusivamente o motor que nós
 * próprios lançamos. Se o `ProcessMonitor` losse estes nomes, o CyberSafe
 * passava a analisar o próprio motor de scan, que voltava a ser visto como
 * processo novo, que voltava a ser analisado: um ciclo que cada volta
 * custava ~1 GB de RAM (o clamscan carrega `main.cvd` + `daily.cvd` +
 * `bytecode.cvd` para o seu espaço privado).
 *
 * Isto fecha o caso comum. Não fecha sozinho: o binário pode ter um nome
 * diferente noutra instalação, e qualquer outro motor que o serviço lance tem
 * o mesmo problema. Por isso existem também a exclusão por caminho e o
 * registo de filhos próprios no serviço.
 */
export const CLAMAV_ENGINE_PROCESS_NAMES: ReadonlySet<string> = new Set([
  "clamscan.exe",
  "clamscan",
  "clamdscan.exe",
  "clamd.exe",
  "clamd",
  "clamdtop.exe",
  "clambc.exe",
  "clamsubmit.exe",
  "freshclam.exe",
  "freshclam",
  "sigtool.exe",
]);

/** Default do timeout de um scan individual. */
const DEFAULT_SCAN_TIMEOUT_MS = 10_000;
/**
 * Custo FIXO de um clamscan: arranque + carga da base de assinaturas.
 * MEDIDO (2026-10-16, controlo 2x): ~7,2 s nesta maquina. Entra no orcamento
 * DEFAULT do batch (ver `timeoutMs` em runScan); um override explicito de
 * `scanTimeoutMs` mantem o contrato antigo (N x override) e ignora este termo.
 */
const DEFAULT_SCAN_STARTUP_MS = 10_000;

/**
 * Tecto de output capturado por scan.
 *
 * O stdout de um clamscan é uma linha por ficheiro mais o resumo: alguns KB
 * mesmo para milhares de ficheiros. O tecto existe para que uma saída
 * patológica não vire um novo vazamento de RAM — que era exactamente o
 * defeito que esta bridge existe para impedir.
 */
const MAX_CAPTURED_OUTPUT = 8 * 1024 * 1024;

/** Tecto do deadline de um batch, para que N grande não fique infinito. */
const MAX_BATCH_TIMEOUT_MS = 600_000;
/**
 * Tempo que damos a um processo morto para sair de facto depois de
 * `taskkill /T /F`. Passado isto, o outcome resolve como morto para o cap não
 * ficar preso à espera de um processo que já não responde.
 */
const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * Semáforo GLOBAL de clamscans.
 *
 * Module-level, não por instância: `scanArtifact` é chamado por vários
 * caminhos (ScanManager, watcher de ficheiros, monitor de processos,
 * dashboard) e cada um tem o seu `ClamavBridge`. Um limite por instância não
 * impediria nada — foi exactamente esse o bug.
 */
/**
 * Semáforo GLOBAL de clamscans.
 *
 * Module-level, não por instância: `scanArtifact` é chamado por vários
 * caminhos (ScanManager, watcher de ficheiros, monitor de processos,
 * dashboard) e cada um tem o seu `ClamavBridge`. Um limite por instância não
 * impediria nada — foi exactamente esse o bug.
 *
 * `poisoned` conta as vagas cujo processo NÃO CONFIRMOU a morte. Uma vaga
 * envenenada continua `active`: o processo pode estar vivo com ~1 GB de RAM, e
 * admitir outro clamscan era o P0 original. Não é um hang — quem chega enquanto
 * há poison recebe `poisoned` imediatamente e o scan responde `unavailable`, que
 * é a verdade. A vaga volta quando a morte é confirmada (o `close` do filho).
 */
const globalClamavSlots = {
  active: 0,
  poisoned: 0,
  /** Fila dos scans do UTILIZADOR (têm scanId: quick/full/custom do ScanManager). */
  waitingUser: [] as Array<(granted: ClamavSlotResult) => void>,
  /** Fila de BACKGROUND (análise unitária de ficheiro/processo, sem scanId). */
  waitingBackground: [] as Array<(granted: ClamavSlotResult) => void>,
  /** Jobs de background RECUSADOS por fila cheia (backpressure honesta). */
  droppedBackground: 0,
};

/**
 * Classe de prioridade de um job na vaga GLOBAL.
 *
 * `user`     = trabalho de um scan que o utilizador pediu (tem scanId).
 * `background` = análise unitária automática (ficheiro observado, processo
 *              iniciado, correlação ETW). É o default, e é o conservador: só
 *              quem declara (ou traz scanId) sobe de prioridade.
 */
export type ClamavJobPriority = "user" | "background";

/**
 * Tecto de jobs de BACKGROUND à espera da vaga.
 *
 * MEDIDO (2026-10-07, Quick Scan real): a fila chegou a `waiting=79-80` e o
 * batch de 730 candidatos do scan do utilizador NUNCA arrancou — ficou atrás de
 * ~80 análises unitárias. Uma fila sem tecto é memória a crescer e um backlog
 * de minutos que ninguém vê.
 *
 * MEDIDO (mesma janela): o pior caso observado foi 80. 128 dá folga a esse caso
 * (a prioridade resolve-o, sem descartar nada) e continua FINITO: acima dele o
 * job leva uma recusa HONESTA (`overloaded` -> `unavailable`), em vez de se
 * acumular em silêncio. Não se perde o evento: publica-se que ele não foi
 * analisado, e o próximo evento do mesmo ficheiro volta a tentar.
 */
const MAX_QUEUED_BACKGROUND_JOBS = 128;

/** `poisoned` = não há vaga segura. `overloaded` = fila de background cheia. */
type ClamavSlotResult = "granted" | "poisoned" | "overloaded" | "aborted";

/**
 * A mensagem de um motor cuja vaga ficou presa. ÚNICA, e usada pelos DOIS
 * pontos que a negam: a recusa antecipada (T19, antes do probe) e a aquisição do
 * semáforo. Duas frases para o mesmo facto dariam azo a um teste passar pelo
 * motivo errado.
 */
const POISONED_SCAN_DETAIL =
  "ClamAV indisponível: um clamscan anterior não confirmou a morte e continua a marcar ~1 GB. " +
  "O motor volta quando esse processo terminar.";

/**
 * A recusa por BACKPRESSURE, dita como o que é: o motor está ocupado e este
 * ficheiro NÃO foi analisado agora. Não é "limpo" e não é "erro de leitura".
 */
const OVERLOADED_SCAN_DETAIL =
  "Motor de análise ocupado: há demasiadas análises automáticas em espera. " +
  "Este ficheiro não foi analisado agora; será reanalisado no próximo evento.";

/**
 * Contador monotónico dos nomes de ficheiro-lista.
 *
 * CODEX (2026-10-07, finding HIGH): com `pid + Date.now()`, dois batches
 * preparados no MESMO milissegundo escreviam para o mesmo caminho — o segundo
 * sobrescrevia a lista do primeiro, e o cleanup de um apagava a lista que o
 * outro ainda ia usar. `MAX_CLAMSCAN=1` serializa os PROCESSOS, não a
 * preparação (que corre antes da vaga).
 */
let batchListSeq = 0;

/** Há alguma vaga envenenada? Então nenhum clamscan novo pode nascer. */
function clamavSlotsPoisoned(): boolean {
  return globalClamavSlots.poisoned > 0;
}

async function acquireClamavSlot(
  limit: number,
  priority: ClamavJobPriority = "background",
  signal?: AbortSignal,
): Promise<ClamavSlotResult> {
  if (globalClamavSlots.poisoned > 0) return "poisoned";
  // Cancelado antes de esperar: não entra na fila de todo.
  if (signal?.aborted) return "aborted";
  if (globalClamavSlots.active < limit) {
    globalClamavSlots.active++;
    return "granted";
  }
  // BACKPRESSURE: a fila de background tem tecto. Um scan do utilizador nunca é
  // recusado por isto — ele é uma ação explícita e cabe sempre.
  if (
    priority === "background" &&
    globalClamavSlots.waitingBackground.length >= MAX_QUEUED_BACKGROUND_JOBS
  ) {
    globalClamavSlots.droppedBackground++;
    return "overloaded";
  }
  // A vaga é TRANSFERIDA, não emprestada: quem espera NÃO incrementa ao ser
  // acordado, porque quem libera NÃO decrementa.
  //
  // A versão anterior incrementava dos dois lados. Isso não era um detalhe
  // teórico: com `limit = 1`, um `release` acordava um waiter sem ainda ter
  // decrementado, e qualquer chamador que chegasse nesse intervalo era
  // admitido em directo. Medido em `clamav-cap-review.test.js`: pico de 7
  // clamscans com o limite declarado a 1. Era o mesmo P0, outra vez.
  return new Promise<ClamavSlotResult>((resolve) => {
    const queue =
      priority === "user"
        ? globalClamavSlots.waitingUser
        : globalClamavSlots.waitingBackground;
    let settled = false;
    const settle = (result: ClamavSlotResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const entry = (result: ClamavSlotResult) => settle(result);
    // Um scan CANCELADO enquanto espera sai da fila: sem isto, ele consumia uma
    // vaga para a devolver logo a seguir ("acorda para morrer"), atrasando quem
    // lá estava.
    const onAbort = () => {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      settle("aborted");
    };
    queue.push(entry);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Liberta a vaga e escolhe QUEM a recebe.
 *
 * ORDEM DE PRIORIDADE (o P0 SCANNER_RUNTIME_ZERO_PROGRESS):
 *   1. scans do utilizador em espera, por ordem de chegada;
 *   2. análises de background em espera, por ordem de chegada;
 *   3. ninguém -> a vaga fica livre (`active` decrementa).
 *
 * O job ATIVO nunca é interrompido: a vaga só é decidida quando ele termina.
 * Isso é deliberado — matar um clamscan saudável a meio para preempção pagaria
 * ~981 MB outra vez e podia deixar a base da app a ser escrita por cima de um
 * processo vivo.
 */
function releaseClamavSlot(): void {
  const next =
    globalClamavSlots.waitingUser.shift() ?? globalClamavSlots.waitingBackground.shift();
  if (next) {
    // `active` mantem-se: a vaga passa de mãos em mãos, nunca há um instante
    // em que o limite possa ser excedido.
    next("granted");
    return;
  }
  globalClamavSlots.active = Math.max(0, globalClamavSlots.active - 1);
}

/**
 * Fotografia read-only do semáforo. Existe para TELEMETRIA e para os testes
 * poderem afirmar a fila sem espiar estado interno por outra via.
 */
export function clamavSlotStats(): {
  active: number;
  waitingUser: number;
  waitingBackground: number;
  poisoned: number;
  droppedBackground: number;
  maxQueuedBackground: number;
} {
  return {
    active: globalClamavSlots.active,
    waitingUser: globalClamavSlots.waitingUser.length,
    waitingBackground: globalClamavSlots.waitingBackground.length,
    poisoned: globalClamavSlots.poisoned,
    droppedBackground: globalClamavSlots.droppedBackground,
    maxQueuedBackground: MAX_QUEUED_BACKGROUND_JOBS,
  };
}

/**
 * A vaga fica presa porque o processo pode ainda estar vivo.
 *
 * NINGUÉM é admitido a partir de agora: nem quem chega agora, nem quem já
 * estava na fila — a fila é acordada com `poisoned` para que ninguém fique à
 * espera de uma vaga que não pode ser dada sem risco de 2 GB em voo. É
 * degradação honesta, não fila morta: cada scan responde `unavailable`.
 */
function poisonClamavSlot(): void {
  globalClamavSlots.poisoned++;
  // AS DUAS filas. Com o semáforo partido em duas, esquecer uma deixava metade
  // dos waiters presos para sempre — ninguém lhes daria vaga nem recusa.
  while (globalClamavSlots.waitingUser.length > 0) {
    globalClamavSlots.waitingUser.shift()!("poisoned");
  }
  while (globalClamavSlots.waitingBackground.length > 0) {
    globalClamavSlots.waitingBackground.shift()!("poisoned");
  }
}

/**
 * A prova de morte chegou (`close` do filho): a vaga volta à circulação.
 *
 * Exportado como SEAM DE TESTE: o `close` do filho é o único produtor desta
 * chamada em produção (spawner). Um mock que queira emular o `close` do
 * spawner (morte tardia de um clamscan cuja vaga foi envenenada) usa-o para
 * provar que a vaga volta — mesmo contrato que o scan.
 */
export function releasePoisonedClamavSlot(): void {
  globalClamavSlots.poisoned = Math.max(0, globalClamavSlots.poisoned - 1);
  releaseClamavSlot();
}

/** PIDs de clamscan que lançámos — o serviço usa isto para não se auto-analisar. */
const liveClamavPids = new Set<number>();

/** Limite de PIDs retidos; o serviço só precisa de cobrir os filhos vivos. */
const MAX_TRACKED_PIDS = 256;

export function isTrackedClamavPid(pid: number): boolean {
  return liveClamavPids.has(pid);
}

function trackClamavPid(pid: number | undefined): void {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return;
  if (liveClamavPids.size >= MAX_TRACKED_PIDS) {
    // Janela deslizante: um PID que já não está a correr não vale a pena
    // guardar, e guardar todos seria um leak num serviço de vida longa.
    const oldest = liveClamavPids.values().next();
    if (!oldest.done) liveClamavPids.delete(oldest.value);
  }
  liveClamavPids.add(pid);
}

function untrackClamavPid(pid: number | undefined): void {
  if (typeof pid === "number") liveClamavPids.delete(pid);
}

/* ────────────────────────────────────────────────────────────────────────────
 * P1-2 — `taskkill /PID` NÃO é identidade.
 *
 * `killProcessTree` fala ao Windows por um NÚMERO. Entre o spawn e o `killTree()`
 * (deadline, abort, dispose) o clamscan pode ter MORRIDO sem que o `close`
 * tenha chegado ao loop — o `close` espera pelo fecho dos pipes, e um neto que
 * herde o stdout segura-o. Nesse intervalo o Windows recicla o PID, e
 * `taskkill /T` deixa de ser "matar o clamscan" e passa a ser "matar a árvore de
 * um processo do utilizador".
 *
 * A protecção é ler a identidade do PID ANTES de o matar, e comparar com o que
 * observámos no spawn. Duas fontes, por ordem de custo:
 *
 *  1. CIM (`Win32_Process`): nome, caminho, `CreationDate`, `CommandLine` e
 *     `ParentProcessId`. Medido nesta máquina: ~275–330 ms por leitura.
 *  2. `tasklist`: só o nome do executável. ~78 ms. É o recurso quando o
 *     PowerShell não está disponível, e apanha o caso catastrófico (outro
 *     programa com o nosso PID).
 *
 * A leitura acontece SÓ no caminho em que vamos matar (deadline/abort/dispose),
 * nunca por scan: `Date.now()` + fecho de handle custam zero, a leitura custa
 * um `powershell.exe`.
 * ────────────────────────────────────────────────────────────────────────── */

/** Tecto de UMA leitura de identidade: um PowerShell que não arranque não se espera. */
const IDENTITY_PROBE_TIMEOUT_MS = 2_500;

/**
 * ORÇAMENTO TOTAL da resolução de identidade, em milissegundos.
 *
 * O orçamento anterior era Implícito: 3 tentativas × (CIM 2,5 s + fallback
 * `tasklist` 2,5 s) ≈ 15 s de chamadas SÍNCRONAS, contra um grace de 2 s. O
 * resultado era um `killTree()` que bloqueava o event loop muito mais tempo do
 * que a tolerância prometia, e um `deadline` que já tinha expirado quando o
 * kill começava.
 *
 * Este número é a verdade: a resolução de identidade inteira — todas as
 * tentativas, as DUAS fontes de cada tentativa e os atrasos entre elas — cabe
 * aqui dentro. Cada sonda recebe o que RESTA, e o fim do orçamento é
 * `unavailable`, nunca um kill às cegas.
 */
const IDENTITY_RESOLUTION_BUDGET_MS = 2_000;

/**
 * Tecto da SESSÃO de terminação validada por handle (B9).
 *
 * É uma única sessão PowerShell que recolhe a descendência e mata cada
 * instância no seu próprio handle, por isso custa mais do que o antigo
 * `taskkill` e é o que fecha a corrida entre validar e terminar.
 */
const IDENTITY_TERMINATE_TIMEOUT_MS = 5_000;

/**
 * Tolerância do relógio ao comparar `CreationDate`.
 *
 * O processo é carimbado pelo kernel no `CreateProcess`, que corre DEPOIS do
 * `Date.now()` que lemos antes do spawn; 5 s absorvem a diferença de resolução
 * e uma skimagem de NTP.
 *
 * DECISÃO DO UTILIZADOR (2026-10-03): isto é DIAGNÓSTICO, nunca autorização.
 * Só rejeita (uma criação no futuro é leitura não fiável; uma criação muito
 * antes do spawn não pode ser o nosso filho). Nunca aceita: o que autoriza é a
 * IGUALDADE com a identidade capturada da instância original.
 */
const IDENTITY_CLOCK_SLACK_MS = 5_000;

/** O que o Windows diz sobre o PID que ocupa agora. */
export interface ProcessIdentityRow {
  pid: number;
  /** 0 = desconhecido (não é prova de nada). */
  ppid: number;
  name: string;
  /** null quando o campo não é legível (exige elevação para outro utilizador). */
  exe: string | null;
  /** ISO-8601 UTC do `CreationDate`; "" quando não foi possível ler. */
  created: string;
  cmd: string | null;
}

/**
 * Uma LEITURA, ainda sem veredicto: quem decide é `classifyProcessIdentity`, e
 * o seam de teste injecta a linha — nunca o veredicto. Assim o veredicto é
 * sempre lógica de produção, não opinião do teste.
 */
export interface ProcessIdentityReading {
  /** null quando o Windows não devolve nenhuma linha para este PID. */
  row: ProcessIdentityRow | null;
  /** A leitura não aconteceu (sem PowerShell, timeout, saída inválida). */
  probeFailed: boolean;
  detail: string;
}

export type ProcessIdentityProbe = (
  pid: number,
  /** Milissegundos que a sonda pode gastar. `undefined` = tecto padrão. */
  budgetMs?: number,
) => ProcessIdentityReading;

/**
 * CAPTURA da identidade logo após o spawn. Assíncrona de propósito: é uma
 * leitura do SO por clamscan, e fazê-la com `spawnSync` custaria ~300 ms de
 * event loop parado em CADA scan. Assíncrona, corre a par com o clamscan a
 * carregar a base e está pronta muito antes de o deadline (10 s) disparar.
 */
export type ProcessIdentityCapture = (
  pid: number,
  budgetMs?: number,
) => Promise<ProcessIdentityReading>;

export interface ExpectedProcessIdentity {
  /** Nome do executável que lançámos, sem extensão. */
  exeStem: string;
  /** Primeiro caminho que o clamscan recebeu a sério (distingue scans). */
  cmdMarker?: string;
  /**
   * `Date.now()` lido ANTES do spawn.
   *
   * NÃO é identidade. É o limite inferior que torna uma criação "impossível de
   * ser a nossa" uma CONTRADIÇÃO (rejeição), nunca uma aceitação.
   */
  spawnedAtMs: number;
  /**
   * IDENTIDADE DE CRIAÇÃO REAL do filho original, capturada do SO logo após o
   * spawn (ver `ProcessIdentityCapture`).
   *
   * É o ÚNICO campo que autoriza `ours`. Sem ele, nenhum campo da leitura
   * atual — nome, caminho, comando, PPID — autoriza um kill: todos eles
   * descrevem um NÚMERO, e o número é exactamente o que pode ter sido reciclado.
   */
  capturedCreated?: string;
}

export type ProcessIdentityVerdict = "ours" | "foreign" | "free" | "unavailable";

export interface ProcessIdentityResult {
  verdict: ProcessIdentityVerdict;
  /** Porquê, em português: é o que entra no diagnóstico quando isto falha. */
  reason: string;
}

/** Nome do executável, sem directório e sem extensão. */
function exeStem(file: string): string {
  return baseName(String(file ?? "")).replace(/\.[a-z0-9]+$/i, "");
}

/**
 * A identidade observada no momento do spawn.
 *
 * Só o que é FREE: o executável que pedimos e o primeiro caminho passado ao
 * clamscan (`--database=...` não conta). A IDENTIDADE DE CRIAÇÃO do filho não
 * entra aqui — entra depois, capturada do SO por `captureSpawnedIdentity`, e
 * é o único campo que pode autorizar um kill.
 */
export function expectedIdentityFor(
  file: string,
  args: readonly string[],
  spawnedAtMs: number,
): ExpectedProcessIdentity {
  const firstPath = args.find((a) => typeof a === "string" && a.length > 0 && !a.startsWith("-"));
  return {
    exeStem: exeStem(file),
    ...(firstPath ? { cmdMarker: firstPath } : {}),
    spawnedAtMs,
  };
}

/** Identidade de criação normalizada para comparação. `null` = ilegível. */
function creationIdentityMs(created: string | undefined): number | null {
  if (typeof created !== "string" || created.trim() === "") return null;
  const ms = Date.parse(created);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Contradições NUM campos PREENCHIDOS: só o que está preenchido e diz o
 * contrário conta. Um campo ilegível (exe/cmdline a null) não é prova de culpa
 * — é falta de informação, e falta de informação dá `unavailable`.
 *
 * Isolado para ser usado em DOIS momentos com a mesma lógica: na classificação
 * da leitura actual, e na validação da leitura capturada logo após o spawn.
 */
function identityContradiction(input: {
  pid: number;
  row: ProcessIdentityRow;
  expected: ExpectedProcessIdentity;
  selfPid: number;
}): string | null {
  const { pid, row, expected, selfPid } = input;
  const rowStem = exeStem(row.name);
  if (rowStem && rowStem !== expected.exeStem) {
    return `o PID ${pid} corre "${row.name}", não "${expected.exeStem}"`;
  }
  if (row.exe) {
    const exeStemRow = exeStem(row.exe);
    if (exeStemRow && exeStemRow !== expected.exeStem) {
      return `o PID ${pid} executa "${row.exe}", não "${expected.exeStem}"`;
    }
  }
  if (Number.isInteger(row.ppid) && row.ppid > 0 && row.ppid !== selfPid) {
    return `o PID ${pid} foi criado pelo processo ${row.ppid}, não por nós (${selfPid})`;
  }
  if (expected.cmdMarker && row.cmd && !row.cmd.includes(expected.cmdMarker)) {
    return `a linha de comando do PID ${pid} não é o scan que lançámos`;
  }
  return null;
}

/**
 * `ours` só com PROVA POSITIVA da instância original.
 *
 * DECISÃO DO UTILIZADOR (2026-10-03): `ours` exige que a `CreationDate` lida
 * seja IGUAL à identidade capturada do filho que lançámos. Nome, caminho,
 * comando e PPID são CATIDATOS a validar — contradições neles rejeitam
 * (`foreign`), mas nunca autorizam sozinhos. Uma leitura incompleta, ou só com
 * PID e nome, dá `unavailable` e portanto NÃO mata.
 *
 * A janela de relógio só rejeita (criação no futuro = leitura não fiável;
 * criação muito antes do spawn = não é o nosso filho). Nunca aceita.
 */
export function classifyProcessIdentity(input: {
  pid: number;
  row: ProcessIdentityRow | null;
  expected: ExpectedProcessIdentity;
  selfPid: number;
  nowMs?: number;
  probeFailed?: boolean;
}): ProcessIdentityResult {
  const { pid, row, expected, selfPid } = input;
  const nowMs = input.nowMs ?? Date.now();

  if (input.probeFailed) {
    return { verdict: "unavailable", reason: "a leitura de identidade do PID falhou" };
  }
  if (!row) {
    return { verdict: "free", reason: `o PID ${pid} não está em uso` };
  }
  if (row.pid !== pid) {
    return { verdict: "foreign", reason: `a linha lida é do PID ${row.pid}, não do ${pid}` };
  }

  // 1. Contradições primeiro: uma contradição é EVIDÊNCIA, e é mais forte do
  //    que a falta de identidade de criação. Um PID reciclado por um programa
  //    do utilizador tem de ser `foreign` mesmo que venhamos sem captura.
  const contradiction = identityContradiction({ pid, row, expected, selfPid });
  if (contradiction) {
    return { verdict: "foreign", reason: contradiction };
  }

  // 2. Sem nome não há sequer o que confirmar. O `tasklist` só traz o nome, e
  //    um nome sozinho nunca prova instância.
  if (!exeStem(row.name)) {
    return { verdict: "unavailable", reason: `sem nome de executável, não há o que confirmar` };
  }

  const createdMs = creationIdentityMs(row.created);
  if (createdMs === null) {
    return {
      verdict: "unavailable",
      reason: `a CreationDate do PID ${pid} é ilegível: não há identidade para comparar`,
    };
  }
  // Diagnóstico, não autorização: uma criação no futuro é uma leitura em que
  // não se pode confiar; uma criação muito antes do spawn não é o nosso filho.
  if (createdMs > nowMs + IDENTITY_CLOCK_SLACK_MS) {
    return { verdict: "foreign", reason: `CreationDate no futuro (${row.created}): leitura não fiável` };
  }
  if (createdMs < expected.spawnedAtMs - IDENTITY_CLOCK_SLACK_MS) {
    return { verdict: "foreign", reason: `criado às ${row.created}, antes de lançarmos o processo` };
  }

  // 3. A ÚNICA autorização: a criação lida é a identidade capturada.
  if (!expected.capturedCreated) {
    return {
      verdict: "unavailable",
      reason:
        `a identidade de criação do PID ${pid} não foi capturada no spawn: ` +
        `sem ela, o PID não prova que é o nosso processo`,
    };
  }
  const capturedMs = creationIdentityMs(expected.capturedCreated);
  if (capturedMs === null || capturedMs !== createdMs) {
    return {
      verdict: "foreign",
      reason:
        `o PID ${pid} foi criado às ${row.created} e a instância que lançámos nasceu às ` +
        `${expected.capturedCreated}: o PID foi reciclado`,
    };
  }
  return {
    verdict: "ours",
    reason: `PID ${pid} é a instância que lançámos (criada às ${row.created})`,
  };
}

/**
 * Nome do executável a partir de `tasklist /FO CSV /NH`.
 *
 * `tasklist` é o fallback quando não há PowerShell: 78 ms medidos, e apanha o
 * caso catastrófico (outro programa com o nosso PID). Não distingue dois
 * clamscan um do outro — para isso está a linha de comando.
 */
export function parseTasklistImageName(stdout: string, pid: number): string | null {
  for (const raw of String(stdout ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('"')) continue;
    const fields = line.split('","').map((f) => f.replace(/^"|"$/g, ""));
    if (fields.length < 2) continue;
    if (Number(fields[1]) !== pid) continue;
    const name = (fields[0] ?? "").trim();
    return name ? name : null;
  }
  return null;
}

/** Linha de identidade reduzida ao que o `tasklist` sabe dizer. */
function rowFromImageName(pid: number, name: string): ProcessIdentityRow {
  return { pid, ppid: 0, name, exe: null, created: "", cmd: null };
}

/**
 * Sonda de identidade do PID, em production.
 *
 * CIM primeiro; `tasklist` quando o CIM não responde. Nada de Interpolation de
 * dados do utilizador: o único valor que entra no comando é o PID, validado
 * como inteiro. Nomes de ficheiro e linhas de comando são comparados aqui em
 * JavaScript, nunca no PowerShell.
 */
export function createWindowsIdentityProbe(sync: typeof spawnSync = spawnSync): ProcessIdentityProbe {
  return (pid, budgetMs) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { row: null, probeFailed: true, detail: `PID inválido: ${pid}` };
    }

    // O orçamento que sobra é medido a partir de AGORA e é o mesmo para as DUAS
    // fontes: o fallback `tasklist` não pode herdar um tecto novo e fazer a
    // soma ultrapassar o que a resolução de identidade prometeu.
    const total = Math.max(1, Math.min(IDENTITY_PROBE_TIMEOUT_MS, budgetMs ?? IDENTITY_PROBE_TIMEOUT_MS));
    const startedAt = Date.now();
    const left = () => Math.max(1, total - (Date.now() - startedAt));

    const script = [
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
      "$ErrorActionPreference='SilentlyContinue';",
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';`,
      "if ($p) {",
      "  $c = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { '' };",
      "  [PSCustomObject]@{ pid=$p.ProcessId; ppid=$p.ParentProcessId; name=$p.Name;",
      "    exe=$p.ExecutablePath; created=$c; cmd=$p.CommandLine } | ConvertTo-Json -Compress",
      "}",
    ].join(" ");

    let res: ReturnType<typeof spawnSync>;
    try {
      res = sync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: left(),
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (err) {
      return readImageNameFallback(sync, pid, `PowerShell não correu: ${(err as Error).message}`, left());
    }
    if (res.error) return readImageNameFallback(sync, pid, `PowerShell: ${res.error.message}`, left());
    if (res.status !== 0) return readImageNameFallback(sync, pid, `PowerShell saiu com ${res.status}`, left());

    const text = String(res.stdout ?? "").trim();
    if (!text) return { row: null, probeFailed: false, detail: `o PID ${pid} não devolveu linha` };

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return readImageNameFallback(sync, pid, "saída do CIM não é JSON", left());
    }
    if (!parsed || typeof parsed !== "object" || Number(parsed.pid) !== pid) {
      return readImageNameFallback(sync, pid, "linha do CIM sem o PID pedido", left());
    }

    return {
      row: {
        pid: Number(parsed.pid),
        ppid: Number(parsed.ppid) || 0,
        name: String(parsed.name ?? ""),
        exe: typeof parsed.exe === "string" && parsed.exe ? parsed.exe : null,
        created: typeof parsed.created === "string" ? parsed.created : "",
        cmd: typeof parsed.cmd === "string" && parsed.cmd ? parsed.cmd : null,
      },
      probeFailed: false,
      detail: "CIM",
    };
  };
}

function readImageNameFallback(
  sync: typeof spawnSync,
  pid: number,
  detail: string,
  budgetMs = IDENTITY_PROBE_TIMEOUT_MS,
): ProcessIdentityReading {
  try {
    const res = sync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: Math.max(1, Math.min(IDENTITY_PROBE_TIMEOUT_MS, budgetMs)),
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.status === 0 && !res.error) {
      const name = parseTasklistImageName(String(res.stdout ?? ""), pid);
      if (name) return { row: rowFromImageName(pid, name), probeFailed: false, detail: `tasklist (${detail})` };
      if (String(res.stdout ?? "").trim() === "") {
        return { row: null, probeFailed: false, detail: `tasklist: o PID ${pid} não está em uso (${detail})` };
      }
    }
  } catch {
    /* o fallback também falhou */
  }
  return { row: null, probeFailed: true, detail };
}

/**
 * CAPTURA a identidade do filho que acabámos de lançar (A2).
 *
 * É a leitura que torna a identidade REAL. Sem ela, qualquer criação posterior
 * do mesmo PID passa por "é o nosso" — que é exactamente o que o Codex marcou:
 * o instante anterior ao spawn não é a identidade de nada.
 *
 * Porque é segura: no instante em que lemos, o Node ainda segura o handle do
 * processo que lançou, e um handle aberto impede o Windows de reciclar o PID.
 * Por isso o que lemos aqui é necessariamente a nossa instância — e a leitura
 * é ainda validada contra o que esperávamos antes de a guardar.
 *
 * Assíncrona (`execFileAsync`): um `spawnSync` custaria ~300 ms de event loop
 * parado em cada scan, e o deadline desta bridge é de 10 s.
 */
export function captureSpawnedIdentity(
  exec: typeof execFileAsync = execFileAsync,
): ProcessIdentityCapture {
  return async (pid, budgetMs) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { row: null, probeFailed: true, detail: `PID inválido: ${pid}` };
    }
    const script = [
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
      "$ErrorActionPreference='SilentlyContinue';",
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';`,
      "if ($p) {",
      "  $c = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { '' };",
      "  [PSCustomObject]@{ pid=$p.ProcessId; ppid=$p.ParentProcessId; name=$p.Name;",
      "    exe=$p.ExecutablePath; created=$c; cmd=$p.CommandLine } | ConvertTo-Json -Compress",
      "}",
    ].join(" ");
    try {
      const { stdout } = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: Math.max(1, Math.min(IDENTITY_PROBE_TIMEOUT_MS, budgetMs ?? IDENTITY_PROBE_TIMEOUT_MS)),
        maxBuffer: 1024 * 1024,
      });
      const text = String(stdout ?? "").trim();
      if (!text) return { row: null, probeFailed: false, detail: `o PID ${pid} não devolveu linha` };
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Number(parsed.pid) !== pid) {
        return { row: null, probeFailed: true, detail: "linha do CIM sem o PID pedido" };
      }
      return {
        row: {
          pid: Number(parsed.pid),
          ppid: Number(parsed.ppid) || 0,
          name: String(parsed.name ?? ""),
          exe: typeof parsed.exe === "string" && parsed.exe ? parsed.exe : null,
          created: typeof parsed.created === "string" ? parsed.created : "",
          cmd: typeof parsed.cmd === "string" && parsed.cmd ? parsed.cmd : null,
        },
        probeFailed: false,
        detail: "CIM (captura)",
      };
    } catch (err) {
      return { row: null, probeFailed: true, detail: `captura falhou: ${(err as Error).message}` };
    }
  };
}

/**
 * O Node JÁ viu este processo sair?
 *
 * `exitCode`/`signalCode` são escritos no callback de saída, ANTES do `close`:
 * um processo morto cujo `close` está atrasado (um neto segura o stdout) é
 * exactamente o caso em que `taskkill /T` passa a ser um tiro ao escuro. Não
 * são `undefined` numa primeira fase — daí o teste por TIPO e não por desigualdade.
 */
function childKnownExited(child: ChildProcess): boolean {
  return typeof child.exitCode === "number" || typeof child.signalCode === "string";
}

/**
 * Mata o processo E a descendência.
 *
 * `child.kill()` sozinho NÃO chega no Windows: o SIGTERM é entregue ao
 * processo directo e o clamscan, que carrega quase 1 GB antes de começar a
 * trabalhar, pode ficar por aí. Foi assim que o P0 deixou um clamscan vivo
 * com 988 MB muito depois de o código já terIOS unido "falhou".
 *
 * `child.kill()` corre SEMPRE e em qualquer veredicto: é o único caminho que
 * mata a raiz sem passar por um número. O `taskkill /T` — que é o que apanha a
 * descendência — só corre quando o PID ainda é o nosso filho.
 */
/**
 * Quantas vezes se tenta ler a identidade antes de desistir.
 *
 * Retry curto e bounded de propósito: duas tentativas suplentes com um atraso
 * pequeno. Um probe que falha uma vez pode falhar porque o CIM estava a
 * responder a outra coisa; mas um probe que continua a falhar não pode
 * transformar-se num timeout longo à frente de um `kill`.
 */
const IDENTITY_RETRY_DELAYS_MS = [120, 400] as const;

/**
 * Uma sonda que LANCA é uma sonda que falhou — nunca uma autorização.
 *
 * MEDIDO: sem isto, uma sonda injectada que atire rejeita a promise de
 * `killProcessTree`, e essa rejeição sai como `unhandledRejection`: o
 * `killTree()` já tinha armado o grace, mas o `deathUnconfirmed` nunca era
 * posto pela decisão, e o processo de morte ficava por decidir com uma
 * excepção a voar em paralelo. Numa bridge de vida longa isso é o
 * `unavailable` que se perde.
 *
 * O veredicto honesto de uma sonda que rebentou é `unavailable` — o mesmo de
 * uma sonda que não respondeu, e que por desenho NÃO mata. O `try/catch` não
 * é conveniência: é o contrato "UNKNOWN nunca mata" também para o modo de
 * falha.
 */
function probeSafely(
  probe: ProcessIdentityProbe,
  pid: number,
  budgetMs: number,
): ProcessIdentityReading {
  try {
    return probe(pid, budgetMs);
  } catch (err) {
    return { row: null, probeFailed: true, detail: `a sonda de identidade falhou: ${(err as Error).message}` };
  }
}

export type KillDecision = "killed" | "skipped-not-owned" | "skipped-unknown" | "already-gone";

/** O que a sessão de terminação por handle respondeu. */
export type InstanceTermination =
  | { verdict: "free"; detail: string }
  | { verdict: "killed"; rootKilled: boolean; descendants: number; refused: number; detail: string }
  | { verdict: "foreign"; created: string; detail: string }
  | { verdict: "unknown"; detail: string };

/**
 * ISO-8601 estrito. A identidade capturada vai para dentro de um script
 * PowerShell entre aspas simples, e um valor que não seja exactamente um
 * instante legível NÃO entra: recusar é a única resposta honesta.
 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * B9 — validar E terminar na MESMA referência (handle do SO).
 *
 * O defeito que a session anterior tinha: ler a identidade por CIM num processo
 * e DEPOIS chamar `taskkill /PID`. São dois pedidos ao SO separados por
 * centenas de milissegundos, e nesse intervalo o processo pode morrer e o Windows
 * reciclar o PID — o `/T` passa a matar a árvore de um programa do utilizador.
 *
 * O que fecha a corrida sem capacidade nativa nova:
 *
 *  - `Get-Process -Id N` devolve um `System.Diagnostics.Process`;
 *  - `$p.Handle` ABRE o handle do processo e o guarda no objecto;
 *  - enquanto esse handle estiver aberto, o Windows **não pode reciclar o PID**
 *    (o número só é reutilizado depois de o objecto de processo ser libertado,
 *    o que exige todos os handles fechados);
 *  - `$p.StartTime` e `$p.Kill()` usam **esse mesmo handle**
 *    (`TerminateProcess` sobre ele), não uma segunda busca por PID.
 *
* Portanto a validação e a terminação ficam vinculadas à mesma instância por
 * construção, e não porque o PID pareça o mesmo. É o mínimo que o utilizador
 * autorizou, e não exige binário novo, binding novo, export novo, schema
 * público novo, nem tocar no spawn ou no monitor de processos.
 *
 * A descendência é recolhida por PPID com a RAIZ ainda presa, e cada
 * descendente é validado (criação capturada na recolha) e morto no seu PRÓPRIO
 * handle — do mais fundo para o mais raso. `/T` desaparece: `taskkill` por PID
 * deixa de existir neste caminho.
 */
export function buildInstanceTerminationScript(pid: number, capturedCreated: string): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`PID inválido para terminação: ${pid}`);
  if (!ISO_UTC.test(capturedCreated)) throw new Error(`identidade de criação não é um instante ISO: ${capturedCreated}`);
  // Comparar em MILISEGUNDOS, nunca as strings ISO.
  //
  // MEDIDO nesta máquina: o CIM devolve `...T00:10:54.9347010Z` e o
  // `Process.StartTime` do handle devolve `...T00:10:54.9347015Z` para o MESMO
  // processo — 500 ns de diferença na última casa. Como instantes são
  // iguais (`Date.parse` das duas dá o mesmo ms); como texto, não. Uma
  // comparação de strings rejeitaria a nossa própria instância e deixaria o
  // clamscan órfão — exactamente o oposto do que se quer.
  const expectedMs = creationIdentityMs(capturedCreated);
  if (expectedMs === null) throw new Error(`identidade de criação ilegível: ${capturedCreated}`);
  return [
    "$ErrorActionPreference='SilentlyContinue';",
    "function Emit($o){ Write-Output ($o | ConvertTo-Json -Compress) };",
    // `Ticks` do .NET conta intervalos de 100 ns DESDE O ANO 1, não desde a
    // época Unix. Medido: `Ticks / 10000` dá 63926583186973 para um processo
    // criado agora, enquanto `Date.parse` do mesmo instante dá 1790986386973 —
    // e comparar os dois rejeitaria a nossa própria instância. A epoch Unix em
    // ticks é 621355968000000000; sem subtrair, nada bate.
    "function MsOf($proc){ try { return [long][math]::Floor(($proc.StartTime.ToUniversalTime().Ticks - ([DateTime]'1970-01-01T00:00:00').Ticks) / 10000) } catch { return [long]0 } };",
    `$root = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;`,
    "if (-not $root) { Emit @{v='free'}; exit 0 };",
    // Abre e guarda o handle: a partir daqui o PID não pode ser reciclado.
    "$null = $root.Handle;",
    "$rootMs = MsOf $root;",
    "if ($rootMs -eq 0) { Emit @{v='unknown'; why='a hora de criacao da raiz e ilegivel'}; exit 0 };",
    `if ($rootMs -ne ${expectedMs}) { Emit @{v='foreign'; created=$root.StartTime.ToUniversalTime().ToString('o')}; exit 0 };`,
    // Recolhe a descendência com a raiz presa, antes de matar seja o que for.
    // A recolha é em largura (breadth-first), logo o índice DECRESCente é
    // exactamente "do mais fundo para o mais raso" — sem `Sort-Object`, cuja
    // enumerable desalinhava os itens (PowerShell desenrola um array escrito
    // no pipeline, e as posições passavam a ser lidas erradas).
    "$plan = New-Object System.Collections.ArrayList;",
    "$seen = @{};",
    `$frontier = @(${pid});`,
    "for ($d = 0; $d -lt 16 -and $frontier.Count -gt 0; $d++) {",
    "  $next = @();",
    "  foreach ($parent in $frontier) {",
    '    foreach ($row in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent")) {',
    "      $cpid = 0; try { $cpid = [int]$row.ProcessId } catch { continue };",
    "      if ($cpid -le 0 -or $seen.ContainsKey($cpid)) { continue };",
    "      $seen[$cpid] = $true;",
    "      $cms = [long]0;",
    "      try { if ($row.CreationDate) { $cms = [long][math]::Floor(($row.CreationDate.ToUniversalTime().Ticks - ([DateTime]'1970-01-01T00:00:00').Ticks) / 10000) } } catch { };",
    "      if ($cms -gt 0) { $null = $plan.Add([PSCustomObject]@{ pid = $cpid; ms = $cms }) };",
    "      $next += $cpid;",
    "    }",
    "  }",
    "  $frontier = $next;",
    "};",
    // Do mais fundo para o mais raso, cada um no seu próprio handle.
    "$killed = 0; $refused = 0;",
    "for ($i = $plan.Count - 1; $i -ge 0; $i--) {",
    "  $entry = $plan[$i];",
    "  $proc = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue;",
    "  if (-not $proc) { continue };",
    "  $null = $proc.Handle;",
    "  $pms = MsOf $proc;",
    "  if ($pms -eq 0 -or $pms -ne $entry.ms) { $refused = $refused + 1; continue };",
    "  $null = $proc.Kill();",
    "  $killed = $killed + 1;",
    "};",
    "$rootKilled = $false;",
    "try { $null = $root.Kill(); $rootKilled = $true } catch { };",
    "Emit @{v='killed'; root=$rootKilled; descendants=$killed; refused=$refused};",
  ].join(" ");
}

/**
 * Executa a sessão de terminação validada por handle.
 *
 * Nunca lança e nunca autoriza nada por si: devolve o que o Windows respondeu
 * sobre AQUELA instância. Uma sessão que não corre, não responde ou devolve
 * lixo é `unknown` — que nunca mata.
 */
export function terminateVerifiedInstance(
  sync: typeof spawnSync,
  pid: number,
  capturedCreated: string,
): InstanceTermination {
  let script: string;
  try {
    script = buildInstanceTerminationScript(pid, capturedCreated);
  } catch (err) {
    return { verdict: "unknown", detail: `identidade não utilizável: ${(err as Error).message}` };
  }
  let res: ReturnType<typeof spawnSync>;
  try {
    res = sync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: IDENTITY_TERMINATE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    return { verdict: "unknown", detail: `a sessão de terminação não correu: ${(err as Error).message}` };
  }
  if (res.error) return { verdict: "unknown", detail: `a sessão de terminação: ${res.error.message}` };
  if (res.status !== 0) return { verdict: "unknown", detail: `a sessão de terminação saiu com ${res.status}` };

  const text = String(res.stdout ?? "").trim();
  if (!text) return { verdict: "unknown", detail: "a sessão de terminação não respondeu" };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.split(/\r?\n/).filter(Boolean).pop() ?? "") as Record<string, unknown>;
  } catch {
    return { verdict: "unknown", detail: "a sessão de terminação não devolveu JSON" };
  }
  const v = String(parsed?.v ?? "");
  if (v === "free") return { verdict: "free", detail: "o PID não está em uso" };
  if (v === "foreign") {
    return { verdict: "foreign", created: String(parsed.created ?? ""), detail: "a identidade do PID não é a nossa" };
  }
  if (v === "killed") {
    return {
      verdict: "killed",
      rootKilled: parsed.root === true,
      descendants: Number(parsed.descendants ?? 0) || 0,
      refused: Number(parsed.refused ?? 0) || 0,
      detail: "terminado pela referência verificada",
    };
  }
  return { verdict: "unknown", detail: `a sessão de terminação respondeu '${v || "(vazio)"}'` };
}

/**
 * Matar o processo E a descendência, tiedos à instância validada.
 *
 * `child.kill()` sozinho NÃO chega no Windows: o SIGTERM é entregue ao processo
 * directo e o clamscan, que carrega quase 1 GB antes de começar a trabalhar,
 * pode ficar por aí. Foi assim que o P0 deixou um clamscan vivo com 988 MB
 * muito depois de o código já ter reportado "falhou".
 *
 * A raiz é morta pelo handle verificado; o `child.kill()` no fim é a rede de
 * segurança do Node (usa o handle do libuv, não um número). O `taskkill /T`
 * foi REMOVIDO: `taskkillTree` não existe mais neste caminho, e a descendência é
 * recolhida e terminada dentro da mesma sessão de handle.
 */
function killProcessTree(
  child: ChildProcess,
  sync: typeof spawnSync,
  probe: ProcessIdentityProbe,
  expected: ExpectedProcessIdentity,
  sleep: (ms: number) => Promise<void>,
  captureReady: Promise<void>,
): Promise<KillDecision> {
  const pid = typeof child.pid === "number" ? child.pid : -1;

  const resolveIdentity = async (): Promise<ProcessIdentityResult> => {
    // A captura do spawn tem de estar RESOLVIDA antes de decidir: sem
    // `capturedCreated` a classificação é `unavailable` por desenho, e isso é
    // o contrato — não um detalhe de implementação.
    await captureReady.catch(() => undefined);

    let last: ProcessIdentityResult = { verdict: "unavailable", reason: "a leitura de identidade nunca correu" };
    const deadline = Date.now() + IDENTITY_RESOLUTION_BUDGET_MS;
    for (let attempt = 0; attempt <= IDENTITY_RETRY_DELAYS_MS.length; attempt++) {
      // O processo já ter saído é EVIDÊNCIA de que o PID deixou de existir:
      // não se valida CreationDate de um processo que não existe.
      if (childKnownExited(child)) {
        return { verdict: "free", reason: "o processo já tinha saído" };
      }
      if (pid <= 0) {
        return { verdict: "unavailable", reason: "o filho não tem PID utilizável" };
      }
      const remaining = deadline - Date.now();
      // A primeira leitura corre sempre; as seguintes só se ainda houver
      // orçamento. É o que impede as ~15 s síncronas que o orçamento anterior
      // escondia.
      if (attempt > 0 && remaining <= 0) break;
      const reading = probeSafely(probe, pid, remaining);
      last = classifyProcessIdentity({
        pid,
        row: reading.row,
        expected,
        selfPid: process.pid,
        probeFailed: reading.probeFailed,
      });
      // Só `unavailable` vale a pena repetir. Os outros veredictos são
      // conclusões, não falta de informação.
      if (last.verdict !== "unavailable") return last;
      const delay = IDENTITY_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      // Um atraso que já não cabe no orçamento não é esperado: cortar aqui é
      // respeitar o orçamento, não falhar a retry.
      if (Date.now() + delay >= deadline) break;
      await sleep(delay);
    }
    return {
      verdict: "unavailable",
      reason: `${last.reason} (orçamento de ${IDENTITY_RESOLUTION_BUDGET_MS} ms esgotado)`,
    };
  };

  return resolveIdentity().then(async (identity) => {
    switch (identity.verdict) {
      case "free":
        // O PID deixou de existir: o cleanup está feito, não há o que matar.
        return "already-gone" as const;
      case "ours": {
        // `ours` só é possível com `capturedCreated` presente. Se mesmo assim
        // não existe, o veredicto não se sustenta e não se mata.
        const captured = expected.capturedCreated;
        if (!captured) return "skipped-unknown" as const;
        // A acção decorre sobre a MESMA referência que foi validada.
        const outcome = terminateVerifiedInstance(sync, pid, captured);
        if (outcome.verdict === "free") return "already-gone" as const;
        if (outcome.verdict === "foreign") return "skipped-not-owned" as const;
        if (outcome.verdict === "unknown") return "skipped-unknown" as const;
        try {
          child.kill("SIGKILL");
        } catch {
          /* já morreu — a raiz foi morta pela referência verificada */
        }
        return "killed" as const;
      }
      case "foreign":
        // EVIDÊNCIA de que não é nosso. Nunca tocar.
        return "skipped-not-owned" as const;
      case "unavailable":
      default:
        // DECISÃO DO UTILIZADOR (2026-10-03): sem identidade confirmada, NÃO
        // se mata. Um processo externo do utilizador é pior do que um processo
        // pesado sem confirmação — o clamscan órfão é detectado como
        // `poisoned` e o scan seguinte responde `unavailable`, que é um estado
        // HONESTO. Matar às cegas não é.
        return "skipped-unknown" as const;
    }
  });
}

/**
 * Espera curta e bounded entre tentativas de leitura de identidade.
 *
 * Existe para ser SUBSTITUÍVEL num teste, que é a única forma de testar o
 * retry sem gastar segundos. Não é um timeout de nada: o retry total é
 * 120 ms + 400 ms.
 */
function delayFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Seam de teste do PROCESSO: como o `spawnClamav` cria o filho e como mata a
 * descendência. A produção nunca injecta nada — `spawnClamav` é esta fábrica sem
 * argumentos, com o `spawn` e o `taskkill` reais.
 *
 * Existe por uma razão concreta: o caminho em que o clamscan NÃO MORRE (o
 * `taskkill` falha e o `kill()` devolve falso) é o caminho em que o cap é
 *\libertado sem prova de morte. Reproduzi-lo com o binário real exigiria um
 * clamscan de ~1 GB que se recusa a morrer — impossível de fabricar, e o teste
 * tem de ser exacto.
 */
export interface ClamavProcessHooks {
  spawn?: typeof spawn;
  spawnSync?: typeof spawnSync;
  /**
   * Como se lê a identidade do PID antes de o matar. Sem isto, a identidade é
   * lida pelo CIM de verdade.
   *
   * Um `spawnSync` injectado SEM sonda é um seam de ISOLAMENTO: nenhum
   * processo real é lançado, a leitura é marcada como falhada e o `taskkill`
   * corre como sempre. Quem quiser testar a protecção injecta a LINHA que o CIM
   * devolveria — o veredicto é sempre lógica de produção.
   */
  probeIdentity?: ProcessIdentityProbe;
  /**
   * Como se CAPTURA a identidade do filho imediatamente após o spawn (A2).
   *
   * Quando não é injectada e há `probeIdentity`, a captura usa a MESMA sonda
   * envolvida numa Promise: um teste passa a descrever a leitura do SO num
   * instante, e a captura e a decisão leem desse mesmo instante. A produção
   * (sem hooks) usa `captureSpawnedIdentity`, que é assíncrona de propósito.
   */
  captureIdentity?: ProcessIdentityCapture;
}

export function createSpawnClamav(hooks: ClamavProcessHooks = {}): ClamavSpawnFn {
  const spawnFn = hooks.spawn ?? spawn;
  const syncFn = hooks.spawnSync ?? spawnSync;
  const probeFn: ProcessIdentityProbe =
    hooks.probeIdentity ??
    (hooks.spawnSync
      ? () => ({ row: null, probeFailed: true, detail: "seam de processo injectado: identidade não lida" })
      : createWindowsIdentityProbe(syncFn));
  const captureFn: ProcessIdentityCapture =
    hooks.captureIdentity ??
    (hooks.probeIdentity
      ? (pid, budgetMs) => Promise.resolve(hooks.probeIdentity!(pid, budgetMs))
      : hooks.spawnSync
        ? () => Promise.resolve({ row: null, probeFailed: true, detail: "seam de processo injectado: identidade não capturada" })
        : captureSpawnedIdentity());
  return (file, args, request) => {
  // Antes do spawn: é o limite inferior do CreationDate do filho. NÃO é
  // identidade — a identidade é a que `captureReady` traz.
  const spawnedAtMs = Date.now();
  const expected = expectedIdentityFor(file, args, spawnedAtMs);
  scanPerfLog("CLAMSCAN_SPAWN_CALL_BEGIN", request.scanId, `argCount=${args.length} argvChars=${argvChars(args)}`);
  let child: ChildProcess;
  try {
    child = spawnFn(file, args, { windowsHide: request.windowsHide, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code ?? "unknown";
    scanPerfLog("CLAMSCAN_SPAWN_CALL_THROW", request.scanId, `code=${String(code)}`);
    throw error;
  }
  scanPerfLog("CHILD_SPAWN_RETURN", request.scanId, `pid=${child.pid ?? "unknown"}`);
  child.once("spawn", () => {
    scanPerfLog("CHILD_SPAWN_EVENT", request.scanId, `pid=${child.pid ?? "unknown"}`);
  });
  trackClamavPid(child.pid);
  scanPerfLog("CLAMSCAN_PID", request.scanId, `pid=${child.pid ?? "unknown"} executable=${path.basename(file)}`);

  /**
   * A IDENTIDADE REAL do filho, capturada do SO (A2).
   *
   * Três condições para guardar o que foi lido, e as três são de identidade,
   * não de conveniência:
   *  - o Node ainda não viu o processo sair (enquanto o handle do libuv está
   *    aberto, o Windows não recicla o PID — logo o que lemos é o nosso);
   *  - a leitura não contradiz o que esperávamos antes do spawn;
   *  - a CreationDate é legível.
   *
   * Se qualquer uma falhar, `expected.capturedCreated` fica por preencher e
   * TODA decisão posterior é `unavailable` — que não mata e envenena a vaga.
   * É o preço declarado do contrato: identidade real, ou nenhuma.
   */
  const captureReady: Promise<void> = (async () => {
    const pid = child.pid;
    if (typeof pid !== "number" || pid <= 0) return;
    let reading: ProcessIdentityReading;
    try {
      reading = await captureFn(pid, IDENTITY_PROBE_TIMEOUT_MS);
    } catch {
      return;
    }
    if (childKnownExited(child)) return;
    const row = reading.row;
    if (!row || reading.probeFailed || row.pid !== pid) return;
    if (identityContradiction({ pid, row, expected, selfPid: process.pid })) return;
    if (!exeStem(row.name)) return;
    if (creationIdentityMs(row.created) === null) return;
    expected.capturedCreated = row.created;
  })();

  let stderr = "";
  let stdout = "";
  let settled = false;
  let killed = false;
  // Passou a tolerância do kill e ninguém confirmou a morte. A vaga fica presa
  // (ver `poisonClamavSlot`) até o `close` chegar.
  let deathUnconfirmed = false;
  /** CODEX: a lease da base espera pela prova de morte, nao pela desistência. */
  const deathConfirmedCallbacks: Array<() => void> = [];
  let deathConfirmedNotified = false;
  let graceTimer: NodeJS.Timeout | null = null;
  /** A decisão de kill em curso (A10): uma só por handle. */
  let killDecision: Promise<KillDecision> | null = null;
  let resolveOutcome!: (outcome: ClamavSpawnOutcome) => void;
  const outcome = new Promise<ClamavSpawnOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  // Diagnostic counters (only active under CYBERSAFE_DEBUG_SCAN=1).
  let firstStdoutLogged = false;
  let firstStderrLogged = false;
  let firstResultLogged = false;
  let onProgressCalls = 0;

  const finish = (code: number | null) => {
    if (settled) return;
    settled = true;
    if (graceTimer) clearTimeout(graceTimer);
    flushDecoders();
    untrackClamavPid(child.pid);
    // `timedOut` vive no outcome para o diagnóstico; quem decide se foi timeout
    // é a bridge, que é quem passou o deadline.
    resolveOutcome({
      code,
      stdout,
      stderr,
      timedOut: killed && code === null,
      killed,
      ...(deathUnconfirmed ? { deathUnconfirmed: true } : {}),
    });
    scanPerfLog(
      "CLAMAV_CHILD_TERMINAL",
      request.scanId,
      `pid=${child.pid ?? "unknown"} code=${code} killed=${killed} deathUnconfirmed=${deathUnconfirmed} onProgressCalls=${onProgressCalls} elapsedMs=${Date.now() - spawnedAtMs}`,
    );
  };

  // Descodificar POR CHUNK corrompe o texto: um caractere multibyte partido
  // entre dois chunks (0xC3 no fim de um, 0xA3 no início do seguinte) vira
  // U+FFFD, o caminho impresso deixa de casar com o que pedimos, a linha FOUND
  // deixa de ser atribuída — e o ficheiro pode sair `clean` sem nenhuma
  // evidência. O `StringDecoder` guarda os bytes a meio de sequência e só os
  // decide no chunk seguinte; o `end()` no fecho trata a cauda.
  const stderrDecoder = new StringDecoder("utf8");
  const stdoutDecoder = new StringDecoder("utf8");
  let decodersEnded = false;
  const flushDecoders = () => {
    if (decodersEnded) return;
    decodersEnded = true;
    stderr += stderrDecoder.end();
    const stdoutTail = stdoutDecoder.end();
    if (stdout.length < MAX_CAPTURED_OUTPUT) stdout += stdoutTail;
    // O último resultado pode chegar sem newline. `close` confirma que não
    // haverá outro chunk, por isso esta cauda pode finalmente ser contada.
    if (request.onProgress) progressoClamav(request.onProgress, stdoutTail, true);
  };

  child.stderr?.on("data", (chunk) => {
    stderr += stderrDecoder.write(chunk as Buffer);
    if (!firstStderrLogged) {
      firstStderrLogged = true;
      scanPerfLog("STDERR_FIRST_CHUNK", request.scanId, `pid=${child.pid ?? "unknown"} bytes=${chunk.length}`);
    }
  });
  // O stdout é ACUMULADO, não descartado. Descartá-lo era o que tornava
  // impossível saber se o clamscan tinha detectado alguma coisa: a linha
  // `FOUND` vai para o stdout, e sem ela um exit 1 não se distinguia de um
  // erro. Acumular também drena o pipe, que é o que evita o clamscan bloquear
  // a falar. O tecto existe para que um output patológico não coma a RAM — o
  // P0 desta bridge.
  child.stdout?.on("data", (chunk) => {
    if (!firstStdoutLogged) {
      firstStdoutLogged = true;
      scanPerfLog("STDOUT_FIRST_CHUNK", request.scanId, `pid=${child.pid ?? "unknown"} bytes=${chunk.length}`);
    }
    const decoded = stdoutDecoder.write(chunk as Buffer);
    if (stdout.length < MAX_CAPTURED_OUTPUT) stdout += decoded;
    if (request.onProgress) progressoClamav(request.onProgress, decoded);
  });

  /**
   * CONTAGEM DE FICHEIROS JÁ ANALISADOS, a partir do stdout do clamscan.
   *
   * O clamscan escreve UMA LINHA por ficheiro que termina de varrer:
   * `<caminho>: OK` quando está limpo, `<caminho>: <assinatura> FOUND` quando
   * não está. A linha existe = o ficheiro foi avaliado. E' a MESMA evidencia
   * que `parseClamavOutput` usa para dar `clean`, aqui só para contar — e é por
   * isso que o número é honesto: nunca é um temporizador, nunca é uma
   * interpolação de "deve estar quase", é o que o motor disse.
   *
   * O bloco `SCAN SUMMARY` (e o `STDERR`/`ERROR` que o antecede) NAO contam:
   * `Scanned files: 4` e `Infected files: 1` não são ficheiros avaliados um a
   * um, e contá-los inventaria trabalho.
   *
   * O resto de uma linha fica em `progressoPendente` entre chunks: partir uma
   * linha ao meio contaria meio ficheiro e depois outro.
   */
  let progressoPendente = "";
  let progressoContados = 0;
  const progressoClamav = (onProgress: (n: number) => void, chunk: string, final = false) => {
    const texto = progressoPendente + chunk;
    const linhas = texto.split("\n");
    // Antes de `close`, a última linha pode continuar a crescer no chunk
    // seguinte. No fecho já não haverá outro chunk: consome-se também a cauda.
    progressoPendente = final ? "" : (linhas.pop() ?? "");
    for (const raw of linhas) {
      const linha = raw.trim();
      if (linha === "") continue;
      if (/^-+\s*(SCAN SUMMARY|SCAN STATISTICS)/i.test(linha)) return;
      // `ERROR` e `WARNING` sao do stderr do clamscan, nunca ficheiros
      // avaliados com sucesso.
      if (/^(ERROR|WARNING)/i.test(linha)) continue;
      const isCleanResult = /:\s*OK\s*$/i.test(linha);
      const isDetectedResult = /\s+FOUND\s*$/i.test(linha);
      if (isCleanResult || isDetectedResult) {
        progressoContados++;
        if (!firstResultLogged) {
          firstResultLogged = true;
          scanPerfLog(
            "STDOUT_FIRST_COMPLETE_RESULT",
            request.scanId,
            `pid=${child.pid ?? "unknown"} kind=${isDetectedResult ? "found" : "ok"} count=1 chars=${linha.length}`,
          );
        }
        onProgressCalls++;
        if (onProgressCalls === 1) {
          scanPerfLog("ON_PROGRESS_FIRST", request.scanId, `pid=${child.pid ?? "unknown"} count=${progressoContados}`);
        }
        onProgress(progressoContados);
      }
    }
  };

  // CODEX (2026-10-03), achado 1: `error` NÃO É PROVA DE MORTE.
  //
  // O Node emite `error` também quando não consegue MATAR o filho, e não só
  // quando o spawn falha. Resolver o outcome aqui libertava a vaga E a lease da
  // base com o clamscan ainda vivo — e o freshclam arrancava por cima dele. O
  // Codex reproduziu a sobreposição em 10 de 10 rondas.
  //
  // A distinção é o PID: sem `child.pid` o processo nunca nasceu e nada está a
  // usar a base. Com `child.pid` há processo, e quem traz a prova de que acabou
  // é o `close` — ou, na falta dele, o temporizador de tolerância, que marca
  // `deathUnconfirmed` e deixa a vaga e a lease presas.
  child.on("error", (err: Error) => {
    const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
    scanPerfLog("CHILD_ERROR_EVENT", request.scanId, `pid=${child.pid ?? "unknown"} code=${String(code)}`);
    stderr += err.message;
    if (child.pid === undefined) {
      finish(null);
      return;
    }
    deathUnconfirmed = true;
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(() => finish(null), DEFAULT_KILL_GRACE_MS);
  });
  // `close` só dispara quando o processo morreu DE FACTO — nunca no momento
  // em que pedimos para o matar. É isto que impede o cap de libertar a vaga
  // enquanto o filho ainda detém ~1 GB.
  child.on("exit", (code, signal) => {
    scanPerfLog("CHILD_EXIT", request.scanId, `pid=${child.pid ?? "unknown"} code=${code} signal=${signal ?? "none"}`);
  });
  child.on("close", (code, signal) => {
    scanPerfLog("CHILD_CLOSE", request.scanId, `pid=${child.pid ?? "unknown"} code=${code} signal=${signal ?? "none"}`);
    // `close` é o fim do pipe: a cauda de uma sequência multibyte decide-se aqui.
    flushDecoders();
    // O SO acabou de confirmar a morte. A lease da base é libertada AQUI, e não
    // no fim do scan que desistiu de a esperar (ver `onDeathConfirmed`).
    if (!deathConfirmedNotified) {
      deathConfirmedNotified = true;
      const callbacks = deathConfirmedCallbacks.splice(0);
      for (const cb of callbacks) {
        try {
          cb();
        } catch {
          /* um subscriber que rebenta nao pode travar os outros */
        }
      }
    }
    // `close` É a prova do SO. O que se faz com a marca `deathUnconfirmed`
    // depende de UMA coisa: se o outcome JÁ tinha resolvido.
    //
    // CODEX (2026-10-03), achados 6 e P0. Os dois bugs moraram no mesmo sitio.
    //
    // O achado 6 era: com um `error` a marcar a morte como não confirmada e um
    // `close` a chegar ANTES do grace expirar, o `finish` resolvia o outcome
    // com a marca ainda posta, e o `finally` da bridge envenenava a vaga de um
    // processo que já estava morto — motor indisponível para sempre.
    //
    // O P0 que a minha primeira correcção introduziu: chamar
    // `releasePoisonedClamavSlot()` sem unguardo. Essa função decrementa
    // `active` INCONDICIONALMENTE, e a vaga nunca tinha sido envenenada — dois
    // clamscans vivos com o limite declarado a 1. Que era o P0 original, de
    // volta, pela porta da correcção.
    //
    // A ordem dos factos é o que garante isto: o grace chama `finish` de forma
    // SÍNCRONA, a continuação da bridge fica como microtarefa, e um `close` é um
    // evento de I/O — uma macrotarefa. As microtarefas correm todas antes. Se
    // `settled` é verdadeiro, o `finally` da bridge JÁ envenenou a vaga; se não
    // é, a vaga nunca foi envenenada e não há poison para libertar.
    if (settled) {
      // O grace já resolveu e o `finally` já envenenou: este `close` é a prova
      // que faltava, e a vaga volta à circulação.
      if (deathUnconfirmed) {
        deathUnconfirmed = false;
        releasePoisonedClamavSlot();
      }
      return;
    }

    // O `close` chegou antes de o grace expirar. O processo morreu de facto, e
    // a marca tem de cair AQUI — senão o `finally` envenena a vaga de um
    // processo morto. Limpar a marca faz o `finally` tomar o ramo
    // `releaseClamavSlot()`, que é o correcto. Não se toca na vaga envenenada:
    // nunca houve poison, e libertá-la decrementaria `active` a mais.
    deathUnconfirmed = false;
    finish(code);
  });

return {
      pid: child.pid,
      onDeathConfirmed: (onConfirmed: () => void) => {
        if (deathConfirmedNotified) {
          // A morte ja foi confirmada antes de este registo: o que se perde e o
          // PRIMEIRO subscriber, nao a prova. O segundo tem de correr na mesma.
          onConfirmed();
          return;
        }
        deathConfirmedCallbacks.push(onConfirmed);
      },
      killTree: () => {
        if (settled) return;
        killed = true;
        // A10 — UMA decisão de kill em curso por handle.
        //
        // O guard `settled` só actua DEPOIS da conclusão. Entre o `killTree()` e
        // a promise resolver, um `abort()`, um `dispose()` ou o deadline podem
        // chamar `killTree()` outra vez e repetir as sondas — e, se o veredicto
        // ainda não chegou, repetir também o kill. A decisão é guardada aqui e
        // reutilizada; o grace é armado UMA vez só.
        if (!killDecision) {
          killDecision = killProcessTree(child, syncFn, probeFn, expected, (ms) => delayFor(ms), captureReady);
          void killDecision.then((decision) => {
            // `skipped-unknown` e `skipped-not-owned` significam o MESMO para o
            // semáforo: não sabemos que o processo morreu, logo a vaga fica
            // `poisoned` e o scan seguinte responde `unavailable` em vez de fingir.
            // `already-gone` é o único caso limpo — o PID deixou de existir.
            if (decision === "killed") return;
            if (decision === "already-gone") return;
            deathUnconfirmed = true;
          });
          // Rede de segurança: se a terminação não resultar, a promise não fica
          // presa para sempre — resolve, mas MARCANDO que a morte não foi
          // confirmada. É essa marca que impede a bridge de libertar a vaga com
          // o processo ainda vivo (2 clamscans × ~1 GB = o P0 original).
          if (graceTimer) clearTimeout(graceTimer);
          graceTimer = setTimeout(() => {
            deathUnconfirmed = true;
            finish(null);
          }, DEFAULT_KILL_GRACE_MS);
        }
      },
      outcome,
    };
  };
}

/**
 * Spawner real: um clamscan. O deadline é imposto pela bridge, que chama
 * `killTree()`.
 *
 * Os `hooks` são aceites aqui para que um teste possa injectar o processo sem
 * passar pela fábrica — e são USADOS. Antes esta função era a fábrica sem
 * argumentos, o que descartava um 4.º argumento em silêncio: um teste que
 * pedisse um filho simulado acabava por lançar o clamscan de VERDADE. Um seam
 * que finge injectar é pior do que não haver seam.
 */
export const spawnClamav: ClamavSpawnFn = (file, args, request, hooks) =>
  createSpawnClamav(hooks ?? {})(file, args, request);

export type ClamavDbSource = "explicit" | "app-definitions" | "clamconf" | "platform-default" | "packaged-fallback";
export type ClamavDbState = "missing" | "unreadable" | "empty" | "ready";

/** Um directório candidato onde a base de assinaturas pode viver. */
export interface ClamavDbCandidate {
  dir: string;
  source: ClamavDbSource;
  /** `missing` = não existe; `unreadable` = existe mas não se lê; `empty` = existe sem assinaturas. */
  state: ClamavDbState;
  signatureFiles: string[];
  /** mtime do ficheiro de assinaturas mais recente; 0 quando desconhecido. */
  newestMtimeMs: number;
  error?: string;
}

export interface ClamavProbeFacts {
  /** stdout de `clamscan --version`; null quando o comando falhou/não existe. */
  versionOutput: string | null;
  versionError?: string;
  /** Database directory resolvido do `clamconf -n` (null = desconhecido). */
  dbDir: string | null;
  /** Ficheiros do diretório; null = ilegível/inexistente. */
  dbFiles: string[] | null;
  /**
   * Candidatos já sondados. Quando presente tem precedência sobre
   * `dbDir`/`dbFiles`, que se mantêm para compatibilidade.
   */
  candidates?: ClamavDbCandidate[];
  /** Instante de referência para a frescura; default Date.now(). */
  now?: number;
  /** Idade máxima aceite das assinaturas. */
  maxSignatureAgeMs?: number;
}

/**
 * Ficheiros que o libclamav carrega como base de assinaturas.
 *
 * MEDIDO (2026-10-22): uma pasta com uma única `.ndb` nossa é carregada pelo
 * `clamscan --database=<pasta>` (`Known viruses: 1`) e deteta o marcador. A
 * versão anterior só reconhecia arquivos `.cvd/.cld/.cuv/.cud`, portanto essa
 * pasta era classificada `empty`; o bridge caía para a base da app e ficava
 * `active` — a reportar cobertura de uma base que o chamador NÃO pediu e que o
 * scan não usou. `datadir` é documentado como prioridade máxima; ignorá-lo em
 * silêncio era a mesma classe de mentira que o resto deste ficheiro evita.
 */
const DB_FILE_PATTERN = /\.(cvd|cld|cuv|cud|ndb|hdb|hsb|ldb|cdb|sdb|mdb|msb)$/i;

/**
 * Arquivos oficiais assinados. Uma base só com assinaturas locais (`.ndb`, …)
 * faz o motor ANALISAR, mas não é a cobertura de produção — é `degraded`.
 */
const DB_ARCHIVE_PATTERN = /\.(cvd|cld|cuv|cud)$/i;

/** Definições com mais de 7 dias estão mortas na prática (o ClamAV actualiza daily). */
export const SIGNATURE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Directório onde a app mantém a SUA base (ver service/src/updater.ts: freshclam --datadir). */
export function appClamavDatabaseDir(definitionsDir?: string): string {
  const base = definitionsDir ?? path.join(os.homedir(), ".cybersafe-service", "definitions");
  return path.join(base, "clamav");
}

/** Localização padrão da plataforma, usada como último recurso. */
export function platformClamavDatabaseDir(): string | null {
  if (process.platform === "win32") {
    const programData = process.env.ProgramData;
    return programData ? path.join(programData, "clamav") : null;
  }
  return "/var/lib/clamav";
}

function ageInDays(ms: number): number {
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function isSignatureFile(name: string): boolean {
  return DB_FILE_PATTERN.test(name);
}

/**
 * Escolhe o directório de assinaturas a usar.
 *
 * Regra de verdade: **sem ficheiros .cvd/.cld/.cuv/.cud não há deteção
 * real** — o binário responder não chega. O primeiro candidato `ready` vence;
 * na falta dele escolhe-se o mais informativo para o diagnóstico
 * (`unreadable` > `empty` > `missing`).
 */
export function selectDatabaseCandidate(candidates: ClamavDbCandidate[]): ClamavDbCandidate | null {
  const ready = candidates.find((c) => c.state === "ready");
  if (ready) return ready;
  const unreadable = candidates.find((c) => c.state === "unreadable");
  if (unreadable) return unreadable;
  const empty = candidates.find((c) => c.state === "empty");
  if (empty) return empty;
  return candidates[0] ?? null;
}

/** Classificação por candidatos — o caminho usado pelo probe real. */
function classifyWithCandidates(facts: ClamavProbeFacts): { available: boolean; health: EngineSubsystemHealth } {
  const now = facts.now ?? Date.now();
  const maxAge = facts.maxSignatureAgeMs ?? SIGNATURE_MAX_AGE_MS;
  const candidates = facts.candidates ?? [];

  if (candidates.length === 0) {
    return {
      available: false,
      health: {
        status: "degraded",
        detail: "ClamAV instalado mas nenhum directório de base de assinaturas pôde ser resolvido",
      },
    };
  }

  const chosen = selectDatabaseCandidate(candidates);
  if (!chosen) {
    return {
      available: false,
      health: { status: "degraded", detail: "ClamAV instalado mas sem directório de base de assinaturas" },
    };
  }

  if (chosen.state === "unreadable") {
    return {
      available: false,
      health: {
        status: "degraded",
        detail: `ClamAV instalado mas a base de assinaturas não é legível: ${chosen.dir} (${chosen.error ?? "permissões"})`,
      },
    };
  }

  if (chosen.state !== "ready") {
    // `empty` (o directório existe mas está sem assinaturas) ou `missing`.
    const tried = candidates.map((c) => c.dir).join(", ");
    const because = chosen.state === "empty" ? "existe mas está vazio" : "não existe";
    return {
      available: false,
      health: {
        status: "degraded",
        detail: `ClamAV instalado mas sem base de assinaturas — ${chosen.dir} ${because} (verificados: ${tried}); corre freshclam`,
      },
    };
  }

  // `ready`: só é `active` se houver ficheiros de assinatura E não estiverem
  // envelhecidos. `ready` com zero ficheiros é tratado como `empty` — active
  // exige assinaturas, sempre.
  const count = chosen.signatureFiles.filter(isSignatureFile).length;
  const archives = chosen.signatureFiles.filter((name) => DB_ARCHIVE_PATTERN.test(name)).length;
  if (count === 0) {
    const tried = candidates.map((c) => c.dir).join(", ");
    return {
      available: false,
      health: {
        status: "degraded",
        detail: `ClamAV instalado mas sem base de assinaturas — ${chosen.dir} não tem ficheiros .cvd/.cld (verificados: ${tried}); corre freshclam`,
      },
    };
  }
  if (archives === 0) {
    // Motor UTILIZÁVEL (carrega e analisa), cobertura NÃO oficial. Devolver
    // `active` aqui seria chamar cobertura de produção a um punhado de
    // assinaturas locais — o mesmo erro que `active` sem `.cvd` já evitava.
    return {
      available: true,
      health: {
        status: "degraded",
        detail: `ClamAV carrega ${count} assinatura(s) local(is) em ${chosen.dir}, sem base oficial (.cvd/.cld) — o motor analisa, a cobertura é limitada; corre freshclam`,
      },
    };
  }
  if (chosen.newestMtimeMs > 0 && now - chosen.newestMtimeMs > maxAge) {
    return {
      available: false,
      health: {
        status: "degraded",
        detail: `ClamAV com ${count} signature database file(s) em ${chosen.dir} mas as definições têm ${ageInDays(now - chosen.newestMtimeMs)} dia(s) — corra freshclam`,
      },
    };
  }

  return {
    available: true,
    health: { status: "active", detail: `ClamAV binary available (${count} signature database file(s))` },
  };
}

/**
 * Classificação pura do health do ClamAV. Regra de verdade: **sem base de
 * assinaturas não há deteção real** — o binário responder (`clamscan
 * --version`) não chega; é preciso encontrar .cvd/.cld no database dir.
 * Nunca devolve `active` sem definições.
 *
 * `dbDir`/`dbFiles` são o formato legado; `candidates` (com frescura por
 * ficheiro) tem precedência quando presente.
 */
export function classifyClamavHealth(facts: ClamavProbeFacts): { available: boolean; health: EngineSubsystemHealth } {
  if (facts.versionOutput === null) {
    return {
      available: false,
      health: { status: "unavailable", detail: `clamscan not found or failed: ${facts.versionError ?? "unknown"}` },
    };
  }
  if (!facts.versionOutput.includes("ClamAV")) {
    return { available: false, health: { status: "unavailable", detail: "clamscan --version did not report ClamAV" } };
  }
  if (facts.candidates) {
    return classifyWithCandidates(facts);
  }
  if (!facts.dbDir) {
    return {
      available: false,
      health: { status: "degraded", detail: "ClamAV binary available but database directory is unknown (check clamconf)" },
    };
  }
  if (facts.dbFiles === null) {
    return {
      available: false,
      health: { status: "degraded", detail: `ClamAV installed but database dir not readable: ${facts.dbDir} (run freshclam)` },
    };
  }
  const dbs = facts.dbFiles.filter((entry) => DB_FILE_PATTERN.test(entry));
  if (dbs.length > 0 && !dbs.some((entry) => DB_ARCHIVE_PATTERN.test(entry))) {
    return {
      available: true,
      health: {
        status: "degraded",
        detail: `ClamAV carrega ${dbs.length} assinatura(s) local(is) em ${facts.dbDir}, sem base oficial (.cvd/.cld) — o motor analisa, a cobertura é limitada; corre freshclam`,
      },
    };
  }
  if (dbs.length === 0) {
    return {
      available: false,
      health: {
        status: "degraded",
        detail: `ClamAV instalado mas sem base de assinaturas (${facts.dbDir}) — corre freshclam`,
      },
    };
  }
  // Base oficial presente mas INCOMPLETA: provado em percurso real (2026-11-01)
  // — um `freshclam` interrompido a meio deixa `main.cvd` intacto e `daily.cvd`
  // ausente, sem ficheiro parcial, e a classificação antiga respondia `active`
  // com «2 signature database file(s)». O binário está bom, as duas bases que
  // existem carregam-se, e mesmo assim quase toda a assinatura recente falta.
  // `active` aqui seria a mentira da classe que o comentário acima jura evitar:
  // contagem de ficheiros não é cobertura. A sonda passa a dizer O QUE FALTA.
  const temDiaria = dbs.some((entry) => /^(daily|nightly)[-.]/i.test(entry));
  if (!temDiaria) {
    return {
      available: true,
      health: {
        status: "degraded",
        detail: `ClamAV carrega ${dbs.length} base(s) oficial(is) em ${facts.dbDir}, mas falta a base diária (daily/nightly) — assinatura recente em falta até correr freshclam`,
      },
    };
  }
  return {
    available: true,
    health: { status: "active", detail: `ClamAV binary available (${dbs.length} signature database file(s))` },
  };
}

/**
 * PROVA POSITIVA DE CARGA (TP-PAP-ENGINES-RECOVERY-AND-PACKAGING-20261027, rev 2).
 *
 * A sonda nunca publica `active` por existência+mtime de `.cvd/.cld`: um
 * ficheiro truncado com mtime recente é exactamente a classe de falso-positivo
 * que o `active` sem prova deixava passar. A única fonte de `active` passa a
 * ser uma operação benigna e controlada em que o `clamscan` confirma ter
 * carregado a base e varrido a fixture com evidência COERENTE.
 *
 * Rev 2 — confirmação ESTRUTURAL (revisão Codex 2026-10-27, HOLD): a prova só é
 * válida com saída consistente e completa:
 *  - exit code EXACTAMENTE 0 e SEM `error` (timeout/spawn/lease/modo);
 *  - stdout com o resumo de um scan real: cabeçalho `SCAN SUMMARY`, resumo
 *    completo (`Known viruses > 0`, `Scanned files >= 1`, `Infected files: 0`);
 *  - stderr sem marcadores de carga falhada (`ERROR`/`LibClamAV Error`/
 *    `damaged`/`Broken or not a CVD`/`Can't load`); avisos `WARNING` não anulam.
 * Contagens válidas com exit 2, timeout, stderr danificado, resumo partido ou
 * relato contraditório NUNCA confirmam carga.
 *
 * `--version` (ou qualquer número impresso na versão) NUNCA prova carga — só o
 * resumo de um scan com a base pedida o faz.
 */

/** Resultado da corrida controlada de carga. */
export interface ClamavLoadProof {
  /** stdout do `clamscan`; null se o processo não arrancou. */
  stdout: string | null;
  /** stderr; null se o processo não arrancou. */
  stderr: string | null;
  /** exit code; null se o processo não arrancou. */
  exitCode: number | null;
  /** erro de spawn/timeout/lease/modo; ausente quando o processo correu. */
  error?: string;
}

/** Seam de teste: executa `clamscan <args>` e devolve a saída. Nunca definido em produção. */
export type ClamavLoadRun = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

/**
 * Timeout da prova de carga.
 *
 * MEDIDO (2026-10-27, base real autorizada com 3 628 193 assinaturas,
 * `freshclam-validation/database`): carga completa + scan da fixture = ~6,3 s
 * (exit 0). 30 s é o tecto com margem >4× para máquinas lentas.
 */
export const CLAMAV_LOAD_PROBE_TIMEOUT_MS = 30_000;

/** ENV que liga o modo SO-SOMENTE-LEITURA do serviço (dev-windows-readonly). */
export const CLAMAV_READONLY_MODE_ENV = "CYBERSAFE_DEV_WINDOWS_READONLY";
/** ENV que liga a sessão de FIXTURE do serviço (dev-fixture-gate). */
export const CLAMAV_FIXTURE_MODE_ENV = "CYBERSAFE_REALDEV_FIXTURE_SCAN";

/**
 * Default FAIL-CLOSED da prova de carga, derivado do ambiente.
 *
 * O serviço liga os dois modos dev por ENV (`=== "1"`), e a bridge é criada no
 * `engine.ts` SEM opção de modos (só `acquireDatabaseLease`). Sem esta derivação,
 * num run de leitura ou fixture o probe continuava a spawnar um clamscan e a
 * escrever uma fixture em tmpdir — fora da superfície que esses modos fecham.
 * Com qualquer um dos flags ligados, a prova fica DESLIGADA por defeito (o
 * motor degrada com a razão honesta); `loadProofEnabled` explícito continua a
 * mandar (seam de teste).
 */
export function clamavLoadProofDefaultEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CLAMAV_READONLY_MODE_ENV] !== "1" && env[CLAMAV_FIXTURE_MODE_ENV] !== "1";
}

/**
 * Órçamento do `dispose()` para aguardar a morte dos filhos da prova.
 *
 * O grace interno do spawner é 2 s — o `outcome` de um filho REAL resolve-se
 * sempre em ≤ 2 s após o `killTree()` (morte confirmada ou `deathUnconfirmed`).
 * Este órçamento existe para um handle que nunca emita `close`: o shutdown não
 * pode ficar preso para sempre à espera de algo que não prova (os handles já
 * foram `killTree()`; a vaga/lease presas são o estado honesto).
 */
export const CLAMAV_DISPOSE_BUDGET_MS = 5_000;

/** Texto benigno fixo da fixture usada na prova de carga (nunca malware). */
export const CLAMAV_LOAD_PROBE_FIXTURE =
  "CyberSafe positive-load probe fixture — ficheiro benigno de teste.\n";

/** Marcadores de carga falhada no stderr — anulam a prova mesmo com stdout válido. */
const CLAMAV_LOAD_FAILURE_STDERR =
  /\bERROR\b|LibClamAV Error|damaged|Broken or not a CVD|Can't load|Failed to load|parse error|FATAL/i;

/** Nº de assinaturas que o `clamscan` confirma ter carregado (null = linha ausente). */
export function parseClamavKnownViruses(output: string): number | null {
  const match = /Known viruses:\s*(\d+)/i.exec(output ?? "");
  return match ? Number(match[1]) : null;
}

/** Resumo de scan estruturado; null quando alguma linha obrigatória falta. */
export interface ClamavScanSummaryParts {
  knownViruses: number;
  scannedFiles: number;
  infectedFiles: number;
}

/** Lê o resumo do scan. Todas as linhas têm de existir; sem elas não há resumo. */
export function parseClamavScanSummary(output: string): ClamavScanSummaryParts | null {
  const known = parseClamavKnownViruses(output);
  const scanned = /Scanned files:\s*(\d+)/i.exec(output ?? "")?.[1];
  const infected = /Infected files:\s*(\d+)/i.exec(output ?? "")?.[1];
  if (known === null || scanned === undefined || infected === undefined) return null;
  return { knownViruses: known, scannedFiles: Number(scanned), infectedFiles: Number(infected) };
}

/**
 * Carga COMPROVADA — evidência coerente e completa:
 *  1. sem `error` (timeout/spawn/lease/modo) e exit code EXACTAMENTE 0;
 *  2. stdout com o cabeçalho `SCAN SUMMARY` e resumo completo;
 *  3. `Known viruses > 0` (a base foi carregada);
 *  4. `Scanned files >= 1` (a fixture foi efectivamente analisada);
 *  5. `Infected files: 0` (fixture benigna, zero infecções);
 *  6. stderr sem marcadores de carga falhada.
 * Qualquer contradição (exit 2 com contagens válidas, stderr danificado,
 * resumo partido, timeout disfarçado de `error`) devolve false.
 */
export function clamavLoadConfirmed(proof: ClamavLoadProof): boolean {
  if (!proof) return false;
  if (proof.error !== undefined) return false;
  if (proof.exitCode !== 0) return false;
  if (!proof.stdout) return false;
  if (!/SCAN SUMMARY/i.test(proof.stdout)) return false;
  const summary = parseClamavScanSummary(proof.stdout);
  if (!summary) return false;
  if (summary.knownViruses <= 0) return false;
  if (summary.scannedFiles < 1) return false;
  if (summary.infectedFiles !== 0) return false;
  if (CLAMAV_LOAD_FAILURE_STDERR.test(proof.stderr ?? "")) return false;
  return true;
}

/**
 * Aplica a prova à classificação: só mantém `active` com carga comprovada;
 * caso contrário degrada com a razão honesta. Estados que já não eram
 * `active` (ausente/vazio/expirado/sem base) nunca mudam.
 */
export function applyClamavLoadProof(
  outcome: { available: boolean; health: EngineSubsystemHealth },
  chosen: ClamavDbCandidate | null,
  proof: ClamavLoadProof,
): { available: boolean; health: EngineSubsystemHealth } {
  if (outcome.health.status !== "active" || !chosen) return outcome;
  if (clamavLoadConfirmed(proof)) return outcome;
  const why = proof.error
    ? `a prova de carga falhou (${proof.error})`
    : "a prova de carga não produziu evidência coerente (exit≠0, resumo incompleto, infrações ou stderr de erro)";
  return {
    available: false,
    health: {
      status: "degraded",
      detail: `Base presente em ${chosen.dir} mas ${why} — não se publica active sem carga comprovada; corra freshclam`,
    },
  };
}

/**
 * Runner PURO da prova de carga (testes herméticos): escreve a fixture benigna
 * no tmpdir, corre o `run` injectado com `--database=<dir> <fixture>` e remove
 * a fixture. NUNCA faz spawn em produção — a bridge usa `runLoadProof`, que
 * passa pelo spawner real com lease, `liveHandles`, deadline e morte
 * confirmada. Qualquer excepção vira uma prova com `error`, nunca confirma.
 */
export async function probeClamavLoad(
  file: string,
  databaseDir: string,
  run: ClamavLoadRun,
): Promise<ClamavLoadProof> {
  const fixturePath = path.join(
    os.tmpdir(),
    `cybersafe-clamav-load-probe-${randomBytes(8).toString("hex")}.txt`,
  );
  try {
    await writeFile(fixturePath, CLAMAV_LOAD_PROBE_FIXTURE, "utf8");
    const res = await run(file, ["--database", databaseDir, fixturePath]);
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.code };
  } catch (err: any) {
    return { stdout: null, stderr: null, exitCode: null, error: String(err?.message ?? err) };
  } finally {
    try {
      await rm(fixturePath, { force: true });
    } catch {
      /* best effort */
    }
  }
}

function firstLine(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
}

/**
 * Sonda um directório candidato. Nunca lança: qualquer falha de I/O vira um
 * estado (`missing`/`unreadable`) em vez de uma excepção.
 */
export async function probeDatabaseDir(dir: string, source: ClamavDbSource): Promise<ClamavDbCandidate> {
  const base: ClamavDbCandidate = { dir, source, state: "missing", signatureFiles: [], newestMtimeMs: 0 };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    const code = err?.code;
    if (code !== "ENOENT") {
      return { ...base, state: "unreadable", error: code ?? String(err?.message ?? err) };
    }
    return base;
  }

  const signatureFiles: string[] = [];
  let newestMtimeMs = 0;
  for (const entry of entries) {
    if (!isSignatureFile(entry.name)) continue;
    if (entry.isSymbolicLink()) return { ...base, state: "unreadable", error: "linked-signature" };
    if (!entry.isFile()) continue;
    signatureFiles.push(entry.name);
    // mtime só para frescura; uma falha aqui não invalida a assinatura.
    try {
      const info = await stat(path.join(dir, entry.name));
      if (info.mtimeMs > newestMtimeMs) newestMtimeMs = info.mtimeMs;
    } catch {
      /* mtime desconhecido ⇒ frescura não avaliada */
    }
  }

  return {
    dir,
    source,
    state: signatureFiles.length > 0 ? "ready" : "empty",
    signatureFiles,
    newestMtimeMs,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * DIST-CLAMAV13OUT — ONDE ESTÁ O MOTOR, SEM DEPENDER DO PATH.
 *
 * MEDIDO nesta máquina (2026-10-13, read-only): o ClamAV 1.5.2 está instalado
 * por Chocolatey. O `clamscan` que o PATH resolve é
 * `C:\ProgramData\chocolatey\bin\clamscan.exe` — um SHIM de 38 912 B que só
 * arranca o binário verdadeiro (`…\lib\clamav\tools\clamav-1.5.2.win.x64\clamscan.exe`,
 * 271 872 B, com `libclamav.dll` de 32 MB ao lado). A resolução era
 * UNICAMENTE `where clamscan` (PATH do PROCESSO).
 *
 * Consequência medida: `where` devolve o que o PATH do processo tiver no
 * momento do arranque. Em DEV isso inclui `…\chocolatey\bin` (herdado do
 * shell/Explorer); num arranque com um PATH mais estreito — o caso da
 * distribuição instalada, que NÃO traz ClamAV nenhum no pacote — o motor fica
 * invisível mesmo estando instalado. A resolução passa a olhar também para as
 * raízes de instalação conhecidas, por ordem de autoridade:
 *
 *   1. `CYBERSAFE_CLAMSCAN_PATH` — pin explícito de operador/deploy;
 *   2. o PATH do processo (o comportamento antigo, inalterado em DEV);
 *   3. raízes conhecidas: Chocolatey, `Program Files\ClamAV`, Scoop, WinGet,
 *      `%LOCALAPPDATA%\Programs\ClamAV` (Windows) e os directórios fixos UNIX.
 *
 * TUDO read-only: só `existsSync`. Nada aqui lança um processo, varre um
 * ficheiro pessoal, toca na rede ou instala o que seja. E nada aqui fabrica
 * `active`: encontrar o binário não é ter base de assinaturas, e a
 * classificação continua a exigir `.cvd`/`.cld` válidos (ver
 * `classifyClamavHealth`).
 * ────────────────────────────────────────────────────────────────────────── */

/** Pin explícito do binário `clamscan` (valor: caminho absoluto). */
export const CLAMAV_BINARY_ENV = "CYBERSAFE_CLAMSCAN_PATH";

/** De onde veio um candidato a binário. A ordem abaixo É a precedência. */
export type ClamavBinarySource =
  | "explicit"
  | "path"
  | "chocolatey"
  | "program-files"
  | "scoop"
  | "winget"
  | "user-programs"
  | "unix";

/** Um caminho candidato a `clamscan`, ainda por verificar no disco. */
export interface ClamavBinaryCandidate {
  path: string;
  source: ClamavBinarySource;
}

/** Nome do executável do motor, por plataforma. */
export function clamavBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "clamscan.exe" : "clamscan";
}

function splitPathList(value: string, platform: NodeJS.Platform): string[] {
  const sep = platform === "win32" ? ";" : ":";
  return value
    .split(sep)
    .map((dir) => dir.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/**
 * Candidatos a binário, por ordem de autoridade. PURO: não toca no disco.
 *
 * O `env` e a `platform` são parâmetros (e não `process.*` lidos por dentro)
 * para que o teste possa medir uma máquina com PATH limpo e uma raiz de
 * fixture isolada — sem depender do que esta máquina tem instalado.
 */
export function clamavBinaryCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ClamavBinaryCandidate[] {
  const name = clamavBinaryName(platform);
  const found: ClamavBinaryCandidate[] = [];
  const push = (path: string | undefined, source: ClamavBinarySource) => {
    if (path && path.trim()) found.push({ path, source });
  };

  push(env[CLAMAV_BINARY_ENV]?.trim(), "explicit");
  for (const dir of splitPathList(env.PATH ?? "", platform)) push(path.join(dir, name), "path");

  if (platform === "win32") {
    const choco = env.ChocolateyInstall?.trim();
    const programData = env.ProgramData?.trim();
    const programFiles = env.ProgramFiles?.trim();
    const programFilesX86 = env["ProgramFiles(x86)"]?.trim();
    const localAppData = env.LOCALAPPDATA?.trim();
    const userProfile = env.USERPROFILE?.trim();
    const scoop = env.SCOOP?.trim();
    push(choco && path.join(choco, "bin", name), "chocolatey");
    push(programData && path.join(programData, "chocolatey", "bin", name), "chocolatey");
    push(programFiles && path.join(programFiles, "ClamAV", name), "program-files");
    push(programFilesX86 && path.join(programFilesX86, "ClamAV", name), "program-files");
    push(scoop && path.join(scoop, "apps", "clamav", "current", name), "scoop");
    push(userProfile && path.join(userProfile, "scoop", "apps", "clamav", "current", name), "scoop");
    push(localAppData && path.join(localAppData, "Microsoft", "WinGet", "Links", name), "winget");
    push(localAppData && path.join(localAppData, "Programs", "ClamAV", name), "user-programs");
  } else {
    for (const dir of ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/snap/bin"]) {
      push(path.join(dir, name), "unix");
    }
  }

  // Dedupe pelo caminho (case-insensitive no Windows) mantendo a PRIMEIRA
  // ocorrência — que é a de maior autoridade.
  const seen = new Set<string>();
  return found.filter((entry) => {
    const key = platform === "win32" ? entry.path.toLowerCase() : entry.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * O primeiro candidato que EXISTE no disco. `null` quando nenhum existe —
 * nunca inventa um caminho por conveniência.
 */
export function firstExistingClamavBinary(
  candidates: readonly ClamavBinaryCandidate[],
  exists: (path: string) => boolean,
): ClamavBinaryCandidate | null {
  for (const candidate of candidates) {
    try {
      if (exists(candidate.path)) return candidate;
    } catch {
      /* uma sondagem que rebenta não é existência */
    }
  }
  return null;
}

/**
 * O ficheiro que o motor LANÇA.
 *
 * Contrato: um binário RESOLVIDO é lançado pelo caminho absoluto (é o que
 * torna útil encontrar uma instalação fora do PATH); sem resolução, o nome
 * simples e o PATH continuam a decidir — o comportamento antigo, que em DEV
 * é o caminho normal.
 */
export function clamavSpawnFile(
  binaryPath: string | null,
  platform: NodeJS.Platform = process.platform,
): string {
  return binaryPath ?? clamavBinaryName(platform);
}

export interface ClamavBinaryDiagnosis {
  platform: NodeJS.Platform;
  /** Caminho escolhido (null = nenhum candidato existe). */
  resolved: string | null;
  resolvedSource: ClamavBinarySource | null;
  /** TODOS os candidatos, com o resultado real do disco em cada um. */
  candidates: Array<ClamavBinaryCandidate & { exists: boolean }>;
}

/**
 * DIAGNÓSTICO read-only: "qual ClamAV é que a app está a ver".
 *
 * Só `existsSync`. Não lança o binário, não varre ficheiros pessoais, não toca
 * na rede. Existe para responder à pergunta que o estado actual não respondia
 * ("está instalado mas não sabes qual") sem acrescentar nenhuma afirmação que
 * o disco não suporte.
 */
export function diagnoseClamavBinary(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    exists?: (path: string) => boolean;
  } = {},
): ClamavBinaryDiagnosis {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? (existsSync as (path: string) => boolean);
  const candidates = clamavBinaryCandidates(env, platform).map((entry) => ({
    ...entry,
    exists: (() => {
      try {
        return exists(entry.path);
      } catch {
        return false;
      }
    })(),
  }));
  const chosen = candidates.find((entry) => entry.exists) ?? null;
  return {
    platform,
    resolved: chosen?.path ?? null,
    resolvedSource: chosen?.source ?? null,
    candidates,
  };
}

export class ClamavBridge {
  private _health: EngineSubsystemHealth = { status: "unavailable", detail: "Not checked" };
  /**
   * A saúde do ULTIMO probe: binario + base presentes + frescura das
   * definicoes. E a autoridade sobre a BASE; `_health` e o que a UI ve agora.
   *
   * Existe por causa da revisao do fix de recuperacao: um batch limpo prova
   * que o SCANNER correu — nao prova que a base esta fresca. Sem esta
   * separacao, um batch limpo pousado numa base expirada (aged > 7 dias,
   * `_hasSignatures` continua true e o scan e permitido) devolvia o motor a
   * `active` com as definicoes velhas — a recuperacao desfazia o aviso do
   * probe. A recuperacao do scanner so e permitida quando o ultimo probe
   * disse `active`; ambos sao atualizados no probe (e no `afterSwap` do
   * freshclam, que forca o probe), nunca por scan.
   */
  private _databaseHealth: EngineSubsystemHealth | null = null;
  private probePromise: Promise<boolean> | null = null;
  /** Prova EM CURSO (single-flight: até `force` se junta à em curso). */
  private probeInFlight: Promise<boolean> | null = null;
  private _dbDir: string | null = null;
  /** Há assinaturas num directório sondado — mesmo que velhas. */
  private _hasSignatures = false;
  /** Caminho absoluto do `clamscan` resolvido, para o motor se excluir. */
  private _binaryPath: string | null = null;
  /** clamscans vivos lançados por ESTE bridge (para `dispose`). */
  private readonly liveHandles = new Set<ClamavSpawnHandle>();
  /** Depois de `dispose` o bridge recusa novos scans em vez de fazer spawn. */
  private disposed = false;

  /**
   * Fail-closed derivado do ambiente: em modo readonly/fixture (por ENV) a
   * prova de carga NÃO faz spawn nem escreve fixture, mesmo sem opção explícita
   * — é o que fecha a fronteira do serviço real (`engine.ts` constrói a bridge
   * só com `acquireDatabaseLease`). `loadProofEnabled` explícito continua a
   * mandar (seam de teste).
   */
  private readonly loadProofEnabled: boolean;

  /** Cancelamento da ESPERA PELA VAGA da prova em curso (dispose aborta). */
  private probeSlotAbort: AbortController | null = null;

  constructor(private readonly options: ClamavBridgeOptions = {}) {
    this.loadProofEnabled = options.loadProofEnabled ?? clamavLoadProofDefaultEnabled();
  }

  get health(): EngineSubsystemHealth {
    return this._health;
  }

  /** Directório de assinaturas que o `clamscan` vai usar (null se nenhum). */
  get datadir(): string | null {
    return this._dbDir;
  }

  /** Caminho do binário `clamscan` que este bridge usa (null se não resolvedo). */
  get binaryPath(): string | null {
    return this._binaryPath;
  }

  /**
   * Resolve o caminho real do clamscan.
   *
   * `where` no Windows dá o que o PATH resolve — que, numa instalação
   * Chocolatey, é o SHIM de ~38 KB que arranca o clamscan verdadeiro. O
   * directório do shim é o mesmo, por isso serve perfeitamente para a
   * exclusão por caminho.
   *
   * DIST-CLAMAV13OUT: `where` é o PRIMEIRO passo do PATH (preserva o
   * comportamento de DEV), mas deixou de ser o ÚNICO. Se ele não devolver nada
   * — o caso de uma instalação que não está no PATH do processo, que é o normal
   * numa máquina onde o utilizador instalou o ClamAV e a app foi lançada com
   * outro PATH — procura-se nas raízes de instalação conhecidas
   * (`clamavBinaryCandidates`). Um resultado de `where` que já não exista no
   * disco não é aceite: cai para as raízes em vez de apontar para um fantasma.
   *
   * DIST-CLAMAV13OUT (integração do bundle, 2026-10-13) — DEFEITO CORRIGIDO:
   * o `where` corria ANTES de se olhar para o pin, por isso numa máquina com
   * um ClamAV no PATH (o caso comum, e o desta máquina de desenvolvimento) o
   * motor EMPACOTADO era silenciosamente ignorado: o `diagnoseClamavBinary`
   * dizia `resolvedSource: "explicit"` e o bridge usava o do PATH. A
   * precedência que `clamavBinaryCandidates` documenta (pin → PATH → raízes)
   * é a única válida, e é aqui que tem de ser cumprida: um pin explícito é uma
   * decisão do operador/deploy e não pode perder para o que calhar no PATH.
   */
  private async resolveBinaryPath(): Promise<string | null> {
    // 1. Pin explícito (autoridade máxima). Sem ficheiro no disco, não serve —
    //    um pin fantasma não é aceite; segue-se para o PATH.
    const pinned = process.env[CLAMAV_BINARY_ENV]?.trim();
    if (pinned && existsSync(pinned)) return pinned;

    // 2. PATH do processo. `where` no Windows mantém o comportamento de DEV.
    if (process.platform === "win32") {
      try {
        const { stdout } = await execFileAsync("where", ["clamscan"], { timeout: 5_000, windowsHide: true });
        const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        if (first && existsSync(first)) return first;
      } catch {
        /* seguimos para as raízes conhecidas */
      }
    }
    const chosen = firstExistingClamavBinary(
      clamavBinaryCandidates(process.env, process.platform),
      existsSync,
    );
    return chosen?.path ?? null;
  }

  /** Limite de clamscans simultâneos em vigor (1 = o default global). */
  get concurrencyLimit(): number {
    return this.options.maxConcurrent === undefined || this.options.maxConcurrent === "GLOBAL"
      ? 1
      : Math.max(1, this.options.maxConcurrent);
  }

  /**
   * PIDs dos clamscans VIVOS que ESTE bridge lançou.
   *
   * Existe para diagnóstico e para os testes. Medir "quantos clamscan há no SO"
   * não responde à pergunta que importa — "quantos os NOSSOS estão a correr ao
   * mesmo tempo" — porque o `node --test` corre ficheiros de teste em paralelo e
   * outro ficheiro pode estar legitimamente a escanear ao mesmo tempo.
   */
  liveChildPids(): number[] {
    const pids: number[] = [];
    for (const handle of this.liveHandles) {
      if (typeof handle.pid === "number" && liveClamavPids.has(handle.pid)) pids.push(handle.pid);
    }
    return pids;
  }

  /**
   * Shutdown. Mata TODOS os clamscans em curso e impede novos spawns.
   *
   * Sem isto, fechar a app ou parar o serviço deixava clamscans vivos — o
   * `NativeEngineBridge` já tem o seu `dispose()` para os filhos do motor
   * nativo; o clamscan não tinha nada equivalente.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    // Cancela a ESPERA PELA VAGA da prova em curso: sem isto, um probe à
    // espera de vaga mantinha um timer de até 30 s vivo após o shutdown.
    this.probeSlotAbort?.abort();
    this.probeSlotAbort = null;
    const handles = [...this.liveHandles];
    this.liveHandles.clear();
    if (handles.length === 0) {
      // Nada para matar, nada para esperar: NENHUM timer é armado. (HOLD
      // CODEX REV4: o `setTimeout` do órçamento ficava armado mesmo com zero
      // filhos e mantinha o processo vivo ~5 s após o dispose.)
      return;
    }
    for (const handle of handles) {
      try {
        handle.killTree();
      } catch {
        /* best effort */
      }
    }
    // Espera pelo fim real: `dispose` que devolve antes de o processo morrer
    // é um `dispose` que não cumpriu o contrato. Com ÓRÇAMENTO: um handle que
    // nunca emita `close` (patológico) não pode prender o shutdown para sempre
    // — os handles já foram `killTree()`; a vaga/lease ficam presas, honesto.
    const budgetMs = this.options.disposeBudgetMs ?? CLAMAV_DISPOSE_BUDGET_MS;
    let budgetTimer: NodeJS.Timeout | null = null;
    const budget = new Promise<void>((resolve) => {
      budgetTimer = setTimeout(resolve, budgetMs);
    });
    try {
      await Promise.race([Promise.allSettled(handles.map((handle) => handle.outcome)), budget]);
    } finally {
      // LIMPA SEMPRE o timer: quando o outcome vence primeiro, o `setTimeout`
      // continua armado e segura o processo — exactamente o sintoma medido.
      if (budgetTimer) {
        clearTimeout(budgetTimer);
        budgetTimer = null;
      }
    }
  }

  /**
   * Verifica binário **e** definições (base de assinaturas). Resultado em
   * cache; `force=true` re-executa o probe (ex.: depois de correr freshclam).
   */
  async isAvailable(force = false): Promise<boolean> {
    // SINGLE-FLIGHT: qualquer chamada (mesmo `force`) junta-se à prova em
    // curso. Sem isto, duas `force` concorrentes (health-check + após swap)
    // arrancavam duas provas e dois clamscans de ~1 GB.
    if (this.probeInFlight) return this.probeInFlight;
    if (this.probePromise && !force) return this.probePromise;
    const run = this.probe();
    this.probeInFlight = run;
    this.probePromise = run;
    return run.finally(() => {
      if (this.probeInFlight === run) this.probeInFlight = null;
    });
  }

  private async probe(): Promise<boolean> {
    // A resolução vem PRIMEIRO: a sonda de versão tem de correr sobre o
    // binário que vamos usar a sério. Correr `clamscan --version` pelo nome
    // dava `unavailable` a uma instalação que existe fora do PATH — e era
    // isso que tornava "está instalado" indistinguível de "não está".
    const resolved = await this.resolveBinaryPath();
    let versionOutput: string | null = null;
    let versionError: string | undefined;
    try {
      versionOutput = (
        await execFileAsync(clamavSpawnFile(resolved), ["--version"], { timeout: 5_000, windowsHide: true })
      ).stdout;
    } catch (err: any) {
      versionError = err?.message;
    }
    if (versionOutput) {
      // Onde está o clamscan? O serviço usa isto para EXCLUIR o binário de
      // scan: o motor não pode ser analisado por si próprio, e o caminho
      // identifica-o mesmo que o nome não esteja em nenhuma lista.
      //
      // Só se publica o caminho quando o binário RESOLVIDO respondeu: uma
      // sonda bem-sucedida pelo NOME não prova qual dos candidatos é o motor.
      this._binaryPath = resolved;
    }

    let candidates: ClamavDbCandidate[] | undefined;
    if (versionOutput) {
      candidates = await this.collectDatabaseCandidates();
    }

    const outcome = classifyClamavHealth({
      versionOutput,
      versionError,
      dbDir: candidates?.[0]?.dir ?? null,
      dbFiles: null,
      candidates,
    });

    const chosen = candidates ? selectDatabaseCandidate(candidates) : null;
    this._dbDir = chosen?.dir ?? null;
    this._hasSignatures = chosen?.state === "ready";

    // PROVA POSITIVA DE CARGA: `active` nunca por existência+mtime. Quando a
    // classificação diz `active`, exige-se uma corrida benigna e controlada em
    // que o clamscan confirma ter carregado a base escolhida; sem confirmação
    // o motor fica `degraded` com a razão honesta.
    let decided: { available: boolean; health: EngineSubsystemHealth } = outcome;
    if (decided.health.status === "active" && chosen) {
      // Modo readonly/fixture (por opção OU por ENV — fail-closed): sem spawn
      // e sem fixture — degradado honesto.
      const proof =
        this.loadProofEnabled === false
          ? { stdout: null, stderr: null, exitCode: null, error: "prova de carga desativada neste modo (readonly/fixture)" }
          : await this.runLoadProof(chosen);
      decided = applyClamavLoadProof(decided, chosen, proof);
    }
    // POST017: timeout/lease/cancel da prova não tornam as definições velhas.
    // Guardar a frescura separadamente permite recuperar SÓ após batch positivo;
    // `decided` continua a expor a falha até haver essa prova de execução.
    this._databaseHealth = outcome.health;
    this._health = decided.health;
    return decided.available;
  }

  /**
   * PROVA DE CARGA COM A VIDA DO BRIDGE — o mesmo caminho dos scans:
   *
   *  - LEASE da base (`acquireDatabaseLease`): exclusão com a troca FreshClam.
   *    Recusada (update pendente/activo/shutdown) → SEM spawn, prova com
   *    `error` honesto. A lease é libertada no `finally`, ou pelo `close` do
   *    filho quando a morte ficou não confirmada (mesmo contrato do scan).
   *  - Spawn pelo MESMO spawner (`options.spawn ?? spawnClamav`): o filho
   *    entra em `liveHandles` e é registado (`trackClamavPid`) — o `dispose`
   *    mata-o, não fica uma prova a correr durante o shutdown.
   *  - DEADLINE imposto pela bridge (como nos scans): o timer chama
   *    `killTree()` e quem decide é o `outcome`, que só resolve com `close` —
   *    morte CONFIRMADA pelo SO. `deathUnconfirmed` envenena a vaga e a prova
   *    falha; nunca se afirma desligamento sem prova.
   *  - Re-verifica `disposed` depois do último `await` antes do spawn.
   *  - Nunca lança: qualquer falha vira uma prova com `error`.
   *
   * O seam `probeRun` (chamado na rev 1 via `probeClamavLoad`) deixou de ser
   * usado aqui de propósito: a prova real tem de passar pelo mesmo ciclo de
   * vida dos scans. `probeClamavLoad` ficou como runner puro dos testes.
   */
  private async runLoadProof(chosen: ClamavDbCandidate): Promise<ClamavLoadProof> {
    // ── VAGA (POSSE) PRIMEIRO — o mesmo semáforo dos scans. ──
    //
    // HOLD CODEX (REV4): sem `acquireClamavSlot`, a prova podia correr
    // CONCORRENTE com um scan (2 clamscans contra o cap de 1) e, pior, o
    // `deathUnconfirmed` envenenava a vaga SEM nunca a ter adquirido — daí
    // para a frente TODOS os scans respondiam "indisponível". A prova agora
    // adquire a vaga como qualquer job (background, espera com limite do
    // probe), e a vaga só é libertada/envenenada QUEM A POSSUI.
    const probeTimeoutMs = this.options.probeTimeoutMs ?? CLAMAV_LOAD_PROBE_TIMEOUT_MS;
    // Cancelamento da ESPERA pela vaga: um controlador próprio cujo timer se
    // limpa assim que a vaga decide (o `AbortSignal.timeout` deixava um timer
    // de 30 s armado a segurar o processo depois de uma prova de 6 s).
    const slotAbort = new AbortController();
    this.probeSlotAbort = slotAbort;
    const slotWaitTimer = setTimeout(() => slotAbort.abort(), probeTimeoutMs);
    let slot: ClamavSlotResult;
    try {
      slot = await acquireClamavSlot(this.concurrencyLimit, "background", slotAbort.signal);
    } finally {
      clearTimeout(slotWaitTimer);
      if (this.probeSlotAbort === slotAbort) this.probeSlotAbort = null;
    }
    if (slot === "poisoned") {
      // Há um clamscan vivo cuja morte ninguém confirmou: não admitimos outro
      // (2 GB em voo). Honesto: prova sem spawn, motor degradado.
      return { stdout: null, stderr: null, exitCode: null, error: "prova recusada: vaga envenenada" };
    }
    if (slot === "overloaded") {
      return {
        stdout: null,
        stderr: null,
        exitCode: null,
        error: "prova recusada: fila de background cheia",
      };
    }
    if (slot === "aborted") {
      return {
        stdout: null,
        stderr: null,
        exitCode: null,
        error: `prova cancelada: sem vaga dentro de ${probeTimeoutMs} ms`,
      };
    }
    // `granted`: a vaga é NOSSA até ao `finally` decidir o contrário. Nunca se
    // liberta/envenena sem esta posse (HOLD CODEX).
    let slotHeld = true;

    const recusa = (pedido: ClamDatabaseLeaseHandle | ClamDatabaseLeaseRefusal | null) =>
      pedido !== null && (pedido as ClamDatabaseLeaseRefusal).refused === true;

    // Tupla do contrato da lease — recolhida DENTRO do mesmo try/finally da
    // vaga: qualquer recusa liberta a vaga AGORA adquirida (posse), nunca fica
    // uma de fora (HOLD CODEX REV4: retornos antecipados perdiam a vaga).
    const leaseBox: { lease: ClamDatabaseLeaseHandle | null } = { lease: null };
    let handle: ClamavSpawnHandle | null = null;
    let deadline: NodeJS.Timeout | null = null;
    let fixturePath: string | null = null;
    let deathUnconfirmed = false;
    try {
      // LEASE — mesmo contrato do scan: nenhum clamscan com a base enquanto o
      // freshclam a está a trocar.
      let pedido: ClamDatabaseLeaseHandle | ClamDatabaseLeaseRefusal | null = null;
      try {
        pedido = this.options.acquireDatabaseLease?.("load-proof") ?? null;
      } catch (err: any) {
        return { stdout: null, stderr: null, exitCode: null, error: `lease falhou (${String(err?.message ?? err)})` };
      }
      if (recusa(pedido)) {
        return {
          stdout: null,
          stderr: null,
          exitCode: null,
          error: `lease recusada (${(pedido as ClamDatabaseLeaseRefusal).reason})`,
        };
      }
      leaseBox.lease =
        this.options.acquireDatabaseLease && pedido !== null ? (pedido as ClamDatabaseLeaseHandle) : null;

      if (this.disposed) {
        return { stdout: null, stderr: null, exitCode: null, error: "bridge descartado (shutdown)" };
      }

      fixturePath = path.join(
        os.tmpdir(),
        `cybersafe-clamav-load-probe-${randomBytes(8).toString("hex")}.txt`,
      );
      await writeFile(fixturePath, CLAMAV_LOAD_PROBE_FIXTURE, "utf8");

      // Re-verificação depois do último `await` antes do spawn (janela dispose).
      if (this.disposed) {
        return { stdout: null, stderr: null, exitCode: null, error: "bridge descartado (shutdown)" };
      }

      const spawnFn = this.options.spawn ?? spawnClamav;
      handle = spawnFn(clamavSpawnFile(this._binaryPath), ["--database", chosen.dir, fixturePath], {
        timeoutMs: probeTimeoutMs,
        windowsHide: true,
        scanId: "load-proof",
      });
      if (!handle) {
        return { stdout: null, stderr: null, exitCode: null, error: "prova de carga sem handle de spawn" };
      }
      this.liveHandles.add(handle);
      if (typeof handle.pid === "number") trackClamavPid(handle.pid);

      // Deadline da bridge: mata e ESPERA pelo outcome (morte real).
      let timedOut = false;
      deadline = setTimeout(() => {
        timedOut = true;
        scanPerfLog("LOAD_PROOF_TIMEOUT", "load-proof", `origin=load-proof pid=${handle?.pid ?? "unknown"} budgetMs=${probeTimeoutMs} termination=requested`);
        handle?.killTree();
      }, probeTimeoutMs);
      // TP-VM016-CLAM-REAL — o deadline é um KILLER DE FALLBACK, não trabalho:
      // não pode segurar o event loop. Sem isto, quando o filho nunca confirma a
      // morte o `await handle.outcome` não resolve, o `finally` (que limpa o
      // timer) nunca corre, e o processo sobrevive `probeTimeoutMs` DEPOIS de
      // `dispose()` ter devolvido. Sem `unref` o timer é a única coisa viva.
      deadline.unref();

      const outcome = await handle.outcome;
      if (deadline) {
        clearTimeout(deadline);
        deadline = null;
      }

      const proof: ClamavLoadProof = {
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        exitCode: outcome.code,
      };
      if (timedOut) proof.error = `timeout (carga > ${probeTimeoutMs} ms)`;
      if (this.disposed) proof.error = "bridge descartado (shutdown)";
      // Morte NÃO confirmada pelo SO: o clamscan pode continuar vivo com a
      // base aberta. A prova NUNCA confirma e a vaga é envenenada (nenhum
      // clamscan novo) — tratado no `finally`. Não se afirma desligamento nem
      // carga sem a prova do SO. A vaga envenenada É NOSSA: adquirimo-la acima.
      if (outcome.deathUnconfirmed === true) {
        deathUnconfirmed = true;
        proof.error = "morte não confirmada pelo SO (prova de carga)";
      }
      return proof;
    } catch (err: any) {
      return { stdout: null, stderr: null, exitCode: null, error: String(err?.message ?? err) };
    } finally {
      if (deadline) clearTimeout(deadline);
      if (handle) {
        if (typeof handle.pid === "number") untrackClamavPid(handle.pid);
        this.liveHandles.delete(handle);
      }
      // A VAGA decide-se PRIMEIRO, antes de QUALQUER `await` do finally
      // (mesma regra do scan — CODEX): com o `await rm(...)` à frente, um
      // `close` tardio do filho podia entregar/libertar a vaga enquanto o
      // nosso finally ainda não tinha decidido. Só quem POSSUI toca na vaga.
      if (slotHeld) {
        if (deathUnconfirmed) poisonClamavSlot();
        else releaseClamavSlot();
        slotHeld = false;
      }
      if (fixturePath) await rm(fixturePath, { force: true }).catch(() => undefined);
      // Morte não confirmada → a lease NÃO se liberta sem prova do SO
      // (spawner de produção tem sempre o gancho; sem ele, a lease fica presa
      // = estado honesto).
      if (deathUnconfirmed) {
        if (leaseBox.lease) {
          if (handle && typeof handle.onDeathConfirmed === "function") {
            handle.onDeathConfirmed(() => leaseBox.lease!.release());
          }
        }
      } else if (leaseBox.lease) {
        leaseBox.lease.release();
      }
    }
  }

  /**
   * Candidatos, por ordem de autoridade.
   *
   * O ponto crítico: o `freshclam` da CyberSafe descarrega as definições para
   * `<definitions>/clamav` (`service/src/updater.ts`), que **não** é
   * necessariamente o directório que o `clamconf` reporta. Consultar só o
   * `clamconf` fazia um ClamAV correctamente instalado e populado parecer
   * degradado para sempre. Por isso a base da app é candidata de primeira
   * classe e o `clamconf` é apenas mais uma fonte.
   */
  private async collectDatabaseCandidates(): Promise<ClamavDbCandidate[]> {
    const wanted: Array<{ dir: string; source: ClamavDbSource }> = [];

    if (this.options.datadir) {
      wanted.push({ dir: this.options.datadir, source: "explicit" });
    }
    wanted.push({ dir: appClamavDatabaseDir(this.options.definitionsDir), source: "app-definitions" });
    for (const dir of await this.clamconfDatabaseDirs()) {
      wanted.push({ dir, source: "clamconf" });
    }
    const platformDir = platformClamavDatabaseDir();
    if (platformDir) {
      wanted.push({ dir: platformDir, source: "platform-default" });
    }

    // Dedupe por path (case-insensitive no Windows) mantendo a primeira
    // ocorrência, que é a de maior autoridade.
    const seen = new Set<string>();
    const unique = wanted.filter((entry) => {
      const key = process.platform === "win32" ? entry.dir.toLowerCase() : entry.dir;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const candidates = await Promise.all(unique.map((entry) => probeDatabaseDir(entry.dir, entry.source)));
    // Never hide an explicit selection, an existing signature set (even stale or
    // partial), or an unreadable location. No publication, merging or cleanup.
    if (!this.options.datadir && candidates.every((candidate) => candidate.state === "missing" || candidate.state === "empty")) {
      const fallback = await this.options.fallbackDatabaseDir?.();
      if (fallback) {
        const candidate = await probeDatabaseDir(fallback, "packaged-fallback");
        // Packaging/copy mtimes do not renew signature freshness. Use the daily
        // header's publication epoch; unknown/invalid age must not become active.
        let publishedAt = 0;
        const daily = candidate.signatureFiles.find(name => /^daily\.(cvd|cld)$/i.test(name));
        if (daily) {
          try {
            const handle = await open(path.join(fallback, daily), "r");
            try {
            const header = Buffer.alloc(512);
            const { bytesRead } = await handle.read(header, 0, header.length, 0);
            const text = header.subarray(0, bytesRead).toString("ascii").trim();
            const epoch = text.startsWith("ClamAV-VDB:") ? Number(text.split(":").at(-1)) : NaN;
            if (Number.isSafeInteger(epoch) && epoch > 0 && epoch * 1000 <= Date.now()) publishedAt = epoch * 1000;
            } finally { await handle.close(); }
          } catch {
            candidate.state = "unreadable";
            candidate.error = "packaged-daily-unreadable";
          }
        }
        candidate.newestMtimeMs = publishedAt || 1;
        candidates.push(candidate);
      }
    }
    return candidates;
  }

  /**
   * Todos os `Database directory:` que o `clamconf` reporta.
   *
   * O `clamconf` pode listar mais do que um (avisa quando `freshclam.conf` e
   * `clamd.conf` divergem). Ler só a primeira linha descartava bases válidas.
   */
  /**
   * O `clamconf` do MESMO directório do binário resolvido, quando existe.
   *
   * O `clamconf` vive ao lado do `clamscan` (medido: os dois em
   * `…\lib\clamav\tools\clamav-1.5.2.win.x64\`). Se o binário foi encontrado
   * fora do PATH, o `clamconf` também não estará lá — e sem isto a base que o
   * `clamconf` reporta ficaria invisível. Sem binário resolvido (ou sem o
   * irmão instalado) cai no nome simples: o comportamento antigo.
   */
  private clamconfBinary(): string {
    if (this._binaryPath) {
      const sibling = path.join(
        path.dirname(this._binaryPath),
        process.platform === "win32" ? "clamconf.exe" : "clamconf",
      );
      if (existsSync(sibling)) return sibling;
    }
    return "clamconf";
  }

  private async clamconfDatabaseDirs(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(this.clamconfBinary(), ["-n"], { timeout: 8_000, windowsHide: true });
      const dirs: string[] = [];
      for (const entry of stdout.split(/\r?\n/)) {
        if (!/^\s*Database directory:/i.test(entry)) continue;
        const value = entry
          .split(":")
          .slice(1)
          .join(":")
          .trim()
          .replace(/^"|"$/g, "");
        if (value) dirs.push(value);
      }
      return dirs;
    } catch {
      // Sem clamconf continuamos com a base da app e o padrão da plataforma —
      // degradado, nunca "active" por omissão.
      return [];
    }
  }

  /**
   * Executa clamscan num ficheiro. Só com base de assinaturas real; caso
   * contrário reporta o estado em vez de simular proteção.
   *
   * Duas correções que só a sondagem real revelou:
   *  - A opção é `--database=DIR` (o clamscan aceita explicitamente um
   *    directório). `--datadir` é opção do **freshclam**; o clamscan
   *    aborta com "unrecognized option" — a base da app nunca seria usada.
   *  - O código de saída chega em `error.code` (não em `error.status`), pelo
   *    que comparar `status === 1` nunca detectava uma infeção: o clamscan
   *    devolvia 1 e nós reportávamos `detected: false`. Falso negativo.
   */
  async scanFile(filePath: string, options: ClamavScanOptions = {}): Promise<ClamavScanResult> {
    const batch = await this.runScan([filePath], options);
    const outcome = batch.files[0];
    return {
      detected: batch.detected,
      status: batch.status,
      verdict: outcome?.verdict ?? "error",
      signature: outcome?.signature,
      reason: outcome?.reason,
      removedDuringScan: outcome?.removedDuringScan,
      detail: outcome?.detail,
    };
  }

  /**
   * Executa clamscan sobre N ficheiros numa ÚNICA invocação.
   *
   * O motivo é medido: carregar a base de assinaturas custa ~6,2 s e ~981 MB,
   * e o clamscan paga esse preço **por processo**, não por ficheiro. Cinco
   * ficheiros em cinco invocações pagavam a base cinco vezes — 31 s e 5 GB de
   * RAM, um de cada vez. Numa invocação são 6,2 s e 981 MB.
   *
   * O resultado é por ficheiro, porque é isso que permite atribuir uma
   * detecção ao ficheiro certo em vez de dizer "o batch estava infectado".
   */
  async scanFiles(filePaths: string[], options: ClamavScanOptions = {}): Promise<ClamavBatchOutcome> {
    const startedAt = Date.now();
    scanPerfLog("BATCH_PROMISE_BEGIN", options.scanId, `files=${filePaths.length}`);
    try {
      const batch = await this.runScan(filePaths, options);
      scanPerfLog(
        "BATCH_PROMISE_RESOLVE",
        options.scanId,
        `files=${batch.files.length} status=${batch.status.status} elapsedMs=${Date.now() - startedAt}`,
      );
      return batch;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? "unknown";
      scanPerfLog("BATCH_PROMISE_REJECT", options.scanId, `code=${String(code)}`);
      throw error;
    }
  }

  /**
   * O caminho único de execução. `scanFile` e `scanFiles` são o mesmo código
   * com N = 1 e N = N: um scan de um ficheiro é um batch de um, e ter as duas
   * como funções separadas era o convite a divergirem.
   */
  private async runScan(filePaths: string[], options: ClamavScanOptions): Promise<ClamavBatchOutcome> {
    const unavailable = (detail: string, verdict: ClamavVerdict = "error"): ClamavBatchOutcome => ({
      files: filePaths.map((file) => ({ file, verdict, detail })),
      detected: false,
      errorCount: verdict === "error" ? filePaths.length : 0,
      status: { status: "unavailable", detail },
    });

    // Um bridge descartado não arranca processos: depois de um shutdown,
    // um pedido atrasado não pode ressuscitar o motor.
    // (o `disposed` é a única autoridade aqui)
    if (this.disposed) return unavailable("ClamAV encerrado (bridge descartado)");
    if (options.signal?.aborted) return unavailable("Scan ClamAV cancelado antes de arrancar");

    // T19 — a recusa de um pedido poisoned acontece ANTES do probe.
    //
    // `isAvailable()` precede o semáforo e executa `clamscan --version`: numa
    // bridge nova, um `poisoned` deixava nevertheless nascer um processo clamscan
    // aprobe. O caso 9 do contrato é literal — se há um clamscan possivelmente
    // nosso vivo, NENHUM clamscan novo nasce. O semáforo continua a ser a
    // autoridade antes do spawn de análise; isto só fecha a porta da frente.
    if (clamavSlotsPoisoned()) return unavailable(POISONED_SCAN_DETAIL);

    // P1-1 — ADQUIRIR A LEASE, AQUI, ANTES DE QUALQUER COISA QUE TOQUE NA BASE.
    //
    // Aquire-se ANTES do probe e antes do semáforo de propósito: entre o momento
    // em que se adquire e o spawn do clamscan há awaits (o probe, o semáforo), e
    // durante todos eles o gate sabe que este scan está a usar a base. Um scan
    // que falhasse a seguir ao probe e devolvesse a lease tarde deixaria o
    // freshclam à espera sem necessidade — inofensivo. O que NÃO é inofensivo é
    // o simétrico: um freshclam que escrevesse enquanto este scan ainda não
    // tinha lease.
    //
    // Recusado = `unavailable` e NÃO há fila: o utilizador vê "motor
    // indisponível, tenta dentro de instantes", que é a verdade.
    scanPerfLog(
      "DB_LEASE_ACQUIRE_BEGIN",
      options.scanId,
      `configured=${Boolean(this.options.acquireDatabaseLease)}`,
    );
    let pedido: ClamDatabaseLeaseHandle | ClamDatabaseLeaseRefusal | null;
    try {
      pedido = this.options.acquireDatabaseLease?.(options.scanId) ?? null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? "unknown";
      scanPerfLog("DB_LEASE_ACQUIRE_THROW", options.scanId, `code=${String(code)}`);
      throw error;
    }
    // A recusa pode vir como `null` (compatibilidade) ou com a CAUSA. A causa é
    // o que permite dizer a verdade ao utilizador — ver `descreverRecusaDaBase`.
    const recusa = pedido !== null && (pedido as ClamDatabaseLeaseRefusal).refused === true;
    const dbLease = recusa ? null : (pedido as ClamDatabaseLeaseHandle | null);
    const dbLeaseDenied = this.options.acquireDatabaseLease ? dbLease === null : false;
    scanPerfLog(
      "DB_LEASE_ACQUIRE_END",
      options.scanId,
      `result=${dbLeaseDenied ? "denied" : this.options.acquireDatabaseLease ? "granted" : "not-configured"}` +
        (recusa ? ` reason=${(pedido as ClamDatabaseLeaseRefusal).reason}` : ""),
    );
    if (dbLeaseDenied) {
      return unavailable(descreverRecusaDaBase(recusa ? (pedido as ClamDatabaseLeaseRefusal).reason : null));
    }

    // Tudo o que daqui em diante pode tocar na base tem de libertar a lease.
    // O `finally` do scan é o sítio, e é `finally` porque o clamscan morre,
    // dá timeout, é abortado ou o scan é cancelado — todos os caminhos.
    const leaseBox: { lease: ClamDatabaseLeaseHandle | null; deferred: boolean } = {
      lease: dbLease,
      deferred: false,
    };
    try {
      return await this.runScanHoldingLease(leaseBox, filePaths, options, unavailable);
    } finally {
      // Só liberta aqui se o corpo NAO a adiou. Com `deathUnconfirmed` a
      // adiou, e quem a liberta passa a ser o `close` do filho.
      if (!leaseBox.deferred && leaseBox.lease) {
        leaseBox.lease.release();
        scanPerfLog("DB_LEASE_RELEASE", options.scanId, "reason=batch-finally");
      }
    }
  }

  /**
   * CODEX (2026-10-03) — a lease só se liberta com PROVA DE MORTE.
   *
   * O `finally` do scan libertava a lease sempre. Mas `deathUnconfirmed` quer
   * dizer o oposto de "o scan acabou": o grace expirou e o clamscan pode
   * continuar VIVO, com a base aberta. O semáforo tratava disso (envenenava a
   * vaga); a lease da base não, e o gate passava a ver a base como livre.
   *
   * Um freshclam podia então escrever por cima de um clamscan vivo — o que é o
   * mesmo bug que o gate existe para fechar, reintroduzido pela porta do
   * "acabou".
   *
   * A correcção usa o registo `onDeathConfirmed`: a lease passa a ser
   * libertada pelo `close` do filho, que é a prova do SO. Se a morte nunca for
   * confirmada, a lease fica presa — que é o estado honesto, e o mesmo pelo
   * qual o semáforo fica envenenado.
   */

  /**
   * O corpo de `runScan`, a correr com a lease ja adquirida.
   *
   * Separar em método próprio é o que garante que `finally` não fique a
   * `return` a meio da lógica: o `return await` acima espera o resultado
   * completo e só depois liberta.
   */
  private async runScanHoldingLease(
    leaseBox: { lease: ClamDatabaseLeaseHandle | null; deferred: boolean },
    filePaths: string[],
    options: ClamavScanOptions,
    unavailable: (detail: string, verdict?: ClamavVerdict) => ClamavBatchOutcome,
  ): Promise<ClamavBatchOutcome> {
    // `leaseBox` e a caixa que o `runScan` le no `finally`: este corpo escreve
    // `deferred` quando decide que a lease so se liberta com prova de morte.
    const batchStart = Date.now();

    await this.isAvailable();
    if (!this._hasSignatures) {
      return {
        files: filePaths.map((file) => ({ file, verdict: "error" as const, detail: this._health.detail })),
        detected: false,
        errorCount: filePaths.length,
        status: this._health,
      };
    }
    const datadir = this._dbDir;

    // execFile com array de argumentos: os filePath nunca passam por shell.
    //
    // `--no-summary` foi REMOVIDO de propósito. O bloco de resumo é onde vive
    // o `Total errors`, e sem ele um exit 2 por um ficheiro ilegível é
    // indistinguível de um exit 2 sem motivo — que era como o CyberSafe
    // chegou a dizer "não conseguiu carregar a base" com a base carregada.
    const args: string[] = [];
    // Sem esta flag, um ficheiro acima dos limites internos pode sair com
    // `: OK` e ser publicado como limpo. Com ela, o ClamAV nomeia o limite
    // (`Heuristics.Limits.Exceeded.*`) e o parser trata-o como lacuna.
    args.push("--alert-exceeds-max=yes");
    if (datadir) args.push(`--database=${datadir}`);

    // Os caminhos vão no argv SÓ enquanto couberem. Acima do orçamento passam
    // para um ficheiro de lista (`--file-list=`), que o ClamAV 1.5 aceita e
    // que não tem tecto: é isto que impede o `spawn ENAMETOOLONG` que
    // matava o batch de um Quick Scan inteiro (ver MAX_CLAMSCAN_ARGV_CHARS).
    // A DECISÃO argv-vs-file-list é síncrona e não toca no disco — pode ser
    // tomada aqui. A ESCRITA da lista não: ver o `try` mais abaixo.
    let listFile: string | null = null;
    const argvComCaminhos = [...args, ...filePaths];
    const usarFileList = argvChars(argvComCaminhos) > MAX_CLAMSCAN_ARGV_CHARS;

    const spawnFn = this.options.spawn ?? spawnClamav;
    // O deadline é um ORÇAMENTO POR FICHEIRO, não um tecto para o batch. Um
    // tecto fixo de 10 s mataria um batch de 20 ficheiros que é perfeitamente
    // legítimo — e mataria o clamscan a meio, que é a pior forma de falhar.
    //
    // ORÇAMENTO DEFAULT (2026-10-16) — o clamscan real paga DOIS custos:
    // um custo FIXO de arranque + carga da base (MEDIDO, controlo 2×: ~7,2 s)
    // e um custo POR FICHEIRO (MEDIDO: ~4,9 s por um benigno de 32 MB).
    // Com o default antigo (10 s × N), um scan de 1 ficheiro de 32 MB custava
    // ~11,7 s e ERA morto — demonstrado no bridge real: 10 s → timeout
    // (degraded, killed), 20 s → clean (exit 0), mesmo ficheiro e base.
    // O default passa a cobrir o custo fixo:
    //   default = STARTUP + N × PER_FILE, cap 600 s;
    // um override EXPLÍCITO (options.scanTimeoutMs) mantém o contrato antigo
    //   total = N × override,
    // para que os chamadores que fixam orçamento (testes de 60 ms incluídos)
    // não vejam a semântica mudar.
    const overrideDeOrcamento = this.options.scanTimeoutMs;
    const fileCount = Math.max(1, filePaths.length);
    const timeoutMs =
      overrideDeOrcamento !== undefined
        ? Math.min(MAX_BATCH_TIMEOUT_MS, overrideDeOrcamento * fileCount)
        : Math.min(MAX_BATCH_TIMEOUT_MS, DEFAULT_SCAN_STARTUP_MS + DEFAULT_SCAN_TIMEOUT_MS * fileCount);

    // O CAP. Uma vaga por clamscan vivo, transversal a todos os chamadores.
    // Sem isto, cada ~6 s de carga de base (~981 MB) somava a um clamscan
    // anterior ainda a terminar.
    // ── PRIORIDADE ──
    //
    // MEDIDO (2026-10-07, Quick Scan real ea56fe6a): a vaga global tinha
    // `active=1 waiting=79` e o batch de 730 candidatos do scan do utilizador
    // ficou ~40 s à espera sem nunca arrancar, atrás de ~80 análises unitárias
    // de background (`scanId=n/a`, `count=1 strategy=argv`).
    //
    // A classe NÃO é inventada aqui: é a impressão digital medida. Um scan do
    // utilizador traz um `scanId` (é o ScanManager que o gera); as análises
    // automáticas de ficheiro/processo passam por `analysis.ts` e chegam sem
    // `scanId` nenhum. `options.priority` existe para um chamador futuro que
    // precise de o dizer explicitamente, mas o default não depende de ninguém
    // se lembrar: quem não traz scanId é background.
    const priority: ClamavJobPriority =
      options.priority ?? (options.scanId ? "user" : "background");
    const slotStartedAt = Date.now();
    scanPerfLog(
      "CLAMAV_SLOT_ACQUIRE_BEGIN",
      options.scanId,
      `priority=${priority} active=${globalClamavSlots.active} waitingUser=${globalClamavSlots.waitingUser.length} waitingBackground=${globalClamavSlots.waitingBackground.length} poisoned=${globalClamavSlots.poisoned} limit=${this.concurrencyLimit}`,
    );
    // HEARTBEAT DA ESPERA PELA VAGA. A vaga é GLOBAL (1) e partilhada com o
    // monitor de ficheiros, o monitor de processos e o dashboard: se outro
    // chamador a tiver, este batch espera sem limite nenhum. Sem este batimento
    // a espera é indistinguivel de um spawn que nunca escreve — e e' essa a
    // diferenca entre "outro clamscan tem a vaga" e "o clamscan arrancou mudo".
    let slotHeartbeat: NodeJS.Timeout | null = null;
    if (globalClamavSlots.poisoned === 0 && globalClamavSlots.active >= this.concurrencyLimit) {
      slotHeartbeat = setInterval(() => {
        scanPerfLog(
          "CLAMAV_SLOT_WAIT",
          options.scanId,
          `waitedMs=${Date.now() - slotStartedAt} priority=${priority} active=${globalClamavSlots.active} waitingUser=${globalClamavSlots.waitingUser.length} waitingBackground=${globalClamavSlots.waitingBackground.length} poisoned=${globalClamavSlots.poisoned} limit=${this.concurrencyLimit}`,
        );
      }, 5000);
    }
    const slot = await acquireClamavSlot(this.concurrencyLimit, priority, options.signal);
    if (slotHeartbeat) clearInterval(slotHeartbeat);
    scanPerfLog(
      "CLAMAV_SLOT_ACQUIRE_END",
      options.scanId,
      `result=${slot} priority=${priority} elapsedMs=${Date.now() - slotStartedAt} active=${globalClamavSlots.active} waitingUser=${globalClamavSlots.waitingUser.length} waitingBackground=${globalClamavSlots.waitingBackground.length} poisoned=${globalClamavSlots.poisoned} droppedBackground=${globalClamavSlots.droppedBackground}`,
    );
    // Vaga envenenada: há um clamscan vivo cuja morte ninguém confirmou. Não
    // admitimos outro — seria 2 GB em voo. E não fingimos que o ficheiro está
    // limpo: `unavailable` é a verdade, e o utilizador vê "motor indisponível".
    if (slot === "poisoned") {
      return unavailable(POISONED_SCAN_DETAIL);
    }
    // Fila de background cheia: recusa HONESTA e contabilizada. O ficheiro fica
    // `error`/`unavailable` (nunca "limpo"), e diz-se porquê.
    if (slot === "overloaded") {
      scanPerfLog(
        "CLAMAV_SLOT_OVERLOADED",
        options.scanId,
        `priority=${priority} dropped=${globalClamavSlots.droppedBackground} waitingBackground=${globalClamavSlots.waitingBackground.length} limit=${MAX_QUEUED_BACKGROUND_JOBS}`,
      );
      return unavailable(OVERLOADED_SCAN_DETAIL);
    }
    // Cancelado enquanto esperava: saiu da fila sem consumir a vaga.
    if (slot === "aborted") {
      return unavailable("Scan ClamAV cancelado enquanto aguardava vaga");
    }
    let handle: ClamavSpawnHandle | null = null;
    let onAbort: (() => void) | null = null;
    let deadline: NodeJS.Timeout | null = null;
    let timedOut = false;
    // O outcome vive para o `finally`: é lá que se decide se a vaga volta à
    // circulação ou fica envenenada (ver `poisonClamavSlot`).
    let lastOutcome: ClamavSpawnOutcome | null = null;

    try {
      if (this.disposed || options.signal?.aborted) {
        // NÃO liberta a vaga aqui: o `finally` liberta. Libertar nos dois
        // sitios devolvia a mesma vaga duas vezes, e o clamp a zero
        // escondia o erro em vez de o evitar.
        return unavailable("Scan ClamAV cancelado enquanto aguardava vaga");
      }

      // ── A LISTA TEMPORÁRIA NASCE AQUI, DENTRO DO `try` ──
      //
      // CODEX (2026-10-07, finding MEDIUM): criada ANTES do `try`, um `return`
      // antecipado do semáforo (`poisoned` / `overloaded` / `aborted`) saía sem
      // passar pelo `finally` — e deixava em disco uma lista com os CAMINHOS DO
      // UTILIZADOR, o oposto exacto da promessa escrita nesse `finally`.
      //
      // O NOME TEM DE SER ÚNICO (finding HIGH do mesmo review): `pid + Date.now()`
      // colidia para dois batches preparados no mesmo milissegundo, porque a
      // preparação corre FORA da vaga. Contador monotónico + sufixo aleatório
      // fecham a colisão dentro do processo e entre processos.
      if (usarFileList) {
        listFile = path.join(
          os.tmpdir(),
          `cybersafe-clamav-batch-${process.pid}-${++batchListSeq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.txt`,
        );
        scanPerfLog("FILE_LIST_CREATE_BEGIN", options.scanId, `entries=${filePaths.length}`);
        const fileListContents = filePaths.join("\n") + "\n";
        await writeFile(listFile, fileListContents, "utf-8");
        scanPerfLog(
          "FILE_LIST_CREATED",
          options.scanId,
          `path=${path.basename(listFile)} entries=${filePaths.length} bytes=${Buffer.byteLength(fileListContents, "utf-8")}`,
        );
        args.push(`--file-list=${listFile}`);
      } else {
        args.push(...filePaths);
      }

      // ── RE-VERIFICAR DEPOIS DO ÚLTIMO `await` QUE ANTECEDE O SPAWN ──
      //
      // CODEX (2026-10-07, finding HIGH do re-review): o teste lá em cima corre
      // ANTES do `await writeFile`. Um `dispose()` ou um `abort()` que chegue
      // DURANTE essa escrita passava ao lado dele e o clamscan nascia na mesma
      // — ~1 GB de processo que ninguém pediu, que é exactamente a classe de P0
      // que este trabalho existe para fechar. A janela é NOVA: antes de a lista
      // nascer dentro do `try`, nenhum `await` estava entre a verificação e o
      // spawn. Nada corre entre esta linha e o `spawnFn`.
      if (this.disposed) return unavailable("ClamAV encerrado (bridge descartado)");
      if (options.signal?.aborted) {
        return unavailable("Scan ClamAV cancelado antes de arrancar");
      }

      scanPerfLog(
        "CLAMAV_BATCH_COUNT",
        options.scanId,
        `count=${filePaths.length} strategy=${listFile ? "file-list" : "argv"} file-list-path=${listFile ? path.basename(listFile) : "n/a"}`,
      );

      // `spawn()` pode LANÇAR de forma SÍNCRONA — é o que faz quando a command
      // line é demasiado longa (ENAMETOOLONG), e nesse caso não existe filho a
      // quem ligar `child.on("error")`. A excepção subia até ao `prefetchClamav`,
      // que a tratava como "sem prefetch" e devolvia TODOS os ficheiros ao
      // clamscan individual: a cascata de ~981 MB por ficheiro. Aqui a falha
      // fica no scan que a sofreu, sob a forma honesta: `unavailable`.
      scanPerfLog(
        "CLAMSCAN_SPAWN_BEGIN",
        options.scanId,
        `argCount=${args.length} argvChars=${argvChars(args)} strategy=${listFile ? "file-list" : "argv"}`,
      );
      try {
        // O binário RESOLVIDO é lançado pelo caminho absoluto: é o que faz uma
        // instalação fora do PATH ser utilizável. Sem resolução, o nome simples
        // mantém o comportamento antigo (o PATH decide).
        handle = spawnFn(clamavSpawnFile(this._binaryPath), args, {
          timeoutMs,
          windowsHide: true,
          onProgress: options.onProgress,
          scanId: options.scanId,
        });
        scanPerfLog("CLAMSCAN_SPAWN_RETURN", options.scanId, `pid=${handle?.pid ?? "unknown"}`);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        scanPerfLog("CLAMSCAN_SPAWN_THROW", options.scanId, `code=${String(code ?? "unknown")}`);
        const detail =
          `clamscan não arrancou: ${code || (err as Error)?.message || "erro desconhecido"}`;
        this._health = { status: "unavailable", detail };
        return unavailable(detail);
      }
      if (!handle) {
        scanPerfLog("CLAMSCAN_SPAWN_NO_HANDLE", options.scanId);
        return unavailable("clamscan não arrancou: sem handle");
      }
      this.liveHandles.add(handle);
      if (typeof handle.pid === "number") trackClamavPid(handle.pid);

      // O DEADLINE É DA BRIDGE, não do spawner.
      //
      // Delegá-lo no spawner queria dizer que a garantia "nenhum clamscan
      // sobrevive" dependia de quem implementa o spawn. O bridge tem de a
      // impor: é o deadline dele que mata, e é o outcome dele que resolve.
      deadline = setTimeout(() => {
        timedOut = true;
        scanPerfLog("CLAMAV_BATCH_TIMEOUT", options.scanId, `origin=${priority === "user" ? "batch-user" : "batch-background"} pid=${handle?.pid ?? "unknown"} budgetMs=${timeoutMs} files=${filePaths.length} active=${globalClamavSlots.active} poisoned=${globalClamavSlots.poisoned} termination=requested`);
        handle?.killTree();
      }, timeoutMs);

      if (options.signal) {
        onAbort = () => handle?.killTree();
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      // HEARTBEAT DO FILHO. Depois do spawn, a unica prova de vida e' o stdout
      // do clamscan (a base leva ~5,8 s a carregar). Se o filho arranca e fica
      // mudo, sem isto so se ve' `CLAMSCAN_PID` e depois silencio: nao se
      // distingue "a carregar a base" de "encravado".
      const childStartedAt = Date.now();
      const childHeartbeat = setInterval(() => {
        scanPerfLog(
          "CLAMAV_CHILD_WAIT",
          options.scanId,
          `pid=${handle?.pid ?? "unknown"} waitedMs=${Date.now() - childStartedAt}`,
        );
      }, 10000);
      let outcome: ClamavSpawnOutcome;
      try {
        outcome = await handle.outcome;
        scanPerfLog(
          "CLAMAV_CHILD_OUTCOME_RESOLVE",
          options.scanId,
          `pid=${handle.pid ?? "unknown"} code=${outcome.code} elapsedMs=${Date.now() - batchStart} timedOut=${timedOut} killed=${outcome.killed === true} deathUnconfirmed=${outcome.deathUnconfirmed === true}`,
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code ?? "unknown";
        scanPerfLog("CLAMAV_CHILD_OUTCOME_REJECT", options.scanId, `pid=${handle.pid ?? "unknown"} code=${String(code)}`);
        throw error;
      } finally {
        clearInterval(childHeartbeat);
      }
      lastOutcome = outcome;

      // Um clamscan que não arranca não é deteção nem motor activo: dizemos
      // o que happened em vez de fingir que escaneámos.
      if (/ENOENT|not found|não.*encontrad/i.test(outcome.stderr) && outcome.code === null) {
        this._health = { status: "unavailable", detail: "clamscan não encontrado" };
        return {
          files: filePaths.map((file) => ({ file, verdict: "error" as const, reason: "engine-missing" as const, detail: this._health.detail })),
          detected: false,
          errorCount: filePaths.length,
          status: this._health,
        };
      }

      const batch = parseClamavOutput({
        files: filePaths,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        code: outcome.code,
        timedOut,
        killed: outcome.killed,
        fileExists: (file) => existsSync(file),
      });
      // O estado do motor só é reescrito quando o que descobrimos é sobre o
      // MOTOR. Um ficheiro ilegível não degrada o ClamAV: degrada aquele
      // ficheiro. Marcar o motor degradado por causa de um ficheiro seria
      // apanhar o motor de mentira — e era pegajoso, porque `_health` só se
      // recalcula no probe.
      //
      // RECUPERAÇÃO (2026-10-16) — o outro lado da mesma moeda. MEDIDO
      // (determinístico, sem carga): um batch limpo e COMPROVADAMENTE
      // carregado (todos os ficheiros com veredicto clean/detected e exit
      // válido) deixava `_health` preso em `degraded` até ao próximo probe —
      // o motor dizia-se degradado logo depois de analisar 3/3 ficheiros com
      // a base carregada. Só evidência POSITIVA recupera:
      //  - `batch.status === "active"` sozinho NÃO basta ("N de M sem
      //    veredicto", ex.: start-up 3221225794, não é prova de nada);
      //  - timeouts/aborts têm batch não-active e continuam a degradar;
      //  - exit válido = 0 (tudo limpo) ou 1 com deteção atribuída (FOUND);
      //  - o ÚLTIMO PROBE tem de ter dito `active` — um batch limpo prova que
      //    o scanner correu, não que a base está fresca. Sem isto, uma base
      //    expirada (> 7 dias) recuperaria para `active` por ter analisado
      //    ficheiros (revisão 2026-10-16); a saúde da base é do probe, que o
      //    `afterSwap` do freshclam reexecuta.
      const todosComVeredictoPositivo =
        batch.files.length > 0 &&
        batch.files.every((f) => f.verdict === "clean" || f.verdict === "detected");
      const exitValido = outcome.code === 0 || (batch.detected && outcome.code === 1);
      if (batch.status.status !== "active") {
        this._health = batch.status;
      } else if (this._databaseHealth?.status === "active" && todosComVeredictoPositivo && exitValido) {
        this._health = batch.status;
        // A disponibilidade cacheada não pode continuar false após recuperação.
        // Não substituir uma prova concorrente nem ressuscitar após dispose.
        if (!this.disposed && !this.probeInFlight) this.probePromise = Promise.resolve(true);
      }

      // A18 — morte NÃO CONFIRMADA é `unavailable`, nunca `degraded`.
      //
      // O outcome já traz `deathUnconfirmed`: pedimos o fim, a tolerância
      // passou e nem a sessão de handle nem o SO confirmaram. O `finally` ainda
      // vai envenenar a vaga, portanto o scan seguinte já responde
      // `unavailable` — mas este resultado, que é o PRIMEIRO a falar com o
      // utilizador, dizia `degraded` com um texto de timeout que AFIRMA
      // terminação. É uma afirmação sem prova, do género que este pacote veio
      // desfazer.
      //
      // O resultado de erro da análise é preservado tal como estava: só o estado
      // do motor é corrigido.
      if (outcome.deathUnconfirmed === true) {
        const detail =
          "Análise não concluída: foi pedido o fim do ClamAV mas a terminação não foi confirmada. " +
          "O motor fica indisponível até haver prova de morte, para não arrancar um segundo clamscan.";
        this._health = { status: "unavailable", detail };
        return { ...batch, status: { status: "unavailable", detail } };
      }
      return batch;
    } finally {
      if (deadline) clearTimeout(deadline);

      // ── A VAGA DECIDE-SE PRIMEIRO, ANTES DE QUALQUER `await` ──
      //
      // CODEX (2026-10-07, finding HIGH): com o `await rm(...)` à frente disto
      // havia uma janela real — o grace resolve o outcome, a limpeza do
      // ficheiro suspende o `finally`, e nesse intervalo o `close` do filho
      // corre `releasePoisonedClamavSlot()`, que liberta/transfere a vaga com
      // `poisoned` ainda a 0; o `finally` retoma e ENVENENA uma vaga já
      // entregue. Daí para a frente TODOS os scans respondem "indisponível"
      // até reiniciar o serviço. Era o mesmo "motor indisponível para sempre"
      // que o comentário do `close` dizia estar fechado: a ordem
      // microtarefa/macrotarefa que o justificava deixou de valer quando
      // apareceu um `await` no meio.
      //
      // A vaga SÓ volta se a morte estiver confirmada. `deathUnconfirmed`
      // significa que pedimos para matar, a tolerância passou e nem o
      // `taskkill` nem o SO confirmaram: o processo pode estar vivo com ~1 GB.
      // Libertar aqui era o P0 original — 2 clamscans em paralelo, o PC a
      // congelar — reintroduzido pela rede de segurança do `killTree`.
      if (lastOutcome?.deathUnconfirmed === true) poisonClamavSlot();
      else releaseClamavSlot();

      // SÓ DEPOIS a limpeza. A lista tem de sair de disco: é uma lista dos
      // ficheiros do utilizador, e o tmpdir do serviço não é o sítio para a
      // deixar.
      if (listFile) {
        await rm(listFile, { force: true }).catch((err: unknown) => {
          // Best effort continua a ser best effort: não falhar o scan por causa
          // disto. Mas deixar em SILÊNCIO uma lista com caminhos do utilizador
          // em disco era a única parte desta limpeza que ainda não era
          // diagnostícável (CODEX, nota do re-review). Passa a ter linha.
          scanPerfLog(
            "FILE_LIST_REMOVE_FAILED",
            options.scanId,
            `path=${path.basename(listFile as string)} err=${String((err as Error)?.message ?? err)}`,
          );
        });
      }
      if (options.signal && onAbort) options.signal.removeEventListener("abort", onAbort);
      if (handle) {
        untrackClamavPid(handle.pid);
        this.liveHandles.delete(handle);
      }

      // CODEX: a lease da base sofre do MESMO problema da vaga, e pela MESMA
      // razao. `deathUnconfirmed` nao e "o scan acabou": e "ninguem provou que
      // morreu". Libertar a lease aqui diria ao gate que a base esta livre
      // enquanto o clamsscan pode ter 1 GB dela abertos — e o freshclam
      // escreveria por cima.
      //
      // A lease passa a ser libertada pelo `close` do filho, que e a prova do
      // SO. Se a morte nunca vier, a lease fica presa: e o estado honesto, o
      // mesmo pelo qual a vaga fica envenenada.
      if (leaseBox.lease && lastOutcome?.deathUnconfirmed === true) {
        const lease = leaseBox.lease;
        leaseBox.deferred = true;
        // CODEX: NÃO se substitui isto por `= lease.release()`. Uma atribuição
        // aqui sobrescreveria o mecanismo do spawner e a lease ficaria presa
        // para sempre. É um registo, e por isso o gancho continua a correr.
        if (handle && typeof handle.onDeathConfirmed === "function") {
          handle.onDeathConfirmed(() => {
            scanPerfLog("DB_LEASE_RELEASE", options.scanId, "reason=child-death-confirmed");
            lease.release();
          });
        } else {
          // CODEX (2026-10-03): este `else` é a mentira que o resto do bloco
          // existe para não contar. Sem gancho de prova de morte, libertar a
          // lease diria ao gate que a base está livre — mas `deathUnconfirmed`
          // quer dizer exactamente o oposto: NINGUÉM PROVOU que o clamscan
          // morreu. Um freshclam escreveria por cima de um processo que pode ter
          // 1 GB da base abertos, que é a corrida que este gate existe para
          // fechar, reintroduzida pela porta do "não sei".
          //
          // Prender a base é o estado HONESTO, e é o mesmo pelo qual a vaga
          // fica envenenada: nenhuma das duas se resolve sem prova do SO. A
          // consequência é o motor indisponível até ao reinício — que é uma
          // degradação declarada, e muito melhor do que uma base corrompida em
          // silêncio. O spawner de PRODUÇÃO tem sempre o gancho; este ramo só
          // existe para spawners injectados que não o exponham.
          leaseBox.deferred = true;
        }
      }
    }
  }
}
