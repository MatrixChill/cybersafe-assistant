import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createElement } from "react";
import type { DashboardSummary, EngineHealth } from "@cybersafe/shared-types";
import { AppearanceProvider } from "../src/contexts/AppearanceContext";
import DashboardPage from "../src/pages/DashboardPage";
import { EngineGrid, MOTORES_PAINEL } from "../src/components/visual/EngineGrid";

/* ═══ TP-PAP-DESIGN-V2-PHASE2-20261027 — grelha de motores ══════════════
   Critério: «verde só com evidência», ao contrário do que o YARA-X faz hoje
   no serviço. A grelha é uma superfície de APRESENTAÇÃO: estes testes não
   provam que um motor está operacional, provam que a UI não afirma que está
   quando o relatório não o diz — e que não apresenta um snapshot antigo como
   leitura atual quando a ligação ao serviço não está confirmada.

   Corre-se com o harness do app (o tsconfig é preciso pelos aliases `@/`):
     cd packages/app
     $env:TSX_TSCONFIG_PATH='tsconfig.app.json'; node --import tsx --test test/engine-grid-estados.test.ts

   Render real por `react-dom/server` — nem a grelha nem a página precisam de
   jsdom para este caminho.

   HARNESS da página (medido na cópia do Codex, 27/10): os três renders
   integrados do `DashboardPage` precisam do mesmo andaime que
   `test/dashboard-engine-gate.test.ts` já usa, e por duas razões diferentes:
    - `DashboardPage.tsx:59` chama `useAppearance()`, que LANÇA sem o provider
      («useAppearance deve ser usado dentro de <AppearanceProvider>»,
      `contexts/AppearanceContext.tsx:69`); é o único contexto da página — os
      restantes hooks (`useTelemetryHistory`, `useTemperatureDisplay`,
      `useSpotlight`, `useNow`) são locais e não pedem provider;
    - o provider lê a aparência no arranque (`loadIdentity/loadTheme/…`), e o
      Node não tem `localStorage`; daí o esboço mínimo em `globalThis`.
   Nada disto é produção: são apenas pernas de andaime. As asserções, os
   estados cobertos e os POST de produção não mudam. */

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

/** O React SSR insere `<!---->` entre filhos de natureza diferente. Se não
    forem retirados, asserções de texto como `>Ativo<` falham por artefacto do
    render, não por comportamento. Só se aplica ao TEXTO comparado: os
    atributos `data-*` vivem dentro das etiquetas e não são tocados. */
const semComentarios = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "");

const CARTOES = (html: string) =>
  MOTORES_PAINEL.map(({ chave }) => {
    const m = html.match(new RegExp(`data-engine="${chave}"([^>]*)`));
    return { chave, attrs: m?.[1] ?? null };
  });

const atributo = (html: string, chave: string, nome: string): string | null => {
  const c = CARTOES(html).find((x) => x.chave === chave);
  const g = c?.attrs?.match(new RegExp(`\\b${nome}="([^"]+)"`));
  return g ? g[1] : null;
};

const estadoDe = (html: string, chave: string) => atributo(html, chave, "data-state");
const coberturaDe = (html: string, chave: string) => atributo(html, chave, "data-coverage");

const base = (extra: Partial<EngineHealth> = {}): EngineHealth => ({
  serviceRunning: true,
  osLayerHealthy: true,
  degradedReasons: [],
  monitoredPaths: [],
  ...extra,
});

const render = (engine?: EngineHealth, conexao: boolean | null = true) =>
  semComentarios(renderToStaticMarkup(createElement(EngineGrid, { engine, conexao })));

const QUATRO_ATIVOS = base({
  yara: { status: "active", coverage: "normal" },
  hashDb: { status: "active", coverage: "normal" },
  clamav: { status: "active", coverage: "normal" },
  nativeEngine: { status: "active", coverage: "normal" },
});

