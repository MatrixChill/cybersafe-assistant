/**
 * Histórico/PDF — duração e identificação do alvo, puros e testáveis.
 *
 * P0-A-app (15/10). Duas regras, ambas de apresentação:
 *
 *  1. DURAÇÃO. A análise USB real fechou 16 421 ficheiros em 818 496 ms e o
 *     histórico mostrava esse tempo em bruto/ilegível. `formatDuration` diz
 *     «13 min 38 s» — e nada é arredondado para cima: um tempo medido é um
 *     tempo medido, não uma estimativa.
 *
 *  2. IDENTIFICAÇÃO DO ALVO. Uma análise a `H:\` aparece hoje como «Pasta
 *     escolhida», o mesmo rótulo que qualquer pasta do disco. A partir de agora,
 *     quando — e SÓ quando — o alvo pode ser ligado a uma unidade USB detetada,
 *     diz-se «USB (H:\)» com o nome do volume.
 *
 *     LIMITE DE PRIVACIDADE, que dita o desenho: `ScanHistoryEntry` não tem
 *     caminho nenhum (é regra do produto, com teste próprio) e o painel não pode
 *     inventar um. A única ligação disponível é o **id do scan**: a unidade USB
 *     publica o `scanId` da análise que lhe pertence. Sem essa ligação, ou sem
 *     a lista de unidades, o rótulo fica EXATAMENTE como estava — nunca se
 *     adivinha que uma pasta é USB por causa da letra.
 */
import type { UsbDeviceState } from "@cybersafe/shared-types";

/** Tipos de alvo que o histórico/scanner consegue distinguir sem adivinhar. */
export type ScanTargetKind = "default" | "custom" | "folder" | "file";

export interface ScanTargetInput {
  /** O que a camada que chama SABE sobre o alvo. */
  kind: ScanTargetKind;
  /** Caminho ou raiz do alvo — só quando a camada que chama o tem mesmo. */
  path?: string | null;
  /** Id do scan, para correlacionar com a unidade USB (`UsbDeviceState.scanId`). */
  scanId?: string | null;
}

export interface ScanHistoryOutcome {
  label: string | null;
  partial: boolean;
}

/** A conclusão do scan e a conclusão dos motores são estados diferentes. */
export function describeScanHistoryOutcome(status: string, filesInconclusive: unknown): ScanHistoryOutcome {
  if (status !== "completed") return { label: null, partial: false };
  if (
    typeof filesInconclusive !== "number" ||
    !Number.isInteger(filesInconclusive) ||
    filesInconclusive < 0
  ) {
    return { label: "Estado conclusivo dos motores não reportado", partial: true };
  }
  if (filesInconclusive === 0) return { label: null, partial: false };
  return {
    label: filesInconclusive === 1
      ? "Parcial — 1 resultado inconclusivo"
      : `Parcial — ${filesInconclusive} resultados inconclusivos`,
    partial: true,
  };
}

/** Rótulos de hoje, que continuam a ser o que se mostra quando não há prova. */
export const TARGET_LABEL_COMPUTER = "Computador";
export const TARGET_LABEL_FOLDER_UNKNOWN = "Pasta escolhida";
const SEM_LEITURA = "sem leitura";

/**
 * Duração legível em PT-PT.
 *
 *   818496 → "13 min 38 s"   (o caso real medido)
 *   760    → "760 ms"        (abaixo de 1 s mostra-se em milissegundos)
 *   4_500_000 → "1 h 15 min" (acima de 1 h deixa de haver segundos)
 *
 * Um valor ausente, não finito ou negativo devolve «sem leitura»: ausência não é
 * zero, e uma duração não medida não se apresenta como 0 ms.
 */
export function formatDuration(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return SEM_LEITURA;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const segundos = ms / 1000;
  if (segundos < 60) {
    // Abaixo de 10 s mantém-se o décimo: 3,4 s diz mais do que 3 s. O separador
    // decimal é o de PT-PT (vírgula): `toFixed` devolveria «3.4 s».
    return `${segundos < 10 ? segundos.toFixed(1).replace(".", ",") : Math.round(segundos)} s`;
  }
  const minutos = Math.floor(segundos / 60);
  const resto = Math.round(segundos % 60);
  if (minutos < 60) return `${minutos} min ${resto} s`;
  const horas = Math.floor(minutos / 60);
  return `${horas} h ${minutos % 60} min`;
}

