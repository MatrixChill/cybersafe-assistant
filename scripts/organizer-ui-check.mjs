import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256 } from './_sha256.mjs';

const ROOT = resolve(process.cwd());
const ORG = resolve(ROOT, 'docs/cybersafe-organizador-pap-v2-editavel.html');
const BACKUP = resolve(ROOT, 'output/manual-retest/MINI-REESTRUTURACAO-20261014/backups/kilo/cybersafe-organizador-pap-v2-editavel.html');
const LOGDIR = resolve(ROOT, 'output/manual-retest/MINI-REESTRUTURACAO-20261014');
const LOG = resolve(LOGDIR, 'kilo-organizer-check.log');

let log = '';
function out(msg) { console.log(msg); log += msg + '\n'; }

function extractTasks(html) {
  const items = [];
  const idRe = /\{id:'([^']+)'/g;
  let m;
  while ((m = idRe.exec(html)) !== null) {
    const fullStart = m.index;
    const id = m[1];
    let i = m.index + m[0].length;
    const rest = html.slice(i);
    const labelMatch = rest.match(/,label:'([^']*)'/);
    const statusMatch = rest.match(/,status:'([^']*)'/);
    const label = labelMatch ? labelMatch[1] : '';
    const status = statusMatch ? statusMatch[1] : '';
    const noteMatch = rest.match(/,note:'([^']*)'/);
    const note = noteMatch ? noteMatch[1] : '';
    items.push({ id, label, status, note, at: fullStart });
  }
  return items;
}

function extractDefined(html, name) {
  const re = new RegExp(`(?:const|function)\\s+${name}\\s*(?:=|\\()`);
  return (html.match(re) || []).length;
}

const beforeHtml = readFileSync(BACKUP, 'utf8');
const afterHtml = readFileSync(ORG, 'utf8');

const beforeTasks = extractTasks(beforeHtml);
const afterTasks = extractTasks(afterHtml);

out('=== organizer-ui-check (Kilo) ===');
out(`SHA256 antes (backup): ${sha256(beforeHtml).slice(0,16)}…`);
out(`SHA256 depois: ${sha256(afterHtml).slice(0,16)}…`);
out(`Backup existe: ${beforeHtml.length > 0 ? 'SIM' : 'NAO'}`);
out(`Tarefas: antes=${beforeTasks.length} depois=${afterTasks.length}`);

let idsOk = true, statusOk = true;
if (beforeTasks.length !== afterTasks.length) { idsOk = false; out('FAIL: contagem de tarefas diferente'); }
for (let i = 0; i < Math.min(beforeTasks.length, afterTasks.length); i++) {
  if (beforeTasks[i].id !== afterTasks[i].id) { idsOk = false; out(`FAIL id: ${beforeTasks[i].id} != ${afterTasks[i].id}`); }
  if (beforeTasks[i].status !== afterTasks[i].status) { statusOk = false; out(`FAIL status: ${beforeTasks[i].id} ${beforeTasks[i].status} != ${afterTasks[i].status}`); }
  if (beforeTasks[i].label !== afterTasks[i].label) { idsOk = false; out(`FAIL label: ${beforeTasks[i].id}`); }
}
out(`Ids+labels conservados: ${idsOk ? 'PASS' : 'FAIL'}`);
out(`Status conservados: ${statusOk ? 'PASS' : 'FAIL'}`);

const detailsOpen = (afterHtml.match(/<details[^>]*\s+open/g) || []).length;
out(`Markup <details> sem open por defeito: ${detailsOpen === 0 ? 'PASS' : 'FAIL'} (open=${detailsOpen})`);
const detailsCount = (afterHtml.match(/<details/g) || []).length;
out(`<details> presente: ${detailsCount > 0 ? 'PASS' : 'FAIL'} (n=${detailsCount})`);
const sumCount = (afterHtml.match(/<summary/g) || []).length;
out(`<summary> presente: ${sumCount > 0 ? 'PASS' : 'FAIL'} (n=${sumCount})`);
const summaryTrunc = (afterHtml.match(/class="task-summary"/g) || []).length;
out(`task-summary truncado (<=140 runtime): ${summaryTrunc > 0 ? 'PASS' : 'FAIL'} (n=${summaryTrunc})`);

const hasExpand = (afterHtml.match(/getElementById\('expandAll'\)/g) || []).length;
const hasCollapse = (afterHtml.match(/getElementById\('collapseAll'\)/g) || []).length;
out(`Handler expandir global: ${hasExpand ? 'PASS' : 'FAIL'}`);
out(`Handler recolher global: ${hasCollapse ? 'PASS' : 'FAIL'}`);

out(`calcSection intacto: ${extractDefined(afterHtml, 'calcSection') === 1 ? 'PASS' : 'FAIL'}`);
out(`calcOverall intacto: ${extractDefined(afterHtml, 'calcOverall') === 1 ? 'PASS' : 'FAIL'}`);
out(`calcPap intacto: ${extractDefined(afterHtml, 'calcPap') === 1 ? 'PASS' : 'FAIL'}`);
out(`STORAGE_KEY intacto: ${extractDefined(afterHtml, 'STORAGE_KEY') === 1 ? 'PASS' : 'FAIL'}`);
out(`DATA_VERSION intacto: ${extractDefined(afterHtml, 'DATA_VERSION') === 1 ? 'PASS' : 'FAIL'}`);
out(`DATA_VERSION (backup): ${extractDefined(beforeHtml, 'DATA_VERSION') === 1 ? 'SIM' : 'NAO'}`);

const allData = beforeTasks.length === afterTasks.length && idsOk && statusOk
  && extractDefined(afterHtml, 'calcSection') === 1
  && extractDefined(afterHtml, 'calcOverall') === 1
  && extractDefined(afterHtml, 'calcPap') === 1
  && extractDefined(afterHtml, 'STORAGE_KEY') === 1
  && extractDefined(afterHtml, 'DATA_VERSION') === 1;
out(`\nINVARIANTES DADOS: ${allData ? 'PASS' : 'FAIL'}`);

const domOk = detailsOpen === 0 && detailsCount > 0 && sumCount > 0 && summaryTrunc > 0 && hasExpand && hasCollapse;
out(`DOM: ${domOk ? 'PASS' : 'FAIL'}`);

mkdirSync(LOGDIR, { recursive: true });
writeFileSync(LOG, log);
out(`\nLog: ${LOG}`);
process.exit(allData && domOk ? 0 : 1);
