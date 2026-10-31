/**
 * POSTHUMAN13 MATRIX P1 — resposta local determinista a
 * perguntas de estado do PC ("Meu PC está seguro?"),
 * exclusivamente a partir do snapshot real recente do
 * serviço via bridge existente. Sem IA externa, sem APIs
 * novas, sem chamadas ao serviço no 4000/pipe diretas.
 *
 * Regras de honestidade provadas aqui:
 *  - NUNCA se declara o PC absolutamente seguro — a
 *    resposta é "segundo as leituras do serviço", com
 *    a idade validada de cada fonte.
 *  - Frescura por FONTE: PcState.generatedAt e
 *    HardwareSnapshot.timestamp são validados (inválido
 *    ou FUTURO nunca finge frescura); a proteção não
 *    publica timestamp próprio (limitação declarada).
 *  - Desconhecido/degradado/off/erro são DISTINTOS.
 *  - Leituras PARCIAIS são honestas: fonte que falha
 *    aparece como "desconhecido", nunca como zero.
 *  - Snapshot indisponível, rejeitado ou chegado tarde
 *    (após abort/unmount) NÃO inventa números.
 *  - Perguntas de estado respondem-se LOCALMENTE ANTES
 *    do provider — ZERO chamadas externas/provider,
 *    inclusive em erro/staleness.
 *
 * Fixtures fakes controladas; sem contas reais.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  answerLocalSecurityQuestion,
  cancelLocalSecurityRequest,
  shouldDiscardLateAnswer,
  buildLocalSecurityReply,
  isLocalSecurityQuestion,
  type LocalSecurityBridge,
  type LocalSecuritySnapshotInput,
} from "../src/lib/localSecurityReply.ts";
import type {
  HardwareSnapshot,
  PcState,
  ProtectionState,
  ThreatEvent,
} from "@cybersafe/shared-types";

// ── Fixtures controladas ────────────────────────────

const NOW = Date.now();

const protectionFixture = (overrides: Partial<ProtectionState> = {}): ProtectionState =>
  ({
    status: "safe",
    stats: {
      riskScore: 8,
      totalEvents: 3,
      highSeverityEvents: 0,
      blockedExecutions: 1,
      quarantinedCount: 0,
      monitoredProcesses: 42,
    },
    engine: {
      serviceRunning: true,
      osLayerHealthy: true,
      degradedReasons: [],
      monitoredPaths: ["C:\\Users"],
      yara: { status: "active" },
      hashDb: { status: "active" },
      clamav: { status: "active" },
      nativeEngine: { status: "active" },
    },
    protectionEnabled: true,
    protectionPausedUntil: null,
    ...overrides,
  }) as ProtectionState;

const hardwareFixture = (overrides: Partial<HardwareSnapshot> = {}): HardwareSnapshot =>
  ({
    cpu: { usage: 12 },
    ram: { usagePercent: 34 },
    disk: { usagePercent: 55 },
    timestamp: new Date(NOW - 5_000).toISOString(),
    ...overrides,
  }) as unknown as HardwareSnapshot;

const pcStateFixture = (overrides: Partial<PcState> = {}): PcState =>
  ({
    overall: "good",
    security: "good",
    performance: "good",
    privacy: "good",
    system: "good",
    findings: [],
    counts: { urgent: 0, attention: 0, recommended: 0, informative: 0 },
    principalFinding: null,
    generatedAt: new Date(NOW - 12_000).toISOString(),
    ...overrides,
  }) as unknown as PcState;

const threatFixture = (overrides: Partial<ThreatEvent> = {}): ThreatEvent =>
  ({
    source: "system-scanner",
    domain: "file-scan",
    severity: "medium",
    confidence: 0.6,
    rulesTriggered: ["heuristic_match"],
    createdAt: new Date(NOW).toISOString(),
    riskScore: 45,
    ...overrides,
  }) as ThreatEvent;

/** Input completo com fixtures por omissão. */
const snapshotInput = (
  overrides: Partial<LocalSecuritySnapshotInput> = {},
): LocalSecuritySnapshotInput => ({
  protection: protectionFixture(),
  hardware: hardwareFixture(),
  pcState: pcStateFixture(),
  threats: [],
  protectionReceivedAt: NOW,
  now: NOW,
  ...overrides,
});

