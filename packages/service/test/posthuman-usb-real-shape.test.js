/**
 * POSTHUMAN13 — forma REAL das 4 queries CIM ate' ao monitor do servico.
 *
 * Porque existe: na maquina real (13/10, so' metadados; nenhum conteudo de volume
 * lido) as 4 queries produziam ZERO dispositivos porque os links
 * `Win32_LogicalDiskToPartition` chegam serializados como
 * `{ CimClass, CimInstanceProperties, CimSystemProperties }` — o DeviceID vive
 * DENTRO do texto de CimInstanceProperties. Estes testes prendem a cadeia REAL:
 * executor fake com a forma exacta medida → adaptador de deteccao do servico →
 * monitor → adapter read-only → porta de ScanManager (fake).
 *
 * RED ANTES DO FIX (registado, nao como "falha de produto", mas como gate):
 *  - o teste "primeira enumeracao falha..." FALHA no codigo anterior: depois de
 *    uma primeira enumeracao falhada, o dispositivo que ja' estava presente era
 *    tratado como insercao nova no ciclo seguinte e o auto-scan arrancava contra
 *    a politica de baseline;
 *  - os testes de deteccao falhavam antes do fix do parser CIM (0 dispositivos).
 *
 * Isolamento: nenhum PowerShell corre, nenhum CIM real, nenhum volume tocado,
 * nenhuma analise real. Fixtures so' com ESTRUTURA e identificadores FICTICIOS.
 *
 * Uso: node --test packages/service/test/posthuman-usb-real-shape.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { USB_CIM_QUERIES, UsbStorageEnumerator } from "@cybersafe/native-windows";
import { criarDeteccaoUsbNativa } from "../dist/usb-detection-adapter.js";
import { UsbProtectionMonitor } from "../dist/usb-protection.js";
import {
  UsbReadOnlyScanAdapter,
  USB_READONLY_CONTRATO,
  criarConfirmacaoPresencaUsb,
} from "../dist/usb-scan-adapter.js";

const T0 = "2026-10-13T18:00:00.000Z";

// ── Schema CIM publico — ordem real da instancia (so' nomes) ────────────────

const NOMES_PARTICAO =
  "Caption Description InstallDate Name Status Availability ConfigManagerErrorCode ConfigManagerUserConfig CreationClassName DeviceID ErrorCleared ErrorDescription LastErrorCode PNPDeviceID PowerManagementCapabilities PowerManagementSupported StatusInfo SystemCreationClassName SystemName Access BlockSize ErrorMethodology NumberOfBlocks Purpose Bootable PrimaryPartition BootPartition DiskIndex HiddenSectors Index RewritePartition Size StartingOffset Type".split(
    " ",
  );

const NOMES_VOLUME =
  "Caption Description InstallDate Name Status Availability ConfigManagerErrorCode ConfigManagerUserConfig CreationClassName DeviceID ErrorCleared ErrorDescription LastErrorCode PNPDeviceID PowerManagementCapabilities PowerManagementSupported StatusInfo SystemCreationClassName SystemName Access BlockSize ErrorMethodology NumberOfBlocks Purpose FreeSpace Size Compressed DriveType FileSystem MaximumComponentLength MediaType ProviderName QuotasDisabled QuotasIncomplete QuotasRebuilding SupportsDiskQuotas SupportsFileBasedCompression VolumeDirty VolumeName VolumeSerialNumber".split(
    " ",
  );

/** Blob real (profundidade por omissao): so' o DeviceID valorizado. */
function refBlob(nomes, valor) {
  return {
    CimClass: "ROOT/cimv2:Win32_DiskPartition",
    CimInstanceProperties: nomes.map((nome) => (nome === "DeviceID" ? `DeviceID = "${valor}"` : nome)).join(" "),
    CimSystemProperties: "Microsoft.Management.Infrastructure.CimSystemProperties",
  };
}

// ── Dispositivos FICTICIOS (estrutura real) ─────────────────────────────────

const PEN = {
  index: 9,
  interfaceType: "USB",
  mediaType: "Removable Media",
  serial: "PEN-POSTHUMAN-FICTICIA",
  pnp: "USBSTOR\\DISK&VEN_FICTICIA&PROD_PEN&REV_1.00\\PEN-POSTHUMAN-FICTICIA&0",
  letter: "Q:",
  label: "PEN FICTICIA",
};

const PEN_HDD_FIXO = {
  index: 8,
  interfaceType: "USB",
  mediaType: "Fixed hard disk media",
  serial: "HDD-POSTHUMAN-FICTICIO",
  letter: "R:",
  label: "HDD FICTICIO",
  driveType: 3,
};

