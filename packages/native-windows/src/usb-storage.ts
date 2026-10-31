/**
 * R8 — Deteccao de armazenamento USB (read-only).
 *
 * Contrato (R8-USB-CONTRACT-CODEX-2026-10-12.md):
 *  - A deteccao confirma ARMAZENAMENTO E TRANSPORTE
 *    USB, por CIM/discos/associacoes Windows.
 *    DriveType=2 isolado NAO prova USB (ha
 *    removiveis nao-USB); transporte USB sem
 *    volume montado NAO prova armazenamento.
 *  - A identidade e' do disco fisico (serial, ou
 *    PNPDeviceID), NUNCA so' a letra — a letra pode
 *    ser reutilizada por outro dispositivo. Sem
 *    serial nem PNPDeviceID, a identidade e'
 *    instavel (indice reciclavel entre insercoes) e
 *    e' declarada como limitacao: o servico recusa
 *    auto-scan nesses casos.
 *  - Falha de enumeracao = desconhecido/indisponivel,
 *    nunca deteccao inventada.
 *  - Sem PowerShell no import: o executor real so'
 *    corre quando e' invocado em runtime. Os testes
 *    injetam fixtures no join puro.
 */

/** Win32_DiskDrive.InterfaceType "USB" = transporto USB. */
export const USB_INTERFACE_TYPE = "USB";

/** Timeout por query CIM (o mesmo das queries de saude existentes). */
export const USB_CIM_TIMEOUT_MS = 15_000;

/** Um disco fisico (Win32_DiskDrive). */
export interface UsbDiskDrive {
  /**
   * Win32_DiskDrive.Index. Ausente = sem join
   * possivel com particoes — NUNCA vira 0.
   */
  index?: number;
  /**
   * Win32_DiskDrive.InterfaceType ("USB", "SATA",
   * ...). Unica prova de transporto USB nesta
   * classe: Win32_DiskDrive NAO tem BusType
   * (propriedade de MSFT_Disk/Get-Disk).
   */
  interfaceType?: string;
  mediaType?: string;
  /** Win32_DiskDrive.SerialNumber — base da identidade estavel. */
  serial?: string;
  /** Win32_DiskDrive.PNPDeviceID — fallback de identidade. */
  pnpDeviceId?: string;
  size?: number;
}

/** Uma particao (Win32_DiskPartition). */
export interface UsbPartition {
  /**
   * Win32_DiskPartition.DiskIndex. Ausente = sem
   * join possivel com o disco.
   */
  diskIndex?: number;
  /** DeviceID CIM ("Disk #1, Partition #0") — chave das associacoes. */
  deviceId: string;
  type?: string;
}

/**
 * Associacao particao -> volume (Win32_LogicalDiskToPartition).
 *
 * FORMA REAL MEDIDA (13/10): com a query da producao (profundidade por
 * omissao), cada referencia chega com o DeviceID DENTRO do texto de
 * CimInstanceProperties — { CimClass, CimInstanceProperties, CimSystemProperties }
 * (-Depth 3: array de strings; -Depth 4: array de { Name, Value }).
 * Exemplo de string de referencia:
 * ("\\\\PC\\root\\cimv2:Win32_LogicalDisk.DeviceID=\"E:\""),
 * Aceites por parseCimReferenceValue: a forma real acima, a string de
 * referencia e o objeto { DeviceID } — SEMPRE com DeviceID UNICO: zero
 * (missing) ou varios (ambiguo) = referencia ilegivel, associacao ignorada.
 */
export interface UsbPartitionLink {
  antecedent?: unknown;
  dependent?: unknown;
}

/** Um volume logico (Win32_LogicalDisk). */
export interface UsbLogicalVolume {
  /** DeviceID ("E:") — sempre letra + dois-pontos. */
  deviceId: string;
  volumeName?: string;
  /**
   * 2 = removable. NUNCA prova USB sozinho (e
   * discos USB externos podem reportar fixo).
   */
  driveType?: number;
  size?: number;
}

