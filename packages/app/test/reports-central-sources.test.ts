import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveProtectionLevel, PROTECTION_LEVEL_META } from "../src/lib/protectionHealth";
import {
  reportHealthFromCentralSources,
  reportCategoriesFromPcState,
} from "../../core/src/scoring.ts";
import type { EngineHealth, ProtectionStatus } from "@cybersafe/shared-types";

/**
 * O relatório interno (A4) tem de ser um CONSUMIDOR das fontes centrais:
 * ProtectionState (status + engine + stats.riskScore), PcState (overall +
 * categorias + findings), ameaças, quarentena e eventos já carregados.
 * Nunca pode ter score próprio nem opinião própria.
 */

const healthyEngine = (overrides: Partial<EngineHealth> = {}): EngineHealth => ({
  serviceRunning: true,
  osLayerHealthy: true,
  degradedReasons: [],
  monitoredPaths: [],
  anyEngineDegraded: false,
  yara: { status: "active" },
  hashDb: { status: "active" },
  clamav: { status: "active" },
  nativeEngine: { status: "active" },
  firewall: { status: "active" },
  ...overrides,
});

describe("(a) o relatório não cria score próprio e usa as fontes centrais", () => {  test("o score apresentado é exatamente o riskScore do serviço", () => {    for (const score of [0, 37, 100]) {
      const health = reportHealthFromCentralSources({
        protectionStatus: "safe",
        engine: healthyEngine(),
        pcStateOverall: "good",
        riskScore: score,
      });
      assert.equal(health.score, score, "o relatório tem de espelhar o score central");
    }
  });

  test("o veredicto muda com a fonte central (PcState e ProtectionState), não com o relatório", () => {
    const base = { engine: healthyEngine(), riskScore: 90 };
    const safe = reportHealthFromCentralSources({ ...base, protectionStatus: "safe", pcStateOverall: "good" });
    const pcCritical = reportHealthFromCentralSources({ ...base, protectionStatus: "safe", pcStateOverall: "critical" });
    const protCritical = reportHealthFromCentralSources({ ...base, protectionStatus: "critical", pcStateOverall: "good" });

    assert.equal(safe.verdict, "protected");
    assert.equal(pcCritical.verdict, "critical", "PcState crítico tem de win sobre protection safe");
    assert.equal(protCritical.verdict, "critical");
    // o score não "puxa" o veredicto: é o mesmo 90 nos três casos
    assert.equal(safe.score, pcCritical.score);
    assert.equal(safe.score, protCritical.score);
  });

  test("o relatório bate com a regra central deriveProtectionLevel (sem deriva de regras)", () => {
    const cases: Array<[ProtectionStatus, EngineHealth | undefined]> = [
      ["safe", healthyEngine()],
      ["safe", healthyEngine({ anyEngineDegraded: true, clamav: { status: "unavailable" } })],
      ["attention", healthyEngine()],
      ["attention", healthyEngine({ anyEngineDegraded: true, yara: { status: "unavailable" } })],
      ["critical", healthyEngine()],
      ["degraded", healthyEngine()],
      ["safe", healthyEngine({ serviceRunning: false, anyEngineDegraded: true })],
      ["safe", healthyEngine({ anyEngineDegraded: true, hashDb: { status: "error" } })],
    ];
    for (const [status, engine] of cases) {
      const central = deriveProtectionLevel(status, engine);
      const report = reportHealthFromCentralSources({ protectionStatus: status, engine });
      assert.equal(report.verdict, central, `divergência em status=${status} engine=${JSON.stringify(engine)}`);
    }
  });
});