const SATA_REMOVIVEL = {
  index: 0,
  interfaceType: "SATA",
  mediaType: "Removable Media",
  serial: "NAO-USB-FICTICIO",
  letter: "S:",
  label: "SATA FICTICIO",
};

const SEM_IDENTIDADE = {
  index: 7,
  interfaceType: "USB",
  mediaType: "Removable Media",
  letter: "T:",
  label: "SEM SERIAL FICTICIA",
};

/** Mundo CIM cru (PascalCase) tal como o executor real o entrega ao enumerador. */
function mundoCom(dispositivos) {
  const disks = [];
  const partitions = [];
  const links = [];
  const volumes = [];
  for (const d of dispositivos) {
    disks.push({
      Index: d.index,
      InterfaceType: d.interfaceType,
      MediaType: d.mediaType,
      ...(d.serial !== undefined ? { SerialNumber: d.serial } : {}),
      ...(d.pnp !== undefined ? { PNPDeviceID: d.pnp } : {}),
      Size: 4_000_000_000,
    });
    partitions.push({ DiskIndex: d.index, DeviceID: `Disk #${d.index}, Partition #0`, Type: "FAT32" });
    links.push({
      Antecedent: refBlob(NOMES_PARTICAO, `Disk #${d.index}, Partition #0`),
      Dependent: refBlob(NOMES_VOLUME, d.letter),
    });
    volumes.push({ DeviceID: d.letter, VolumeName: d.label ?? "", DriveType: d.driveType ?? 2, Size: 3_990_000_000 });
  }
  return { disks, partitions, links, volumes };
}

/** Executor fake: devolve o mundo actual a cada query (nunca corre PowerShell). */
function executorDoMundo(lerMundo) {
  return async (script) => {
    const mundo = lerMundo();
    if (script === USB_CIM_QUERIES.disks) return mundo.disks;
    if (script === USB_CIM_QUERIES.partitions) return mundo.partitions;
    if (script === USB_CIM_QUERIES.links) return mundo.links;
    return mundo.volumes;
  };
}

function storeFixo(enabledInicial) {
  const estado = { enabled: enabledInicial };
  return {
    escritas: [],
    async ler() {
      return { estado: "known", enabled: estado.enabled, config: { version: 1, enabled: estado.enabled, updatedAt: T0 } };
    },
    async guardar(config) {
      this.escritas.push(config);
      estado.enabled = config.enabled;
    },
  };
}

function analiseFake() {
  const iniciados = [];
  const cancelados = [];
  return {
    iniciados,
    cancelados,
    async iniciar(alvo) {
      iniciados.push(alvo);
      return { scanId: `scan-posthuman-${iniciados.length}` };
    },
    async cancelar(id) {
      cancelados.push(id);
    },
  };
}

const READ_ONLY_OK = { verificar: () => ({ ok: true }) };

// ── Testes ──────────────────────────────────────────────────────────────────

test("deteccao e2e: forma real do CIM → dispositivo com identidade, raiz e label", async () => {
  const deteccao = criarDeteccaoUsbNativa({ executor: executorDoMundo(() => mundoCom([PEN])) });
  const dispositivos = await deteccao.listar();
  assert.equal(dispositivos.length, 1);
  assert.equal(dispositivos[0].id, "usb-serial:PEN-POSTHUMAN-FICTICIA");
  assert.equal(dispositivos[0].identityProvenance, "disk-serial");
  assert.equal(dispositivos[0].rootPath, "Q:\\");
  assert.deepEqual(dispositivos[0].rootPaths, ["Q:\\"]);
  assert.equal(dispositivos[0].label, "PEN FICTICIA");
});

test("antes do opt-in: dispositivo detetado, sem analise automatica (motivo honesto)", async () => {
  const deteccao = criarDeteccaoUsbNativa({ executor: executorDoMundo(() => mundoCom([PEN])) });
  const analise = analiseFake();
  const monitor = new UsbProtectionMonitor({ deteccao, store: storeFixo(false), analise, readOnly: READ_ONLY_OK });
  const snapshot = await monitor.iniciar();
  const estado = snapshot.devices.find((d) => d.id === "usb-serial:PEN-POSTHUMAN-FICTICIA");
  assert.ok(estado);
  assert.equal(estado.status, "detected");
  assert.match(estado.limitation ?? "", /opt-in/i);
  assert.deepEqual(analise.iniciados, []);
});

