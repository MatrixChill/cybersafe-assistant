/**
 * P0 USB — CICLO DE VIDA DA ANÁLISE MANUAL (`usb.scan`/`usb.cancel`) no serviço.
 *
 * Bug confirmado por leitura (15/10/2026): `UsbProtectionRuntime.executarScanManual`
 * chama `analise.iniciar(...)` e guarda o `scanId` no mapa interno `manuais`, mas
 * NUNCA liga essa análise ao lifecycle do monitor. Consequências medidas no código:
 *   - `runtime.snapshot()` devolve só `monitor.snapshot()` ⇒ o dispositivo nunca
 *     aparece `scanning` e nunca publica `scanId` (a UI correlaciona progresso e
 *     cancel EXCLUSIVAMENTE por `device.scanId`/`device.status`);
 *   - `alimentarResultados()` só itera dispositivos `scanning` com `scanId` ⇒ o
 *     desfecho real (completed/cancelled/failed) da análise manual NUNCA chega ao
 *     monitor (nem é publicado com resultado);
 *   - a remoção a meio não cancela nada, porque o cancelamento por remoção usa o
 *     `scanId` do ESTADO do monitor, que estava a `undefined`.
 *
 * Estes testes são RED contra o código anterior e fixam o contrato novo:
 * gesto consentido ⇒ `scanning` + `scanId` no snapshot; cancel com os DOIS ids do
 * snapshot; desfecho terminal real publicado (completed só com confirmação fresca);
 * remoção cancela e nunca publica `completed`; reinserção não herda nada; o
 * auto-scan continua DESLIGADO pelo gesto manual e nenhuma análise fica invisível.
 *
 * Uso: node --test packages/service/test/delivery15-usb-lifecycle.test.js
 * (depende de `npm run build -w @cybersafe/service`, como os restantes testes do serviço)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { UsbConfigStore, UsbProtectionMonitor } from "../dist/usb-protection.js";
import { UsbReadOnlyScanAdapter, USB_READONLY_CONTRATO } from "../dist/usb-scan-adapter.js";
import { UsbProtectionRuntime, caminhoConfigUsb } from "../dist/usb-protection-runtime.js";

const T0 = new Date("2026-10-15T09:00:00.000Z");

function dispositivo(id, rootPath, extra = {}) {
  return { id, rootPath, rootPaths: [rootPath], identityProvenance: "disk-serial", ...extra };
}

function deteccaoMutavel(inicial = []) {
  const porta = {
    leituras: 0,
    atual: inicial,
    pendentes: [],
    definir(proximo) {
      porta.atual = proximo;
    },
    listar: async () => {
      porta.leituras += 1;
      return porta.atual;
    },
    listarPendentes: async () => porta.pendentes,
  };
  return porta;
}

/**
 * Porta de análise controlável: prova os desfechos do cancelamento (falhou,
 * pedido sem terminal, terminal real) sem depender do adapter real.
 */
function portaAnaliseControlada({ cancelarLanca = false, cancelarPendente = false } = {}) {
  const iniciados = [];
  const cancelados = [];
  const estado = new Map();
  let contador = 0;
  return {
    iniciados,
    cancelados,
    estado,
    iniciar: async (alvo) => {
      const raiz = typeof alvo?.rootPath === "string" ? alvo.rootPath.trim() : "";
      if (raiz === "") throw new Error("alvo USB sem raiz confirmada: análise recusada");
      contador += 1;
      const scanId = `scan-manual-${contador}`;
      iniciados.push({ id: scanId, rootPath: raiz });
      estado.set(scanId, { id: scanId, status: "running" });
      return { scanId };
    },
    cancelar: async (scanId) => {
      cancelados.push(scanId);
      if (cancelarLanca) throw new Error("motor recusou o cancelamento");
      if (!cancelarPendente) estado.set(scanId, { id: scanId, status: "cancelled" });
    },
    /** Prova de read-only na forma do contrato do monitor (`{ ok }`). */
    verificar: () => ({ ok: true }),
  };
}

