// ── Atividade de disco por volume: PDH (pdh.dll), sem PowerShell ─────────────
//
// PORQUÊ: o PC Center tem de mostrar "atividade de leitura e escrita" e
// "velocidades de transferência" por volume. As fontes disponíveis eram:
//   * `systeminformation.disksIO()` → abre PowerShell e, medido a 26/10 nesta
//     máquina, devolveu `null` (ninguém deve mostrar 0 B/s por causa disto);
//   * `Get-Counter`/`Win32_PerfFormattedData_*` → PowerShell por poll;
//   * PDH, a API user-mode que o próprio Monitor de Recursos usa.
// Medido nesta máquina (evidence/SONDA-PDH-DISCO-20261026.txt): um poll PDH
// completo custa 0,17–0,22 ms com ZERO subprocessos, e os números respondem a
// I/O gerado de propósito (80 MB escritos/lidos → 22,5 MB/s leitura e 54,5 MB/s
// escrita em `_Total`). É o requisito §3 "preferir APIs nativas; PowerShell
// apenas quando necessário" aplicado ao disco.
//
// ARMADILHA MEDIDA (foi o que custou três sondas): o formato de
// `PdhGetFormattedCounterValue` são BITS, não um índice. `PDH_FMT_DOUBLE` é
// 0x00000200; passar 0x07 (que não define nenhum tipo) devolve
// 0xC0000BBD (argumento inválido) para TODOS os contadores — um erro de binding
// que se confunde facilmente com "este Windows não expõe discos". Por isso o
// formato vive aqui como constante nomeada e é testado, não escrito à mão no
// sítio de leitura.
//
// SEGURANÇA: `koffi` é `optionalDependency` e PDH é user-mode — não há driver,
// não há privilégio, não há terceiros. Falhou o binding ou a DLL, o resultado é
// `unavailable` com motivo; a UI mostra "Sensor indisponível", nunca 0 B/s.
//
// HONESTIDADE: só sai daqui um número se a API o preencher com um estado de
// dados válido. O primeiro `PdhCollectQueryData` depois de adicionar contadores
// ainda não tem intervalo para calcular taxas; tratar isso como "0 B/s" seria a
// mentira exata que este módulo existe para evitar, por isso `cStatus` é
// devolvido ao normalizador em vez de ser escondido.

import { createRequire } from "node:module";
import process from "node:process";

/** Formato `PDH_FMT_DOUBLE` (pdh.h). Não é um índice: é um bit. */
const PDH_FMT_DOUBLE = 0x0000_0200;
/** `PDH_CSTATUS_VALID_DATA` / `PDH_CSTATUS_NEW_DATA`: o único par de estados
 *  que prova que o número em buffer foi medido. */
const CSTATUS_VALID_DATA = 0x0000_0000;
const CSTATUS_NEW_DATA = 0x0000_0001;

/** `PDH_FMT_COUNTERVALUE`: CStatus(4) + Pad(4) + união de 8 bytes. */
const VALUE_SIZE = 16;
const OFFSET_CSTATUS = 0;
const OFFSET_DOUBLE = 8;
/** Tamanho de um handle/pointer em x64. */
const HANDLE_SIZE = 8;
/** `PdhCollectQueryData` sem nada na query (medido: PDH_NO_DATA). */
const PDH_NO_DATA = 0x8000_07d5;

export type PdhReading<T> = { status: "ok"; value: T } | { status: "unavailable"; reason: string };

/** Uma amostra crua de um contador, ainda sem qualquer interpretação. */
export interface PdhCounterSample {
  /** Caminho completo do contador, tal como foi adicionado (proveniência). */
  counter: string;
  /** Estado de dados devolvido pela própria API; distinto de "valor ausente". */
  cStatus: number;
  /** Número preenchido só quando `measured` é verdadeiro. */
  value: number | null;
  /** Verdadeiro apenas quando `cStatus` é VALID_DATA ou NEW_DATA. */
  measured: boolean;
}

export interface PdhVolumeSample {
  /** Instância PDH, por exemplo `C:` ou `_Total`. */
  instance: string;
  readBytesPerSec: PdhCounterSample;
  writeBytesPerSec: PdhCounterSample;
  readsPerSec: PdhCounterSample;
  writesPerSec: PdhCounterSample;
  idlePercent: PdhCounterSample;
}

/** Superfície mínima que este módulo precisa da DLL; sobrepõe-se em testes. */
export interface PdhBindings {
  openQuery(): bigint | null;
  addEnglishCounter(query: bigint, path: string): bigint | null;
  collect(query: bigint): number;
  formattedDouble(counter: bigint): { cStatus: number; value: number } | null;
  closeQuery(query: bigint): void;
}

