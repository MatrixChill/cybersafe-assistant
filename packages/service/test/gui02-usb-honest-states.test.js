/**
 * TP-GUI02-USB-20261023 — ESTADOS HONESTOS DA PROTECÇÃO USB.
 *
 * O defeito a reproduzir: com `CYBERSAFE_USB_PROTECTION=0` (é o que a lane de
 * leitura define) o `engine.init()` NÃO chama `usbRuntime.iniciar()`. O monitor
 * fica com o valor de construtor `monitorStatus="starting"` e `devices=[]`, e o
 * `usb.getState` devolve isso para sempre. A página mostra «Monitorização USB a
 * arrancar — ainda não há enumeração confirmada; o serviço pode demorar a
 * responder», uma promessa que nunca se cumpre, enquanto o PC Center mostra a
 * pen ligada. Não é a enumeração que está vazia: é a enumeração que NUNCA FOI
 * AUTORIZADA, e o estado diz o contrário.
 *
 * Quatro eixos que este ficheiro separa à força:
 *   1. INVENTÁRIO FÍSICO — o disco existe no Windows (o PC Center vê-o).
 *   2. VOLUMES ELEGÍVEIS — letra/mount publicado; sem isto não há alvo analisável.
 *   3. WATCHER/POLL      — o ciclo periódico; cortado por política neste modo.
 *   4. CONSENTIMENTO     — o opt-in `usb.configure`; eixo próprio.
 * Um deles bloqueado não é evidência dos outros, e «watcher bloqueado» NUNCA
 * equivale a «a enumeração confirmou zero unidades».
 *
 * Importa do BUILD como os restantes testes de serviço, para correr com o
 * `node --test` simples do `npm test` (sem loader extra) e para provar o que
 * efetivamente é publicado, não só o fonte.
 *
 * Não sobe pipe, não sobe serviço, não corre scan, não liga proteção, não toca
 * na porta 4000. A porta de detecção é injectada e CADA leitura é contada: é
 * assim que «zero enumeração» se prova em vez de se prometer.
 *
 * Uso: node --test packages/service/test/gui02-usb-honest-states.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { UsbConfigStore, UsbProtectionMonitor } from "../dist/usb-protection.js";
import { UsbProtectionRuntime, caminhoConfigUsb, motivoBloqueioUsbPolicy } from "../dist/usb-protection-runtime.js";

const T0 = new Date("2026-10-23T12:00:00.000Z");
const CAUSA = "poll USB cortado pela política de leitura (CYBERSAFE_USB_PROTECTION=0); enumeração não autorizada neste modo";

function dispositivo(id, rootPath, extra = {}) {
  return { id, rootPath, rootPaths: [rootPath], identityProvenance: "disk-serial", ...extra };
}

/** Porta de detecção com CONTADOR de leituras — a prova de «zero enumeração». */
function deteccaoMutavel(inicial = []) {
  const porta = {
    leituras: 0,
    leiturasPendentes: 0,
    atual: inicial,
    pendentes: [],
    lancarErro: null,
    definir(proximo) { porta.atual = proximo; },
    definirPendentes(proximos) { porta.pendentes = proximos; },
    listar: async () => {
      porta.leituras += 1;
      if (porta.lancarErro) throw new Error(porta.lancarErro);
      return porta.atual;
    },
    listarPendentes: async () => {
      porta.leiturasPendentes += 1;
      return porta.pendentes;
    },
  };
  return porta;
}

