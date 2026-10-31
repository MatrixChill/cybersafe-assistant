import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  SAMPLE_EVENTS_ENV,
  sampleEventsAllowed,
  seedSampleThreatEventsWith,
} from '../dist/sample-events.js';

const env = (mode, optIn = '1') => ({ NODE_ENV: mode, [SAMPLE_EVENTS_ENV]: optIn });

test('R7/AUD-001: produção nunca autoriza, nem com opt-in', () => {
  assert.equal(sampleEventsAllowed(env('production')), false);
  assert.equal(sampleEventsAllowed({ NODE_ENV: 'production' }), false);
});

test('R7/AUD-001: só development/test EXPLÍCITOS autorizam', () => {
  assert.equal(sampleEventsAllowed(env('development')), true);
  assert.equal(sampleEventsAllowed(env('test')), true);
});

test('R7/AUD-001: NODE_ENV ausente, staging ou capitalizado não autoriza', () => {
  assert.equal(sampleEventsAllowed({ [SAMPLE_EVENTS_ENV]: '1' }), false);
  assert.equal(sampleEventsAllowed(env('staging')), false);
  assert.equal(sampleEventsAllowed(env('Production')), false);
  assert.equal(sampleEventsAllowed(env('development', 'true')), false);
});

test('R7/AUD-001: desenvolvimento sem opt-in não escreve nada', async () => {
  let creates = 0;
  const inserted = await seedSampleThreatEventsWith({
    env: { NODE_ENV: 'development' },
    countThreatEvents: () => 0,
    createThreatEvents: () => { creates += 1; },
  });
  assert.equal(inserted, 0);
  assert.equal(creates, 0);
});

test('R7/AUD-001: produção com DB vazia e opt-in não insere', async () => {
  let creates = 0;
  const inserted = await seedSampleThreatEventsWith({
    env: { NODE_ENV: 'production', [SAMPLE_EVENTS_ENV]: '1' },
    countThreatEvents: () => 0,
    createThreatEvents: () => { creates += 1; },
  });
  assert.equal(inserted, 0);
  assert.equal(creates, 0);
});

test('R7/AUD-001: desenvolvimento com opt-in insere a amostra numa DB vazia', async () => {
  let received = null;
  const inserted = await seedSampleThreatEventsWith({
    env: { NODE_ENV: 'development', [SAMPLE_EVENTS_ENV]: '1' },
    countThreatEvents: () => 0,
    createThreatEvents: (data) => { received = data; },
  });
  assert.equal(inserted, 2);
  assert.equal(received.length, 2);
});

test('R7/AUD-001: uma DB já populada nunca recebe amostra (não apaga nem acrescenta)', async () => {
  let creates = 0;
  const inserted = await seedSampleThreatEventsWith({
    env: { NODE_ENV: 'development', [SAMPLE_EVENTS_ENV]: '1' },
    countThreatEvents: () => 7,
    createThreatEvents: () => { creates += 1; },
  });
  assert.equal(inserted, 0);
  assert.equal(creates, 0);
});

test('R7/AUD-001: o processo API empacotado arranca com NODE_ENV=production', () => {
  const source = fs.readFileSync(new URL('../../desktop/src/api-lifecycle.ts', import.meta.url), 'utf8');
  assert.match(source, /env\.NODE_ENV\s*=\s*"production"/);
});
