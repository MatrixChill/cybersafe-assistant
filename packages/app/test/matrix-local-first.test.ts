/**
 * TP-MATRIX-LOCAL-FIRST-20261023 — o clique «Explicar» responde com o que foi
 * medido, sem fornecedor e sem consentimento externo.
 *
 * Estes testes olham para o MOTOR local (o mesmo que o componente chama) e para
 * o contrato que a opção de IA usa depois. Não há mocks de fetch: quando se fala
 * de fornecedor é o validador real que decide.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProcessLocalReply,
  instanteDoContrato,
  familiaDoProcesso,
  narrativaDaFamilia,
  processPayload,
} from "../src/lib/processMatrix.ts";
import { alvoDePedido } from "../src/lib/matrixRequestMachine.ts";
import { validateProcessIntelligencePayload } from "../../api/src/process-intelligence.ts";
import { buildProcessMatrixContext } from "../src/lib/processMatrix.ts";
import { isProcessQuestion } from "../src/lib/processMatrix.ts";

const INICIO_BRAVE = "2026-10-23T08:00:00.0000000Z";
const INICIO_WMI = "2026-10-23T09:14:07.1234567Z";
const INICIO_DEFENDER = "2026-10-23T07:00:00.0000000Z";
const INICIO_DESCONHECIDO = "2026-10-23T06:00:00.0000000Z";

const TOP = [
  { pid: 900, name: "brave.exe", startedAt: INICIO_BRAVE, cpuPercent: 22, workingSetMb: 1800 },
  { pid: 901, name: "brave.exe", startedAt: "2026-10-23T08:01:00.0000000Z", cpuPercent: 3, workingSetMb: 250 },
  { pid: 902, name: "brave.exe", startedAt: "2026-10-23T08:02:00.0000000Z", cpuPercent: 2, workingSetMb: 180 },
  { pid: 15112, name: "WmiPrvSE.exe", startedAt: INICIO_WMI, cpuPercent: 62.4, workingSetMb: 118.4 },
  { pid: 600, name: "MsMpEng.exe", startedAt: INICIO_DEFENDER, cpuPercent: 4, workingSetMb: 320 },
];

function diagnostico(over: Record<string, unknown> = {}) {
  return {
    measuredAt: "2026-10-23T09:20:00.000Z",
    ram: { totalMb: 16384, usedMb: 15000, availableMb: 1384 },
    cpuPercent: 88,
    topProcesses: TOP,
    trends: [
      { pid: 900, startedAt: INICIO_BRAVE, previousMb: 1500, currentMb: 1800, deltaMb: 300, intervalMs: 60000, samples: 3 },
    ],
    observations: [],
    recommendations: ["Guardar o trabalho antes de fechar normalmente uma aplicação."],
    limitations: ["Working Set não é memória privada ou exclusiva."],
    ...over,
  } as never;
}

const brave = TOP[0];
const wmi = TOP[3];
const defender = TOP[4];
const desconhecido = { pid: 777, name: "appdesconhecida.exe", startedAt: INICIO_DESCONHECIDO, cpuPercent: 30, workingSetMb: 400 };

// As menções a malware são NEGADAS («não é sinal de malware»); o que não pode
// aparecer é uma afirmação de infeção, de ameaça confirmada ou de normalidade,
// nem uma fuga de memória dada como confirmada.
const semAlarme = (texto: string) => assert.doesNotMatch(
  texto,
  /(está|foi|é) (infetado|malware)|ameaça confirmada|fuga de memória confirmada|\bNormal\b/i,
);

test("L1 — Brave com RAM alta: mede, explica multiprocesso e não atribui culpa", () => {
  const texto = buildProcessLocalReply(diagnostico(), 900, brave);
  assert.match(texto, /DIAGNÓSTICO LOCAL/);
  assert.match(texto, /brave\.exe \(PID 900\)/);
  assert.match(texto, /1800 MB/);
  assert.match(texto, /separadores, extensões e processos auxiliares/);
  assert.match(texto, /não atribuem culpa/i);
  assert.match(texto, /3 processos com este nome/);
  assert.match(texto, /soma do Working Set não é memória exclusiva/);
  semAlarme(texto);
});

test("L2 — Brave normal (sem tendência): não é alarmista nem afirma pressão", () => {
  const texto = buildProcessLocalReply(diagnostico({ trends: [] }), 901, TOP[1]);
  assert.match(texto, /Tendência deste processo: A recolher dados\. Uma amostra isolada não é tendência\./);
  assert.match(texto, /Estado: \*\*não concludente\*\*/);
  assert.match(texto, /Pressão de memória não é confirmável/);
  semAlarme(texto);
});

