import type {
  ScanState,
  UsbDeviceState,
  UsbDeviceStatus,
  UsbMonitorStatus,
  UsbProtectionSnapshot,
} from "@cybersafe/shared-types";
import {
  isTerminalScanStatus,
  scanProgressPercent,
  scanResultBreakdown,
  scanResultBreakdownNote,
  shouldAcceptScanState,
} from "./scanSession";

/**
 * R8-USB — a decisão pura do painel de unidades USB. Nenhum React, nenhum IPC,
 * nenhum temporizador aqui: é o sítio onde o que o serviço devolve se transforma
 * em apresentações verificáveis sem DOM (o package não tem jsdom).
 *
 * O que este ficheiro recusa fazer, e porquê:
 *  · não inventa estado: `normalizarSnapshot` rejeita o envelope que não reconhece
 *    em vez de o completar com `operational`/`false` por omissão;
 *  · não pinta proteção: o observador USB deteta e analisa a pedido. Não bloqueia,
 *    não ejeta, não impede nada, e nada neste ficheiro diz «protegido» ou «seguro»;
 *  · não empresta progresso: o `ScanState` ao vivo só pinta numa linha cujo
 *    `scanId` bata certo com o do dispositivo (regra da bridge: `scan.progress` é
 *    progresso, nunca um snapshot global);
 *  · não reinventa contadores: a linha de resultado usa o MESMO
 *    `scanResultBreakdown` do cartão de resultado do scanner, com HUMAN PASS R7.
 *    Dois cartões a ler o mesmo `ScanState` de formas diferentes é exatamente o
 *    tipo de contradição que a lane existe para evitar.
 */

export type FaseLeitura = "a_consultar" | "sem_ligacao" | "erro" | "snapshot";
export type Tom = "ok" | "warn" | "crit" | "proc" | "na";
export type MotivoRefresh = "montagem" | "config" | "terminal" | "manual" | "pendente" | "tick" | "retry";
export type DecisaoRefresh = "pedir" | "marcar_pendente" | "ignorar";

/**
 * De quanto em quanto o painel, COM MONTAGEM, volta a perguntar o estado ao
 * serviço. Não é um palpite: sem qualquer consulta periódica, uma pen ligada
 * depois de o painel estar aberto nunca aparece — `scan.progress` só fala de
 * sessões de análise, e sem snapshot não há `device.scanId` para correlacionar.
 * O valor é 5 s porque a deteção USB é um facto que muda em minutos, não em
 * milissegundos, e cada consulta é um pedido ao serviço.
 *
 * O mesmo valor serve de **limiar de espera prolongada** (DECISÃO do Maestro,
 * 12/10): aos 5 s sem resposta, o painel passa a dizer que o serviço ainda não
 * respondeu e que o estado não está confirmado. Desde o pacote A (14/10) o
 * prazo REAL do IPC é `PRAZO_CONSULTA_MS` (15 s): ao expirar, a consulta é
 * declarada não confirmada, a resposta antiga é deitada fora e o retry fica
 * funcional — a espera aos 5 s continua sendo mitigação de apresentação.
 */
export const INTERVALO_CONSULTA_MS = 5000;

/** A frase da espera prolongada. Vive no lib para ser pinada por teste sem DOM. */
export const TEXTO_ESPERA_PROLONGADA =
  "O serviço ainda não respondeu ao estado USB: o estado das unidades não está confirmado. " +
  "A app continua à espera desta resposta e não repete o pedido.";

/**
 * Prazo REAL da consulta (decisão do Maestro, 14/10 — pacote A): o ciclo do
 * serviço é bounded mas um pedido IPC pode juntar-se a um ciclo CIM de 8–12 s;
 * 15 s é o teto do lado da UI. Ao expirar, a UI declara tempo-limite, liberta
 * a guarda e a resposta antiga deixa de ser aplicada — nunca se infere sucesso
 * nem falha do serviço, só que ESTA leitura não foi confirmada. Alinhado com o
 * timeout CIM de 15 s por lote do serviço.
 */
export const PRAZO_CONSULTA_MS = 15000;

export const TEXTO_PRAZO_CONSULTA =
  "A consulta do estado USB excedeu o tempo limite: esta leitura não foi confirmada e a resposta " +
  "antiga deixa de ser aplicada. Use «Recarregar» para nova tentativa, sem sair desta página.";

const MONITOR: UsbMonitorStatus[] = ["starting", "operational", "unavailable"];
const ESTADOS: UsbDeviceStatus[] = [
  "detected",
  "queued",
  "scanning",
  "completed",
  "cancelled",
  "failed",
  "removed",
  "incomplete",
];

const ROTULO: Record<UsbDeviceStatus, string> = {
  detected: "Deteção confirmada",
  queued: "Em fila para análise",
  scanning: "A analisar",
  completed: "Análise concluída",
  cancelled: "Análise cancelada",
  failed: "Análise falhou",
  removed: "Unidade removida",
  incomplete: "Análise incompleta",
};

const TOM: Record<UsbDeviceStatus, Tom> = {
  detected: "na",
  queued: "proc",
  scanning: "proc",
  completed: "ok",
  cancelled: "na",
  failed: "crit",
  removed: "na",
  incomplete: "warn",
};

/** Par chip/mosaico por tom — só primitivas que já existem na folha. */
export function chipsDoTom(tom: Tom): { chip: string; tile: string } {
  if (tom === "na") return { chip: "state-chip state-chip--na", tile: "icon-tile" };
  return {
    chip: `state-chip state-chip--${tom}`,
    tile: `icon-tile icon-tile--${tom}`,
  };
}

/**
 * Identidade estável é obrigatória: `id` é o que atravessa o tempo entre
 * eventos, e `rootPath` sem `id` não chega para associar uma inserção. Uma
 * linha sem `id` ou com `status` desconhecido é CONTADA como ignorada, não
 * silently descartada — o painel diz quantas não soube ler.
 */
export function normalizarDispositivo(bruto: unknown): UsbDeviceState | null {
  if (!bruto || typeof bruto !== "object") return null;
  const d = bruto as Record<string, unknown>;
  if (typeof d.id !== "string" || d.id.trim() === "") return null;
  if (typeof d.rootPath !== "string") return null;
  if (typeof d.present !== "boolean") return null;
  if (typeof d.status !== "string" || !ESTADOS.includes(d.status as UsbDeviceStatus)) return null;

  const limpo: UsbDeviceState = {
    id: d.id,
    rootPath: d.rootPath,
    present: d.present,
    status: d.status as UsbDeviceStatus,
  };
  if (typeof d.label === "string" && d.label.trim() !== "") limpo.label = d.label;
  if (typeof d.scanId === "string" && d.scanId.trim() !== "") limpo.scanId = d.scanId;
  if (typeof d.limitation === "string" && d.limitation !== "") limpo.limitation = d.limitation;
  // Estado de espera por volume (serviço, 14/10): transporta o flag EXATO
  // `true`; tudo o resto é ausência, não `false` inventado.
  if (d.awaitingVolume === true) limpo.awaitingVolume = true;
  if (d.result && typeof d.result === "object" && typeof (d.result as Record<string, unknown>).id === "string") {
    limpo.result = d.result as ScanState;
  }
  return limpo;
}

