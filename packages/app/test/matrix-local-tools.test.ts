import test from "node:test";
import assert from "node:assert/strict";
import {
  answerMatrixLocalQuestion,
  classifyMatrixTopic,
} from "../src/lib/matrixLocalTools.ts";
import { isProcessDiagnosticRequest } from "../src/lib/processMatrix.ts";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();

function hardware(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: iso(5000),
    cpu: { usage: 12, usageStatus: "ok" },
    ram: { usagePercent: 48, totalGb: 16, usedGb: 7.7 },
    disk: { usagePercent: 74.5, totalGb: 500, usedGb: 372.5 },
    ...overrides,
  } as any;
}

function protection(overrides: Record<string, unknown> = {}) {
  return {
    status: "protected",
    protectionEnabled: true,
    protectionPausedUntil: null,
    engine: {
      serviceRunning: true,
      yara: { status: "active" },
      hashDb: { status: "active" },
      clamav: { status: "degraded" },
      nativeEngine: { status: "active" },
    },
    ...overrides,
  } as any;
}

function fakeBridge(hw: any, prot: any) {
  const calls = { hardware: 0, protection: 0 };
  const bridge = {
    getHardwareSnapshot: async () => {
      calls.hardware += 1;
      return hw;
    },
    getProtectionState: async () => {
      calls.protection += 1;
      return prot;
    },
  } as any;
  return { bridge, calls };
}

const ask = (q: string, hw: any, prot: any, now = NOW) => {
  const { bridge, calls } = fakeBridge(hw, prot);
  return { run: answerMatrixLocalQuestion(q, bridge, { now }), calls };
};

test("classificador: perguntas de estado vão para o tópico certo", () => {
  const cases: Array<[string, string | null]> = [
    ["Verifique aí o estado de proteção.", "protection"],
    ["Como está a proteção?", "protection"],
    ["Quais motores estão ativos?", "protection"],
    ["Quanto armazenamento tenho?", "storage"],
    ["Quanto espaço livre tenho no disco C?", "storage"],
    ["Como está a minha RAM?", "resources"],
    ["Quanto está a CPU agora?", "resources"],
    ["O que fazer se um processo estiver a usar 100% da CPU?", null],
    ["Qual processo usa mais CPU agora?", null],
    ["A memória deste processo está a aumentar?", null],
    ["Meu PC está seguro?", "general"],
  ];
  for (const [question, expected] of cases) {
    assert.equal(classifyMatrixTopic(question), expected, question);
  }
});

test("armazenamento: responde com % e GB livres, só lê hardware", async () => {
  const { run, calls } = ask("Quanto armazenamento tenho?", hardware(), protection());
  const answer = await run;
  assert.match(answer!.reply, /74\.5%/);
  assert.match(answer!.reply, /127\.5 GB livres de 500 GB/);
  assert.equal(calls.hardware, 1);
  assert.equal(calls.protection, 0);
});

test("recursos: responde com RAM e só lê hardware", async () => {
  const { run, calls } = ask("Como está a minha RAM?", hardware(), protection());
  const answer = await run;
  assert.match(answer!.reply, /RAM 48% de 16 GB/);
  assert.equal(calls.hardware, 1);
  assert.equal(calls.protection, 0);
});

test("proteção: nomeia motores e só lê proteção", async () => {
  const { run, calls } = ask("Verifique aí o estado de proteção.", hardware(), protection());
  const answer = await run;
  assert.match(answer!.reply, /YARA/);
  assert.match(answer!.reply, /HashDB/);
  assert.match(answer!.reply, /ClamAV/);
  assert.match(answer!.reply, /Native/);
  assert.equal(calls.protection, 1);
  assert.equal(calls.hardware, 0);
});

test("sem leitura de hardware não inventa valores", async () => {
  const { run } = ask("Quanto espaço livre tenho?", null, protection());
  const answer = await run;
  assert.match(answer!.reply, /Sem leitura de hardware/);
  assert.doesNotMatch(answer!.reply, /\d+%/);
});

test("leitura antiga não é apresentada como estado atual", async () => {
  const { run } = ask("Quanto espaço tenho no disco?", hardware({ timestamp: iso(10 * 60_000) }), protection());
  const answer = await run;
  assert.match(answer!.reply, /não é atual/);
  assert.doesNotMatch(answer!.reply, /74\.5%/);
});

test("leitura futura é rejeitada", async () => {
  const { run } = ask("Como está a RAM?", hardware({ timestamp: iso(-60_000) }), protection());
  const answer = await run;
  assert.match(answer!.reply, /não é atual|data futura/);
});

test("proteção indisponível não é mascarada", async () => {
  const { run } = ask("Como está a proteção?", hardware(), null);
  const answer = await run;
  assert.match(answer!.reply, /desconhecido|Sem leitura/);
});

test("serviço parado não afirma proteção", async () => {
  const { run } = ask(
    "Como está a proteção?",
    hardware(),
    protection({ engine: { serviceRunning: false } }),
  );
  const answer = await run;
  assert.match(answer!.reply, /não está a correr/);
});

test("pergunta educativa não lê dados do serviço", async () => {
  const { run, calls } = ask("O que fazer se um processo usa 100% CPU?", hardware(), protection());
  const answer = await run;
  assert.equal(answer, null);
  assert.equal(calls.hardware, 0);
  assert.equal(calls.protection, 0);
});

test("cancelamento devolve null sem responder", async () => {
  const controller = new AbortController();
  controller.abort();
  const { bridge } = fakeBridge(hardware(), protection());
  const answer = await answerMatrixLocalQuestion("Quanto espaço tenho?", bridge, {
    now: NOW,
    signal: controller.signal,
  });
  assert.equal(answer, null);
});

test("Caso A: proteção é lida independentemente da página aberta", async () => {
  const { run, calls } = ask("Verifique aí o estado de proteção.", hardware(), protection());
  const answer = await run;
  assert.match(answer!.reply, /Proteção: /);
  assert.equal(calls.protection, 1);
});

test("Caso B: armazenamento devolve os dados disponíveis", async () => {
  const { run } = ask("Quanto armazenamento tenho?", hardware(), protection());
  const answer = await run;
  assert.match(answer!.reply, /74\.5%/);
  assert.match(answer!.reply, /127\.5 GB livres de 500 GB/);
});

test("Caso C: conselho geral não abre diagnóstico do processo selecionado", () => {
  assert.equal(isProcessDiagnosticRequest("O que fazer se um processo usa 100% CPU?"), false);
  assert.equal(isProcessDiagnosticRequest("Explica este processo."), true);
  assert.equal(isProcessDiagnosticRequest("Porque está este processo lento?"), true);
});
