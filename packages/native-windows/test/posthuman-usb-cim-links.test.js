/**
 * POSTHUMAN13 — REFERENCIAS CIM REAIS DOS LINKS disco→particao→volume.
 *
 * CAUSA MEDIDA (13/10, so' metadados Windows; nenhum conteudo de volume lido):
 * `Get-CimInstance Win32_LogicalDiskToPartition | Select-Object Antecedent,Dependent |
 * ConvertTo-Json -Compress` — a query EXACTA da producao, profundidade por omissao —
 * serializa cada referencia como
 *
 *   { CimClass: "...", CimInstanceProperties: "... DeviceID = \"Disk #N, Partition #M\" ...",
 *     CimSystemProperties: "Microsoft.Management.Infrastructure.CimSystemProperties" }
 *
 * ou seja, o DeviceID vive DENTRO do TEXTO de `CimInstanceProperties`. Nem a forma
 * `{ DeviceID }` nem a string de referencia (as duas que as fixtures antigas usavam)
 * ocorrem nesta serializacao real — por isso o join antigo nao encontrava associacao
 * NENHUMA e as 4 queries produziam 0 dispositivos.
 *
 * PROVA DE PROFUNDIDADE (medida com a mesma query):
 *  - profundidade por omissao (a da producao): `CimInstanceProperties` e' STRING (blob)
 *    com EXACTAMENTE 1 `DeviceID = "..."` e nenhuma outra propriedade valorizada;
 *  - `-Depth 3`: passa a ARRAY de strings; o unico elemento com valor e'
 *    exactamente `DeviceID = "..."`;
 *  - `-Depth 4`: ARRAY de objetos `{ Name, Value, CimType, Flags, IsValueModified }`.
 *
 * REGRA DO PARSER (estrita): exactamente UM DeviceID nao vazio. Zero (missing) ou
 * varios (ambiguo) => null. Nunca se escolhe um DeviceID entre varios: uma
 * associacao ambigua nao prova armazenamento.
 *
 * FIXTURES: so' ESTRUTURA, com identificadores FICTICIOS (nenhum serial/PNP/nome de
 * volume real; as listas de propriedades sao o schema publico CIM). Nenhum
 * PowerShell corre aqui — o executor e' fake.
 *
 * Uso: node --test packages/native-windows/test/posthuman-usb-cim-links.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  USB_CIM_QUERIES,
  UsbStorageEnumerator,
  identifyUsbStorageDevices,
  parseCimReferenceValue,
} from "../src/usb-storage.ts";

// ── Schema CIM publico (ordem real da instancia; so' nomes de propriedades) ──

const NOMES_PARTICAO =
  "Caption Description InstallDate Name Status Availability ConfigManagerErrorCode ConfigManagerUserConfig CreationClassName DeviceID ErrorCleared ErrorDescription LastErrorCode PNPDeviceID PowerManagementCapabilities PowerManagementSupported StatusInfo SystemCreationClassName SystemName Access BlockSize ErrorMethodology NumberOfBlocks Purpose Bootable PrimaryPartition BootPartition DiskIndex HiddenSectors Index RewritePartition Size StartingOffset Type".split(
    " ",
  );

const NOMES_VOLUME =
  "Caption Description InstallDate Name Status Availability ConfigManagerErrorCode ConfigManagerUserConfig CreationClassName DeviceID ErrorCleared ErrorDescription LastErrorCode PNPDeviceID PowerManagementCapabilities PowerManagementSupported StatusInfo SystemCreationClassName SystemName Access BlockSize ErrorMethodology NumberOfBlocks Purpose FreeSpace Size Compressed DriveType FileSystem MaximumComponentLength MediaType ProviderName QuotasDisabled QuotasIncomplete QuotasRebuilding SupportsDiskQuotas SupportsFileBasedCompression VolumeDirty VolumeName VolumeSerialNumber".split(
    " ",
  );

/**
 * Blob real (profundidade por omissao): a lista de nomes do schema com APENAS a
 * propriedade-chave valorizada — medido em todas as referencias da maquina.
 */
function blob(nomes, valor) {
  return nomes.map((nome) => (nome === "DeviceID" ? `DeviceID = "${valor}"` : nome)).join(" ");
}

/** Referencia CIM real de particao/volume (forma blob, a da PRODUCAO). */
function refBlob(nomes, valor) {
  return {
    CimClass: "ROOT/cimv2:Win32_DiskPartition",
    CimInstanceProperties: blob(nomes, valor),
    CimSystemProperties: "Microsoft.Management.Infrastructure.CimSystemProperties",
  };
}