/**
 * Envelope estrito: um `monitorStatus` que não está nos três do contrato faz o
 * snapshot inteiro ser recusado (`null`), porque adivinhar «operational» seria
 * a UI afirmar que o observador funciona. `enabled` e `updatedAt` são likewise
 * obrigatórios — `enabled` por omissão a `false` pareceria opt-in desligado
 * quando na verdade não houve leitura.
 */
export function normalizarSnapshot(bruto: unknown): { snapshot: UsbProtectionSnapshot; ignorados: number } | null {
  if (!bruto || typeof bruto !== "object") return null;
  const s = bruto as Record<string, unknown>;
  if (typeof s.enabled !== "boolean") return null;
  if (typeof s.monitorStatus !== "string" || !MONITOR.includes(s.monitorStatus as UsbMonitorStatus)) return null;
  if (typeof s.updatedAt !== "string") return null;
  if (!Array.isArray(s.devices)) return null;

  const devices: UsbDeviceState[] = [];
  let ignorados = 0;
  for (const brutoDispositivo of s.devices) {
    const limpo = normalizarDispositivo(brutoDispositivo);
    if (limpo) devices.push(limpo);
    else ignorados += 1;
  }
  const snapshot: UsbProtectionSnapshot = {
    enabled: s.enabled,
    monitorStatus: s.monitorStatus as UsbMonitorStatus,
    updatedAt: s.updatedAt,
    devices,
  };
  if (typeof s.error === "string" && s.error !== "") snapshot.error = s.error;
  return { snapshot, ignorados };
}

export function rotuloDoEstado(status: UsbDeviceStatus): string {
  return ROTULO[status];
}

export function tomDoEstado(status: UsbDeviceStatus): Tom {
  return TOM[status];
}

/**
 * Contagens de PRESENÇA para apresentar. A presença lê-se SÓ do campo
 * `present` (shared-types: "Presença confirmada na última enumeração") —
 * nunca se infere presença de `completed`/`failed`: uma análise terminada
 * não diz que a unidade está lá, e uma unidade ligada sem análise também
 * está. O histórico não se apaga: os removidos continuam contados e listados.
 *
 * `naoConfirmados` é o ramo honesto da enumeração partida: um snapshot
 * `starting`/`unavailable`, ou com `error`, significa que a última
 * enumeração NÃO confirmou nada — as bandeiras `present` que ficaram do
 * ciclo anterior são memória, não leitura. Chamar-lhes "ligados" seria a
 * UI afirmar presença que o serviço não sustentou.
 */
export interface ResumoPresenca {
  ligados: number;
  removidos: number;
  naoConfirmados: number;
  total: number;
  /** A última enumeração confirmou presença (`operational` sem `error`). */
  enumeracaoConfirmada: boolean;
}

export function resumoDePresenca(snapshot: UsbProtectionSnapshot): ResumoPresenca {
  const confirmado = snapshot.monitorStatus === "operational" && !snapshot.error;
  const resumo: ResumoPresenca = { ligados: 0, removidos: 0, naoConfirmados: 0, total: snapshot.devices.length, enumeracaoConfirmada: confirmado };
  for (const d of snapshot.devices) {
    if (!confirmado) resumo.naoConfirmados += 1;
    else if (d.present === true) resumo.ligados += 1;
    else if (d.present === false) resumo.removidos += 1;
    else resumo.naoConfirmados += 1;
  }
  return resumo;
}

export function linhaDePresenca(resumo: ResumoPresenca): string {
  const partes = [
    `${resumo.ligados} ${resumo.ligados === 1 ? "ligada" : "ligadas"}`,
    `${resumo.removidos} ${resumo.removidos === 1 ? "removida" : "removidas"}`,
    `${resumo.naoConfirmados} com presença não confirmada`,
  ];
  return `Presença: ${partes.join(" · ")}.`;
}

// ── memória de sessão por dispositivo ────────────────────────────────────────

/**
 * O serviço NÃO republica o desfecho de uma análise quando a unidade é removida
 * e reinserida: `usb-protection.ts` substitui a entrada por `detected` e deita
 * fora o `result` («estado terminal anterior nao transita»). Com o opt-in
 * desligado — o default entregue — isso deixa a unidade a dizer apenas «proteção
 * USB desligada (opt-in)», e o que já se sabia desaparece do ecrã.
 *
 * Esta memória não é estado do produto nem uma segunda fonte de verdade: é o
 * registo do que o SERVIÇO publicou nesta sessão de painel, com a hora do
 * snapshot e o seu `scanId`. Nunca afirma presença (para isso há `present`) nem
 * proteção — serve para o painel poder dizer «esta unidade já foi analisada,
 * com este desfecho, a esta hora» em vez de fingir que nunca foi vista.
 */
export interface DesfechoUsb {
  /** Só os três desfechos que o contrato publica COM resultado. */
  status: UsbDeviceStatus;
  /** `snapshot.updatedAt` do momento em que o desfecho foi observado. */
  quando: string;
  scanId?: string;
}

export type MemoriaUsb = Readonly<Record<string, DesfechoUsb>>;

/** Mesmo tecto do histórico terminal do serviço (`LIMITE_HISTORICO_TERMINAL`). */
export const LIMITE_MEMORIA_USB = 24;

/**
 * `removed`/`incomplete` ficam de fora de propósito: o serviço retira-lhes o
 * `result` antes de os publicar, por isso tratá-los como desfecho seria contar
 * uma análise que o contrato não entrega.
 */
