/**
 * R8 — DETECCAO DE ARMAZENAMENTO USB (native-windows).
 *
 * Regras do contrato (R8-USB-CONTRACT-CODEX-2026-10-12.md):
 *  - A deteccao confirma ARMAZENAMENTO E TRANSPORTE USB, por
 *    CIM/discos/associacoes Windows. DriveType=2 isolado NAO
 *    prova USB; USB generico (teclado) NAO prova armazenamento.
 *  - A identidade e' do DISCO FISICO (serial/PNPDeviceID),
 *    nunca so' da letra — a letra pode ser reutilizada por outro
 *    dispositivo. Sem serial nem PNPDeviceID a identidade e'
 *    instavel (indice reciclavel) e e' declarada como tal.
 *  - Falha de enumeracao = desconhecido/indisponivel, nunca
 *    deteccao inventada.
 *  - Sem PowerShell no import: o executor real so' corre quando
 *    invocado; os testes injetam fixtures/runners.
 *
 * As fixtures sao a forma EXATA que o PowerShell emite
 * (Select-Object + ConvertTo-Json -Compress): chaves PascalCase
 * do schema CIM e Antecedent/Dependent como referencias CIM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  USB_CIM_BATCH_SCRIPT,
  USB_CIM_QUERIES,
  USB_CIM_TIMEOUT_MS,
  UsbStorageEnumerator,
  createPowerShellCimBatchExecutor,
  createPowerShellCimExecutor,
  identifyAwaitingVolumeDisks,
  identifyUsbStorageDevices,
  isUsbTransport,
  parseCimBatchOutput,
  parseCimJson,
  parseCimReferenceValue,
  usbCimSectionMarker,
  usbDeviceIdentity,
  usbTransportProof,
} from "../src/usb-storage.ts";

/** Referencia CIM de particao (forma objeto — a real). */
function partitionRef(deviceId) {
  return { DeviceID: deviceId };
}

/** Referencia CIM de volume (forma objeto — a real). */
function volumeRef(deviceId) {
  return { DeviceID: deviceId };
}

/**
 * Pen USB real — forma EXATA do PowerShell
 * (chaves PascalCase; referencias CIM em
 * objeto).
 */
function usbPen(overrides = {}) {
  return {
    disks: [
      {
        Index: 1,
        InterfaceType: "USB",
        MediaType: "Removable Media",
        SerialNumber: "CYBERSAFE-PEN-1",
        PNPDeviceID: "USBSTOR\\DISK&VEN_SANDISK&PROD_CRUIZ&REV_1.26",
        Size: 8000000000,
      },
    ],
    partitions: [
      { DiskIndex: 1, DeviceID: "Disk #1, Partition #0", Type: "FAT32" },
    ],
    links: [
      {
        Antecedent: partitionRef("Disk #1, Partition #0"),
        Dependent: volumeRef("E:"),
      },
    ],
    volumes: [
      { DeviceID: "E:", VolumeName: "PEN", DriveType: 2, Size: 7900000000 },
    ],
    ...overrides,
  };
}

/** Enumeracao normalizada a partir de uma fixture crua (sem join). */
async function enumerar(enumeration) {
  const enumerator = new UsbStorageEnumerator(async (script) => {
    if (script === USB_CIM_QUERIES.disks) return enumeration.disks;
    if (script === USB_CIM_QUERIES.partitions) return enumeration.partitions;
    if (script === USB_CIM_QUERIES.links) return enumeration.links;
    return enumeration.volumes;
  });
  return enumerator.enumerate();
}

/** Executa o join a partir de uma fixture crua (via enumerador). */
async function detect(enumeration) {
  const enumerator = new UsbStorageEnumerator(async (script) => {
    if (script === USB_CIM_QUERIES.disks) return enumeration.disks;
    if (script === USB_CIM_QUERIES.partitions) return enumeration.partitions;
    if (script === USB_CIM_QUERIES.links) return enumeration.links;
    return enumeration.volumes;
  });
  return identifyUsbStorageDevices(await enumerator.enumerate());
}

