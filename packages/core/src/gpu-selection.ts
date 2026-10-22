/**
 * Seleção determinística da GPU principal (multi-GPU).
 *
 * Vive num módulo próprio para poder ser partilhado por `hardware.ts` e pelos
 * providers de temperatura (`temperature.ts`) sem criar um ciclo de imports.
 * Nunca escolhemos `controller[0]` cegamente: em máquinas com gráficos
 * integrados + discretos a primeira listada costuma ser a integrada.
 */

/** Padrões de GPUs discretas (preferidas) vs integradas (fallback). */
export const DISCRETE_GPU_PATTERNS = [
  /nvidia/i, /geforce/i, /\brtx\b/i, /\bgtx\b/i, /quadro/i, /radeon\s+rx/i,
  /\brx\s*\d{4}/i, /\barc\b/i, /\bradeon\s+pro\b/i, /\bvega\s+\d+/i,
];

export const INTEGRATED_GPU_PATTERNS = [
  /radeon\(tm\)\s+graphics/i, /\bradeon\s+graphics\b/i, /intel.*(uhd|hd|iris)/i,
  /\buhd\s+graphics\b/i, /\bhd\s+graphics\b/i, /\biris\b/i, /\bvega\s+graphics\b/i,
  /\bgraphics\b(?!.*\b(rx|rtx|gtx)\b)/i,
];

/** Classifica uma GPU a partir do modelo. */
export function isDedicatedGpu(model: string | undefined | null): boolean {
  const name = (model ?? "").trim();
  if (!name) return false;
  if (INTEGRATED_GPU_PATTERNS.some((re) => re.test(name))) return false;
  return DISCRETE_GPU_PATTERNS.some((re) => re.test(name));
}

/** Pontuação de escolha da GPU principal: dedicada > mais VRAM > primeira. */
export function gpuSelectionScore(gpu: { model?: string; vramTotalMb?: number | null }): number {
  const dedicated = isDedicatedGpu(gpu.model) ? 1000 : 0;
  const vram = typeof gpu.vramTotalMb === "number" && Number.isFinite(gpu.vramTotalMb) ? gpu.vramTotalMb : 0;
  return dedicated + vram / 1024;
}

/**
 * Escolhe o controlador principal de uma lista de GPUs (regra determinística,
 * com tie-break pela ordem original). Aceita controladores crus do
 * systeminformation (`model`/`vram`).
 */
export function pickPrimaryGpuController<T extends { model?: string; vram?: number | null }>(
  controllers: T[],
): T | null {
  if (!controllers || controllers.length === 0) return null;
  return controllers
    .map((g, index) => ({ g, index, score: gpuSelectionScore({ model: g.model, vramTotalMb: g.vram ?? null }) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))[0].g;
}
