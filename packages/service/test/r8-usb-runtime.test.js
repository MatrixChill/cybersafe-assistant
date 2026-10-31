/**
 * R8 — RUNTIME DA PROTECAO USB (integracao: monitor + adapter + poll).
 *
 * Prova, com as pecas REAIS (monitor, adapter, store, runtime) e so' o
 * ScanManager substituido por uma porta:
 *  - lifecycle: `iniciar()` faz o primeiro ciclo e agenda o poll; `dispose()`
 *    para o poll (o servico nao deixa um timer a correr depois de desmontar);
 *  - opt-in real: `configure({enabled})` grava no baseDir (version 1) e o
 *    snapshot reflecte a opcao, sem tocar em firewall/protecao;
 *  - analise de ponta a ponta: o desfecho REAL do scan entra pelo
 *    `aplicarResultado` e so' e' publicado como `completed` depois de uma
 *    enumeracao fresca;
 *  - fail-safe: sem contrato de read-only declarado pelo motor, NENHUMA
 *    analise arranca (limitacao declarada, nao auto-scan a fingir);
 *  - identidade instavel (indice de disco) recusa auto-scan;
 *  - remocao durante a analise cancela o scan proprio no ScanManager.
 *
 * Uso: node --test packages/service/test/r8-usb-runtime.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Importados do BUILD (como os restantes testes de servico): os modulos do
// src importam-se entre si com extensao `.js` (tsc/ESM) e o type-stripping do
// Node nao reescreve especificadores.
import { UsbConfigStore, UsbProtectionMonitor } from "../dist/usb-protection.js";
import { UsbReadOnlyScanAdapter, USB_READONLY_CONTRATO } from "../dist/usb-scan-adapter.js";
import { UsbProtectionRuntime, caminhoConfigUsb } from "../dist/usb-protection-runtime.js";

const T0 = new Date("2026-10-13T12:00:00.000Z");

function dispositivo(id, rootPath, extra = {}) {
  return { id, rootPath, rootPaths: [rootPath], identityProvenance: "disk-serial", ...extra };
}

/** Deteccao mutavel: o teste define o que se ve; cada leitura conta. */
function deteccaoMutavel(inicial = []) {
  const porta = {
    leituras: 0,
    atual: inicial,
    /** Discos detetados SEM volume/letra (estado de espera) — 14/10. */
    pendentes: [],
    definir(proximo) {
      porta.atual = proximo;
    },
    definirPendentes(proximos) {
      porta.pendentes = proximos;
    },
    listar: async () => {
      porta.leituras += 1;
      return porta.atual;
    },
    listarPendentes: async () => porta.pendentes,
  };
  return porta;
}

/** Porta de ScanManager (a unica peca substituida). */
function scanManagerFalso() {
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
      estados.set(id, { id, status: "cancelled" });
    },
    getScan: (id) => estados.get(id),
  };
}

async function cenario(
  t,
  {
    enabled = true,
    capacidade = () => ({ ...USB_READONLY_CONTRATO }),
    intervaloMs = 10,
    slotOcupado = () => false,
  } = {},
) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-usb-runtime-"));
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  const deteccao = deteccaoMutavel([]);
  const scans = scanManagerFalso();
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
  const monitor = new UsbProtectionMonitor({
    deteccao,
    store,
    analise: adapter,
    readOnly: adapter,
    agora: () => T0,
  });
  const relogio = { agora: T0.getTime() };
  const runtime = new UsbProtectionRuntime({
    baseDir,
    monitor,
    estadoDoScan: (scanId) => scans.getScan(scanId),
    verificarCapacidade: () => adapter.verificar(),
    // Análise MANUAL: as MESMAS peças reais (adapter + enumeração) do auto-scan.
    analise: adapter,
    enumerar: () => deteccao.listar(),
    slotOcupado,
    agora: () => relogio.agora,
    intervaloMs,
  });
  return { baseDir, deteccao, scans, adapter, store, monitor, runtime, relogio };
}

const estado = (snapshot, id) => snapshot.devices.find((d) => d.id === id);

/* ── P0 FIABILIDADE USB (14/10/2026): disco USB detetado SEM volume ────────
 *
 * Incidente real: o Windows mostrava a pen e a pagina do CyberSafe dizia "sem
 * dispositivo". O produto so' conhecia dispositivos com raiz analisavel; um
 * disco com transporte USB provado mas ainda sem letra publicada nao existia em
 * lado nenhum. Estes testes fixam o estado novo: DETETADO e declarado, NUNCA
 * analisavel, sem deixar fantasmas depois de sair. */

