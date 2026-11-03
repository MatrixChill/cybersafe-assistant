import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Vector3 } from 'three';
import { orbitalRingPose } from '../src/v2/dashboard/effects/orbitalPose';

const normal = (seconds: number, ring: 0 | 1) => new Vector3(0, 0, 1).applyEuler(new Euler(...orbitalRingPose(seconds, ring)));
test('proposal changes both orbital planes perceptibly and keeps independent inclinations', () => {
  for (const ring of [0, 1] as const) {
    assert.ok(normal(0, ring).angleTo(normal(16, ring)) > 0.03, 'rotating a symmetric ring about its own axis is insufficient');
  }
  for (const time of [0, 1, 5, 15]) {
    assert.ok(normal(time, 0).angleTo(normal(time, 1)) > 0.3, 'rings must not collapse into one plane');
  }
  assert.notDeepEqual(orbitalRingPose(5, 0), orbitalRingPose(5, 1));
});
test('invalid or negative clocks preserve a finite static initial pose', () => {
  for (const time of [NaN, Infinity, -1]) {
    for (const ring of [0, 1] as const) assert.deepEqual(orbitalRingPose(time, ring), orbitalRingPose(0, ring));
  }
});

test('both comparison variants move their planes visibly within six seconds',()=>{
  for(const variant of ['exterior','depth'] as const)for(const ring of [0,1] as const){
    const a=new Vector3(0,0,1).applyEuler(new Euler(...orbitalRingPose(0,ring,variant)));
    const b=new Vector3(0,0,1).applyEuler(new Euler(...orbitalRingPose(6,ring,variant)));
    assert.ok(a.angleTo(b)>.25,`${variant} ring ${ring}: plane motion is too subdued`);
  }
});