/* ── P0 FIABILIDADE USB (14/10/2026) ───────────────────────────────────────
 *
 * INCIDENTE REAL: o Windows via a pen e a pagina do CyberSafe nao. Duas causas
 * deterministicas, reproduzidas aqui com fixtures:
 *   (1) a prova de transporte USB exigia `InterfaceType === "USB"` — pens atras
 *       de controladores UASP/bridges USB-SATA reportam `SCSI` e eram para
 *       sempre invisiveis;
 *   (2) um disco USB so' existia para o produto depois de ter volume COM letra —
 *       enquanto o Windows montava (ou quando um link falhava), a pagina dizia
 *       "sem dispositivo" sem qualquer estado que explicasse a espera.
 *
 * Contra-prova obrigatoria (a deteccao nao pode alargar-se a discos internos):
 * um disco SATA/NVMe fixo com letra C: NUNCA pode aparecer como dispositivo USB.
 */

test("transporte: qualquer das provas reais serve; disco interno fixo nunca prova", () => {
  const prova = (disco) => usbTransportProof(disco);

  assert.equal(prova({ interfaceType: "USB", mediaType: "Removable Media" }), "interface-usb");
  // Pen/enclosure que reporta SCSI mas e' servida pelo driver de armazenamento USB.
  assert.equal(prova({ interfaceType: "SCSI", pnpDeviceId: "USBSTOR\\DISK&VEN_SANDISK" }), "pnp-usbstor");
  // Bridge USB-SATA: caminho do barramento USB no PNPDeviceID.
  assert.equal(prova({ interfaceType: "SCSI", pnpDeviceId: "USB\\VID_174C&PID_55AA\\7&1A2B" }), "pnp-usb-bridge");
  assert.equal(prova({ interfaceType: "SCSI", pnpDeviceId: "USB&VID_174C" }), "pnp-usb-bridge");
  // Removivel NAO e' prova de USB (nao pode alargar a deteccao a discos SATA).
  assert.equal(prova({ interfaceType: "SCSI", mediaType: "Removable Media" }), null);

  // Contra-prova: disco interno fixo, nada aqui pode provar USB.
  assert.equal(
    prova({
      interfaceType: "SCSI",
      mediaType: "Fixed hard disk media",
      pnpDeviceId: "SCSI\\DISK&VEN_NVME&PROD_SSD",
    }),
    null,
  );
  assert.equal(prova({ interfaceType: "IDE", mediaType: "Fixed hard disk media" }), null);
  assert.equal(isUsbTransport({ interfaceType: "SCSI", mediaType: "Fixed hard disk media" }), false);
  assert.equal(isUsbTransport({ interfaceType: " scsi ", pnpDeviceId: "usbstor\\disk" }), true, "normalizacao de maiusculas/minusculas");
});

test("pen reportada como SCSI (UASP/bridge): detetada com a prova declarada", async () => {
  const pen = usbPen();
  pen.disks[0].InterfaceType = "SCSI";
  pen.disks[0].PNPDeviceID = "USBSTOR\\DISK&VEN_SANDISK&PROD_CRUIZ";

  const devices = await detect(pen);
  assert.equal(devices.length, 1, "pen USB atras de driver SCSI continua invisivel");
  assert.equal(devices[0].rootPath, "E:\\");
  assert.equal(devices[0].transportProof, "pnp-usbstor");
  assert.equal(devices[0].identityProvenance, "disk-serial");
});

test("disco interno fixo com letra C: nunca e' dispositivo USB", async () => {
  const devices = await detect({
    disks: [
      {
        Index: 0,
        InterfaceType: "SCSI",
        MediaType: "Fixed hard disk media",
        SerialNumber: "NVME-INTERNO-1",
        PNPDeviceID: "SCSI\\DISK&VEN_NVME&PROD_SSD_1TB",
        Size: 1_000_000_000_000,
      },
    ],
    partitions: [{ DiskIndex: 0, DeviceID: "Disk #0, Partition #1", Type: "NTFS" }],
    links: [{ Antecedent: partitionRef("Disk #0, Partition #1"), Dependent: volumeRef("C:") }],
    volumes: [{ DeviceID: "C:", VolumeName: "Windows", DriveType: 3, Size: 1_000_000_000_000 }],
  });
  assert.deepEqual(devices, []);
});

test("USB sem volume publicado: NAO e' analisavel, mas e' DETETADO como 'a aguardar volume'", async () => {
  const penSemVolume = usbPen({ links: [], volumes: [] });

  // 1. Contrato R8 intacto: sem raiz real nao ha dispositivo ANALISAVEL.
  const analisaveis = await detect(penSemVolume);
  assert.deepEqual(analisaveis, [], "disco sem volume nao pode ser armazenamento acessivel");

  // 2. Estado honesto de espera: o utilizador ve' o MESMO que o Windows ve'.
  const pendentes = identifyAwaitingVolumeDisks(await enumerar(penSemVolume));
  assert.equal(pendentes.length, 1, "o disco USB sem volume ficou invisivel");
  assert.equal(pendentes[0].awaitingVolume, true);
  assert.equal(pendentes[0].transportProof, "interface-usb");
  assert.deepEqual(pendentes[0].letters, []);
  assert.match(pendentes[0].id, /^usb-serial:CYBERSAFE-PEN-1$/);
});

