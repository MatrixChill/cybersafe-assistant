#!/usr/bin/env node
// Autopilot: escolhe a proxima tarefa elegivel a partir de docs/cloud-coding/BACKLOG.yaml
// e das listas em docs/cloud-coding/CURRENT-STATE.md. Regras:
//  - elegiveis: READY_PARTIAL | READY_NEW (trabalho de codigo na cloud). NEEDS_HUMAN/*WINDOWS*
//    esperam pessoas, nao agentes — ficam FORA da seleccao.
//    com cloud_capable=true; prioridade P0 > P1 > P2 > sem-prioridade; depois ordem do backlog.
//  - excluidas: ids com linha "IN_PROGRESS: <id>" ou "BLOCKED: <id>" no CURRENT-STATE.
//  - nunca escolhe DONE_* nem NEEDS_WINDOWS_VALIDATION.
//  - com --state <ficheiro> aceita um CURRENT-STATE alternativo (para os testes A/B/C/D).
// Uso: node scripts/autopilot/next-task.mjs [--backlog docs/cloud-coding/BACKLOG.yaml] [--state docs/cloud-coding/CURRENT-STATE.md] [--explain]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? path.resolve(process.argv[i + 1]) : path.resolve(root, dflt);
};

export function parseBacklog(yaml) {
  const tasks = [];
  let cur = null;
  for (const line of yaml.split(/\r?\n/)) {
    const start = line.match(/^\s*-\s+id:\s+(\S+)/);
    if (start) { cur = { id: start[1] }; tasks.push(cur); continue; }
    if (!cur) continue;
    const kv = line.match(/^\s+(title|priority|area|state|cloud_capable|needs_windows|missing):\s+(.*)$/);
    if (!kv) continue;
    const [, k, rawV] = kv;
    if (k === 'priority') cur.priority = rawV === 'null' ? null : rawV;
    else if (k === 'cloud_capable' || k === 'needs_windows') cur[k] = rawV === 'true';
    else if (k === 'title' || k === 'missing') { try { cur[k] = JSON.parse(rawV); } catch { cur[k] = rawV; } }
    else cur[k] = rawV;
  }
  return tasks;
}

export function stateExclusions(md) {
  const excl = { inProgress: new Set(), blocked: new Set() };
  for (const m of md.matchAll(/IN_PROGRESS:\s*([a-z0-9-]+)/gi)) excl.inProgress.add(m[1]);
  for (const m of md.matchAll(/BLOCKED(?:_CLOUD)?:\s*([a-z0-9-]+)/gi)) excl.blocked.add(m[1]);
  return excl;
}

const PRIO_RANK = { P0: 0, 'P0-X': 0, P1: 1, 'P1-HW': 1, P2: 2 };

export function pickNext(tasks, excl) {
  const eligible = tasks.filter((t) =>
    (t.state === 'READY_PARTIAL' || t.state === 'READY_NEW') &&
    t.cloud_capable !== false && !excl.inProgress.has(t.id) && !excl.blocked.has(t.id),
  );
  eligible.sort((a, b) => {
    const pa = PRIO_RANK[a.priority] ?? 3, pb = PRIO_RANK[b.priority] ?? 3;
    return pa !== pb ? pa - pb : 0;
  });
  return eligible[0] ?? null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const backlog = parseBacklog(fs.readFileSync(arg('--backlog', 'docs/cloud-coding/BACKLOG.yaml'), 'utf8'));
  const excl = stateExclusions(fs.readFileSync(arg('--state', 'docs/cloud-coding/CURRENT-STATE.md'), 'utf8'));
  const pick = pickNext(backlog, excl);
  if (process.argv.includes('--explain')) console.log(`backlog=${backlog.length} inProgress=${[...excl.inProgress].join(',') || '-'} blocked=${[...excl.blocked].join(',') || '-'}`);
  if (!pick) { console.log('NAO_ELEGIVEL: nada cloud-capable pendente — atualizar CURRENT-STATE ou validar Windows.'); process.exit(0); }
  console.log(`PROXIMA: ${pick.id} [${pick.priority ?? 'sem-prio'}] ${pick.state} — ${pick.title}`);
  console.log(`  em falta: ${(pick.missing || '—').slice(0, 200)}`);
}