test("sem volume publicado: o dispositivo USB aparece como 'a aguardar volume' e nunca arranca analise", async (t) => {
  const { monitor, deteccao, scans, adapter } = await cenario(t, { enabled: true });
  deteccao.definirPendentes([{ id: "usb-serial:PEN-SEM-VOLUME", identityProvenance: "disk-serial" }]);

  const snapshot = await monitor.ciclo();
  const dispositivo = estado(snapshot, "usb-serial:PEN-SEM-VOLUME");
  assert.ok(dispositivo, "o disco USB detetado sem volume ficou invisivel");
  assert.equal(dispositivo.status, "detected");
  assert.equal(dispositivo.awaitingVolume, true);
  assert.equal(dispositivo.present, true);
  assert.equal(dispositivo.rootPath, "", "dispositivo em espera nao pode ter raiz");
  assert.match(dispositivo.limitation, /a aguardar volume/);
  assert.equal(scans.iniciados.length, 0, "nunca se analisa um disco sem volume");
  assert.equal(adapter.verificar().ok, true);
});

test("porta de deteccao antiga (sem listarPendentes) continua a funcionar", async (t) => {
  const { monitor, deteccao } = await cenario(t, { enabled: true });
  delete deteccao.listarPendentes;
  const snapshot = await monitor.ciclo();
  assert.equal(snapshot.monitorStatus, "operational");
  assert.deepEqual(snapshot.devices, []);
});

test("disco em espera sai: e' removido sem deixar fantasma", async (t) => {
  const { monitor, deteccao } = await cenario(t, { enabled: true });
  deteccao.definirPendentes([{ id: "usb-serial:PEN-SEM-VOLUME", identityProvenance: "disk-serial" }]);
  await monitor.ciclo();

  deteccao.definirPendentes([]);
  const depois = await monitor.ciclo();
  const dispositivo = estado(depois, "usb-serial:PEN-SEM-VOLUME");
  assert.equal(dispositivo.present, false);
  assert.equal(dispositivo.status, "removed");
  assert.equal(dispositivo.awaitingVolume, false);
});

test("letra tardia: o disco em espera passa a analisavel quando o volume aparece", async (t) => {
  const { monitor, deteccao, scans } = await cenario(t, { enabled: true });
  deteccao.definirPendentes([{ id: "usb-serial:PEN-TARDIA", identityProvenance: "disk-serial" }]);
  // `iniciar()` e' o arranque real do servico: le o opt-in e marca o baseline
  // da PRIMEIRA enumeracao bem sucedida. A pen ja' esta' ligada mas ainda sem
  // letra — e' exatamente o caso do incidente.
  const emEspera = await monitor.iniciar();
  assert.equal(estado(emEspera, "usb-serial:PEN-TARDIA").awaitingVolume, true);
  assert.equal(scans.iniciados.length, 0);

  // Windows publicou a letra: o MESMO id passa a dispositivo com raiz.
  deteccao.definir([dispositivo("usb-serial:PEN-TARDIA", "E:\\")]);
  deteccao.definirPendentes([]);
  const comVolume = await monitor.ciclo();
  const pronto = estado(comVolume, "usb-serial:PEN-TARDIA");
  assert.equal(pronto.rootPath, "E:\\");
  assert.equal(pronto.awaitingVolume, undefined, "o estado de espera nao pode sobreviver a chegada do volume");
  // Insercao nova com opt-in ligado e read-only provado: arranca UMA analise.
  assert.equal(scans.iniciados.length, 1);
  assert.equal(scans.iniciados[0].targetPath, "E:\\");
});

test("lifecycle: iniciar() faz o primeiro ciclo; dispose() para o poll", async (t) => {
  const { deteccao, runtime } = await cenario(t, { intervaloMs: 10 });

  const primeiro = await runtime.iniciar();
  assert.equal(primeiro.monitorStatus, "operational");
  const aposIniciar = deteccao.leituras;

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(deteccao.leituras > aposIniciar, "o poll tem de continuar a enumerar");

  await runtime.dispose();
  const aposDispose = deteccao.leituras;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(deteccao.leituras, aposDispose, "dispose() tem de parar o poll (sem timer órfão)");
});