describe("(b) degradado/atenção vem da fonte central, nunca de opinião própria", () => {
  test("protection.status = 'degraded' NUNCA é apresentado como protegido", () => {
    const health = reportHealthFromCentralSources({
      protectionStatus: "degraded",
      engine: healthyEngine({ anyEngineDegraded: true, yara: { status: "unavailable" } }),
    });
    assert.equal(health.verdict, "degraded");
    assert.equal(health.canClaimProtected, false);
    assert.notEqual(health.tone, "green", "degradado não pode ser verde");
  });

  test("'degraded' com todos os motores ativos continua degradado (não há 'queda' de opinião)", () => {
    const health = reportHealthFromCentralSources({
      protectionStatus: "degraded",
      engine: healthyEngine(),
    });
    assert.equal(health.verdict, "degraded");
  });

  test("subsistema degradado/atention vem do engine, não do histórico de ameaças", () => {
    const semAmeacas = reportHealthFromCentralSources({
      protectionStatus: "safe",
      engine: healthyEngine({ anyEngineDegraded: true, hashDb: { status: "degraded" } }),
    });
    assert.equal(semAmeacas.verdict, "degraded", "zero ameaças não torna o sistema saudável");
    assert.equal(semAmeacas.canClaimProtected, false);
  });

  test("motor em error / serviço parado ⇒ critical", () => {
    assert.equal(
      reportHealthFromCentralSources({
        protectionStatus: "safe",
        engine: healthyEngine({ anyEngineDegraded: true, clamav: { status: "error" } }),
      }).verdict,
      "critical",
    );
    assert.equal(
      reportHealthFromCentralSources({
        protectionStatus: "safe",
        engine: healthyEngine({ serviceRunning: false, anyEngineDegraded: true }),
      }).verdict,
      "critical",
    );
  });
});

describe("(c) dados ausentes são indisponível/desconhecido, nunca 0 nem saudável", () => {
  test("sem nenhuma fonte central ⇒ unknown, não protected", () => {
    const health = reportHealthFromCentralSources({});
    assert.equal(health.verdict, "unknown");
    assert.equal(health.dataAvailable, false);
    assert.equal(health.canClaimProtected, false);
    assert.equal(health.score, null, "sem riskScore não há score — nunca 0");
    assert.notEqual(health.tone, "green");
  });

  test("riskScore ausente/inválido ⇒ null (nunca 0, que pareceria saudável)", () => {
    for (const riskScore of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const health = reportHealthFromCentralSources({
        protectionStatus: "safe",
        engine: healthyEngine(),
        pcStateOverall: "good",
        riskScore,
      });
      assert.equal(health.score, null, `riskScore=${riskScore} tem de ser null`);
    }
  });

  test("categorias sem PcState ficam indisponíveis (nunca 'Ok')", () => {
    for (const pcState of [null, undefined, {}]) {
      const categories = reportCategoriesFromPcState(pcState as never);
      assert.equal(categories.length, 4);
      for (const category of categories) {
        assert.equal(category.available, false, `${category.label} sem PcState = indisponível`);
        assert.equal(category.verdict, "unknown");
        assert.equal(category.tone, "unknown");
      }
    }
  });

  test("categorias com PcState espelham o nível real (good/attention/critical/unknown)", () => {
    const categories = reportCategoriesFromPcState({
      security: "attention",
      performance: "good",
      system: "unknown",
      privacy: "critical",
    });
    const byKey = Object.fromEntries(categories.map((c) => [c.key, c]));
    assert.equal(byKey.security.verdict, "attention");
    assert.equal(byKey.performance.verdict, "protected");
    assert.equal(byKey.privacy.verdict, "critical");
    assert.equal(byKey.system.available, false, "'unknown' do PcState não é bom nem mau: indisponível");
  });
});

