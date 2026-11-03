export const ORBITAL_RADII = [1.85, 2.1] as const;
export type OrbitalVariant = 'exterior' | 'depth';
/** Human visual approval, 2026-11-02. A remains available in the development lab. */
export const APPROVED_ORBITAL_VARIANT:OrbitalVariant = 'depth';

/** Bounded precession: neither plane can turn edge-on across the emblem. */
export function orbitalRingPose(seconds: number, ring: 0 | 1, variant:OrbitalVariant='exterior'): [number, number, number] {
  const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  if(variant==='depth')return ring===0
    ? [-.55+Math.sin(t*.24)*.12,.35+t*.22,t*.08]
    : [.65+Math.cos(t*.19)*.16,-.4-t*.16,-t*.11];
  const phase=t*Math.PI/(ring?16:12);
  const tilt=ring?-.57:.52;
  return ring === 0
    ? [tilt*Math.cos(phase),tilt*Math.sin(phase),phase*.35]
    : [tilt*Math.cos(phase),tilt*Math.sin(phase),-phase*.3];
}