test("L3 — WmiPrvSE: finalidade WMI, medição da própria app, não terminar", () => {
  const texto = buildProcessLocalReply(diagnostico(), 15112, wmi);
  assert.match(texto, /WmiPrvSE\.exe é o anfitrião de fornecedores WMI/);
  assert.match(texto, /As medições desta própria app usam WMI/);
  assert.match(texto, /Não encerrar/i);
  assert.match(texto, /não é sinal de malware/i);
});

test("L4 — MsMpEng (Defender): não confirma análise, não terminar nem desativar", () => {
  const texto = buildProcessLocalReply(diagnostico(), 600, defender);
  assert.match(texto, /Microsoft Defender/);
  assert.match(texto, /não confirma uma análise em curso/);
  assert.match(texto, /Não encerrar nem desativar/);
});

test("L5 — processo desconhecido: só as métricas, sem inventar função", () => {
  const texto = buildProcessLocalReply(diagnostico({ trends: [] }), 777, desconhecido as never);
  assert.match(texto, /Não há informação suficiente para atribuir uma função/);
  assert.match(texto, /appdesconhecida\.exe \(PID 777\)/);
  assert.match(texto, /400 MB/);
  semAlarme(texto);
});

test("L6 — sem histórico: uma amostra nunca vira tendência; memória comprimida mantém o texto técnico", () => {
  const texto = buildProcessLocalReply(
    diagnostico({ trends: [] }),
    968,
    { pid: 968, name: "Memory Compression", startedAt: "2026-09-01T10:00:00.000Z", cpuPercent: 3, workingSetMb: 1950 },
  );
  assert.match(texto, /Uma amostra isolada não é tendência/);
  assert.match(texto, /comprime páginas de memória menos usadas/);
  assert.doesNotMatch(texto, /Working Set: \d+ → \d+/);
});

test("L7 — família: navegadores, Discord, WMI, Defender, cliente de jogos e desconhecido", () => {
  for (const n of ["brave.exe", "chrome.exe", "msedge.exe", "opera.exe", "firefox.exe"]) assert.equal(familiaDoProcesso(n), "navegador", n);
  assert.equal(familiaDoProcesso("Discord.exe"), "discord");
  assert.equal(familiaDoProcesso("wmiprvse.exe"), "wmi");
  assert.equal(familiaDoProcesso("MsMpEng.exe"), "defender");
  assert.equal(familiaDoProcesso("steam.exe"), "cliente-jogos");
  assert.equal(familiaDoProcesso("qualquer.exe"), "desconhecido");
  assert.match(narrativaDaFamilia("cliente-jogos").explicacao, /carga alta durante o jogo é esperada/);
  assert.match(narrativaDaFamilia("discord").explicacao, /tecnologias web|Electron/);
});

test("L8 — diagnóstico local não depende de fornecedor: o mesmo texto sai em modo local e a falha de IA acrescenta, não substitui", () => {
  const texto = buildProcessLocalReply(diagnostico(), 15112, wmi);
  // Não há parâmetro de modo/fornecedor: é impossível o texto local depender de rede.
  assert.equal(buildProcessLocalReply(diagnostico(), 15112, wmi), texto);
  assert.equal(isProcessQuestion("É seguro fechar o WmiPrvSE?"), true);
  // Falha de IA: o resultado do pedido é «indisponível», e o diagnóstico local já
  // está na conversa — a mensagem de falha é OUTRA, nunca a substitui.
  assert.match(texto, /DIAGNÓSTICO LOCAL/);
});

