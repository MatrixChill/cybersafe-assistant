import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * TP-V2-SCANNER-S2-DROP-ADAPTER — qoder.
 *
 * A moldura de largada do laboratório (`ultimate.css:401-420`) como apresentação
 * do produto, com tokens `--v2-*`. A decisão do integrador está no packet: a
 * geometria é reutilizável mesmo que o protótipo recuse `Files`; o que não é
 * reutilizável é o comportamento de demonstração.
 *
 * O invariante que este ficheiro existe para provar: **um só nó com handlers**.
 * O bloco de idle mantém `onDragOver`/`onDragLeave`/`onDrop` no invólucro que já
 * os tinha (linhas 1483-1485) e a moldura é um filho de apresentação — portanto
 * a área de largada NÃO foi encolhida para caber no desenho.
 */

const ler = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const pagina = ler("../src/pages/FileScannerPage.tsx");
const codigo = pagina.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const folha = ler("../src/v2/scanner/scanner-v2.css");
const semComentario = folha.replace(/\/\*[\s\S]*?\*\//g, "");

describe("Scanner S2 — moldura de largada com a anatomia do lab", () => {
  test("os handlers continuam num só nó, e a moldura é filha desse nó", () => {
    assert.equal((codigo.match(/onDragOver=\{handleDragOver\}/g) ?? []).length, 1, "dragover duplicado = duas zonas de largada");
    assert.equal((codigo.match(/onDragLeave=\{handleDragLeave\}/g) ?? []).length, 1);
    assert.equal((codigo.match(/onDrop=\{handleDrop\}/g) ?? []).length, 1, "drop duplicado");
    const abreBloco = codigo.indexOf('{uiStatus === "idle" && (');
    assert.ok(abreBloco >= 0, "faltou o bloco idle");
    const bloco = codigo.slice(abreBloco, codigo.indexOf("{error && (", abreBloco) > abreBloco ? codigo.indexOf("{error && (", abreBloco) : abreBloco + 4000);
    const eventos = bloco.indexOf("onDrop={handleDrop}");
    const moldura = bloco.indexOf('className={cn("v2-scanner-drop"');
    assert.ok(eventos >= 0 && moldura > eventos, "a moldura tem de vir DEPOIS do nó que recebe os eventos — é apresentação dentro do alvo, não um alvo novo");
    assert.equal(bloco.slice(0, eventos).includes("v2-scanner-drop"), false, "nenhuma moldura antes do nó de eventos");
  });

  test("estado de arrastar ligado ao isDragging real, com a classe do lab", () => {
    assert.match(codigo, /className=\{cn\("v2-scanner-drop", isDragging && "v2-scanner-drop--arrastando"\)\}/);
    assert.match(semComentario, /\.cs-v2 \.v2-scanner \.v2-scanner-drop\.v2-scanner-drop--arrastando \{\s*border-color: var\(--v2-accent\);\s*background: var\(--v2-accent-soft\);\s*\}/);
  });

  test("anatomia transcrita de ultimate.css:401-416, com tokens do produto", () => {
    const caixa = semComentario.match(/\.cs-v2 \.v2-scanner \.v2-scanner-drop \{([^}]*)\}/);
    assert.ok(caixa, "faltou a regra da moldura");
    const corpo = caixa[1];
    for (const métrica of [
      "display: flex",
      "flex-direction: column",
      "align-items: center",
      "gap: 10px",
      "text-align: center",
      "border: 1px dashed var(--v2-border-strong)",
      "border-radius: var(--v2-card-radius)",
      "padding: 24px",
      "background: var(--v2-inset)",
      "margin-bottom: 20px",
    ]) {
      assert.ok(corpo.includes(métrica), `métrica do lab em falta na moldura: ${métrica}`);
    }
    assert.match(semComentario, /\.cs-v2 \.v2-scanner \.v2-scanner-drop p,\s*\.cs-v2 \.v2-scanner \.v2-scanner-drop small \{\s*font-size: 11px;\s*\}/);
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(semComentario), false, "cor literal");
  });

  test("nada de texto ou comportamento de demonstração", () => {
    for (const demo of ["Nenhum ficheiro real", "recusados", "amostra", "fictíci", "demo", "Larga aqui uma amostra", "Arrasta ou seleciona", "ANÁLISE DEMO"]) {
      assert.equal(codigo.toLowerCase().includes(demo.toLowerCase()), false, `texto de demo no produto: ${demo}`);
    }
    // A instrução factual do produto mantém-se: ficheiro OU pasta, e o que
    // acontece depende da confirmação — não do protótipo.
    assert.match(pagina, /Solte o ficheiro ou a pasta aqui/);
    assert.match(pagina, /Escolha uma das análises abaixo\. Também pode arrastar um ficheiro para esta área\./);
  });

  test("gates e restantes blocos intactos", () => {
    assert.match(pagina, /onDragOver=\{handleDragOver\}/);
    assert.match(pagina, /handleConfirmFolder/);
    assert.match(pagina, /handleCancelFolder/);
    assert.match(pagina, /<FolderConfirmationPanel/);
    assert.match(pagina, /pendingFolder &&/);
    assert.match(pagina, /className="scan-options grid grid-cols-1 md:grid-cols-2 gap-4"/, "os cartões de análise continuam dentro do mesmo bloco");
    assert.match(pagina, /scan-option cs-scanner-acao/);
    assert.match(pagina, /<ScanEngineState engineHealth=\{engineHealth\} serviceConnected=\{serviceConnected\} \/>/);
    assert.match(pagina, /handleDrop/);
  });
});
