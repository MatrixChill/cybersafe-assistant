import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuarantineEntry } from "@cybersafe/shared-types";
import QuarantinePage, {
  decideBandeira,
  decideResultadoAcao,
  PAPEL_BANDEIRA,
  QUARENTENA_AVISO_PREFIXO,
  ROTULO_BANDEIRA,
} from "../src/pages/QuarantinePage";

/**
 * P1-RETOQUE + V4 (TP-PAP-UI-FUNCTIONAL-20261028 / FECHAR UI FUNCIONAL, Qoder)
 * — `success: true` pode vir com `error`, e o resultado de uma ação não pode
 * morrer com a linha.
 *
 * Literal do serviço, em `packages/core/src/response.ts` (restauro, caminho em
 * que o destino já foi publicado antes do erro):
 *   { success: true, error: "Ficheiro restaurado; limpeza, permissoes ou
 *     metadados pendentes. Entrada preservada para recuperacao. <motivo>" }
 * A entrega anterior (V1/V2) fazia `if (result?.success) { okId; onChanged }`,
 * deitando o `error` fora; e `okId`/`error` viviam na linha, que desaparece
 * quando a ação é confirmada. A V4 põe os quatro desfechos numa banda
 * persistente, com rótulo, tinta e `role` distintos por estado.
 *
 * O que NÃO é simulado: cliques. `renderToStaticMarkup` só vê o estado inicial,
 * por isso a ligação entre o clique e a banda é verificada no fonte (estrutural,
 * declarado) e o comportamento em Electron real fica no harness `e2e`.
 */

(globalThis as Record<string, unknown>).React = React;

const pagina = readFileSync(new URL("../src/pages/QuarantinePage.tsx", import.meta.url), "utf8");

const AVISO_SERVICO =
  "Ficheiro restaurado; limpeza, permissoes ou metadados pendentes. Entrada preservada para recuperacao. EPERM: chmod";

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

describe("decideResultadoAcao — as quatro leituras possíveis do resultado", () => {
  test("sucesso com aviso é sucesso declarado, não recusa", () => {
    const decisao = decideResultadoAcao({ success: true, error: AVISO_SERVICO });
    assert.equal(decisao.tipo, "confirmado_com_aviso");
    assert.ok(decisao.tipo === "confirmado_com_aviso" && decisao.aviso === AVISO_SERVICO);
  });

  test("sucesso limpo não inventa aviso", () => {
    assert.deepEqual(decideResultadoAcao({ success: true }), { tipo: "confirmado" });
    assert.deepEqual(decideResultadoAcao({ success: true, error: "" }), { tipo: "confirmado" });
    assert.deepEqual(decideResultadoAcao({ success: true, error: "   " }), { tipo: "confirmado" });
    assert.deepEqual(decideResultadoAcao({ success: true, error: undefined }), { tipo: "confirmado" });
  });

  test("recusa mantém o motivo do serviço", () => {
    const decisao = decideResultadoAcao({ success: false, error: "Ja existe um ficheiro nesse destino." });
    assert.ok(decisao.tipo === "recusado" && decisao.motivo === "Ja existe um ficheiro nesse destino.");
    const semMotivo = decideResultadoAcao({ success: false });
    assert.ok(semMotivo.tipo === "recusado" && semMotivo.motivo.length > 0);
  });

  test("ausência de resposta não é sucesso nem recusa", () => {
    assert.deepEqual(decideResultadoAcao(null), { tipo: "sem_confirmacao" });
    assert.deepEqual(decideResultadoAcao(undefined), { tipo: "sem_confirmacao" });
  });

  test("success em falta nunca se lê como confirmação", () => {
    assert.equal(decideResultadoAcao({ error: AVISO_SERVICO }).tipo, "recusado");
    assert.equal(decideResultadoAcao({ success: undefined, error: AVISO_SERVICO }).tipo, "recusado");
  });
});

describe("decideBandeira — o portador persistente por estado", () => {
  const alvo = { id: "e1", fileName: "ameaca.dll" };

  test("transporta o motivo do serviço sem o reescrever", () => {
    const aviso = decideBandeira(alvo, decideResultadoAcao({ success: true, error: AVISO_SERVICO }));
    assert.equal(aviso.tipo, "confirmado_com_aviso");
    assert.equal(aviso.mensagem, AVISO_SERVICO, "a string do serviço é mostrada como foi dita");
    assert.equal(aviso.fileName, "ameaca.dll", "o nome da entrada sobrevive à saída dela da lista");
  });

  test("recusa e sem-confirmação têm texto próprio", () => {
    assert.equal(decideBandeira(alvo, decideResultadoAcao({ success: false, error: "Destino ocupado." })).mensagem, "Destino ocupado.");
    const mudo = decideBandeira(alvo, decideResultadoAcao(null));
    assert.equal(mudo.tipo, "sem_confirmacao");
    assert.match(mudo.mensagem, /não foi confirmada/);
    assert.ok(!/intacto|não foi alterado/i.test(mudo.mensagem), "sem prova, sem asserção sobre o ficheiro");
  });

  test("sucesso limpo não inventa motivo", () => {
    assert.equal(decideBandeira(alvo, decideResultadoAcao({ success: true })).mensagem, "");
  });

  test("os quatro estados são distinguíveis por rótulo e por papel", () => {
    assert.deepEqual(Object.keys(ROTULO_BANDEIRA).sort(), ["confirmado", "confirmado_com_aviso", "recusado", "sem_confirmacao"]);
    assert.equal(new Set(Object.values(ROTULO_BANDEIRA)).size, 4, "quatro estados não partilham rótulo");
    assert.equal(PAPEL_BANDEIRA.confirmado, "status");
    assert.equal(PAPEL_BANDEIRA.confirmado_com_aviso, "alert");
    assert.equal(PAPEL_BANDEIRA.recusado, "alert");
    assert.equal(PAPEL_BANDEIRA.sem_confirmacao, "alert");
    assert.match(ROTULO_BANDEIRA.confirmado, /confirmada pelo serviço/);
    assert.match(ROTULO_BANDEIRA.confirmado_com_aviso, /com aviso do serviço/);
    assert.match(ROTULO_BANDEIRA.recusado, /recusou/);
    assert.match(ROTULO_BANDEIRA.sem_confirmacao, /Sem confirmação/);
  });
});

