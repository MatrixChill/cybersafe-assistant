import { ExtrudeGeometry, Mesh, MeshPhysicalMaterial, Shape } from 'three';

export function createOrbitalBody() {
  const face = new Shape();
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 6 + i * Math.PI / 3;
    const x = Math.cos(angle) * 1.05, y = Math.sin(angle) * 1.05;
    if (i === 0) face.moveTo(x, y); else face.lineTo(x, y);
  }
  face.closePath();
  const geometry = new ExtrudeGeometry(face, {depth: .32, bevelEnabled: true, bevelSize: .045, bevelThickness: .045, bevelSegments: 3, steps: 1});
  geometry.translate(0, 0, -.16);
  // Opaque faces and bevels participate in the same depth buffer as both rings.
  const front = new MeshPhysicalMaterial({color:0x11738b,metalness:.6,roughness:.3,clearcoat:1,transparent:false,depthWrite:true,depthTest:true});
  const side = front.clone();
  side.roughness = .42;
  return new Mesh(geometry, [front, side]);
}
