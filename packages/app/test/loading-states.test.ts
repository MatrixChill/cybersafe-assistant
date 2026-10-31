import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type {
  EngineHealth,
  EngineSubsystemHealth,
  EngineSubsystemStatus,
  ProtectionState,
} from "@cybersafe/shared-types";
import {
  deriveLoadingState,
  DEFAULT_STARTUP_TIMEOUT_MS,
  BOOT_BODY_COPY,
  LOADING_COPY,
  type LoadingInput,
  type LoadingStateName,
} from "../src/lib/loadingStates";

/**
 * Contrato de estados de carregamento (Ronda 5 — lane R5-L3).
 * A regra central: uma indisponibilidade ou degradação JÁ confirmada pelo
 * serviço nunca pode aparecer como «a carregar», e não existe verde antes de
 * uma leitura confirmada nem vermelho antes de haver um facto.
 */

function sub(status: EngineSubsystemStatus): EngineSubsystemHealth {
  return { status };
}

function engine(overrides: Partial<EngineHealth> = {}): EngineHealth {
  return {
    serviceRunning: true,
    osLayerHealthy: true,
    degradedReasons: [],
    monitoredPaths: [],
    ...overrides,
  };
}

function protection(
  status: ProtectionState["status"],
  engineOverrides: Partial<EngineHealth> = {},
): ProtectionState {
  return {
    status,
    stats: {
      riskScore: 95,
      totalEvents: 0,
      highSeverityEvents: 0,
      blockedExecutions: 0,
      quarantinedCount: 0,
      monitoredProcesses: 0,
    },
    engine: engine(engineOverrides),
  } as ProtectionState;
}

const ALL_ACTIVE: Partial<EngineHealth> = {
  yara: sub("active"),
  hashDb: sub("active"),
  clamav: sub("active"),
  nativeEngine: sub("active"),
  wfp: sub("active"),
};

function derive(overrides: Partial<LoadingInput> = {}) {
  return deriveLoadingState({
    booting: false,
    serviceConnected: true,
    protection: null,
    syncError: "",
    elapsedMs: 0,
    ...overrides,
  });
}

describe("loadingStates — estados distintos e honestos", () => {
  test("INITIALIZING: sem leitura e dentro do prazo, tom neutro, nunca vermelho", () => {
    const s = derive({ booting: true, serviceConnected: null });
    assert.equal(s.state, "INITIALIZING");
    assert.equal(s.busy, true);
    assert.equal(s.tone, "neutral");
    assert.equal(s.canRetry, false);
    assert.match(s.text, /A preparar o motor/);
  });

  test("READY exige leitura confirmada — nunca antes", () => {
    // Sem proteção, o estado NUNCA é READY (nada de verde por ausência de dado).
    const semLeitura = derive({ serviceConnected: true, protection: null });
    assert.notEqual(semLeitura.state, "READY");
    assert.equal(semLeitura.state, "INITIALIZING");

    const comLeitura = derive({ protection: protection("safe", ALL_ACTIVE) });
    assert.equal(comLeitura.state, "READY");
    assert.equal(comLeitura.tone, "ok");
    assert.equal(comLeitura.busy, false);
  });
});

