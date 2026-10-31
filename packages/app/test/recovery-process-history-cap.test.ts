import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { criarHistoricoProcessos } from "../src/lib/processIntelligence";
import type { HardwareSnapshot, ProcessSnapshot } from "@cybersafe/shared-types";

/**
 * PACOTE A (PROCESS-UX-HUMAN-FAIL-20261014): reprodução do FAIL humano
 * ">60s todas as tendências em 'A recolher dados'" na candidata instalada,
 * com NÚMEROS DO CONTRATO REAL — ~350-400 processos do Windows, poll de 2 s,
 * 90 s de espera, ordem do lista VARIÁVEL (o serviço não garante ordem).
 *
 * A causa a testar (hipótese do Maestro, NÃO assumida): `maxProcesses` 256
 * com evict oldest-first por inserção. Com >256 identidades vivas e ordem a
 * mudar, cada poll insere chaves novas que EVICTAM séries estabelecidas —
 * nenhuma série sobrevive aos 3 amostras / 30 s que `diagnosticar` exige.
 *
 * Nada aqui usa processos reais, temporizadores reais ou o serviço.
 */

const T0 = 1_760_000_000_000; // âncora fixa; relógio é injetado por parâmetro

const startedAtDe = (pid: number) => new Date(T0 - 600_000 - pid * 1000).toISOString();

const hw: HardwareSnapshot = {
  cpu: { usage: 30, model: "", cores: 8, speed: 0, temperature: null },
  ram: { usagePercent: 60, usedGb: 9.6, totalGb: 16 },
  disk: null, network: { rxSec: 0, txSec: 0 }, gpu: null, alerts: [],
  timestamp: new Date(T0).toISOString(),
} as unknown as HardwareSnapshot;

/** 380 processos com startedAt estável (CreatedIso presente, como no CIM real). */
function mundo(total: number, bigAt: number[]): ProcessSnapshot[] {
  return Array.from({ length: total }, (_, i) => {
    const pid = 1000 + i;
    const big = bigAt.includes(i);
    return {
      pid,
      name: big ? `gigante-${i}.exe` : `proc-${i}.exe`,
      memoryMb: big ? 900 + i : 5 + (i % 40),
      cpu: 0.1,
      startedAt: startedAtDe(pid),
    } as ProcessSnapshot;
  });
}

