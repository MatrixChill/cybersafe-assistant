import test from 'node:test';
import assert from 'node:assert/strict';
import { Mesh, MeshStandardMaterial, Raycaster, Vector3 } from 'three';
import { createOrbitalBody } from '../src/v2/dashboard/effects/orbitalBody';

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
