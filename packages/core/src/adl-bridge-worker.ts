/**
 * ── WORKER ADL (AMD Display Library) —corre SEMPRE em processo próprio ─────────
 *
 * Porque um processo separado e não uma chamada in-process: a ADL desta máquina
 * produz `0xC0000005` em certas entradas (medido a 26/10/2026; ver
 * `evidence/adl-diag/segunda-fonte`). Um segfault no processo do serviço mataria
 * o CyberSafe inteiro; no worker, mata apenas o worker — e o pai converte isso
 * honestamente em `error`.
 *
 * Sequência usada — a DO SAMPLE OFICIAL (GPUOpen display-library, `PMLog.cpp`),
 * verificada nesta máquina com leitura física real (`evidence/adl-diag/
 * pmlog-shmem`):
 *   1. `ADL_Main_Control_Create(callback, 1)`            — ADL **v1**, 2 argumentos
 *   2. `ADL_Adapter_NumberOfAdapters_Get(int*)`          — v1
 *   3. `ADL_Adapter_AdapterInfo_Get(buf, 1572×n)`        — v1 (identidade do chip)
 *   4. `ADL2_Device_PMLog_Device_Create(NULL, idx, &h)`  — ADL2 com contexto NULO
 *   5. `ADL2_Adapter_PMLog_Support_Get(NULL, idx, info)` — sensores suportados
 *   6. `ADL2_Adapter_PMLog_Start(NULL, idx, in, out, h)` — devolve endereço de
 *      memória partilhada onde o driver escreve amostras
 *   7. ler os pares (sensor, valor) nesse endereço, depois `…_PMLog_Stop` e
 *      `…_Device_Destroy`
 *
 * O que ficou FORA desta versão, com prova: `ADL2_New_QueryPMLogData_Get` — a
 * consulta síncrona que a primeira versão usava — rebenta (`0xC0000005`) em
 * TODAS as combinações de argumentos/contexto testadas neste driver, inclusive
 * depois de um `ADL2_Main_Control_Create` correto. Chamar-lhe é o crash, não o
 * contexto errado. Também não se chama `ADL2_Adapter_Active_Get`: a ordem dos
 * argumentos não está no cabeçalho e a variante tentada fez access violation —
 * o campo `active` fica `null` (não tentado) em vez de se pagar um crash.
 *
 * O que este worker NUNCA faz: instala algo, carrega drivers de kernel, acede à
 * rede, ou publica número sem leitura plausível.
 *
 * Protocolo: um único objeto JSON no stdout, sempre. Nunca lança para a stderr
 * como sinal de falha — o `status` no JSON é a fonte de verdade. Se o processo
 * morrer antes de escrever, o pai vê saída vazia/código anómalo e trata como
 * erro do provider.
 */

/** Ordinais PMLog confirmados em `adl_defines.h` (enum ADL_PMLOG_SENSORS).
 *  Errar aqui é trocar temperaturas entre si, por isso ficam centralizados. */
const PMLOG = {
  gfxclk: 1,
  memclk: 2,
  socclk: 3,
  uvdclk1: 4,
  uvdclk2: 5,
  edgeC: 8,
  memC: 9,
  vrvddcC: 10,
  fanRpm: 14,
  fanPercent: 15,
  socVoltage: 16,
  activityGfx: 19,
  activityMem: 20,
  gfxVoltage: 21,
  memVoltage: 22,
  asicPower: 23,
  vrmvdd0C: 25,
  vrmvdd1C: 26,
  hotspotC: 27,
  cpuC: 32,
  pcieSpeed: 40,
  pcieLanes: 41,
} as const;

/** Chave publicada por ordinal. `gpuCoreC` vem de TEMPERATURE_EDGE — é o sensor
 *  que este driver expõe como temperatura do núcleo; o rótulo no provider diz
 *  exatamente isso, em vez de afirmar um "Package" que não foi medido. */
