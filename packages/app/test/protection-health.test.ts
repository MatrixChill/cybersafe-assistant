import { test, describe } from "node:test";
import { engineStatusText, windowsFirewallDisplay, wfpModuleDisplay } from "../src/lib/protectionHealth";
import assert from "node:assert/strict";
import type { EngineHealth, ProtectionStatus } from "@cybersafe/shared-types";
import { deriveProtectionLevel, explainProtectionScore, PROTECTION_LEVEL_META } from "../src/lib/protectionHealth";

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

const cases: { name: string; status: ProtectionStatus; engine?: EngineHealth; expected: string }[] = [
  {
    name: "todos ativos + safe → protected",
    status: "safe",
    engine: healthyEngine(),
    expected: "protected",
  },
  {
    name: "yara ativo + clamav unavailable + safe → NUNCA protected",
    status: "safe",
    engine: healthyEngine({
      anyEngineDegraded: true,
      clamav: { status: "unavailable", detail: "serviço não instalado" },
    }),
    expected: "degraded",
  },
  {
    name: "yara ativo + clamav unavailable + attention → degraded",
    status: "attention",
    engine: healthyEngine({
      anyEngineDegraded: true,
      clamav: { status: "unavailable", detail: "serviço não instalado" },
    }),
    expected: "degraded",
  },
  {
    name: "engine em ERROR + safe → critical imediato",
    status: "safe",
    engine: healthyEngine({
      anyEngineDegraded: true,
      yara: { status: "error", detail: "falha de inicialização" },
    }),
    expected: "critical",
  },
  {
    name: "serviço desligado + safe → critical",
    status: "safe",
    engine: healthyEngine({ serviceRunning: false, anyEngineDegraded: true }),
    expected: "critical",
  },
  {
    name: "critical (ameaça) + healthy → critical",
    status: "critical",
    engine: healthyEngine(),
    expected: "critical",
  },
  {
    name: "degraded backend + sem engines → degraded",
    status: "degraded",
    engine: undefined,
    expected: "degraded",
  },
  {
    name: "backend degraded com serviço parado → critical (defesa extra)",
    status: "degraded",
    engine: healthyEngine({ serviceRunning: false, anyEngineDegraded: true }),
    expected: "critical",
  },
];

for (const c of cases) {
  test(c.name, () => {
    assert.equal(deriveProtectionLevel(c.status, c.engine), c.expected);
  });
}

// ── Explicação da pontuação (pesos reais espelham effectiveRiskScore) ──

describe("explainProtectionScore — fórmula real do Dashboard", () => {
  test("cenário 55: 2 de 4 motores de análise ativos → máx 55, sem penalização", () => {
    // Estado real típico: YARA + Hash DB ativos; ClamAV e Native indisponíveis.
    const engine: EngineHealth = {
      serviceRunning: true,
      osLayerHealthy: true,
      degradedReasons: [],
      monitoredPaths: [],
      yara: { status: "active" },
      hashDb: { status: "active" },
      clamav: { status: "unavailable", detail: "clamscan não encontrado" },
      nativeEngine: { status: "unavailable", detail: "não integrado" },
      firewall: { status: "unavailable" },
    };
    const info = explainProtectionScore(55, engine);
    assert.equal(info.activeEngines, 2);
    assert.equal(info.totalEngines, 4);
    assert.equal(info.maxPossible, 55); // 100 − piso 45 (1–2 ativos)
    assert.equal(info.threatPenalty, 0); // 55 já é o máximo possível
  });

  test("0 motores de análise ativos → máx 25 (piso 75)", () => {
    const engine: EngineHealth = {
      serviceRunning: true,
      osLayerHealthy: true,
      degradedReasons: [],
      monitoredPaths: [],
      yara: { status: "error" },
      hashDb: { status: "error" },
      clamav: { status: "unavailable" },
      nativeEngine: { status: "unavailable" },
    };
    assert.equal(explainProtectionScore(25, engine).maxPossible, 25);
  });

  test("4 motores ativos sem degradados → máx 100", () => {
    const engine: EngineHealth = {
      serviceRunning: true,
      osLayerHealthy: true,
      degradedReasons: [],
      monitoredPaths: [],
      yara: { status: "active" },
      hashDb: { status: "active" },
      clamav: { status: "active" },
      nativeEngine: { status: "active" },
    };
    const info = explainProtectionScore(80, engine);
    assert.equal(info.maxPossible, 100);
    assert.equal(info.threatPenalty, 20); // ameaças recentes explicam os 20 perdidos
  });

  test("a pontuação nunca reflete componentes inexistentes como penalização", () => {
    // Firewall UNAVAILABLE não conta para o piso (comporta-se como o backend).
    const engine: EngineHealth = {
      serviceRunning: true,
      osLayerHealthy: true,
      degradedReasons: [],
      monitoredPaths: [],
      yara: { status: "active" },
      hashDb: { status: "active" },
      clamav: { status: "active" },
      nativeEngine: { status: "active" },
      firewall: { status: "unavailable" },
    };
    assert.equal(explainProtectionScore(100, engine).maxPossible, 100);
  });

  test("o texto do nível degraded é compreensível por utilizadores comuns", () => {
    assert.equal(PROTECTION_LEVEL_META.degraded.shortLabel, "Atenção");
    assert.equal(PROTECTION_LEVEL_META.degraded.label, "Proteção precisa de atenção");
  });
});
/**
 * O texto de estado de cada motor tem de ser o que o serviço reportou.
 * Runtime real (probe ao serviço vivo): o ClamAV chega com status "degraded"
 * e o motivo "ClamAV instalado mas sem base de assinaturas ... corre freshclam".
 */