/** Ponto de partida do ramo de recusa: o monitor passa a ter análise VIVA no
 *  MESMO dispositivo durante a enumeração fresca do gesto (corrida real). */
async function comRecusaNoRegisto(t, { cancelarLanca = false, cancelarPendente = false } = {}) {
  const porta = portaAnaliseControlada({ cancelarLanca, cancelarPendente });
  const pecas = await cenario(t, {
    enabled: true,
    analiseManualAtiva: () => true,
    portaAnalise: porta,
    enumerarHook: async (monitor) => {
      await monitor.ciclo();
    },
  });
  await pecas.runtime.iniciar();
  pecas.deteccao.definir([dispositivo("pen-1", "E:\\")]);
  return { ...pecas, porta };
}

/** Porta de ScanManager (a única peça substituída): estados reais por scanId. */
function scanManagerFalso({ cancelPendente = false } = {}) {
  const iniciados = [];
  const cancelados = [];
  const estados = new Map();
  let contador = 0;
  return {
    iniciados,
    cancelados,
    estados,
    concluir(scanId, status = "completed") {
      estados.set(scanId, { id: scanId, status });
    },
    startScan: async (type, targetPath, options) => {
      contador += 1;
      const id = `scan-${contador}`;
      estados.set(id, { id, status: "running" });
      iniciados.push({ id, type, targetPath, options });
      return id;
    },
    cancelScan: (id) => {
      cancelados.push(id);
      // Cancelamento PENDENTE: o motor ainda não confirmou terminal nenhum.
      if (!cancelPendente) estados.set(id, { id, status: "cancelled" });
    },
    getScan: (id) => estados.get(id),
  };
}

async function cenario(
  t,
  {
    enabled = false,
    capacidade = () => ({ ...USB_READONLY_CONTRATO }),
    analiseManualAtiva = () => false,
    cancelPendente = false,
    portaAnalise = null,
    enumerarHook = null,
  } = {},
) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-usb-lifecycle-"));
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  const deteccao = deteccaoMutavel([]);
  const scans = scanManagerFalso({ cancelPendente });
  const adapter = new UsbReadOnlyScanAdapter({
    scans: {
      startScan: (type, targetPath, options) => scans.startScan(type, targetPath, options),
      cancelScan: (id) => scans.cancelScan(id),
      getScan: (id) => scans.getScan(id),
    },
    capacidade,
  });
  const store = new UsbConfigStore(caminhoConfigUsb(baseDir));
  if (enabled) {
    await store.guardar({ version: 1, enabled: true, updatedAt: T0.toISOString() }, null);
  }
  const analisePorta = portaAnalise ?? adapter;
  const monitor = new UsbProtectionMonitor({
    deteccao,
    store,
    analise: analisePorta,
    readOnly: analisePorta,
    analiseManualAtiva,
    agora: () => T0,
  });
  let hookExecutado = false;
  const runtime = new UsbProtectionRuntime({
    baseDir,
    monitor,
    estadoDoScan: (scanId) => portaAnalise?.estado?.get(scanId) ?? scans.getScan(scanId),
    verificarCapacidade: () => analisePorta.verificar(),
    analise: analisePorta,
    enumerar: async () => {
      if (enumerarHook && !hookExecutado) {
        hookExecutado = true;
        await enumerarHook(monitor);
      }
      return deteccao.listar();
    },
    slotOcupado: () => scans.getScan("scan-ativo") !== undefined,
    agora: () => T0.getTime(),
    intervaloMs: 10,
  });
  return { deteccao, scans, adapter, analisePorta, monitor, runtime };
}

const estado = (snapshot, id) => snapshot.devices.find((d) => d.id === id);