/** baseDir temporário e limpo no `after` — o opt-in é escrito no disco, como no serviço. */
async function baseTemporaria(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gui02-usb-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Runtime completo com as peças reais; só o ScanManager é porta falsa. */
async function cenario(t, deteccao = deteccaoMutavel(), opts = {}) {
  const base = await baseTemporaria(t);
  const store = new UsbConfigStore(caminhoConfigUsb(base));
  const monitor = new UsbProtectionMonitor({
    deteccao,
    store,
    agora: () => T0,
    ...(opts.monitor ?? {}),
  });
  const runtime = new UsbProtectionRuntime({
    baseDir: base,
    monitor,
    estadoDoScan: (id) => monitor.snapshot().devices.find((d) => d.scanId === id) ?? null,
    intervaloMs: 10,
    ...(opts.runtime ?? {}),
  });
  return { base, store, monitor, runtime, deteccao };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. O ESTADO TERMINAL QUE FALTAVA
// ─────────────────────────────────────────────────────────────────────────────

test("politica a cortar o runtime: estado TERMINAL com causa, nunca 'starting' eterno", async (t) => {
  const { runtime, deteccao } = await cenario(t, deteccaoMutavel(), { runtime: { bloqueioPorPolitica: CAUSA } });

  const snapshot = runtime.snapshot();
  assert.notEqual(snapshot.monitorStatus, "starting",
    "o snapshot continua a prometer 'a arrancar' quando nada vai arrancar neste processo");
  assert.equal(snapshot.monitorStatus, "unavailable", "estado terminal esperado: indisponível");
  assert.equal(snapshot.error, CAUSA, "a causa tem de viajar até quem lê, senão é indisponibilidade sem explicação");
  assert.deepEqual(snapshot.devices, [], "sem enumeração não há unidades; lista vazia sem causa é meio-dado");
  assert.equal(deteccao.leituras, 0, "bloquear por política NÃO pode enumerar para mostrar algo");
  assert.equal(deteccao.leiturasPendentes, 0, "nem a porta de espera pode ser lida");
});

test("bloqueio por política é terminal: reler (refresh manual) não inventa nem re-tenta", async (t) => {
  const { runtime, deteccao } = await cenario(t, deteccaoMutavel(), { runtime: { bloqueioPorPolitica: CAUSA } });

  const primeiro = runtime.snapshot();
  const segundo = runtime.snapshot();   // é isto que o botão «atualizar» faz
  const terceiro = runtime.snapshot();

  assert.equal(segundo.monitorStatus, "unavailable");
  assert.equal(terceiro.error, CAUSA, "a causa não se perde na segunda leitura");
  assert.equal(deteccao.leituras, 0, "refresh sem autorização continua a ser zero enumeração");
  assert.deepEqual(
    [primeiro.monitorStatus, segundo.monitorStatus, terceiro.monitorStatus],
    ["unavailable", "unavailable", "unavailable"],
    "estados terminais não transitam por leitura",
  );
});

test("watcher bloqueado NÃO é enumeração vazia comprovada", async (t) => {
  const { runtime } = await cenario(t, deteccaoMutavel(), { runtime: { bloqueioPorPolitica: CAUSA } });
  const s = runtime.snapshot();
  // A distinção que a UI precisa: `operational` + 0 dispositivos diz «procurámos
  // e não encontrámos». `unavailable` diz «não procurámos». São frases diferentes.
  assert.notEqual(s.monitorStatus, "operational",
    "marcar como operational com zero unidades afirmaria uma enumeração que nunca aconteceu");
  assert.ok(typeof s.error === "string" && s.error.length > 0, "indisponibilidade sem causa é outro defeito");
});

test("iniciar() depois de um bloqueio por política limpa o estado terminal", async (t) => {
  const deteccao = deteccaoMutavel([dispositivo("disk-7", "E:\\")]);
  const { runtime } = await cenario(t, deteccao, { runtime: { bloqueioPorPolitica: CAUSA } });
  assert.equal(runtime.snapshot().monitorStatus, "unavailable");

  await runtime.iniciar();
  const s = runtime.snapshot();
  assert.equal(s.monitorStatus, "operational", "um arranque genuíno substitui o bloqueio registado");
  assert.equal(s.error, undefined, "a causa do bloqueio não pode sobreviver a uma enumeração bem-sucedida");
  assert.equal(s.devices.length, 1, "a pen aparece quando a enumeração é autorizada");
});

test("sem bloqueio registado e sem iniciar, 'starting' mantém-se: é transitório honesto", async (t) => {
  // Regressão do contrato EXISTENTE (`r8-usb-engine-handlers.test.js:45`): engine
  // construído sem `init()` é «a arrancar» porque ainda vai arrancar. Não é o
  // mesmo caso que política cortada, e não pode ser tratado igual.
  const { runtime } = await cenario(t);
  assert.equal(runtime.snapshot().monitorStatus, "starting",
    "sem arranque e sem bloqueio registado a palavra certa continua a ser 'a arrancar'");
});

test("arranque que rebenta tambem e terminal, nao 'starting' eterno por outro caminho", async (t) => {
  // Aqui NAO ha causa a passar na construção: e' o proprio `iniciar()` que tem de
  // guardar a falha antes de a repropagar, porque o `catch` do engine so faz
  // `console.warn` e nunca volta a perguntar ao runtime o que aconteceu.
  const base = await baseTemporaria(t);
  const monitorAvaro = {
    iniciar: async () => { throw new Error("leitura da preferência USB falhou (EIO)"); },
    snapshot: () => ({ enabled: false, monitorStatus: "starting", updatedAt: T0.toISOString(), devices: [] }),
    ciclo: async () => monitorAvaro.snapshot(),
    configurar: async () => monitorAvaro.snapshot(),
  };
  const runtime = new UsbProtectionRuntime({
    baseDir: base,
    monitor: monitorAvaro,
    estadoDoScan: () => null,
    intervaloMs: 10,
  });

  await assert.rejects(() => runtime.iniciar(), /EIO/, "a falha tem de continuar a ser propagada ao engine");
  const s = runtime.snapshot();
  assert.equal(s.monitorStatus, "unavailable", "arranque falhado não é arranque pendente");
  assert.match(String(s.error), /EIO/, "o motivo do arranque falhado tem de chegar à UI");
  assert.equal(s.devices.length, 0, "nem por isto se inventa um dispositivo");
});

test("zero scans, zero escritas, zero enumerações no caminho bloqueado", async (t) => {
  const deteccao = deteccaoMutavel([dispositivo("disk-5", "E:\\")]);
  const portaAnalise = {
    iniciadas: [],
    canceladas: [],
    iniciar: async (alvo) => { portaAnalise.iniciadas.push(alvo.rootPath); throw new Error("motor não deve ser tocado"); },
    cancelar: async (id) => { portaAnalise.canceladas.push(id); },
    verificar: () => ({ ok: true }),
  };
  const { runtime, base } = await cenario(t, deteccao, {
    runtime: { bloqueioPorPolitica: CAUSA, analise: portaAnalise, enumerar: () => deteccao.listar() },
  });
  runtime.snapshot();

  assert.equal(portaAnalise.iniciadas.length, 0, "ler estado não pode arrancar análises");
  assert.equal(deteccao.leituras, 0, "o gesto de ler estado não pode enumerar");

  // O gesto manual: recusado COM MOTIVO, sem enumerar e sem tocar no motor.
  const recusado = await runtime.scan({ deviceId: "disk-5", requestId: "r1", consent: true });
  assert.equal(recusado.ok, false, "scan aceite com a enumeração bloqueada por política");
  assert.match(String(recusado.error ?? ""), /política|não autorizada|indispon/i,
    "recusa sem causa é a mesma mentira noutro sítio");
  assert.equal(deteccao.leituras, 0, "a recusa tem de vir ANTES da enumeração que ela proíbe");
  assert.equal(portaAnalise.iniciadas.length, 0);
  assert.equal(portaAnalise.canceladas.length, 0);

  // Ler estado nunca escreve a preferência de outrem.
  let existeConfig = true;
  try { await fs.access(caminhoConfigUsb(base)); } catch { existeConfig = false; }
  assert.equal(existeConfig, false, "usb.getState nunca cria o ficheiro de opt-in");
});

// ─────────────────────────────────────────────────────────────────────────────
// B. FIXTURES QUE O PATCH NÃO PODE PARTIR (com a enumeração autorizada)
// ─────────────────────────────────────────────────────────────────────────────

test("pen ligada: operational com a unidade e a raiz que a enumeração deu", async (t) => {
  const deteccao = deteccaoMutavel([dispositivo("disk-1", "E:\\")]);
  const { runtime } = await cenario(t, deteccao);
  await runtime.iniciar();
  const s = runtime.snapshot();
  assert.equal(s.monitorStatus, "operational");
  assert.equal(s.devices.length, 1);
  assert.equal(s.devices[0].rootPath, "E:\\");
  assert.equal(s.devices[0].present, true);
});

test("lista vazia COM autorização: operational e zero unidades — a frase é outra", async (t) => {
  const deteccao = deteccaoMutavel([]);
  const { runtime } = await cenario(t, deteccao);
  await runtime.iniciar();
  const s = runtime.snapshot();
  assert.equal(s.monitorStatus, "operational");
  assert.equal(s.devices.length, 0);
  assert.equal(s.error, undefined, "procurar e não encontrar não é indisponibilidade");
});

test("remoção: a presença confirmada sai do snapshot no ciclo seguinte", async (t) => {
  const deteccao = deteccaoMutavel([dispositivo("disk-9", "F:\\")]);
  const { runtime } = await cenario(t, deteccao);
  await runtime.iniciar();
  assert.equal(runtime.snapshot().devices.length, 1);

  deteccao.definir([]);
  const s = await runtime.ciclo();
  const ainda = s.devices.find((d) => d.id === "disk-9");
  if (ainda) assert.equal(ainda.present, false, "listado como presente depois de sair");
  assert.equal(s.monitorStatus, "operational", "remover um dispositivo não torna o monitor indisponível");
});

test("erro de enumeração: unavailable com o motivo e SEM transições inventadas", async (t) => {
  const deteccao = deteccaoMutavel([dispositivo("disk-3", "E:\\")]);
  const { runtime } = await cenario(t, deteccao);
  await runtime.iniciar();
  assert.equal(runtime.snapshot().devices.length, 1);

  deteccao.lancarErro = "CIM indisponível";
  const s = await runtime.ciclo();
  assert.equal(s.monitorStatus, "unavailable");
  assert.match(String(s.error), /CIM/);
  // Falha de enumeração não declara remoção: presença não confirmada.
  assert.equal(s.devices.find((d) => d.id === "disk-3")?.present, true,
    "um erro de leitura não pode converter presença em ausência");
});

test("disco físico sem volume elegível: existe, espera, e NUNCA é convertido em unidade", async (t) => {
  const deteccao = deteccaoMutavel([]);
  deteccao.definirPendentes([{ id: "disk-42", identityProvenance: "disk-serial" }]);
  const { runtime } = await cenario(t, deteccao);
  await runtime.iniciar();
  const s = runtime.snapshot();
  const pendente = s.devices.find((d) => d.id === "disk-42");
  assert.ok(pendente, "disco sem letra tem de aparecer — o Windows mostra-o");
  assert.equal(pendente.awaitingVolume, true);
  assert.equal(pendente.rootPath, "", "sem volume publicado não há raiz; inventar uma é o defeito");
  assert.notEqual(pendente.status, "completed", "um disco sem volume não foi analisado");
});

// ─────────────────────────────────────────────────────────────────────────────
// C. O PREDICADO DA POLÍTICA, lido do mesmo ambiente que o engine usa
// ─────────────────────────────────────────────────────────────────────────────

test("motivoBloqueioUsbPolicy espelha EXATAMENTE o corte do engine — nem mais, nem menos", () => {
  // O engine só arranca o runtime quando `CYBERSAFE_USB_PROTECTION !== "0"` e
  // `NODE_ENV !== "test"`. O predicado tem de dizer o mesmo; um predicado mais
  // largo mentiria sobre serviços reais, um mais estreito deixaria a mentira viva.
  assert.match(String(motivoBloqueioUsbPolicy({ CYBERSAFE_USB_PROTECTION: "0", NODE_ENV: "development" })), /CYBERSAFE_USB_PROTECTION=0/);
  assert.match(String(motivoBloqueioUsbPolicy({ NODE_ENV: "test" })), /teste/);
  assert.equal(motivoBloqueioUsbPolicy({ NODE_ENV: "development" }), null, "serviço real não pode ser declarado bloqueado");
  assert.equal(motivoBloqueioUsbPolicy({ CYBERSAFE_USB_PROTECTION: "1", NODE_ENV: "production" }), null);
  // O literal "0" é o que o lançador define; "false"/"" NÃO são o corte.
  assert.equal(motivoBloqueioUsbPolicy({ CYBERSAFE_USB_PROTECTION: "false" }), null,
    "inventar um corte por semelhança textual mudaria o comportamento do serviço real");
});

test("o corte da lane de leitura é o que o lançador escreve no ambiente", () => {
  // Espelha `construirAmbiente` do lançador: CYBERSAFE_USB_PROTECTION "0" e
  // NODE_ENV "development". É esta dupla que produz o estado bloqueado.
  const envDaLaneLeitura = { NODE_ENV: "development", CYBERSAFE_USB_PROTECTION: "0" };
  assert.ok(motivoBloqueioUsbPolicy(envDaLaneLeitura), "a lane de leitura tem de ser declarada bloqueada");
});
