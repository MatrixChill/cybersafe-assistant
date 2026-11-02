/** Lab-only proposal: rotate the planes, not just a symmetric torus about itself. */
export function orbitalRingPose(seconds: number, ring: 0 | 1): [number, number, number] {
  const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return ring === 0
    ? [-0.55 + Math.sin(t * 0.24) * 0.12, 0.35 + t * 0.22, t * 0.08]
    : [0.65 + Math.cos(t * 0.19) * 0.16, -0.4 - t * 0.16, -t * 0.11];
}