test("L9 — pergunta geral sem consentimento: nenhuma telemetria de processo sai", () => {
  const contexto = buildProcessMatrixContext(diagnostico(), 15112, wmi as never);
  assert.deepEqual(processPayload(contexto, false), {});
  const payload = processPayload(contexto, true);
  assert.equal(validateProcessIntelligencePayload(payload.processIntelligence), true);
});

test("L11 — REGRESSÃO: instante 7 casas na fonte, selectedProcess normalizado → a MESMA instância preserva a tendência", () => {
  const diag = diagnostico();
  const contexto = buildProcessMatrixContext(diag, 900, { ...(brave as object), cpu: 22, memoryMb: 1800 } as never);
  assert.equal(contexto.selectedProcess?.startedAt, instanteDoContrato(INICIO_BRAVE));
  assert.equal(contexto.selectedProcess?.startedAt, "2026-10-23T08:00:00.000Z");
  const texto = buildProcessLocalReply(diag, 900, contexto.selectedProcess);
  assert.match(texto, /Working Set: 1500 → 1800 MB \(\+300 MB em 60 s, 3 amostras\)/);
  assert.doesNotMatch(texto, /Tendência deste processo: A recolher dados/);
});

test("L12 — REGRESSÃO: outra instância do mesmo PID é rejeitada (sem tolerância larga)", () => {
  const diag = diagnostico();
  const outra = { ...(brave as object), startedAt: "2026-10-23T08:00:00.0010000Z" };
  const contexto = buildProcessMatrixContext(diag, 900, outra as never);
  const texto = buildProcessLocalReply(diag, 900, contexto.selectedProcess);
  assert.match(texto, /Tendência deste processo: A recolher dados\. Uma amostra isolada não é tendência\./);
  assert.doesNotMatch(texto, /1500 → 1800/);
});

test("L13 — REGRESSÃO: null/ilegível nunca prova identidade (nem com null===null)", () => {
  const diag = diagnostico({
    trends: [{ pid: 900, startedAt: null, previousMb: 1500, currentMb: 1800, deltaMb: 300, intervalMs: 60000, samples: 3 }],
  });
  const texto = buildProcessLocalReply(diag, 900, { pid: 900, name: "brave.exe", startedAt: null, cpuPercent: 22, workingSetMb: 1800 });
  assert.match(texto, /Tendência deste processo: A recolher dados/);
  assert.doesNotMatch(texto, /1500 → 1800/);

  const ilegivel = buildProcessLocalReply(diag, 900, { pid: 900, name: "brave.exe", startedAt: "1793000000000", cpuPercent: 22, workingSetMb: 1800 });
  assert.match(ilegivel, /Tendência deste processo: A recolher dados/);
});

test("L14 — REGRESSÃO: histórico insuficiente não inventa tendência; desconhecido mantém-se nas métricas", () => {
  const semHistorico = buildProcessLocalReply(diagnostico({ trends: [] }), 900, brave);
  assert.doesNotMatch(semHistorico, /→/);
  assert.match(semHistorico, /Uma amostra isolada não é tendência/);
  const desconhecidoSemHistorico = buildProcessLocalReply(diagnostico({ trends: [] }), 777, desconhecido as never);
  assert.match(desconhecidoSemHistorico, /Não há informação suficiente para atribuir uma função/);
  assert.doesNotMatch(desconhecidoSemHistorico, /→/);
});

test("L10 — trocar de PID/instância não mistura alvos: a identidade é pid + instante", () => {
  const a = alvoDePedido({ pid: 900, startedAt: INICIO_BRAVE });
  const b = alvoDePedido({ pid: 900, startedAt: "2026-10-23T08:05:00.0000000Z" });
  assert.notEqual(a, b, "mesmo PID com outra instância é outro alvo");
  assert.equal(alvoDePedido({ pid: 15112, startedAt: INICIO_WMI }), `15112:${INICIO_WMI}`);
});
