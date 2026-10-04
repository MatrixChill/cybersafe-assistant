import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Copy em ingles que chega ao ecra, corrigida NA ORIGEM (o service).
 *
 * Estas strings sao payloads que o renderer mostra ao utilizador: o `reason` de
 * um evento `process.suspicious`, o `summary` de um `scan.progress`, e o
 * `detail` do motor WFP que entra em `degradedReasons` e dai chega as findings
 * do PcState.
 *
 * Corrigir no frontend seria tratar o sintoma: o mesmo texto continua a viajar
 * pelo pipe e qualquer outro consumidor le-o em ingles. A origem e o service.
 *
 * O teste e de ANALISE DE FONTE, nao de DOM: nao se monta React neste package.
 * Prova que o texto ingles deixou de ser emitido, nao o que o ecra mostra.
 */

const engineRaw = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");
const bridgeRaw = readFileSync(new URL("../src/native-engine-bridge.ts", import.meta.url), "utf8");

/**
 * So o que e EMITIDO, nao o que e comentado. Um comentario em ingles sobre a
 * politica de VT e nota interna e nao chega ao utilizador; conta-lo como copy
 * seria obrigar a reescrever comentarios sem qualquer ganho e sem relacao com o
 * problema. O que interessa e strings que o service coloca em payloads.
 */
