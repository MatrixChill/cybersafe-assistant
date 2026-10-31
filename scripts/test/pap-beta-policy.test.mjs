import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avaliarBeta } from '../pap-beta-policy.mjs';

const provenance = { obrigacaoPorResolver: { bloqueador: true, residuos: [{ componente: 'ascii_tree', versao: '0.1.1' }] } };
const marker = { schema: 1, perfil: 'PAP_BETA_TEST', distribuicao: 'NAO_AUTORIZADA', pendencia: 'ascii_tree@0.1.1' };
test('beta exige opt-in, marcador e exatamente a pendência aprovada', () => {
  assert.equal(avaliarBeta({ optIn: '1', marker, provenance }).permitido, true);
  assert.equal(avaliarBeta({ optIn: '', marker, provenance }).permitido, false);
  assert.equal(avaliarBeta({ optIn: '1', marker: null, provenance }).permitido, false);
  assert.equal(avaliarBeta({ optIn: '1', marker, provenance: {} }).permitido, false);
  assert.equal(avaliarBeta({ optIn: '1', marker, provenance: { obrigacaoPorResolver: { bloqueador:true, residuos:[...provenance.obrigacaoPorResolver.residuos,{componente:'outro',versao:'1'}] } } }).permitido, false);
  assert.equal(avaliarBeta({ optIn: '1', marker: {...marker, distribuicao:'AUTORIZADA'}, provenance }).permitido, false);
});
