import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decidePaginaHistorico,
  HISTORICO_FALHA_NOTE,
  HISTORICO_SEM_CONFIRMACAO_NOTE,
  HISTORICO_ULTIMA_LEITURA_NOTE,
} from "../src/components/ScanHistoryPanel";

/**
 * UI-D2 (TP-PAP-UI-FUNCTIONAL-20261028, Qoder) — o que uma resposta de
 * `getScanHistory` prova.
 *
 * O defeito real, na base desta lane: `ScanHistoryPanel.tsx:241` fazia
 * `pagina.entries ?? []` sobre o que `getScanHistory()` devolve. Durante o
 * encerramento o preload resolve `Promise.resolve(null)`
 * (`packages/desktop/src/preload.ts:9-17`), o `null` rebentava em
 * `Cannot read properties of null (reading 'entries')`, o `catch` de `:245`
 * despejava o `e.message` cru no ecrã (`:246`) e pintava `fase="erro"` — que é
 * uma asserção de falha de leitura quando o que houve foi ausência de resposta.
 *
 * O painel é um `<section>` com estado; `renderToStaticMarkup` só veria o estado
 * inicial `a_consultar`, por isso a decisão vive na função pura testada aqui e a
 * ligação aos ramos do JSX é verificada no fonte (estrutural, declarado).
 */

const fontePainel = readFileSync(new URL("../src/components/ScanHistoryPanel.tsx", import.meta.url), "utf8");

describe("decidePaginaHistorico — página confirmada ou nada", () => {
  test("null (encerramento/sem resposta) não é página nem lista vazia", () => {
    assert.deepEqual(decidePaginaHistorico(null), { confirmada: false });
    assert.deepEqual(decidePaginaHistorico(undefined), { confirmada: false });
  });

  test("objeto sem `entries` não é uma página", () => {
    assert.deepEqual(decidePaginaHistorico({}), { confirmada: false });
    assert.deepEqual(decidePaginaHistorico({ entries: null, nextCursor: null }), { confirmada: false });
    assert.deepEqual(decidePaginaHistorico({ entries: "0" }), { confirmada: false });
    assert.deepEqual(decidePaginaHistorico("[]"), { confirmada: false }, "string não é página");
  });

  test("entradas vazias confirmadas são a única forma de dizer «sem análises»", () => {
    const decisao = decidePaginaHistorico({ entries: [], nextCursor: null });
    assert.equal(decisao.confirmada, true);
    assert.ok(decisao.confirmada && decisao.entradas.length === 0);
    assert.ok(decisao.confirmada && decisao.cursor === null);
  });

  test("página real passa entradas e cursor; cursor não-string vira null", () => {
    const entradas = [{ id: "s1", status: "completed" }];
    const decisao = decidePaginaHistorico({ entries: entradas, nextCursor: 42 });
    assert.equal(decisao.confirmada, true);
    assert.ok(decisao.confirmada);
    assert.deepEqual(decisao.entradas, entradas);
    assert.equal(decisao.cursor, null, "cursor fora do contrato não se propaga");
  });
});

describe("mensagens do painel", () => {
  test("são PT-PT e dizem o que não se pode concluir", () => {
    assert.match(HISTORICO_SEM_CONFIRMACAO_NOTE, /não devolveu nenhuma página/i);
    assert.match(HISTORICO_SEM_CONFIRMACAO_NOTE, /não quer dizer que não existam análises/);
    assert.match(HISTORICO_FALHA_NOTE, /Nada é afirmado/);
    assert.match(HISTORICO_ULTIMA_LEITURA_NOTE, /última leitura confirmada/);
    for (const texto of [HISTORICO_SEM_CONFIRMACAO_NOTE, HISTORICO_FALHA_NOTE, HISTORICO_ULTIMA_LEITURA_NOTE]) {
      assert.ok(!/[A-Za-z]+ [A-Za-z]+ properties of/.test(texto), "sem texto interno de runtime");
    }
  });
});

describe("verificação estrutural do painel (não simula eventos)", () => {
  test("nenhum ramo volta a ler `entries` de uma resposta que pode não existir", () => {
    assert.doesNotMatch(fontePainel, /\.entries \?\? \[\]/, "a leitura defensiva antiga desapareceu");
    assert.doesNotMatch(fontePainel, /setErro\(e instanceof Error \? e\.message/, "o message cru não vai para o ecrã");
    assert.doesNotMatch(fontePainel, /setErroMais\(e instanceof Error \? e\.message/);
    assert.match(fontePainel, /console\.warn\("\[ScanHistory\] leitura da página falhou", e\)/, "a razão técnica fica no registo");
  });

  test("ambos os caminhos de consulta passam pelo mesmo classificador", () => {
    const usos = fontePainel.match(/decidePaginaHistorico\(/g) ?? [];
    assert.equal(usos.length, 3, "1 definição + 2 usos (consulta e página seguinte)");
  });

  test("a fase nova tem ramo próprio e não apaga a lista anterior", () => {
    assert.match(fontePainel, /type Fase = "a_consultar" \| "pronto" \| "sem_ligacao" \| "sem_confirmacao" \| "erro";/);
    assert.match(fontePainel, /setFase\("sem_confirmacao"\)/);
    assert.doesNotMatch(fontePainel, /setFase\("sem_confirmacao"\)[\s\S]{0,120}setEntradas\(\[\]\)/, "sem página não se limpa a lista");
    assert.match(fontePainel, /\{fase === "sem_confirmacao" && \(/, "o estado é mostrado");
  });

  test("falha de página seguinte não avança o cursor", () => {
    assert.match(fontePainel, /setErroMais\(HISTORICO_SEM_CONFIRMACAO_NOTE\);\s*\n\s*return;/);
  });
});
