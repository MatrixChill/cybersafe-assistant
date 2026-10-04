import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as toastCopy from "../src/lib/toastCopy";

/**
 * CONTRACTO service -> app: o summary que chega ao toast ja vem em PT-PT.
 *
 * Ate aqui a UI tinha uma camada de traducao (`toastCopy.translateToastSummary`)
 * com tres padroes em ingles — "Threat detected in X", "Blocked malicious script
 * execution (app)", "Blocked process by path: X". Foram escritos quando o engine
 * publicava summary em ingles. O service foi entretanto corrigido para PT-PT
 * (engine.ts:652, :758, :1114) e o `service-copy.test.js` PROIBE explicitamente
 * o engine de voltar a emitir essas tres strings.
 *
 * Duas coisas de uma vez:
 *
 *   1. Prova a obsolescencia. Nenhum texto do engine e traduzido hoje. A camada
 *      e trabalho morto e um leitor novo nao a deve estender.
 *   2. Guarda a regressao. Se alguem meter ingles no engine, este teste falha —
 *      e o sinal e "a copy do service regressou", nao "falta um padrao novo no
 *      toastCopy". A correcao pertence ao service.
 *
 * O inverso — traduzir no cliente o que o servidor ja disse na lingua do
 * utilizador — e o caminho que produz as duas copies a divergirem.
 *
 * ── Porque este teste varre TODOS os literais, e so os summaries ──────────
 * A primeira versao fazia parse dos argumentos de cada `eventBus.publish(...)`
 * para extrair o summary. Era fragil e falhava: os templates do engine contem
 * parenteses (`(${info.appName})`), e um contador de parenteses que nao
 * distingue codigo de string fecha a chamada no sitio errado. O bug nao estava
 * no service — estava no parser, que era mais esperto do que precisava de ser.
 *
 * Varrer todos os literais e um SUPERSET dos summaries: prova estritamente mais
 * forte com menos codigo. Se nenhum literal do engine precisa de traducao,
 * nenhum summary precisa. E o servico-copy.test.js, no outro package, ja
 * garante que nao ha ingles no engine — este teste fecha o ciclo pelo lado da UI.
 */

/** A partir de packages/app/test/: ".." e app, "../.." e packages. */
const ENGINE_SRC = readFileSync(
  path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../service/src/engine.ts"),
  "utf8",
);

/**
 * Literais de template e de string do engine, com as interpolacoes
 * concretizadas. Um scanner de caracteres em vez de regex: uma regex para
 * "todos os literais" tem de lidar com escapes e com `${}` aninhado, e erra
 * calado — que e a pior forma de um guard de contrato errar.
 */
function extrairLiterais(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch !== '"' && ch !== "'" && ch !== "`") {
      i++;
      continue;
    }
    const quote = ch;
    let value = "";
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        // Escape: o proximo caractere entra tal e qual (nao fecha a string).
        value += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === quote) {
        i++;
        break;
      }
      // `${...}` dentro de template literal: substituido por um marcador que
      // nao casa nenhum padrao de traducao.
      if (quote === "`" && c === "$" && src[i + 1] === "{") {
        let depth = 1;
        i += 2;
        while (i < src.length && depth > 0) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") depth--;
          i++;
        }
        value += "EXEMPLO";
        continue;
      }
      value += c;
      i++;
    }
    if (value.trim()) out.push(value.trim());
  }
  return out;
}

const LITERAIS = extrairLiterais(ENGINE_SRC);

/** Os tres toasts que o App.tsx mostra, para o guard se auto-verificar. */
const SUMARIOS_DE_TOAST = [
  "Ameaça detetada em",
  "Execução de script malicioso bloqueada",
  "Processo bloqueado por caminho",
];

/**
 * As strings em ingles que a UI sabia traduzir. Eram o unico input da funcao
 * removida. Nenhuma pode reaparecer no service: se reaparecer, a correcao e
 * publicar PT-PT no engine.ts, nunca voltar a traduzir no cliente.
 */
const ENGLISH_TOAST_SUMMARY = [
  "Threat detected in",
  "Blocked malicious script execution",
  "Blocked process by path",
  "Killed blocked process",
  "Killed process tree",
];

describe("contrato service -> app: o summary do evento ja chega em PT-PT", () => {
  test("o scanner le mesmo os summaries que o App.tsx mostra (o guard nao e vazio)", () => {
    // Um guard que passa porque nao leu nada e um guard que mente. Este tem de
    // encontrar os tres summaries que os toasts mostram — caso contrario o
    // ficheiro inteiro passa a verde sobre um caminho errado.
    // 190 e o numero medido hoje. O limiar e folgado de propósito: serve
    // para pegar um scanner que devolveva 0 ou uma lista minuscula, nao para
    // fixar o ficheiro do engine. O guard forte sao os tres summaries abaixo.
    assert.ok(LITERAIS.length >= 150, `esperava >=150 literais, encontrei ${LITERAIS.length}`);

    const juntos = LITERAIS.join(" | ");
    for (const summary of SUMARIOS_DE_TOAST) {
      assert.ok(juntos.includes(summary), `o summary "${summary}" tem de estar aqui`);
    }
  });

  test("NENHUM texto do engine e traduzido pela camada de traducao da UI", () => {
    // A funcao de traducao foi removida, entao este teste passa por vacuuo —
    // o que seria um guard morto. O que prova e o contrapositive: a funcao
    // NAO EXISTE e o engine nao precisa dela. Se alguem reintroduzir a tabela,
    // este teste tem de falhar em vez de voltar a passar em silencio.
    assert.equal(
      Object.hasOwn(toastCopy, "translateToastSummary"),
      false,
      "translateToastSummary voltou a existir: confirmar que o engine ainda fala PT-PT",
    );

    // E o guard de conteudo, que vale sem a funcao: nenhum literal do engine
    // contem os ingleses que ela traduzia. Se um dia o engine publicar
    // english, e aqui que se apanha — antes de o utilizador o ler.
    const emIngles = LITERAIS.filter((s) => ENGLISH_TOAST_SUMMARY.some((p) => s.includes(p)));
    assert.deepEqual(
      emIngles,
      [],
      `a copy do service voltou a ser inglesa em ${emIngles.length} texto(s): ${emIngles.join(" | ")}`,
    );
  });

  test("o engine nao contem os ingleses que a UI sabia traduzir", () => {
    for (const literal of LITERAIS) {
      for (const p of ENGLISH_TOAST_SUMMARY) {
        assert.ok(
          !literal.includes(p),
          `"${literal}" voltou a estar em ingles ("${p}") — a correcao e no service, nao na UI`,
        );
      }
    }
  });

  test("App.tsx mostra o summary do service tal e qual", () => {
    // Fecha o circulo pelo lado do render: o toast escreve o que o engine
    // mandou. Se alguem voltar a envolver o summary numa camada de traducao
    // na UI, este teste falha — e a correcao e desfazer a camada, nao
    // traduzir mais uma vez.
    const appSrc = readFileSync(
      path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../src/App.tsx"),
      "utf8",
    );
    assert.match(
      appSrc,
      /\{event\.summary\}/,
      "o toast tem de renderizar o summary do service directamente",
    );
    assert.doesNotMatch(
      appSrc,
      /translateToastSummary/,
      "a traducao de summary foi removida: nao pode voltar a aparecer no App.tsx",
    );
  });
});