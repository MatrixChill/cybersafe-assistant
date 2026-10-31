/**
 * 7H — FRONTEIRA TERMINAL USB (integração REAL: runtime + monitor + adapter + ScanManager).
 *
 * Fronteira em causa: o desfecho terminal de uma análise USB era aplicado pelo
 * runtime ANTES da enumeração fresca. Se o dispositivo saísse DURANTE a
 * análise, o ScanManager terminava em `completed` (estado + histórico) enquanto
 * o snapshot USB ficava `incomplete` — o GLOBAL afirmava uma análise completa de
 * um dispositivo que já não estava lá.
 *
 * Correção (USB-scoped): o adapter USB injeta no ScanManager um callback de
 * CONFIRMAÇÃO TERMINAL que corre ANTES de o scan declarar `completed`. A prova é
 * uma ENUMERAÇÃO FRESCA (o detetor existente) que confirme a MESMA identidade na
 * MESMA raiz — existir o caminho não chega. Ausente / trocado / instável / erro
 * ⇒ terminal SEGURO (`failed` com motivo PT-PT), nunca `completed` nem no
 * histórico. Um scan normal (sem callback) mantém o terminal como antes, e um
 * cancelamento que chegue durante a confirmação NÃO é sobrescrito.
 *
 * O que este ficheiro NÃO duplica (já provado nos R8 existentes):
 *  - `r8-usb-monitor.test.js` — monitor isolado; `r8-usb-runtime.test.js` —
 *    runtime+monitor+adapter com uma PORTA falsa de ScanManager;
 *  - `r8-usb-adapter.test.js` — adapter+ScanManager real, mas com o cancelamento
 *    chamado À MÃO, não detetado pelo poll.
 *
 * Isolamento: só o DETETOR é falso (a presença é o que o teste controla); o
 * motor é um duplo LENTO com o contrato real do ScanManager. Sem PowerShell,
 * sem CIM, sem USB, sem rede. REGRA DESTA JANELA: não se apaga nada — a fixture
 * fica em TEMP e a "remoção" é simulada SÓ no detetor.
 *
 * Uso: node --test packages/service/test/7h-usb-terminal-confirmation.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Importados do BUILD (como os restantes testes de serviço): os módulos do
// src importam-se entre si com extensão `.js` (tsc/ESM) e o type-stripping do
// Node não reescreve especificadores. Nenhum build é corrido por este teste.
import { ScanManager } from "../dist/scan-manager.js";
import { ScanHistory } from "../dist/scan-history.js";
import { UsbConfigStore, UsbProtectionMonitor } from "../dist/usb-protection.js";
import { UsbReadOnlyScanAdapter, USB_READONLY_CONTRATO, criarConfirmacaoPresencaUsb } from "../dist/usb-scan-adapter.js";
import { UsbProtectionRuntime, caminhoConfigUsb } from "../dist/usb-protection-runtime.js";

const T0 = new Date("2026-10-13T18:00:00.000Z");
const ID = "pen-1";

function dispositivo(id, rootPath, extra = {}) {
  return { id, rootPath, rootPaths: [rootPath], identityProvenance: "disk-serial", ...extra };
}

/**
 * Detetor fake controlado: o teste define a presença. `atual` pode ser uma
 * lista, um `Error` (enumerador falha) ou uma função (usada para segurar a
 * confirmação e provar que um cancelamento a meio não é sobrescrito).
 */
function deteccaoMutavel(inicial = []) {
  const porta = {
    leituras: 0,
    atual: inicial,
    definir(proximo) {
      porta.atual = proximo;
    },
    listar: async () => {
      porta.leituras += 1;
      const atual = porta.atual;
      if (atual instanceof Error) throw atual;
      return typeof atual === "function" ? atual() : atual;
    },
  };
  return porta;
}

/**
 * Duplo LENTO do motor: cumpre o contrato que o ScanManager exige e regista o
 * caminho de cada ficheiro pedido — é o sinal de "a análise está mesmo a
 * decorrer" (as alterações do detetor são injetadas depois disso).
 */
function motorLento({ atrasoMs, aoAnalisar } = {}) {
  const chamadas = [];
  return {
    chamadas,
    scanArtifact: async (file, source, options) => {
      chamadas.push({ file, source, options });
      aoAnalisar?.(file);
      if (atrasoMs > 0) await new Promise((resolve) => setTimeout(resolve, atrasoMs));
      return {
        results: [],
        totalFiles: 1,
        highRiskCount: 0,
        overallSeverity: "low",
        rulesTriggered: [],
        riskScore: 0,
      };
    },
    emitScanProgress: () => {},
    isExcluded: () => false,
    prefetchClamav: async () => ({ spawned: false }),
    clearClamavPrefetch: () => {},
  };
}

