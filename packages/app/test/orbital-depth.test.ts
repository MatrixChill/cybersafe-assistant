import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Mesh, MeshStandardMaterial, Raycaster, Vector3 } from 'three';
import { createOrbitalBody } from '../src/v2/dashboard/effects/orbitalBody';
import { orbitalRingPose } from '../src/v2/dashboard/effects/orbitalPose';

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

test('both moving ring planes have front and occluded rear segments over a rotation', () => {
  const body=createOrbitalBody();body.updateMatrixWorld(true);
  const camera=new Vector3(0,0,7);
  for(const ring of [0,1] as const){
    let rear=0,front=0;
    for(let time=0;time<=60;time+=2){
      const orientation=new Euler(...orbitalRingPose(time,ring));
      for(let angle=0;angle<Math.PI*2;angle+=Math.PI/36){
        const point=new Vector3(Math.cos(angle)*(ring?1.7:1.4),Math.sin(angle)*(ring?1.7:1.4),0).applyEuler(orientation);
        const targetDistance=camera.distanceTo(point);
        const hit=new Raycaster(camera,point.clone().sub(camera).normalize()).intersectObject(body)[0];
        if(hit){if(hit.distance<targetDistance-.02)rear++;if(hit.distance>targetDistance+.02)front++;}
      }
    }
    assert.ok(rear>10,`ring ${ring}: rear sections must be occluded`);
    assert.ok(front>10,`ring ${ring}: front sections must remain visible`);
  }
  body.geometry.dispose();body.material.forEach(m=>m.dispose());
});