/** Resultado bruto das 4 queries CIM, antes do join. */
export interface UsbEnumeration {
  disks: UsbDiskDrive[];
  partitions: UsbPartition[];
  links: UsbPartitionLink[];
  volumes: UsbLogicalVolume[];
}

/**
 * Provas de estabilidade da identidade de
 * insercao. "disk-index-fallback" e' reciclavel
 * entre insercoes: o servico recusa auto-scan
 * com limitacao declarada.
 */
export type UsbIdentityProvenance =
  | "disk-serial"
  | "pnp-device-id"
  | "disk-index-fallback";

/** Um dispositivo de armazenamento USB confirmado. */
export interface UsbStorageDevice {
  /** Identidade estavel da insercao/dispositivo. */
  id: string;
  /** Como a identidade foi provada. */
  identityProvenance: UsbIdentityProvenance;
  /** Qual propriedade CIM provou o transporte/removibilidade (nunca inventada). */
  transportProof?: UsbTransportProof;
  /**
   * Todas as unidades (letras) do dispositivo,
   * ordenadas (ex.: ["E:\\", "F:\\"]). Um disco
   * com varias particoes tem varias raizes — a
   * primeira e' a padrao; o servico declara a
   * cobertura como limitacao quando ha mais.
   */
  rootPaths: string[];
  /** Primeira unidade ordenada — raiz padrao de analise. */
  rootPath: string;
  /** Nome do volume da primeira unidade, quando o Windows o publica. */
  label?: string;
}

/**
 * As 4 queries CIM (dumb — o join e' feito em JS,
 * puro e testavel). Chaves sao o schema CIM real
 * (PascalCase — e' o que o PowerShell/ConvertTo-Json
 * emite).
 */
export const USB_CIM_QUERIES = {
  disks: "Get-CimInstance Win32_DiskDrive | Select-Object Index,InterfaceType,MediaType,SerialNumber,PNPDeviceID,Size | ConvertTo-Json -Compress",
  partitions: "Get-CimInstance Win32_DiskPartition | Select-Object DiskIndex,DeviceID,Type | ConvertTo-Json -Compress",
  links: "Get-CimInstance Win32_LogicalDiskToPartition | Select-Object Antecedent,Dependent | ConvertTo-Json -Compress",
  volumes: "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType,Size | ConvertTo-Json -Compress",
} as const;

/** Ordem canonica das quatro secoes (a mesma do lote). */
export const USB_CIM_SECTION_KEYS = ["disks", "partitions", "links", "volumes"] as const;
export type UsbCimSectionKey = (typeof USB_CIM_SECTION_KEYS)[number];

/**
 * Marcador de secao do lote (P0 PERFORMANCE, 14/10/2026).
 *
 * MEDIDO no produto instalado: a enumeracao USB corria a cada 5 s e cada
 * ciclo lancava QUATRO processos `powershell.exe` (um por query CIM) — 48
 * processos por minuto, em repouso, sempre (cada um com ~200-400 ms de CPU e
 * uma alocacao transitoria de dezenas de MB, mais a inspecao do antivirus a
 * cada processo novo). Num equipamento de 8 GB e' isto que se sente como
 * "computador pesado".
 *
 * O lote abaixo faz AS MESMAS quatro queries, com os MESMOS campos, dentro de
 * UM processo: o custo por ciclo passa de 4 arranques de PowerShell para 1. Nao
 * muda a cadencia, nao muda o que se deteta, nao muda o timeout.
 */
export function usbCimSectionMarker(key: UsbCimSectionKey): string {
  return `###CYBERSAFE-CIM-${key.toUpperCase()}###`;
}

/** As quatro queries num so processo (secções delimitadas por marcador). */
export const USB_CIM_BATCH_SCRIPT = USB_CIM_SECTION_KEYS.map(
  (key) => `Write-Output '${usbCimSectionMarker(key)}'\n${USB_CIM_QUERIES[key]}`,
).join("\n");

/** Regex de letra de unidade estrita ("E:"). */
const DRIVE_LETTER_PATTERN = /^[A-Za-z]:$/;