test("os quatro cartões existem sempre, com engine em falta", () => {
  const html = render(undefined);
  for (const { chave } of MOTORES_PAINEL) {
    assert.match(html, new RegExp(`data-engine="${chave}"`), `falta o cartão ${chave}`);
    assert.equal(estadoDe(html, chave), "sem-leitura", `${chave} sem relatório não é sem-leitura`);
  }
  assert.doesNotMatch(html, /Ativo/, "sem relatório não pode haver um «Ativo»");
  assert.match(html, /Sem leitura/, "a ausência de leitura tem de ser dita");
});

test("active é o único estado que mostra «Ativo»", () => {
  const html = render(
    base({
      yara: { status: "active", coverage: "normal" },
      hashDb: { status: "degraded" },
      clamav: { status: "unavailable" },
      nativeEngine: { status: "error" },
    }),
  );
  assert.equal(estadoDe(html, "yara"), "active");
  assert.equal(estadoDe(html, "hashDb"), "degraded");
  assert.equal(estadoDe(html, "clamav"), "unavailable");
  assert.equal(estadoDe(html, "nativeEngine"), "error");
  assert.equal(
    (html.match(/>Ativo</g) ?? []).length,
    1,
    "mais de um cartão verde com um só motor ativo no relatório",
  );
  assert.match(html, />Degradado</);
  assert.match(html, />Indisponível</);
  assert.match(html, />Erro</);
});

test("um motor em falta no relatório não herda o estado dos vizinhos", () => {
  // Não-vacuidade: se a grelha agregasse em vez de ler por motor, este caso
  // pintaria o HashDB verde porque os outros três estão ativos.
  const html = render(
    base({
      yara: { status: "active" },
      clamav: { status: "active" },
      nativeEngine: { status: "active" },
    }),
  );
  assert.equal(estadoDe(html, "hashDb"), "sem-leitura");
  assert.equal(estadoDe(html, "yara"), "active");
});

test("status fora do contrato não é interpretado — e não fica verde", () => {
  const html = render(base({ yara: { status: "loading" as never } }));
  assert.equal(estadoDe(html, "yara"), "loading");
  assert.match(html, /Estado desconhecido/, "tem de dizer que não sabe");
  assert.doesNotMatch(html, />Ativo</, "valor desconhecido nunca pinta como ativo");
});

test("cobertura: ausente é «não comunicada», nunca «normal»", () => {
  const html = render(base({ clamav: { status: "active" } }));
  assert.equal(coberturaDe(html, "clamav"), "ausente");
  assert.match(html, /Cobertura não comunicada por este serviço/);
  assert.doesNotMatch(html, /Cobertura comunicada como normal/);
});

test("cobertura: normal só se apresenta como comunicada com motor ativo", () => {
  const ativo = render(base({ clamav: { status: "active", coverage: "normal" } }));
  assert.equal(coberturaDe(ativo, "clamav"), "normal");
  assert.match(ativo, /Cobertura comunicada como normal/);

  const degradado = render(base({ clamav: { status: "degraded", coverage: "normal" } }));
  assert.equal(coberturaDe(degradado, "clamav"), "unknown");
  assert.match(degradado, /Cobertura não verificada/);
  assert.doesNotMatch(degradado, /Cobertura comunicada como normal/, "motor não-ativo não declara cobertura comunicada como normal");

  const limitada = render(base({ yara: { status: "active", coverage: "limited" } }));
  assert.equal(coberturaDe(limitada, "yara"), "limited");
  assert.match(limitada, /Cobertura limitada/);
});

