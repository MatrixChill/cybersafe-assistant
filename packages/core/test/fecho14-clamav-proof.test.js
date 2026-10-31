import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseClamavOutput} from '../dist/index.js';
const parse=stdout=>parseClamavOutput({files:['one.txt','two.txt'],code:0,stdout,stderr:'',fileExists:()=>true});
test('code zero sem output não prova análise dos ficheiros',()=>{
  assert.ok(parse('').files.every(f=>f.verdict==='error'));
});
test('resumo parcial não prova análise dos ficheiros sem OK',()=>{
  const result=parse('Scanned files: 1\nInfected files: 0\n');
  assert.ok(result.files.every(f=>f.verdict==='error'));
});
test('resumo completo e limpo permite clean para o lote',()=>{
  assert.ok(parse('Scanned files: 2\nInfected files: 0\n').files.every(f=>f.verdict==='clean'));
});
test('OK por ficheiro preserva prova individual mesmo sem resumo',()=>{
  const result=parse('one.txt: OK\n');
  assert.equal(result.files[0].verdict,'clean');
  assert.equal(result.files[1].verdict,'error');
});