/**
 * Extrai o DeviceID de uma referencia CIM: aceita a
 * referencia como string ("...DeviceID=\"E:\"") ou
 * como objeto CIM ({ DeviceID: "E:" }), o objeto CimInstance do PowerShell
 * 5.1 (DeviceID dentro de CimInstanceProperties: blob string por omissao,
 * array de strings a -Depth 3, array de { Name, Value } a -Depth 4).
 * REGRA ESTRITA: EXACTAMENTE UMA ocorrencia do nome `DeviceID`, com valor nao
 * vazio. Zero, varias (ambiguo — mesmo que so' uma tenha valor) ou sem valor
 * => null: associacao sem prova nao prova armazenamento.
 */
export function parseCimReferenceValue(reference: unknown): string | null {
  if (typeof reference === "string") {
    if (contarOcorrenciasDeviceId(reference) !== 1) return null;
    const match = /(?<![A-Za-z])DeviceID="([^"]+)"/.exec(reference);
    return match && match[1] !== "" ? match[1] : null;
  }
  if (
    typeof reference === "object" &&
    reference !== null &&
    !Array.isArray(reference)
  ) {
    const obj = reference as Record<string, unknown>;
    const direto = obj.DeviceID;
    if (typeof direto === "string" && direto !== "") return direto;
    return deviceIdDePropriedades(obj.CimInstanceProperties);
  }
  return null;
}

/**
 * Conta OCORRENCIAS do NOME `DeviceID` (valorizado ou nao). O lookaround impede
 * que `PNPDeviceID` (ou outro nome maior) seja contado como `DeviceID`.
 */
function contarOcorrenciasDeviceId(texto: string): number {
  return [...texto.matchAll(/(?<![A-Za-z0-9_])DeviceID(?![A-Za-z0-9_])/g)].length;
}

/**
 * DeviceID dentro de `CimInstanceProperties` do PowerShell: blob string
 * (profundidade por omissao), array de strings (-Depth 3) ou array de
 * { Name, Value } (-Depth 4).
 *
 * REGRA: EXACTAMENTE UMA ocorrencia da propriedade DeviceID (valorizada ou nao)
 * E valor nao vazio. Zero ocorrencias, duas ou mais (ambigua — mesmo que so'
 * uma tenha valor) ou a unica sem valor => null. Nada disto inventa um alvo.
 */
function deviceIdDePropriedades(propriedades: unknown): string | null {
  if (typeof propriedades === "string") {
    if (contarOcorrenciasDeviceId(propriedades) !== 1) return null;
    const match = /(?:^|\s)DeviceID\s*=\s*"([^"]+)"/.exec(propriedades);
    return match && match[1] !== "" ? match[1] : null;
  }
  if (!Array.isArray(propriedades)) return null;
  const ocorrencias = propriedades.filter(ehOcorrenciaDeviceId);
  if (ocorrencias.length !== 1) return null;
  const valor = valorDaOcorrenciaDeviceId(ocorrencias[0]);
  return typeof valor === "string" && valor !== "" ? valor : null;
}

/** Uma ocorrencia do NOME DeviceID (com ou sem valor) numa propriedade serializada. */
function ehOcorrenciaDeviceId(elemento: unknown): boolean {
  if (typeof elemento === "string") {
    const texto = elemento.trim();
    return texto === "DeviceID" || /^DeviceID\s*=/.test(texto);
  }
  if (elemento !== null && typeof elemento === "object") {
    return (elemento as { Name?: unknown }).Name === "DeviceID";
  }
  return false;
}

/** Valor da ocorrencia, quando existe e e' string nao vazia. */
function valorDaOcorrenciaDeviceId(elemento: unknown): string | null {
  if (typeof elemento === "string") {
    const match = /^DeviceID\s*=\s*"([^"]+)"$/.exec(elemento.trim());
    return match ? match[1] : null;
  }
  if (elemento !== null && typeof elemento === "object") {
    const valor = (elemento as { Value?: unknown }).Value;
    return typeof valor === "string" ? valor : null;
  }
  return null;
}

