import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_UNAVAILABLE_NOTIFY_COOLDOWN_MS,
  shouldPublishEngineUnavailable,
} from '../dist/engine-health-notifications.js';

const agora = 1_000_000;
const on = (engine = 'ClamAV') => ({ engine, available: true, status: 'active' });
const off = (status = 'degraded', engine = 'ClamAV') => ({ engine, available: false, status });

test('R7: uma transição real de disponível para indisponível anuncia', () => {
  assert.equal(shouldPublishEngineUnavailable(on(), off(), agora, undefined), true);
});

test('R7: flapping dentro da janela de arrefecimento não repete a notificação', () => {
  const publishedAt = agora - 1000;
  assert.equal(shouldPublishEngineUnavailable(on(), off(), agora, publishedAt), false);
});

test('R7: depois da janela, uma nova transição volta a anunciar', () => {
  const publishedAt = agora - (ENGINE_UNAVAILABLE_NOTIFY_COOLDOWN_MS + 1);
  assert.equal(shouldPublishEngineUnavailable(on(), off(), agora, publishedAt), true);
});

test('R7: já indisponível não gera uma segunda notificação', () => {
  assert.equal(shouldPublishEngineUnavailable(off(), off('unavailable'), agora, undefined), false);
});

test('R7: voltar a estar disponível nunca anuncia indisponibilidade', () => {
  assert.equal(shouldPublishEngineUnavailable(off(), on(), agora, undefined), false);
});

test('R7: arranque sem leitura prévia não anuncia uma queda que não foi observada', () => {
  assert.equal(shouldPublishEngineUnavailable(null, off(), agora, undefined), false);
});

test('R7: motores distintos não partilham a decisão por nome', () => {
  assert.equal(shouldPublishEngineUnavailable(on('Native'), off('unavailable', 'Native'), agora, undefined), true);
});