test("link disco-volume em falta (falha de uma associacao): aparece a aguardar volume, nunca com letra inventada", async () => {
  // A particao existe, o volume existe, mas a associacao falhou: sem prova de
  // armazenamento acessivel. Nao se inventa a letra — declara-se a espera.
  const pendentes = identifyAwaitingVolumeDisks(await enumerar(usbPen({ links: [] })));
  assert.equal(pendentes.length, 1);
  assert.equal(pendentes[0].awaitingVolume, true);
  assert.equal("rootPath" in pendentes[0], false, "um dispositivo em espera nao pode ter raiz");
  assert.deepEqual(await detect(usbPen({ links: [] })), []);
});

test("as duas listas sao complementares: com volume publicado nao ha espera", async () => {
  const pendentes = identifyAwaitingVolumeDisks(await enumerar(usbPen()));
  assert.deepEqual(pendentes, []);
  const analisaveis = await detect(usbPen());
  assert.equal(analisaveis.length, 1);
});

test("letra tardia: a MESMA pen passa de 'a aguardar volume' a analisavel, sem mudar de identidade", async () => {
  const pendentes = identifyAwaitingVolumeDisks(await enumerar(usbPen({ links: [], volumes: [] })));
  const comVolume = await detect(usbPen());
  assert.equal(pendentes[0].id, comVolume[0].id, "a identidade mudou com a montagem do volume");
  assert.equal(pendentes[0].awaitingVolume, true);
  assert.equal(comVolume[0].rootPath, "E:\\");
});

test("mudanca de letra: a identidade NAO e' a letra", async () => {
  const antes = await detect(usbPen());
  const depois = await detect(
    usbPen({
      links: [{ Antecedent: partitionRef("Disk #1, Partition #0"), Dependent: volumeRef("F:") }],
      volumes: [{ DeviceID: "F:", VolumeName: "PEN", DriveType: 2 }],
    }),
  );
  assert.equal(antes[0].id, depois[0].id, "a letra entrou na identidade");
  assert.equal(antes[0].rootPath, "E:\\");
  assert.equal(depois[0].rootPath, "F:\\");
});

test("varias particoes/letras: UM dispositivo com todas as raizes ordenadas", async () => {
  const devices = await detect({
    disks: [
      { Index: 3, InterfaceType: "USB", MediaType: "Removable Media", SerialNumber: "PEN-MULTI", Size: 64_000_000_000 },
    ],
    partitions: [
      { DiskIndex: 3, DeviceID: "Disk #3, Partition #1", Type: "FAT32" },
      { DiskIndex: 3, DeviceID: "Disk #3, Partition #2", Type: "NTFS" },
    ],
    links: [
      { Antecedent: partitionRef("Disk #3, Partition #2"), Dependent: volumeRef("H:") },
      { Antecedent: partitionRef("Disk #3, Partition #1"), Dependent: volumeRef("G:") },
    ],
    volumes: [
      { DeviceID: "H:", VolumeName: "DADOS", DriveType: 2 },
      { DeviceID: "G:", VolumeName: "BOOT", DriveType: 2 },
    ],
  });
  assert.equal(devices.length, 1);
  assert.deepEqual(devices[0].rootPaths, ["G:\\", "H:\\"]);
  assert.equal(devices[0].rootPath, "G:\\");
});

test("USB removida durante a descoberta: o disco ausente da enumeracao seguinte desaparece das DUAS listas", async () => {
  const presente = await detect(usbPen());
  const vazio = usbPen({ disks: [], partitions: [], links: [], volumes: [] });
  const ausente = await detect(vazio);
  assert.equal(presente.length, 1);
  assert.deepEqual(ausente, [], "uma enumeracao fresca sem o disco tem de o remover");
  assert.deepEqual(identifyAwaitingVolumeDisks(await enumerar(vazio)), []);
});

test("retry: uma enumeracao que falha nao deixa dispositivo fantasma (desconhecido)", async () => {
  const enumerador = new UsbStorageEnumerator(async (script) => {
    if (script === USB_CIM_QUERIES.disks) throw new Error("timeout do CIM");
    return [];
  });
  await assert.rejects(enumerador.enumerate(), /timeout do CIM/);
});

