import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_EVENTS_ENV, sampleEventsAllowed } from '../dist/sample-events.js';

test('R7/AUD-001: produção nunca autoriza eventos de exemplo, nem com opt-in', () => {
  assert.equal(sampleEventsAllowed({ NODE_ENV: 'production', [SAMPLE_EVENTS_ENV]: '1' }), false);
  assert.equal(sampleEventsAllowed({ NODE_ENV: 'production' }), false);
});

test('R7/AUD-001: desenvolvimento sem opt-in explícito não escreve amostra', () => {
  assert.equal(sampleEventsAllowed({ NODE_ENV: 'development' }), false);
  assert.equal(sampleEventsAllowed({ NODE_ENV: 'development', [SAMPLE_EVENTS_ENV]: '0' }), false);
  assert.equal(sampleEventsAllowed({ NODE_ENV: 'development', [SAMPLE_EVENTS_ENV]: 'true' }), false);
});

test('R7/AUD-001: só o opt-in exacto em ambiente não-produção autoriza', () => {
  assert.equal(sampleEventsAllowed({ NODE_ENV: 'development', [SAMPLE_EVENTS_ENV]: '1' }), true);
  assert.equal(sampleEventsAllowed({ NODE_ENV: 'test', [SAMPLE_EVENTS_ENV]: '1' }), true);
});

test('R7/AUD-001: ausência de NODE_ENV não equivale a produção (opt-in continua explícito)', () => {
  assert.equal(sampleEventsAllowed({ [SAMPLE_EVENTS_ENV]: '1' }), true);
  assert.equal(sampleEventsAllowed({}), false);
});