/** Estado base do cenário: pen conhecida pelo monitor e gesto consentido. */
async function comGestoManual(t, opcoes = {}) {
  const pecas = await cenario(t, opcoes);
  await pecas.runtime.iniciar();
  pecas.deteccao.definir([dispositivo("pen-1", "E:\\")]);
  await pecas.runtime.ciclo();
  const resultado = await pecas.runtime.scan({ deviceId: "pen-1", requestId: "gesto-1", consent: true });
  return { ...pecas, resultado };
}

test("P0: gesto manual consentido com opt-in OFF publica scanning + scanId no snapshot", async (t) => {
  const { runtime, scans, resultado } = await comGestoManual(t, { enabled: false });

  assert.deepEqual(resultado, { ok: true, deviceId: "pen-1", scanId: "scan-1" });
  const dispositivoAtual = estado(runtime.snapshot(), "pen-1");
  assert.ok(dispositivoAtual, "o dispositivo analisado desapareceu do snapshot");
  assert.equal(dispositivoAtual.status, "scanning", "a análise manual tem de aparecer em curso no estado publicado");
  assert.equal(dispositivoAtual.scanId, resultado.scanId, "o scanId publicado tem de ser o REAL devolvido pelo gesto");
  assert.equal(dispositivoAtual.present, true);
  assert.equal(runtime.snapshot().enabled, false, "o gesto manual NÃO pode ligar o auto-scan/opt-in");
  assert.deepEqual(scans.iniciados, [
    { id: "scan-1", type: "custom", targetPath: "E:\\", options: { readOnly: true } },
  ]);
  await runtime.dispose();
});

test("P0: cancelar com os ids do snapshot leva a análise a terminal honesto, sem resultado", async (t) => {
  const { runtime, scans } = await comGestoManual(t);
  const atual = estado(runtime.snapshot(), "pen-1");

  const cancelado = await runtime.cancel({ deviceId: atual.id, scanId: atual.scanId });

  assert.deepEqual(cancelado, { ok: true });
  assert.deepEqual(scans.cancelados, [atual.scanId], "o cancelamento chega ao ScanManager pelo adapter read-only");

  const depois = await runtime.ciclo();
  const dispositivoDepois = estado(depois, "pen-1");
  assert.equal(dispositivoDepois.status, "cancelled", "o desfecho real do ScanManager tem de ser publicado");
  assert.equal(dispositivoDepois.result, undefined, "uma análise cancelada nunca publica resultado");
  await runtime.dispose();
});

test("P0: desfecho completed é publicado com o resultado REAL após enumeração fresca", async (t) => {
  const { runtime, scans } = await comGestoManual(t);

  // O ScanManager conclui a análise: antes de haver ciclo, nada foi publicado.
  scans.concluir("scan-1", "completed");
  assert.equal(estado(runtime.snapshot(), "pen-1").result, undefined, "sem confirmação fresca não há publicação");

  const confirmado = await runtime.ciclo();
  const dispositivoConfirmado = estado(confirmado, "pen-1");
  assert.equal(dispositivoConfirmado.status, "completed");
  assert.equal(dispositivoConfirmado.result.status, "completed", "o resultado publicado é o do scan real");
  // O id da análise que produziu o resultado fica registado (comportamento igual
  // ao do auto-scan). A UI só correlaciona progresso/cancel com o estado
  // `scanning`, por isso um id terminal não é accionável.
  assert.equal(dispositivoConfirmado.scanId, "scan-1");
  const cancelarTerminal = await runtime.cancel({ deviceId: "pen-1", scanId: "scan-1" });
  assert.equal(cancelarTerminal.ok, false, "uma análise já terminal não se cancela");
  await runtime.dispose();
});