test("opt-in real: configure grava no baseDir e o snapshot reflecte a opção", async (t) => {
  const { baseDir, runtime } = await cenario(t, { enabled: false });
  await runtime.iniciar();

  assert.equal(runtime.snapshot().enabled, false, "sem opt-in a proteção USB nasce desligada");

  const ligado = await runtime.configure({ enabled: true });
  assert.equal(ligado.enabled, true);

  const guardado = JSON.parse(await fs.readFile(caminhoConfigUsb(baseDir), "utf8"));
  assert.deepEqual(guardado, { version: 1, enabled: true, updatedAt: T0.toISOString() });

  const desligado = await runtime.configure({ enabled: false });
  assert.equal(desligado.enabled, false);
  assert.equal(JSON.parse(await fs.readFile(caminhoConfigUsb(baseDir), "utf8")).enabled, false);

  await runtime.dispose();
});

test("análise de ponta a ponta: desfecho real só é publicado após enumeração fresca", async (t) => {
  const { deteccao, scans, runtime } = await cenario(t);

  await runtime.iniciar();
  deteccao.definir([dispositivo("pen-1", "E:\\")]);
  const aArrancar = await runtime.ciclo();

  assert.equal(estado(aArrancar, "pen-1").status, "scanning");
  assert.deepEqual(scans.iniciados, [
    { id: "scan-1", type: "custom", targetPath: "E:\\", options: { readOnly: true } },
  ]);

  // Ainda sem ciclo: nada foi publicado. O desfecho real e' absorvido no
  // INICIO do ciclo seguinte e a enumeracao desse ciclo (posterior ao
  // desfecho) e' que confirma presenca+identidade.
  scans.concluir("scan-1", "completed");
  assert.equal(estado(runtime.snapshot(), "pen-1").result, undefined, "nada é publicado sem confirmação");

  const publicado = await runtime.ciclo();
  assert.equal(estado(publicado, "pen-1").status, "completed");
  assert.equal(estado(publicado, "pen-1").result.status, "completed", "o resultado publicado é o real do scan");

  // Estável: uma insercao e' analisada UMA vez (nao re-arranca a cada ciclo).
  const estavel = await runtime.ciclo();
  assert.equal(estado(estavel, "pen-1").status, "completed");
  assert.equal(scans.iniciados.length, 1, "não re-arranca análises sobre a mesma inserção");

  await runtime.dispose();
});

test("BITE fail-safe: sem contrato de read-only NENHUMA análise arranca", async (t) => {
  const { deteccao, scans, runtime } = await cenario(t, { capacidade: () => null });

  await runtime.iniciar();
  deteccao.definir([dispositivo("pen-1", "E:\\")]);
  const snapshot = await runtime.ciclo();

  assert.deepEqual(scans.iniciados, [], "sem garantia estrutural não se arranca análise nenhuma");
  assert.equal(estado(snapshot, "pen-1").status, "detected");
  assert.match(estado(snapshot, "pen-1").limitation, /read-only/i);

  await runtime.dispose();
});

test("identidade instável (índice de disco): auto-scan recusado com limitação", async (t) => {
  const { deteccao, scans, runtime } = await cenario(t);

  await runtime.iniciar();
  deteccao.definir([dispositivo("usb-index:0", "E:\\", { identityProvenance: "disk-index-fallback" })]);
  const snapshot = await runtime.ciclo();

  assert.deepEqual(scans.iniciados, [], "identidade reciclável não pode gerar auto-scan");
  assert.equal(estado(snapshot, "usb-index:0").status, "detected");
  assert.match(estado(snapshot, "usb-index:0").limitation, /índice de disco/i);

  await runtime.dispose();
});

test("remoção durante a análise: o scan próprio é cancelado no ScanManager", async (t) => {
  const { deteccao, scans, runtime } = await cenario(t);

  await runtime.iniciar();
  deteccao.definir([dispositivo("pen-1", "E:\\")]);
  await runtime.ciclo();
  assert.equal(scans.cancelados.length, 0);

  deteccao.definir([]);
  const removido = await runtime.ciclo();

  assert.deepEqual(scans.cancelados, ["scan-1"], "a remoção cancela exactamente o scan deste dispositivo");
  assert.equal(estado(removido, "pen-1").status, "incomplete");
  assert.equal(estado(removido, "pen-1").present, false);

  await runtime.dispose();
});