test("o detalhe técnico do serviço não é impresso no painel", () => {
  // Medido em clamav.ts / signatures.ts: o `detail` traz caminhos locais.
  // Um painel de resumo não é sítio para publicar o sistema de ficheiros do
  // utilizador; o texto técnico fica em `ProtectionDetails`.
  const caminho = "C:\\Users\\utilizador\\AppData\\Local\\CyberSafe\\signatures";
  const html = render(
    base({
      clamav: { status: "degraded", detail: `base em ${caminho} em falta` },
      hashDb: { status: "active", detail: `Loaded 8192 signature(s) from ${caminho}` },
    }),
  );
  assert.ok(!html.includes(caminho), "o cartão imprimiu um caminho local do serviço");
  assert.ok(!html.includes("Loaded 8192"), "o cartão imprimiu texto técnico cru do motor");
});

test("sem contadores inventados", () => {
  const html = render(base({ clamav: { status: "active", detail: "analisou 4200 ficheiros" } }));
  assert.doesNotMatch(
    html,
    /\b\d+[\s\u00a0]*(ficheiros|files|an[áa]lises?|analisados)\b/i,
    "a grelha apresentou uma contagem que o contrato não transporta",
  );
});

/* ─── ligação ao serviço: TRUE / FALSE / NULL, fail-closed ───────────────
   REVISÃO HOLD (27/10, Codex Lead): a versão inicial passava
   `offline={serviceConnected === false}`, e `serviceConnected` é
   `boolean | null` com default `null` (`DashboardPage.tsx:51-52`,
   `App.tsx:168`). Com `null` — ligação ainda não confirmada — um snapshot
   anterior com os quatro ativos ficava pintado como estado atual. A prop é
   agora `conexao` e só `true` autoriza mostrar estado; `false` e `null`
   distinguem-se por palavras, porque «desligado» e «não confirmado» são
   factos diferentes. */

test("conexao=true com quatro ativos: quatro verdes", () => {
  const html = render(QUATRO_ATIVOS, true);
  assert.match(html, /data-conexao="confirmada"/);
  assert.doesNotMatch(html, /Serviço desligado|não confirmada/, "legenda de aviso sem motivo");
  for (const { chave } of MOTORES_PAINEL) {
    assert.equal(estadoDe(html, chave), "active");
  }
  assert.equal((html.match(/>Ativo</g) ?? []).length, 4);
});
test("conexao=false: nada se mostra como leitura atual", () => {
  const html = render(QUATRO_ATIVOS, false);
  assert.match(html, /data-conexao="desligada"/);
  assert.doesNotMatch(html, />Ativo</, "com o serviço desligado não há verdes atuais");
  assert.match(html, /Serviço desligado/);
  for (const { chave } of MOTORES_PAINEL) {
    assert.equal(estadoDe(html, chave), "sem-leitura");
  }
});

test("conexao=null: falha fechada, e diz «não confirmada» — não «desligado»", () => {
  const html = render(QUATRO_ATIVOS, null);
  assert.match(html, /data-conexao="nao-confirmada"/);
  assert.doesNotMatch(html, />Ativo</, "ligação não confirmada não é prova de estado atual");
  assert.match(html, /Ligação ao serviço não confirmada/);
  assert.doesNotMatch(html, /Serviço desligado/, "null não afirma que o serviço está desligado");
});

test("conexao por omissão é null: sem prop não há verdes", () => {
  // O omissão tem de ser o lado seguro. Se alguém esquecer a prop no call
  // site, a grelha fica em «sem leitura» — não verde com o último snapshot.
  const html = semComentarios(
    renderToStaticMarkup(createElement(EngineGrid, { engine: QUATRO_ATIVOS })),
  );
  assert.doesNotMatch(html, />Ativo</);
  assert.match(html, /data-conexao="nao-confirmada"/);
});

/* ─── MOEDA: ligado prova a conduta, não a hora ───────────────────────────
   Critério P1 «ausência de resposta do serviço». Medido no código: a
   propagação de falha em `App.tsx:462-465` RETÉM o último estado confirmado
   («a UI nunca inventa um estado em cima do silêncio»), e `EngineHealth` não
   transporta a hora do relatório — só `definitionsUpdatedAt` (hora de
   DEFINIÇÕES) e `lastEventAt` (hora do último evento do tempo real), que são
   outras coisas. Logo, `conexao === true` não autoriza uma frase de agora.
   A versão inicial dizia «O serviço reporta este motor como operacional nesta
   leitura»; os testes abaixo fixam o pretérito e a proveniência declarada. */

