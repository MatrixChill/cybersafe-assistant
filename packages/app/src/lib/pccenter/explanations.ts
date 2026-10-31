/**
 * TP-RETOMA-04-EXPLICACOES-V2 · modelo PURO das explicações locais do PC Center.
 *
 * As leituras chegam JÁ RESOLVIDAS pelos helpers reais do produto; o adaptador
 * `leiturasDe` recebe esses helpers injectados (para poder ser testado com os
 * reais, sem alias de build) e honra o `temperatureStatus` EXPLÍCITO:
 *  - status available -> medido (só com timestamp publicado);
 *  - status stale     -> cache (última leitura, nunca "agora");
 *  - unavailable/waiting/pending/unconfirmed -> desconhecido com motivo.
 * GPU `absent` NÃO publica VRAM de extras residuais.
 * NUNCA se associa consumo a malware. Sem imports: testável com `tsx --test`.
 */

export type Certeza = "medido" | "cache" | "desconhecido";

export interface Facto {
  id: string;
  rotulo: string;
  valor: string | number | null;
  unidade: string | null;
  fonte: string;
  sensor: string | null;
  medidoEm: string | null;
  certeza: Certeza;
  motivo?: string;
}

export interface Hipotese {
  id: string;
  descricao: string;
  certeza: "inferido" | "hipotese";
  base: string[];
  contra: string[];
}

export interface Recomendacao {
  id: string;
  descricao: string;
  risco: "baixo" | "medio" | "alto";
  reversivel: boolean;
}

export interface Risco {
  id: string;
  descricao: string;
  reversibilidade: string;
}

export interface Matriz {
  disponivel: false;
  requerConsentimento: true;
  estado: "NAO_ATIVADA";
  nota: string;
}

export interface Assistente {
  estado: "NAO_INTEGRADO_NESTA_SECCAO";
  motivo: string;
}

/** `leituras-disponiveis` = as regras desta secção não geraram hipótese; NÃO é normalidade do PC. */
export type Resumo = "hipoteses" | "leituras-disponiveis" | "faltam-leituras";

export interface Explicacoes {
  fatos: Facto[];
  hipoteses: Hipotese[];
  recomendacoes: Recomendacao[];
  riscos: Risco[];
  matriz: Matriz;
  assistente: Assistente;
  resumo: Resumo;
  avisos: string[];
}

export type EstadoTemperatura = "waiting" | "available" | "stale" | "unavailable";
export interface LeituraTemperatura { state: EstadoTemperatura; value: number | null }

export type Presence = "pending" | "present" | "absent";

export interface LeiturasResolvidas {
  cpu: { state: "available" | "stale" | "unavailable"; value: number | null; updatedAt: string | null };
  ram: { state: "available" | "stale" | "unavailable" | "unconfirmed"; value: number | null; cachedValue: number | null; updatedAt: string | null };
  rede: { state: "pending" | "available" | "stale" | "unavailable"; rxSec: number | null; txSec: number | null; interfaceName: string | null; updatedAt: string | null };
  cpuTemp: LeituraTemperatura;
  gpu: null | {
    presence: Presence;
    core: LeituraTemperatura;
    hotspot: LeituraTemperatura;
    memoryJunction: LeituraTemperatura;
    /** Fonte/sensor do sensor PRINCIPAL — não se aplicam a hotspot/junction. */
    source: string | null;
    sensor: string | null;
    updatedAt: string | null;
  };
  disco: { usagePercent: number | null; physicalCount: number | null };
  bateria: { temBateria: boolean; percent: number | null };
}

/* ---------- adaptador puro: snapshot -> LeiturasResolvidas ---------- */

export interface HardwareLike {
  cpu?: { usage?: number | null; usageStatus?: string | null; usageUpdatedAt?: string | null; temperature?: number | null; temperatureStatus?: string | null } | null;
  ram?: { usagePercent?: number | null; usageStatus?: string | null; usageUpdatedAt?: string | null } | null;
  network?: { rxSec?: number | null; txSec?: number | null; interfaceName?: string | null; readStatus?: string | null; updatedAt?: string | null } | null;
  disk?: { usagePercent?: number | null; physical?: unknown[] | null } | null;
  battery?: { hasBattery?: boolean | null; percent?: number | null } | null;
  gpu?: {
    available?: boolean | null;
    model?: string | null;
    temperature?: number | null;
    coreTemperature?: number | null;
    hotspotTemperature?: number | null;
    memoryJunctionTemperature?: number | null;
    temperatureSource?: string | null;
    temperatureSensor?: string | null;
    temperatureStatus?: string | null;
    temperatureUpdatedAt?: string | null;
    vramUsedMb?: number | null;
    vramTotalMb?: number | null;
  } | null;
}

