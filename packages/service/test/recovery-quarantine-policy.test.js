import test from 'node:test';
import assert from 'node:assert/strict';
import {canAutoQuarantine,loadQuarantinePolicy} from '../dist/quarantine-policy.js';
test('safe default and critical confidence alone never authorize automatic isolation',async()=>{
  assert.equal(await loadQuarantinePolicy('/no-such-fixture-policy'), 'warn');
  const a={severity:'critical',verdict:'malicious',confidence:0.99,rulesTriggered:['high_entropy'],riskScore:100};
  for(const policy of ['warn','ask','invalid','automatic-high-confidence'])assert.equal(canAutoQuarantine(policy,a),false);
  assert.equal(canAutoQuarantine('automatic-high-confidence',{...a,rulesTriggered:['known_bad_hash']}),true);
  assert.equal(canAutoQuarantine('automatic-high-confidence',{...a,rulesTriggered:['known_bad_hash'],confidence:0.3}),false);
});