/**
 * Transporto USB: Win32_DiskDrive.InterfaceType
 * "USB" (case-insensivel). BusType NAO existe em
 * Win32_DiskDrive (e' propriedade de MSFT_Disk),
 * logo nao e' consultado nem inventado.
 */
/**
 * Como se provou o transporte/removibilidade do disco. NUNCA se inventa a
 * prova: cada valor corresponde a uma propriedade CIM REAL que casou.
 *
 *  - `interface-usb`   — `InterfaceType` diz USB (a prova classica);
 *  - `pnp-usbstor`     — `PNPDeviceID` com o driver de armazenamento USB
 *    (`USBSTOR`) — é prova de armazenamento USB mesmo quando o driver reporta
 *    `InterfaceType = SCSI` (bridges/enclosures/UASP, medido em campo);
 *  - `pnp-usb-bridge`  — `PNPDeviceID` com o caminho do barramento USB
 *    (`USB\\VID_...`) em disco de massa.
 *
 * `MediaType = Removable Media` e `DriveType = 2` NÃO entram: provam
 * armazenamento removível, não transporte USB (contrato R8).
 *
 * P0 FIABILIDADE (14/10): um aparelho com `InterfaceType = "SCSI"` (comum em
 * pens USB 3.0 atrás de controladores UASP e em caixas USB-SATA) era INVISIVEL
 * para o produto, com o Windows a vê-lo — foi assim que a página "não
 * reconhecia" a pen que o Windows reconhecia. A prova passou a ter várias
 * fontes independentes em vez de um único campo que varia com hardware, driver
 * e fabricante; a exigência de ARMAZENAMENTO (estar em `Win32_DiskDrive`) não
 * mudou.
 */
export type UsbTransportProof = "interface-usb" | "pnp-usbstor" | "pnp-usb-bridge";

export function usbTransportProof(disk: UsbDiskDrive): UsbTransportProof | null {
  const interfaceType = typeof disk.interfaceType === "string" ? disk.interfaceType.trim().toUpperCase() : "";
  if (interfaceType === USB_INTERFACE_TYPE) return "interface-usb";

  const pnpDeviceId = typeof disk.pnpDeviceId === "string" ? disk.pnpDeviceId.trim().toUpperCase() : "";
  if (pnpDeviceId.includes("USBSTOR")) return "pnp-usbstor";
  if (/^USB[\\&]/.test(pnpDeviceId) || pnpDeviceId.includes("USB\\VID_") || pnpDeviceId.includes("USB&VID_")) {
    return "pnp-usb-bridge";
  }

  // `MediaType = Removable Media` / `DriveType = 2` NAO entram aqui de proposito:
  // provam armazenamento removivel, nao transporte USB, e alargariam a
  // deteccao a discos SATA com volume removivel (contrato R8, testado).
  return null;
}

export function isUsbTransport(disk: UsbDiskDrive): boolean {
  return usbTransportProof(disk) !== null;
}

/**
 * Identidade estavel da insercao/dispositivo e a
 * prova usada: serial do disco fisico > PNPDeviceID
 * > indice do disco (INSTAVEL — reciclavel entre
 * insercoes). NUNCA a letra.
 */
export function usbDeviceIdentity(disk: UsbDiskDrive): {
  id: string;
  provenance: UsbIdentityProvenance;
} {
  const serial = typeof disk.serial === "string" ? disk.serial.trim() : "";
  if (serial !== "") {
    return { id: `usb-serial:${serial.toUpperCase()}`, provenance: "disk-serial" };
  }
  const pnp = typeof disk.pnpDeviceId === "string" ? disk.pnpDeviceId.trim() : "";
  if (pnp !== "") {
    return { id: `usb-pnp:${pnp.toUpperCase()}`, provenance: "pnp-device-id" };
  }
  return {
    id: `usb-index:${disk.index ?? "unknown"}`,
    provenance: "disk-index-fallback",
  };
}