test("ligado: nenhum verbo no presente afirma um estado de agora", () => {
  const html = render(QUATRO_ATIVOS, true);
  assert.doesNotMatch(html, /reporta\b/, "presente («reporta») afirmava atualidade sem fonte");
  assert.doesNotMatch(
    html,
    /nesta leitura|neste momento|neste instante|de agora|no momento/,
    "a grelha afirmou frescura sem fonte",
  );
  assert.match(html, /reportou este motor como operacional no relatório recebido/);
});

test("ligado: a legenda declara a proveniência e que a idade não é afirmada", () => {
  const html = render(QUATRO_ATIVOS, true);
  assert.match(html, /data-nivel="proveniencia"/, "sem legenda de proveniência com ligação confirmada");
  assert.match(html, /último relatório recebido/);
  assert.match(html, /idade não é afirmada/, "a grelha tem de dizer que não sabe a idade");
});

test("silêncio do serviço com conduta intacta: snapshot ativo não vira presente", () => {
  // Reprodução do caso: os quatro ficaram ativos no último relatório, o serviço
  // deixou de responder às atualizações, a conduta continua confirmada.
  const html = render(QUATRO_ATIVOS, true);
  const ativos = (html.match(/reportou este motor como operacional/g) ?? []).length;
  assert.equal(ativos, 4, "cada cartão tem de dar a sua própria frase, no pretérito");
  assert.equal((html.match(/>Ativo</g) ?? []).length, 4);
  // Nada na grelha pode ser lido como «agora estão operacionais»: nem presente,
  // nem idade inventada (um «há N s» sem timestamp seria fabricar frescura).
  assert.doesNotMatch(html, /há \d+ (s|min|h)\b/, "idade mostrada sem hora no contrato");
  assert.doesNotMatch(html, /reporta\b|nesta leitura/);
});

test("desligado e não-confirmado continuam sem legenda de proveniência", () => {
  // A legenda de proveniência só faz sentido quando há estados mostrados; com
  // «sem leitura» generalizado, seria texto sobre texto.
  for (const conexao of [false, null] as const) {
    const html = render(QUATRO_ATIVOS, conexao);
    assert.doesNotMatch(html, /data-nivel="proveniencia"/);
    assert.match(html, /data-nivel="aviso"/);
  }
});

/* ─── render integrado da página ────────────────────────────────────────
   Testa o call site, não só o componente: foi exatamente no call site
   (`offline={serviceConnected === false}`) que o defeito do HOLD viveu.

  ANDAIME: `AppearanceProvider` à volta, porque `DashboardPage.tsx:59` chama
   `useAppearance()` e esse hook lança sem provider. As asserções de texto da
   grelha são medidas DENTRO da secção da grelha (`grelhaDaPagina`), não na
   página inteira — a página tem outros painéis, e contar `>Ativo<` na página
   toda daria um teste sensível a markup que não é desta entrega. A secção da
   grelha não tem `<section>` filhos (medido), por isso o corte é exato. */

const resumo = (engine: EngineHealth): DashboardSummary => ({
  riskScore: 12,
  totalEvents: 0,
  highSeverityEvents: 0,
  downloadRisk: "low",
  recentThreats: [],
  alerts: [],
  // `"healthy"` não existe em `ProtectionStatus` ("safe" | "attention" |
  // "critical" | "degraded", `shared-types:9`). A_fixture anterior passava por
  // cima disso com uma asserção de tipo; agora que o fixture é tipado, o valor
  // é o da tabela real.
  systemStatus: "safe",
  engineHealth: engine,
});