/* ── ANÁLISE MANUAL (`usb.scan` / `usb.cancel`) — contrato ratificado ─────── */

test("usb.scan: análise manual com opt-in DESLIGADO, readOnly forçado e sem ligar o auto-scan", async (t) => {
  const { deteccao, scans, runtime } = await cenario(t, { enabled: false });
  deteccao.definir([dispositivo("pen-1", "E:\\")]);

  const resultado = await runtime.scan({ deviceId: "pen-1", requestId: "gesto-1", consent: true });

  assert.deepEqual(resultado, { ok: true, deviceId: "pen-1", scanId: "scan-1" });
  assert.deepEqual(
    scans.iniciados,
    [{ id: "scan-1", type: "custom", targetPath: "E:\\", options: { readOnly: true } }],
    "a análise manual arranca SEMPRE read-only, na raiz resolvida pelo serviço",
  );
  assert.equal(runtime.snapshot().enabled, false, "o gesto manual NÃO liga o auto-scan");
  await runtime.dispose();
});

test("usb.scan: consent ausente/false/'true' é RECUSADO com ok:false (nunca aceite por omissão)", async (t) => {
  const { deteccao, scans, runtime } = await cenario(t, { enabled: false });
  deteccao.definir([dispositivo("pen-1", "E:\\")]);

  for (const payload of [
    { deviceId: "pen-1", requestId: "gesto-1" },
    { deviceId: "pen-1", requestId: "gesto-1", consent: false },
    { deviceId: "pen-1", requestId: "gesto-1", consent: "true" },
  ]) {
    const resultado = await runtime.scan(payload);
    assert.equal(resultado.ok, false, `payload ${JSON.stringify(payload)} devia ser recusado`);
    assert.match(resultado.error, /consent/);
  }
  assert.deepEqual(scans.iniciados, [], "sem consentimento literal nada arranca");
  await runtime.dispose();
});

test("usb.scan: ids fora dos limites (vazios, tipo errado, demasiado longos) são recusados", async (t) => {
  const { deteccao, scans, runtime } = await cenario(t, { enabled: false });
  deteccao.definir([dispositivo("pen-1", "E:\\")]);

  for (const payload of [
    "nada",
    null,
    [],
    { deviceId: "", requestId: "gesto-1", consent: true },
    { deviceId: "   ", requestId: "gesto-1", consent: true },
    { deviceId: 42, requestId: "gesto-1", consent: true },
    { deviceId: "pen-1", requestId: "", consent: true },
    { deviceId: "pen-1", requestId: "x".repeat(101), consent: true },
    { deviceId: "y".repeat(201), requestId: "gesto-1", consent: true },
  ]) {
    const resultado = await runtime.scan(payload);
    assert.equal(resultado.ok, false, `payload ${JSON.stringify(payload)} devia ser recusado`);
    assert.equal(typeof resultado.error, "string");
  }
  assert.deepEqual(scans.iniciados, []);
  await runtime.dispose();
});

test("usb.scan: retry do MESMO pedido devolve o MESMO scanId (uma só análise)", async (t) => {
  const { deteccao, scans, runtime } = await cenario(t, { enabled: false });
  deteccao.definir([dispositivo("pen-1", "E:\\")]);

  const primeiro = await runtime.scan({ deviceId: "pen-1", requestId: "gesto-1", consent: true });
  const repetido = await runtime.scan({ deviceId: "pen-1", requestId: "gesto-1", consent: true });

  assert.deepEqual(repetido, primeiro, "o retry mantém o MESMO scanId");
  assert.equal(scans.iniciados.length, 1, "o retry do MESMO gesto não arranca segunda análise");

  // Ciclo de vida REAL: com a análise viva, um gesto DIFERENTE é recusado com
  // motivo — nunca se sobrepõem duas sessões sobre o mesmo dispositivo. Um gesto
  // novo só arranca depois de a sessão anterior chegar a terminal.
  const comAnaliseViva = await runtime.scan({ deviceId: "pen-1", requestId: "gesto-2", consent: true });
  assert.equal(comAnaliseViva.ok, false);
  assert.match(comAnaliseViva.error, /em curso/i);
  assert.equal(scans.iniciados.length, 1, "nada arranca com uma análise viva no mesmo dispositivo");

  scans.concluir("scan-1", "completed");
  await runtime.ciclo();
  const depoisDoTerminal = await runtime.scan({ deviceId: "pen-1", requestId: "gesto-2", consent: true });
  assert.equal(depoisDoTerminal.ok, true, "terminada a sessão anterior, um gesto NOVO arranca outra análise");
  assert.equal(scans.iniciados.length, 2);
  await runtime.dispose();
});

