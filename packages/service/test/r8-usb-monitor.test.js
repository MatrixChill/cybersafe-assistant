/**
 * R8 — MONITOR DE PROTECAO USB (service): fila, presenca, identidade, opt-in.
 *
 * Contrato (R8-USB-CONTRACT-CODEX-2026-10-12.md):
 *  - opt-in (`enabled`) e estado do monitor (`monitorStatus`) sao eixos SEPARADOS.
 *  - Baseline (dispositivos ja presentes) NUNCA dispara analise automatica.
 *  - Fila limitada/dedup por identidade; UMA analise global real.
 *  - Desativar cancela APENAS a analise USB que este modulo iniciou — nunca manual.
 *  - Remocao/letra reutilizada/reconexao revalidam identidade; o estado terminal
 *    exige confirmacao FRESCA (nunca `completed` por heranca).
 *  - Enumeracao falhada NAO publica `completed` nem transita estados.
 *  - Se a prova de read-only faltar, o AUTO e' bloqueado NO SERVICO (nao so' na UI).
 *
 * Tudo injetado: nenhum Windows, nenhuma pen, nenhum PowerShell.
 *
 * Uso: node --test packages/service/test/r8-usb-monitor.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { UsbProtectionMonitor } from "../src/usb-protection.ts";

const T0 = new Date("2026-10-13T07:00:00.000Z");
const T1 = new Date("2026-10-13T07:01:00.000Z");

function dispositivo(id, rootPath, extra = {}) {
  return { id, rootPath, rootPaths: [rootPath], identityProvenance: "disk-serial", ...extra };
}

/** Porta de deteccao injetada: devolve a proxima leitura da sequencia. */
function fakeDeteccao(sequencia) {
  const leituras = [];
  let indice = 0;
  return {
    leituras,
    listar: async () => {
      leituras.push(indice);
      const atual = sequencia[Math.min(indice, sequencia.length - 1)];
      indice += 1;
      if (atual instanceof Error) throw atual;
      return typeof atual === "function" ? atual() : atual;
    },
  };
}

/**
 * Porta de deteccao MUTAVEL: o teste define o que se ve e cada `listar()`
 * conta. Preferivel a sequencias indexadas porque o monitor enumera DUAS
 * vezes por arranque (o ciclo e a revalidacao pre-arranque) — a sequencia
 * indexada esconderia exactamente essa segunda leitura.
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
      return typeof atual === "function" ? atual(porta) : atual;
    },
  };
  return porta;
}

/** Porta de analise injetada: registra inicios/cancelamentos. */
function fakeAnalise() {
  const iniciados = [];
  const cancelados = [];
  let contador = 0;
  return {
    iniciados,
    cancelados,
    iniciar: async (alvo) => {
      iniciados.push(alvo);
      contador += 1;
      return { scanId: `scan-${contador}` };
    },
    cancelar: async (scanId) => {
      cancelados.push(scanId);
    },
  };
}

/** Config injetada em memoria (sem disco). */
function fakeStore(inicial = null) {
  let atual = inicial;
  const escritas = [];
  return {
    escritas,
    ler: async () =>
      atual
        ? { estado: "known", enabled: atual.enabled, config: atual }
        : { estado: "unknown", motivo: "documento_ausente", enabled: false },
    guardar: async (config) => {
      escritas.push(config);
      atual = config;
    },
  };
}

function monitor(deteccao, { store = fakeStore(), analise, readOnly, manual, opcoes = {} } = {}) {
  return new UsbProtectionMonitor({
    deteccao,
    store,
    analise,
    readOnly,
    analiseManualAtiva: manual,
    agora: () => T1,
    ...opcoes,
  });
}

const READ_ONLY_OK = { verificar: () => ({ ok: true }) };
const READ_ONLY_FALTA = { verificar: () => ({ ok: false, motivo: "motor sem prova de leitura" }) };

function estado(snapshot, id) {
  return snapshot.devices.find((d) => d.id === id);
}