describe("honestidade do estado de cada motor", () => {
  // A copy passou de tokens crus ("DEGRADED") para PT-PT ("Degradado").
  // O INVARIANTE nao muda: um motor inerte continua a nao poder aparecer como
  // operacional. E o invariante que se prova, nao a grafia do token.
  test("o ClamAV sem base de assinaturas mostra Degradado, nunca Ativo", () => {
    // Motor instalado mas inerte NAO e motor operacional. Se isto virar "Ativo",
    // a UI passa a afirmar que o ClamAV protege, e ele nao analisa nada.
    assert.equal(engineStatusText("degraded"), "Degradado");
    assert.notEqual(engineStatusText("degraded"), engineStatusText("active"));
  });

  test("um motor indisponivel mostra Indisponível, nunca Ativo", () => {
    // O mesmo princípio para o firewall (WFP filter not started).
    assert.equal(engineStatusText("unavailable"), "Indisponível");
    assert.notEqual(engineStatusText("unavailable"), engineStatusText("active"));
  });

  test("só o estado 'active' é apresentado como Ativo", () => {
    // "Ativo" é uma afirmação: o motor viu os ficheiros. Só o serviço a pode fazer.
    assert.equal(engineStatusText("active"), "Ativo");
  });

  test("um motor em erro mostra Erro", () => {
    assert.equal(engineStatusText("error"), "Erro");
  });

  test("a telemetria real do ClamAV degrada o nivel, nao o mantem protegido", () => {
    // O estado exato que o serviço devolveu nesta maquina.
    const engine: EngineHealth = {
      serviceRunning: true,
      anyEngineDegraded: true,
      clamav: { status: "degraded", detail: "ClamAV instalado mas sem base de assinaturas" },
      yara: { status: "active", detail: "Loaded 1 rule(s) from file" },
      hashDb: { status: "active", detail: "Loaded 4 signature(s)" },
    } as EngineHealth;
    const level = deriveProtectionLevel("safe", engine);
    assert.notEqual(level, "protected", "com o ClamAV inerte nao se pode dizer 'Sistema Protegido'");
    assert.equal(level, "degraded");
  });
});

/**
 * O Windows Firewall e o modulo WFP do CyberSafe sao coisas diferentes.
 * Runtime real (protection.getState ao servico vivo): engine.firewall =
 * { status: "unavailable", detail: "WFP filter not started" }, e vem de
 * wfpFilter.isActive() (engine.ts:762-765) — ou seja, so do modulo WFP.
 * A UI dizia "protecao desligada", o que afirmava sobre o Windows algo que
 * o produto nunca mediu.
 */