const PMLOG_KEY: Record<number, string> = {
  [PMLOG.gfxclk]: "gpuGfxclkMhz",
  [PMLOG.memclk]: "gpuMemclkMhz",
  [PMLOG.socclk]: "gpuSocclkMhz",
  [PMLOG.uvdclk1]: "gpuUvdclk1Mhz",
  [PMLOG.uvdclk2]: "gpuUvdclk2Mhz",
  [PMLOG.edgeC]: "gpuCoreC",
  [PMLOG.memC]: "gpuMemoryC",
  [PMLOG.vrvddcC]: "gpuVrVddcC",
  [PMLOG.vrmvdd0C]: "gpuVrMvdd0C",
  [PMLOG.vrmvdd1C]: "gpuVrMvdd1C",
  [PMLOG.fanRpm]: "fanRpm",
  [PMLOG.fanPercent]: "fanPercent",
  [PMLOG.socVoltage]: "socVoltageMv",
  [PMLOG.activityGfx]: "gpuUtilPercent",
  [PMLOG.activityMem]: "memUtilPercent",
  [PMLOG.gfxVoltage]: "gpuVoltageMv",
  [PMLOG.memVoltage]: "gpuMemVoltageMv",
  [PMLOG.asicPower]: "gpuAsicPowerW",
  [PMLOG.hotspotC]: "gpuHotspotC",
  [PMLOG.cpuC]: "cpuC",
  [PMLOG.pcieSpeed]: "pcieLinkSpeed",
  [PMLOG.pcieLanes]: "pcieLinkLanes",
};

/** `ADLPMLogSupportInfo`/`ADLPMLogStartInput`: `unsigned short usSensors[256]`
 *  + `int ulReserved[16]` → 576 bytes. `ADLPMLogStartOutput`: ponteiro (8) +
 *  `int ulReserved[14]` → 64 bytes. */
const PMLOG_INFO_BYTES = 256 * 2 + 16 * 4;
const PMLOG_START_IN_BYTES = 256 * 2 + 4 + 15 * 4;
const PMLOG_START_OUT_BYTES = 8 + 14 * 4;
/** `ADLPMLogData` no final da amostragem: pares (sensor, valor) a partir de 16. */
const PMLOG_VALUES_OFFSET = 16;
const PMLOG_MAX_PAIRS = 256;
/** `AdapterInfo` em Windows x64: 4×2 + 256×3 + 4×5 + 256×3 + 4 = 1572 bytes. */
const ADAPTER_INFO_BYTES = 1572;
/** Amostra a 250 ms; espera-se no máximo 1,2 s pela primeira escrita do driver,
 *  dentro de um orçamento GLOBAL de 1,8 s para todo o worker — o timeout do pai
 *  é 2,5 s e um adaptador lento não pode comer o budget dos restantes. */
const SAMPLE_RATE_MS = 250;
const FIRST_SAMPLE_WAIT_MS = 1_200;
const TOTAL_SAMPLE_BUDGET_MS = 1_800;
const SAMPLE_POLL_MS = 60;

interface SensorReading {
  adapterIndex: number;
  udid: string;
  adapterName: string;
  displayName: string;
  busNumber: number;
  deviceNumber: number;
  present: boolean;
  active: number | null;
  pmlog: Record<string, number>;
  od6Celsius: number | null;
  codes: { device?: number; support?: number; start?: number; od6?: number; skip?: string };
  /** Sensores que este adaptador declarou suportados (ordinais PMLog). */
  supportedSensors?: number[];
}

interface WorkerReport {
  status: "ok" | "unsupported" | "error";
  reason: string | null;
  dll: string | null;
  adapterCount: number | null;
  createCode: number | null;
  adapters: SensorReading[];
  /** Ordem efetivamente usada, para o relatório poder ser confrontado. */
  sequence?: string;
}

const report: WorkerReport = {
  status: "error",
  reason: null,
  dll: null,
  adapterCount: null,
  createCode: null,
  adapters: [],
  sequence: "v1-create + adl2-null-context pmlog-shmem",
};

