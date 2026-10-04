import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PcStateEngine } from "../dist/index.js";
import { wfpHealth, ENGINE_DISPLAY_NAME } from "@cybersafe/shared-types";

/**
 * WS-A: O FILTRO WFP DO CYBERSAFE != O FIREWALL DO WINDOWS.
 *
 * Medido ao servico vivo (named pipe `protection.getState`, DEV):
 *   engine.wfp.status = unavailable
 *   engine.wfp.detail  = "WFP filter not started"
 *   Windows Firewall real: Domain/Private/Public = Enabled True (os tres).
 *
 * O que esta `unavailable` e o filtro WFP do CyberSafe, NAO o Firewall do
 * Windows. Qualquer consumidor que rotule o campo como "Firewall" diz ao
 * utilizador que a proteccao de rede esta desligada quando ela esta ligada.
 *
 * ESTES SAO TESTES DE CONTRASTE: cada um falha com a semantica antiga e passa
 * com a nova. E cada um falha DE NOVO se a copy voltar a dizer so "Firewall".
 */

const now = () => 1_700_000_000_000;

function hw() {
  return {
    cpu: { usage: 10, model: "Test CPU", cores: 8, speed: 3.2, temperature: null },
    ram: { usagePercent: 40, usedGb: 8, totalGb: 16 },
    disk: { usagePercent: 40, usedGb: 200, totalGb: 500, fsType: "NTFS" },
    network: { rxSec: 0, txSec: 0, interfaceName: "eth0" },
    battery: { hasBattery: false, percent: 100, isCharging: true, timeRemaining: null },
    gpu: null,
    system: { uptime: 1000, platform: "win32", osVersion: "10", hostname: "TEST" },
    topProcessesByCpu: [],
    topProcessesByRam: [],
    stressScore: 0,
    alerts: [],
    timestamp: "2023-11-14T22:13:20.000Z",
  };
}

/** Payload real medido: o filtro WFP do CyberSafe esta inativo. */
function wfpUnavailable() {
  return {
    status: "degraded",
    stats: {
      riskScore: 0, totalEvents: 0, highSeverityEvents: 0,
      blockedExecutions: 0, quarantinedCount: 0, monitoredProcesses: 0,
    },
    engine: {
      serviceRunning: true,
      osLayerHealthy: true,
      degradedReasons: ["Filtro WFP do CyberSafe: unavailable — WFP filter not started"],
      monitoredPaths: [],
      yara: { status: "active" },
      hashDb: { status: "active" },
      clamav: { status: "active" },
      nativeEngine: { status: "active" },
      wfp: { status: "unavailable", detail: "WFP filter not started" },
    },
  };
}

function health(overrides = {}) {
  return {
    system: { uptime: 1000, platform: "win32", osVersion: "10", hostname: "TEST" },
    cpu: { usage: 10, model: "Test CPU", cores: 8, speed: 3.2 },
    memory: { totalGb: 16, usedGb: 8 },
    disks: [],
    services: [],
    users: [],
    network: { interfaceName: "eth0" },
    // MEDIDA REAL: o Windows Firewall esta ATIVO nos tres perfis.
    firewall: { available: true, enabled: true, profiles: [
      { name: "Domain", enabled: true },
      { name: "Private", enabled: true },
      { name: "Public", enabled: true },
    ] },
    recommendations: [],
    alerts: [],
    ...overrides,
  };
}

function baseInput(extra = {}) {
  return { hardware: hw(), protection: wfpUnavailable(), windowsHealth: health(), threats: [], now: now(), ...extra };
}

/** O que o utilizador LÊ: todo o texto de uma finding, colado. */
function textoDaFinding(f) {
  return [f.title, f.summary, f.evidence?.engine, ...(f.evidence?.evidenceLines ?? [])]
    .filter(Boolean).join(" | ");
}

describe("WS-A 1 — o campo do contrato significa uma coisa so", () => {
  test("wfpHealth le `wfp`, e cai no alias `firewall` quando so o antigo existe", () => {
    assert.deepEqual(wfpHealth({ wfp: { status: "active" } }), { status: "active" });
    // Alias: um servico de uma versao anterior so publica `firewall`.
    assert.deepEqual(wfpHealth({ firewall: { status: "unavailable" } }), { status: "unavailable" });
    // `wfp` ganha quando os dois existem — o nome certo nao cede ao antigo.
    assert.deepEqual(wfpHealth({ wfp: { status: "active" }, firewall: { status: "unavailable" } }), { status: "active" });
    assert.equal(wfpHealth(undefined), undefined);
  });

  test("a chave antiga e a chave nova dizem a MESMA coisa ao utilizador", () => {
    assert.equal(ENGINE_DISPLAY_NAME.firewall, ENGINE_DISPLAY_NAME.wfp);
  });

  test("NENHUMA chave de motor se escreve so como 'firewall'", () => {
    // CONTRASTE: falha se alguem voltar a meter o WFP em `firewall`.
    for (const [chave, nome] of Object.entries(ENGINE_DISPLAY_NAME)) {
      assert.doesNotMatch(nome, /^\s*firewall\s*$/i, `a chave ${chave} aparece ao utilizador como "Firewall" a secas`);
    }
  });
});