/** Query e bindings em simultâneo: provar um prova o outro. */
interface Ready {
  query: bigint;
  bindings: PdhBindings;
}

const COUNTERS = {
  readBytesPerSec: "Disk Read Bytes/sec",
  writeBytesPerSec: "Disk Write Bytes/sec",
  readsPerSec: "Disk Reads/sec",
  writesPerSec: "Disk Writes/sec",
  idlePercent: "% Idle Time",
} as const;

type CounterKey = keyof typeof COUNTERS;

/** Ordem estável dos cinco contadores de um volume. */
const COUNTER_KEYS = Object.entries(COUNTERS) as [CounterKey, string][];

function loadPdh(): PdhReading<PdhBindings> {
  if (process.platform !== "win32") {
    return { status: "unavailable", reason: "plataforma-nao-suportada" };
  }
  try {
    const require = createRequire(import.meta.url);
    const koffi = require("koffi") as {
      load(name: string): { func(proto: string): (...args: unknown[]) => unknown };
    };
    const pdh = koffi.load("pdh.dll");
    // Out-pointer de handle: Buffer(8) declarado `void*`; o handle volta como
    // BigInt lido do buffer e é aceite como `void*` nas chamadas seguintes
    // (comprovado por sondas: handle inválido dá 0xC0000BBC, válido dá dados).
    const openQueryW = pdh.func("uint32 __stdcall PdhOpenQueryW(void *rsvd, size_t ctx, void *phQuery)") as (
      rsvd: null,
      ctx: number,
      phQuery: Buffer,
    ) => number;
    const addEnglishCounterW = pdh.func(
      "uint32 __stdcall PdhAddEnglishCounterW(void *hQuery, const wchar_t *szPath, size_t ctx, void *phCounter)",
    ) as (hQuery: bigint, szPath: string, ctx: number, phCounter: Buffer) => number;
    const collectQueryData = pdh.func("uint32 __stdcall PdhCollectQueryData(void *hQuery)") as (
      hQuery: bigint,
    ) => number;
    const getFormattedCounterValue = pdh.func(
      "uint32 __stdcall PdhGetFormattedCounterValue(void *hCounter, uint32_t fmt, void *pType, void *pValue)",
    ) as (hCounter: bigint, fmt: number, pType: Buffer, pValue: Buffer) => number;
    const closeQueryW = pdh.func("uint32 __stdcall PdhCloseQuery(void *hQuery)") as (hQuery: bigint) => number;

    return {
      status: "ok",
      value: {
        openQuery() {
          const buffer = Buffer.alloc(HANDLE_SIZE);
          return openQueryW(null, 0, buffer) === 0 ? buffer.readBigUInt64LE(0) : null;
        },
        addEnglishCounter(query, path) {
          const buffer = Buffer.alloc(HANDLE_SIZE);
          return addEnglishCounterW(query, path, 0, buffer) === 0 ? buffer.readBigUInt64LE(0) : null;
        },
        collect(query) {
          return collectQueryData(query) >>> 0;
        },
        formattedDouble(counter) {
          const value = Buffer.alloc(VALUE_SIZE);
          // `pType` não pode ser nulo: medido, passar nulo devolve 0xC0000BBD.
          const type = Buffer.alloc(4);
          if ((getFormattedCounterValue(counter, PDH_FMT_DOUBLE, type, value) >>> 0) !== 0) return null;
          return { cStatus: value.readUInt32LE(OFFSET_CSTATUS), value: value.readDoubleLE(OFFSET_DOUBLE) };
        },
        closeQuery(query) {
          try {
            closeQueryW(query);
          } catch {
            // Fechar a query é melhor esforço: se a DLL já não estiver utilizável
            // não há nada seguro a tentar, e o processo vai terminar de qualquer forma.
          }
        },
      },
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: `ffi-indisponivel:${error instanceof Error ? error.message.slice(0, 120) : "desconhecido"}`,
    };
  }
}

/**
 * Sonda de atividade de disco por volume. Vive uma query PDH para toda a
 * duração: abrir/fechar a query por poll seria exactamente o desperdício de
 * recursos que o requisito §3 manda evitar, e os contadores de taxa precisam de
 * dois `collect` sucessivos na MESMA query para terem um intervalo.
 */
export class PdhDiskProbe {
  private readonly bindings: PdhReading<PdhBindings>;
  private query: bigint | null = null;
  /** Instância → handles dos cinco contadores, só quando a instância está completa. */
  private counters = new Map<string, Map<CounterKey, bigint>>();

