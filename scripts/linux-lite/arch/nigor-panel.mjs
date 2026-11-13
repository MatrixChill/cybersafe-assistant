import { execFile, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { probeFirewall } from './firewall.mjs';

const exec = promisify(execFile);
const states = { active: 'ativo', degraded: 'degradado', unavailable: 'indisponível', error: 'erro' };
const scanStates = { completed: 'concluída', cancelled: 'cancelada', failed: 'falhou' };

function label(values, key) {
  return Object.hasOwn(values, key) ? values[key] : 'sem leitura';
}

export function formatPanel(snapshot) {
  if (snapshot.version !== 1) throw new Error('Versão de estado incompatível.');
  const { protection, engines, latestScan, alerts, metrics } = snapshot;
  const monitor = protection.enabled === true ? 'ativa' : protection.enabled === false ? 'desativada' : 'sem leitura';
  const metric = (number) => typeof number === 'number' ? number.toFixed(1).replace(/\.0$/, '') + '%' : 'sem leitura';
  const lines = [
    'Serviço: ' + (snapshot.serviceRunning ? 'em execução' : 'sem confirmação'),
    'Monitorização: ' + monitor,
    'ClamAV: ' + label(states, engines.clamav),
    'YARA: ' + label(states, engines.yara),
    'HashDB: ' + label(states, engines.hashDb),
    'Motor nativo: ' + label(states, engines.native),
    'CPU: ' + metric(metrics.cpuPercent),
    'RAM: ' + metric(metrics.ramPercent),
    'Última análise: ' + (latestScan ? label(scanStates, latestScan.status) : 'sem registo'),
  ];
  if (latestScan) {
    lines.push('Ficheiros analisados: ' + (latestScan.filesAnalyzed ?? 'sem leitura'));
    lines.push('Inconclusivos: ' + (latestScan.filesInconclusive ?? 'sem leitura'));
  }
  lines.push('Alertas na amostra recente: ' + alerts.length);
  return lines.join('\n');
}

async function readPanel() {
  const { stdout } = await exec('/usr/bin/cybersafe-nigor-status', [], { timeout: 7000, maxBuffer: 65536 });
  const firewall = await probeFirewall();
  const firewallLabels = {
    running: 'em execução', active: 'ativo', inactive: 'inativo',
    unavailable: 'indisponível', 'permission-denied': 'permissão insuficiente',
    'rules-present': 'regras presentes', 'no-rules-reported': 'sem regras reportadas',
    unknown: 'sem leitura',
  };
  return formatPanel(JSON.parse(stdout)) + '\n\n' + Object.entries(firewall)
    .map(([backend, state]) => 'Firewall (' + backend + '): ' + label(firewallLabels, state)).join('\n');
}

function showDialog(text) {
  return new Promise((resolve, reject) => {
    const dialog = spawn('/usr/bin/zenity', [
      '--text-info', '--title=CyberSafe Assistant', '--width=480', '--height=540',
      '--ok-label=Fechar', '--extra-button=Atualizar', '--extra-button=Abrir CyberSafe',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let selected = '';
    dialog.stdout.setEncoding('utf8');
    dialog.stdout.on('data', (chunk) => { selected += chunk; });
    dialog.stderr.resume();
    dialog.stdin.on('error', () => {});
    dialog.stdin.end(text);
    dialog.once('error', reject);
    dialog.once('exit', (code) => resolve(code === 0 ? selected.trim() : ''));
  });
}

export async function runPanel(args) {
  if (args.length === 0) {
    console.log(await readPanel());
    return;
  }
  if (args.length !== 1 || args[0] !== '--dialog') throw new Error('Argumentos inválidos.');
  while (true) {
    const selected = await showDialog(await readPanel());
    if (selected === 'Atualizar') continue;
    if (selected === 'Abrir CyberSafe') {
      const app = spawn('/usr/bin/cybersafe-assistant-linux-lite', [], { detached: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => {
        app.once('spawn', resolve);
        app.once('error', reject);
      });
      app.unref();
    }
    return;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPanel(process.argv.slice(2)).catch(() => {
    console.error('Estado CyberSafe indisponível. O modo gráfico requer Zenity.');
    process.exitCode = 1;
  });
}
