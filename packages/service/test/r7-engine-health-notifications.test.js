import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_UNAVAILABLE_NOTIFY_COOLDOWN_MS,
  engineUnavailableKey,
  shouldPublishEngineUnavailable,
} from '../dist/engine-health-notifications.js';

const agora = 1_000_000;
const on = (engine = 'ClamAV') => ({ engine, available: true, status: 'active' });
const off = (status = 'degraded', engine = 'ClamAV') => ({ engine, available: false, status });

test('R7: uma transição real de disponível para indisponível anuncia', () => {
  assert.equal(shouldPublishEngineUnavailable(on(), off(), agora, undefined), true);
});

test('R7: a MESMA fingerprint dentro da janela não repete a notificação', () => {
  const notice = { key: engineUnavailableKey(off()), at: agora - 1000 };
  assert.equal(shouldPublishEngineUnavailable(on(), off(), agora, notice), false);
});

test('R7: a mesma fingerprint volta a anunciar depois da janela', () => {
  const notice = { key: engineUnavailableKey(off()), at: agora - (ENGINE_UNAVAILABLE_NOTIFY_COOLDOWN_MS + 1) };
  assert.equal(shouldPublishEngineUnavailable(on(), off(), agora, notice), true);
});

test('R7: uma indisponibilidade DIFERENTE após recuperação não é ocultada pela janela', () => {
  const notice = { key: engineUnavailableKey(off('degraded')), at: agora - 1000 };
  assert.equal(shouldPublishEngineUnavailable(on(), off('unavailable'), agora, notice), true);
});

test('R7: motores distintos têm fingerprints distintas', () => {
  const notice = { key: engineUnavailableKey(off('degraded', 'ClamAV')), at: agora - 1000 };
  assert.equal(shouldPublishEngineUnavailable(on('Native'), off('degraded', 'Native'), agora, notice), true);
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