/** Bridge fake controlada: regista chamadas e devolve fixtures. */
function fakeBridge(
  fixtures: {
    protection?: ProtectionState | null;
    hardware?: HardwareSnapshot | null;
    pcState?: PcState | null;
    threats?: ThreatEvent[] | null;
    /** Fontes cuja leitura rejeita (simula falha de IPC). */
    reject?: Array<"protection" | "hardware" | "pcState" | "threats">;
  } = {},
) {
  const calls = { protection: 0, hardware: 0, pcState: 0, threats: 0 };
  const settle = <T,>(value: T, fail: boolean): Promise<T> =>
    fail
      ? Promise.reject(new Error("ECONNREFUSED fixture-interno"))
      : Promise.resolve(value);
  const reject = (source: string) =>
    (fixtures.reject ?? []).includes(source as never);
  const bridge: LocalSecurityBridge = {
    getProtectionState: () => {
      calls.protection += 1;
      return settle(fixtures.protection ?? protectionFixture(), reject("protection"));
    },
    getHardwareSnapshot: () => {
      calls.hardware += 1;
      return settle(fixtures.hardware ?? hardwareFixture(), reject("hardware"));
    },
    getPCState: () => {
      calls.pcState += 1;
      return settle(fixtures.pcState ?? pcStateFixture(), reject("pcState"));
    },
    getThreatEvents: () => {
      calls.threats += 1;
      return settle(
        fixtures.threats ?? [threatFixture()],
        reject("threats"),
      );
    },
  };
  return { bridge, calls };
}

// ── Detecção de pergunta de estado ──────────────────

describe("isLocalSecurityQuestion — literal PT-BR/PT-PT de estado", () => {
  test("pergunta literal 'Meu PC está seguro?' é aceite", () => {
    assert.equal(isLocalSecurityQuestion("Meu PC está seguro?"), true);
  });

  test("variantes PT-PT/PT-BR e de estado são aceites", () => {
    for (const q of [
      "O meu PC está seguro?",
      "Meu computador está seguro?",
      "meu pc está protegido?",
      "estou protegido?",
      "proteção em tempo real está ativa?",
      "a protecção em tempo real está ligada?",
      "meus motores estão ativos?",
      "algo errado com o meu pc?",
      "o meu pc tem problemas?",
      "está tudo bem com meu computador?",
    ]) {
      assert.equal(isLocalSecurityQuestion(q), true, `esperado true: ${q}`);
    }
  });

  test("perguntas de conselho/educação NÃO são de estado local", () => {
    for (const q of [
      "o que é phishing?",
      "como melhorar minha segurança?",
      "como criar palavras-passe fortes?",
      "o ransomware encripta ficheiros?",
      "lasanha",
      "escreve-me um poema",
    ]) {
      assert.equal(isLocalSecurityQuestion(q), false, `esperado false: ${q}`);
    }
  });
});

// ── Resposta determinista (pura) ────────────────────

