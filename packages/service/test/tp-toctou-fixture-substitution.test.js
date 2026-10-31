/**
 * TP-PAP-FREEBUFF-TOCTOU-20261027 — substituição de caminho DEPOIS da validação.
 *
 * O que este ficheiro fixa, em uma frase: a validação do gate de fixture prova o
 * alvo NO INSTANTE do `scan.start`; o scan corre depois, abre caminhos outra vez
 * e — sem verificação no momento do uso — pode analisar um objecto que nunca foi
 * validado (junction criada depois, pasta substituída, ficheiro recriado).
 *
 * Todas as fixtures são benignas e ficam em TEMP: um corpus validado dentro da
 * raiz de fixture e uma "isca" FORA da raiz (o que a substituição tentaria
 * alcançar). Sem EICAR, sem rede, sem kills, sem dados pessoais.
 *
 * Contratos:
 *  1. Controlo positivo: sem substituição, o scan de fixture completa e analisa
 *     exactamente os ficheiros validados (as guardas não bloqueiam o caso bom).
 *  2. Junction criada depois da validação (antes do gather) ⇒ `failed` fechado,
 *     ZERO ficheiros entregues ao motor.
 *  3. Alvo trocado por uma pasta REAL (sem links) depois da validação ⇒ `failed`
 *     fechado, ZERO ficheiros entregues.
 *  4. Substituição a meio do scan: locks Windows recusam o rename antes da
 *     reabertura do motor; ZERO leituras do objecto errado, corpus original completo.
 *  5. `startScan` directo em modo fixture, sem validação registada ⇒ `failed`
 *     fechado (acesso dirigido bloqueado), ZERO leituras.
 *  6. Junction dentro do corpus (não substitui o alvo): nunca se lê fora da raiz.
 *  7. Primitivas: a validação captura a identidade efectiva e a recriação de um
 *     ficheiro (mesmo caminho, mesmo conteúdo, objecto novo) é detectada.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ScanManager } from "../dist/scan-manager.js";
import {
  FIXTURE_ROOT_ENV,
  FIXTURE_SCAN_FLAG,
  GATE_CODE,
  installDevFixtureGate,
} from "../dist/dev-fixture-gate.js";

const VALIDADO = (n) => `CONTEUDO-VALIDADO-${n}\n`;
const FORA = (n) => `FORA-DA-RAIZ-NAO-VALIDADO-${n}\n`;
const NOMES = ["a", "b", "c"];

function ambiente(t) {
  const tmp = fs.realpathSync(os.tmpdir());
  const base = fs.mkdtempSync(path.join(tmp, "cs-toctou-base-"));
  const fixture = fs.mkdtempSync(path.join(tmp, "cs-toctou-fix-"));
  const corpus = path.join(fixture, "corpus");
  fs.mkdirSync(corpus);
  for (const n of NOMES) fs.writeFileSync(path.join(corpus, `${n}.txt`), VALIDADO(n));
  // A isca fica FORA da raiz de fixture: é o destino que a substituição alcança.
  const isca = path.join(base, "isca");
  fs.mkdirSync(isca);
  for (const n of NOMES) fs.writeFileSync(path.join(isca, `${n}.txt`), FORA(n));
  t.after(() => {
    for (const p of [base, fixture]) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
  });
  return { base, fixture, corpus, isca };
}

/** Liga a sessão de fixture no ambiente REAL do processo (o que o gate lê). */
function ligarFixture(t, fixture) {
  const guardado = {
    [FIXTURE_SCAN_FLAG]: process.env[FIXTURE_SCAN_FLAG],
    [FIXTURE_ROOT_ENV]: process.env[FIXTURE_ROOT_ENV],
  };
  process.env[FIXTURE_SCAN_FLAG] = "1";
  process.env[FIXTURE_ROOT_ENV] = fixture;
  t.after(() => {
    for (const [k, v] of Object.entries(guardado)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** Motor espião: registra exactamente o que foi pedido para analisar e o que leu. */
function motorEspiao(gancho) {
  const leituras = [];
  const motor = {
    emitScanProgress: () => {},
    isExcluded: () => {
      gancho?.("isExcluded");
      return false;
    },
    scanArtifact: async (ficheiro) => {
      let conteudo;
      let real = null;
      try {
        conteudo = fs.readFileSync(ficheiro, "utf8");
      } catch (e) {
        conteudo = `ERRO:${e.code}`;
      }
      try {
        real = fs.realpathSync(ficheiro);
      } catch {}
      leituras.push({ ficheiro, conteudo, real });
      return {
        results: [{ analysisState: "completed", verdict: "safe", severity: "low", rulesTriggered: [] }],
        highRiskCount: 0,
        overallSeverity: "low",
      };
    },
  };
  // Gancho alternativo no primeiro emit (corre ANTES do gather, depois da validação).
  if (gancho) {
    motor.emitScanProgress = () => {
      gancho("emitScanProgress");
    };
  }
  return { motor, leituras };
}

function servicoCom(scanManager) {
  return {
    handleRequest: async (req) => {
      if (req.method === "scan.start") {
        const id = await scanManager.startScan(req.payload?.type, req.payload?.targetPath);
        return { id: String(req.id ?? ""), type: "response", ok: true, result: { scanId: id } };
      }
      return { id: String(req.id ?? ""), type: "response", ok: true, result: null };
    },
    scanManager,
    quarantinePolicy: "warn",
  };
}

async function esperarTerminal(scanManager, id, timeoutMs = 15000) {
  const inicio = Date.now();
  for (;;) {
    const estado = scanManager.getLastScan(id);
    if (estado && ["completed", "failed", "cancelled"].includes(estado.status)) return estado;
    if (Date.now() - inicio > timeoutMs) throw new Error("o scan não chegou a terminal no tempo do teste");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function trocarPorJunction(corpus, isca) {
  fs.renameSync(corpus, `${corpus}-antigo`);
  fs.symlinkSync(isca, corpus, "junction");
}

function trocarPorPastaReal(corpus) {
  fs.renameSync(corpus, `${corpus}-antigo`);
  fs.mkdirSync(corpus);
  for (const n of NOMES) fs.writeFileSync(path.join(corpus, `${n}.txt`), FORA(n));
}

function dentroDaRaiz(real, raiz) {
  if (!real) return false;
  const rel = path.relative(path.resolve(raiz), path.resolve(real));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ————— 1) controlo positivo —————

test("fixture sem substituição: completa e analisa exactamente o corpus validado", async (t) => {
  const a = ambiente(t);
  ligarFixture(t, a.fixture);
  const { motor, leituras } = motorEspiao();
  const sm = new ScanManager(motor);
  const svc = servicoCom(sm);
  installDevFixtureGate(svc, process.env, () => {});

  const r = await svc.handleRequest({
    id: "c1",
    method: "scan.start",
    payload: { type: "custom", targetPath: a.corpus },
  });
  assert.equal(r.ok, true, "scan custom contido tem de ser aceite pelo gate");
  const estado = await esperarTerminal(sm, r.result.scanId);

  assert.equal(estado.status, "completed", `estado final: ${estado.status} (${estado.error ?? ""})`);
  assert.equal(estado.filesAnalyzed, 3, "os três ficheiros validados têm de ser analisados");
  assert.equal(leituras.length, 3);
  for (const leitura of leituras) {
    assert.ok(dentroDaRaiz(leitura.real, a.fixture), `leitura fora da raiz de fixture: ${leitura.real}`);
    assert.match(leitura.conteudo, /^CONTEUDO-VALIDADO-/, "só o conteúdo validado pode ser lido");
  }
});

// ————— 2) junction criada depois da validação, antes do gather —————

test("junction criada depois da validação: falha fechado, nada entregue ao motor", async (t) => {
  const a = ambiente(t);
  ligarFixture(t, a.fixture);
  let trocado = false;
  const { motor, leituras } = motorEspiao(() => {
    if (!trocado) {
      trocado = true;
      trocarPorJunction(a.corpus, a.isca);
    }
  });
  const sm = new ScanManager(motor);
  const svc = servicoCom(sm);
  installDevFixtureGate(svc, process.env, () => {});

  const r = await svc.handleRequest({
    id: "c2",
    method: "scan.start",
    payload: { type: "custom", targetPath: a.corpus },
  });
  assert.equal(r.ok, true, "a validação em si continua a aceitar o corpus original");
  const estado = await esperarTerminal(sm, r.result.scanId);

  assert.equal(estado.status, "failed", `substituição por junction tem de falhar fechado (obtido: ${estado.status})`);
  assert.match(String(estado.error ?? ""), new RegExp(GATE_CODE), "o motivo tem de trazer o código do gate");
  assert.equal(leituras.length, 0, "nenhum ficheiro do objecto substituído pode ir ao motor");
});

// ————— 3) alvo trocado por pasta real (sem links) —————

test("alvo trocado por pasta real depois da validação: falha fechado sem ler o novo objecto", async (t) => {
  const a = ambiente(t);
  ligarFixture(t, a.fixture);
  let trocado = false;
  const { motor, leituras } = motorEspiao(() => {
    if (!trocado) {
      trocado = true;
      trocarPorPastaReal(a.corpus);
    }
  });
  const sm = new ScanManager(motor);
  const svc = servicoCom(sm);
  installDevFixtureGate(svc, process.env, () => {});

  const r = await svc.handleRequest({
    id: "c3",
    method: "scan.start",
    payload: { type: "custom", targetPath: a.corpus },
  });
  const estado = await esperarTerminal(sm, r.result.scanId);

  assert.equal(
    estado.status,
    "failed",
    `pasta real substituída (mesmo caminho, objecto novo) tem de falhar fechado (obtido: ${estado.status})`,
  );
  assert.match(String(estado.error ?? ""), new RegExp(GATE_CODE));
  assert.equal(leituras.length, 0, "o novo objecto nunca pode ser entregue ao motor");
});

// ————— 4) substituição a meio do scan —————

test("substituição a meio: o SO recusa a troca e o motor só lê o corpus original", async (t) => {
  const a = ambiente(t);
  ligarFixture(t, a.fixture);
  let trocado = false;
  let recusado = false;
  const { motor, leituras } = motorEspiao((origem) => {
    if (origem === "isExcluded" && !trocado) {
      trocado = true;
      try { trocarPorJunction(a.corpus, a.isca); }
      catch (error) {
        assert.ok(["EBUSY", "EPERM", "EACCES"].includes(error.code));
        recusado = true;
      }
    }
  });
  const sm = new ScanManager(motor);
  const svc = servicoCom(sm);
  installDevFixtureGate(svc, process.env, () => {});

  const r = await svc.handleRequest({
    id: "c4",
    method: "scan.start",
    payload: { type: "custom", targetPath: a.corpus },
  });
  const estado = await esperarTerminal(sm, r.result.scanId);

  assert.equal(trocado, true);
  assert.equal(recusado, true, "O SO tem de impedir a substituição, não apenas detetá-la depois");
  assert.equal(estado.status, "completed", estado.error);
  assert.equal(estado.filesAnalyzed, 3);
  assert.equal(leituras.length, 3);
  for (const leitura of leituras) {
    assert.ok(dentroDaRaiz(leitura.real, a.fixture));
    assert.match(leitura.conteudo, /^CONTEUDO-VALIDADO-/);
  }
});

// ————— 5) startScan directo sem validação registada —————

test("startScan directo em modo fixture, sem validação: acesso dirigido bloqueado", async (t) => {
  const a = ambiente(t);
  ligarFixture(t, a.fixture);
  trocarPorJunction(a.corpus, a.isca); // substituição antes de qualquer validação
  const { motor, leituras } = motorEspiao();
  const sm = new ScanManager(motor);
  const svc = servicoCom(sm);
  installDevFixtureGate(svc, process.env, () => {});

  const id = await sm.startScan("custom", a.corpus);
  assert.ok(id, "o teste precisa de um scanId");
  const estado = await esperarTerminal(sm, id);

  assert.equal(estado.status, "failed", `sem validação registada não pode varrer (obtido: ${estado.status})`);
  assert.match(String(estado.error ?? ""), new RegExp(GATE_CODE));
  assert.equal(leituras.length, 0, "sem validação, ZERO ficheiros podem ir ao motor");
});

// ————— 6) junction dentro do corpus (não substitui o alvo) —————

test("junction dentro do corpus: nunca se lê fora da raiz de fixture", async (t) => {
  const a = ambiente(t);
  ligarFixture(t, a.fixture);
  let trocado = false;
  const { motor, leituras } = motorEspiao(() => {
    if (!trocado) {
      trocado = true;
      // Link INTERNO: o alvo continua o mesmo; só aparece um link novo dentro dele.
      fs.symlinkSync(a.isca, path.join(a.corpus, "link"), "junction");
    }
  });
  const sm = new ScanManager(motor);
  const svc = servicoCom(sm);
  installDevFixtureGate(svc, process.env, () => {});

  const r = await svc.handleRequest({
    id: "c6",
    method: "scan.start",
    payload: { type: "custom", targetPath: a.corpus },
  });
  const estado = await esperarTerminal(sm, r.result.scanId);

  assert.ok(
    ["completed", "failed"].includes(estado.status),
    `terminal honesto esperado, obtido ${estado.status}`,
  );
  if (estado.status === "failed") {
    assert.match(String(estado.error ?? ""), new RegExp(GATE_CODE), "falha tem de vir do gate, não de erro genérico");
  }
  for (const leitura of leituras) {
    assert.ok(
      dentroDaRaiz(leitura.real, a.fixture),
      `leitura atravessou a junction para fora da raiz: ${leitura.real}`,
    );
  }
});

// ————— 7) primitivas de identidade —————

test("validação captura identidade efectiva; recriação do mesmo caminho é detectada", async (t) => {
  const a = ambiente(t);
  const gate = await import("../dist/dev-fixture-gate.js");
  const decisao = gate.scanCustomContido(
    { type: "custom", targetPath: a.corpus },
    { root: a.fixture, real: fs.realpathSync(a.fixture) },
  );
  assert.equal(decisao.ok, true, decisao.motivo);
  assert.ok(decisao.snapshot, "a validação tem de capturar a identidade efectiva do alvo");

  const ficheiro = path.join(a.corpus, "a.txt");
  assert.equal(gate.identidadeAindaBate(decisao.snapshot, ficheiro), null, "ficheiro intacto bate a identidade");

  fs.rmSync(ficheiro);
  fs.writeFileSync(ficheiro, VALIDADO("a")); // mesmo caminho, mesmo conteúdo, objecto NOVO
  assert.ok(
    gate.identidadeAindaBate(decisao.snapshot, ficheiro),
    "objecto recriado no mesmo caminho tem de ser detectado (identidade, não conteúdo)",
  );
});
