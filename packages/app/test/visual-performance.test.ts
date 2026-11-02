import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_V2_PREFERENCES, deriveV2Capabilities, readV2Preferences, readVisualNoticeDismissals, writeVisualNoticeDismissals } from '../src/v2/theme';

test('custom disables renderers and independent decoration', () => {
  const caps = deriveV2Capabilities({...DEFAULT_V2_PREFERENCES, performance:'custom', effects:{core3d:false,orbits:false,particles:false,glass:false,blur:false,glow:false,transitions:false}}, false);
  assert.equal(caps.gpu, false);
  assert.equal(caps.animate, false);
  assert.equal(caps.effects.blur, false);
  assert.equal(caps.effects.particles, false);
});

test('old high preference survives migration and custom controls load defensively', () => {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  const data:Record<string,string>={cybersafe_appearance_v2:JSON.stringify({...DEFAULT_V2_PREFERENCES,performance:'high'})};
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>data[k]??null,setItem:(k:string,v:string)=>{data[k]=v;}}});
  try {
    assert.equal(readV2Preferences().performance,'high');
    data.cybersafe_appearance_v2=JSON.stringify({...DEFAULT_V2_PREFERENCES,performance:'custom',effects:{core3d:false,blur:'invalid',glow:false}});
    const p=readV2Preferences();
    assert.equal(p.effects?.core3d,false);assert.equal(p.effects?.blur,true);assert.equal(p.effects?.glow,false);
    assert.equal(writeVisualNoticeDismissals(['webgl-unavailable']),true);
    assert.deepEqual(readVisualNoticeDismissals(),['webgl-unavailable']);
    data.cybersafe_visual_notices_v1='broken';assert.deepEqual(readVisualNoticeDismissals(),[]);
  } finally {if(previous)Object.defineProperty(globalThis,'localStorage',previous);else Reflect.deleteProperty(globalThis,'localStorage');}
});
test('automatic uses observed frame instability while manual quality remains requested', () => {
  assert.equal(deriveV2Capabilities(DEFAULT_V2_PREFERENCES,false,{unstable:true}).lowPower,true);
  assert.equal(deriveV2Capabilities({...DEFAULT_V2_PREFERENCES,performance:'high'},false,{unstable:true}).lowPower,false);
  assert.equal(deriveV2Capabilities(DEFAULT_V2_PREFERENCES,false).lowPower,false);
});
test('reduced motion and unavailable WebGL override every visual profile', () => {
  for (const performance of ['auto','high','balanced','economy','custom'] as const) {
    const caps=deriveV2Capabilities({...DEFAULT_V2_PREFERENCES,performance},true,{webglAvailable:false});
    assert.equal(caps.animate,false);
    assert.equal(caps.gpu,false);
    assert.equal(caps.effects.orbits,false);
  }
});