test("iniciar: monitor fica operacional e o baseline NUNCA e' autoanalisado", async () => {
  const deteccao = fakeDeteccao([[dispositivo("idA", "E:\\")]]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  const snapshot = await m.iniciar();
  assert.equal(snapshot.monitorStatus, "operational");
  assert.equal(snapshot.enabled, true);
  assert.equal(estado(snapshot, "idA").status, "detected");
  assert.match(estado(snapshot, "idA").limitation, /baseline|já presente/i);
  assert.deepEqual(analise.iniciados, [], "dispositivo ja presente na ativacao nao e' analisado sozinho");
});

test("opt-in desligado: dispositivos detetados mas sem fila, com motivo honesto", async () => {
  const deteccao = fakeDeteccao([[dispositivo("idA", "E:\\")]]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore(), analise, readOnly: READ_ONLY_OK });

  const snapshot = await m.iniciar();
  assert.equal(snapshot.enabled, false);
  assert.equal(estado(snapshot, "idA").status, "detected");
  assert.match(estado(snapshot, "idA").limitation, /opt-in|desligada/i);
  assert.deepEqual(analise.iniciados, []);
});

test("eixos separados: enabled=false nao impede o monitor de estar operacional", async () => {
  const deteccao = fakeDeteccao([[]]);
  const m = monitor(deteccao, { store: fakeStore(), readOnly: READ_ONLY_OK });
  const snapshot = await m.iniciar();
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.monitorStatus, "operational");
});

test("enumeracao falhada no inicio: unavailable com erro, nunca deteccao inventada", async () => {
  const deteccao = fakeDeteccao([new Error("powershell indisponivel")]);
  const m = monitor(deteccao, { readOnly: READ_ONLY_OK });
  const snapshot = await m.iniciar();
  assert.equal(snapshot.monitorStatus, "unavailable");
  assert.match(snapshot.error, /powershell indisponivel/);
  assert.deepEqual(snapshot.devices, []);
});

test("insercao nova com read-only provado: UMA analise, com a raiz real do dispositivo", async () => {
  const deteccao = fakeDeteccao([[], [dispositivo("idNovo", "F:\\", { label: "PEN" })]]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  const snapshot = await m.ciclo();

  assert.equal(estado(snapshot, "idNovo").status, "scanning");
  assert.equal(estado(snapshot, "idNovo").scanId, "scan-1");
  assert.deepEqual(analise.iniciados, [{ id: "idNovo", rootPath: "F:\\", rootPaths: ["F:\\"] }]);
});

test("BITE: read-only NAO provado bloqueia o AUTO no servico (nao e' so' a UI)", async () => {
  const deteccao = fakeDeteccao([[], [dispositivo("idNovo", "F:\\")]]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_FALTA });

  await m.iniciar();
  const snapshot = await m.ciclo();

  assert.equal(estado(snapshot, "idNovo").status, "detected");
  assert.match(estado(snapshot, "idNovo").limitation, /read-only/i);
  assert.deepEqual(analise.iniciados, [], "sem prova de leitura nao se comeca analise nenhuma");
});

test("analise manual ativa: insercao nova fica em fila (nunca duas analises globais)", async () => {
  const deteccao = fakeDeteccao([[], [dispositivo("idNovo", "F:\\")]]);
  const analise = fakeAnalise();
  let manual = true;
  const m = monitor(deteccao, {
    store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }),
    analise,
    readOnly: READ_ONLY_OK,
    manual: () => manual,
  });

  await m.iniciar();
  const emFila = await m.ciclo();
  assert.equal(estado(emFila, "idNovo").status, "queued");
  assert.deepEqual(analise.iniciados, []);

  manual = false;
  const depois = await m.ciclo();
  assert.equal(estado(depois, "idNovo").status, "scanning");
  assert.equal(analise.iniciados.length, 1);
});

test("fila limitada: a fila nao cresce sem limite", async () => {
  const deteccao = fakeDeteccao([[], [dispositivo("idA", "E:\\"), dispositivo("idB", "F:\\")]]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, {
    store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }),
    analise,
    readOnly: READ_ONLY_OK,
    manual: () => true,
    opcoes: { limiteFila: 1 },
  });

  await m.iniciar();
  const snapshot = await m.ciclo();

  assert.equal(estado(snapshot, "idA").status, "queued");
  assert.equal(estado(snapshot, "idB").status, "detected");
  assert.match(estado(snapshot, "idB").limitation, /fila/i);
});

