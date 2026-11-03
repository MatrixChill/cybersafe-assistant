import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = join(__dirname, "..", "..", "packages", "app", "src");

/**
 * Guarda de UX do ecrã de proteção (C4-fase2): o ecrã ACTUAL não pode ser lido
 * como lista histórica de alertas/ameaças.
 *
 * REAPONTADO a 2026-11-01, e a razão é medida, não estética: `DashboardPage.tsx`
 * deixou de conter apresentação — os seus 70 linhas são hoje um contentor de
 * dados que monta `<LabDashboard>`. Uma busca às strings antigas neste ficheiro
 * falhava para sempre, verde ou vermelho que o produto estivesse bem. Onde a
 * garantia vive hoje:
 *   · `v2/dashboard/LabDashboard.tsx` — a leitura do histórico e o seu limite;
 *   · `components/visual/EngineGrid.tsx` — a legenda de proveniência dos cartões.
 *
 * Asserção aposentada e porquê: `/Ameaças<\/a>/` pertencia a um `<a>` de
 * react-router. A shell v2 navega pelo modelo `Page` (`App.tsx:573`:
 * "dashboard", "pccenter", "threats", …), por isso nenhum `</a>` existe. A
 * intenção que ela protegia — dizer ao utilizador ONDE está o histórico
 * completo — **não foi substituída**: ver o `todo` no fim da suite. Não apago
 * essa diferença; declaro-a.
 */
const dashboard = readFileSync(resolve(appSrc, "v2", "dashboard", "LabDashboard.tsx"), "utf8");
const engineGrid = readFileSync(resolve(appSrc, "components", "visual", "EngineGrid.tsx"), "utf8");

describe("Dashboard — o ecrã actual declara que é leitura, não histórico", () => {
  it("os cartões dizem o que o serviço reportou, e não são apresentados como leitura histórica", () => {
    assert.match(
      engineGrid,
      /Ligação confirmada: os cartões mostram o que o serviço reportou/,
      "a legenda de proveniência tem de existir quando a ligação está confirmada",
    );
    assert.match(
      engineGrid,
      /Serviço desligado: os cartões abaixo não são uma leitura atual dos motores/,
      "sem ligação os cartões têm de se auto-declarar não-leitura",
    );
    assert.match(
      dashboard,
      /A ausência de leitura não significa que o histórico esteja vazio/,
      "a ausência de leitura não pode ser apresentada como histórico vazio",
    );
  });

  it("o dashboard limita a visibilidade, mas não introduz paginação nem filtro arbitrário", () => {
    assert.match(
      dashboard,
      /activityEventsForDisplay\(p\.events \?\? \[\], 3\)/,
      "o dashboard mantém um limite explícito de visibilidade",
    );
    for (const [onde, fonte] of [["LabDashboard", dashboard], ["EngineGrid", engineGrid]]) {
      assert.ok(
        !/pageSize|nextCursor|Carregar mais/.test(fonte),
        `${onde}: nenhum controlo de paginação/filtro pode aparecer no ecrã actual`,
      );
    }
  });

  it("o dashboard aponta para onde está o histórico completo", () => {
    assert.match(
      dashboard,
      /Ver histórico completo/,
      "tem de existir um pointer do ecrã actual para o histórico completo",
    );
    assert.match(
      dashboard,
      /onOpenHistory/,
      "o pointer tem de usar a navegação real da shell, não um link morto",
    );
  });
});