/**
 * Join puro: um dispositivo so' existe com
 * ARMAZENAMENTO (particao do disco associada a um
 * volume REAL publicado) E TRANSPORTE USB. Um disco
 * com varias particoes/letras e' UM dispositivo com
 * todas as raizes. Dedup por identidade de insercao.
 */
export function identifyUsbStorageDevices(
  enumeration: UsbEnumeration,
): UsbStorageDevice[] {
  const devices: UsbStorageDevice[] = [];
  const seen = new Set<string>();

  // Volumes reais (Win32_LogicalDisk), ordenados por letra.
  const volumes = [...(enumeration.volumes ?? [])]
    .filter(
      (volume) =>
        typeof volume?.deviceId === "string" &&
        DRIVE_LETTER_PATTERN.test(volume.deviceId),
    )
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  const volumeByLetter = new Map(
    volumes.map((volume) => [volume.deviceId.toUpperCase(), volume]),
  );

  // Associacoes particao -> letra, mas so' quando a
  // letra corresponde a um volume REAL publicado:
  // uma referencia a volume inexistente nao prova
  // armazenamento acessivel.
  const letterByPartition = new Map<string, string>();
  for (const link of enumeration.links ?? []) {
    const partition = parseCimReferenceValue(link?.antecedent);
    const volume = parseCimReferenceValue(link?.dependent);
    if (partition === null || volume === null) continue;
    const letter = volume.toUpperCase();
    if (!DRIVE_LETTER_PATTERN.test(letter)) continue;
    if (!volumeByLetter.has(letter)) continue;
    letterByPartition.set(partition.toUpperCase(), letter);
  }

  const partitionsByDisk = new Map<number, UsbPartition[]>();
  for (const partition of enumeration.partitions ?? []) {
    if (typeof partition?.deviceId !== "string" || partition.deviceId === "") {
      continue;
    }
    // Indice da particao: inteiro nao negativo. Ausente/vazio/booleano/
    // negativo/fracionario = ausencia de indice (nunca disco 0).
    const diskIndex = partition.diskIndex;
    if (!isValidCimIndex(diskIndex)) continue;
    const list = partitionsByDisk.get(diskIndex) ?? [];
    list.push(partition);
    partitionsByDisk.set(diskIndex, list);
  }

  // Indice ausente nunca vira disco 0: sem indice
  // nao ha prova de armazenamento possivel.
  const disks = [...(enumeration.disks ?? [])]
    .filter((disk) => isValidCimIndex(disk?.index))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  for (const disk of disks) {
    // Transporto/removibilidade provados por UMA de varias fontes independentes
    // (DriveType=2 sozinho continua a nao provar nada).
    const transportProof = usbTransportProof(disk);
    if (transportProof === null) continue;
    const diskIndex = disk.index;
    if (!isValidCimIndex(diskIndex)) continue;
    const { id, provenance } = usbDeviceIdentity(disk);
    if (seen.has(id)) continue;
    // Prova de armazenamento ACESSIVEL: particao deste disco associada a volume
    // real (com letra).
    const letters = (partitionsByDisk.get(diskIndex) ?? [])
      .map((partition) => letterByPartition.get(partition.deviceId.toUpperCase()))
      .filter((letter): letter is string => typeof letter === "string");

    // Disco USB sem volume/letra publicados NAO e' armazenamento acessivel: nao
    // entra nesta lista (contrato R8: a analise exige uma raiz real). O estado
    // honesto de espera e' dado por `identifyAwaitingVolumeDisks`, que le a
    // MESMA enumeracao — a pagina deixa de dizer "sem dispositivo" com a pen
    // visivel no Windows.
    if (letters.length === 0) continue;

    const sortedLetters = [...new Set(letters)].sort();
    const rootPaths = sortedLetters.map((letter) => `${letter}\\`);
    const volume = volumeByLetter.get(sortedLetters[0]);
    devices.push({
      id,
      identityProvenance: provenance,
      transportProof,
      rootPaths,
      rootPath: rootPaths[0],
      label: volume?.volumeName,
    });
    seen.add(id);
  }
  return devices;
}

