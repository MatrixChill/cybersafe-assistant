/**
 * R8 — NORMALIZACAO RIGOROSA DOS INDICES CIM (native-windows).
 *
 * RED independente (Codex, 13/10): um disco com `Index: null` e
 * `InterfaceType: USB` era empacotado como indice 0 pela coercao
 * antiga (`Number(null) === 0`) e o join encontrava a particao
 * `DiskIndex: 0` — um dispositivo era detetado onde nao existe
 * prova nenhuma de armazenamento. O mesmo valia para `""`, `"   "`,
 * booleanos, negativos e fracionarios.
 *
 * Regra: um indice CIM (Index/DiskIndex) e' um INTEIRO NAO NEGATIVO.
 * Qualquer outra forma — null, ausente, vazio, booleano, negativo,
 * fracionario, texto nao numerico — e' ausencia de indice, e ausencia
 * de indice significa SEM JOIN (nunca "disco 0").
 *
 * Estes testes correm o PIPELINE REAL (enumerador -> join puro), com a
 * forma exata que o PowerShell emite (chaves PascalCase do schema CIM).
 * Sem PowerShell, sem OS, sem pen.
 *
 * Uso: node --test packages/native-windows/test/r8-usb-index-normalization.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  USB_CIM_QUERIES,
  UsbStorageEnumerator,
  identifyUsbStorageDevices,
} from "../src/usb-storage.ts";

/** Um disco USB valido com o `Index` cru que se quer testar. */
function fixture(rawIndex, overrides = {}) {
  return {
    disks: [
      {
        Index: rawIndex,
        InterfaceType: "USB",
        SerialNumber: "FICTICIO-1",
        PNPDeviceID: "USBSTOR\\DISK&VEN_FICT&PROD_FAKE&REV_1.0",
      },
    ],
    partitions: [{ DiskIndex: 0, DeviceID: "Disk #0, Partition #0" }],
    links: [
      {
        Antecedent: { DeviceID: "Disk #0, Partition #0" },
        Dependent: { DeviceID: "E:" },
      },
    ],
    volumes: [{ DeviceID: "E:", VolumeName: "FICTICIA", DriveType: 2 }],
    ...overrides,
  };
}

/** Corre enumerador -> join com a fixture crua (isto e' o pipeline real). */
async function detect(rawIndex, overrides = {}) {
  const data = fixture(rawIndex, overrides);
  const enumerator = new UsbStorageEnumerator(async (script) => {
    if (script === USB_CIM_QUERIES.disks) return data.disks;
    if (script === USB_CIM_QUERIES.partitions) return data.partitions;
    if (script === USB_CIM_QUERIES.links) return data.links;
    return data.volumes;
  });
  const enumeration = await enumerator.enumerate();
  return {
    devices: identifyUsbStorageDevices(enumeration),
    enumeration,
  };
}

test("BITE: Index null NAO vira disco 0 (nenhum dispositivo sem prova de armazenamento)", async () => {
  const { devices, enumeration } = await detect(null);
  assert.equal(enumeration.disks[0].index, undefined, "index null tem de normalizar para ausente");
  assert.equal(devices.length, 0, "sem indice nao ha join com 'Disk #0, Partition #0'");
});

test("Index em branco (\"\" e \"   \") NAO vira disco 0", async () => {
  for (const raw of ["", "   ", "\t"]) {
    const { devices } = await detect(raw);
    assert.equal(devices.length, 0, `Index ${JSON.stringify(raw)} nao pode juntar-se a particao 0`);
  }
});

test("Index booleano NAO vira 0/1 (true e false nao sao indices CIM)", async () => {
  for (const raw of [true, false]) {
    const { devices, enumeration } = await detect(raw);
    assert.equal(enumeration.disks[0].index, undefined, `Index ${raw} tem de normalizar para ausente`);
    assert.equal(devices.length, 0);
  }
});

test("Index negativo e' rejeitado (nao existe disco #-1)", async () => {
  const { devices, enumeration } = await detect(-1);
  assert.equal(enumeration.disks[0].index, undefined);
  assert.equal(devices.length, 0);
});

test("Index fracionario e' rejeitado (1.5 e \"1.5\" nao sao indices)", async () => {
  for (const raw of [1.5, "1.5", 1.0001]) {
    const { devices, enumeration } = await detect(raw);
    assert.equal(enumeration.disks[0].index, undefined, `Index ${raw} tem de normalizar para ausente`);
    assert.equal(devices.length, 0);
  }
});