test("removido em fila: item sai como removed (nao fica pendente para sempre)", async () => {
  const deteccao = fakeDeteccao([[], [dispositivo("idA", "E:\\")], []]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, {
    store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }),
    analise,
    readOnly: READ_ONLY_OK,
    manual: () => true,
  });

  await m.iniciar();
  await m.ciclo();
  const snapshot = await m.ciclo();
  assert.equal(estado(snapshot, "idA").status, "removed");
  assert.equal(estado(snapshot, "idA").present, false);
});

test("removido DURANTE a analise: cancela o proprio scan e NUNCA publica completed", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  deteccao.definir([dispositivo("idA", "E:\\")]);
  const aAnalisar = await m.ciclo();
  assert.equal(estado(aAnalisar, "idA").status, "scanning");

  deteccao.definir([]);
  const removido = await m.ciclo();
  assert.deepEqual(analise.cancelados, ["scan-1"]);
  assert.equal(estado(removido, "idA").status, "incomplete");
  assert.equal(estado(removido, "idA").present, false);
  assert.notEqual(estado(removido, "idA").status, "completed");
});

test("falha de enumeracao durante a analise: sem completed, sem transicoes, com erro", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  deteccao.definir([dispositivo("idA", "E:\\")]);
  await m.ciclo();
  deteccao.definir(new Error("CIM timeout"));
  const snapshot = await m.ciclo();

  assert.equal(snapshot.monitorStatus, "unavailable");
  assert.match(snapshot.error, /CIM timeout/);
  assert.equal(estado(snapshot, "idA").status, "scanning", "sem confirmacao fresca de presenca nao se transita nada");
  assert.deepEqual(analise.cancelados, []);
});

test("resultado so' e' publicado depois de uma enumeracao POSTERIOR (frescura estrutural)", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  deteccao.definir([dispositivo("idA", "E:\\")]);
  await m.ciclo();
  const leiturasNoFimDaAnalise = deteccao.leituras;

  assert.equal(m.aplicarResultado("scan-1", { scanId: "scan-1", status: "completed" }), true, "resultado da sessao em curso e' aceite");

  // Aceitar o resultado NAO enumera nada: ainda ninguem confirmou que a pen la' esta'.
  assert.equal(deteccao.leituras, leiturasNoFimDaAnalise, "aceitar o resultado não pode valer como confirmação");
  const retido = m.snapshot();
  assert.equal(estado(retido, "idA").status, "incomplete", "sem confirmacao fresca nao ha' completed");
  assert.equal(estado(retido, "idA").result, undefined, "o resultado fica retido, nao publicado");
  assert.match(estado(retido, "idA").limitation, /aguarda confirmação/i);

  // Enumeracao POSTERIOR (mesma identidade, mesma raiz) => publicado.
  const confirmado = await m.ciclo();
  assert.ok(deteccao.leituras > leiturasNoFimDaAnalise, "a confirmação exige uma enumeração nova");
  assert.equal(estado(confirmado, "idA").status, "completed");
  assert.deepEqual(estado(confirmado, "idA").result, { scanId: "scan-1", status: "completed" });
  assert.equal(estado(confirmado, "idA").limitation, undefined);
  assert.equal(estado(confirmado, "idA").present, true);

  // Remocao posterior: o resultado JA' confirmado mantem-se (present=false).
  deteccao.definir([]);
  const removido = await m.ciclo();
  assert.equal(estado(removido, "idA").status, "completed");
  assert.equal(estado(removido, "idA").present, false);
});

test("resultado retido + enumeracao falhada = NUNCA completed (incomplete com motivo)", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  deteccao.definir([dispositivo("idA", "E:\\")]);
  await m.ciclo();
  m.aplicarResultado("scan-1", { scanId: "scan-1", status: "completed" });
  deteccao.definir(new Error("CIM offline"));
  const snapshot = await m.ciclo();

  assert.equal(snapshot.monitorStatus, "unavailable");
  assert.equal(estado(snapshot, "idA").status, "incomplete", "sem enumeracao valida nao se publica desfecho");
  assert.equal(estado(snapshot, "idA").result, undefined);
});

