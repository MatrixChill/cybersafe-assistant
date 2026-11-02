export const ORBITAL_RADII = [1.6, 1.85] as const;

/** Bounded precession: neither plane can turn edge-on across the emblem. */
export function orbitalRingPose(seconds: number, ring: 0 | 1): [number, number, number] {
  const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return ring === 0
    ? [0.30 + Math.sin(t * Math.PI / 24) * 0.06, 0.18 * Math.cos(t * Math.PI / 24), t * Math.PI / 24]
    : [-0.34 + Math.sin(t * Math.PI / 32) * 0.05, -0.16 * Math.cos(t * Math.PI / 32), -t * Math.PI / 32];
}