test("usb.scan: dois gestos concorrentes — só UM arranca (lock síncrono antes do await)", async (t) => {
  const { deteccao, scans, runtime } = await cenario(t, { enabled: false });
  deteccao.definir([dispositivo("pen-1", "E:\\")]);

  const [a, b] = await Promise.all([
    runtime.scan({ deviceId: "pen-1", requestId: "gesto-A", consent: true }),
    runtime.scan({ deviceId: "pen-1", requestId: "gesto-B", consent: true }),
  ]);

  assert.equal(scans.iniciados.length, 1, "um duplo clique não pode enfileirar duas análises");
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  await runtime.dispose();
});

test("usb.scan: slot ocupado é recusado SEM fingir fila nem estado 'a correr'", async (t) => {
  const { deteccao, scans, runtime } = await cenario(t, { enabled: false, slotOcupado: () => true });
  deteccao.definir([dispositivo("pen-1", "E:\\")]);

  const resultado = await runtime.scan({ deviceId: "pen-1", requestId: "gesto-1", consent: true });
  assert.equal(resultado.ok, false);
  assert.match(resultado.error, /ocupado/);
  assert.deepEqual(scans.iniciados, [], "nada arranca com o slot ocupado");
  await runtime.dispose();
});

test("usb.scan: dispositivo ausente, instável ou sem volume é recusado com motivo", async (t) => {
  const casos = [
    { dispositivos: [], esperado: /não encontrado/ },
    {
      dispositivos: [dispositivo("pen-1", "E:\\", { identityProvenance: "disk-index-fallback" })],
      esperado: /índice de disco/,
    },
    { dispositivos: [dispositivo("pen-1", "")], esperado: /sem volume/ },
  ];
  for (const caso of casos) {
    const { deteccao, scans, runtime } = await cenario(t, { enabled: false });
    deteccao.definir(caso.dispositivos);
    const resultado = await runtime.scan({ deviceId: "pen-1", requestId: "gesto-1", consent: true });
    assert.equal(resultado.ok, false);
    assert.match(resultado.error, caso.esperado);
    assert.deepEqual(scans.iniciados, []);
    await runtime.dispose();
  }
});

test("usb.cancel: cancela SÓ com os DOIS ids certos; uma sessão nova nunca é tocada", async (t) => {
  const { deteccao, scans, runtime } = await cenario(t, { enabled: false });
  deteccao.definir([dispositivo("pen-1", "E:\\")]);
  const { scanId } = await runtime.scan({ deviceId: "pen-1", requestId: "gesto-1", consent: true });

  const outroDispositivo = await runtime.cancel({ deviceId: "outro", scanId });
  assert.equal(outroDispositivo.ok, false);
  const desconhecido = await runtime.cancel({ deviceId: "pen-1", scanId: "scan-999" });
  assert.equal(desconhecido.ok, false);
  assert.deepEqual(scans.cancelados, [], "ids que não coincidem não cancelam nada");

  const certo = await runtime.cancel({ deviceId: "pen-1", scanId });
  assert.deepEqual(certo, { ok: true });
  assert.deepEqual(scans.cancelados, [scanId], "cancela exactamente o scan indicado");

  scans.concluir(scanId, "cancelled");
  const depoisDoTerminal = await runtime.cancel({ deviceId: "pen-1", scanId });
  assert.equal(depoisDoTerminal.ok, false, "a associação não é persistida: um id antigo não cancela outra sessão");
  await runtime.dispose();
});

test("usb.cancel: ids inválidos são recusados com ok:false", async (t) => {
  const { runtime } = await cenario(t, { enabled: false });
  for (const payload of ["nada", null, [], {}, { deviceId: "pen-1" }, { scanId: "scan-1" }]) {
    const resultado = await runtime.cancel(payload);
    assert.equal(resultado.ok, false, `payload ${JSON.stringify(payload)} devia ser recusado`);
    assert.equal(typeof resultado.error, "string");
  }
  await runtime.dispose();
});