test("chegada com opt-in: readOnly forcado e confirmacao terminal por enumeracao fresca", async () => {
  let presente = false;
  const deteccao = criarDeteccaoUsbNativa({ executor: executorDoMundo(() => mundoCom(presente ? [PEN] : [])) });
  const scans = {
    chamadas: [],
    canceladas: [],
    async startScan(type, targetPath, options) {
      scans.chamadas.push({ type, targetPath, options });
      return "scan-posthuman-1";
    },
    cancelScan(id) {
      scans.canceladas.push(id);
    },
    getScan() {
      return undefined;
    },
  };
  const adapter = new UsbReadOnlyScanAdapter({
    scans,
    capacidade: () => USB_READONLY_CONTRATO,
    confirmarPresenca: criarConfirmacaoPresencaUsb(deteccao),
  });
  const monitor = new UsbProtectionMonitor({ deteccao, store: storeFixo(true), analise: adapter, readOnly: adapter });

  await monitor.iniciar(); // primeira enumeracao: vazio
  presente = true;
  const snapshot = await monitor.ciclo();
  const estado = snapshot.devices.find((d) => d.id === "usb-serial:PEN-POSTHUMAN-FICTICIA");
  assert.ok(estado, "o dispositivo tem de aparecer com a forma real");
  assert.equal(estado.status, "scanning");
  assert.equal(scans.chamadas.length, 1);
  assert.equal(scans.chamadas[0].type, "custom");
  assert.equal(scans.chamadas[0].targetPath, "Q:\\");
  assert.equal(scans.chamadas[0].options.readOnly, true, "o scan USB NUNCA corre mutavel");
  assert.equal(typeof scans.chamadas[0].options.confirmarTerminal, "function");
  const confirmacao = await scans.chamadas[0].options.confirmarTerminal();
  assert.deepEqual(confirmacao, { ok: true });
});

test("removido durante a analise: cancela o proprio scan e nunca publica completed", async () => {
  let presente = false;
  const deteccao = criarDeteccaoUsbNativa({ executor: executorDoMundo(() => mundoCom(presente ? [PEN] : [])) });
  const scans = {
    chamadas: [],
    canceladas: [],
    async startScan() {
      return "scan-posthuman-1";
    },
    cancelScan(id) {
      scans.canceladas.push(id);
    },
    getScan() {
      return undefined;
    },
  };
  const adapter = new UsbReadOnlyScanAdapter({ scans, capacidade: () => USB_READONLY_CONTRATO });
  const monitor = new UsbProtectionMonitor({ deteccao, store: storeFixo(true), analise: adapter, readOnly: adapter });

  await monitor.iniciar();
  presente = true;
  await monitor.ciclo();
  presente = false;
  const snapshot = await monitor.ciclo();
  assert.deepEqual(scans.canceladas, ["scan-posthuman-1"]);
  const estado = snapshot.devices.find((d) => d.id === "usb-serial:PEN-POSTHUMAN-FICTICIA");
  assert.equal(estado.status, "incomplete");
  assert.equal(estado.present, false);
});

test("removivel vs fixo vs nao-USB: o TRANSPORTE e' que decide (a letra nao)", async () => {
  const pen = criarDeteccaoUsbNativa({ executor: executorDoMundo(() => mundoCom([PEN])) });
  const hddUsb = criarDeteccaoUsbNativa({ executor: executorDoMundo(() => mundoCom([PEN_HDD_FIXO])) });
  const sata = criarDeteccaoUsbNativa({ executor: executorDoMundo(() => mundoCom([SATA_REMOVIVEL])) });

  const penLista = await pen.listar();
  const hddLista = await hddUsb.listar();
  const sataLista = await sata.listar();

  assert.equal(penLista.length, 1, "USB removivel: detetado");
  assert.equal(hddLista.length, 1, "USB com media fixa continua a ser armazenamento USB");
  assert.equal(sataLista.length, 0, "DriveType=2 num disco SATA NAO prova USB");
});

test("identidade instavel (sem serial/PNP): detetado e recusado para auto-scan", async () => {
  let presente = false;
  const deteccao = criarDeteccaoUsbNativa({
    executor: executorDoMundo(() => mundoCom(presente ? [SEM_IDENTIDADE] : [])),
  });
  const analise = analiseFake();
  const monitor = new UsbProtectionMonitor({ deteccao, store: storeFixo(true), analise, readOnly: READ_ONLY_OK });

  await monitor.iniciar();
  presente = true;
  const snapshot = await monitor.ciclo();
  const estado = snapshot.devices.find((d) => d.id === "usb-index:7");
  assert.ok(estado);
  assert.equal(estado.status, "detected");
  assert.match(estado.limitation ?? "", /indice|índice|instável|instavel/i);
  assert.deepEqual(analise.iniciados, []);
});

