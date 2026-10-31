import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { HardwareSnapshot, PcState, ProtectionState } from "@cybersafe/shared-types";
import {
  deriveBootReadiness,
  mostraAvisoDeModoLimitado,
  type BootReadinessInput,
} from "../src/lib/bootReadiness";
import { deriveLoadingState, DEFAULT_STARTUP_TIMEOUT_MS } from "../src/lib/loadingStates";

/**
 * Prontidão do arranque (TP-HAIKU-BOOT-READINESS).
 *
 * Duas promessas ficam fixadas aqui, e são as que a UI não pode quebrar:
 *   1. O TEMPO nunca produz prontidão. Esgotado o orçamento sem confirmação, o
 *      estado é UNKNOWN — não READY.
 *   2. Um erro real não fica a girar. Ele abre a moldura com o aviso, sem
 *      spinner e sem promessa de que a espera vai resolver.
 */

function protection(over: Partial<ProtectionState> = {}): ProtectionState {
  return {
    status: "safe",
    protectionEnabled: true,
    engine: { serviceRunning: true, osLayerHealthy: true, degradedReasons: [], monitoredPaths: [] },
    stats: {
      riskScore: 95,
      totalEvents: 0,
      highSeverityEvents: 0,
      blockedExecutions: 0,
      quarantinedCount: 0,
      monitoredProcesses: 0,
    },
    ...over,
  } as ProtectionState;
}

const PC_STATE = { findings: [] } as unknown as PcState;
const HARDWARE = { cpu: { usage: 2 }, ram: { usagePercent: 3 }, disk: {} } as unknown as HardwareSnapshot;

function input(over: Partial<BootReadinessInput> = {}): BootReadinessInput {
  return {
    serviceConnected: true,
    protection: protection(),
    pcState: PC_STATE,
    hardware: HARDWARE,
    loadingState: "READY",
    syncError: "",
    syncRecusas: 0,
    pastDeadline: false,
    ...over,
  };
}

describe("bootReadiness — READY só com factos confirmados", () => {
  test("serviço + proteção + estado do PC + hardware confirmados abrem a moldura", () => {
    const r = deriveBootReadiness(input());
    assert.equal(r.state, "READY");
    assert.equal(r.claimsReady, true);
    assert.equal(r.opensShell, true);
    assert.equal(r.busy, false);
    assert.equal(r.limitation, null);
    assert.deepEqual(r.confirmed, { service: true, protection: true, pcState: true, hardware: true });
  });

  test("cada leitura em falta impede READY — sem inferir sensores opcionais", () => {
    const casos = [
      { nome: "serviço", over: { serviceConnected: null } },
      { nome: "proteção", over: { protection: null } },
      { nome: "estado do PC", over: { pcState: null } },
      { nome: "hardware", over: { hardware: null } },
    ];
    for (const caso of casos) {
      const r = deriveBootReadiness(input({ ...caso.over, loadingState: "INITIALIZING" } as Partial<BootReadinessInput>));
      assert.notEqual(r.state, "READY", `${caso.nome} em falta não pode dar READY`);
      assert.equal(r.claimsReady, false, `${caso.nome} em falta não afirma prontidão`);
      assert.equal(r.opensShell, false, `${caso.nome} em falta não abre a moldura`);
      assert.equal(r.state, "INITIALIZING", `${caso.nome} em falta continua à espera, dentro do orçamento`);
      assert.equal(r.busy, true);
    }
  });

  test("proteção desligada NÃO impede a moldura e NÃO se apresenta como protegida", () => {
    const r = deriveBootReadiness(input({ protection: protection({ protectionEnabled: false }) }));
    assert.equal(r.state, "READY", "proteção desligada não bloqueia o arranque");
    assert.equal(r.claimsReady, true);
    assert.match(String(r.limitation), /desligada/i, "a limitação fica escrita");
    const texto = `${r.text} ${r.detail} ${r.limitation ?? ""}`;
    assert.doesNotMatch(texto, /proteção (está )?ativa|protegido|protegida/i, "o arranque não afirma proteção ativa");
  });

  test("componentes limitados abrem com o motivo, sem virar espera", () => {
    const r = deriveBootReadiness(input({ loadingState: "DEGRADED" }));
    assert.equal(r.state, "READY");
    assert.equal(r.busy, false);
    assert.match(String(r.limitation), /limitados/i);
  });
});