async function esperar(cond, mensagem, timeoutMs = 15_000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout à espera de: ${mensagem}`);
}

async function esperarTerminal(manager, id, timeoutMs = 20_000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const estado = manager.getScan(id);
    if (estado && ["completed", "cancelled", "failed"].includes(estado.status)) return estado;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("o scan não chegou a estado terminal dentro do tempo");
}

/** O histórico é escrito de forma assíncrona: espera-se pela linha do scanId. */
async function linhasDoScan(arquivo, scanId, timeoutMs = 5_000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const bruto = await fs.readFile(arquivo, "utf8").catch(() => "");
    const linhas = bruto
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((linha) => {
        try {
          return JSON.parse(linha);
        } catch {
          return null;
        }
      })
      .filter((entrada) => entrada && entrada.id === scanId);
    if (linhas.length > 0) return linhas;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

const estado = (snapshot, id) => snapshot.devices.find((d) => d.id === id);

/** Cria uma raiz temporária com N ficheiros (nunca apagada nesta janela). */
async function criarRaiz(ficheiros) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cs-7h-usb-terminal-"));
  const raiz = path.join(base, "pen");
  await fs.mkdir(raiz, { recursive: true });
  for (let i = 0; i < ficheiros; i += 1) {
    await fs.writeFile(path.join(raiz, `f-${String(i).padStart(2, "0")}.txt`), `conteudo ${i}`);
  }
  return { base, raiz };
}

/**
 * Cenário real: ScanManager real com histórico persistido, adapter real (com a
 * porta de confirmação ligada ao detetor), monitor real e runtime real. Só o
 * detetor é falso. O poll automático fica fora do caminho (intervalo longo) e o
 * teste conduz cada ciclo à mão, para controlar QUANDO o poll observa.
 */
async function cenario({ ficheiros = 14, atrasoMs = 30, intervaloMs = 60_000 } = {}) {
  const { base, raiz } = await criarRaiz(ficheiros);
  const historico = path.join(base, "scans.jsonl");
  const analisados = [];
  const engine = motorLento({ atrasoMs, aoAnalisar: (ficheiro) => analisados.push(path.basename(ficheiro)) });
  const manager = new ScanManager(engine, new ScanHistory(historico));
  const deteccao = deteccaoMutavel([]);
  const adapter = new UsbReadOnlyScanAdapter({
    scans: {
      startScan: (type, targetPath, options) => manager.startScan(type, targetPath, options),
      cancelScan: (id) => manager.cancelScan(id),
      getScan: (id) => manager.getScan(id),
    },
    capacidade: () => ({ ...USB_READONLY_CONTRATO }),
    confirmarPresenca: criarConfirmacaoPresencaUsb(deteccao),
  });
  const store = new UsbConfigStore(caminhoConfigUsb(base));
  await store.guardar({ version: 1, enabled: true, updatedAt: T0.toISOString() }, null);
  const monitor = new UsbProtectionMonitor({
    deteccao,
    store,
    analise: adapter,
    readOnly: adapter,
    agora: () => T0,
  });
  const runtime = new UsbProtectionRuntime({
    baseDir: base,
    monitor,
    estadoDoScan: (scanId) => manager.getScan(scanId),
    verificarCapacidade: () => adapter.verificar(),
    intervaloMs,
  });

  return { base, raiz, historico, engine, analisados, manager, adapter, deteccao, store, monitor, runtime };
}

/** Arranca o scan USB pela via real (runtime → monitor → adapter → ScanManager). */
async function arrancarScanUsb(cenarioUsb) {
  await cenarioUsb.runtime.iniciar();
  cenarioUsb.deteccao.definir([dispositivo(ID, cenarioUsb.raiz)]);
  const snapshot = await cenarioUsb.runtime.ciclo();
  const scanId = estado(snapshot, ID)?.scanId;
  assert.ok(scanId, "o scan USB tem de arrancar com o ScanManager real");
  await esperar(() => cenarioUsb.analisados.length >= 1, "o primeiro ficheiro a ser analisado");
  return scanId;
}

test("integração real: remoção detetada pelo POLL durante a análise ⇒ ScanManager fica cancelled (estado E histórico), nunca completed", async (t) => {
  const c = await cenario();
  const scanId = await arrancarScanUsb(c);
  const loop = c.manager.currentScanPromise;

  // Remoção DURANTE a análise: o dispositivo sai enquanto o scan ainda corre.
  assert.equal(c.manager.getScan(scanId).status, "running", "o scan tem de estar mesmo a correr quando o dispositivo sai");
  c.deteccao.definir([]);

  // O poll seguinte observa a ausência e cancela a análise própria deste módulo.
  const removido = await c.runtime.ciclo();
  assert.deepEqual(c.adapter.analisesAtivas(), [], "o adapter deixa de ter a análise USB por correr");

  const estadoGlobal = await esperarTerminal(c.manager, scanId);
  await loop; // drena o loop antes de concluir (nenhum trabalho fica pendente)
  assert.equal(estadoGlobal.status, "cancelled", "remoção durante a análise ⇒ o scan global é cancelado");
  assert.notEqual(estadoGlobal.status, "completed");

  const doScan = await linhasDoScan(c.historico, scanId);
  assert.ok(doScan.length > 0, "o scan tem de aparecer no histórico persistido");
  assert.equal(doScan.some((linha) => linha.status === "completed"), false, "o histórico não pode guardar completed");
  assert.equal(doScan.at(-1).status, "cancelled", `estado terminal no histórico devia ser cancelled (veio ${doScan.at(-1).status})`);

  const item = estado(removido, ID);
  assert.equal(item.present, false);
  assert.equal(item.status, "incomplete", "remoção apanhada a meio deixa a análise por confirmar");
  assert.equal(item.result, undefined, "nenhum resultado publicado sem confirmação fresca");
  assert.notEqual(item.status, "completed");
  assert.equal(c.manager.currentScanPromise, null, "o loop drenou antes do fim do teste");

  await c.runtime.dispose();
});

test("controlo positivo: dispositivo sempre presente ⇒ análise global completed e resultado USB publicado após enumeração fresca", async (t) => {
  const c = await cenario();
  const scanId = await arrancarScanUsb(c);

  const estadoGlobal = await esperarTerminal(c.manager, scanId);
  await c.manager.currentScanPromise;
  assert.equal(estadoGlobal.status, "completed", "com o dispositivo sempre presente a análise conclui");

  const publicado = await c.runtime.ciclo();
  const item = estado(publicado, ID);
  assert.equal(item.status, "completed", "a enumeração fresca posterior confirma e publica o desfecho");
  assert.equal(item.present, true);
  assert.equal(item.result?.status, "completed");
  assert.equal(item.limitation, undefined);

  const doScan = await linhasDoScan(c.historico, scanId);
  assert.equal(doScan.at(-1).status, "completed");

  await c.runtime.dispose();
});

test("FRONTEIRA (GREEN após fix): dispositivo ausente ANTES de o scan terminar ⇒ global/histórico NÃO ficam completed", async (t) => {
  const c = await cenario();
  const scanId = await arrancarScanUsb(c);
  const loop = c.manager.currentScanPromise;

  // A identidade sai DURANTE a análise, e não se corre nenhum poll enquanto o
  // scan ainda corre: sem o fix, o loop terminaria em `completed`.
  assert.equal(c.manager.getScan(scanId).status, "running", "o scan tem de estar a correr quando o dispositivo sai");
  c.deteccao.definir([]);

  const estadoGlobal = await esperarTerminal(c.manager, scanId);
  await loop;
  const doScan = await linhasDoScan(c.historico, scanId);
  t.diagnostic(`observado (global) estado=${estadoGlobal.status} filesScanned=${estadoGlobal.filesScanned} error=${estadoGlobal.error ?? "-"}`);
  t.diagnostic(`observado (histórico) status=${doScan.map((linha) => linha.status).join(",") || "(vazio)"}`);

  assert.equal(estadoGlobal.status, "failed", "sem confirmação de presença o terminal tem de ser seguro");
  assert.notEqual(estadoGlobal.status, "completed");
  assert.match(estadoGlobal.error ?? "", /ausente/i, "o motivo tem de dizer que a identidade não foi confirmada");
  assert.equal(doScan.some((linha) => linha.status === "completed"), false, "o histórico persistido não pode guardar completed");
  assert.equal(doScan.at(-1).status, "failed");

  // O único poll corre depois do terminal: o dispositivo está mesmo ausente.
  const depois = await c.runtime.ciclo();
  const item = estado(depois, ID);
  t.diagnostic(`observado (USB) status=${item?.status} present=${item?.present} result=${item?.result ? "presente" : "ausente"}`);
  assert.equal(item.present, false);
  assert.equal(item.result, undefined, "invariante: `result` só existe com `completed`");
  assert.notEqual(item.status, "completed");
  assert.equal(item.status, "removed", "sem resultado retido para publicar, o dispositivo sai da lista de presentes");

  await c.runtime.dispose();
});

test("mismatch na MESMA letra (identidade diferente): confirmação recusa ⇒ nunca completed", async (t) => {
  const c = await cenario();
  const scanId = await arrancarScanUsb(c);
  const loop = c.manager.currentScanPromise;

  // A MESMA raiz passa a ter OUTRA identidade: a letra foi reutilizada, por isso
  // "o caminho existe" não pode valer como confirmação.
  c.deteccao.definir([dispositivo("outro-id", c.raiz)]);
  const estadoGlobal = await esperarTerminal(c.manager, scanId);
  await loop;
  t.diagnostic(`mismatch: estado=${estadoGlobal.status} error=${estadoGlobal.error ?? "-"}`);

  assert.equal(estadoGlobal.status, "failed");
  assert.notEqual(estadoGlobal.status, "completed");
  assert.match(estadoGlobal.error ?? "", /ausente|não confirmada/i);
  const doScan = await linhasDoScan(c.historico, scanId);
  assert.equal(doScan.some((linha) => linha.status === "completed"), false);

  await c.runtime.dispose();
});

test("enumerador falha no fim da análise: erro ⇒ terminal seguro, nunca completed", async (t) => {
  const c = await cenario();
  const scanId = await arrancarScanUsb(c);
  const loop = c.manager.currentScanPromise;

  c.deteccao.definir(new Error("CIM timeout"));
  const estadoGlobal = await esperarTerminal(c.manager, scanId);
  await loop;
  t.diagnostic(`enumerador falhou: estado=${estadoGlobal.status} error=${estadoGlobal.error ?? "-"}`);

  assert.equal(estadoGlobal.status, "failed");
  assert.notEqual(estadoGlobal.status, "completed");
  assert.match(estadoGlobal.error ?? "", /falhou/i);
  const doScan = await linhasDoScan(c.historico, scanId);
  assert.equal(doScan.some((linha) => linha.status === "completed"), false);

  await c.runtime.dispose();
});

test("cancelamento DURANTE a confirmação: o terminal `cancelled` não é sobrescrito", async (t) => {
  const c = await cenario();
  const scanId = await arrancarScanUsb(c);
  const loop = c.manager.currentScanPromise;

  // A confirmação fica presa numa enumeração: dá tempo para cancelar a MEIO.
  let liberar;
  let bloqueou = false;
  c.deteccao.definir(() => {
    if (!bloqueou) {
      bloqueou = true;
      return new Promise((resolve) => {
        liberar = () => resolve([dispositivo(ID, c.raiz)]);
      });
    }
    return [dispositivo(ID, c.raiz)];
  });

  await esperar(() => bloqueou, "a confirmação terminal a começar");
  assert.equal(c.manager.getScan(scanId).status, "running", "o scan ainda não é terminal enquanto confirma");
  c.manager.cancelScan(scanId);
  assert.equal(c.manager.getScan(scanId).status, "cancelled", "o cancelamento é imediato");
  liberar(); // a confirmação responde DEPOIS de o cancelamento já ter acontecido

  await loop;
  const estadoGlobal = c.manager.getScan(scanId);
  t.diagnostic(`cancelamento durante validação: estado=${estadoGlobal.status}`);
  assert.equal(estadoGlobal.status, "cancelled", "o cancelamento durante a validação não pode ser sobrescrito");
  assert.notEqual(estadoGlobal.status, "completed");
  assert.notEqual(estadoGlobal.status, "failed");
  const doScan = await linhasDoScan(c.historico, scanId);
  assert.equal(doScan.some((linha) => linha.status === "completed"), false);
  assert.equal(doScan.at(-1).status, "cancelled");

  await c.runtime.dispose();
});

test("controlo custom normal (sem callback): o terminal mantém-se completed", async (t) => {
  const { base, raiz } = await criarRaiz(4);
  const historico = path.join(base, "scans.jsonl");
  const manager = new ScanManager(motorLento({ atrasoMs: 2 }), new ScanHistory(historico));

  const id = await manager.startScan("custom", raiz);
  assert.ok(id, "um scan custom normal arranca");
  const estadoGlobal = await esperarTerminal(manager, id);
  await manager.currentScanPromise;

  t.diagnostic(`custom normal: estado=${estadoGlobal.status} filesScanned=${estadoGlobal.filesScanned} error=${estadoGlobal.error ?? "-"}`);
  assert.equal(estadoGlobal.status, "completed", "sem callback o comportamento do scan custom não muda");
  assert.equal(estadoGlobal.error, undefined);
  const doScan = await linhasDoScan(historico, id);
  assert.equal(doScan.at(-1).status, "completed");
});