test("dispositivo removido antes da confirmacao: resultado NAO publicado (incomplete, present=false)", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  deteccao.definir([dispositivo("idA", "E:\\")]);
  await m.ciclo();
  m.aplicarResultado("scan-1", { scanId: "scan-1", status: "completed" });
  deteccao.definir([]);
  const snapshot = await m.ciclo();

  const item = estado(snapshot, "idA");
  assert.equal(item.present, false);
  assert.equal(item.status, "incomplete");
  assert.equal(item.result, undefined, "nunca 'pen limpa' sobre um volume que ja' saiu");
  assert.match(item.limitation, /não publicado/i);
  assert.equal(item.scanId, "scan-1", "a sessao real continua identificada para inspeccao");
});

test("mesma identidade noutra letra antes da confirmacao: resultado NAO publicado", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  deteccao.definir([dispositivo("idA", "E:\\")]);
  await m.ciclo();
  m.aplicarResultado("scan-1", { scanId: "scan-1", status: "completed" });
  deteccao.definir([dispositivo("idA", "G:\\")]);
  const snapshot = await m.ciclo();

  const item = estado(snapshot, "idA");
  assert.equal(item.present, true);
  assert.notEqual(item.status, "completed");
  assert.equal(item.result, undefined);
  assert.match(item.limitation, /raiz mudou/i);
});

test("desativar com resultado retido: o resultado nunca chega a ser publicado", async () => {
  const deteccao = fakeDeteccao([[], [dispositivo("idA", "E:\\")]]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  await m.ciclo();
  m.aplicarResultado("scan-1", { scanId: "scan-1", status: "completed" });
  const snapshot = await m.configurar({ enabled: false });

  const item = estado(snapshot, "idA");
  assert.equal(item.result, undefined);
  assert.equal(item.status, "incomplete");
  assert.match(item.limitation, /não publicado/i);
});

test("dispositivo muda entre a enumeração e o arranque: NUNCA arranca (identidade não revalidada)", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  // A MESMA letra E:, outra identidade: a insercao mudou entre a enumeração do
  // ciclo e a revalidação pre-arranque.
  let chamadas = 0;
  deteccao.definir(() => {
    chamadas += 1;
    return chamadas === 1 ? [dispositivo("idA", "E:\\")] : [dispositivo("idB", "E:\\")];
  });
  const snapshot = await m.ciclo();

  assert.deepEqual(analise.iniciados, [], "com a identidade trocada, NADA arranca sobre a letra E:");
  assert.equal(estado(snapshot, "idA").status, "failed");
  assert.match(estado(snapshot, "idA").limitation, /identidade não revalidada/i);

  // idB so' e' visto como sessao nova na enumeracao seguinte — e essa arranca.
  deteccao.definir([dispositivo("idB", "E:\\")]);
  const depois = await m.ciclo();
  assert.equal(estado(depois, "idB").status, "scanning");
  assert.equal(analise.iniciados.length, 1);
  assert.equal(analise.iniciados[0].id, "idB");
  assert.equal(analise.iniciados[0].rootPath, "E:\\");
});

test("reuso da letra durante a analise: a sessao antiga nao herda o resultado", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  deteccao.definir([dispositivo("idA", "E:\\")]);
  await m.ciclo();
  deteccao.definir([dispositivo("idB", "E:\\")]);
  const snapshot = await m.ciclo();

  assert.equal(estado(snapshot, "idA").status, "incomplete", "idA desapareceu enquanto analisava");
  assert.equal(estado(snapshot, "idB").status, "scanning", "idB e' uma insercao nova com identidade propria");
  assert.equal(estado(snapshot, "idB").scanId, "scan-2");
  assert.notEqual(estado(snapshot, "idA").scanId, estado(snapshot, "idB").scanId);
  assert.equal(m.aplicarResultado("scan-1", { status: "completed" }), false, "evento tardio da sessao antiga e' ignorado");
});