test("pen USB confirmada: armazenamento E transporto USB, identidade pelo serial", async () => {
  const devices = await detect(usbPen());
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, "usb-serial:CYBERSAFE-PEN-1");
  assert.equal(devices[0].identityProvenance, "disk-serial");
  assert.deepEqual(devices[0].rootPaths, ["E:\\"]);
  assert.equal(devices[0].rootPath, "E:\\");
  assert.equal(devices[0].label, "PEN");
});

test("query de discos NAO seleciona BusType (propriedade inexistente em Win32_DiskDrive)", () => {
  assert.equal(USB_CIM_QUERIES.disks.includes("BusType"), false);
  assert.equal(USB_CIM_QUERIES.disks.includes("InterfaceType"), true);
});

test("USB HDD (media fixa) e' detectado — o transporte e' que importa", async () => {
  const devices = await detect(
    usbPen({
      disks: [
        {
          Index: 1,
          InterfaceType: "USB",
          MediaType: "Fixed hard disk media",
          SerialNumber: "CYBERSAFE-HDD-9",
        },
      ],
    }),
  );
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, "usb-serial:CYBERSAFE-HDD-9");
});

test("DriveType=2 isolado NAO prova USB (disco SATA com volume removivel)", async () => {
  const devices = await detect(
    usbPen({
      disks: [
        {
          Index: 0,
          InterfaceType: "SATA",
          MediaType: "Removable Media",
          SerialNumber: "NOT-USB",
        },
      ],
    }),
  );
  assert.equal(devices.length, 0);
});

test("interfaceType USB e' case-insensivel", async () => {
  const devices = await detect(
    usbPen({
      disks: [{ Index: 1, InterfaceType: " usb ", SerialNumber: "IFACE-USB" }],
    }),
  );
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, "usb-serial:IFACE-USB");
});

test("USB generico sem disco (teclado) nunca e' armazenamento", async () => {
  const devices = await detect({ disks: [], partitions: [], links: [], volumes: [] });
  assert.equal(devices.length, 0);
});

test("disco USB sem volume montado (sem associacao) nao e' armazenamento acessivel", async () => {
  const devices = await detect(usbPen({ links: [], volumes: [] }));
  assert.equal(devices.length, 0);
});

test("identidade: mesma caneta, outra letra (reinsercao) = MESMO id", async () => {
  const first = await detect(usbPen());
  const again = await detect(
    usbPen({
      links: [
        {
          Antecedent: partitionRef("Disk #1, Partition #0"),
          Dependent: volumeRef("F:"),
        },
      ],
      volumes: [{ DeviceID: "F:", VolumeName: "PEN", DriveType: 2 }],
    }),
  );
  assert.equal(first[0].id, again[0].id);
  assert.equal(again[0].rootPath, "F:\\");
});

test("identidade: outro dispositivo a reutilizar a letra = id DIFERENTE (letra reciclada nao engana)", async () => {
  const first = await detect(usbPen());
  const other = await detect(
    usbPen({
      disks: [
        {
          Index: 1,
          InterfaceType: "USB",
          SerialNumber: "OUTRA-PEN-2",
        },
      ],
    }),
  );
  assert.notEqual(first[0].id, other[0].id);
  assert.equal(other[0].rootPath, "E:\\");
});

test("duas pen diferentes simultaneas = dois dispositivos", async () => {
  const devices = await detect(
    usbPen({
      disks: [
        { Index: 1, InterfaceType: "USB", SerialNumber: "PEN-A" },
        { Index: 2, InterfaceType: "USB", SerialNumber: "PEN-B" },
      ],
      partitions: [
        { DiskIndex: 1, DeviceID: "Disk #1, Partition #0" },
        { DiskIndex: 2, DeviceID: "Disk #2, Partition #0" },
      ],
      links: [
        {
          Antecedent: partitionRef("Disk #1, Partition #0"),
          Dependent: volumeRef("E:"),
        },
        {
          Antecedent: partitionRef("Disk #2, Partition #0"),
          Dependent: volumeRef("F:"),
        },
      ],
      volumes: [
        { DeviceID: "E:", VolumeName: "A", DriveType: 2 },
        { DeviceID: "F:", VolumeName: "B", DriveType: 2 },
      ],
    }),
  );
  assert.equal(devices.length, 2);
  assert.equal(devices[0].id, "usb-serial:PEN-A");
  assert.equal(devices[1].id, "usb-serial:PEN-B");
});