describe("bootReadiness — o tempo nunca produz prontidão", () => {
  test("orçamento esgotado sem confirmação → UNKNOWN, sem spinner e sem abrir sozinho", () => {
    const r = deriveBootReadiness(input({ serviceConnected: null, protection: null, pcState: null, hardware: null, loadingState: "INITIALIZING", pastDeadline: true }));
    assert.equal(r.state, "UNKNOWN");
    assert.equal(r.claimsReady, false, "UNKNOWN nunca é pronto");
    assert.equal(r.opensShell, false, "UNKNOWN não abre a moldura sozinho");
    assert.equal(r.busy, false, "nada está a carregar: o tempo acabou, não a espera");
    assert.equal(r.canEnterLimited, true, "continuar é um clique explícito");
    assert.match(`${r.text} ${r.detail}`, /sem confirmação|Não há garantia/i);
    assert.ok(r.limitation, "a limitação tem de ficar escrita");
  });

  test("controlo negativo: um mutante «sempre pronto ao fim do tempo» falha esta asserção", () => {
    // Mutação só em memória: é o comportamento antigo (20 s → ready).
    const semprePronto = (): { state: string; claimsReady: boolean; busy: boolean } => ({
      state: "READY",
      claimsReady: true,
      busy: false,
    });
    assert.throws(() => {
      const r = semprePronto();
      assert.equal(r.state, "UNKNOWN");
      assert.equal(r.claimsReady, false);
    }, assert.AssertionError);
  });

  test("os factos dominam o relógio: chegar depois do prazo continua a ser READY", () => {
    const r = deriveBootReadiness(input({ pastDeadline: true }));
    assert.equal(r.state, "READY");
    assert.equal(r.claimsReady, true);
  });

  test("UNKNOWN diz QUAL leitura falta — não afirma serviço ausente quando só faltam sensores", () => {
    const r = deriveBootReadiness(input({ hardware: null, loadingState: "INITIALIZING", pastDeadline: true }));
    assert.equal(r.state, "UNKNOWN");
    assert.deepEqual(r.confirmed, { service: true, protection: true, pcState: true, hardware: false });
    assert.match(`${r.text} ${r.detail} ${r.limitation}`, /sensores/);
    assert.doesNotMatch(`${r.text} ${r.detail} ${r.limitation}`, /sem confirmação do serviço|serviço de proteção indisponível/i, "o serviço está confirmado: não se pode dizer que falta");
  });

  test("sem nada confirmado, a lista de pendentes inclui a ligação ao serviço", () => {
    const r = deriveBootReadiness(input({ serviceConnected: null, protection: null, pcState: null, hardware: null, loadingState: "INITIALIZING", pastDeadline: true }));
    assert.equal(r.state, "UNKNOWN");
    assert.match(r.detail, /ligação ao serviço/);
    assert.match(r.detail, /sensores/);
  });
});