/**
 * Disco USB DETETADO mas ainda SEM volume/letra publicados pelo Windows.
 *
 * P0 FIABILIDADE (14/10/2026). Incidente real: o Windows mostrava a pen e a
 * pagina do CyberSafe dizia "sem dispositivo", sem mais nada — porque o join de
 * deteccao exige uma raiz analisavel e um disco sem volume nao tem nenhuma.
 * Enquanto o Windows monta (letra tardia), ou quando a associacao
 * disco→volume falha, o utilizador ficava sem explicacao e sem saber se havia
 * algo a acontecer. Esta funcao devolve ESSES discos, com o motivo da espera,
 * para a UI poder dizer "dispositivo detetado — a aguardar volume (letra)".
 *
 * Nunca e' alvo de analise: `rootPaths` vazio e' a prova disso mesmo.
 */
export interface UsbAwaitingVolumeDevice {
  /** Mesma identidade de insercao do join principal (serial/PNPDeviceID). */
  id: string;
  identityProvenance: UsbIdentityProvenance;
  transportProof: UsbTransportProof;
  /** Porque ainda nao ha raiz: explicito, nunca inventado. */
  awaitingVolume: true;
  /** Letras vistas para as particoes deste disco, quando existirem (so' diagnostico). */
  letters: string[];
}

export function identifyAwaitingVolumeDisks(
  enumeration: UsbEnumeration,
): UsbAwaitingVolumeDevice[] {
  const pendentes: UsbAwaitingVolumeDevice[] = [];
  const seen = new Set<string>();

  const volumes = [...(enumeration.volumes ?? [])]
    .filter((volume) => typeof volume?.deviceId === "string" && DRIVE_LETTER_PATTERN.test(volume.deviceId))
    .map((volume) => volume.deviceId.toUpperCase());
  const publishedLetters = new Set(volumes);

  const lettersByPartition = new Map<string, string>();
  for (const link of enumeration.links ?? []) {
    const partition = parseCimReferenceValue(link?.antecedent);
    const volume = parseCimReferenceValue(link?.dependent);
    if (partition === null || volume === null) continue;
    const letter = volume.toUpperCase();
    if (!DRIVE_LETTER_PATTERN.test(letter)) continue;
    if (!publishedLetters.has(letter)) continue;
    lettersByPartition.set(partition.toUpperCase(), letter);
  }

  const partitionsByDisk = new Map<number, UsbPartition[]>();
  for (const partition of enumeration.partitions ?? []) {
    if (typeof partition?.deviceId !== "string" || partition.deviceId === "") continue;
    if (!isValidCimIndex(partition.diskIndex)) continue;
    const list = partitionsByDisk.get(partition.diskIndex) ?? [];
    list.push(partition);
    partitionsByDisk.set(partition.diskIndex, list);
  }

  for (const disk of enumeration.disks ?? []) {
    const transportProof = usbTransportProof(disk);
    if (transportProof === null) continue;
    const diskIndex = disk.index;
    if (!isValidCimIndex(diskIndex)) continue;
    const { id, provenance } = usbDeviceIdentity(disk);
    if (seen.has(id)) continue;
    const letters = (partitionsByDisk.get(diskIndex) ?? [])
      .map((partition) => lettersByPartition.get(partition.deviceId.toUpperCase()))
      .filter((letter): letter is string => typeof letter === "string");
    // Com volume publicado, o dispositivo ja' e' armazenamento acessivel: nao
    // pertence a esta lista (esta e' a lista do que ainda ESPERA).
    if (letters.length > 0) continue;
    pendentes.push({
      id,
      identityProvenance: provenance,
      transportProof,
      awaitingVolume: true,
      letters: [],
    });
    seen.add(id);
  }
  return pendentes;
}

/** Executor de uma query CIM (injetavel — os testes nunca correm PowerShell). */
export type CimQueryExecutor = (script: string) => Promise<unknown[]>;

function asArray(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result === null || result === undefined) return [];
  return [result];
}