describe("loadingStates — não mascarar degradação/indisponibilidade como carregamento", () => {
  test("YARA degradado → DEGRADED, nunca INITIALIZING", () => {
    const s = derive({
      protection: protection("attention", { ...ALL_ACTIVE, yara: sub("degraded") }),
    });
    assert.equal(s.state, "DEGRADED");
    assert.notEqual(s.state, "INITIALIZING");
    assert.equal(s.busy, false);
    assert.match(s.detail, /YARA \(degradado\)/);
  });

  test("módulo WFP indisponível → DEGRADED, nunca INITIALIZING", () => {
    const s = derive({ protection: protection("safe", { ...ALL_ACTIVE, wfp: sub("unavailable") }) });
    assert.equal(s.state, "DEGRADED");
    assert.notEqual(s.state, "INITIALIZING");
    assert.match(s.detail, /Filtro WFP \(CyberSafe\) \(indisponível\)/);
  });

  test("ClamAV degradado (instalado mas inerte) → DEGRADED com motivo", () => {
    const s = derive({ protection: protection("attention", { ...ALL_ACTIVE, clamav: sub("degraded") }) });
    assert.equal(s.state, "DEGRADED");
    assert.match(s.detail, /ClamAV \(degradado\)/);
  });

  test("subsistema em erro → ERROR, estado confirmado (não espera)", () => {
    const s = derive({ protection: protection("critical", { ...ALL_ACTIVE, nativeEngine: sub("error") }) });
    assert.equal(s.state, "ERROR");
    assert.equal(s.tone, "warn");
    assert.equal(s.canRetry, true);
    assert.match(s.detail, /Motor nativo \(em erro\)/);
    assert.match(s.detail, /não uma espera/);
  });

  test("serviço reporta motor parado → UNAVAILABLE (facto), não carregamento", () => {
    const s = derive({ protection: protection("critical", { serviceRunning: false }) });
    assert.equal(s.state, "UNAVAILABLE");
    assert.notEqual(s.state, "INITIALIZING");
    assert.equal(s.canRetry, false);
  });

  test("ligação ao serviço confirmada em falta → UNAVAILABLE", () => {
    const s = derive({ serviceConnected: false, protection: null });
    assert.equal(s.state, "UNAVAILABLE");
    assert.notEqual(s.state, "INITIALIZING");
    assert.equal(s.busy, false);
    // A reconexão é automática: não se promete um botão que não existe.
    assert.equal(s.canRetry, false);
  });
});

describe("loadingStates — motivos após timeout e erro de sincronização", () => {
  test("após o timeout o estado ganha motivo, sem 'A carregar' sem fim", () => {
    const dentro = derive({ booting: true, serviceConnected: null, elapsedMs: 1000 });
    assert.equal(dentro.reason, "waiting");

    const fora = derive({ booting: true, serviceConnected: null, elapsedMs: DEFAULT_STARTUP_TIMEOUT_MS + 1 });
    assert.equal(fora.state, "INITIALIZING");
    assert.equal(fora.reason, "timeout");
    assert.match(fora.detail, /demorar mais do que o habitual/);
  });

  test("erro de sincronização com serviço ligado → ERROR com repetição suportada", () => {
    const s = derive({ serviceConnected: true, protection: null, syncError: "Falha ao sincronizar com o serviço." });
    assert.equal(s.state, "ERROR");
    assert.equal(s.canRetry, true);
    assert.match(s.detail, /Falha ao sincronizar/);
  });
});

describe("loadingStates — copy sem números inventados", () => {
  const states: LoadingStateName[] = ["INITIALIZING", "READY", "DEGRADED", "UNAVAILABLE", "ERROR"];

  test("nenhuma frase mostra percentagens de progresso", () => {
    const samples = [
      derive({ booting: true, serviceConnected: null }),
      derive({ booting: true, serviceConnected: null, elapsedMs: 999_999 }),
      derive({ protection: protection("safe", ALL_ACTIVE) }),
      derive({ protection: protection("attention", { ...ALL_ACTIVE, yara: sub("degraded") }) }),
      derive({ serviceConnected: false }),
      derive({ serviceConnected: true, syncError: "Falha ao sincronizar com o serviço." }),
      derive({ protection: protection("critical", { ...ALL_ACTIVE, yara: sub("error") }) }),
    ];
    for (const s of samples) {
      assert.doesNotMatch(s.text, /\d+\s*%/, `${s.state}: texto com percentagem`);
      assert.doesNotMatch(s.detail, /\d+\s*%/, `${s.state}: detalhe com percentagem`);
      assert.ok(states.includes(s.state));
    }
    // A copy de arranque vive num único sítio (não duplicada no App).
    assert.equal(BOOT_BODY_COPY, "A preparar o seu centro de segurança...");
    assert.match(LOADING_COPY.initializing, /A preparar o motor/);
  });
});

