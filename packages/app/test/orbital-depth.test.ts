import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Mesh, MeshStandardMaterial, Raycaster, Vector3 } from 'three';
import { createOrbitalBody } from '../src/v2/dashboard/effects/orbitalBody';
import { orbitalRingPose, ORBITAL_RADII } from '../src/v2/dashboard/effects/orbitalPose';

test('opaque volumetric body hides rear geometry and leaves front geometry visible', () => {
  const body = createOrbitalBody();
  body.updateMatrixWorld(true);
  const ray = new Raycaster(new Vector3(0.4, 0, 7), new Vector3(0, 0, -1));
  const hit = ray.intersectObject(body)[0];
  assert.ok(hit, 'central emblem must have a physical occluding face');
  assert.ok(hit.point.z > 0.15 && hit.point.z < 0.4);
  assert.ok(hit.distance < 7.5, 'rear segment at z=-0.5 is hidden');
  assert.ok(hit.distance > 6.5, 'front segment at z=0.5 remains in front');
  const materials = Array.isArray(body.material) ? body.material : [body.material];
  for (const material of materials) {
    assert.equal(material.transparent, false);
    assert.equal(material.depthWrite, true);
    assert.equal(material.depthTest, true);
  }
  body.geometry.computeBoundingBox();
  assert.ok(body.geometry.boundingBox!.max.z - body.geometry.boundingBox!.min.z > 0.35);
  assert.equal(body instanceof Mesh, true);
  assert.equal(materials.every(m => m instanceof MeshStandardMaterial), true);
  body.geometry.dispose();
  materials.forEach(m => m.dispose());
});

test('complete ring trajectories stay outside the emblem projection for both full cycles', () => {
  const camera=new Vector3(0,0,7);
  for(const ring of [0,1] as const){
    for(let time=0;time<=160;time+=.5){
      const orientation=new Euler(...orbitalRingPose(time,ring));
      for(let angle=0;angle<Math.PI*2;angle+=Math.PI/90){
        const point=new Vector3(Math.cos(angle)*ORBITAL_RADII[ring],Math.sin(angle)*ORBITAL_RADII[ring],0).applyEuler(orientation).applyEuler(new Euler(Math.cos(time*.25)*.04,Math.sin(time*.3)*.06,0));
        // Perspective at the near side of the opaque body. Includes bevel and tube margin.
        const projectedRadius=Math.hypot(point.x,point.y)*(camera.z-.205)/(camera.z-point.z);
        assert.ok(projectedRadius>1.16,`ring ${ring}, t=${time}: silhouette clearance ${projectedRadius}`);
      }
    }
  }
});