/** Referencia CIM a `-Depth 3`: array de strings com o elemento DeviceID valorizado. */
function refArrayStrings(nomes, valor) {
  return {
    CimClass: "ROOT/cimv2:Win32_DiskPartition",
    CimInstanceProperties: nomes.map((nome) => (nome === "DeviceID" ? `DeviceID = "${valor}"` : nome)),
    CimSystemProperties: "Microsoft.Management.Infrastructure.CimSystemProperties",
  };
}

/** Referencia CIM a `-Depth 4`: array de objetos { Name, Value, ... }. */
function refArrayObjetos(nomes, valor) {
  return {
    CimClass: "ROOT/cimv2:Win32_DiskPartition",
    CimInstanceProperties: nomes.map((nome) => ({
      Name: nome,
      Value: nome === "DeviceID" ? valor : null,
      CimType: 14,
      Flags: nome === "DeviceID" ? "Property, Key, ReadOnly, NotModified" : "Property, ReadOnly, NotModified, NullValue",
      IsValueModified: false,
    })),
    CimSystemProperties: "Microsoft.Management.Infrastructure.CimSystemProperties",
  };
}

// ── Dispositivo FICTICIO (estrutura real: disco USB → particao → volume) ────

const FICTICIO = {
  disco: {
    Index: 9,
    InterfaceType: "USB",
    MediaType: "Removable Media",
    SerialNumber: "PEN-POSTHUMAN-FICTICIA",
    PNPDeviceID: "USBSTOR\\DISK&VEN_FICTICIA&PROD_PEN&REV_1.00\\PEN-POSTHUMAN-FICTICIA&0",
    Size: 4_000_000_000,
  },
  particao: { DiskIndex: 9, DeviceID: "Disk #9, Partition #0", Type: "FAT32" },
  volume: { DeviceID: "Q:", VolumeName: "PEN FICTICIA", DriveType: 2, Size: 3_990_000_000 },
};

/** Enumeracao com os links na forma pedida (blob por omissao, como a producao). */
function enumeracao(links, overrides = {}) {
  return {
    disks: [FICTICIO.disco],
    partitions: [FICTICIO.particao],
    links,
    volumes: [FICTICIO.volume],
    ...overrides,
  };
}

async function detect(enumeration) {
  const enumerator = new UsbStorageEnumerator(async (script) => {
    if (script === USB_CIM_QUERIES.disks) return enumeration.disks;
    if (script === USB_CIM_QUERIES.partitions) return enumeration.partitions;
    if (script === USB_CIM_QUERIES.links) return enumeration.links;
    return enumeration.volumes;
  });
  return identifyUsbStorageDevices(await enumerator.enumerate());
}

const LINKS_BLOB = [
  {
    Antecedent: refBlob(NOMES_PARTICAO, FICTICIO.particao.DeviceID),
    Dependent: refBlob(NOMES_VOLUME, FICTICIO.volume.DeviceID),
  },
];

// ── Testes ──────────────────────────────────────────────────────────────────

test("forma REAL da producao (blob CimInstanceProperties): pen detetada com identidade e raiz", async () => {
  const devices = await detect(enumeracao(LINKS_BLOB));
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, "usb-serial:PEN-POSTHUMAN-FICTICIA");
  assert.equal(devices[0].identityProvenance, "disk-serial");
  assert.deepEqual(devices[0].rootPaths, ["Q:\\"]);
  assert.equal(devices[0].rootPath, "Q:\\");
  assert.equal(devices[0].label, "PEN FICTICIA");
});

test("depth 3 (array de strings): mesma deteccao, mesma identidade", async () => {
  const devices = await detect(
    enumeracao([
      {
        Antecedent: refArrayStrings(NOMES_PARTICAO, FICTICIO.particao.DeviceID),
        Dependent: refArrayStrings(NOMES_VOLUME, FICTICIO.volume.DeviceID),
      },
    ]),
  );
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, "usb-serial:PEN-POSTHUMAN-FICTICIA");
  assert.deepEqual(devices[0].rootPaths, ["Q:\\"]);
});

test("depth 4 (array de objetos Name/Value): mesma deteccao", async () => {
  const devices = await detect(
    enumeracao([
      {
        Antecedent: refArrayObjetos(NOMES_PARTICAO, FICTICIO.particao.DeviceID),
        Dependent: refArrayObjetos(NOMES_VOLUME, FICTICIO.volume.DeviceID),
      },
    ]),
  );
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, "usb-serial:PEN-POSTHUMAN-FICTICIA");
  assert.deepEqual(devices[0].rootPaths, ["Q:\\"]);
});