test("serial ausente: PNPDeviceID e' fallback de identidade estavel", async () => {
  const devices = await detect(
    usbPen({ disks: [{ Index: 1, InterfaceType: "USB", PNPDeviceID: "USBSTOR\\DISK&VEN_X&PROD_Y&REV_1.0" }] }),
  );
  assert.equal(devices.length, 1);
  assert.equal(
    devices[0].id,
    "usb-pnp:USBSTOR\\DISK&VEN_X&PROD_Y&REV_1.0",
  );
  assert.equal(devices[0].identityProvenance, "pnp-device-id");
});

test("serial e PNPDeviceID ausentes: identidade instavel (indice), declarada — nunca a letra", async () => {
  const devices = await detect(
    usbPen({ disks: [{ Index: 1, InterfaceType: "USB" }] }),
  );
  assert.equal(devices.length, 1);
  assert.equal(devices[0].identityProvenance, "disk-index-fallback");
  assert.equal(devices[0].id, "usb-index:1");
  assert.equal(devices[0].id.includes("E:"), false);
});

test("duas particoes do mesmo disco: um dispositivo com TODAS as raizes", async () => {
  const devices = await detect(
    usbPen({
      partitions: [
        { DiskIndex: 1, DeviceID: "Disk #1, Partition #0", Type: "FAT32" },
        { DiskIndex: 1, DeviceID: "Disk #1, Partition #1", Type: "NTFS" },
      ],
      links: [
        {
          Antecedent: partitionRef("Disk #1, Partition #1"),
          Dependent: volumeRef("G:"),
        },
        {
          Antecedent: partitionRef("Disk #1, Partition #0"),
          Dependent: volumeRef("E:"),
        },
      ],
      volumes: [
        { DeviceID: "E:", VolumeName: "PEN1", DriveType: 2 },
        { DeviceID: "G:", VolumeName: "PEN2", DriveType: 2 },
      ],
    }),
  );
  assert.equal(devices.length, 1);
  assert.deepEqual(devices[0].rootPaths, ["E:\\", "G:\\"]);
  assert.equal(devices[0].rootPath, "E:\\");
  assert.equal(devices[0].label, "PEN1");
});

test("dedup: o mesmo disco listado duas vezes = um dispositivo", async () => {
  const pen = usbPen();
  pen.disks.push({ ...pen.disks[0] });
  const devices = await detect(pen);
  assert.equal(devices.length, 1);
});

test("link aponta para volume inexistente: nao prova armazenamento", async () => {
  const devices = await detect(
    usbPen({
      links: [
        {
          Antecedent: partitionRef("Disk #1, Partition #0"),
          Dependent: volumeRef("G:"),
        },
      ],
      volumes: [{ DeviceID: "E:", VolumeName: "PEN", DriveType: 2 }],
    }),
  );
  assert.equal(devices.length, 0);
});

test("referencias CIM como STRING (forma alternativa de serializacao) tambem sao parseadas", async () => {
  const devices = await detect(
    usbPen({
      links: [
        {
          Antecedent:
            '\\\\PC\\root\\cimv2:Win32_DiskPartition.DeviceID="Disk #1, Partition #0"',
          Dependent:
            '\\\\PC\\root\\cimv2:Win32_LogicalDisk.DeviceID="E:"',
        },
      ],
    }),
  );
  assert.equal(devices.length, 1);
  assert.equal(devices[0].rootPath, "E:\\");
});

test("indice ausente no disco NAO vira disco 0 (junta-se nada)", async () => {
  const devices = await detect(
    usbPen({ disks: [{ InterfaceType: "USB", SerialNumber: "NO-INDEX" }] }),
  );
  assert.equal(devices.length, 0);
});

test("indice 0 e' valido quando presente (distinto de ausente)", async () => {
  const devices = await detect(
    usbPen({
      disks: [{ Index: 0, InterfaceType: "USB", SerialNumber: "ZERO" }],
      partitions: [{ DiskIndex: 0, DeviceID: "Disk #0, Partition #0" }],
      links: [
        {
          Antecedent: partitionRef("Disk #0, Partition #0"),
          Dependent: volumeRef("E:"),
        },
      ],
    }),
  );
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, "usb-serial:ZERO");
});