describe("buildLocalSecurityReply — PT-PT determinista, sem afirmação absoluta", () => {
  test("snapshot fresco com proteção ativa: estado, RT, motores, leitura de agora", () => {
    const reply = buildLocalSecurityReply(snapshotInput({ threats: [] }));
    assert.match(reply, /Segundo as leituras do serviço/);
    assert.match(reply, /Protegido/);
    assert.match(reply, /Ativa/); // proteção em tempo real
    assert.match(reply, /ativos/); // motores
    assert.match(reply, /leitura de agora/); // frescura medida da receção
    // Nunca afirma segurança absoluta.
    assert.doesNotMatch(reply, /está seguro\b/i);
    assert.match(reply, /Não posso garantir segurança absoluta/);
    // Limitação declarada: proteção sem timestamp próprio.
    assert.match(reply, /não publica timestamp próprio/);
  });

  test("frescura por fonte: PcState.generatedAt antigo reporta a idade (receção ≠ dados)", () => {
    const reply = buildLocalSecurityReply(
      snapshotInput({
        pcState: pcStateFixture({ generatedAt: new Date(NOW - 90_000).toISOString() }),
        threats: [],
      }),
    );
    // A proteção é medida da receção; os dados do PC Center têm 90 s.
    assert.match(reply, /leitura de agora/);
    assert.match(reply, /Problemas detetados \(há 90 s\)/);
  });

  test("timestamp FUTURO nunca finge frescura", () => {
    const reply = buildLocalSecurityReply(
      snapshotInput({
        pcState: pcStateFixture({ generatedAt: new Date(NOW + 60_000).toISOString() }),
        hardware: hardwareFixture({ timestamp: new Date(NOW + 60_000).toISOString() }),
        threats: [],
      }),
    );
    assert.match(reply, /Problemas detetados \(data futura \(inválida\)\)/);
    assert.match(reply, /Recursos \(data futura \(inválida\)\)/);
  });

  test("timestamp inválido (não-data) é declarado, não fingido", () => {
    const reply = buildLocalSecurityReply(
      snapshotInput({
        pcState: pcStateFixture({ generatedAt: "não-é-data" }),
        threats: [],
      }),
    );
    assert.match(reply, /Problemas detetados \(data inválida\)/);
  });

  test("proteção ausente → desconhecido honesto, sem números inventados", () => {
    const reply = buildLocalSecurityReply(
      snapshotInput({
        protection: null,
        threats: null,
        pcState: null,
        hardware: null,
      }),
    );
    assert.match(reply, /desconhecido/i);
    assert.match(reply, /não posso afirmar/i);
    assert.doesNotMatch(reply, /Protegido/);
    assert.doesNotMatch(reply, /\d+(\s*%|\s*GB)/);
  });

  test("leitura parcial honesta: proteção+PC válidos, eventos e recursos sem leitura", () => {
    const reply = buildLocalSecurityReply(
      snapshotInput({ threats: null, hardware: null }),
    );
    // O que existe aparece...
    assert.match(reply, /Protegido/);
    assert.match(reply, /Problemas detetados \(há 12 s\): nenhum na última geração/);
    // ...o que falhou aparece como desconhecido, NUNCA como zero.
    assert.match(reply, /Eventos de segurança disponíveis: desconhecidos \(sem leitura\) — não é zero/);
    assert.match(reply, /· Recursos: sem leitura/);
    assert.doesNotMatch(reply, /disponíveis: 0/);
  });

  test("RT distingue ligada/desligada/pausada/não lida", () => {
    const on = buildLocalSecurityReply(snapshotInput({ protection: protectionFixture({ protectionEnabled: true }), threats: [] }));
    assert.match(on, /Ativa/);
    const off = buildLocalSecurityReply(snapshotInput({ protection: protectionFixture({ protectionEnabled: false }), threats: [] }));
    assert.match(off, /Desativada/);
    const paused = buildLocalSecurityReply(
      snapshotInput({
        protection: protectionFixture({ protectionEnabled: false, protectionPausedUntil: "2030-01-01T00:00:00.000Z" }),
        threats: [],
      }),
    );
    assert.match(paused, /Pausada até/);
    const unknown = buildLocalSecurityReply(snapshotInput({ protection: protectionFixture({ protectionEnabled: undefined }), threats: [] }));
    assert.match(unknown, /não lida \(desconhecida\)/);
  });

  test("motores em erro/degradado são reportados como estão — nunca como ativos", () => {
    const reply = buildLocalSecurityReply(
      snapshotInput({
        protection: protectionFixture({
          status: "attention",
          engine: {
            serviceRunning: true,
            osLayerHealthy: true,
            degradedReasons: ["clamav"],
            monitoredPaths: [],
            yara: { status: "error" },
            hashDb: { status: "active" },
            clamav: { status: "degraded" },
            nativeEngine: { status: "active" },
            anyEngineDegraded: true,
          },
        }),
        threats: [],
      }),
    );
    assert.match(reply, /Erro/);
    assert.match(reply, /Degradado/);
    assert.doesNotMatch(reply, /todos ativos/);
  });

  test("serviço parado → sem leitura fiável, nunca 'protegido'", () => {
    const reply = buildLocalSecurityReply(
      snapshotInput({
        protection: protectionFixture({
          engine: {
            serviceRunning: false,
            osLayerHealthy: true,
            degradedReasons: [],
            monitoredPaths: [],
            yara: { status: "unavailable" },
            hashDb: { status: "unavailable" },
            clamav: { status: "unavailable" },
            nativeEngine: { status: "unavailable" },
          },
        }),
        threats: [],
      }),
    );
    assert.match(reply, /não está a correr/);
    assert.doesNotMatch(reply, /Protegido/);
  });

  test("ameaças recentes e problemas do pcState são refletidos", () => {
    const pcWithFindings = pcStateFixture({
      findings: [
        { severity: "high", title: "Definições do Windows desatualizadas" },
      ] as never,
    });
    const reply = buildLocalSecurityReply(
      snapshotInput({
        pcState: pcWithFindings,
        threats: [threatFixture(), threatFixture()],
      }),
    );
    assert.match(reply, /disponíveis: 2/);
    assert.match(reply, /Definições do Windows desatualizadas/);
  });
});