export interface HelpersLeitura {
  cpuUsage: (cpu: HardwareLike["cpu"]) => { state: "available" | "stale" | "unavailable"; value: number | null; updatedAt?: string | null };
  ramUsage: (ram: HardwareLike["ram"]) => { state: "available" | "stale" | "unavailable" | "unconfirmed"; value: number | null; cachedValue?: number | null; updatedAt?: string | null };
  rede: (rede: HardwareLike["network"]) => { state: "pending" | "available" | "stale" | "unavailable"; rxSec: number | null; txSec: number | null; interfaceName: string | null; updatedAt?: string | null };
  temperatura: (valor: number | null | undefined) => { state: "waiting" | "available" | "unavailable"; value: number | null };
  presencia: (gpu: HardwareLike["gpu"]) => Presence;
}

const ESTADOS_TEMP = new Set(["available", "stale", "unavailable", "waiting"]);

/** Honra o status térmico explícito; o helper só valida o número.
 *  `error` e `waiting` também vencem o valor: um resíduo finito não é medição. */
function temperaturaComStatus(
  valor: number | null | undefined,
  status: string | null | undefined,
  helper: HelpersLeitura["temperatura"],
): LeituraTemperatura {
  const base = helper(valor);
  const s = typeof status === "string" ? status : null;
  if (s === "unavailable" || s === "error") return { state: "unavailable", value: null };
  if (s === "waiting") return { state: "waiting", value: null };
  if (s === "stale") {
    // Cache só se houver valor válido; sem valor, é desconhecido.
    return base.state === "available" && typeof base.value === "number"
      ? { state: "stale", value: base.value }
      : { state: "unavailable", value: null };
  }
  if (s === "available" || s === null || !ESTADOS_TEMP.has(s)) return base;
  return base;
}

export function leiturasDe(hardware: HardwareLike | null, helpers: HelpersLeitura): LeiturasResolvidas {
  const h = hardware ?? {};
  const gpu = h.gpu ?? null;
  const cpuT = temperaturaComStatus(h.cpu?.temperature, h.cpu?.temperatureStatus, helpers.temperatura);
  const cpuUso = helpers.cpuUsage(h.cpu ?? null);
  const ram = helpers.ramUsage(h.ram ?? null);
  const rede = helpers.rede(h.network ?? null);

  return {
    cpu: { state: cpuUso.state, value: cpuUso.value, updatedAt: cpuUso.updatedAt ?? null },
    ram: { state: ram.state, value: ram.value, cachedValue: ram.cachedValue ?? null, updatedAt: ram.updatedAt ?? null },
    rede: { state: rede.state, rxSec: rede.rxSec, txSec: rede.txSec, interfaceName: rede.interfaceName, updatedAt: rede.updatedAt ?? null },
    cpuTemp: cpuT,
    gpu: gpu
      ? {
          presence: helpers.presencia(gpu),
          core: temperaturaComStatus(gpu.coreTemperature ?? gpu.temperature, gpu.temperatureStatus, helpers.temperatura),
          hotspot: temperaturaComStatus(gpu.hotspotTemperature, gpu.temperatureStatus, helpers.temperatura),
          memoryJunction: temperaturaComStatus(gpu.memoryJunctionTemperature, gpu.temperatureStatus, helpers.temperatura),
          source: gpu.temperatureSource ?? null,
          sensor: gpu.temperatureSensor ?? null,
          updatedAt: gpu.temperatureUpdatedAt ?? null,
        }
      : null,
    disco: { usagePercent: typeof h.disk?.usagePercent === "number" ? h.disk.usagePercent : null, physicalCount: h.disk?.physical?.length ?? null },
    bateria: { temBateria: h.battery?.hasBattery === true, percent: typeof h.battery?.percent === "number" ? h.battery.percent : null },
  };
}

/* ---------- modelo ---------- */

export interface Extras {
  gpuModel?: string | null;
  vramUsedMb?: number | null;
  vramTotalMb?: number | null;
}

const ASSOCIACAO_MALWARE = /\bmalware\b|\bv[ií]rus\b|infetad|infe[cç][aã]o|ransomware|trojan|cavalo de tr[oó]ia/i;

/** Guard do contrato: consumo elevado NÃO é diagnóstico de infeção. */
export function textoAtribuiMalware(texto: string): boolean {
  return ASSOCIACAO_MALWARE.test(String(texto ?? ""));
}

const num = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

const FONTE_SNAPSHOT = "snapshot de hardware do serviço";