test("DiskIndex ausente na particao: sem join com o disco", async () => {
  const devices = await detect(
    usbPen({ partitions: [{ DeviceID: "Disk #1, Partition #0" }] }),
  );
  assert.equal(devices.length, 0);
});

test("link sem DeviceID parseavel: associacao ignorada", async () => {
  const devices = await detect(
    usbPen({ links: [{ Antecedent: {}, Dependent: { Serial: "?" } }] }),
  );
  assert.equal(devices.length, 0);
});

test("volume sem letra estrita (DeviceID sem ':') nao e' volume real", async () => {
  const devices = await detect(
    usbPen({ volumes: [{ DeviceID: "C", VolumeName: "X", DriveType: 2 }] }),
  );
  assert.equal(devices.length, 0);
});

test("isUsbTransport: so' InterfaceType USB (BusType nao existe na classe)", () => {
  assert.equal(isUsbTransport({ index: 0, interfaceType: "USB" }), true);
  assert.equal(isUsbTransport({ index: 0, interfaceType: "usb" }), true);
  assert.equal(isUsbTransport({ index: 0, interfaceType: "SATA" }), false);
  assert.equal(isUsbTransport({ index: 0 }), false);
  assert.equal(isUsbTransport({}), false);
});

test("usbDeviceIdentity: serial normalizado (trim + upper); fallbacks documentados", () => {
  assert.deepEqual(
    usbDeviceIdentity({ index: 0, interfaceType: "USB", serial: "  abc-123  " }),
    { id: "usb-serial:ABC-123", provenance: "disk-serial" },
  );
  assert.deepEqual(
    usbDeviceIdentity({ index: 4, interfaceType: "USB", pnpDeviceId: " pnp-1 " }),
    { id: "usb-pnp:PNP-1", provenance: "pnp-device-id" },
  );
  assert.deepEqual(usbDeviceIdentity({ index: 4, interfaceType: "USB" }), {
    id: "usb-index:4",
    provenance: "disk-index-fallback",
  });
});

test("parseCimReferenceValue: string, objeto CIM e formas invalidas", () => {
  assert.equal(
    parseCimReferenceValue('\\\\PC\\root\\cimv2:Win32_LogicalDisk.DeviceID="E:"'),
    "E:",
  );
  assert.equal(parseCimReferenceValue({ DeviceID: "E:" }), "E:");
  assert.equal(parseCimReferenceValue({ DeviceID: "" }), null);
  assert.equal(parseCimReferenceValue(""), null);
  assert.equal(parseCimReferenceValue("sem-referencia"), null);
  assert.equal(parseCimReferenceValue({}), null);
  assert.equal(parseCimReferenceValue(null), null);
  assert.equal(parseCimReferenceValue(42), null);
  assert.equal(parseCimReferenceValue(["E:"]), null);
});

test("enumerador: join das 4 queries CIM com fixture exata (PascalCase real)", async () => {
  const queries = [];
  const enumerator = new UsbStorageEnumerator(async (script) => {
    queries.push(script);
    const pen = usbPen();
    if (script === USB_CIM_QUERIES.disks) return pen.disks;
    if (script === USB_CIM_QUERIES.partitions) return pen.partitions;
    if (script === USB_CIM_QUERIES.links) return pen.links;
    return pen.volumes;
  });
  const enumeration = await enumerator.enumerate();
  // O enumerador normaliza para as formas tipadas (camelCase).
  assert.deepEqual(enumeration.disks[0].index, 1);
  assert.deepEqual(enumeration.disks[0].interfaceType, "USB");
  assert.deepEqual(enumeration.disks[0].serial, "CYBERSAFE-PEN-1");
  assert.deepEqual(enumeration.partitions[0].diskIndex, 1);
  assert.deepEqual(enumeration.links[0].antecedent, partitionRef("Disk #1, Partition #0"));
  assert.deepEqual(enumeration.volumes[0].deviceId, "E:");
  const devices = identifyUsbStorageDevices(enumeration);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, "usb-serial:CYBERSAFE-PEN-1");
  assert.equal(queries.length, 4);
});