test("reconexao: o mesmo id que reaparece e' sessao nova (confirmacao fresca, sem herdar resultado)", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  deteccao.definir([dispositivo("idA", "E:\\")]);
  await m.ciclo();
  m.aplicarResultado("scan-1", { status: "completed" });
  deteccao.definir([]);
  const removido = await m.ciclo(); // removido antes da confirmacao
  assert.equal(estado(removido, "idA").result, undefined, "o resultado retido morreu com o dispositivo");

  deteccao.definir([dispositivo("idA", "E:\\")]);
  const reconectado = await m.ciclo();

  const item = estado(reconectado, "idA");
  assert.equal(item.present, true);
  assert.equal(item.status, "scanning", "reconexao exige analise fresca");
  assert.equal(item.result, undefined, "nao herda o resultado anterior");
  assert.equal(item.scanId, "scan-2");
});

test("evento tardio desconhecido nao muda nada", async () => {
  const deteccao = fakeDeteccao([[]]);
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), readOnly: READ_ONLY_OK });
  await m.iniciar();
  assert.equal(m.aplicarResultado("scan-inexistente", { status: "completed" }), false);
});

test("uma enumeracao em curso: dois ciclos concorrentes partilham a mesma leitura", async () => {
  let resolver;
  let leituras = 0;
  const deteccao = {
    listar: () => {
      leituras += 1;
      return new Promise((resolve) => {
        resolver = resolve;
      });
    },
  };
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), readOnly: READ_ONLY_OK });

  const a = m.ciclo();
  const b = m.ciclo();
  resolver([]);
  await Promise.all([a, b]);
  assert.equal(leituras, 1, "o poll bounded nunca corre duas enumeracoes em paralelo");
});

test("desativar: remove a fila, cancela APENAS a analise USB propria", async () => {
  const deteccao = fakeDeteccao([[], [dispositivo("idA", "E:\\"), dispositivo("idB", "F:\\")]]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, {
    store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }),
    analise,
    readOnly: READ_ONLY_OK,
    manual: () => true,
  });

  await m.iniciar();
  await m.ciclo();
  assert.equal(estado(m.snapshot(), "idA").status, "queued");

  const snapshot = await m.configurar({ enabled: false });
  assert.equal(snapshot.enabled, false);
  assert.equal(estado(snapshot, "idA").status, "removed");
  assert.equal(estado(snapshot, "idB").status, "removed");
  assert.deepEqual(analise.cancelados, [], "nada foi cancelado porque nada era nosso a analisar");
});

