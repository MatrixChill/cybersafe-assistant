import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClamavOutput } from '../dist/clamav.js';
test('Linux batch preserves case-sensitive verdict attribution', {skip:process.platform!=='linux'},()=>{
 const result=parseClamavOutput({files:['/tmp/Case.txt','/tmp/case.txt'],stdout:'/tmp/Case.txt: OK\n/tmp/case.txt: Fixture.Sig FOUND\n',stderr:'',code:1});
 assert.equal(result.files[0].verdict,'clean');assert.equal(result.files[1].verdict,'detected');
});