describe("(d) não existe caminho que mostre 'Seguro' sem deteção e sem estado de saúde", () => {
  test("todas as combinações sem fontes / degradadas nunca dão canClaimProtected", () => {
    const nullish: Array<null | undefined> = [null, undefined];
    const statuses: Array<ProtectionStatus | null> = ["safe", "attention", "critical", "degraded", null];
    const engines: Array<EngineHealth | undefined> = [
      undefined,
      healthyEngine(),
      healthyEngine({ anyEngineDegraded: true, yara: { status: "unavailable" } }),
      healthyEngine({ serviceRunning: false, anyEngineDegraded: true }),
    ];
    const pcStates = [null, "good", "attention", "critical", "unknown"] as const;

    for (const status of statuses) {
      for (const engine of engines) {
        for (const overall of pcStates) {
          const health = reportHealthFromCentralSources({
            protectionStatus: status,
            engine,
            pcStateOverall: overall,
            riskScore: nullish[0],
          });
          const temFonte = status != null || overall != null || engine != null;
          if (!temFonte) {
            assert.equal(health.canClaimProtected, false, "sem fontes nunca 'Protegido'");
            assert.equal(health.verdict, "unknown");
            assert.equal(health.score, null);
            assert.equal(health.dataAvailable, false);
            continue;
          }
          // Só a telemetria de motores (sem status de proteção) nunca autoriza
          // "Protegido", mesmo que esteja tudo ativo.
          if (status == null) {
            assert.equal(health.canClaimProtected, false, "sem ProtectionState nunca 'Protegido'");
          }
          if (health.canClaimProtected) {
            // "Protegido" só é admissível com protectionStatus === 'safe',
            // todos os motores ativos e PcState sem queixa.
            assert.equal(status, "safe");
            assert.notEqual(engine?.anyEngineDegraded, true, "só com telemetria não degradada");
            assert.ok(
              overall == null || overall === "good" || overall === "unknown",
              `PcState não pode contradizer 'Protegido' (overall=${overall})`,
            );
            assert.equal(health.tone, "green");
          }
        }
      }
    }
  });

  test("o texto 'Protegido' do nível central nunca é usado sem fontes reais", () => {
    const semFontes = reportHealthFromCentralSources({});
    const label = semFontes.verdict === "unknown"
      ? "Estado desconhecido"
      : PROTECTION_LEVEL_META[semFontes.verdict].shortLabel;
    assert.equal(label, "Estado desconhecido");
    assert.notEqual(label, PROTECTION_LEVEL_META.protected.shortLabel);
  });
});

/**
 * O HTML do relatório é construído dentro do componente (React não é corrável
 * num teste node sem DOM), por isso o guard de honestidade sobre o ficheiro da
 * página é ESTÁTICO: garante que o HTML não reintroduz opinião própria.
 */
describe("ReportsPage — o HTML do relatório não reintroduz opinião própria", () => {
  const pagePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "pages",
    "ReportsPage.tsx",
  );
  const source = fs.readFileSync(pagePath, "utf-8");
  // Só o corpo do exportPdf (gerador do HTML A4) conta; o resto é o layout React.
  const template = source.slice(source.indexOf("const exportPdf = "));
  // Os guards olham para CÓDIGO, não para comentários (que citam os termos).
  const code = template
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\/.*$/gm, "");

  test("o estado geral e o score vêm das fontes centrais, sem literais hardcoded", () => {
    assert.match(template, /\$\{statusLabel\}/, "o badge tem de usar o veredicto das fontes");
    assert.match(template, /\$\{scoreText\}/, "o score tem de vir de health.score");
    assert.doesNotMatch(code, /riskScore \?\? 0/, "riskScore ausente nunca pode virar 0");
    assert.doesNotMatch(code, /"Protegido"/, "'Protegido' não pode ser literal do relatório");
    assert.doesNotMatch(code, /\? "Precisa de atenção" : "Protegido"/, "bifurcação de opinião própria");
  });

  test("categorias e findings vêm do PcState, sem valores inventados", () => {
    assert.match(template, /\$\{categoryRows\}/);
    assert.match(template, /\$\{findingsBlock\}/);
    for (const inventado of ['>Ok<', '>Estável<', '>Protegido<', 'class="v sev sev-green">Ok']) {
      assert.doesNotMatch(code, new RegExp(inventado.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `categoria inventada: ${inventado}`);
    }
  });

  test("a ausência de ameaças é qualificada e a telemetria ausente diz isso", () => {
    assert.match(template, /não indica que o sistema esteja saudável/, "sem deteção não é sinônimo de saudável");
    assert.match(template, /indispon[ií]vel/i, "dados ausentes são Indisponível");
    assert.match(template, /Telemetria de motores indisponível/);
  });

  test("o espelho local do relatório é guard contra a versão canónica em @cybersafe/core", () => {
    // O renderer não importa @cybersafe/core (index puxa código node-only), por
    // isso espelha a regra; este guard fixa a paridade das invariantes.
    for (const assinatura of ["reportHealthFromCentralSources", "reportCategoriesFromPcState", "canClaimProtected"]) {
      assert.ok(source.includes(assinatura), `ReportsPage tem de expor/usar ${assinatura}`);
    }
  });
});