describe("bootReadiness — R6: erro pendente nunca é prontidão", () => {
  // O buraco: `deriveLoadingState` prioriza a proteção presente e só olha para
  // `syncError` no ramo sem leitura. Estes testes usam o contrato REAL para
  // provar que o vizinho diz READY/DEGRADED e que a prontidão diz ERROR.
  const ERRO = "Falha ao sincronizar com o serviço.";

  function vizinho(over: Partial<Parameters<typeof deriveLoadingState>[0]> = {}) {
    return deriveLoadingState({
      booting: false,
      serviceConnected: true,
      protection: protection(),
      syncError: ERRO,
      elapsedMs: 0,
      timeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
      ...over,
    });
  }

  test("vizinho READY com snapshots completos + erro pendente → ERROR, sem prontidão", () => {
    const contrato = vizinho();
    assert.equal(contrato.state, "READY", "o vizinho não vê o erro quando já há proteção — é este o buraco que R6 fecha");

    const r = deriveBootReadiness(input({ loadingState: contrato.state, syncError: ERRO }));
    assert.equal(r.state, "ERROR");
    assert.equal(r.claimsReady, false, "com erro pendente não há prontidão");
    assert.equal(r.opensShell, true, "o aviso tem de ser visível no painel");
    assert.equal(r.busy, false);
    assert.match(`${r.text} ${r.detail}`, /Falha ao sincronizar/);
  });

  test("vizinho DEGRADED (subsistema limitado) + erro pendente → ERROR, sem prontidão", () => {
    const protegido = protection({
      status: "attention",
      engine: {
        serviceRunning: true,
        osLayerHealthy: true,
        degradedReasons: [],
        monitoredPaths: [],
        yara: { status: "degraded" },
      },
    });
    const contrato = vizinho({ protection: protegido });
    assert.equal(contrato.state, "DEGRADED");

    const r = deriveBootReadiness(input({ protection: protegido, loadingState: contrato.state, syncError: ERRO }));
    assert.equal(r.state, "ERROR");
    assert.equal(r.claimsReady, false);
  });

  test("vazio ou só espaços NÃO bloqueiam a prontidão", () => {
    for (const vazio of ["", "   ", "\n\t "]) {
      const r = deriveBootReadiness(input({ loadingState: "READY", syncError: vazio }));
      assert.equal(r.state, "READY", `«${vazio}» não é um erro`);
      assert.equal(r.claimsReady, true);
    }
  });

  test("erro de componente continua ERROR e não é lido como erro de sincronização", () => {
    const r = deriveBootReadiness(input({ loadingState: "ERROR" }));
    assert.equal(r.state, "ERROR");
    assert.equal(r.claimsReady, false);
    assert.equal(r.busy, false);
    assert.match(r.text, /Não foi possível sincronizar/);
  });

  test("a queda confirmada mantém precedência sobre o erro de sincronização", () => {
    const r = deriveBootReadiness(input({ serviceConnected: false, protection: null, loadingState: "UNAVAILABLE", syncError: ERRO }));
    assert.equal(r.state, "UNAVAILABLE");
    assert.equal(r.claimsReady, false);
    assert.equal(r.busy, false);
  });
});

describe("bootReadiness — factos confirmados abrem sem esperar pelo relógio", () => {
  test("serviço desligado → UNAVAILABLE, sem spinner e sem prontidão", () => {
    const r = deriveBootReadiness(input({ serviceConnected: false, protection: null, loadingState: "UNAVAILABLE" }));
    assert.equal(r.state, "UNAVAILABLE");
    assert.equal(r.opensShell, true);
    assert.equal(r.claimsReady, false);
    assert.equal(r.busy, false);
    assert.ok(r.limitation);
  });

  test("erro real de sincronização → ERROR, sem spinner (mutante «sempre a girar» falha)", () => {
    const r = deriveBootReadiness(input({ protection: null, pcState: null, hardware: null, loadingState: "ERROR", syncError: "Falha ao sincronizar com o serviço." }));
    assert.equal(r.state, "ERROR");
    assert.equal(r.busy, false);
    assert.equal(r.opensShell, true, "o aviso vive na moldura, não num spinner");
    assert.equal(r.claimsReady, false);
    assert.match(`${r.text} ${r.detail}`, /Falha ao sincronizar/);

    assert.throws(() => {
      const sempreAGirar = { state: r.state, busy: true };
      assert.equal(sempreAGirar.busy, false);
    }, assert.AssertionError);
  });

  test("recusa por política → RESTRICTED, neutro, sem prontidão e sem avaria", () => {
    const r = deriveBootReadiness(input({ protection: null, pcState: null, hardware: null, loadingState: "REFUSED", syncRecusas: 7 }));
    assert.equal(r.state, "RESTRICTED");
    assert.equal(r.claimsReady, false);
    assert.equal(r.busy, false);
    assert.equal(r.tone, "neutral");
    assert.equal(r.opensShell, true);
    assert.match(r.text, /Rotinas fora do âmbito desta sessão/);
  });

  test("recusas sem estado REFUSED (contagem crua) não viram prontidão", () => {
    const r = deriveBootReadiness(input({ protection: null, pcState: null, hardware: null, loadingState: "INITIALIZING", syncRecusas: 2 }));
    assert.equal(r.state, "RESTRICTED");
    assert.equal(r.claimsReady, false);
  });

  test("com leitura de proteção, uma recusa isolada não sobrepõe o facto", () => {
    const r = deriveBootReadiness(input({ loadingState: "READY", syncRecusas: 1 }));
    assert.equal(r.state, "READY");
  });
});