/**
 * Normalizacao rigorosa de um numero CIM (Index/DiskIndex/Size/
 * DriveType): um INTEIRO NAO NEGATIVO. Qualquer outra forma devolve
 * `undefined` — ausencia. A coercao antiga (`Number(value)`)
 * transformava `null`, `""` e `false` em 0: um disco com
 * `Index: null` juntava-se a particao `DiskIndex: 0` e "detetava"
 * armazenamento onde nao existe prova nenhuma (RED 13/10).
 */
function toNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[0-9]+$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Indice CIM valido: inteiro nao negativo. Defesa do join — mesmo que
 * uma enumeracao futura lhe entregue um indice cru, o join nunca casa
 * um indice ausente com o disco 0.
 */
function isValidCimIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function toText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Enumerador real: 4 queries CIM via executor
 * injetado. As chaves sao o schema CIM real
 * (PascalCase); o join e' puro
 * (identifyUsbStorageDevices), logo a deteccao e'
 * testavel sem OS nem pen.
 */
export class UsbStorageEnumerator {
  private readonly execute: CimQueryExecutor;
  private readonly executeBatch?: CimBatchExecutor;

  /**
   * `executeBatch` e' OPCIONAL de proposito: quando existe, as quatro secoes
   * vem de UM processo PowerShell; quando nao existe, mantem-se o caminho
   * antigo de quatro chamadas (o seam que os testes existentes injetam).
   */
  constructor(execute: CimQueryExecutor, executeBatch?: CimBatchExecutor) {
    this.execute = execute;
    this.executeBatch = executeBatch;
  }

  async enumerate(): Promise<UsbEnumeration> {
    const [disks, partitions, links, volumes] = this.executeBatch
      ? await this.enumerateBatched()
      : await Promise.all([
          this.execute(USB_CIM_QUERIES.disks),
          this.execute(USB_CIM_QUERIES.partitions),
          this.execute(USB_CIM_QUERIES.links),
          this.execute(USB_CIM_QUERIES.volumes),
        ]);
    return {
      disks: asArray(disks).map((raw) => {
        const disk = (raw ?? {}) as Record<string, unknown>;
        return {
          index: toNonNegativeInt(disk.Index),
          interfaceType: toText(disk.InterfaceType),
          mediaType: toText(disk.MediaType),
          serial: toText(disk.SerialNumber),
          pnpDeviceId: toText(disk.PNPDeviceID),
          size: toNonNegativeInt(disk.Size),
        };
      }),
      partitions: asArray(partitions).map((raw) => {
        const partition = (raw ?? {}) as Record<string, unknown>;
        return {
          diskIndex: toNonNegativeInt(partition.DiskIndex),
          deviceId: typeof partition.DeviceID === "string" ? partition.DeviceID : "",
          type: toText(partition.Type),
        };
      }),
      links: asArray(links).map((raw) => {
        const link = (raw ?? {}) as Record<string, unknown>;
        // Referencias CIM: passam ao join como
        // vieram (objeto ou string) — o parse e'
        // do join (parseCimReferenceValue).
        return {
          antecedent: link.Antecedent,
          dependent: link.Dependent,
        };
      }),
      volumes: asArray(volumes).map((raw) => {
        const volume = (raw ?? {}) as Record<string, unknown>;
        return {
          deviceId: typeof volume.DeviceID === "string" ? volume.DeviceID : "",
          volumeName: toText(volume.VolumeName),
          driveType: toNonNegativeInt(volume.DriveType),
          size: toNonNegativeInt(volume.Size),
        };
      }),
    };
  }

  /**
   * Uma execucao para as quatro secoes. A ordem dos valores e' a de
   * `USB_CIM_SECTION_KEYS` — o chamador desestrutura na mesma ordem das
   * quatro chamadas antigas, logo o resultado e' indistinguivel.
   */
  private async enumerateBatched(): Promise<[unknown[], unknown[], unknown[], unknown[]]> {
    const batch = await this.executeBatch!();
    return [batch.disks, batch.partitions, batch.links, batch.volumes];
  }
}

