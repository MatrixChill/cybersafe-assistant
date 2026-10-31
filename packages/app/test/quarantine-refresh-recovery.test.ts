import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuarantineEntry } from "@cybersafe/shared-types";
import QuarantinePage, {
  decideRecuperacao,
  QUARENTENA_ATUALIZAR,
  QUARENTENA_ATUALIZAR_ARIA,
  QUARENTENA_RECUPERADA_NOTE,
  QUARENTENA_TENTAR_NOVAMENTE,
  type EstadoLeituraQuarentena,
} from "../src/pages/QuarantinePage";

/**
 * V4 (FECHAR UI FUNCIONAL, 28/10) — recuperação de erros da Quarentena.
 *
 * O que estava em falta desde a V3, medido no Electron real:
 *  1. com a ponte muda, nenhum refresh acontecia e, não tendo havido falha
 *     anterior, a página não tinha botão nenhum para repetir a leitura — o
 *     «Tentar novamente» só nascia depois de um `falhou`;
 *  2. quando a comunicação voltava, a lista simplesmente reaparecia: nada dizia
 *     ao utilizador que aquela era a leitura atual e não a anterior;
 *  3. o resultado de uma ação vivia na linha, e restaurar/eliminar tiram a linha
 *     da lista.
 *
 * Métodos: decisão pura (`decideRecuperacao`), render SSR de cada estado da
 * leitura, e asserções estruturais declaradas para o que o SSR não clica.
 */

(globalThis as Record<string, unknown>).React = React;

const pagina = readFileSync(new URL("../src/pages/QuarantinePage.tsx", import.meta.url), "utf8");

const entrada = (overrides: Partial<QuarantineEntry> = {}): QuarantineEntry => ({
  id: "e1",
  originalPath: "C:\\temp\\ameaca.dll",
  quarantinePath: "C:\\quarantine\\e1",
  fileName: "ameaca.dll",
  sha256: "a".repeat(64),
  verdict: "malicious",
  riskScore: 90,
  quarantinedAt: "2026-10-27T10:00:00.000Z",
  isolationStatus: "confirmed",
  ...overrides,
});

function renderiza(props: Partial<React.ComponentProps<typeof QuarantinePage>> = {}): string {
  return renderToStaticMarkup(
    createElement(QuarantinePage, { entries: [], onChanged: () => {}, ...props }),
  );
}

describe("decideRecuperacao — o que conta como ligação recuperada", () => {
  test("só falhou → confirmado é recuperação", () => {
    assert.equal(decideRecuperacao("falhou", "confirmado"), true);
  });

  test("primeira leitura normal não se apresenta como recuperação", () => {
    assert.equal(decideRecuperacao(undefined, "confirmado"), false, "o arranque não 'recuperou' nada");
    assert.equal(decideRecuperacao("a_ler", "confirmado"), false, "ler e depois confirmar é o curso normal");
    assert.equal(decideRecuperacao("confirmado", "confirmado"), false);
  });

  test("continuar falhado ou ficar em leitura não dispara nada", () => {
    assert.equal(decideRecuperacao("falhou", "falhou"), false);
    assert.equal(decideRecuperacao("falhou", "a_ler"), false);
    assert.equal(decideRecuperacao("falhou", undefined), false);
  });
});