test("enumerador: normaliza tipos (strings numericas, espaços) e ausentes", async () => {
  const enumerator = new UsbStorageEnumerator(async (script) => {
    if (script === USB_CIM_QUERIES.disks) {
      return [{ Index: "1", InterfaceType: " usb ", SerialNumber: "  S  " }];
    }
    if (script === USB_CIM_QUERIES.partitions) {
      return [{ DiskIndex: "1", DeviceID: "Disk #1, Partition #0" }];
    }
    if (script === USB_CIM_QUERIES.links) {
      return [
        {
          Antecedent: { DeviceID: "Disk #1, Partition #0" },
          Dependent: { DeviceID: "E:" },
        },
      ];
    }
    return [{ DeviceID: "E:", VolumeName: "PEN", DriveType: "2", Size: "7900000000" }];
  });
  const devices = identifyUsbStorageDevices(await enumerator.enumerate());
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, "usb-serial:S");
  assert.equal(devices[0].rootPath, "E:\\");
});

test("enumerador: resultado vazio do CIM (nenhum disco) = enumeracao vazia, nao erro", async () => {
  const enumerator = new UsbStorageEnumerator(async () => []);
  const enumeration = await enumerator.enumerate();
  assert.deepEqual(enumeration, { disks: [], partitions: [], links: [], volumes: [] });
  assert.equal(identifyUsbStorageDevices(enumeration).length, 0);
});

test("parseCimJson: array, objeto unico ou vazio", () => {
  assert.deepEqual(parseCimJson(' [{"Index":1}] '), [{ Index: 1 }]);
  assert.deepEqual(parseCimJson('{"Index":1}'), [{ Index: 1 }]);
  assert.deepEqual(parseCimJson(""), []);
  assert.deepEqual(parseCimJson("   "), []);
});

test("executor real: corre powershell com args/timeout/windowsHide e parsea o stdout", async () => {
  const calls = [];
  const executor = createPowerShellCimExecutor((file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, JSON.stringify([{ Index: 1 }]));
  });
  const result = await executor(USB_CIM_QUERIES.disks);
  assert.deepEqual(result, [{ Index: 1 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "powershell.exe");
  assert.deepEqual(calls[0].args, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    USB_CIM_QUERIES.disks,
  ]);
  assert.equal(calls[0].options.timeout, USB_CIM_TIMEOUT_MS);
  assert.equal(calls[0].options.windowsHide, true);
});

test("executor real: falha do powershell rejeita (enumeracao falhada = desconhecido)", async () => {
  const executor = createPowerShellCimExecutor((file, args, options, callback) => {
    callback(new Error("exit 1"), "");
  });
  await assert.rejects(executor(USB_CIM_QUERIES.disks), /exit 1/);
});

test("executor real: stdout nao-JSON rejeita (nunca deteccao inventada)", async () => {
  const executor = createPowerShellCimExecutor((file, args, options, callback) => {
    callback(null, "nao e json");
  });
  await assert.rejects(executor(USB_CIM_QUERIES.disks));
});

/* ── P0 PERFORMANCE (14/10/2026): UM processo em vez de QUATRO ──────────────
 *
 * MEDIDO no produto instalado: a enumeracao USB corre a cada 5 s e cada ciclo
 * lancava QUATRO `powershell.exe` (um por query CIM) = 48 processos por minuto
 * em repouso, cada um com ~200-400 ms de CPU e uma alocacao transitoria de
 * dezenas de MB (mais a inspecao do antivirus a cada processo novo). O lote faz
 * AS MESMAS quatro queries, com os MESMOS campos, num so processo.
 *
 * O que estes testes provam, e' exatamente isso: (a) as quatro queries estao no
 * lote uma e uma so' vez; (b) uma invocacao do lote substitui as quatro
 * chamadas individuais e produz o MESMO resultado; (c) o executor real lanca UM
 * processo por ciclo; (d) uma leitura parcial e' DESCONHECIDA, nunca "lista
 * vazia" — uma enumeracao incompleta nao pode virar a afirmacao "nao ha nada
 * ligado". */

const BATCH_STDOUT = [
  usbCimSectionMarker("disks"),
  JSON.stringify([
    { Index: 2, InterfaceType: "USB", MediaType: "Removable Media", SerialNumber: "SER-LOTE", PNPDeviceID: "USBSTOR\\DISK", Size: 8_000_000 },
  ]),
  usbCimSectionMarker("partitions"),
  JSON.stringify([{ DiskIndex: 2, DeviceID: "Disk #2, Partition #0", Type: "Installable" }]),
  usbCimSectionMarker("links"),
  JSON.stringify([{ Antecedent: '\\\\MATRIX\\root\\cimv2:Win32_DiskPartition.DeviceID="Disk #2, Partition #0"', Dependent: '\\\\MATRIX\\root\\cimv2:Win32_LogicalDisk.DeviceID="E:"' }]),
  usbCimSectionMarker("volumes"),
  JSON.stringify([{ DeviceID: "E:", VolumeName: "PEN-LOTE", DriveType: 2, Size: 8_000_000 }]),
].join("\n");