function emit(): void {
  // stdout síncrono: um crash a meio não pode apagar o que já foi escrito.
  try {
    process.stdout.write(JSON.stringify(report), () => undefined);
  } catch {
    /* pipes fechados: o pai interpreta ausência como erro */
  }
}

/** O `import` do koffi é dinâmico e com especificador não literal: koffi é uma
 *  dependência OPCIONAL. Sem ela o worker diz `unsupported` e o CyberSafe
 *  continua a viver — nunca é motivo para falhar o snapshot. */
async function importKoffi(): Promise<any> {
  const specifier = "koffi";
  const mod: any = await import(specifier);
  return mod?.default ?? mod;
}

const readAnsi = (buf: Buffer, offset: number, max = 256): string => {
  const slice = buf.subarray(offset, offset + max);
  const end = slice.indexOf(0);
  return (end >= 0 ? slice.subarray(0, end) : slice)
    .toString("latin1")
    .replace(/[^\x20-\x7e]/g, "")
    .trim();
};

/** Celsius só quando fisicamente plausível: 0, negativos e >150 não são
 *  leituras — são ausência de leitura, e nunca se publicam. */
const plausibleC = (raw: number): number | null =>
  Number.isFinite(raw) && raw > 0 && raw <= 150 ? Math.round(raw) : null;

const sleep = (ms: number): void => {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    /* espera ocupada curta: o worker vive apenas esta aquisição */
  }
};

