import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { stdout } = await exec('/usr/bin/cybersafe-nigor-status', [], { timeout: 7000, maxBuffer: 65536 });
    console.log(formatPanel(JSON.parse(stdout)));
  } catch {
    console.error('Estado CyberSafe indisponível.');
    process.exitCode = 1;
  }
}