test("RED baseline-refresh: primeira enumeracao falha → a primeira bem-sucedida define o baseline", async () => {
  const porta = criarDeteccaoUsbNativa({ executor: executorDoMundo(() => mundoCom([PEN])) });
  let falhou = false;
  const deteccao = {
    async listar() {
      if (!falhou) {
        falhou = true;
        throw new Error("CIM timeout (fixture)");
      }
      return porta.listar();
    },
  };
  const analise = analiseFake();
  const monitor = new UsbProtectionMonitor({ deteccao, store: storeFixo(true), analise, readOnly: READ_ONLY_OK });

  const inicio = await monitor.iniciar();
  assert.equal(inicio.monitorStatus, "unavailable");

  const snapshot = await monitor.ciclo();
  const estado = snapshot.devices.find((d) => d.id === "usb-serial:PEN-POSTHUMAN-FICTICIA");
  assert.ok(estado);
  assert.equal(estado.status, "detected", "pre-conectado nunca e' autoanalisado");
  assert.match(estado.limitation ?? "", /baseline|já presente/i);
  assert.deepEqual(analise.iniciados, [], "nenhuma analise automatica depois da recuperacao");
});

test("depois do baseline definido, uma insercao POSTERIOR continua elegivel", async () => {
  const PEN2 = { ...PEN, index: 5, serial: "PEN-POSTHUMAN-FICTICIA-2", letter: "U:", label: "PEN FICTICIA 2" };
  let presentes = [PEN];
  const porta = criarDeteccaoUsbNativa({ executor: executorDoMundo(() => mundoCom(presentes)) });
  let falhou = false;
  const deteccao = {
    async listar() {
      if (!falhou) {
        falhou = true;
        throw new Error("CIM timeout (fixture)");
      }
      return porta.listar();
    },
  };
  const analise = analiseFake();
  const monitor = new UsbProtectionMonitor({ deteccao, store: storeFixo(true), analise, readOnly: READ_ONLY_OK });

  await monitor.iniciar(); // falha
  await monitor.ciclo(); // recupera com a PEN (baseline)
  presentes = [PEN, PEN2];
  const snapshot = await monitor.ciclo();

  const pen = snapshot.devices.find((d) => d.id === "usb-serial:PEN-POSTHUMAN-FICTICIA");
  const pen2 = snapshot.devices.find((d) => d.id === "usb-serial:PEN-POSTHUMAN-FICTICIA-2");
  assert.equal(pen.status, "detected");
  assert.match(pen.limitation ?? "", /baseline|já presente/i);
  assert.equal(pen2.status, "scanning", "a insercao nova e' analisada");
  assert.deepEqual(
    analise.iniciados.map((alvo) => alvo.id),
    ["usb-serial:PEN-POSTHUMAN-FICTICIA-2"],
  );
});

test("RED ativacao: pre-conectado NAO observado antes de configurar(true) nao e' autoanalisado", async () => {
  let presente = false;
  const deteccao = criarDeteccaoUsbNativa({ executor: executorDoMundo(() => mundoCom(presente ? [PEN] : [])) });
  const analise = analiseFake();
  const monitor = new UsbProtectionMonitor({
    deteccao,
    store: storeFixo(false),
    analise,
    readOnly: READ_ONLY_OK,
  });

  await monitor.iniciar(); // opt-in OFF, enumeracao vazia OK
  presente = true; // pen presente ANTES de ligar o opt-in; sem poll pelo meio
  await monitor.configurar({ enabled: true });
  const snapshot = await monitor.ciclo(); // 1.ª enumeracao apos a ativacao

  const estado = snapshot.devices.find((d) => d.id === "usb-serial:PEN-POSTHUMAN-FICTICIA");
  assert.ok(estado);
  assert.equal(estado.status, "detected", "pre-conectado nunca e' autoanalisado");
  assert.match(estado.limitation ?? "", /baseline|já presente/i);
  assert.deepEqual(analise.iniciados, []);
});