  constructor(options: { bindings?: PdhBindings } = {}) {
    this.bindings = options.bindings
      ? { status: "ok", value: options.bindings }
      : loadPdh();
  }

  get available(): boolean {
    return this.bindings.status === "ok";
  }

  /** Monta a query e os contadores das instâncias pedidas; devolve o par pronto. */
  private ensure(instances: string[]): PdhReading<Ready> {
    if (this.bindings.status === "unavailable") return this.bindings;
    const bindings = this.bindings.value;
    const wanted = new Set(instances);
    // Instâncias que desapareceram (volume retirado) ficam com os handles
    // descartados: a query continua válida, apenas deixamos de as ler.
    for (const instance of [...this.counters.keys()]) {
      if (!wanted.has(instance)) this.counters.delete(instance);
    }
    if (this.query === null) {
      const opened = bindings.openQuery();
      if (opened === null) return { status: "unavailable", reason: "PdhOpenQueryW falhou" };
      this.query = opened;
    }
    const query = this.query;
    for (const instance of wanted) {
      if (this.counters.has(instance)) continue;
      const handles = new Map<CounterKey, bigint>();
      for (const [key, suffix] of COUNTER_KEYS) {
        const handle = bindings.addEnglishCounter(query, `\\LogicalDisk(${instance})\\${suffix}`);
        if (handle === null) break;
        handles.set(key, handle);
      }
      // Metade dos contadores de uma instância não é uma leitura honesta: ou a
      // instância tem os cinco, ou não entra — nada de publicar 0 nos que faltam.
      if (handles.size === COUNTER_KEYS.length) this.counters.set(instance, handles);
    }
    if (this.counters.size === 0) {
      // Duas causas, um único motivo seria um diagnóstico falso: «ainda não foi
      // pedida nenhuma instância» (timing do chamador, resolve-se no próximo
      // tick com volumes lidos) não é «nenhum contador resolvível nesta
      // máquina» (PDH presente mas a recusar LogicalDisk). Comprovado por
      // sonda: com `["C:","_Total"]` esta mesma DLL devolve os cinco contadores
      // e medidas reais; com a lista vazia caía nesta mesma linha.
      return wanted.size === 0
        ? { status: "unavailable", reason: "nenhuma instância de disco pedida" }
        : { status: "unavailable", reason: "nenhum contador LogicalDisk disponível" };
    }
    return { status: "ok", value: { query, bindings } };
  }

  /**
   * Um poll: recolhe e lê. O primeiro poll depois de abrir a query tipicamente
   * ainda não tem intervalo para calcular taxas — as amostras vêm com
   * `measured: false` e o normalizador publica-as como indisponível, nunca zero.
   */
  poll(instances: string[]): PdhReading<PdhVolumeSample[]> {
    const ready = this.ensure(instances);
    if (ready.status === "unavailable") return ready;
    const { query, bindings } = ready.value;
    const code = bindings.collect(query);
    if (code !== 0 && code !== PDH_NO_DATA) {
      return { status: "unavailable", reason: `PdhCollectQueryData 0x${code.toString(16).toUpperCase()}` };
    }
    const samples: PdhVolumeSample[] = [];
    for (const [instance, handles] of this.counters) {
      const read = (key: CounterKey): PdhCounterSample => {
        const counter = `\\LogicalDisk(${instance})\\${COUNTERS[key]}`;
        const handle = handles.get(key);
        if (handle === undefined) return { counter, cStatus: -1, value: null, measured: false };
        const raw = bindings.formattedDouble(handle);
        if (raw === null) {
          return { counter, cStatus: -1, value: null, measured: false };
        }
        const measured = raw.cStatus === CSTATUS_VALID_DATA || raw.cStatus === CSTATUS_NEW_DATA;
        return {
          counter,
          cStatus: raw.cStatus,
          value: measured && Number.isFinite(raw.value) ? raw.value : null,
          measured,
        };
      };
      samples.push({
        instance,
        readBytesPerSec: read("readBytesPerSec"),
        writeBytesPerSec: read("writeBytesPerSec"),
        readsPerSec: read("readsPerSec"),
        writesPerSec: read("writesPerSec"),
        idlePercent: read("idlePercent"),
      });
    }
    return { status: "ok", value: samples };
  }

  close(): void {
    if (this.query !== null && this.bindings.status === "ok") {
      this.bindings.value.closeQuery(this.query);
    }
    this.query = null;
    this.counters.clear();
  }
}