function ehDesfechoTerminal(status: UsbDeviceStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

/**
 * Regista (puro) os desfechos terminais publicados no snapshot. Nunca esquece
 * uma identidade; o tecto remove a MAIS ANTIGA por `quando` (empate decidido
 * pelo id, para o resultado não depender da ordem de iteração).
 */
export function registarDesfechos(memoria: MemoriaUsb, snapshot: UsbProtectionSnapshot): MemoriaUsb {
  const novo: Record<string, DesfechoUsb> = { ...memoria };
  for (const d of snapshot.devices) {
    if (!ehDesfechoTerminal(d.status)) continue;
    const anterior = novo[d.id];
    if (anterior && anterior.status === d.status && anterior.scanId === d.scanId) continue;
    novo[d.id] = { status: d.status, quando: snapshot.updatedAt, ...(d.scanId ? { scanId: d.scanId } : {}) };
  }
  const chaves = Object.keys(novo);
  if (chaves.length <= LIMITE_MEMORIA_USB) return novo;
  chaves.sort((a, b) => {
    const comparacao = novo[a].quando.localeCompare(novo[b].quando);
    return comparacao !== 0 ? comparacao : a.localeCompare(b);
  });
  const manter = new Set(chaves.slice(-LIMITE_MEMORIA_USB));
  for (const chave of chaves) if (!manter.has(chave)) delete novo[chave];
  return novo;
}

const DESFECHO_ROTULO: Record<string, string> = {
  completed: "concluída",
  cancelled: "cancelada",
  failed: "falhou",
};

/**
 * A linha que a unidade mostra quando o serviço já não publica o desfecho dela
 * (reinserção, ou opt-in desligado depois de uma análise). Devolve `null` quando
 * há um desfecho ATUAL no snapshot (`linhaDoResultado` já fala), quando a
 * análise está em curso, ou quando a identidade nunca foi vista nesta sessão.
 */
export function linhaDaMemoria(d: UsbDeviceState, memoria: MemoriaUsb): string | null {
  if (d.status === "scanning" || d.status === "queued") return null;
  if (ehDesfechoTerminal(d.status)) return null;
  const anterior = memoria[d.id];
  if (!anterior) return null;
  const rotulo = DESFECHO_ROTULO[anterior.status] ?? anterior.status;
  return (
    `Nesta sessão esta unidade já foi analisada — análise ${rotulo} às ${horaDe(anterior.quando)}. ` +
    "O serviço não republica esse resultado depois de uma nova inserção, e a análise anterior não se repete sozinha."
  );
}

/** Contagem honesta do histórico desta sessão de painel; `null` se não houver. */
export function resumoDeHistorico(memoria: MemoriaUsb): string | null {
  const desfechos = Object.values(memoria);
  if (desfechos.length === 0) return null;
  const contar = (status: string) => desfechos.filter((d) => d.status === status).length;
  const concluidas = contar("completed");
  const canceladas = contar("cancelled");
  const falhadas = contar("failed");
  return (
    `Nesta sessão: ${concluidas} ${concluidas === 1 ? "concluída" : "concluídas"} · ` +
    `${canceladas} ${canceladas === 1 ? "cancelada" : "canceladas"} · ` +
    `${falhadas} ${falhadas === 1 ? "falhada" : "falhadas"}.`
  );
}

/**
 * A análise individual a pedido (com consentimento) ainda NÃO tem contrato IPC:
 * os únicos canais USB publicados são `usb.getState`/`usb.configure`, e o
 * `scan.start` genérico não é read-only — o motor declara que uma análise USB
 * tem de ser estritamente read-only. Enquanto o contrato não existir, o painel
 * declara a ausência em vez de mostrar um botão que não faz nada.
 */
export const TEXTO_ANALISE_INDIVIDUAL_INDISPONIVEL =
  "Analisar uma unidade a pedido, com o teu consentimento, ainda não está disponível nesta versão: falta o " +
  "contrato do serviço para uma análise USB individual. Sem contrato não há botão — um pedido que não faz nada " +
  "seria pior do que a ausência.";

// ── análise individual a pedido (contrato ratificado pelo Codex, 15/10) ──────

/**
 * Seam de consumo do contrato, tal como ele foi ratificado (15/10) e NÃO um tipo
 * do contrato partilhado — esse vive em `@cybersafe/shared-types` e é do
 * OpenCode:
 *
 *   usbScan({ deviceId, requestId, consent: true }) → { ok: true, deviceId, scanId } | { ok: false, error }
 *   usbCancel({ deviceId, scanId })                → { ok: boolean, error? }
 *
 * Tudo o que este painel pede ao serviço passa por aqui: o painel constrói a
 * porta a partir da ponte (quando ela os expõe) e o orquestrador é quem decide
 * quando pedir — nunca o render.
 */
export interface PortaAnaliseIndividualUsb {
  iniciar(pedido: { deviceId: string; requestId: string; consent: true }): Promise<unknown>;
  cancelar(pedido: { deviceId: string; scanId: string }): Promise<unknown>;
}

/**
 * A ponte do renderer como o contrato a publica — declarada aqui, e não em
 * `electron.d.ts` (que é do OpenCode), porque o painel precisa de a LER sem
 * assumir que já existe nesta build: faltando `usbScan` ou `usbCancel`, a porta
 * é `null` e a UI declara a ausência em vez de mostrar um botão morto.
 */
export interface PonteAnaliseUsbRenderer {
  usbScan?: (pedido: { deviceId: string; requestId: string; consent: true }) => Promise<unknown>;
  usbCancel?: (pedido: { deviceId: string; scanId: string }) => Promise<unknown>;
}

/**
 * O gesto consentido. O `requestId` nasce com o gesto e MANTÉM-SE enquanto o
 * mesmo pedido for repetido — repetir não é um gesto novo, é a mesma intenção.
 */
export interface PedidoAnaliseIndividual {
  deviceId: string;
  requestId: string;
}

export interface AnaliseIndividualModelo {
  /** A ponte desta janela expõe `usbScan`+`usbCancel` (contrato presente). */
  podePedir: boolean;
  /** Porque não se pode pedir, quando não se pode. */
  motivoIndisponivel: string;
  /** Gesto à espera de confirmação do utilizador. */
  pedido: PedidoAnaliseIndividual | null;
  /** Operação em voo: nenhum gesto novo antes de o estado ser confirmado. */
  emCurso: { tipo: "iniciar" | "cancelar"; deviceId: string } | null;
}

/**
 * O que o consentimento autoriza, dito antes de o utilizador confirmar. A
 * deteção de uma unidade não prova que a análise corre: por isso a frase promete
 * o modo (só-leitura, sem quarentena) e não o resultado.
 */
export const TEXTO_PRE_ANALISE_INDIVIDUAL =
  "Esta análise corre no serviço em modo só-leitura (é o motor que o força), não coloca nada em quarentena, não " +
  "apaga nem altera nada na unidade e não envia conteúdo para fora. Estar detetada não prova que a análise corre: " +
  "o resultado só conta quando o serviço o publicar com um identificador próprio.";

export const TEXTO_PEDIDO_NAO_CONFIRMADO =
  "O pedido de análise não foi confirmado dentro do tempo esperado: não se sabe se chegou a arrancar. Vê o estado " +
  "da unidade antes de repetir — a app não repete a análise sozinha.";

export const TEXTO_CANCELAMENTO_NAO_CONFIRMADO =
  "O cancelamento não foi confirmado dentro do tempo esperado: não se sabe se chegou a ser entregue ao serviço. " +
  "O que se lê é apenas o que o estado da unidade disser — nenhum cancelamento é dado como certo daqui.";

export const TEXTO_SEM_ALVO_CANCELAMENTO =
  "Esta unidade não tem análise identificada (o serviço ainda não publicou um identificador dela). Cancelar só " +
  "pelo dispositivo podia cancelar uma análise que não é esta — por isso não se cancela nada.";

export type RespostaInicioAnalise =
  | { ok: true; deviceId: string; scanId: string }
  | { ok: false; error: string };

/**
 * Envelope estrito: `ok: true` sem `deviceId` e `scanId` não é sucesso (a UI não
 * pode afirmar uma análise que não sabe identificar) e `ok: false` sem motivo é
 * dito como tal, nunca tapado com um texto inventado.
 */
export function lerRespostaInicioAnalise(bruto: unknown): RespostaInicioAnalise | null {
  if (!bruto || typeof bruto !== "object") return null;
  const r = bruto as Record<string, unknown>;
  if (r.ok === true) {
    if (typeof r.deviceId !== "string" || r.deviceId.trim() === "") return null;
    if (typeof r.scanId !== "string" || r.scanId.trim() === "") return null;
    return { ok: true, deviceId: r.deviceId, scanId: r.scanId };
  }
  if (r.ok === false) {
    return {
      ok: false,
      error: typeof r.error === "string" && r.error !== "" ? r.error : "O serviço recusou o pedido sem declarar motivo.",
    };
  }
  return null;
}

export function lerRespostaCancelamento(bruto: unknown): { ok: boolean; error?: string } | null {
  if (!bruto || typeof bruto !== "object") return null;
  const r = bruto as Record<string, unknown>;
  if (typeof r.ok !== "boolean") return null;
  const limpo: { ok: boolean; error?: string } = { ok: r.ok };
  if (typeof r.error === "string" && r.error !== "") limpo.error = r.error;
  return limpo;
}

/**
 * O que o observador é, dito com as palavras dele. Nunca «protegido»: com
 * `operational` e zero dispositivos a frase é «nenhuma unidade confirmada», que
 * é o que a enumeração disse — não uma garantia.
 */
export function descreverMonitor(snapshot: UsbProtectionSnapshot): { titulo: string; tom: Tom; detalhe: string } {
  if (snapshot.monitorStatus === "starting") {
    return {
      titulo: "Monitorização USB a arrancar",
      tom: "proc",
      detalhe: "Ainda não há enumeração confirmada; o serviço pode demorar a responder.",
    };
  }
  if (snapshot.monitorStatus === "unavailable") {
    return {
      titulo: "Monitorização USB indisponível",
      tom: "warn",
      // A mensagem é a que o serviço devolveu; sem mensagem diz-se que não houve
      // motivo devolvido, em vez de se inventar uma causa.
      // Com a enumeração em falha, o que está na lista é memória do ciclo
      // anterior: presença não confirmada, não "ligadas".
      // Regra de apresentação: `operational` com `error` não é "ok" — é
      // presença não confirmada. O serviço pode estar operacional e a
      // enumeração mais recente ter falhado (ou o snapshot transportar um
      // erro de ciclo); não se conta o que não foi confirmado.
      detalhe:
        (snapshot.error ?? "O serviço não indicou o motivo da indisponibilidade.") +
        (snapshot.devices.length > 0
          ? ` As ${snapshot.devices.length === 1 ? "unidade listada" : "unidades listadas"} têm presença não confirmada desde a última enumeração bem-sucedida.`
          : ""),
    };
  }
  if (snapshot.devices.length === 0) {
    return {
      titulo: "Nenhuma unidade de armazenamento USB confirmada",
      tom: "na",
      detalhe: "A última enumeração não encontrou unidades. Isto não é uma garantia de proteção.",
    };
  }
  const presenca = resumoDePresenca(snapshot);
  return {
    // O título conta LIGADOS CONFIRMADOS, não `devices.length`: o array do
    // serviço é o histórico bounded (terminal não podado + removidos +
    // baseline), e usá-lo como total pintava 1 pen ligada como "3 unidades".
    // O histórico não desaparece — vive na linha de presença e na lista.
    titulo: `Monitorização operacional · ${presenca.ligados === 1 ? "1 unidade ligada" : `${presenca.ligados} unidades ligadas`}`,
    tom: snapshot.error ? "warn" : "na",
    // Regra de apresentação: com erro o título recorda que o ciclo não
    // confirmou presença — nunca «ligadas» sobre enumeração com erro.
    detalhe: snapshot.error
      ? `A deteção confirma armazenamento E transporte USB; o ciclo mais recente trouxe erro (${snapshot.error}). ${linhaDePresenca(presenca)}`
      : `A deteção confirma armazenamento E transporte USB; a letra da unidade isolada não prova nada. ${linhaDePresenca(presenca)}`,
  };
}

/** Nome humano da linha: o volume, se o Windows o publicar; senão a raiz. */
export function unidadeDe(d: UsbDeviceState): string {
  const rotulo = typeof d.label === "string" ? d.label.trim() : "";
  if (rotulo !== "") return rotulo;
  const raiz = typeof d.rootPath === "string" ? d.rootPath.trim() : "";
  return raiz !== "" ? `Unidade ${raiz}` : "Unidade sem nome";
}

/**
 * Linha do disco USB detetado SEM volume atribuído pelo Windows (falha 2 do
 * relatório Freebuff: antes este estado não existia no produto). É espera, não
 * análise: sem raiz não há alvo, e dizer "Deteção confirmada" a secas sugeriria
 * que havia algo para analisar.
 */
export function linhaDeEsperaVolume(d: UsbDeviceState): string | null {
  if (d.awaitingVolume !== true) return null;
  return "Detetado como USB — a aguardar volume (letra) do Windows. Sem volume não há nada para analisar; o estado atualiza-se sozinho quando a letra aparecer.";
}

/**
 * Sempre a perguntar: ausente ou ilegível diz «sem leitura». Não existe
 * «sem limitações» — a ausência de limitação reportada não é uma afirmação
 * de que não a há.
 */
export function limitacaoDoDispositivo(d: UsbDeviceState): string | null {
  return typeof d.limitation === "string" && d.limitation.trim() !== "" ? d.limitation : null;
}

/** O opt-in é o que o snapshot devolve, nunca o que a UI pediu. */
export function optInDoSnapshot(snapshot: UsbProtectionSnapshot | null): "ligado" | "desligado" | "desconhecido" {
  if (!snapshot) return "desconhecido";
  return snapshot.enabled ? "ligado" : "desligado";
}

/**
 * Coalescing com um pedido em voo (o padrão medido de `App.tsx` para eventos de
 * processos). Um terminal que chega durante um pedido em voo marca pendente: no
 * fim desse pedido faz-se UM re-pedido, não uma fila. `montagem`/`manual` deitam
 * fora quando já há um a correr. O `tick` periódico deita fora SEM marcação: há
 * outro tick daqui a `INTERVALO_CONSULTA_MS`, e encadear ticks era justamente a
 * tempestade de pedidos que esta regra existe para evitar.
 */
export function decidirRefreshUsb(motivo: MotivoRefresh, emVoo: boolean): DecisaoRefresh {
  if (!emVoo) return "pedir";
  if (motivo === "terminal" || motivo === "config") return "marcar_pendente";
  return "ignorar";
}

/**
 * Progresso ao vivo de UM dispositivo, e só enquanto o serviço diz que ele está
 * `scanning`: exige o `scanId` do dispositivo e que o estado do motor seja
 * exatamente dessa sessão. Dois motivos para a condição de estado:
 *  · um `scan.progress` de outra análise não pode pintar aqui uma barra que não
 *    lhe pertence (regra da bridge: progresso é progresso, nunca snapshot);
 *  · um dispositivo já terminal não volta a mostrar progresso velho — um evento
 *    atrasado da mesma sessão (running 71 depois de completed 100) tem de ser
 *    ignorado, porque o facto terminado já está no snapshot.
 */
export function progressoDoDispositivo(d: UsbDeviceState, aoVivo: ScanState | null): number | null {
  if (d.status !== "scanning") return null;
  if (!d.scanId || !aoVivo || aoVivo.id !== d.scanId) return null;
  return scanProgressPercent(aoVivo);
}

/**
 * Quando o motor disse «terminal» mas o snapshot do serviço ainda marca a
 * unidade como `scanning`, a UI NÃO declara «concluída» por conta própria —
 * diz que terminou e que falta a confirmação do serviço. O estado do
 * dispositivo (`incomplete`/`removed`) só o serviço o sabe.
 */
export function notaDeConfirmacao(d: UsbDeviceState, aoVivo: ScanState | null): string | null {
  if (d.status !== "scanning") return null;
  if (!d.scanId || !aoVivo || aoVivo.id !== d.scanId) return null;
  return isTerminalScanStatus(aoVivo.status) ? "terminou; a confirmar com o serviço" : null;
}

/**
 * A linha de contadores de uma análise TERMINADA. Só o `result` do snapshot do
 * serviço é usado — um terminal vindo do `scan.progress` não é facto do painel,
 * é facto do motor, e o painel diz isso com `notaDeConfirmacao` até o snapshot
 * chegar. Reusa o `scanResultBreakdown` do scanner, por isso «excluídos» continua
 * a significar «não chegou aos motores» e a reconciliação é a mesma que o cartão
 * de resultado já mostra (dois cartões a ler o mesmo `ScanState` de formas
 * diferentes é o tipo de contradição que esta lane existe para evitar).
 */
export function linhaDoResultado(d: UsbDeviceState): string | null {
  if (!isTerminalScanStatus(d.status)) return null;
  const estado = d.result;
  if (!estado) return "O serviço não devolveu contadores para esta análise.";
  const detalhe = scanResultBreakdown(estado);
  if (!detalhe) return "A análise terminou sem contadores no resultado.";
  const nota = scanResultBreakdownNote(detalhe, estado.status);
  const partes = [
    `considerados ${detalhe.considered}`,
    `analisados ${detalhe.analyzed}`,
    `excluídos ${detalhe.excluded}`,
    `falhados ${detalhe.failed}`,
    `ameaças ${detalhe.threats}`,
  ];
  return nota ? `${partes.join(" · ")} — ${nota}` : partes.join(" · ");
}

export type VistaPainel =
  | { tipo: "a_consultar" }
  | { tipo: "sem_ligacao" }
  | { tipo: "erro"; mensagem: string }
  | {
      tipo: "snapshot";
      monitor: { titulo: string; tom: Tom; detalhe: string };
      dispositivos: UsbDeviceState[];
      ignorados: number;
      enabled: boolean;
      atualizado: string;
      /** Linha de presença já composta (ligadas/removidas/não confirmadas). */
      presenca: string;
    };

/**
 * A matriz única do que se pinta. `erro` sem mensagem diz o que falhou em termos
 * de leitura, nunca «não há unidades» — ausência de leitura não é ausência de
 * dispositivos.
 */
export function vistaDoPainel(
  fase: FaseLeitura,
  snapshot: UsbProtectionSnapshot | null,
  ignorados: number,
  erro: string | null,
): VistaPainel {
  if (fase === "a_consultar") return { tipo: "a_consultar" };
  if (fase === "sem_ligacao") return { tipo: "sem_ligacao" };
  if (fase === "erro") return { tipo: "erro", mensagem: erro ?? "O serviço não devolveu o estado USB." };
  if (!snapshot) return { tipo: "erro", mensagem: "O serviço respondeu, mas sem estado USB reconhecível." };
  return {
    tipo: "snapshot",
    monitor: descreverMonitor(snapshot),
    dispositivos: snapshot.devices,
    ignorados,
    enabled: snapshot.enabled,
    atualizado: snapshot.updatedAt,
    presenca: linhaDePresenca(resumoDePresenca(snapshot)),
  };
}

/** Data e hora PT-PT do `updatedAt`; ilegível diz isso, não «Invalid Date». */
export function horaDe(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "hora ilegível no registo";
  return d.toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" });
}

// ── orquestração (consulta, coalescing, geração) ─────────────────────────────

export type FeedbackUsb =
  | { tipo: "inerte" }
  | { tipo: "ok"; mensagem: string }
  | { tipo: "erro"; mensagem: string }
  /** O pedido não foi confirmado no prazo: NÃO é falha nem sucesso. */
  | { tipo: "nao_confirmado"; mensagem: string };

export interface ModeloUsb {
  vista: VistaPainel;
  aoVivo: ScanState | null;
  aConfigurar: boolean;
  feedback: FeedbackUsb;
  /** O que o observador é agora, para a UI poder dizer «opt-in sem efeito». */
  monitorStatus: UsbMonitorStatus | null;
  enabled: boolean;
  /** Desfechos terminais observados nesta sessão de painel (histórico honesto). */
  memoria: MemoriaUsb;
  /** Análise individual a pedido: disponibilidade, gesto e operação em voo. */
  analise: AnaliseIndividualModelo;
  /**
   * Espera prolongada: já passou `INTERVALO_CONSULTA_MS` e o serviço não
   * respondeu. Mitigação de apresentação, NÃO um prazo de IPC — o pedido
   * continua em voo e a resposta tardia continua a contar.
   */
  esperaProlongada: boolean;
}

export interface OrquestradorUsbDeps {
  /** `usb.getState`, ou `null` quando a janela não tem bridge. */
  obterEstado?: (() => Promise<unknown>) | null;
  /** `usb.configure`, ou `null` quando a janela não tem bridge. */
  configurar?: ((config: { enabled: boolean }) => Promise<unknown>) | null;
  /** Seam de `usb.scan`/`usb.cancel` (contrato 15/10); `null` sem contrato na ponte. */
  portaAnalise?: PortaAnaliseIndividualUsb | null;
  /** Gerador de `requestId` — injetável para os testes serem determinísticos. */
  novoRequestId?: () => string;
  aoModelo: (modelo: ModeloUsb) => void;
  /** Agendador injetável: os testes funcionais não dependem do relógio real. */
  agendar?: (funcao: () => void, ms: number) => () => void;
  /** Teto da consulta; injetável para testes com relógio falso. */
  prazoMs?: number;
}

export interface OrquestradorUsb {
  iniciar(): void;
  parar(): void;
  recarregar(): void;
  alternarOptIn(pedido: boolean): Promise<void>;
  receberProgresso(estado: ScanState): void;
  /** Abre o consentimento de UM dispositivo (não fala com o serviço). */
  pedirConsentimento(deviceId: string): void;
  /** Fecha o consentimento sem pedir nada. */
  desistirDoPedido(): void;
  /** Confirma o gesto pendente (mesmo `requestId`) e pede a análise ao serviço. */
  confirmarPedido(): void;
  /** Pede o cancelamento da análise MOSTRADA (exige `deviceId` e `scanId`). */
  cancelarAnalise(deviceId: string): void;
  modelo(): ModeloUsb;
}

/**
 * O único sítio que fala com o serviço sobre USB. Vive fora do React porque tem
 * de ser testável com promises adiadas e um relógio emprestado — as três
 * revisões que este código recebeu foram todas aqui:
 *
 *  · **tick enquanto montado**: sem qualquer consulta periódica, uma pen ligada
 *    depois de a página abrir nunca aparece (`scan.progress` fala de sessões de
 *    análise; sem snapshot não há `device.scanId` para correlacionar). É um
 *    pedido por `INTERVALO_CONSULTA_MS`, coalescido com o in-flight guard, e é
 *    cancelado no `parar()` — não é um snapshot global nem um pedido por progresso.
 *  · **geração**: um `usb.getState` que estava em voo quando o utilizador ligou
 *    o opt-in resolveria DEPOIS do `usb.configure` e escreveria o `enabled`
 *    velho por cima da confirmação. Cada ação que manda no estado sobe a
 *    `geracao`; respostas de gerações anteriores são deitadas fora, inclusivé o
 *    seu `finally`.
 *  · **sem escrita depois de desmontado**: `parar()` sobe a geração e cala o
 *    emit — um `setState` pós-unmount não acontece por construção.
 *  · **progresso não reabre factos**: `shouldAcceptScanState` (o mesmo que o
 *    scanner usa, com HUMAN PASS) rejeita revisão inferior e estados não-terminais
 *    de uma sessão já terminada.
 */
export function criarOrquestradorUsb(deps: OrquestradorUsbDeps): OrquestradorUsb {
  const obterEstado = deps.obterEstado ?? null;
  const configurar = deps.configurar ?? null;
  const portaAnalise = deps.portaAnalise ?? null;
  const agendar =
    deps.agendar ??
    ((funcao: () => void, ms: number) => {
      const id = setTimeout(funcao, ms);
      return () => clearTimeout(id);
    });

  let fase: FaseLeitura = "a_consultar";
  let snapshot: UsbProtectionSnapshot | null = null;
  let ignorados = 0;
  let erro: string | null = null;
  let aoVivo: ScanState | null = null;
  let feedback: FeedbackUsb = { tipo: "inerte" };
  let aConfigurar = false;
  let emVoo = false;
  let pendente = false;
  let parado = true;
  let geracao = 0;
  let cancelarTick: (() => void) | null = null;
  let esperaProlongada = false;
  let cancelarEspera: (() => void) | null = null;
  /** Memória de sessão por dispositivo: sobrevive a snapshots, morre na montagem. */
  let memoria: MemoriaUsb = {};
  let pedido: PedidoAnaliseIndividual | null = null;
  let emCurso: AnaliseIndividualModelo["emCurso"] = null;
  let operacao = 0;
  let cancelarPrazoOperacao: (() => void) | null = null;
  let contadorGestos = 0;
  const novoRequestId = deps.novoRequestId ?? (() => `usb-${Date.now()}-${(contadorGestos += 1)}`);
  const prazoMs = deps.prazoMs ?? PRAZO_CONSULTA_MS;
  let cancelarPrazo: (() => void) | null = null;
  /**
   * Identidade do pedido atualmente ativo. Expirado o prazo, ou invalidada a
   * geração, sobe para 0 e a resposta tardia do mesmo pedido é deitada fora —
   * é o mecanismo que cumpre "respostas antigas não contam" atrás do timeout.
   */
  let pedidoAtivo = 0;
  let contadorPedidos = 0;
  /**
   * Sessões de que já se pediu confirmação ao serviço. Um terminal repetido (ou
   * um terminal com revisão maior da MESMA sessão) não volta a pedir: o pedido
   * é por sessão, não por evento.
   */
  const confirmados = new Set<string>();

  function modelo(): ModeloUsb {
    return {
      vista: vistaDoPainel(fase, snapshot, ignorados, erro),
      aoVivo,
      aConfigurar,
      feedback,
      monitorStatus: snapshot?.monitorStatus ?? null,
      enabled: snapshot?.enabled ?? false,
      memoria,
      analise: {
        podePedir: portaAnalise !== null,
        motivoIndisponivel: TEXTO_ANALISE_INDIVIDUAL_INDISPONIVEL,
        pedido,
        emCurso,
      },
      esperaProlongada,
    };
  }

  function emitir(): void {
    deps.aoModelo(modelo());
  }

  /**
   * Limiar de espera prolongada. Agenda SÓ uma mudança de apresentação: não
   * toca no `emVoo`, não chama `consultar`, não marca pendente. Se o painel for
   * desmontado pelo meio, o `parar()` cancela este temporizador e a ordem de
   * `parado` abaixo não emite.
   */
  function marcarEspera(): void {
    cancelarEspera?.();
    cancelarEspera = agendar(() => {
      cancelarEspera = null;
      if (parado) return;
      esperaProlongada = true;
      emitir();
    }, INTERVALO_CONSULTA_MS);
  }

  function limparEspera(): void {
    cancelarEspera?.();
    cancelarEspera = null;
    esperaProlongada = false;
  }

  function agendarTick(): void {
    if (parado || !obterEstado) return;
    cancelarTick?.();
    cancelarTick = agendar(() => {
      cancelarTick = null;
      consultar("tick");
    }, INTERVALO_CONSULTA_MS);
  }

  function consultar(motivo: MotivoRefresh): void {
    if (parado || !obterEstado) return;
    const decisao = decidirRefreshUsb(motivo, emVoo);
    if (decisao === "ignorar") return;
    if (decisao === "marcar_pendente") {
      pendente = true;
      return;
    }
    const geracaoPedido = geracao;
    contadorPedidos += 1;
    const meuPedido = contadorPedidos;
    pedidoAtivo = meuPedido;
    emVoo = true;
    marcarEspera();
    cancelarPrazo?.();
    cancelarPrazo = agendar(() => {
      cancelarPrazo = null;
      if (parado || geracaoPedido !== geracao || pedidoAtivo !== meuPedido) return;
      // Prazo real: ESTA leitura falhou a confirmar-se. A resposta antiga do
      // mesmo pedido passa a ser ignorada; não se afirma nada sobre o serviço.
      pedidoAtivo = 0;
      emVoo = false;
      limparEspera();
      snapshot = null;
      ignorados = 0;
      erro = TEXTO_PRAZO_CONSULTA;
      fase = "erro";
      emitir();
      agendarTick();
    }, prazoMs);
    if (motivo === "montagem" || motivo === "manual" || motivo === "retry") {
      fase = "a_consultar";
      erro = null;
      emitir();
    }
    Promise.resolve()
      .then(() => obterEstado())
      .then((bruto) => {
        if (parado || geracaoPedido !== geracao || pedidoAtivo !== meuPedido) return;
        const resultado = normalizarSnapshot(bruto);
        if (!resultado) {
          snapshot = null;
          erro = "O serviço devolveu um estado USB que a app não reconhece; nada é apresentado como certeza.";
          fase = "erro";
          return;
        }
        snapshot = resultado.snapshot;
        ignorados = resultado.ignorados;
        erro = null;
        fase = "snapshot";
        // O que o serviço publicou fica registado ANTES de pintar: a próxima
        // remoção/reinserção não pode apagar o que já se sabe.
        memoria = registarDesfechos(memoria, resultado.snapshot);
      })
      .catch((falha: unknown) => {
        if (parado || geracaoPedido !== geracao || pedidoAtivo !== meuPedido) return;
        snapshot = null;
        erro = falha instanceof Error ? falha.message : "O serviço não respondeu ao estado USB.";
        fase = "erro";
      })
      .finally(() => {
        // A geração mudou (configure/desmontagem) ou o prazo já falou: esta
        // resposta já não manda no estado, por isso também não mexe no guard.
        if (parado || geracaoPedido !== geracao || pedidoAtivo !== meuPedido) return;
        pedidoAtivo = 0;
        cancelarPrazo?.();
        cancelarPrazo = null;
        emVoo = false;
        limparEspera();
        emitir();
        agendarTick();
        if (pendente) {
          pendente = false;
          consultar("pendente");
        }
      });
  }

  function estadoDoDispositivo(deviceId: string): UsbDeviceState | null {
    return snapshot?.devices.find((d) => d.id === deviceId) ?? null;
  }

  /**
   * Abre UMA operação (pedido ou cancelamento) e fecha-a com prazo. O prazo não
   * é um cancelamento: é a declaração de que ESTA operação não foi confirmada.
   * A resposta que chegue tarde depois disso é deitada fora — e a análise nunca
   * é repetida por conta própria (só um novo gesto, ou a repetição do mesmo).
   */
  function abrirOperacao(
    tipo: "iniciar" | "cancelar",
    deviceId: string,
    textoPrazo: string,
    enviar: () => Promise<unknown>,
    aplicar: (bruto: unknown) => void,
  ): void {
    operacao += 1;
    const minhaOperacao = operacao;
    emCurso = { tipo, deviceId };
    cancelarPrazoOperacao?.();
    cancelarPrazoOperacao = agendar(() => {
      cancelarPrazoOperacao = null;
      if (parado || minhaOperacao !== operacao) return;
      emCurso = null;
      // A operação desta geração fica INVALIDADA: uma resposta que chegue
      // depois do prazo já não manda no estado (nem pode afirmar um
      // cancelamento que ninguém confirmou).
      operacao += 1;
      feedback = { tipo: "nao_confirmado", mensagem: textoPrazo };
      emitir();
      // Ver o estado ANTES de qualquer repetição: sem retry automático.
      consultar("pendente");
    }, prazoMs);
    emitir();
    Promise.resolve()
      .then(enviar)
      .then((bruto) => {
        if (parado || minhaOperacao !== operacao) return;
        aplicar(bruto);
      })
      .catch((falha: unknown) => {
        if (parado || minhaOperacao !== operacao) return;
        feedback = {
          tipo: "erro",
          mensagem: falha instanceof Error ? falha.message : "O serviço não respondeu ao pedido de análise USB.",
        };
      })
      .finally(() => {
        if (parado || minhaOperacao !== operacao) return;
        cancelarPrazoOperacao?.();
        cancelarPrazoOperacao = null;
        emCurso = null;
        emitir();
      });
  }

  return {
    iniciar() {
      if (!parado) return;
      parado = false;
      confirmados.clear();
      memoria = {};
      pedido = null;
      emCurso = null;
      operacao += 1;
      cancelarPrazoOperacao?.();
      cancelarPrazoOperacao = null;
      if (!obterEstado) {
        fase = "sem_ligacao";
        snapshot = null;
        emitir();
        return;
      }
      emitir();
      consultar("montagem");
    },
    parar() {
      parado = true;
      geracao += 1;
      cancelarTick?.();
      cancelarTick = null;
      cancelarPrazo?.();
      cancelarPrazo = null;
      limparEspera();
      emVoo = false;
      pendente = false;
      pedidoAtivo = 0;
      // Um pedido de análise em voo não volta a escrever depois de desmontar.
      operacao += 1;
      cancelarPrazoOperacao?.();
      cancelarPrazoOperacao = null;
      emCurso = null;
    },
    recarregar() {
      if (parado || !obterEstado) return;
      if (emVoo) {
        // Cooldown com estado que já existia: antes da espera prolongada o
        // clique é deitado fora — cliques repetidos não viram tempestade de CIM.
        if (!esperaProlongada) return;
        // Retry FUNCIONAL, com limite honesto: NÃO há cancelamento real do
        // IPC — o pedido antigo continua no bridge até resolver ou falhar.
        // A UI invalida-o (geração + pedido ativo), ignora a resposta tardia
        // e emite UM novo. Nunca dois pedidos a MANDAR no estado; pode haver
        // dois em transporte.
        geracao += 1;
        emVoo = false;
        pendente = false;
        pedidoAtivo = 0;
        cancelarPrazo?.();
        cancelarPrazo = null;
        limparEspera();
        consultar("retry");
        return;
      }
      consultar("manual");
    },
    async alternarOptIn(pedido: boolean) {
      if (parado) return;
      if (!configurar) {
        feedback = { tipo: "erro", mensagem: "Esta janela não tem o bridge de configuração USB." };
        emitir();
        return;
      }
      if (aConfigurar) return;
      // Esta ação passa a mandar no estado: invalida o que estiver em voo.
      geracao += 1;
      emVoo = false;
      pendente = false;
      pedidoAtivo = 0;
      cancelarPrazo?.();
      cancelarPrazo = null;
      // A espera armada pertencia ao pedido que acabou de ser invalidado — sem
      // isto, o modelo diria «sem resposta» com um snapshot confirmado em mãos.
      limparEspera();
      aConfigurar = true;
      feedback = { tipo: "inerte" };
      emitir();
      const geracaoPedido = geracao;
      try {
        const resultado = normalizarSnapshot(await configurar({ enabled: pedido }));
        if (parado || geracaoPedido !== geracao) return;
        if (!resultado) {
          feedback = {
            tipo: "erro",
            mensagem: "A resposta da configuração não é reconhecível; o estado mostrado continua a ser o anterior.",
          };
          return;
        }
        snapshot = resultado.snapshot;
        ignorados = resultado.ignorados;
        erro = null;
        fase = "snapshot";
        memoria = registarDesfechos(memoria, resultado.snapshot);
        // Só se afirma o que o snapshot devolveu — nunca o que foi pedido.
        feedback = {
          tipo: "ok",
          mensagem: resultado.snapshot.enabled
            ? "Monitorização confirmada ligada pelo serviço."
            : "Monitorização confirmada desligada pelo serviço.",
        };
      } catch (falha: unknown) {
        if (parado || geracaoPedido !== geracao) return;
        feedback = {
          tipo: "erro",
          mensagem: falha instanceof Error ? falha.message : "O serviço não confirmou a configuração USB.",
        };
      } finally {
        if (!parado && geracaoPedido === geracao) {
          aConfigurar = false;
          emitir();
          agendarTick();
        }
      }
    },
    receberProgresso(estado: ScanState) {
      if (parado) return;
      if (!estado || typeof estado.id !== "string") return;
      if (!shouldAcceptScanState(aoVivo, estado)) return;
      aoVivo = estado;
      emitir();
      // Uma só consulta de confirmação por sessão, por muito que o motor
      // repita o terminal. O estado do dispositivo sabe-o o serviço.
      if (isTerminalScanStatus(estado.status) && !confirmados.has(estado.id)) {
        confirmados.add(estado.id);
        consultar("terminal");
      }
    },
    pedirConsentimento(deviceId: string) {
      if (parado) return;
      if (!portaAnalise) {
        // Sem contrato na ponte não há gesto nenhum — e diz-se porquê.
        feedback = { tipo: "erro", mensagem: TEXTO_ANALISE_INDIVIDUAL_INDISPONIVEL };
        emitir();
        return;
      }
      // Um gesto de cada vez, até o estado ser confirmado.
      if (emCurso) return;
      const dispositivo = estadoDoDispositivo(deviceId);
      if (dispositivo && (dispositivo.status === "scanning" || dispositivo.status === "queued")) {
        feedback = {
          tipo: "erro",
          mensagem:
            "Esta unidade já tem uma análise em curso ou em fila: espera pelo estado dela antes de pedir outra. " +
            "O modelo USB analisa uma de cada vez.",
        };
        emitir();
        return;
      }
      contadorGestos += 1;
      pedido = { deviceId, requestId: novoRequestId() };
      feedback = { tipo: "inerte" };
      emitir();
    },
    desistirDoPedido() {
      if (parado) return;
      pedido = null;
      feedback = { tipo: "inerte" };
      emitir();
    },
    confirmarPedido() {
      if (parado || !portaAnalise || emCurso) return;
      const atual = pedido;
      if (!atual) return;
      abrirOperacao(
        "iniciar",
        atual.deviceId,
        TEXTO_PEDIDO_NAO_CONFIRMADO,
        () => portaAnalise.iniciar({ deviceId: atual.deviceId, requestId: atual.requestId, consent: true }),
        (bruto) => {
          const resposta = lerRespostaInicioAnalise(bruto);
          if (!resposta) {
            // Estado desconhecido: o gesto fica de pé com o MESMO requestId.
            feedback = {
              tipo: "erro",
              mensagem:
                "A resposta do serviço ao pedido de análise não é reconhecível: nada se afirma sobre a análise. " +
                "Podes repetir o mesmo pedido.",
            };
            return;
          }
          if (!resposta.ok) {
            // Recusa definitiva: um novo gesto gera um pedido novo.
            pedido = null;
            feedback = { tipo: "erro", mensagem: resposta.error };
            return;
          }
          pedido = null;
          feedback = {
            tipo: "ok",
            mensagem:
              `Análise pedida ao serviço: identificador ${resposta.scanId}. O resultado só conta quando o estado da ` +
              "unidade o publicar.",
          };
          consultar("pendente");
        },
      );
    },
    cancelarAnalise(deviceId: string) {
      if (parado || !portaAnalise || emCurso) return;
      const dispositivo = estadoDoDispositivo(deviceId);
      const scanId = dispositivo?.scanId;
      if (!scanId) {
        // O cancelamento exige os DOIS identificadores da análise mostrada.
        feedback = { tipo: "erro", mensagem: TEXTO_SEM_ALVO_CANCELAMENTO };
        emitir();
        return;
      }
      abrirOperacao(
        "cancelar",
        deviceId,
        TEXTO_CANCELAMENTO_NAO_CONFIRMADO,
        () => portaAnalise.cancelar({ deviceId, scanId }),
        (bruto) => {
          const resposta = lerRespostaCancelamento(bruto);
          if (!resposta) {
            feedback = {
              tipo: "erro",
              mensagem: "A resposta do serviço ao cancelamento não é reconhecível: não se afirma que a análise foi cancelada.",
            };
            return;
          }
          if (!resposta.ok) {
            feedback = {
              tipo: "erro",
              mensagem: resposta.error ?? "O serviço recusou o cancelamento sem declarar motivo.",
            };
            return;
          }
          feedback = {
            tipo: "ok",
            mensagem: "Cancelamento confirmado pelo serviço; o estado definitivo vem do estado da unidade.",
          };
          consultar("pendente");
        },
      );
    },
    modelo,
  };
}