const pagina = (conexao: boolean | null) =>
  semComentarios(
    renderToStaticMarkup(
      createElement(
        AppearanceProvider,
        null,
        createElement(DashboardPage, {
          dashboard: resumo(QUATRO_ATIVOS),
          isLoading: false,
          onScan: () => {},
          serviceConnected: conexao,
        }),
      ),
    ),
  );

/** Só a secção da grelha, tal como foi renderizada dentro da página. */
const grelhaDaPagina = (html: string): string => {
  const m = html.match(/data-testid="engine-grid"[\s\S]*?<\/section>/);
  assert.ok(m, "a grelha não foi renderizada dentro da página");
  return m[0];
};

test("DashboardPage com serviceConnected=true mostra os quatro ativos", () => {
  const grelha = grelhaDaPagina(pagina(true));
  assert.match(grelha, /data-conexao="confirmada"/);
  assert.equal((grelha.match(/>Ativo</g) ?? []).length, 4, "os quatro cartões não estão verdes com ligação confirmada");
});

test("DashboardPage com serviceConnected=false não mostra verdes", () => {
  // Migração V2-FIRST: a grelha do lab não tem estado `desligada`; tem DOIS
  // estados de ligação — `confirmada` só quando o serviço o confirma, e
  // `nao-confirmada` para `false` e `null`. O que se protege é o mesmo: sem
  // confirmação não há verdes.
  const grelha = grelhaDaPagina(pagina(false));
  assert.match(grelha, /data-conexao="nao-confirmada"/);
  assert.doesNotMatch(grelha, />Ativo</);
});

test("DashboardPage com serviceConnected=null (default) não mostra verdes", () => {
  const grelha = grelhaDaPagina(pagina(null));
  assert.match(grelha, /data-conexao="nao-confirmada"/);
  assert.doesNotMatch(grelha, />Ativo</, "o regresso do HOLD: null não pode pintar snapshot como atual");
});

test("DashboardPage integrado: a moeda da grelha é a mesma da página", () => {
  // Laço do call site: a página passa `serviceConnected`, e é esse valor — não
  // a presença de dados no `dashboard` — que decide se algo se mostra como
  // reportado. Migração V2-FIRST: a grelha do lab fala por atributos medidos
  // (`data-state` = o estado cru do relatório; `data-coverage` = a cobertura
  // comunicada) e pela palavra do cartão; a frase de proveniência é ÚNICA e
  // vive no detalhe do motor, não repetida em cada cartão.
  const grelha = grelhaDaPagina(pagina(true));
  assert.match(grelha, /data-engine="yara"[^>]*data-state="active"[^>]*data-coverage="normal"/, "o estado mostrado é o do relatório, sem subir a 'operacional'");
  assert.equal((grelha.match(/data-state="active"/g) ?? []).length, 4, "a grelha mostra os quatro estados medidos");
  assert.match(grelha, /Cobertura reportada: normal/, "cobertura comunicada é dita como comunicada");
  assert.match(grelha, /Último relatório recebido/, "pretérito, não leitura atual");
  assert.doesNotMatch(grelha, /reporta\b|nesta leitura|operacional no relatório recebido/, "a grelha não afirma mais do que o cartão isolado");
  // O texto do JSX pode partir-se em várias linhas; o que se trava é a frase.
  const paginaFonte = readFileSync(new URL("../src/v2/dashboard/LabDashboard.tsx", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.match(paginaFonte, /a sua idade não é afirmada/, "a proveniência única existe e diz que a idade não é afirmada");
  assert.equal((grelha.match(/idade não é afirmada/g) ?? []).length, 0, "e não é repetida dentro da grelha");
});


test("todos os quatro motores do critério estão na grelha", () => {
  const chaves = MOTORES_PAINEL.map((m) => m.chave).sort();
  assert.deepEqual(chaves, ["clamav", "hashDb", "nativeEngine", "yara"]);
});
