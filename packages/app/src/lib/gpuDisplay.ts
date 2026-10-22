/**
 * ── GPU: presença vs. leitura ────────────────────────────────────────────────
 *
 * Vive num módulo próprio porque o PC Center faz a MESMA pergunta em dois
 * cartões ("Gráficos (GPU)" e os sensores) e, antes, respondia mal nos dois:
 *
 *   `hardware.gpu === null`  →  "GPU não detetada"
 *
 * `null` significa apenas que o serviço ainda não publicou a leitura de GPU
 * (o tick lento que a deteta corre a cada 10 s, depois do primeiro snapshot).
 * No PC do utilizador existe uma AMD Radeon RX 5600 XT, portanto "não detetada"
 * era uma afirmação FALSA sobre o hardware — o defeito secundário reportado em
 * 2026-10-10 (o P0 de armazenamento tinha a mesma origem: um snapshot em cache
 * que nunca era reconstruído).
 *
 * As três situações são distintas e passam a ter texto distinto:
 *   1. `pending`  — a leitura ainda não chegou (`gpu === null`);
 *   2. `present`  — placa detetada (o sensor térmico pode continuar indisponível,
 *                   o que é dito no cartão da temperatura, não aqui);
 *   3. `absent`   — o sistema não reportou nenhum controlador gráfico.
 */
import type { HardwareSnapshot } from "@cybersafe/shared-types";

export type GpuPresence = "pending" | "present" | "absent";

/**
 * `available === false` só é publicado pelo motor quando não houve NENHUM
 * controlador gráfico. A ausência do campo (snapshots antigos, fixtures) conta
 * como `present`: um modelo reportado é prova de placa, e não se inventa
 * "não detetada" por falta de um campo opcional.
 */
export function gpuPresence(gpu: HardwareSnapshot["gpu"] | null | undefined): GpuPresence {
  if (!gpu) return "pending";
  return gpu.available === false ? "absent" : "present";
}

/** A leitura do serviço ainda não incluiu a GPU — facto, não uma conclusão. */
export const GPU_PENDING_LABEL = "Sem leitura da GPU";
export const GPU_PENDING_HINT =
  "A leitura de hardware ainda não devolveu dados da placa gráfica. Não significa que a placa não exista.";

/** O sistema não reportou nenhum controlador gráfico. */
export const GPU_ABSENT_LABEL = "Não detetada";
export const GPU_ABSENT_HINT = "O sistema não reportou nenhum controlador gráfico.";

/** Placa presente, mas sem sensor térmico legível. */
export const GPU_NO_SENSOR_LABEL = "Placa detetada · sem leitura térmica";