test("desativar cancela o proprio scan e deixa claro que nunca toca em analise manual", async () => {
  const deteccao = fakeDeteccao([[], [dispositivo("idA", "E:\\")]]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  await m.ciclo();
  const snapshot = await m.configurar({ enabled: false });

  assert.deepEqual(analise.cancelados, ["scan-1"], "cancela exactamente o scanId que este modulo iniciou");
  assert.equal(estado(snapshot, "idA").status, "incomplete");
  assert.equal(snapshot.enabled, false);
});

test("configurar recusa enabled nao booleano sem efeitos", async () => {
  const store = fakeStore();
  const m = monitor(fakeDeteccao([[]]), { store });
  await m.iniciar();
  await assert.rejects(() => m.configurar({ enabled: "sim" }), /boolean/);
  await assert.rejects(() => m.configurar({}), /boolean/);
  assert.deepEqual(store.escritas, [], "input invalido nao escreve configuracao nenhuma");
});

test("ativar nao muda o que ja' estava presente: so' insercoes novas sao elegiveis", async () => {
  const deteccao = fakeDeteccao([
    [dispositivo("idAntigo", "E:\\")],
    [dispositivo("idAntigo", "E:\\")],
    [dispositivo("idAntigo", "E:\\"), dispositivo("idNovo", "F:\\")],
  ]);
  const analise = fakeAnalise();
  const store = fakeStore();
  const m = monitor(deteccao, { store, analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  await m.configurar({ enabled: true });

  // 1.ª enumeração depois de ligar: consome o baseline da ativação — nada é
  // analisado e o que já estava presente fica `detected` (política de baseline).
  const posAtivacao = await m.ciclo();
  assert.deepEqual(analise.iniciados, [], "nada e' analisado na 1.ª enumeração após a ativação");
  assert.equal(estado(posAtivacao, "idAntigo").status, "detected");
  assert.match(estado(posAtivacao, "idAntigo").limitation, /baseline|já presente/i);

  // 2.ª enumeração: o dispositivo que aparece agora é uma inserção real.
  const snapshot = await m.ciclo();
  assert.equal(estado(snapshot, "idAntigo").status, "detected");
  assert.match(estado(snapshot, "idAntigo").limitation, /baseline|já presente/i);
  assert.equal(estado(snapshot, "idNovo").status, "scanning");
  assert.equal(store.escritas.length, 1);
  assert.equal(store.escritas[0].version, 1, "a config gravada mantem version 1");
});

test("snapshot bounded: limite de dispositivos e' respeitado", async () => {
  const muitos = Array.from({ length: 30 }, (_, i) => dispositivo(`id${String(i).padStart(2, "0")}`, `${String.fromCharCode(70 + i)}:\\`));
  const deteccao = fakeDeteccao([[], muitos]);
  const m = monitor(deteccao, {
    store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }),
    readOnly: READ_ONLY_OK,
    opcoes: { limiteDispositivos: 10 },
  });

  await m.iniciar();
  const snapshot = await m.ciclo();
  assert.equal(snapshot.devices.length, 10);
});

test("snapshot bounded: o dispositivo em fila tem prioridade sobre um removido", async () => {
  const deteccao = fakeDeteccao([[], [dispositivo("idA", "E:\\")], [dispositivo("idB", "F:\\")]]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, {
    store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }),
    analise,
    readOnly: READ_ONLY_OK,
    manual: () => true,
    opcoes: { limiteDispositivos: 1 },
  });

  await m.iniciar();
  await m.ciclo();
  const snapshot = await m.ciclo();
  assert.equal(snapshot.devices.length, 1);
  assert.equal(snapshot.devices[0].id, "idB", "o corte prefere queued a removed, nao a ordem alfabetica");
});

// ── Correcoes P0 da revisao do Codex (13/10) ───────────────────────────────

test("duas inserções na MESMA enumeração: só UMA análise global arranca (slot dinâmico)", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  deteccao.definir([dispositivo("idA", "E:\\"), dispositivo("idB", "F:\\")]);
  const snapshot = await m.ciclo();

  assert.equal(analise.iniciados.length, 1, "nunca duas análises globais ao mesmo tempo");
  assert.equal(analise.iniciados[0].id, "idA");
  assert.equal(estado(snapshot, "idA").status, "scanning");
  assert.equal(estado(snapshot, "idB").status, "queued", "a segunda reserva lugar na fila, não arranca");
  assert.equal(estado(snapshot, "idB").scanId, undefined);

  // Terminada a primeira, a segunda pode arrancar (por ordem de fila).
  m.aplicarResultado("scan-1", { scanId: "scan-1", status: "completed" });
  const depois = await m.ciclo();
  assert.equal(estado(depois, "idA").status, "completed", "a primeira confirma-se na enumeração fresca");
  assert.equal(estado(depois, "idB").status, "scanning", "a segunda só arranca quando o slot está livre");
  assert.equal(analise.iniciados.length, 2);
});

test("desfecho cancelled/failed/desconhecido: estado honesto, NUNCA completed e sem resultado", async () => {
  for (const [desfecho, esperado] of [
    ["cancelled", "cancelled"],
    ["failed", "failed"],
    ["incomplete", "incomplete"],
    [null, "incomplete"],
  ]) {
    const deteccao = deteccaoMutavel([]);
    const analise = fakeAnalise();
    const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

    await m.iniciar();
    deteccao.definir([dispositivo("idA", "E:\\")]);
    await m.ciclo();

    const resultado = desfecho === null ? { scanId: "scan-1" } : { scanId: "scan-1", status: desfecho };
    assert.equal(m.aplicarResultado("scan-1", resultado), true);

    const item = estado(m.snapshot(), "idA");
    assert.equal(item.status, esperado, `desfecho ${desfecho}`);
    assert.notEqual(item.status, "completed");
    assert.equal(item.result, undefined, "nenhum desfecho é publicado");

    // E uma enumeração posterior não transforma isto num "completed".
    const depois = await m.ciclo();
    assert.equal(estado(depois, "idA").status, esperado, `desfecho ${desfecho} continua honesto`);
    assert.equal(estado(depois, "idA").result, undefined);
    assert.equal(analise.iniciados.length, 1, "não re-arranca em loop sobre a mesma inserção");
  }
});

