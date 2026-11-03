// §10 Linux Lite — o detetor POSIX serve a porta do monitor USB existente.
import test from "node:test";
import assert from "node:assert/strict";

import { criarDeteccaoUsbPosix } from "../dist/usb-detection-adapter-posix.js";
import { UsbReadOnlyScanAdapter, criarConfirmacaoPresencaUsb } from "../dist/usb-scan-adapter.js";

const PEN = {
  ok: true,
  dispositivos: [
    {
      id: "usb-serial:ABCD1234",
      rootPath: "/mnt/pen",
      rootPaths: ["/mnt/pen", "/mnt/pen/docs"],
      identityProvenance: "sysfs-serial",
      nomeBloco: "sdb",
      dispositivo: "8:16",
      amovivel: true,
      serial: "ABCD1234",
    },
  ],
  observados: [],
  semVolume: [],
  naoAtribuidos: [],
  ilegiveis: 0,
  motivo: null,
};

const falha = (motivo) => ({
  ok: false,
  dispositivos: [],
  observados: [],
  semVolume: [],
  naoAtribuidos: [],
  ilegiveis: 0,
  motivo,
});

test("o adapter publica só os campos que a porta do monitor expõe", async () => {
  const deteccao = criarDeteccaoUsbPosix({ detetar: () => PEN });
  const [pen] = await deteccao.listar();
  assert.deepEqual(pen, {
    id: "usb-serial:ABCD1234",
    rootPath: "/mnt/pen",
    rootPaths: ["/mnt/pen", "/mnt/pen/docs"],
    identityProvenance: "sysfs-serial",
  });
});

test("sem `listarPendentes`: o estado de espera do Windows nomeia uma letra", async () => {
  const deteccao = criarDeteccaoUsbPosix({ detetar: () => PEN });
  assert.equal(deteccao.listarPendentes, undefined);
});

test("falha de leitura lança com o motivo: ausência não é «sem dispositivos»", async () => {
  const deteccao = criarDeteccaoUsbPosix({
    detetar: () => falha("A tabela de dispositivos de bloco (/sys/block) não pôde ser lida (EACCES)."),
  });
  await assert.rejects(deteccao.listar(), /sys\/block/);
});

test("cada pedido lê fresco — a confirmação de presença não pode receber leitura velha", async () => {
  let chamadas = 0;
  const deteccao = criarDeteccaoUsbPosix({
    detetar: () => {
      chamadas += 1;
      return PEN;
    },
  });
  await deteccao.listar();
  await deteccao.listar();
  assert.equal(chamadas, 2);
});

test("a confirmação terminal aceita o mesmo pen na mesma raiz", async () => {
  let ciclo = 0;
  const deteccao = criarDeteccaoUsbPosix({
    detetar: () => (ciclo++ === 0 ? PEN : { ...PEN, dispositivos: [{ ...PEN.dispositivos[0], rootPaths: ["/mnt/pen"] }] }),
  });
  const confirmar = criarConfirmacaoPresencaUsb(deteccao);
  const resultado = await confirmar.confirmar({ id: "usb-serial:ABCD1234", rootPath: "/mnt/pen", rootPaths: ["/mnt/pen"] });
  assert.deepEqual(resultado, { ok: true });
});

test("a confirmação recusa quando o pen já não está — e o scan fica inseguro", async () => {
  const deteccao = criarDeteccaoUsbPosix({ detetar: () => ({ ...PEN, dispositivos: [] }) });
  const confirmar = criarConfirmacaoPresencaUsb(deteccao);
  const resultado = await confirmar.confirmar({ id: "usb-serial:ABCD1234", rootPath: "/mnt/pen", rootPaths: ["/mnt/pen"] });
  assert.equal(resultado.ok, false);
  assert.match(resultado.motivo, /ausente no fim da análise/);
});

test("identidade de índice é recusada na confirmação, em Linux como no Windows", async () => {
  const reciclavel = {
    ...PEN,
    dispositivos: [{ ...PEN.dispositivos[0], id: "usb-index:sdd", identityProvenance: "disk-index-fallback" }],
  };
  const confirmar = criarConfirmacaoPresencaUsb(criarDeteccaoUsbPosix({ detetar: () => reciclavel }));
  const resultado = await confirmar.confirmar({ id: "usb-index:sdd", rootPath: "/mnt/pen", rootPaths: ["/mnt/pen"] });
  assert.equal(resultado.ok, false);
  assert.match(resultado.motivo, /índice de disco/);
});

test("o adapter read-only arranca na raiz do detetor Linux, sempre com readOnly", async () => {
  const pedidos = [];
  const adapter = new UsbReadOnlyScanAdapter({
    scans: {
      startScan: async (tipo, alvo, opcoes) => {
        pedidos.push({ tipo, alvo, opcoes });
        return "scan-1";
      },
      cancelScan: () => {},
      getScan: () => ({ status: "running" }),
    },
    capacidade: () => ({ nome: "usb-readonly", versao: 1 }),
    confirmarPresenca: criarConfirmacaoPresencaUsb(criarDeteccaoUsbPosix({ detetar: () => PEN })),
  });
  const [pen] = await criarDeteccaoUsbPosix({ detetar: () => PEN }).listar();
  const { scanId } = await adapter.iniciar({
    id: pen.id,
    rootPath: pen.rootPath,
    rootPaths: pen.rootPaths,
  });
  assert.equal(scanId, "scan-1");
  assert.equal(pedidos[0].tipo, "custom");
  assert.equal(pedidos[0].alvo, "/mnt/pen");
  assert.equal(pedidos[0].opcoes.readOnly, true);
  assert.equal(typeof pedidos[0].opcoes.confirmarTerminal, "function");
});