function facto(args: {
  id: string;
  rotulo: string;
  valor: number | null;
  unidade: string | null;
  fonte: string;
  sensor?: string | null;
  medidoEm?: string | null;
  certeza: Certeza;
  motivo?: string;
}): Facto {
  return {
    id: args.id,
    rotulo: args.rotulo,
    valor: num(args.valor) ? Math.round(args.valor! * 10) / 10 : null,
    unidade: args.unidade,
    fonte: args.fonte,
    sensor: args.sensor ?? null,
    medidoEm: args.medidoEm ?? null,
    certeza: args.certeza,
    ...(args.motivo ? { motivo: args.motivo } : {}),
  };
}

function factoTemperatura(args: {
  id: string;
  rotulo: string;
  leitura: LeituraTemperatura;
  fonte: string;
  sensor: string | null;
  medidoEm: string | null;
  motivoAusente: string;
}): Facto {
  const { leitura } = args;
  if (leitura.state === "available" && num(leitura.value)) {
    return facto({
      id: args.id, rotulo: args.rotulo, valor: leitura.value, unidade: "°C",
      fonte: args.fonte, sensor: args.sensor, medidoEm: args.medidoEm,
      certeza: "medido",
      motivo: args.medidoEm ? undefined : "sem timestamp no snapshot",
    });
  }
  if (leitura.state === "stale" && num(leitura.value)) {
    return facto({
      id: args.id, rotulo: args.rotulo, valor: leitura.value, unidade: "°C",
      fonte: args.fonte, sensor: args.sensor, medidoEm: args.medidoEm,
      certeza: "cache",
      motivo: "última leitura guardada; não é medição atual",
    });
  }
  return facto({
    id: args.id, rotulo: args.rotulo, valor: null, unidade: "°C",
    fonte: args.fonte, sensor: args.sensor, medidoEm: args.medidoEm,
    certeza: "desconhecido",
    motivo: leitura.state === "waiting" ? "leitura ainda a ser recolhida" : args.motivoAusente,
  });
}

