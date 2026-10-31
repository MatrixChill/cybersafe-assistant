import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  decideCartaoLargura,
  mesmoCaminho,
  PER_FILE_PASTA_NOTE,
  type CartaoLargura,
} from "../src/lib/scanSession";
import FileScannerPage, { PerFileEngineCard, type PerFileCardState } from "../src/pages/FileScannerPage";

/**
 * UI-D4 (TP-PAP-UI-FUNCTIONAL-20261028, Qoder) — uma pasta larga-se como pasta.
 *
 * O defeito, reportado pelo Codex e confirmado na base desta lane: o `drop`
 * (`FileScannerPage.tsx:910-932`) pintava sempre o cartão por ficheiro
 * («Ficheiro analisado» + «Analisar com os motores»), quer o caminho largado
 * fosse um ficheiro quer uma pasta. O cartão é a interface de `scan.artifact`,
 * que é análise de UM ficheiro; para uma pasta oferecia um pedido sem sentido e
 * chamava «ficheiro» ao que o serviço classifica como `directory`.
 *
 * Fonte da verdade: `ScanState.targetKind` ("file" | "directory", partilhado em
 * `shared-types`, normalizado em `scanSession.ts:258`). Antes do serviço falar,
 * nada é adivinhado — nem por extensão, nem pelo `File` do browser.
 */

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const fontePagina = readFileSync(new URL("../src/pages/FileScannerPage.tsx", import.meta.url), "utf8");

describe("decideCartaoLargura — só o que o serviço diz", () => {
  test("file e directory têm leitura própria", () => {
    assert.equal(decideCartaoLargura("file"), "ficheiro");
    assert.equal(decideCartaoLargura("directory"), "pasta");
  });

  test("ausência de leitura não é ficheiro", () => {
    for (const valor of [undefined, null, "", "File", "dir", 0, false]) {
      assert.equal(decideCartaoLargura(valor), "sem_leitura", `«${String(valor)}» não confirma nada`);
    }
    const vocabulario: CartaoLargura[] = ["sem_leitura", "ficheiro", "pasta"];
    assert.equal(vocabulario.length, 3);
  });
});

describe("mesmoCaminho — ligar a largura à análise que ela lançou", () => {
  test("separadores, maiúsculas e barra final não fazem outro caminho", () => {
    assert.ok(mesmoCaminho("C:\\Users\\caioc\\Downloads", "C:/Users/caioc/Downloads/"));
    assert.ok(mesmoCaminho("C:/Temp/Fixo", "c:\\temp\\fixo"));
  });

  test("caminhos diferentes não colam", () => {
    assert.ok(!mesmoCaminho("C:/Temp/a", "C:/Temp/b"));
    assert.ok(!mesmoCaminho("C:/Temp", "C:/Temp2"));
  });

  test("sem texto não há comparação", () => {
    assert.ok(!mesmoCaminho("", ""));
    assert.ok(!mesmoCaminho(undefined, "C:/Temp"));
    assert.ok(!mesmoCaminho("C:/Temp", null));
  });
});

describe("cartão renderizado — pasta confirmada", () => {
  const desenha = (estado: PerFileCardState) =>
    renderToStaticMarkup(createElement(PerFileEngineCard, { estado, onAnalisar: () => {}, scanAtivo: false }));

  test("pasta larga não se chama ficheiro e não oferece análise por motor", () => {
    const html = desenha({ fase: "diretorio", fileName: "Documentos" });
    assert.match(html, /Pasta largada/);
    assert.ok(!html.includes("Ficheiro analisado"), "a palavra acompanha o que o serviço confirmou");
    assert.ok(!html.includes("Analisar com os motores"), "não se oferece ao serviço o que ele não faz aqui");
    assert.ok(html.includes(PER_FILE_PASTA_NOTE));
    assert.match(html, /data-fase="diretorio"/);
    assert.match(html, /role="status"/);
  });

  test("ficheiro mantém o que sempre fez", () => {
    const html = desenha({ fase: "disponivel", fileName: "setup.exe" });
    assert.match(html, /Ficheiro analisado/);
    assert.match(html, /Analisar com os motores/);
    assert.ok(!html.includes(PER_FILE_PASTA_NOTE));
  });

  test("sem sessão a página abre sem cartão nenhum", () => {
    const html = renderToStaticMarkup(createElement(FileScannerPage, {}));
    assert.ok(!html.includes("cs-scanner-perfile"), "o cartão só existe com uma largura real");
    assert.match(html, /O que pretende analisar\?/);
  });
});

describe("verificação estrutural (o efeito não corre em SSR)", () => {
  test("a confirmação do serviço é o que muda o cartão", () => {
    assert.match(fontePagina, /const decisao = decideCartaoLargura\(scanProgress\.targetKind\)/);
    assert.match(fontePagina, /if \(decisao === "sem_leitura"\) return/, "antes de o serviço falar, nada muda");
    assert.match(fontePagina, /if \(!mesmoCaminho\(scanProgress\.targetPath, largura\.caminho\)\) return/);
    assert.match(fontePagina, /\{ fase: "diretorio", fileName: atual\.fileName \}/);
  });

  test("a análise dirigida recusa a pasta pela verdade síncrona, não pelo render", () => {
    assert.match(fontePagina, /if \(larguraTipoRef\.current === "pasta"\) return/);
    assert.match(fontePagina, /larguraTipoRef\.current = decisao/);
    assert.match(fontePagina, /larguraTipoRef\.current = "sem_leitura"/, "uma largura nova recomeça sem leitura");
  });

  test("uma página nova nunca mostra a pasta como pronta", () => {
    // `diretorio` não tem factos: o ramo `pronto` continua a exigir resposta.
    const ramosProntos = fontePagina.match(/estado\.fase === "pronto"/g) ?? [];
    assert.ok(ramosProntos.length >= 1);
    assert.match(fontePagina, /type PerFileCardState =[\s\S]*\| \{ fase: "diretorio"; fileName: string \}/);
  });
});