/** Baralho determinístico (mesma semente) — ordem muda entre polls, como na vida real. */
function ordemVariavel(base: ProcessSnapshot[], poll: number): ProcessSnapshot[] {
  const arr = [...base];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = (i * 31 + poll * 17 + 7) % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

describe("cap de histórico com >maxProcesses processos reais (reprodução do FAIL humano)", () => {
  test("380 processos, ordem variável, poll 2s x 45 (90s): os GIGANTES estáveis têm tendência", () => {
    const hist = criarHistoricoProcessos(); // caps por omissão: 30 amostras, 256 processos, 300s
    const base = mundo(380, [3, 47, 129, 260, 311]); // 5 grandes; dois FORA dos primeiros 256 de qualquer ordem
    for (let poll = 0; poll < 45; poll += 1) {
      hist.registar(ordemVariavel(base, poll), T0 + poll * 2000);
    }
    const diag = hist.diagnosticar(hw, ordemVariavel(base, 45), T0 + 45 * 2000);
    const pidsGrandes = new Set(base.filter((p) => p.memoryMb > 900).map((p) => p.pid));
    const tendenciasGrandes = diag.trends.filter((t) => pidsGrandes.has(t.pid));
    assert.ok(
      tendenciasGrandes.length >= 4,
      `tendências perderam processos estáveis (esperava >=4 gigantes, obtive ${tendenciasGrandes.length}) — o cap está a expulsar séries estabelecidas; humano vê 'A recolher dados' para sempre`,
    );
    assert.equal(
      diag.trends.every((t) => t.samples >= 3 && t.intervalMs >= 30_000),
      true,
      "alguma tendência publicada viola o contrato de amostragem",
    );
  });

  test("380 processos, ordem ESTÁVEL: os do fim da lista (índices >256) também têm tendência", () => {
    const hist = criarHistoricoProcessos();
    const base = mundo(380, [300, 311]); // ambos além da posição 256 da ordem estável
    for (let poll = 0; poll < 45; poll += 1) hist.registar(base, T0 + poll * 2000);
    const diag = hist.diagnosticar(hw, base, T0 + 45 * 2000);
    const pids = new Set(base.filter((p) => p.memoryMb > 900).map((p) => p.pid));
    assert.equal(
      diag.trends.filter((t) => pids.has(t.pid)).length,
      2,
      "com ordem estável, o caudal da lista nunca entra no cap — top5 por memória fica sem série",
    );
  });

  test("ranking com prioridade topRAM: gigantes maduros sobrevivem ao corte mesmo com 5 pequenos a crescer mais", () => {
    const hist = criarHistoricoProcessos();
    const estaveis = mundo(6, [0, 1]); // dois gigantes RAM
    for (let poll = 0; poll < 45; poll += 1) {
      const pequenosQueCrescem = Array.from({ length: 5 }, (_, k) => ({
        pid: 50_000 + k,
        name: `subiu-${k}.exe`,
        memoryMb: 10 + poll * 4 + k, // delta cresce mais que o dos gigantes (planos)
        cpu: 0,
        startedAt: startedAtDe(50_000 + k),
      })) as ProcessSnapshot[];
      hist.registar([...estaveis, ...pequenosQueCrescem], T0 + poll * 2000);
    }
    const diag = hist.diagnosticar(hw, estaveis, T0 + 45 * 2000);
    const pidsGrandes = estaveis.filter((p) => p.memoryMb > 900).map((p) => p.pid);
    const presentes = pidsGrandes.filter((pid) => diag.trends.some((t) => t.pid === pid));
    assert.equal(presentes.length, pidsGrandes.length, "o corte por |delta| deitou fora as instâncias apresentadas no top5");
    assert.equal(diag.trends.length, 5, "contrato: no maximo 5 tendencias");
    // as prioritárias vêm primeiro, ordenadas entre si
    const primeiras = diag.trends.slice(0, pidsGrandes.length).map((t) => t.pid).sort((a, b) => a - b);
    assert.deepEqual(primeiras, [...pidsGrandes].sort((a, b) => a - b));
  });

  test("empates de delta: ordem deterministica (|delta|, depois currentMb, depois pid) sem depender do mapa", () => {
    const hist = criarHistoricoProcessos();
    const gmeos = Array.from({ length: 3 }, (_, k) => ({
      pid: 60_000 + k, name: `empate-${k}.exe`,
      memoryMb: 50 + pollBase(k), cpu: 0, startedAt: startedAtDe(60_000 + k),
    })) as ProcessSnapshot[];
    function pollBase(k: number) { return k * 7; }
    for (let poll = 0; poll < 45; poll += 1) {
      hist.registar(gmeos.map((p, k) => ({ ...p, memoryMb: 50 + k + poll * 2 })), T0 + poll * 2000);
    }
    const a = hist.diagnosticar(hw, gmeos.map((p, k) => ({ ...p, memoryMb: 50 + k + 44 * 2 })), T0 + 45 * 2000);
    const b = hist.diagnosticar(hw, gmeos.map((p, k) => ({ ...p, memoryMb: 50 + k + 44 * 2 })), T0 + 45 * 2000);
    assert.deepEqual(a.trends.map((t) => t.pid), b.trends.map((t) => t.pid), "ranking não determinístico sob empates");
  });

  test("startedAt placeholder (sem CreationDate): sem identidade estável, tendências NÃO existem — honesto", () => {
    const hist = criarHistoricoProcessos();
    const base = mundo(10, [4]).map((p) => ({ ...p, startedAt: new Date(T0).toISOString() }));
    for (let poll = 0; poll < 45; poll += 1) {
      // placeholder = instante DO POLL: muda com o relógio de cada chamada
      const carimbada = base.map((p) => ({ ...p, startedAt: new Date(T0 + poll * 2000).toISOString() }));
      hist.registar(carimbada, T0 + poll * 2000);
    }
    const diag = hist.diagnosticar(hw, base.map((p) => ({ ...p, startedAt: new Date(T0 + 44 * 2000).toISOString() })), T0 + 45 * 2000);
    assert.equal(diag.trends.length, 0, "inventou tendência sem identidade estável");
  });

  test("política preservadora: séries maduras nunca são expulsas por candidatos novos; cap mantém-se", () => {
    const hist = criarHistoricoProcessos();
    // 300 established + fluxo constante de novos candidatos de 1 amostra
    const estaveis = mundo(300, [10, 55, 120, 200, 290]);
    for (let poll = 0; poll < 45; poll += 1) {
      const novos = Array.from({ length: 80 }, (_, k) => ({
        pid: 90_000 + poll * 100 + k,
        name: `novo-${poll}-${k}.exe`,
        memoryMb: 1,
        cpu: 0,
        startedAt: startedAtDe(90_000 + poll * 100 + k),
      })) as ProcessSnapshot[];
      hist.registar([...estaveis, ...novos], T0 + poll * 2000);
    }
    const diag = hist.diagnosticar(hw, estaveis, T0 + 45 * 2000);
    const pids = new Set(estaveis.filter((p) => p.memoryMb > 900).map((p) => p.pid));
    assert.equal(
      diag.trends.filter((t) => pids.has(t.pid)).length,
      5,
      "candidatos efémeros expulsaram séries estabelecidas dentro do cap",
    );
  });
});