describe("recarga: um só botão, sempre disponível", () => {
  const estados: Array<[EstadoLeituraQuarentena | undefined, string]> = [
    [undefined, "sem sinal (compatibilidade)"],
    ["confirmado", "leitura confirmada"],
    ["a_ler", "leitura em curso"],
    ["falhou", "leitura falhada"],
  ];

  for (const [estado, nome] of estados) {
    test(`existe botão de recarga com ${nome}`, () => {
      const html = renderiza({ estadoLeitura: estado });
      assert.match(html, /aria-label="Atualizar a lista de quarentena a partir do serviço"/, `${nome}: sem recarga`);
      assert.match(html, /<button[^>]*>[^<]*<(svg|span)[\s\S]*?(Atualizar|Tentar novamente)/, `${nome}: sem rótulo`);
    });
  }

  test("com lista vazia também há recarga (antes não havia)", () => {
    const html = renderiza({ entries: [], estadoLeitura: "confirmado" });
    assert.match(html, /A quarentena está vazia\./, "o vazio afirma-se quando foi lido");
    assert.match(html, new RegExp(QUARENTENA_ATUALIZAR));
  });

  test("o rótulo acompanha o que se pode fazer agora", () => {
    assert.match(renderiza({ estadoLeitura: "falhou" }), new RegExp(QUARENTENA_TENTAR_NOVAMENTE));
    assert.match(renderiza({ estadoLeitura: "confirmado" }), new RegExp(QUARENTENA_ATUALIZAR));
  });

  test("não há dois botões para a mesma coisa", () => {
    const recargas = pagina.match(/void recarregar\(\)/g) ?? [];
    assert.equal(recargas.length, 1, "uma só ligação ao recarregar");
    assert.equal(/onClick=\{\(\) => void onChanged\(\)\}/.test(pagina), false, "o banner tinha ficado com recarga própria");
  });
});

describe("recuperação depois de a comunicação voltar", () => {
  test("a nota de recuperação é PT-PT e não afirma cobertura", () => {
    assert.match(QUARENTENA_RECUPERADA_NOTE, /Ligação recuperada/);
    assert.match(QUARENTENA_RECUPERADA_NOTE, /vem da leitura atual/);
    assert.ok(!/sem ameaças|tudo em dia|protegido/i.test(QUARENTENA_RECUPERADA_NOTE), "não confunde ler com proteger");
  });

  test("o portador existe e é anunciado", () => {
    assert.match(pagina, /\{recuperada && \(/);
    const banda = pagina.indexOf("{recuperada && (");
    const recorte = pagina.slice(banda, banda + 1200);
    assert.match(recorte, /role="status" aria-live="polite"/);
    assert.ok(
      recorte.indexOf('role="status"') < recorte.indexOf("{QUARENTENA_RECUPERADA_NOTE}"),
      "o portador antecede a frase, senão não anuncia nada",
    );
    assert.match(pagina, /onClick=\{\(\) => setRecuperada\(false\)\}/, "a nota fecha-se");
  });

  test("a recarga não limpa o resultado anterior da ação", () => {
    // Se «Atualizar» apagasse a banda, o utilizador perdia a frase do serviço ao
    // confirmar que a lista tinha voltado — exatamente o que a V4 veio evitar.
    const recarga = pagina.indexOf("const recarregar = async");
    const corpo = pagina.slice(recarga, pagina.indexOf("};", recarga));
    assert.equal(/setBandeira/.test(corpo), false, "recarregar mexe na banda do resultado");
  });

  test("o estado anterior é guardado por ref, não por estado (sem ciclo de render)", () => {
    assert.match(pagina, /const leituraAnteriorRef = useRef<EstadoLeituraQuarentena \| undefined>\(undefined\)/);
    assert.match(pagina, /leituraAnteriorRef\.current = estadoLeitura;/);
    assert.match(pagina, /if \(decideRecuperacao\(anterior, estadoLeitura\)\) setRecuperada\(true\)/);
  });
});

describe("não apagar o que foi lido sem confirmação", () => {
  test("com falha de leitura as entradas continuam listadas e rotuladas", () => {
    const html = renderiza({ entries: [entrada()], estadoLeitura: "falhou" });
    assert.match(html, /ameaca\.dll/, "a linha lida não desaparece com a falha");
    assert.match(html, /Última leitura confirmada — esta consulta não respondeu\./);
    assert.ok(!html.includes("A quarentena está vazia"));
  });

  test("em modo embebido (aba Ameaças) a recarga também existe", () => {
    const html = renderiza({ embedded: true, entries: [entrada()], estadoLeitura: "falhou" });
    assert.match(html, new RegExp(QUARENTENA_ATUALIZAR_ARIA));
    assert.match(html, /ameaca\.dll/);
  });

  test("sem o prop, o comportamento histórico mantém-se", () => {
    const html = renderiza({ entries: [entrada()] });
    assert.ok(!html.includes("Não foi possível ler a quarentena"));
    assert.ok(!html.includes(QUARENTENA_RECUPERADA_NOTE));
    assert.match(html, /ameaca\.dll/);
  });
});