describe("ligação na página (estrutural: SSR não corre cliques)", () => {
  test("o resultado passa pelo classificador e não por `result?.success`", () => {
    assert.match(pagina, /setBandeira\(decideBandeira\(entry, decideResultadoAcao\(result\)\)\)/);
    assert.doesNotMatch(pagina, /if \(result\?\.success\) \{/, "o teste binário que engolia o aviso");
    assert.doesNotMatch(pagina, /message: result\?\.error \|\| /);
  });

  test("a banda é escrita ANTES de recarregar a lista", () => {
    const pedido = pagina.indexOf("await api.restoreQuarantine(entry.id)");
    const guarda = pagina.indexOf("setBandeira(decideBandeira(entry, decideResultadoAcao(result)))", pedido);
    const recarrega = pagina.indexOf("await onChanged();", pedido);
    assert.ok(pedido > 0 && guarda > pedido && recarrega > guarda, "banda → onChanged, não o contrário");
  });

  test("a banda vive fora da linha da entrada", () => {
    const banda = pagina.indexOf("{bandeira && (");
    const linhas = pagina.indexOf("{sorted.map((entry) => {");
    assert.ok(banda > 0, "a banda existe");
    assert.ok(banda < linhas, "desenhada antes do mapa: sobrevive à saída da entrada da lista");
    assert.match(pagina, /aria-live=\{PAPEL_BANDEIRA\[bandeira\.tipo\] === "alert" \? "assertive" : "polite"\}/);
    assert.match(pagina, /onClick=\{\(\) => setBandeira\(null\)\}/, "o utilizador pode fechar a banda");
  });

  test("o texto interno do runtime não vai para o ecrã", () => {
    assert.doesNotMatch(pagina, /message: err instanceof Error \? err\.message/);
    assert.doesNotMatch(pagina, /String\(err\)/);
    assert.match(pagina, /console\.warn\("\[Quarantine\] ação não chegou ao serviço", err\)/, "a razão fica no registo");
  });

  test("não ficou nada do desenho anterior por linha", () => {
    // O nome pode aparecer em comentário a explicar a mudança; o que não pode é
    // existir estado ou desenho por linha.
    assert.equal(/const \[okId/.test(pagina), false, "voltou o estado `okId`");
    assert.equal(/setOkId\(/.test(pagina), false, "voltaram escritas de `okId`");
    assert.equal(/\{okId === entry\.id/.test(pagina), false, "voltou a banda por linha");
    assert.equal(/const \[error, setError\]/.test(pagina), false, "voltou o erro por linha");
    assert.equal(/\{error\?\.id === entry\.id/.test(pagina), false, "voltava o erro por linha");
    assert.equal(/\{aviso && \(/.test(pagina), false, "voltou a banda antiga só para o aviso");
  });
});

describe("render inicial", () => {
  const renderiza = (props: Partial<React.ComponentProps<typeof QuarantinePage>> = {}) =>
    renderToStaticMarkup(createElement(QuarantinePage, { entries: [], onChanged: () => {}, ...props }));

  test("sem ação, sem banda: nada é afirmado", () => {
    const html = renderiza({ entries: [entrada()] });
    assert.ok(!html.includes("Operação confirmada pelo serviço"), "nenhum sucesso inventado");
    assert.ok(!html.includes(QUARENTENA_AVISO_PREFIXO), "nenhum aviso inventado");
    assert.ok(!html.includes("Fechar"));
    assert.ok(html.includes("ameaca.dll"));
  });

  test("a recarga está disponível mesmo com lista vazia e sem falha registada", () => {
    const html = renderiza();
    assert.match(html, /Atualizar/);
    assert.match(html, /aria-label="Atualizar a lista de quarentena a partir do serviço"/);
  });

  test("a entrega v1 continua de pé: vazio só com leitura confirmada", () => {
    const falhou = renderiza({ estadoLeitura: "falhou" });
    assert.ok(!falhou.includes("A quarentena está vazia"));
    assert.match(falhou, /Não foi possível ler a quarentena/);
    assert.match(renderiza({ estadoLeitura: "confirmado" }), /A quarentena está vazia\./);
  });
});