describe("honestidade do firewall", () => {
  test("estado REAL desligado, com evidencia, e dito como desligado", () => {
    // Aqui ha leitura real (Get-NetFirewallProfile), logo afirmar e honesto.
    const win = windowsFirewallDisplay({ enabled: false, available: true, profiles: [{ name: "Dominio", enabled: false }, { name: "Publico", enabled: true }] });
    assert.equal(win.status, "inactive");
    assert.equal(win.text, "DESATIVADO");
    assert.match(win.detail, /Dominio/);
  });

  test("estado REAL ligado, com evidencia, e dito como ativo", () => {
    const win = windowsFirewallDisplay({ enabled: true, available: true, profiles: [{ name: "Publico", enabled: true }] });
    assert.equal(win.status, "active");
    assert.equal(win.text, "ATIVO");
  });

  test("estado DESCONHECIDO: diz desconhecido, nunca desligado", () => {
    // Sem leitura real nao se afirma nada sobre o Windows. Este e o caso de hoje:
    // o servico nao consulta o firewall do Windows.
    for (const entrada of [null, undefined, { enabled: false, available: false, profiles: [] }]) {
      const win = windowsFirewallDisplay(entrada as never);
      assert.equal(win.status, "unknown");
      assert.equal(win.text, "Não verificado");
      assert.notEqual(win.text, "DESATIVADO");
      assert.doesNotMatch(win.text, /desligad/i, "desconhecido nunca se escreve como desligado");
    }
  });

  test("modulo WFP inativo mostra o estado real e o disclaimer do Windows", () => {
    // Payload exacto do servico nesta maquina. WS-B: a copy antiga prometia
    // "Arranca quando ligado a Proteção" sem prova no codigo/runtime — essa
    // afirmacao passou a ser proibida. O que se exige agora e o disclaimer
    // honesto de que o estado do nosso filtro nada diz do Firewall do Windows.
    const wfp = wfpModuleDisplay({ status: "unavailable", detail: "WFP filter not started" });
    assert.equal(wfp.text, "Indisponível");
    assert.match(wfp.detail, /filtro de rede próprio do CyberSafe/i, wfp.detail);
    assert.match(wfp.detail, /Isto não significa que o Firewall do Windows esteja desligado\./, wfp.detail);
    assert.doesNotMatch(wfp.detail, /arranca quando/i, "nao se afirma um comportamento nao provado");
    assert.doesNotMatch(wfp.detail, /\bmodulo\b/i, "PT-PT corrente: 'módulo', nao 'modulo'");
  });

  test("nenhum estado do modulo WFP se escreve como protecao desligada", () => {
    // A mentira que o utilizador viu. unavailable, unknown e degraded nao podem
    // aparecer como "protecao desligada" — isso sugeriria que o Windows esta
    // desprotegido, e o modulo WFP nao diz nada sobre o Windows.
    for (const sub of [
      { status: "unavailable", detail: "WFP filter not started" },
      { status: "degraded", detail: "WFP filter not active" },
      { status: "error", detail: "WFP filter off" },
      undefined,
    ] as never[]) {
      const wfp = wfpModuleDisplay(sub as never);
      assert.doesNotMatch(wfp.text, /desligad/i, `estado ${JSON.stringify(sub)}`);
      assert.doesNotMatch(wfp.detail, /protecao desligada/i, `estado ${JSON.stringify(sub)}`);
    }
  });

  test("o nivel global nunca regressa a protegido com o WFP inativo", () => {
    // Payload real: clamav degraded + firewall unavailable, com o servico a correr.
    const engine = {
      serviceRunning: true,
      anyEngineDegraded: true,
      yara: { status: "active", detail: "Loaded 1 rule(s) from file" },
      hashDb: { status: "active", detail: "Loaded 4 signature(s)" },
      clamav: { status: "degraded", detail: "sem base de assinaturas" },
      nativeEngine: { status: "active", detail: "ok" },
      firewall: { status: "unavailable", detail: "WFP filter not started" },
    } as unknown as EngineHealth;
    const level = deriveProtectionLevel("safe", engine);
    assert.notEqual(level, "protected", "com o WFP inativo e o ClamAV degradado nao se pode dizer Sistema Protegido");
    assert.equal(level, "degraded");
  });

  test("o Windows Firewall desconhecido NAO torna o nivel critico", () => {
    // Desconhecer o Windows Firewall nao e evidencia de problema: nao pode
    //agerir a protecao para critical, que seria alarmismo sem prova.
    const engine = {
      serviceRunning: true,
      anyEngineDegraded: false,
      yara: { status: "active", detail: "ok" },
      hashDb: { status: "active", detail: "ok" },
      clamav: { status: "active", detail: "ok" },
      nativeEngine: { status: "active", detail: "ok" },
    } as unknown as EngineHealth;
    const level = deriveProtectionLevel("safe", engine);
    assert.notEqual(level, "critical", "desconhecer o Windows Firewall nao e um erro de motor");
  });
});