async function main(): Promise<void> {
  const dllPath =
    process.env.CYBERSAFE_ADL_DLL ||
    (process.env.SystemRoot
      ? `${process.env.SystemRoot}\\System32\\atiadlxx.dll`
      : "C:\\Windows\\System32\\atiadlxx.dll");

  let koffi: any;
  try {
    koffi = await importKoffi();
  } catch {
    report.status = "unsupported";
    report.reason = "ffi-module-absent";
    return;
  }

  let lib: any;
  try {
    lib = koffi.load(dllPath);
  } catch {
    report.status = "unsupported";
    report.reason = "dll-not-found";
    report.dll = dllPath;
    return;
  }
  report.dll = dllPath;

  const fn = (sig: string): any => {
    try {
      return lib.func(sig);
    } catch {
      return null;
    }
  };

  // A ADL aloca os arrays de adaptadores e devolve ponteiros que o chamador
  // liberta: o callback de malloc é obrigatório no Create.
  const mallocProto = koffi.proto("void* __stdcall ADL_MALLOC_CB(int size)");
  const cMalloc: any = koffi.load("msvcrt.dll").func("void *malloc(size_t n)");
  const cb = koffi.register(
    (size: number) => {
      try {
        return cMalloc(size);
      } catch {
        return null;
      }
    },
    koffi.pointer(mallocProto),
  );

  const create = fn("int __stdcall ADL_Main_Control_Create(ADL_MALLOC_CB *callback, int adapterType)");
  const numAdapters = fn("int __stdcall ADL_Adapter_NumberOfAdapters_Get(void *num)");
  const adapterInfo = fn("int __stdcall ADL_Adapter_AdapterInfo_Get(void *info, int inputSize)");
  const destroy = fn("int __stdcall ADL_Main_Control_Destroy()");
  const devCreate = fn("int __stdcall ADL2_Device_PMLog_Device_Create(void *ctx, int iAdapterIndex, void *pDevice)");
  const devDestroy = fn("int __stdcall ADL2_Device_PMLog_Device_Destroy(void *ctx, unsigned int hDevice)");
  const supportGet = fn("int __stdcall ADL2_Adapter_PMLog_Support_Get(void *ctx, int iAdapterIndex, void *pInfo)");
  const pmStart = fn(
    "int __stdcall ADL2_Adapter_PMLog_Start(void *ctx, int iAdapterIndex, void *pInput, void *pOutput, unsigned int hDevice)",
  );
  const pmStop = fn("int __stdcall ADL2_Adapter_PMLog_Stop(void *ctx, int iAdapterIndex, unsigned int hDevice)");
  const od6 = fn("int __stdcall ADL_Overdrive6_Temperature_Get(int iAdapterIndex, void *temp)");

  if (!create || !numAdapters || !adapterInfo) {
    report.status = "unsupported";
    report.reason = "adl-entrypoint-missing";
    return;
  }
  if (!devCreate || !supportGet || !pmStart) {
    // Driver sem PMLog por memória partilhada: não há como ler sensores aqui.
    report.status = "unsupported";
    report.reason = "adl-pmlog-shmem-missing";
    return;
  }

  const createCode = create(cb, 1);
  report.createCode = createCode;
  if (createCode !== 0) {
    report.status = "unsupported";
    report.reason = "adl-create-failed";
    return;
  }

  const countBuf = Buffer.alloc(4);
  if (numAdapters(countBuf) !== 0) {
    report.status = "error";
    report.reason = "number-of-adapters-failed";
    if (destroy) destroy();
    return;
  }
  const count = Math.max(0, Math.min(countBuf.readInt32LE(0), 64));
  report.adapterCount = countBuf.readInt32LE(0);
  if (count === 0) {
    report.status = "unsupported";
    report.reason = "no-adapters";
    if (destroy) destroy();
    return;
  }

  const infoBuf = Buffer.alloc(ADAPTER_INFO_BYTES * count);
  if (adapterInfo(infoBuf, infoBuf.length) !== 0) {
    report.status = "error";
    report.reason = "adapter-info-failed";
    if (destroy) destroy();
    return;
  }

  // Um mesmo chip físico aparece como vários "slots" de ecrã (DISPLAY1..7),
  // cada um com o seu iAdapterIndex. Ler os sete é trabalho redundante e mais
  // superfície de crash: agrupa-se por (nome, bus, device) e lê-se o primeiro.
  const seenPhysical = new Set<string>();
  const targets: { adapterIndex: number; udid: string; adapterName: string; displayName: string; busNumber: number; deviceNumber: number; present: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const b = i * ADAPTER_INFO_BYTES;
    const adapterIndex = infoBuf.readInt32LE(b + 4);
    if (!Number.isInteger(adapterIndex) || adapterIndex < 0) continue;
    const adapterName = readAnsi(infoBuf, b + 280);
    const reading = {
      adapterIndex,
      udid: readAnsi(infoBuf, b + 8),
      adapterName,
      displayName: readAnsi(infoBuf, b + 536),
      busNumber: infoBuf.readInt32LE(b + 264),
      deviceNumber: infoBuf.readInt32LE(b + 268),
      present: infoBuf.readInt32LE(b + 792) === 1,
    };
    const physical = `${adapterName}|${reading.busNumber}|${reading.deviceNumber}`;
    if (reading.present && seenPhysical.has(physical)) continue;
    seenPhysical.add(physical);
    targets.push(reading);
  }

  const sampleDeadline = Date.now() + TOTAL_SAMPLE_BUDGET_MS;
  for (const target of targets) {
    const reading: SensorReading = {
      ...target,
      active: null,
      pmlog: {},
      od6Celsius: null,
      codes: {},
    };
    if (!target.present) {
      // Adaptador desligado (ex.: iGPU com código 43): chamar o PMLog aqui deu
      // `-5`/sem sensores; não se gasta um handle em algo sem sensor.
      reading.codes.skip = "present=0";
      report.adapters.push(reading);
      continue;
    }

    const deviceBuf = Buffer.alloc(4);
    const rcDevice = devCreate(null, target.adapterIndex, deviceBuf);
    reading.codes.device = rcDevice;
    const hDevice = deviceBuf.readUInt32LE(0);
    if (rcDevice !== 0 || hDevice === 0) {
      report.adapters.push(reading);
      continue;
    }

    const info = Buffer.alloc(PMLOG_INFO_BYTES);
    const rcSupport = supportGet(null, target.adapterIndex, info);
    reading.codes.support = rcSupport;
    const sensors: number[] = [];
    if (rcSupport === 0) {
      for (let i = 0; i < PMLOG_MAX_PAIRS; i++) {
        const value = info.readUInt16LE(i * 2);
        if (value === 0) break; // ADL_SENSOR_MAXTYPES termina a lista
        sensors.push(value);
      }
    }
    reading.supportedSensors = sensors;
    if (!sensors.length) {
      if (devDestroy) devDestroy(null, hDevice);
      report.adapters.push(reading);
      continue;
    }

    const startIn = Buffer.alloc(PMLOG_START_IN_BYTES);
    sensors.forEach((s, i) => startIn.writeUInt16LE(s, i * 2));
    startIn.writeUInt32LE(SAMPLE_RATE_MS, sensors.length * 2);
    const startOut = Buffer.alloc(PMLOG_START_OUT_BYTES);
    const rcStart = pmStart(null, target.adapterIndex, startIn, startOut, hDevice);
    reading.codes.start = rcStart;
    if (rcStart !== 0) {
      if (devDestroy) devDestroy(null, hDevice);
      report.adapters.push(reading);
      continue;
    }

    const address = Number(startOut.readBigUInt64LE(0));
    if (Number.isInteger(address) && address > 0) {
      // O driver escreve aqui de forma assíncrona: espera-se a primeira
      // amostra dentro de um orçamento fixo, nunca indefinidamente.
      const stopAt = Math.min(Date.now() + FIRST_SAMPLE_WAIT_MS, sampleDeadline);
      for (;;) {
        const pairs: [number, number][] = [];
        for (let i = 0; i < PMLOG_MAX_PAIRS; i++) {
          const sensor = koffi.decode(address + PMLOG_VALUES_OFFSET + i * 8, "uint32");
          if (sensor === 0) break;
          pairs.push([sensor, koffi.decode(address + PMLOG_VALUES_OFFSET + i * 8 + 4, "uint32")]);
        }
        if (pairs.length) {
          for (const [sensor, value] of pairs) {
            const key = PMLOG_KEY[sensor];
            if (key) reading.pmlog[key] = value;
            else reading.pmlog[`sensor${sensor}`] = value;
          }
          break;
        }
        if (Date.now() >= stopAt) break;
        sleep(SAMPLE_POLL_MS);
      }
    }

    if (pmStop) pmStop(null, target.adapterIndex, hDevice);
    if (devDestroy) devDestroy(null, hDevice);

    // Fallback para drivers antigos sem PMLog: Overdrive6 devolve centésimos.
    // Nesta máquina (RDNA) responde `-8` NOT_SUPPORTED; continua sendo um
    // caminho legítimo noutros chips, sem custo de crash.
    if (od6) {
      const t = Buffer.alloc(8);
      t.writeInt32LE(8, 0);
      const rcOd6 = od6(target.adapterIndex, t);
      if (rcOd6 === 0) reading.od6Celsius = plausibleC(t.readInt32LE(4) / 100);
    }

    report.adapters.push(reading);
  }

  if (destroy) {
    try {
      destroy();
    } catch {
      /* o destroy pode falhar depois de um estado parcial; não apaga leituras */
    }
  }

  const comSensor = report.adapters.some(
    (a) => Object.keys(a.pmlog).length > 0 || a.od6Celsius !== null,
  );
  report.status = comSensor ? "ok" : "unsupported";
  report.reason = comSensor ? null : "no-sensor-data";
}

main()
  .catch((err: unknown) => {
    report.status = "error";
    report.reason = String((err as Error)?.message ?? err).slice(0, 200);
  })
  .finally(() => {
    emit();
    // Exit limpo: sem isto o evento loop do koffi pode manter o processo vivo.
    process.exit(0);
  });