test("RED Codex: análise manual activa durante vários ciclos — nada arranca; só depois de manual=false", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  let manual = true;
  const m = monitor(deteccao, {
    store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }),
    analise,
    readOnly: READ_ONLY_OK,
    manual: () => manual,
  });

  await m.iniciar();
  deteccao.definir([dispositivo("idA", "E:\\")]);
  const primeiro = await m.ciclo();
  assert.equal(estado(primeiro, "idA").status, "queued");

  for (let i = 0; i < 3; i += 1) {
    const ciclo = await m.ciclo();
    assert.equal(
      estado(ciclo, "idA").status,
      "queued",
      `ciclo ${i + 2}: continua em fila enquanto a análise manual corre (nunca arranca)`,
    );
  }
  assert.deepEqual(analise.iniciados, [], "com análise manual activa NADA arranca");

  manual = false;
  const depois = await m.ciclo();
  assert.equal(estado(depois, "idA").status, "scanning", "libertado o slot, a fila arranca");
  assert.equal(analise.iniciados.length, 1, "arranca UMA vez");
});

test("proteção desligada com item em fila: não arranca agora nem depois de religar", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  let manual = true;
  const m = monitor(deteccao, {
    store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }),
    analise,
    readOnly: READ_ONLY_OK,
    manual: () => manual,
  });

  await m.iniciar();
  deteccao.definir([dispositivo("idA", "E:\\")]);
  await m.ciclo(); // fica em fila
  manual = false;

  await m.configurar({ enabled: false });
  for (let i = 0; i < 2; i += 1) await m.ciclo();
  await m.configurar({ enabled: true });
  const depois = await m.ciclo();

  assert.deepEqual(analise.iniciados, [], "o opt-in vale em todo o início/queued: nada arranca");
  assert.notEqual(estado(depois, "idA").status, "scanning");
});

test("race: configure desliga durante a enumeração fresca de arranque ⇒ não arranca", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, {
    store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }),
    analise,
    readOnly: READ_ONLY_OK,
  });

  await m.iniciar();
  let chamadas = 0;
  deteccao.definir(async () => {
    chamadas += 1;
    // A segunda leitura e' a revalidacao pre-arranque: desligar aqui e' a race.
    if (chamadas === 2) await m.configurar({ enabled: false });
    return [dispositivo("idA", "E:\\")];
  });

  const snapshot = await m.ciclo();

  assert.deepEqual(analise.iniciados, [], "desligar durante a enumeração fresca não pode deixar arrancar");
  assert.notEqual(estado(snapshot, "idA").status, "scanning");
  assert.equal(snapshot.enabled, false);
});

test("uma inserção é analisada UMA vez: presença continuada não re-arranca a cada ciclo", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  deteccao.definir([dispositivo("idA", "E:\\")]);
  await m.ciclo();
  m.aplicarResultado("scan-1", { scanId: "scan-1", status: "completed" });
  await m.ciclo(); // confirmação fresca => completed

  await m.ciclo();
  const terceiro = await m.ciclo();
  assert.equal(analise.iniciados.length, 1, "a mesma pen não volta a ser analisada sem nova inserção");
  assert.equal(estado(terceiro, "idA").status, "completed", "o desfecho confirmado mantém-se");
  assert.equal(estado(terceiro, "idA").scanId, "scan-1");
});