describe("WS-A 2 — WFP unavailable nao diz que o Firewall do Windows esta desligado", () => {
  test("a finding do WFP indisponivel NAO afirma nada sobre o Firewall do Windows", () => {
    const engine = new PcStateEngine();
    const state = engine.update(baseInput());
    const f = state.findings.find((x) => x.id === "security:engine-unavailable");
    assert.ok(f, "deve reportar o filtro WFP indisponivel");

    const texto = textoDaFinding(f);
    // CONTRASTE (ACCEPTANCE 5): se voltar a dizer so "firewall", isto falha.
    assert.doesNotMatch(texto, /^\s*firewall\b/im, `a finding chama o WFP so de Firewall: ${texto}`);
    assert.match(texto, /Filtro WFP do CyberSafe/);

    // A frase tem de desambiguar: o WFP nao e o Windows Firewall.
    assert.match(texto, /WFP/);
    assert.doesNotMatch(texto, /firewall do sistema/i, "afirma o Firewall do SISTEMA com base no filtro do CyberSafe");
  });

  test("as evidenceLines dizem 'Filtro WFP do CyberSafe', nunca 'firewall:'", () => {
    const engine = new PcStateEngine();
    const state = engine.update(baseInput());
    const f = state.findings.find((x) => x.id === "security:engine-unavailable");
    const linhas = f.evidence.evidenceLines ?? [];
    assert.ok(linhas.length > 0);
    for (const linha of linhas) {
      assert.doesNotMatch(linha, /^firewall\s*:/i, `evidenceLines crua: "${linha}"`);
      assert.doesNotMatch(linha, /\bfirewall\b(?![^.]{0,40}Windows)/i, `evidenceLines chama o WFP de firewall: "${linha}"`);
    }
  });

  test("as degradedReasons vindas do servico nao dizem 'firewall:'", () => {
    const linhas = wfpUnavailable().engine.degradedReasons;
    for (const l of linhas) assert.doesNotMatch(l, /^firewall\s*:/i, `degradedReason crua: "${l}"`);
  });

  test("um erro no WFP fala do CyberSafe e nega o Windows Firewall", () => {
    const engine = new PcStateEngine();
    const protection = wfpUnavailable();
    protection.engine.wfp = { status: "error", detail: "wfp api failed" };
    const state = engine.update(baseInput({ protection }));
    const f = state.findings.find((x) => x.id === "security:firewall-error");
    assert.ok(f, "o erro do WFP tem de aparecer");
    const texto = textoDaFinding(f);
    // CONTRASTE: a copy antiga era "Erro no firewall" / "A protecao de firewall
    // do sistema reporta um erro", que e uma afirmacao sobre o Windows.
    assert.doesNotMatch(texto, /^Erro no firewall$/i, `titulo volta a dizer so Firewall: ${texto}`);
    assert.doesNotMatch(texto, /firewall do sistema/i);
    assert.match(texto, /filtro WFP do CyberSafe/i);
    assert.match(texto, /Nada disto diz respeito ao Firewall do Windows/);
  });
});

describe("WS-A 3 — o servico Windows Firewall parado NAO e silenciado", () => {
  test("mpssvc em baixo gera achado MESMO com o filtro WFP indisponivel", () => {
    // A semantica antiga: `firewallCoveredByProtection()` devolvia true quando o
    // WFP estava INACTIVO, e usava isso para REMOVER o mpssvc da lista de
    // servicos importantes. O achado de rede desprotegida desaparecia.
    const engine = new PcStateEngine();
    const comServico = health({
      services: [{ name: "mpssvc", displayName: "Windows Defender Firewall", running: false }],
      recommendations: [{
        id: "service-down", status: "critical", severity: "high",
        title: "Servico importante parado",
        description: "Um servico importante do Windows esta parado.",
        suggestion: "Reinicie o servico.",
      }],
    });
    const state = engine.update(baseInput({ windowsHealth: comServico }));
    const f = state.findings.find((x) => String(x.summary ?? "").includes("Windows Defender Firewall"));
    assert.ok(f, "o servico mpssvc parado tem de aparecer mesmo com o WFP indisponivel");
  });

  test("a finding do Firewall do Windows so aparece com DADO REAL do Windows", () => {
    // Com dado real e honesto: Windows Firewall ativo => nao ha finding de firewall
    // do Windows. E o que a medicao real mostra.
    const engine = new PcStateEngine();
    const state = engine.update(baseInput());
    const texto = state.findings.map(textoDaFinding).join(" | ");
    // O WFP estar inactivo nao pode produzir "Firewall do Windows desativado".
    assert.doesNotMatch(texto, /Windows Firewall.{0,40}(desativado|desligado|inativo)/i,
      `WFP indisponivel virou diagnostico do Windows Firewall: ${texto}`);
  });
});
