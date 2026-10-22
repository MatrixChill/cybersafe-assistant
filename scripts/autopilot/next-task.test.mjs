// Teste de autonomia A/B/C/D exigido antes de entregar ao amigo (fixtures proprias,
// nada toca o produto). Corre: node --test scripts/autopilot/next-task.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBacklog, stateExclusions, pickNext } from './next-task.mjs';

const YAML = `
tasks:
  - id: a-p0-code
    title: "P0 analise: trabalho com codigo na cloud"
    priority: P0
    area: Scanner
    state: READY_PARTIAL
    cloud_capable: true
    needs_windows: false
    missing: "falta teste"
  - id: b-p0-blocked
    title: "P0 tarefa que vai falhar"
    priority: P0
    area: USB
    state: READY_PARTIAL
    cloud_capable: true
    needs_windows: false
    missing: "-"
  - id: c-p0-windows
    title: "P0 sensor real"
    priority: P0
    area: HW
    state: READY_PARTIAL
    cloud_capable: false
    needs_windows: true
    missing: "-"
  - id: d-p1-independent
    title: "P1 contrato offline"
    priority: P1
    area: MATRIX
    state: READY_PARTIAL
    cloud_capable: true
    needs_windows: false
    missing: "-"
  - id: done-one
    title: "concluida"
    priority: P0
    area: X
    state: DONE_AUTOMATED
    cloud_capable: true
    needs_windows: false
    missing: "-"
`;

const tasks = parseBacklog(YAML);
const NOEXCL = { inProgress: new Set(), blocked: new Set() };

test('A — escolhe P0 cloud-capavel por prioridade', () => {
  const pick = pickNext(tasks, NOEXCL);
  assert.equal(pick.id, 'a-p0-code');
});

test('B — bloqueada fica de fora e a selecao avanca sem repetir', () => {
  const excl = stateExclusions('IN_PROGRESS: a-p0-code\nBLOCKED: b-p0-blocked');
  const pick = pickNext(tasks, excl);
  assert.equal(pick.id, 'd-p1-independent', 'deve saltar para a independente seguinte');
  const pick2 = pickNext(tasks, excl);
  assert.equal(pick2.id, pick.id, 'deterministica — nao repete nem inventa');
});

test('C — windows-only NUNCA e escolhida na cloud', () => {
  const pick = pickNext(tasks, NOEXCL);
  assert.notEqual(pick.id, 'c-p0-windows');
  const only = pickNext(tasks.filter((t) => t.id === 'c-p0-windows'), NOEXCL);
  assert.equal(only, null);
});

test('D — DONE nunca regressa a elegibilidade; sem elegiveis = null', () => {
  assert.equal(pickNext(tasks.filter((t) => t.id === 'done-one'), NOEXCL), null);
  const everything = stateExclusions('IN_PROGRESS: a-p0-code\nBLOCKED: b-p0-blocked\nBLOCKED_CLOUD: d-p1-independent');
  assert.equal(pickNext(tasks, everything), null);
});

test('parser nao engole campos errados: priority null', () => {
  const noPrio = parseBacklog('tasks:\n  - id: x\n    title: "t"\n    priority: null\n    state: READY_PARTIAL\n    cloud_capable: true\n');
  assert.equal(noPrio[0].priority, null);
  assert.equal(pickNext(noPrio, NOEXCL).id, 'x');
});