/** Raiz de unidade (`H:\`, `c:/`) de um caminho, ou null se não houver letra. */
function raizDe(path: string): string | null {
  const m = /^([A-Za-z]):[\\/]?/.exec(path.trim());
  return m ? `${m[1].toUpperCase()}:\\` : null;
}

function listaDe(drives: readonly UsbDeviceState[] | null | undefined): readonly UsbDeviceState[] {
  return Array.isArray(drives) ? drives : [];
}

/** Unidade USB cuja raiz é a do caminho, ou cujo `scanId` é o do scan. */
function unidadeDoAlvo(
  alvo: ScanTargetInput,
  drives: readonly UsbDeviceState[] | null | undefined,
): UsbDeviceState | null {
  const unidades = listaDe(drives).filter((d) => d.awaitingVolume !== true);
  const id = typeof alvo.scanId === "string" && alvo.scanId.trim() !== "" ? alvo.scanId.trim() : null;
  if (id !== null) {
    const porId = unidades.find((d) => typeof d.scanId === "string" && d.scanId === id);
    if (porId) return porId;
  }
  const caminho = typeof alvo.path === "string" ? alvo.path.trim() : "";
  const raiz = caminho !== "" ? raizDe(caminho) : null;
  if (raiz === null) return null;
  return unidades.find((d) => raizDe(String(d.rootPath ?? "")) === raiz) ?? null;
}

/** «USB (H:\)» — com o nome do volume quando o Windows o publica. */
export function usbTargetLabel(unidade: Pick<UsbDeviceState, "rootPath" | "label">): string {
  const raiz = raizDe(String(unidade.rootPath ?? "")) ?? "sem letra";
  const rotulo = typeof unidade.label === "string" ? unidade.label.trim() : "";
  return rotulo !== "" ? `USB (${raiz}) · ${rotulo}` : `USB (${raiz})`;
}

/** Último segmento com significado de um caminho (sem separadores finais). */
export function targetNameFromPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const limpo = path.trim().replace(/[\\/]+$/, "");
  if (limpo === "") return null;
  const partes = limpo.split(/[\\/]/);
  const nome = partes[partes.length - 1]?.trim() ?? "";
  if (nome === "") return null;
  // A raiz de uma unidade nao tem nome: a letra sozinha nao e uma pasta.
  if (/^[A-Za-z]:$/.test(nome)) return null;
  return nome;
}

/**
 * Rótulo do alvo para o histórico e para o PDF. A ordem importa:
 *
 *   1. prova de USB (raiz igual à de uma unidade detetada, ou `scanId` igual) →
 *      «USB (H:\)» (+ nome do volume);
 *   2. tipo conhecido + nome do caminho → «Ficheiro <nome>» / «Pasta <nome>»;
 *   3. sem prova nenhuma → os rótulos de hoje («Computador» / «Pasta escolhida»).
 *
 * `custom` NUNCA vira «Pasta <nome>» por si só: sem saber o tipo real e sem o
 * nome, chamar-lhe pasta seria adivinhar — e é isso que a regra proíbe.
 */
export function describeScanTarget(
  target: ScanTargetInput | null | undefined,
  drivesSnapshot: readonly UsbDeviceState[] | null | undefined,
): string {
  const alvo: ScanTargetInput =
    target && typeof target === "object" ? target : { kind: "custom" };

  const unidade = unidadeDoAlvo(alvo, drivesSnapshot);
  if (unidade) return usbTargetLabel(unidade);

  const nome = targetNameFromPath(alvo.path);
  if (alvo.kind === "file" && nome) return `Ficheiro ${nome}`;
  if (alvo.kind === "folder" && nome) return `Pasta ${nome}`;
  if (alvo.kind === "default") return TARGET_LABEL_COMPUTER;
  return TARGET_LABEL_FOLDER_UNKNOWN;
}