test("lote: um script com as quatro secoes, na ordem, cada query uma so' vez", () => {
  const ordem = ["DISKS", "PARTITIONS", "LINKS", "VOLUMES"].map((k) => USB_CIM_BATCH_SCRIPT.indexOf(`###CYBERSAFE-CIM-${k}###`));
  assert.ok(ordem.every((posicao) => posicao >= 0), "falta um marcador no lote");
  assert.deepEqual([...ordem].sort((a, b) => a - b), ordem, "marcadores fora de ordem");
  for (const key of ["disks", "partitions", "links", "volumes"]) {
    assert.equal(USB_CIM_BATCH_SCRIPT.split(USB_CIM_QUERIES[key]).length - 1, 1, `query ${key} ausente ou duplicada`);
  }
});

test("lote: uma saida do PowerShell le-se como as quatro secoes", () => {
  const lote = parseCimBatchOutput(BATCH_STDOUT);
  assert.equal(lote.disks.length, 1);
  assert.equal(lote.partitions.length, 1);
  assert.equal(lote.links.length, 1);
  assert.equal(lote.volumes.length, 1);
  assert.equal(lote.disks[0].SerialNumber, "SER-LOTE");
});

test("lote: seccao ausente ou truncada = desconhecido (nunca lista vazia)", () => {
  // Falta a seccao das particoes: nao pode ser lido como "nenhuma particao".
  const semParticoes = BATCH_STDOUT.replace(usbCimSectionMarker("partitions"), "");
  assert.throws(() => parseCimBatchOutput(semParticoes), /desconhecida/);
  // Saida truncada a meio (o processo morreu): tambem desconhecido.
  assert.throws(() => parseCimBatchOutput(usbCimSectionMarker("disks")), /desconhecida/);
  // Saida vazia: nem comecou.
  assert.throws(() => parseCimBatchOutput(""), /desconhecida/);
});

test("lote: UMA invocacao substitui as quatro chamadas, com o mesmo resultado", async () => {
  const loteBruto = parseCimBatchOutput(BATCH_STDOUT);
  const chamadasIndividuais = [];
  const chamadasLote = [];

  const individual = async (script) => {
    chamadasIndividuais.push(script);
    if (script === USB_CIM_QUERIES.disks) return loteBruto.disks;
    if (script === USB_CIM_QUERIES.partitions) return loteBruto.partitions;
    if (script === USB_CIM_QUERIES.links) return loteBruto.links;
    return loteBruto.volumes;
  };
  const lote = async () => {
    chamadasLote.push("ciclo");
    return loteBruto;
  };

  const comLote = await new UsbStorageEnumerator(individual, lote).enumerate();
  const daLote = chamadasLote.length;
  const semLote = await new UsbStorageEnumerator(individual).enumerate();

  assert.deepEqual(comLote, semLote, "o lote mudou o resultado da enumeracao");
  assert.equal(daLote, 1, "o ciclo nao usou o lote exatamente uma vez");
  assert.equal(chamadasIndividuais.length, 4, "caminho antigo (4 chamadas) deixou de funcionar como referencia");
  assert.equal(comLote.disks[0].index, 2);
  assert.equal(comLote.volumes[0].deviceId, "E:");
});

test("executor do lote: um unico processo powershell por ciclo", async () => {
  const chamadas = [];
  const execute = createPowerShellCimBatchExecutor((file, args, options, callback) => {
    chamadas.push({ file, args, options });
    callback(null, BATCH_STDOUT);
  });
  const resultado = await execute();
  assert.equal(chamadas.length, 1, "o lote lancou mais do que um processo");
  assert.equal(chamadas[0].file, "powershell.exe");
  assert.deepEqual(chamadas[0].args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(chamadas[0].args[3], USB_CIM_BATCH_SCRIPT);
  assert.equal(chamadas[0].options.windowsHide, true);
  assert.equal(chamadas[0].options.timeout, USB_CIM_TIMEOUT_MS);
  assert.equal(resultado.volumes[0].VolumeName, "PEN-LOTE");
});

test("executor do lote: falha do powershell rejeita (desconhecido, nunca inventado)", async () => {
  const execute = createPowerShellCimBatchExecutor((file, args, options, callback) => {
    callback(new Error("exit 1"), "");
  });
  await assert.rejects(execute(), /exit 1/);
});