export function buildExplicacoes({ leituras, extras = {} }: { leituras: LeiturasResolvidas; extras?: Extras }): Explicacoes {
  const l = leituras;
  const gpu = l.gpu;

  const fatos: Facto[] = [];

  fatos.push(
    l.cpu.state === "available"
      ? facto({ id: "cpu.uso", rotulo: "Uso de CPU", valor: l.cpu.value, unidade: "%", fonte: FONTE_SNAPSHOT, medidoEm: l.cpu.updatedAt, certeza: "medido", motivo: l.cpu.updatedAt ? undefined : "sem timestamp no snapshot" })
      : l.cpu.state === "stale"
        ? facto({ id: "cpu.uso", rotulo: "Uso de CPU", valor: l.cpu.value, unidade: "%", fonte: FONTE_SNAPSHOT, medidoEm: l.cpu.updatedAt, certeza: "cache", motivo: "última leitura guardada; não é medição atual" })
        : facto({ id: "cpu.uso", rotulo: "Uso de CPU", valor: null, unidade: "%", fonte: FONTE_SNAPSHOT, certeza: "desconhecido", motivo: "sem leitura atual nem recente" }),
  );

  fatos.push(factoTemperatura({ id: "cpu.temperatura", rotulo: "Temperatura da CPU", leitura: l.cpuTemp, fonte: FONTE_SNAPSHOT, sensor: null, medidoEm: null, motivoAusente: "sensor da CPU não reportou temperatura" }));

  if (!gpu) {
    for (const [id, rotulo] of [["gpu.temperatura.core", "GPU · núcleo"], ["gpu.temperatura.hotspot", "GPU · hotspot"], ["gpu.temperatura.memoryJunction", "GPU · memory junction"]] as const) {
      fatos.push(facto({ id, rotulo, valor: null, unidade: "°C", fonte: FONTE_SNAPSHOT, certeza: "desconhecido", motivo: "sem leitura da GPU nesta captura — a placa pode existir; a leitura ainda não chegou" }));
    }
    fatos.push(facto({ id: "gpu.vram", rotulo: "GPU · VRAM usada", valor: null, unidade: "MB", fonte: FONTE_SNAPSHOT, certeza: "desconhecido", motivo: "sem leitura da GPU nesta captura" }));
  } else {
    const fonteGpu = gpu.source ?? "fonte não declarada no snapshot";
    const presencia = gpu.presence === "absent"
      ? "o sistema não reportou nenhum controlador gráfico"
      : gpu.presence === "pending"
        ? "leitura da GPU ainda não chegou"
        : null;

    for (const [id, rotulo, leitura, sensor, motivo] of [
      ["gpu.temperatura.core", "GPU · núcleo", gpu.core, gpu.sensor, "sensor da GPU não reportou temperatura"],
      ["gpu.temperatura.hotspot", "GPU · hotspot", gpu.hotspot, null, "este driver/GPU não expõe hotspot"],
      ["gpu.temperatura.memoryJunction", "GPU · memory junction", gpu.memoryJunction, null, "este driver/GPU não expõe memory junction"],
    ] as const) {
      if (presencia) {
        fatos.push(facto({ id, rotulo, valor: null, unidade: "°C", fonte: fonteGpu, sensor, medidoEm: gpu.updatedAt, certeza: "desconhecido", motivo: presencia }));
      } else {
        fatos.push(factoTemperatura({ id, rotulo, leitura, fonte: fonteGpu, sensor, medidoEm: gpu.updatedAt, motivoAusente: motivo }));
      }
    }

    // GPU ausente não publica VRAM de extras residuais.
    if (gpu.presence === "absent") {
      fatos.push(facto({ id: "gpu.vram", rotulo: "GPU · VRAM usada", valor: null, unidade: "MB", fonte: FONTE_SNAPSHOT, certeza: "desconhecido", motivo: "o sistema não reportou nenhum controlador gráfico" }));
    } else {
      fatos.push(
        num(extras.vramUsedMb)
          ? facto({ id: "gpu.vram", rotulo: "GPU · VRAM usada", valor: extras.vramUsedMb, unidade: "MB", fonte: FONTE_SNAPSHOT, medidoEm: null, certeza: "medido", motivo: "sem timestamp no snapshot" })
          : facto({ id: "gpu.vram", rotulo: "GPU · VRAM usada", valor: null, unidade: "MB", fonte: FONTE_SNAPSHOT, certeza: "desconhecido", motivo: "VRAM não lida" }),
      );
    }
  }

  fatos.push(
    l.ram.state === "available"
      ? facto({ id: "ram.uso", rotulo: "Uso de RAM", valor: l.ram.value, unidade: "%", fonte: FONTE_SNAPSHOT, medidoEm: l.ram.updatedAt, certeza: "medido", motivo: l.ram.updatedAt ? undefined : "sem timestamp no snapshot" })
      : l.ram.state === "stale"
        ? facto({ id: "ram.uso", rotulo: "Uso de RAM", valor: l.ram.cachedValue, unidade: "%", fonte: FONTE_SNAPSHOT, medidoEm: l.ram.updatedAt, certeza: "cache", motivo: "última leitura guardada; não é medição atual" })
        : facto({ id: "ram.uso", rotulo: "Uso de RAM", valor: null, unidade: "%", fonte: FONTE_SNAPSHOT, certeza: "desconhecido", motivo: l.ram.state === "unconfirmed" ? "estado não confirmado (snapshot legado)" : "sem leitura atual nem recente" }),
  );

  fatos.push(
    l.rede.state === "available"
      ? facto({ id: "rede.trafego", rotulo: "Rede · receção/envio", valor: l.rede.rxSec, unidade: "B/s (rx)", fonte: FONTE_SNAPSHOT, sensor: l.rede.interfaceName, medidoEm: l.rede.updatedAt, certeza: "medido", motivo: l.rede.updatedAt ? undefined : "sem timestamp no snapshot" })
      : l.rede.state === "stale"
        ? facto({ id: "rede.trafego", rotulo: "Rede · receção/envio", valor: l.rede.rxSec, unidade: "B/s (rx)", fonte: FONTE_SNAPSHOT, sensor: l.rede.interfaceName, medidoEm: l.rede.updatedAt, certeza: "cache", motivo: "última leitura guardada; não é medição atual" })
        : facto({ id: "rede.trafego", rotulo: "Rede · receção/envio", valor: null, unidade: "B/s", fonte: FONTE_SNAPSHOT, certeza: "desconhecido", motivo: l.rede.state === "pending" ? "primeira leitura ainda a decorrer" : "sem leitura" }),
  );

  fatos.push(facto({ id: "disco.uso", rotulo: "Uso do disco principal", valor: l.disco.usagePercent, unidade: "%", fonte: FONTE_SNAPSHOT, medidoEm: null, certeza: l.disco.usagePercent == null ? "desconhecido" : "medido", motivo: l.disco.usagePercent == null ? "sem leitura de capacidade" : "sem timestamp no snapshot" }));
  fatos.push(facto({ id: "bateria.percent", rotulo: "Bateria", valor: l.bateria.temBateria ? l.bateria.percent : null, unidade: "%", fonte: FONTE_SNAPSHOT, medidoEm: null, certeza: l.bateria.temBateria && l.bateria.percent != null ? "medido" : "desconhecido", motivo: l.bateria.temBateria ? "sem timestamp no snapshot" : "sem bateria" }));

  const porId = new Map(fatos.map((f) => [f.id, f]));
  const medido = (id: string): number | null => {
    const f = porId.get(id);
    return f && f.certeza === "medido" && typeof f.valor === "number" ? f.valor : null;
  };

  const hipoteses: Hipotese[] = [];
  const recomendacoes: Recomendacao[] = [];
  const avisos: string[] = [
    "Consumo elevado não é, por si, sinal de infeção; é uma medição, não um diagnóstico.",
    "Nenhum conteúdo desta vista é enviado para fora do computador.",
  ];

  const cpuUso = medido("cpu.uso");
  if (cpuUso != null && cpuUso >= 85) {
    hipoteses.push({
      id: "cpu.carga.elevada",
      descricao: "A CPU está com carga elevada nesta captura; a vista não identifica a causa.",
      certeza: "inferido",
      base: ["cpu.uso"],
      contra: ["pode ser trabalho intencional (compilação, jogos, atualizações)", "uma captura isolada não mostra duração nem tendência"],
    });
    recomendacoes.push({ id: "cpu.processos", descricao: "Abrir a vista Processos para ver o que consome; esta vista não termina nada.", risco: "baixo", reversivel: true });
  }

  // Diferença hotspot−core é ARITMÉTICA sobre duas medições; não é diagnóstico
  // de ventilação. Sem carga/duração não se infere causa.
  const core = medido("gpu.temperatura.core");
  const hotspot = medido("gpu.temperatura.hotspot");
  if (core != null && hotspot != null) {
    const delta = Math.round((hotspot - core) * 10) / 10;
    fatos.push(facto({ id: "gpu.diferenca.hotspotCore", rotulo: "GPU · diferença hotspot − núcleo", valor: delta, unidade: "°C", fonte: "aritmética sobre duas leituras medidas", medidoEm: null, certeza: "medido", motivo: "derivado; sem timestamp próprio" }));
    if (delta >= 15) {
      avisos.push("Diferença hotspot−núcleo elevada nesta captura. Sem carga, duração e tendência não se conclui causa; não é diagnóstico de ventilação.");
    }
  }

  // Sem hipótese NÃO significa PC normal: só que as regras desta secção nada geraram.
  const resumo: Resumo = hipoteses.length > 0
    ? "hipoteses"
    : cpuUso != null && core != null
      ? "leituras-disponiveis"
      : "faltam-leituras";

  const riscos: Risco[] = [
    { id: "leitura.cache", descricao: "Uma leitura em cache descreve um instante anterior ao atual.", reversibilidade: "Recolher nova leitura; nada no sistema é alterado." },
    { id: "sem.alteracao", descricao: "Esta vista explica e recomenda; não altera definições, serviços ou ficheiros.", reversibilidade: "Nenhuma ação de sistema é tomada por esta vista." },
    { id: "fechar.processos", descricao: "Fechar aplicações pode perder trabalho não guardado e nunca deve incluir processos do sistema.", reversibilidade: "Não garantida: guardar trabalho antes e fechar pela própria UI da aplicação." },
    { id: "perfil.ventoinhas", descricao: "Alterar o perfil de ventoinhas não é observação: muda configuração, ruído e comportamento térmico.", reversibilidade: "Repor o perfil anterior no utilitário do fabricante." },
  ];

  const textoLivre = [...hipoteses.map((x) => x.descricao), ...recomendacoes.map((x) => x.descricao)].join(" ");
  if (textoAtribuiMalware(textoLivre)) {
    throw new Error("TEXTO_ASSOCIA_MALWARE: o gerador produziu uma associação proibida pelo contrato");
  }

  const semLeituras = fatos.filter((f) => f.certeza === "medido").length === 0;
  if (semLeituras) avisos.push("Sem leituras medidas nesta captura: as explicações ficam vazias em vez de inventar.");

  return {
    fatos,
    hipoteses,
    recomendacoes,
    riscos,
    matriz: {
      disponivel: false,
      requerConsentimento: true,
      estado: "NAO_ATIVADA",
      nota: "MATRIX é uma opção consentida e não está ativa; nada é enviado sem consentimento explícito.",
    },
    assistente: {
      estado: "NAO_INTEGRADO_NESTA_SECCAO",
      motivo: "Esta secção não integra o assistente; não afirma o estado do provider no produto e não envia contexto.",
    },
    resumo,
    avisos,
  };
}

export const VERSAO_MODELO = "pccenter-explicacoes-v3";