// ── Orquestrador (bridge existente, fakes controladas) ──────

describe("answerLocalSecurityQuestion — bridge real recente, zero externo", () => {
  test("não é pergunta de estado → null e a bridge NÃO é chamada", async () => {
    const { bridge, calls } = fakeBridge();
    const result = await answerLocalSecurityQuestion("o que é phishing?", bridge);
    assert.equal(result, null);
    assert.deepEqual(calls, { protection: 0, hardware: 0, pcState: 0, threats: 0 });
  });

  test("pergunta literal PT-BR → resposta PT-PT a partir dos 4 snapshots", async () => {
    const { bridge, calls } = fakeBridge();
    const result = await answerLocalSecurityQuestion("Meu PC está seguro?", bridge);
    assert.ok(result, "esperado resposta local");
    assert.match(result.reply, /Segundo as leituras do serviço/);
    assert.deepEqual(calls, { protection: 1, hardware: 1, pcState: 1, threats: 1 });
  });

  test("bridge indisponível (null) → desconhecido honesto, sem números", async () => {
    const result = await answerLocalSecurityQuestion("Meu PC está seguro?", null);
    assert.ok(result);
    assert.match(result.reply, /desconhecido/i);
    assert.doesNotMatch(result.reply, /\d+(\s*%|\s*GB)/);
  });

  test("bridge rejeita tudo → desconhecido, sem eco do erro interno", async () => {
    const { bridge } = fakeBridge({ reject: ["protection", "hardware", "pcState", "threats"] });
    const result = await answerLocalSecurityQuestion("Meu PC está seguro?", bridge);
    assert.ok(result);
    assert.match(result.reply, /sem leitura fiável|desconhecido/i);
    assert.match(result.reply, /desconhecidos \(sem leitura\)/);
    // Sem eco: nem o erro interno nem a pergunta do utilizador.
    assert.doesNotMatch(result.reply, /ECONNREFUSED/);
    assert.doesNotMatch(result.reply, /fixture-interno/);
    assert.doesNotMatch(result.reply, /Meu PC está seguro/);
  });

  test("parcial no orquestrador: hardware e eventos falham, proteção+PC válidos", async () => {
    const { bridge } = fakeBridge({ reject: ["hardware", "threats"] });
    const result = await answerLocalSecurityQuestion("Meu PC está seguro?", bridge);
    assert.ok(result);
    // O que leu aparece...
    assert.match(result.reply, /Protegido/);
    assert.match(result.reply, /Problemas detetados \(há 12 s\)/);
    // ...o que falhou aparece como desconhecido, nunca zero.
    assert.match(result.reply, /desconhecidos \(sem leitura\) — não é zero/);
    assert.match(result.reply, /· Recursos: sem leitura/);
    assert.doesNotMatch(result.reply, /disponíveis: 0/);
  });

  test("sem externo: fetch/provider NUNCA é chamado para perguntas de estado (inclusive em erro)", async () => {
    const { bridge } = fakeBridge({ reject: ["protection", "hardware", "pcState", "threats"] });
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    // @ts-expect-error — spy controlado para provar zero externo
    globalThis.fetch = () => {
      fetchCalls += 1;
      return Promise.reject(new Error("fetch não deve ser chamado"));
    };
    try {
      const result = await answerLocalSecurityQuestion("Meu PC está seguro?", bridge);
      assert.ok(result);
      assert.equal(fetchCalls, 0, "garantido ZERO provider/fetch");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("chegada tardia após abort (unmount/cancelar) é descartada → null", async () => {
    const slowBridge: LocalSecurityBridge = {
      getProtectionState: () =>
        new Promise((resolve) => setTimeout(() => resolve(protectionFixture()), 15)),
      getHardwareSnapshot: () =>
        new Promise((resolve) => setTimeout(() => resolve(hardwareFixture()), 15)),
      getPCState: () =>
        new Promise((resolve) => setTimeout(() => resolve(pcStateFixture()), 15)),
      getThreatEvents: () =>
        new Promise((resolve) => setTimeout(() => resolve([]), 15)),
    };
    const controller = new AbortController();
    controller.abort(); // o utilizador cancelou/fechou antes de os dados chegarem
    const result = await answerLocalSecurityQuestion("Meu PC está seguro?", slowBridge, {
      signal: controller.signal,
    });
    assert.equal(result, null, "snapshot em voo tardio não produz resposta nem números");
  });
});


describe("fecho e concorrência do pedido local", () => {
  test("fechar cancela o controller real e descarta uma leitura pendente", async () => {
    const controller = new AbortController();
    let resolveProtection!: (value: ReturnType<typeof protectionFixture>) => void;
    const { bridge } = fakeBridge();
    bridge.getProtectionState = () => new Promise(resolve => { resolveProtection = resolve; });
    const pending = answerLocalSecurityQuestion("Meu PC está seguro?", bridge, { signal: controller.signal, now: NOW });
    await Promise.resolve(); // a leitura já arrancou; o cancelamento é em voo
    cancelLocalSecurityRequest(controller);
    assert.equal(controller.signal.aborted, true);
    resolveProtection(protectionFixture());
    assert.equal(await pending, null);
  });
  test("pedido antigo não altera a fase ou mensagem da pergunta nova", () => {
    assert.equal(shouldDiscardLateAnswer({ signalAborted: false, questionId: 1, currentQuestionId: 2 }), true);
    assert.equal(shouldDiscardLateAnswer({ signalAborted: true, questionId: 2, currentQuestionId: 2 }), true);
    assert.equal(shouldDiscardLateAnswer({ signalAborted: false, questionId: 2, currentQuestionId: 2 }), false);
  });
  test("sem alertas não significa proteção em tempo real ativa", () => {
    const reply = buildLocalSecurityReply(snapshotInput({ protection: protectionFixture({ protectionEnabled: false }), threats: [] }));
    assert.match(reply, /Desativada/);
    assert.doesNotMatch(reply, /proteção ativa sem erros/i);
    assert.match(reply, /sem alertas reportados/);
  });
});


describe("estado do PC e falhas da bridge", () => {
  test("inclui o estado real do PC, distinto do estado da proteção", () => {
    const reply = buildLocalSecurityReply(snapshotInput({ pcState: pcStateFixture({ overall: "critical" }) }));
    assert.match(reply, /Estado do PC[^\n]*Crítico/);
  });
  test("receção antiga da proteção não se apresenta como leitura de agora", () => {
    const reply = buildLocalSecurityReply(snapshotInput({ protectionReceivedAt: NOW - 90_000 }));
    assert.match(reply, /Proteção:[^\n]*há 90 s/);
    assert.doesNotMatch(reply, /Proteção:[^\n]*leitura de agora/);
  });
  test("erro síncrono de uma fonte produz resposta parcial sem eco", async () => {
    const { bridge } = fakeBridge();
    bridge.getPCState = () => { throw new Error("fixture-privada-nao-ecoar"); };
    const result = await answerLocalSecurityQuestion("Meu PC está seguro?", bridge, { now: NOW });
    assert.ok(result);
    assert.match(result.reply, /Estado do PC: desconhecido/);
    assert.match(result.reply, /Proteção em tempo real/);
    assert.doesNotMatch(result.reply, /fixture-privada/);
  });
});