/** Assinatura de child_process.execFile (so' o que usamos). */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean },
  callback: (error: Error | null, stdout: string) => void,
) => void;

/**
 * Executor real por PowerShell (CIM). INERTE ao
 * import: so' quando e' invocado e' que o
 * powershell.exe corre. Sem admin, sem driver, sem
 * watchers, sem execucao de ficheiros do
 * dispositivo — 4 leituras CIM e nada mais. O
 * runner e' injetavel para testes (que nunca
 * correm PowerShell).
 */
/** Resultado do lote: as quatro secoes cruas, na ordem de `USB_CIM_SECTION_KEYS`. */
export interface UsbCimBatch {
  disks: unknown[];
  partitions: unknown[];
  links: unknown[];
  volumes: unknown[];
}

/** Executor do lote: UMA execucao devolve as quatro secoes. */
export type CimBatchExecutor = () => Promise<UsbCimBatch>;

/**
 * Le as quatro secoes de UMA saida de PowerShell.
 *
 * Uma secao ausente/truncada faz falhar o lote INTEIRO (desconhecido), nunca
 * "lista vazia": uma enumeracao parcial nao pode ser lida como "nao ha nada
 * ligado" — era assim que uma leitura incompleta virava uma afirmacao falsa.
 */
export function parseCimBatchOutput(stdout: string): UsbCimBatch {
  const out = {} as UsbCimBatch;
  for (let i = 0; i < USB_CIM_SECTION_KEYS.length; i += 1) {
    const key = USB_CIM_SECTION_KEYS[i];
    const marker = usbCimSectionMarker(key);
    const start = stdout.indexOf(marker);
    if (start === -1) throw new Error(`lote CIM sem a seccao ${key}: leitura desconhecida`);
    const from = start + marker.length;
    const nextKey = USB_CIM_SECTION_KEYS[i + 1];
    const end = nextKey ? stdout.indexOf(usbCimSectionMarker(nextKey), from) : stdout.length;
    if (end === -1) throw new Error(`lote CIM truncado antes da seccao ${nextKey}: leitura desconhecida`);
    out[key] = parseCimJson(stdout.slice(from, end));
  }
  return out;
}

/**
 * Executor real do LOTE: um unico `powershell.exe` para as quatro queries.
 * Mesmos scripts, mesmo timeout, mesma rejeicao em erro — o que muda e' o
 * numero de processos que o Windows tem de criar por ciclo (4 -> 1).
 */
export function createPowerShellCimBatchExecutor(execFile?: ExecFileLike): CimBatchExecutor {
  return async () => {
    const run = execFile ?? (await defaultExecFile());
    return new Promise<UsbCimBatch>((resolve, reject) => {
      run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", USB_CIM_BATCH_SCRIPT],
        { timeout: USB_CIM_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          if (error) {
            // Falha de enumeracao = desconhecido, nunca deteccao inventada.
            reject(error);
            return;
          }
          try {
            resolve(parseCimBatchOutput(stdout));
          } catch (parseError) {
            reject(parseError);
          }
        },
      );
    });
  };
}

export function createPowerShellCimExecutor(
  execFile?: ExecFileLike,
): CimQueryExecutor {
  return async (script) => {
    const run = execFile ?? (await defaultExecFile());
    return new Promise<unknown[]>((resolve, reject) => {
      run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: USB_CIM_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          if (error) {
            // Falha de enumeracao = desconhecido, nunca deteccao inventada.
            reject(error);
            return;
          }
          try {
            resolve(parseCimJson(stdout));
          } catch (parseError) {
            reject(parseError);
          }
        },
      );
    });
  };
}

async function defaultExecFile(): Promise<ExecFileLike> {
  const { execFile } = await import("node:child_process");
  return execFile as unknown as ExecFileLike;
}

/** ConvertTo-Json -Compress: array, objeto unico ou vazio. */
export function parseCimJson(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  const parsed: unknown = JSON.parse(trimmed);
  return asArray(parsed);
}