test("RED ativacao: ultima enumeracao falhada antes de ligar ⇒ pre-conectado continua sem auto-scan", async () => {
  const porta = criarDeteccaoUsbNativa({ executor: executorDoMundo(() => mundoCom([PEN])) });
  let falhou = false;
  const deteccao = {
    async listar() {
      if (!falhou) {
        falhou = true;
        throw new Error("CIM timeout (fixture)");
      }
      return porta.listar();
    },
  };
  const analise = analiseFake();
  const monitor = new UsbProtectionMonitor({
    deteccao,
    store: storeFixo(false),
    analise,
    readOnly: READ_ONLY_OK,
  });

  const inicio = await monitor.iniciar();
  assert.equal(inicio.monitorStatus, "unavailable");
  await monitor.configurar({ enabled: true });
  const snapshot = await monitor.ciclo();

  const estado = snapshot.devices.find((d) => d.id === "usb-serial:PEN-POSTHUMAN-FICTICIA");
  assert.ok(estado);
  assert.equal(estado.status, "detected");
  assert.match(estado.limitation ?? "", /baseline|já presente/i);
  assert.deepEqual(analise.iniciados, []);
});

test("controlo: chegada POSTERIOR a 1.ª enumeracao apos ativacao continua elegivel", async () => {
  const PEN2 = { ...PEN, index: 5, serial: "PEN-POSTHUMAN-FICTICIA-2", letter: "U:", label: "PEN FICTICIA 2" };
  let presentes = [];
  const deteccao = criarDeteccaoUsbNativa({ executor: executorDoMundo(() => mundoCom(presentes)) });
  const analise = analiseFake();
  const monitor = new UsbProtectionMonitor({
    deteccao,
    store: storeFixo(false),
    analise,
    readOnly: READ_ONLY_OK,
  });

  await monitor.iniciar();
  await monitor.configurar({ enabled: true });
  await monitor.ciclo(); // 1.ª enumeracao apos ativacao: vazia — define o baseline
  presentes = [PEN2];
  const snapshot = await monitor.ciclo();

  const pen2 = snapshot.devices.find((d) => d.id === "usb-serial:PEN-POSTHUMAN-FICTICIA-2");
  assert.ok(pen2);
  assert.equal(pen2.status, "scanning", "a chegada posterior e' analisada");
  assert.deepEqual(
    analise.iniciados.map((alvo) => alvo.id),
    ["usb-serial:PEN-POSTHUMAN-FICTICIA-2"],
  );
});

test("controlo: configurar(true) redundante (ja' ligado) NAO volta a armar o baseline", async () => {
  let presente = false;
  const deteccao = criarDeteccaoUsbNativa({ executor: executorDoMundo(() => presente ? mundoCom([PEN]) : mundoCom([])) });
  const analise = analiseFake();
  const monitor = new UsbProtectionMonitor({
    deteccao,
    store: storeFixo(false),
    analise,
    readOnly: READ_ONLY_OK,
  });

  await monitor.iniciar();
  await monitor.configurar({ enabled: true }); // transicao OFF -> ON
  await monitor.ciclo(); // consome o baseline da ativacao (vazio)
  await monitor.configurar({ enabled: true }); // redundante: NAO pode re-armar

  presente = true;
  const snapshot = await monitor.ciclo();
  const estado = snapshot.devices.find((d) => d.id === "usb-serial:PEN-POSTHUMAN-FICTICIA");
  assert.ok(estado);
  assert.equal(estado.status, "scanning", "um toggle redundante nao engole uma insercao real");
  assert.deepEqual(analise.iniciados.map((alvo) => alvo.id), ["usb-serial:PEN-POSTHUMAN-FICTICIA"]);
});

// ── Custo da leitura de espera (P0 fiabilidade x P2 performance) ────────────

test("custo: um ciclo faz UMA enumeracao — `listar` e `listarPendentes` partilham a leitura em curso", async () => {
  let enumeracoes = 0;
  const deteccao = criarDeteccaoUsbNativa({
    enumerar: async () => {
      enumeracoes += 1;
      // enumerar injects a normalized UsbEnumeration, not raw CIM rows.
      // Exercise the same parser as production; retain all count assertions.
      return new UsbStorageEnumerator(executorDoMundo(() => mundoCom([PEN]))).enumerate();
    },
  });
  const monitor = new UsbProtectionMonitor({
    deteccao,
    store: storeFixo(false),
    analise: analiseFake(),
    readOnly: READ_ONLY_OK,
  });

  await monitor.iniciar();
  assert.equal(enumeracoes, 1, "um ciclo = uma leitura CIM, mesmo com o estado de espera ligado");

  await monitor.ciclo();
  assert.equal(enumeracoes, 2, "cada ciclo volta a ler de facto (sem janela de cache)");

  // E a leitura partilhada continua a alimentar as DUAS listas do ciclo.
  const [prontos, pendentes] = await Promise.all([deteccao.listar(), deteccao.listarPendentes()]);
  assert.equal(enumeracoes, 3, "duas leituras em paralelo partilham a mesma enumeracao");
  assert.equal(prontos.length, 1);
  assert.deepEqual(pendentes, []);
});