test("P0: remoção a meio cancela a análise manual e NUNCA publica completed", async (t) => {
  const { runtime, scans, deteccao } = await comGestoManual(t);

  deteccao.definir([]);
  const removido = await runtime.ciclo();
  const dispositivoRemovido = estado(removido, "pen-1");

  assert.deepEqual(scans.cancelados, ["scan-1"], "a remoção cancela exactamente o scan manual deste dispositivo");
  assert.equal(dispositivoRemovido.present, false);
  assert.notEqual(dispositivoRemovido.status, "completed", "pen removida a meio não pode aparecer concluída");
  assert.equal(dispositivoRemovido.result, undefined);
  await runtime.dispose();
});

test("P0: reinserção depois da remoção não herda scanId nem resultado", async (t) => {
  const { runtime, scans, deteccao } = await comGestoManual(t);

  deteccao.definir([]);
  await runtime.ciclo();
  deteccao.definir([dispositivo("pen-1", "E:\\")]);
  const reinserido = await runtime.ciclo();
  const dispositivoReinserido = estado(reinserido, "pen-1");

  assert.equal(dispositivoReinserido.present, true);
  assert.equal(dispositivoReinserido.scanId, undefined, "a reinserção é uma inserção NOVA: nada de scanId herdado");
  assert.equal(dispositivoReinserido.result, undefined);
  assert.notEqual(dispositivoReinserido.status, "scanning");
  assert.equal(scans.iniciados.length, 1, "a reinserção com opt-in OFF não arranca análise nenhuma");
  await runtime.dispose();
});

test("P0: com auto-scan LIGADO, a análise manual ocupa o slot — nenhuma outra inserção arranca sozinha", async (t) => {
  const { runtime, scans, deteccao } = await cenario(t, { enabled: true });
  // pen-1 JÁ estava presente no arranque: entra no baseline e não é
  // autoanalisada. A única análise da cena é a do gesto manual.
  deteccao.definir([dispositivo("pen-1", "E:\\")]);
  await runtime.iniciar();
  await runtime.ciclo();
  assert.deepEqual(scans.iniciados, [], "baseline: a pen presente no arranque não arranca sozinha");

  const gesto = await runtime.scan({ deviceId: "pen-1", requestId: "gesto-1", consent: true });
  assert.equal(gesto.ok, true);
  assert.equal(scans.iniciados.length, 1, "só o gesto manual arrancou análise");

  deteccao.definir([dispositivo("pen-1", "E:\\"), dispositivo("pen-2", "F:\\")]);
  const comOutra = await runtime.ciclo();
  const segunda = estado(comOutra, "pen-2");

  assert.equal(segunda.status, "queued", "com o slot ocupado pela análise manual, a inserção nova espera declarada");
  assert.match(segunda.limitation, /em curso|fila/i);
  assert.equal(scans.iniciados.length, 1, "a inserção nova NÃO arranca com a análise manual a correr");
  assert.equal(estado(comOutra, "pen-1").status, "scanning");
  await runtime.dispose();
});

test("P0: idempotência mantida — o MESMO gesto não abre segunda sessão nem duplica estado", async (t) => {
  const { runtime, scans, monitor, monitor: semUso } = await comGestoManual(t);
  void semUso;

  const repetido = await runtime.scan({ deviceId: "pen-1", requestId: "gesto-1", consent: true });
  assert.deepEqual(repetido, { ok: true, deviceId: "pen-1", scanId: "scan-1" });
  assert.equal(scans.iniciados.length, 1, "retry do mesmo pedido reutiliza a sessão");

  const emCurso = monitor.snapshot().devices.filter((d) => d.id === "pen-1");
  assert.equal(emCurso.length, 1, "o dispositivo não pode aparecer duas vezes no snapshot");
  assert.equal(emCurso[0].status, "scanning");

  // Registo directo repetido: recusa explícita, sem inventar estado nem trocar o scanId.
  const segundoRegisto = monitor.registarAnaliseManual({ id: "pen-1", scanId: "scan-999", rootPath: "E:\\", rootPaths: ["E:\\"] });
  assert.deepEqual(segundoRegisto, { ok: false, motivo: "analise-viva" }, "uma análise viva não pode ser substituída por registo directo");
  assert.equal(estado(monitor.snapshot(), "pen-1").scanId, "scan-1");
  await runtime.dispose();
});