test("Index nao numerico e' rejeitado (\"abc\", \"1abc\", \"0x1\", NaN, Infinity)", async () => {
  for (const raw of ["abc", "1abc", "0x1", "1e1", Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
    const { devices, enumeration } = await detect(raw);
    assert.equal(enumeration.disks[0].index, undefined, `Index ${JSON.stringify(raw)} nao e' um indice`);
    assert.equal(devices.length, 0);
  }
});

test("DiskIndex nas particoes segue a mesma regra (null/blank/bool/negativo/fracionario nao juntam)", async () => {
  for (const raw of [null, "", "   ", true, false, -1, 1.5, "1.5", "abc"]) {
    const { devices } = await detect(0, {
      partitions: [{ DiskIndex: raw, DeviceID: "Disk #0, Partition #0" }],
    });
    assert.equal(devices.length, 0, `DiskIndex ${JSON.stringify(raw)} nao pode juntar-se ao disco 0`);
  }
});

test("indices validos continuam a funcionar: 0, 1, \"2\" (nao sobre-rejeitar)", async () => {
  const zero = await detect(0);
  assert.equal(zero.enumeration.disks[0].index, 0);
  assert.equal(zero.devices.length, 1, "disco 0 com particao 0 e' valido");
  assert.equal(zero.devices[0].rootPath, "E:\\");

  const um = await detect(1, {
    partitions: [{ DiskIndex: 1, DeviceID: "Disk #1, Partition #0" }],
    links: [
      {
        Antecedent: { DeviceID: "Disk #1, Partition #0" },
        Dependent: { DeviceID: "E:" },
      },
    ],
  });
  assert.equal(um.devices.length, 1);
  assert.equal(um.devices[0].id, "usb-serial:FICTICIO-1");

  const texto = await detect("2", {
    partitions: [{ DiskIndex: "2", DeviceID: "Disk #2, Partition #0" }],
    links: [
      {
        Antecedent: { DeviceID: "Disk #2, Partition #0" },
        Dependent: { DeviceID: "E:" },
      },
    ],
  });
  assert.equal(texto.enumeration.disks[0].index, 2, "string numerica inteira continua a ser aceite");
  assert.equal(texto.devices.length, 1);
});

test("identidade instavel: um disco USB sem indice nao produz identidade usb-index:0", async () => {
  const { devices } = await detect(null);
  assert.deepEqual(devices, [], "sem indice nao ha dispositivo — logo nao ha identidade para emitir");
});

test("Size e DriveType tambem sao rigorosos: null/blank/bool nunca viram 0", async () => {
  const { enumeration } = await detect(0, {
    disks: [
      {
        Index: 0,
        InterfaceType: "USB",
        SerialNumber: "FICTICIO-1",
        Size: null,
      },
    ],
    volumes: [{ DeviceID: "E:", VolumeName: "FICTICIA", DriveType: null, Size: "   " }],
  });
  assert.equal(enumeration.disks[0].size, undefined, "Size null nao e' 0 bytes");
  assert.equal(enumeration.volumes[0].driveType, undefined, "DriveType null nao e' drive type 0");
  assert.equal(enumeration.volumes[0].size, undefined, "Size em branco nao e' 0 bytes");

  const { enumeration: comBool } = await detect(0, {
    volumes: [{ DeviceID: "E:", DriveType: false, Size: true }],
  });
  assert.equal(comBool.volumes[0].driveType, undefined);
  assert.equal(comBool.volumes[0].size, undefined);
});

test("quatro discos dos quais so' um tem indice valido: so' esse pode juntar", async () => {
  const enumerator = new UsbStorageEnumerator(async (script) => {
    if (script === USB_CIM_QUERIES.disks) {
      return [
        { Index: null, InterfaceType: "USB", SerialNumber: "SEM-INDICE" },
        { Index: 0, InterfaceType: "USB", SerialNumber: "COM-INDICE-0" },
        { Index: -2, InterfaceType: "USB", SerialNumber: "NEGATIVO" },
        { Index: 3.5, InterfaceType: "USB", SerialNumber: "FRACIONARIO" },
      ];
    }
    if (script === USB_CIM_QUERIES.partitions) {
      return [{ DiskIndex: 0, DeviceID: "Disk #0, Partition #0" }];
    }
    if (script === USB_CIM_QUERIES.links) {
      return [
        {
          Antecedent: { DeviceID: "Disk #0, Partition #0" },
          Dependent: { DeviceID: "E:" },
        },
      ];
    }
    return [{ DeviceID: "E:", DriveType: 2 }];
  });
  const devices = identifyUsbStorageDevices(await enumerator.enumerate());
  assert.equal(devices.length, 1, "so' o disco com indice 0 pode juntar-se a particao 0");
  assert.equal(devices[0].id, "usb-serial:COM-INDICE-0");
});