test("formas antigas continuam aceites: string de referencia e objeto {DeviceID}", () => {
  assert.equal(
    parseCimReferenceValue('\\\\PC\\root\\cimv2:Win32_LogicalDisk.DeviceID="Q:"'),
    "Q:",
  );
  assert.equal(parseCimReferenceValue({ DeviceID: "Disk #9, Partition #0" }), "Disk #9, Partition #0");
});

test("missingID: sem DeviceID valorizado (blob ou array) => null, associacao ignorada", async () => {
  const nomesSemValor = NOMES_PARTICAO.filter((nome) => nome !== "DeviceID");
  const blobSemDevice = refBlob(nomesSemValor, "");
  assert.equal(parseCimReferenceValue(blobSemDevice), null);
  assert.equal(parseCimReferenceValue(refArrayStrings(nomesSemValor, "")), null);
  assert.equal(
    parseCimReferenceValue(refArrayObjetos([{ Name: "Caption" }, { Name: "PNPDeviceID" }], "")),
    null,
  );

  // A associacao inteira e' ignorada: sem prova de armazenamento nao ha' dispositivo.
  const devices = await detect(
    enumeracao([{ Antecedent: blobSemDevice, Dependent: refBlob(NOMES_VOLUME, "Q:") }]),
  );
  assert.equal(devices.length, 0);
});

test("ambiguo: 2+ DeviceID na mesma referencia => null (nunca se escolhe um deles)", async () => {
  const blobAmbiguo = {
    ...refBlob(NOMES_PARTICAO, "Disk #9, Partition #0"),
    CimInstanceProperties: `CreationClassName DeviceID = "Disk #9, Partition #0" DeviceID = "Disk #1, Partition #0" Type`,
  };
  assert.equal(parseCimReferenceValue(blobAmbiguo), null);
  assert.equal(
    parseCimReferenceValue({
      CimInstanceProperties: ["DeviceID = \"Disk #9, Partition #0\"", "DeviceID = \"Disk #1, Partition #0\""],
    }),
    null,
  );
  assert.equal(
    parseCimReferenceValue({
      CimInstanceProperties: [
        { Name: "DeviceID", Value: "Disk #9, Partition #0" },
        { Name: "DeviceID", Value: "Disk #1, Partition #0" },
      ],
    }),
    null,
  );

  const devices = await detect(
    enumeracao([{ Antecedent: blobAmbiguo, Dependent: refBlob(NOMES_VOLUME, "Q:") }]),
  );
  assert.equal(devices.length, 0);
});

test("PNPDeviceID valorizado NUNCA e' confundido com DeviceID", () => {
  const blobSemDevice = {
    CimInstanceProperties:
      'CreationClassName PNPDeviceID = "USBSTOR\\DISK&VEN_FICTICIA&PROD_PEN" DeviceID ErrorCleared',
  };
  assert.equal(parseCimReferenceValue(blobSemDevice), null);

  const blobComAmbos = {
    CimInstanceProperties:
      'PNPDeviceID = "USBSTOR\\DISK&VEN_FICTICIA&PROD_PEN" DeviceID = "Q:"',
  };
  assert.equal(parseCimReferenceValue(blobComAmbos), "Q:");
});

test("ambiguidade conta OCORRENCIAS do nome DeviceID (valid+empty / valid+bare => null)", async () => {
  // Dois DeviceID na mesma referencia sao ambiguos MESMO quando um deles nao tem
  // valor: conta-se a OCORRENCIA do nome, nao apenas os valores validos.
  assert.equal(
    parseCimReferenceValue({ CimInstanceProperties: 'CreationClassName DeviceID = "Q:" DeviceID = "" Type' }),
    null,
  );
  assert.equal(
    parseCimReferenceValue({ CimInstanceProperties: 'CreationClassName DeviceID = "Q:" DeviceID Type' }),
    null,
  );
  assert.equal(
    parseCimReferenceValue('Win32_LogicalDisk.DeviceID="Q:" PNPDeviceID="ficticio" DeviceID=""'),
    null,
  );
  assert.equal(parseCimReferenceValue({ CimInstanceProperties: ['DeviceID = "Q:"', "DeviceID"] }), null);
  assert.equal(
    parseCimReferenceValue({
      CimInstanceProperties: [
        { Name: "DeviceID", Value: "Q:" },
        { Name: "DeviceID", Value: null },
      ],
    }),
    null,
  );

  // No join: referencia ambigua nao prova armazenamento.
  const blobValidoMaisVazio = {
    CimInstanceProperties: 'CreationClassName DeviceID = "Disk #9, Partition #0" DeviceID = "" Type',
  };
  const devices = await detect(
    enumeracao([{ Antecedent: blobValidoMaisVazio, Dependent: refBlob(NOMES_VOLUME, "Q:") }]),
  );
  assert.equal(devices.length, 0);
});