describe("loadingStates — integração mínima no App", () => {
  test("o App usa o contrato no arranque e no banner de serviço/proteção", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    // O ecrã de arranque foi extraído para components/BootScreen: a política
    // continua a vir do contrato e a copy do arranque mantém uma só fonte.
    const boot = readFileSync(new URL("../src/components/BootScreen.tsx", import.meta.url), "utf8");
    assert.match(app, /import \{ deriveLoadingState, DEFAULT_STARTUP_TIMEOUT_MS \} from "\.\/lib\/loadingStates"/);
    assert.match(app, /deriveLoadingState\(\{/);
    assert.match(boot, /import \{ BOOT_BODY_COPY \} from "\.\.\/lib\/loadingStates"/);
    assert.match(boot, /\{BOOT_BODY_COPY\}/);
    assert.doesNotMatch(app, /A preparar o seu centro de segurança.../, "a copy de arranque voltou a ser duplicada");
    assert.doesNotMatch(boot, /A preparar o seu centro de segurança.../, "a copy de arranque voltou a ser duplicada");
    // O banner lê o estado, não uma string solta.
    assert.match(app, /loadingState.canRetry/);
  });

  test("preserva o WIP obrigatório do App (scroll, boot, ligação, Matrix)", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    assert.match(app, /anchorNewPageAtTop/);
    assert.match(app, /mainScrollRef/);
    assert.match(app, /protectionPending/);
    assert.match(app, /bootSteps/);
    assert.match(app, /serviceConnectionRef/);
    assert.match(app, /buildMatrixContext\(\{ protection, hardware, pcState, threats \}\)/);
  });
});

describe("loadingStates — recusa deliberada de sessão de teste não é espera nem avaria", () => {
  test("sem leitura e com recusas: estado explícito, sem spinner, sem verde", () => {
    const s = derive({ syncRecusas: 7 });
    assert.equal(s.state, "REFUSED", "a recusa do gate tem de ter estado próprio, não INITIALIZING");
    assert.equal(s.busy, false, "nada está a carregar: o serviço respondeu, recusou por política");
    assert.notEqual(s.tone, "ok", "recusa nunca é verde");
    assert.match(`${s.text} ${s.detail}`, /sessão de teste/i);
  });

  test("a recusa não promete levantar o gate", () => {
    const s = derive({ syncRecusas: 3 });
    assert.equal(s.canRetry, false, "repetir não muda o âmbito da sessão; não se oferece botão vazio");
    assert.doesNotMatch(`${s.text} ${s.detail}`, /vai ficar disponível|passa a estar disponível|basta repetir/i);
  });

  test("anti-mascaração: uma falha real domina a recusa", () => {
    const s = derive({ syncRecusas: 3, syncError: "Falha ao sincronizar com o serviço." });
    assert.equal(s.state, "ERROR");
  });

  test("serviço caído domina sobre a recusa", () => {
    const s = derive({ syncRecusas: 3, serviceConnected: false });
    assert.equal(s.state, "UNAVAILABLE");
  });

  test("com proteção confirmada a recusa não sobrepõe um estado já lido", () => {
    const s = derive({ syncRecusas: 2, protection: protection("safe") });
    assert.ok(
      s.state === "READY" || s.state === "DEGRADED" || s.state === "ERROR",
      `com leitura confirmada o estado é o da leitura, veio ${s.state}`,
    );
  });

  test("contraste: zero recusas não cria o estado", () => {
    assert.notEqual(derive({ syncRecusas: 0 }).state, "REFUSED");
    assert.notEqual(derive({}).state, "REFUSED");
    assert.notEqual(derive({ syncRecusas: 0, elapsedMs: 9_999_999 }).state, "REFUSED");
  });
});