test("P0: gesto antes do primeiro ciclo — dispositivo adoptado com dados MEDIDOS e visível em curso", async (t) => {
  const { runtime, scans, deteccao } = await cenario(t);
  await runtime.iniciar();
  // Enumeração fresca conhece a pen, mas o monitor ainda não fez ciclo nenhum.
  deteccao.definir([dispositivo("pen-1", "E:\\")]);

  const resultado = await runtime.scan({ deviceId: "pen-1", requestId: "gesto-1", consent: true });

  assert.deepEqual(resultado, { ok: true, deviceId: "pen-1", scanId: "scan-1" });
  const publicado = estado(runtime.snapshot(), "pen-1");
  assert.ok(publicado, "nenhuma análise pode ficar invisível no estado publicado");
  assert.equal(publicado.status, "scanning");
  assert.equal(publicado.scanId, "scan-1");
  assert.equal(publicado.rootPath, "E:\\", "a raiz adoptada é a MEDIDA pela enumeração fresca");
  assert.equal(publicado.present, true);
  assert.deepEqual(scans.cancelados, [], "não há nada para desfazer: a análise entrou no ciclo de vida");
  await runtime.dispose();
});

test("P0: cancelamento PENDENTE não é terminal — continua em curso e aceita repetição", async (t) => {
  const { runtime, scans } = await comGestoManual(t, { cancelPendente: true });

  const primeiro = await runtime.cancel({ deviceId: "pen-1", scanId: "scan-1" });
  assert.deepEqual(primeiro, { ok: true });
  const pendente = estado(runtime.snapshot(), "pen-1");
  assert.equal(pendente.status, "scanning", "cancel pendente não pode ser publicado como desfecho terminal");
  assert.equal(pendente.scanId, "scan-1");
  assert.equal(pendente.result, undefined);

  const repetido = await runtime.cancel({ deviceId: "pen-1", scanId: "scan-1" });
  assert.deepEqual(repetido, { ok: true }, "enquanto não há terminal, repetir o cancelamento é aceite");
  assert.deepEqual(scans.cancelados, ["scan-1", "scan-1"]);

  // O motor confirma o terminal: agora sim é publicado, pelo caminho real.
  scans.concluir("scan-1", "cancelled");
  const terminal = await runtime.ciclo();
  assert.equal(estado(terminal, "pen-1").status, "cancelled");
  assert.equal(estado(terminal, "pen-1").result, undefined);
  await runtime.dispose();
});

test("P0: dispositivo em fila não aceita segundo pedido — a análise arrancada é desfeita, sem sobrepor sessões", async (t) => {
  let manualAtiva = true;
  const { runtime, scans, deteccao } = await cenario(t, {
    enabled: true,
    analiseManualAtiva: () => manualAtiva,
  });
  await runtime.iniciar();
  // Inserção NOVA (chega depois do baseline) com uma análise global já em
  // curso: o monitor declara a espera na fila em vez de arrancar.
  deteccao.definir([dispositivo("pen-1", "E:\\")]);
  await runtime.ciclo();
  assert.equal(estado(runtime.snapshot(), "pen-1").status, "queued", "com análise global em curso a inserção espera na fila");

  manualAtiva = false;
  const resultado = await runtime.scan({ deviceId: "pen-1", requestId: "gesto-1", consent: true });

  assert.equal(resultado.ok, false, "não se sobrepõe uma análise a uma sessão já em curso");
  assert.match(resultado.error, /em curso/i);
  assert.deepEqual(scans.iniciados, [], "a recusa acontece ANTES de arrancar: não se ocupa o slot global por nada");
  assert.deepEqual(scans.cancelados, [], "não há nada para desfazer");
  const ficou = estado(runtime.snapshot(), "pen-1");
  assert.equal(ficou.status, "queued", "o estado da sessão em fila não é alterado");
  assert.equal(ficou.scanId, undefined, "nenhum scanId inventado para uma análise desfeita");
  await runtime.dispose();
});

