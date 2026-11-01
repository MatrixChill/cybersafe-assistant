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

/** Lê `src/...` com o EOL do checkout irrelevante: o contrato é o conteúdo. */
const ler = (...partes: string[]) =>
  readFileSync(
    path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "src", ...partes),
    "utf8",
  ).replace(/\r\n/g, "\n");

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

/** Os summaries que o App.tsx mostra em toast, para o guard se auto-verificar. */
// O auto-kill saiu do engine: "Processo bloqueado por caminho" deixou de ser
// publicado, e os dois process.suspicious honestos ("processo não terminado")
// passaram a chegar ao toast. A lista espelha os summaries REAIS do engine.
const SUMARIOS_DE_TOAST = [
  "Ameaça detetada em",
  "Execução de script malicioso bloqueada",
  "Deteção anterior neste caminho; processo não terminado",
  "Assinatura detetada; processo não terminado",
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

  test("o toast mostra o summary do service tal e qual", () => {
    // Fecha o circulo pelo lado do render: o toast escreve o que o engine
    // mandou. Se alguem voltar a envolver o summary numa camada de traducao
    // na UI, este teste falha — e a correcao e desfazer a camada, nao
    // traduzir mais uma vez.
    //
    // Para onde apontava (e porque deixou de apontar): o JSX do toast saiu do
    // `App.tsx` e passou a viver em `components/SecurityEventMessage.tsx`, com
    // o texto derivado em `lib/securityEventPresentation.ts`. O guard lia o
    // App.tsx a procura de `{event.summary}` — um ponteiro, nao o contrato.
    // Passa a afirmar o invariante nos tres ficheiros do caminho vivo:
    //   1. o toast do App usa o renderizador partilhado de eventos de seguranca
    //      (nao monta uma frase propria ao lado);
    //   2. o summary cru do service chega ao DOM;
    //   3. para um evento que nao e registo de processo, o titulo da
    //      apresentacao e `original` — o summary, devolvido sem o tocar;
    //   4. nao existe tabela de traducao no caminho de render.
    // O que `securityEventPresentation` reescreve sao os registos de processo
    // (`process.exited`/`process.killed`), e reescreve-os para NAO afirmar mais
    // do que o service provou; nesses o registo original continua a ser
    // publicado ao lado, em `{event.summary}` (SecurityEventMessage.tsx:9). Os
    // eventos de seguranca — os unicos que trazem copy do engine para o toast —
    // caem no ramo por defeito, onde o titulo e o summary verbatim.
    const appSrc = ler("App.tsx");
    const mensagemSrc = ler("components", "SecurityEventMessage.tsx");
    const apresentacaoSrc = ler("lib", "securityEventPresentation.ts");

    // Um guard que le um ficheiro vazio passa sempre. Os tres têem de existir.
    assert.ok(
      appSrc.length > 1000 && mensagemSrc.length > 200 && apresentacaoSrc.length > 200,
      "o caminho de render do toast não foi lido",
    );

    assert.match(
      appSrc,
      /<SecurityEventMessage event=\{event\} \/>/,
      "o toast tem de usar o renderizador partilhado do evento de segurança",
    );
    assert.match(
      mensagemSrc,
      /\{event\.summary\}/,
      "o toast tem de renderizar o summary do service directamente",
    );
    assert.match(
      apresentacaoSrc,
      /return\s*\{\s*text:\s*original\s*\|\|/,
      "fora dos registos de processo, o título do toast tem de ser o summary cru",
    );

    // A camada removida nao pode voltar a aparecer no App.tsx — nem em mais
    // nenhum ficheiro do caminho de render, como código: os comentarios sao
    // retirados antes de procurar, porque documentar a historia nao e traduzir.
    const codigoDoCaminho = [appSrc, mensagemSrc, apresentacaoSrc]
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(
      appSrc,
      /translateToastSummary/,
      "a traducao de summary foi removida: nao pode voltar a aparecer no App.tsx",
    );
    for (const ingles of ENGLISH_TOAST_SUMMARY) {
      assert.ok(
        !codigoDoCaminho.includes(ingles),
        `apareceu "${ingles}" no caminho de render: uma camada de traducao voltou — a correcao e no service`,
      );
    }
  });
});