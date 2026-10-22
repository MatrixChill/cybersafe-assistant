import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * P0 CONTRATO (15/10) — GUARDA DE DERIVA ENTRE DECLARAÇÃO E RUNTIME.
 *
 * A causa raiz do HIGH-1 nao foi o `main.ts`: foi o `ServiceResponseMap` declarar
 * `{ success: boolean }` para `monitor.start`/`monitor.stop` quando o motor devolve
 * `{ ok, protectionEnabled, failures?, degraded? }`. Uma declaracao mentirosa
 * OBRIGA a um cast, e um cast esconde a próxima mentira — o ciclo fecha-se sozinho
 * e nenhuma suite de tipos o apanha. Este teste parte o ciclo ao prender, por
 * analise de fonte (mesmo metodo de `service-copy.test.js` no service), quatro
 * factos que tenhem de continuar verdadeiros em simultaneo:
 *   1. o mapa partilhado descreve a forma real, sem `success` nestes dois topicos;
 *   2. o motor assina as respostas a PARTIR do mapa (nao copia o tipo);
 *   3. a ponte do desktop nao casta nem inventa booleanos;
 *   4. o contrato do renderer e o MESMO tipo partilhado (MED-1: `degraded` morria
 *      na tipagem porque `electron.d.ts` nao o declarava).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(__dirname, "..", "..", "..");

const ler = (...p) => readFileSync(path.join(raiz, ...p), "utf8");

const shared = ler("packages", "shared-types", "src", "index.ts");
const engine = ler("packages", "service", "src", "engine.ts");
const main = ler("packages", "desktop", "src", "main.ts");
const renderer = ler("packages", "app", "src", "electron.d.ts");

/** So o que e declarado, nao o que e comentado. */
function semComentarios(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const mapa = semComentarios(shared);

describe("1. ServiceResponseMap descreve a resposta real do motor", () => {
  it('monitor.start/stop ja nao declaram "success"', () => {
    assert.doesNotMatch(mapa, /"monitor\.start":\s*\{\s*success/, "o contrato voltou a mentir sobre monitor.start");
    assert.doesNotMatch(mapa, /"monitor\.stop":\s*\{\s*success/, "o contrato voltou a mentir sobre monitor.stop");
  });

  it("monitor.start/stop apontam para os tipos nomeados", () => {
    assert.match(mapa, /"monitor\.start":\s*ProtectionStartResult;/);
    assert.match(mapa, /"monitor\.stop":\s*ProtectionStopResult;/);
  });

  it("os tipos nomeados tem ok + protectionEnabled booleanos, e o start traz failures/degraded", () => {
    const start = /interface ProtectionStartResult \{([\s\S]*?)\n\}/.exec(mapa);
    const stop = /interface ProtectionStopResult(?: extends ProtectionRevocation)? \{([\s\S]*?)\n\}/.exec(mapa);
    assert.ok(start && stop, "ProtectionStartResult/ProtectionStopResult deixaram de existir");
    for (const corpo of [start[1], stop[1]]) {
      assert.match(corpo, /ok:\s*boolean;/);
      assert.match(corpo, /protectionEnabled:\s*boolean;/);
    }
    assert.match(start[1], /failures\?:\s*ProtectionCause\[\];/);
    assert.match(start[1], /degraded\?:\s*ProtectionCause\[\];/);
    const causa = /interface ProtectionCause \{([\s\S]*?)\n\}/.exec(mapa);
    assert.ok(causa, "ProtectionCause deixou de existir");
    assert.match(causa[1], /label:\s*string;/);
    assert.match(causa[1], /reason:\s*string;/);
  });

  it("a confirmacao da ponte e partilhada: protectionEnabled pode ser null (nao confirmado)", () => {
    const conf = /interface ProtectionToggleConfirmation(?: extends ProtectionRevocation)? \{([\s\S]*?)\n\}/.exec(mapa);
    assert.ok(conf, "ProtectionToggleConfirmation deixou de existir");
    assert.match(conf[1], /protectionEnabled:\s*boolean\s*\|\s*null;/);
    assert.match(conf[1], /degraded\?:\s*ProtectionCause\[\];/);
  });
});

describe("2. o motor assina a partir do mapa (deriva fica impossivel de escrever)", () => {
  it("startProtection/stopProtection usam ServiceResponseMap em vez de replicar o tipo", () => {
    assert.match(engine, /async startProtection\(\): Promise<ServiceResponseMap\["monitor\.start"\]>/);
    assert.match(engine, /async stopProtection\(\): Promise<ServiceResponseMap\["monitor\.stop"\]>/);
  });
});

describe("3. a ponte do desktop nao mascara o contrato", () => {
  const seam = ler("packages", "desktop", "src", "protection-toggle-result.ts");
  const bloco = /async function setProtectionEnabled[\s\S]*?\n\}/.exec(semComentarios(main));

  it("existe e delega TODO o caminho no seam testado (nenhuma segunda guarda)", () => {
    assert.ok(bloco, "setProtectionEnabled deixou de existir em main.ts");
    assert.match(bloco[0], /requestProtectionToggle\(/, "o main.ts tem de chamar o caminho que os testes executam");
    assert.doesNotMatch(bloco[0], /\btry\b|\bcatch\b/, "a guarda nao pode viver em dois sitios: o catch e do seam");
    assert.doesNotMatch(bloco[0], /interpretProtectionToggle\(/, "validar no main.ts criaria uma copia nao testada");
    assert.doesNotMatch(bloco[0], /\)\s+as\s+\{/, "voltou o cast que escondia o contrato");
  });

  it("nao inventa protectionEnabled por omissao nem sanitiza à medida", () => {
    assert.doesNotMatch(bloco[0], /:\s*true\b/, "nada pode devolver ATIVO sem booleano do serviço");
    assert.doesNotMatch(bloco[0], /\?\?\s*(true|false)/, "nem ?? true nem ?? false");
    assert.doesNotMatch(bloco[0], /Users\|users/, "o sanitizador e do seam, nao duplicado aqui");
  });

  it("o elo compile-time e o caminho de rejeicao vivem no seam", () => {
    assert.match(
      seam,
      /Promise<ServiceResponseMap\["monitor\.start"\] \| ServiceResponseMap\["monitor\.stop"\] \| undefined>/,
      "sem o elo tipado, o contrato volta a poder mentir sem ninguém dar por isso",
    );
    assert.match(seam, /catch \(err\)/);
    assert.match(seam, /protectionEnabled:\s*null/);
    assert.doesNotMatch(semComentarios(seam), /\?\?\s*true/, "a regra original (?? true) nao pode voltar em lado nenhum");
  });

  it("sem confirmacao o resultado e null: o tipo vive no contrato partilhado, o seam aliasa-o", () => {
    assert.match(seam, /export type ProtectionActionResult = ProtectionToggleConfirmation;/);
  });
});

describe("4. o renderer ve o mesmo contrato (MED-1)", () => {
  it("setProtection usa ProtectionToggleConfirmation, nao um literal local", () => {
    assert.match(renderer, /setProtection:\s*\(enabled:\s*boolean\)\s*=>\s*Promise<ProtectionToggleConfirmation\s*\|\s*null>/);
    assert.doesNotMatch(renderer, /setProtection:[\s\S]{0,160}protectionEnabled:\s*boolean;/, "o literal duplicado voltou: null desapareceu da tipagem");
  });

  it("o tipo e importado do pacote partilhado", () => {
    assert.match(renderer, /ProtectionToggleConfirmation,[\s\S]*?from "@cybersafe\/shared-types"/);
  });
});