test("P0: registo recusado + cancelamento a FALHAR — nunca afirma cancelada e preserva o scanId no erro", async (t) => {
  const { runtime, porta, monitor } = await comRecusaNoRegisto(t, { cancelarLanca: true });

  const resultado = await runtime.scan({ deviceId: "pen-1", requestId: "gesto-1", consent: true });

  assert.equal(resultado.ok, false);
  assert.match(resultado.error, /em curso/i);
  assert.match(resultado.error, /FALHOU/, "o erro tem de dizer que o cancelamento falhou");
  assert.doesNotMatch(resultado.error, /cancelada/i, "nunca se afirma cancelada por intenção");
  assert.match(resultado.error, /scan-manual-1/, "o scanId fica no erro para diagnóstico");
  assert.match(resultado.error, /continuar a correr/);
  assert.deepEqual(porta.iniciados.map((i) => i.id), ["scan-manual-1"], "a análise chegou a arrancar");
  assert.deepEqual(porta.cancelados, ["scan-manual-1"], "o cancelamento foi PEDIDO");
  assert.equal(estado(monitor.snapshot(), "pen-1").scanId, undefined, "nenhum scanId inventado no estado publicado");
  await runtime.dispose();
});

test("P0: registo recusado + cancelamento PENDENTE — diz 'pedido', não terminal nem confirmado", async (t) => {
  const { runtime, porta } = await comRecusaNoRegisto(t, { cancelarPendente: true });

  const resultado = await runtime.scan({ deviceId: "pen-1", requestId: "gesto-1", consent: true });

  assert.equal(resultado.ok, false);
  assert.match(resultado.error, /pedido/);
  assert.match(resultado.error, /não confirmado/i);
  assert.match(resultado.error, /ainda NÃO confirmado pelo motor/, "diz exactamente o que falta");
  assert.doesNotMatch(resultado.error, /\(confirmado pelo motor\)/, "sem terminal real não há frase de confirmação");
  assert.doesNotMatch(resultado.error, /cancelada/i);
  assert.match(resultado.error, /scan-manual-1/);
  assert.deepEqual(porta.cancelados, ["scan-manual-1"]);
  await runtime.dispose();
});

test("P0: registo recusado + terminal REAL — reporta o estado do motor, sem afirmar o que o causou", async (t) => {
  const { runtime, porta } = await comRecusaNoRegisto(t);

  const resultado = await runtime.scan({ deviceId: "pen-1", requestId: "gesto-1", consent: true });

  assert.equal(resultado.ok, false);
  assert.match(resultado.error, /a análise terminou como cancelled/);
  assert.match(resultado.error, /confirmado pelo motor/);
  assert.doesNotMatch(resultado.error, /pode continuar a correr/);
  assert.deepEqual(porta.cancelados, ["scan-manual-1"]);
  await runtime.dispose();
});

test("P0: sem contrato read-only nada é registado nem publicado como em curso", async (t) => {
  const { runtime, scans, deteccao } = await cenario(t, { capacidade: () => null });
  await runtime.iniciar();
  deteccao.definir([dispositivo("pen-1", "E:\\")]);
  await runtime.ciclo();

  const resultado = await runtime.scan({ deviceId: "pen-1", requestId: "gesto-1", consent: true });

  assert.equal(resultado.ok, false);
  assert.match(resultado.error, /read-only|recusada/i);
  assert.deepEqual(scans.iniciados, [], "a guarda de read-only continua a bloquear antes de arrancar");
  assert.notEqual(estado(runtime.snapshot(), "pen-1").status, "scanning");
  await runtime.dispose();
});