function semComentarios(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const engine = semComentarios(engineRaw);
const bridge = semComentarios(bridgeRaw);

describe("copy do service sem ingles", () => {
  test("o resumo do progresso da analise e PT-PT", () => {
    // Antes: `Scan ${status}: ${n} files, ${m} threats`
    assert.ok(
      engine.includes("summary: `Análise ${scanState.status}: ${scanState.filesScanned} ficheiros, ${scanState.threatsFound} ameaças`"),
      "o summary do scan.progress voltou ao ingles",
    );
    assert.doesNotMatch(engine, /files, \$\{scanState\.threatsFound\} threats/);
    assert.doesNotMatch(engine, /`Scan \$\{scanState\.status\}/, "summary em ingles no progresso");
  });

  test("o motivo da heuristica e PT-PT", () => {
    assert.doesNotMatch(engine, /Suspicious command line pattern detected/i);
    assert.doesNotMatch(engine, /no auto-kill/i, "'no auto-kill' e ingles; o produto diz 'sem auto-kill'");
    assert.ok(engine.includes("Padrão suspeito na linha de comando (sem auto-kill)"));
  });

  test("o detail do motor WFP e PT-PT", () => {
    // Este detail e o que entra em degradedReasons e chega as findings.
    assert.doesNotMatch(engine, /"WFP filter (active|not started)"/i);
    assert.ok(engine.includes('"filtro WFP ativo"'));
    assert.ok(engine.includes('"filtro WFP inativo"'));
  });

  test("o erro de servico desconhecido e PT-PT", () => {
    assert.doesNotMatch(engine, /Unknown service error/i);
    assert.ok(engine.includes("Erro desconhecido do serviço"));
  });

  test("as detecoes do VirusTotal sao PT-PT", () => {
    assert.doesNotMatch(engine, /VT detections/i);
    assert.ok(engine.includes("deteções VT"));
  });

  test("nenhum dos textos user-facing devolvidos pelo service fica em ingles", () => {
    // Varredura de recurso: apanha o que os testes anteriores nao nomeiam.
    const proibidos = [
      "Suspicious command line",
      "no auto-kill",
      "WFP filter active",
      "WFP filter not started",
      "Unknown service error",
      "VT detections",
    ];
    for (const p of proibidos) {
      assert.doesNotMatch(engine, new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), `ainda em ingles: "${p}"`);
    }
  });

  test("o detail do motor nativo e PT-PT (mesmo caminho de fuga do WFP)", () => {
    // `NativeEngineBridge.health` entra em `engine.nativeEngine` e dai em
    // `degradedReasons` -> findings do PcState. Mesmo caminho do WFP.
    assert.doesNotMatch(bridge, /"Not checked"/i);
    assert.doesNotMatch(bridge, /Native engine at/i);
    assert.doesNotMatch(bridge, /Native engine spawn/i);
    assert.ok(bridge.includes("Ainda não verificado"));
    assert.ok(bridge.includes("Motor nativo ativo"));
    assert.ok(bridge.includes("O arranque do motor nativo falhou"));
  });

  test("os motivos de bloqueio protegido sao PT-PT", () => {
    // "blocked path mas protegido por" era PT-BR com o inicio em ingles.
    assert.doesNotMatch(engine, /blocked path mas protegido/i);
    assert.doesNotMatch(engine, /blocked hash mas protegido/i);
    assert.ok(engine.includes("path bloqueado mas protegido por"));
    assert.ok(engine.includes("hash bloqueado mas protegido por"));
  });

  test("o que NAO devia ser traduzido foi deixado quieto", () => {
    // As linguas de wire (topic do pipe, tipo de evento, status) sao contrato.
    // Traduzi-las parte o consumidor. Este teste existe para travar esse deslize.
    assert.ok(engine.includes('"process.suspicious"'), "o tipo do evento e contrato, nao copy");
    assert.ok(engine.includes('"scan.progress"'), "o tipo do evento e contrato, nao copy");
    assert.ok(engine.includes('? "active" : "unavailable"'), "os status sao contrato, nao copy");
  });
});

/**
 * W2 — o fluxo de scanner/deteccao/bloqueio por inteiro.
 *
 * Os 3 summaries que(senderam este ticket nao eram os unicos: o mesmo fluxo
 * publica mais 17 frases em ingles (ciclo de vida de processos, observacao de
 * ficheiros, persistencia, quarentena, progresso da analise completa, confianca
 * e restauracao). Traduzir so 3 deixaria o utilizador a ler ingles nos mesmos
 * toasts, por isso o sweep abaixo e a prova principal e os testes nomeados sao
 * a prova de leitura.
 *
 * REGRA: so a prosa e traduzida. Paths, PIDs, nomes de malware, `${fileName}`,
 * `${totalScanned}`, `YARA`/`ClamAV`/`Hashes` ficam intactos — sao o conteudo
 * tecnico que o utilizador usa para identificar o que foi detectado.
 */
describe("W2 — copy do fluxo de scanner, deteccao e bloqueio", () => {
  test("a observacao de ficheiros e a persistencia sao PT-PT", () => {
    assert.ok(engine.includes("Novo ficheiro observado: ${event.path}"));
    assert.ok(engine.includes("Ficheiro modificado observado: ${event.path}"));
    assert.ok(engine.includes("Persistência de registo alterada"));
    assert.doesNotMatch(engine, /New file observed|Modified file observed|Registry persistence changed/);
  });

  test("o ciclo de vida do processo e PT-PT", () => {
    assert.ok(engine.includes("Processo iniciado: ${processInfo.name}"));
    assert.ok(engine.includes("Processo terminado: ${processInfo.name}"));
    assert.ok(engine.includes("Processo terminado: ${processInfo?.name ?? pid}"));
    assert.doesNotMatch(engine, /Process started:|Process exited:/);
  });

  test("os bloqueios e o kill sao PT-PT", () => {
    // As tres traducoes iguais as do workaround de UI, para o texto nao mudar
    // de roupa no ecra: a origem passa a dizer a mesma coisa que a UI inventava.
    assert.ok(engine.includes("Execução de script malicioso bloqueada (${info.appName})"));
    assert.ok(engine.includes("Processo bloqueado por caminho: ${processInfo.name}"));
    assert.ok(engine.includes("Processo bloqueado terminado (assinatura de malware): ${processInfo.name}"));
    assert.ok(engine.includes("Árvore de processos terminada ${pid}"));
    assert.doesNotMatch(engine, /Blocked malicious script execution|Blocked process by path|Killed blocked process|Killed process tree/);
  });

  test("a analise, a ameaca e a quarentena sao PT-PT", () => {
    assert.ok(engine.includes("Analisado ${analysis.fileName}"));
    assert.ok(engine.includes("Colocado em quarentena ${analysis.fileName}"));
    assert.ok(engine.includes("Ameaça detetada em ${analysis.fileName}"));
    assert.doesNotMatch(engine, /Threat detected in|^`Analyzed |^`Quarantined /m);
  });

  test("o progresso da analise completa e PT-PT", () => {
    assert.ok(engine.includes("A iniciar análise completa do sistema..."));
    assert.ok(engine.includes("Analisados ${totalScanned} ficheiros..."));
    assert.ok(
      engine.includes("Análise completa do sistema concluída. ${totalScanned} ficheiros analisados."),
    );
    assert.doesNotMatch(engine, /Starting full system scan|`Scanned \$\{totalScanned\} files|Full system scan completed/);
  });

  test("a confianca, a restauracao e a actualizacao de definicoes sao PT-PT", () => {
    assert.ok(engine.includes("Hash permitido ${sha256}"));
    assert.ok(engine.includes("Editor permitido ${publisher}"));
    assert.ok(engine.includes("Entrada de quarentena restaurada ${id}"));
    // "YARA"/"ClamAV"/"Hashes" sao os nomes dos componentes: nao se traduzem.
    assert.ok(engine.includes("Definições atualizadas (YARA: ${result.yaraUpdated}"));
    assert.doesNotMatch(engine, /Allowed hash|Allowed publisher|Restored quarantine entry|Definitions updated/);
  });

  test("varredura: nenhum summary deste fluxo fica em ingles", () => {
    // Prova principal: apanha o que os testes nomeados acima nao cobrirem.
    const proibidos = [
      "New file observed",
      "Modified file observed",
      "Registry persistence changed",
      "Process started:",
      "Process exited:",
      "Blocked malicious script execution",
      "Blocked process by path",
      "Killed blocked process",
      "Killed process tree",
      "Threat detected in",
      "Starting full system scan",
      "Full system scan completed",
      "Allowed hash",
      "Allowed publisher",
      "Restored quarantine entry",
      "Definitions updated",
      "Quarantined ${",
      "Analyzed ${",
    ];
    for (const p of proibidos) {
      assert.doesNotMatch(
        engine,
        new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        `ainda em ingles: "${p}"`,
      );
    }
  });

  test("o conteudo tecnico sobreviveu a traducao", () => {
    // A prosa muda; o que identifica a amostra nao pode mudar. Se um destes
    // sumisse, a traducao teria comido dados em vez de palavras.
    assert.ok(engine.includes("${analysis.fileName}"), "o nome do ficheiro tem de sobreviver");
    assert.ok(engine.includes("${totalScanned}"), "o contador tem de sobreviver");
    assert.ok(engine.includes("${processInfo.name}"), "o nome do processo tem de sobreviver");
    assert.ok(engine.includes("${pid}"), "o PID tem de sobreviver");
    assert.ok(engine.includes("${sha256}"), "o hash tem de sobreviver");
    assert.ok(engine.includes("YARA:"), "os nomes dos componentes sao conteudo tecnico");
    assert.ok(engine.includes("ClamAV:"), "os nomes dos componentes sao conteudo tecnico");
  });

  test("a traducao nao pode duplicar o workaround da UI nem partir os tipos", () => {
    // O tipo do evento continua a ser o mesmo contrato de sempre, para o
    // `translateToastSummary` da UI deixar de ser necessario sem partir.
    assert.ok(engine.includes('"threat.detected"'));
    assert.ok(engine.includes('"process.blocked"'));
    assert.ok(engine.includes('"process.killed"'));
    assert.ok(engine.includes('"scan.progress"'));
    assert.ok(engine.includes('"quarantine.added"'));
  });
});