#!/usr/bin/env node
// Gera docs/cloud-coding/BACKLOG.yaml a partir do espelho oficial do Organizador
// (docs/CYBERSAFE_ORGANIZADOR.md) — fonte de verdade sincronizada com o HTML
// (checker oficial: node output/pap-sprint/organizer-check.mjs). Os docs antigos
// com 242 NAO sao fonte; o total atual e 243.
// Uso: node scripts/cloud-gen-backlog.mjs [--out docs/cloud-coding/BACKLOG.yaml]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'docs', 'CYBERSAFE_ORGANIZADOR.md'), 'utf8');
const outArg = process.argv.indexOf('--out');
const outPath = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'docs', 'cloud-coding', 'BACKLOG.yaml');

// Regex espelha o checker oficial (output/pap-sprint/organizer-check.mjs):
// emoji arbitrario com flag u + id entre backticks + resto. A classe minha de
// emojis anterior perdia tarefas (155 de 243).
// Heuristica declarada de Windows-only (reavaliada por humanos/agentes por tarefa):
const WINDOWS_ONLY = /defender|toast|notifica[çc][õo]es windows|hotplug|NTFS|ACL|titlebar no SO|BIOS|UEFI|Secure Boot|TPM|HWiNFO|SMART|sensores reais|instalador NSIS|arranque real|pen f[ií]sica|hardware real/i;
const MD_ITEM_RE = /^-\s+(\S+)\s+`([^`]+)`\s+—\s*([\s\S]*)$/u;
const tasks = [];
let section = '';
for (const line of src.split(/\r?\n/)) {
  const h = line.match(/^##\s+(.+?)\s*$/);
  if (h) { section = h[1].trim(); continue; }
  if (!/^-\s+/.test(line)) continue;
  const m = line.match(MD_ITEM_RE);
  if (!m) continue;
  const [, emoji, id, restRaw] = m;
  const noteM = restRaw.match(/\s+—\s+_([\s\S]*)_\s*$/);
  const note = noteM ? noteM[1].trim() : '';
  const title = (noteM ? restRaw.slice(0, noteM.index) : restRaw).trim();
  const state = emoji === '✅' ? 'DONE_AUTOMATED' : emoji === '🟡' ? 'NEEDS_HUMAN_VALIDATION' : emoji === '⚠️' ? 'READY_PARTIAL' : emoji === '⛔' ? 'NEEDS_WINDOWS_VALIDATION' : emoji === '📋' ? 'READY_NEW' : emoji === '🔴' ? 'BLOCKED' : 'READY_PARTIAL';
  const prio = (title.match(/\b(P\d[-A-Z]*)\b/) || [])[1] || null;
  tasks.push({
    id,
    title: title.trim(),
    priority: prio,
    organizer_state: emoji,
    state,
    cloud_capable: !WINDOWS_ONLY.test(`${title} ${note}`),
    needs_windows: WINDOWS_ONLY.test(`${title} ${note}`),
    area: section,
    missing: note.slice(0, 400),
    files_owner_hint: 'ver docs/cloud-coding/CURRENT-STATE.md antes de tocar',
  });
}

const counts = {};
for (const t of tasks) counts[t.state] = (counts[t.state] || 0) + 1;

const y = [
  '# BACKLOG.yaml — gerado de docs/CYBERSAFE_ORGANIZADOR.md (243 tarefas; checker 243/243 IN_SYNC).',
  '# NAO editar a mao: regenerar com `node scripts/cloud-gen-backlog.mjs`. Estados do autopilot:',
  '# READY|IN_PROGRESS|BLOCKED|BLOCKED_CLOUD|NEEDS_WINDOWS_VALIDATION|NEEDS_HUMAN_VALIDATION|DONE_AUTOMATED|DONE_VERIFIED',
  '# O campo `state` espelha o Organizador; o autopilot so escolhe READY*/NEEDS_* com cloud_capable=true e sem conflito em CURRENT-STATE.',
  `meta:`,
  `  generated_at: ${new Date().toISOString().slice(0, 10)}`,
  `  source: docs/CYBERSAFE_ORGANIZADOR.md`,
  `  tasks_total: ${tasks.length}`,
  `  by_state: ${JSON.stringify(counts)}`,
  `  truth_rule: 'HTML e espelho valem mais que este yaml; yaml e derivado'`,
  'tasks:',
  ...tasks.map((t) => [
    `  - id: ${t.id}`,
    `    title: ${JSON.stringify(t.title)}`,
    `    priority: ${t.priority ?? 'null'}`,
    `    area: ${JSON.stringify(t.area)}`,
    `    state: ${t.state}`,
    `    cloud_capable: ${t.cloud_capable}`,
    `    needs_windows: ${t.needs_windows}`,
    `    missing: ${JSON.stringify(t.missing)}`,
  ].join('\n')),
].join('\n') + '\n';

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, y);
console.log(`BACKLOG.yaml: ${tasks.length} tarefas (${JSON.stringify(counts)}) -> ${path.relative(root, outPath)}`);