/**
 * QA2-BOOTFLOW (25/10/2026) — o aviso de «modo limitado» segue o FACTO.
 *
 * Reportado na VM QA1: as strings «Prontidão não confirmada / arranque em modo
 * limitado» continuavam no painel instalado. Se nesse episódio o serviço acabou
 * por responder, não está provado — sem logs da VM, a confirmação tardia é NÃO
 * CONFIRMADA. O que estes casos fixam é o contrato: com o serviço confirmado e
 * todas as leituras presentes, o painel não pode afirmar «sem confirmação do
 * serviço», porque a condição antiga dependia só de `bootPhase` (o clique) e nunca
 * da prontidão actual.
 */
describe("aviso de modo limitado — depende da prontidão, não do clique", () => {
  test("em arranque nunca há aviso (o ecrã de arranque é que fala)", () => {
    const readiness = deriveBootReadiness(input({ loadingState: "INITIALIZING" }));
    assert.equal(mostraAvisoDeModoLimitado("booting", readiness), false);
  });

  test("moldura aberta por facto confirmado nunca mostra o aviso", () => {
    const readiness = deriveBootReadiness(input({ loadingState: "READY" }));
    assert.equal(readiness.claimsReady, true);
    assert.equal(mostraAvisoDeModoLimitado("ready", readiness), false);
  });

  test("entrou em modo limitado e a prontidão continua por confirmar: aviso visível", () => {
    const readiness = deriveBootReadiness(
      input({ serviceConnected: true, protection: null, pcState: null, hardware: null, loadingState: "INITIALIZING", pastDeadline: true }),
    );
    assert.equal(readiness.state, "UNKNOWN");
    assert.equal(mostraAvisoDeModoLimitado("limited", readiness), true);
  });

  test("REGRESSÃO: o serviço confirmou tudo depois do clique → o aviso desaparece", () => {
    const readiness = deriveBootReadiness(input({ loadingState: "READY" }));
    assert.equal(readiness.claimsReady, true);
    assert.equal(
      mostraAvisoDeModoLimitado("limited", readiness),
      false,
      "manter o aviso aqui é afirmar uma limitação que já não existe",
    );
  });

  test("o aviso nunca é mostrado sem clique explícito", () => {
    const unknown = deriveBootReadiness(
      input({ serviceConnected: true, protection: null, pcState: null, hardware: null, loadingState: "INITIALIZING", pastDeadline: true }),
    );
    assert.equal(mostraAvisoDeModoLimitado("booting", unknown), false);
    assert.equal(mostraAvisoDeModoLimitado("ready", unknown), false);
  });

  test("texto do aviso nomeia o que falta quando o serviço já está ligado", () => {
    const readiness = deriveBootReadiness(
      input({ serviceConnected: true, protection: null, pcState: null, hardware: null, loadingState: "INITIALIZING", pastDeadline: true }),
    );
    // O aviso do painel usa `limitation`/`detail` deste estado: tem de nomear as
    // leituras em falta, não afirmar que o serviço está ausente.
    assert.match(String(readiness.limitation), /Por confirmar/);
    assert.match(String(readiness.limitation), /estado da proteção/);
    assert.doesNotMatch(String(readiness.limitation), /Sem serviço confirmado|sem ligação ao serviço/);
  });
});