test("histórico terminal é podado: o mapa interno não cresce com as pens que passam", async () => {
  const deteccao = deteccaoMutavel([]);
  const m = monitor(deteccao, {
    store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }),
    readOnly: READ_ONLY_OK,
    manual: () => true, // nada arranca: o que se mede é o histórico terminal
    opcoes: { limiteHistoricoTerminal: 3 },
  });

  await m.iniciar();
  for (let i = 0; i < 12; i += 1) {
    deteccao.definir([dispositivo(`pen-${i}`, `${String.fromCharCode(70 + i)}:\\`)]);
    await m.ciclo();
    deteccao.definir([]);
    await m.ciclo();
  }

  assert.ok(
    m.dispositivosConhecidos() <= 3,
    `o mapa interno tem de ficar bounded (ficou com ${m.dispositivosConhecidos()})`,
  );
});

test("disco-part-volume: duas raizes confirmadas — UMA analise, na principal (E:\\)", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  deteccao.definir([dispositivo("usb1", "E:\\", { rootPaths: ["E:\\", "F:\\"], label: "PEN" })]);
  const snapshot = await m.ciclo();

  // Uma so' analise global, na raiz PRINCIPAL: o segundo volume nunca abre um
  // scan proprio (o slot global e' unico por desenho).
  assert.deepEqual(analise.iniciados, [{ id: "usb1", rootPath: "E:\\", rootPaths: ["E:\\", "F:\\"] }]);
  assert.equal(estado(snapshot, "usb1").status, "scanning");
  // O estado NUNCA pode parecer cobertura total do disco: F:\ fica declarado.
  assert.match(estado(snapshot, "usb1").limitation, /cobertura parcial/i);
  assert.match(estado(snapshot, "usb1").limitation, /F:\\/);
});

test("disco-part-volume: a cobertura parcial sobrevive ao desfecho terminal (nunca 'todo o disco')", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  deteccao.definir([dispositivo("usb1", "E:\\", { rootPaths: ["E:\\", "F:\\"] })]);
  await m.ciclo();
  m.aplicarResultado("scan-1", { scanId: "scan-1", status: "completed" });
  const confirmado = await m.ciclo();

  assert.equal(estado(confirmado, "usb1").status, "completed");
  assert.deepEqual(estado(confirmado, "usb1").result, { scanId: "scan-1", status: "completed" });
  assert.match(estado(confirmado, "usb1").limitation, /cobertura parcial/i);
  assert.match(estado(confirmado, "usb1").limitation, /E:\\/);
  assert.match(estado(confirmado, "usb1").limitation, /F:\\/);
});

test("controlo: um dispositivo de UMA raiz nunca ganha limitacao de cobertura", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK });

  await m.iniciar();
  deteccao.definir([dispositivo("usb1", "E:\\")]);
  await m.ciclo();
  const aAnalisar = m.snapshot();
  assert.equal(estado(aAnalisar, "usb1").limitation, undefined, "uma raiz = cobertura total, sem limitacao inventada");

  m.aplicarResultado("scan-1", { scanId: "scan-1", status: "completed" });
  const confirmado = await m.ciclo();
  assert.equal(estado(confirmado, "usb1").status, "completed");
  assert.equal(estado(confirmado, "usb1").limitation, undefined);
});

test("arranque a partir da fila nao herda o motivo de espera ('aguarda na fila' a analisar)", async () => {
  const deteccao = deteccaoMutavel([]);
  const analise = fakeAnalise();
  let manual = true;
  const m = monitor(deteccao, { store: fakeStore({ version: 1, enabled: true, updatedAt: T0.toISOString() }), analise, readOnly: READ_ONLY_OK, manual: () => manual });

  await m.iniciar();
  deteccao.definir([dispositivo("usb1", "E:\\")]);
  const emFila = await m.ciclo();
  assert.equal(estado(emFila, "usb1").status, "queued");
  assert.match(estado(emFila, "usb1").limitation, /fila/i);

  manual = false;
  const aAnalisar = await m.ciclo();
  assert.equal(estado(aAnalisar, "usb1").status, "scanning");
  assert.equal(estado(aAnalisar, "usb1").limitation, undefined, "em análise real nao se mostra um motivo de espera já falso");
});
