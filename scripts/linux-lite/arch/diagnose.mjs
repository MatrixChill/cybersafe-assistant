#!/usr/bin/node
// Diagnóstico de dependências do CyberSafe Linux (schemaVersion 1, aditivo).
//
// Não eleva privilégios, não altera o sistema e não lê bases do utilizador.
// Cada verificação devolve um estado (`ok`, `missing`, `warning`, `unknown`),
// uma frase curta e, quando há solução, o remédio exato. A instalação assistida
// (`--install <pacotes> --consent`) só existe numa sessão interativa: corre
// `pkexec pacman -S --needed …` sem shell, e o polkit pede a autorização.
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { probeFirewall } from './firewall.mjs';

/** Pacotes oficiais do Arch que a instalação assistida pode pedir. Lista fechada. */
export const INSTALLABLE = Object.freeze({ clamav: 'clamav', yara: 'yara', zenity: 'zenity' });

const pacmanHint = (pkg) => ({
  packages: [pkg],
  command: ['pkexec', 'pacman', '-S', '--needed', pkg],
  manual: `sudo pacman -S --needed ${pkg}`,
});

export function diagnose({ platform, uid, session, hasCommand, arch = 'x64', fsProbe = null }) {
  const result = {
    schemaVersion: 1,
    platform,
    session,
    launchable: platform === 'linux' && Number.isInteger(uid) && uid > 0
      && (session === 'wayland' || session === 'x11'),
    clamav: { commandsPresent: hasCommand('clamscan'), health: 'unknown' },
    yara: { commandsPresent: hasCommand('yara') && hasCommand('yarac'), health: 'unknown' },
  };
  if (fsProbe) result.checks = dependencyChecks({ platform, uid, session, hasCommand, arch, fsProbe });
  return result;
}

/**
 * Verificações independentes. `fsProbe` é injectável (testes):
 *   listDir(path) → string[] | null, exists(path) → boolean.
 */
export function dependencyChecks({ platform, uid, session, hasCommand, arch, fsProbe }) {
  const checks = [];
  const add = (id, status, message, remedy = null) => checks.push({ id, status, message, remedy });

  const supported = platform === 'linux' && arch === 'x64';
  add('architecture', supported ? 'ok' : 'missing',
    supported ? 'Linux x86_64 suportado.' : `Plataforma ${platform}/${arch} não suportada por este pacote (só Linux x86_64).`);

  const user = Number.isInteger(uid) && uid > 0;
  add('permissions', user ? 'ok' : 'missing',
    user ? 'Sessão de utilizador normal (sem root).' : 'Execute o CyberSafe como utilizador normal; nunca como root.');

  add('graphics', session ? 'ok' : 'warning',
    session ? `Sessão gráfica ${session} detetada.` : 'Sem DISPLAY/WAYLAND_DISPLAY: a aplicação gráfica não abre nesta sessão (o diagnóstico e o cliente funcionam).');

  const clamscan = hasCommand('clamscan');
  add('clamav', clamscan ? 'ok' : 'missing',
    clamscan ? 'ClamAV instalado (clamscan).' : 'ClamAV não instalado.', clamscan ? null : pacmanHint('clamav'));

  const freshclam = hasCommand('freshclam');
  const dbFiles = (fsProbe.listDir('/var/lib/clamav') ?? []).filter((n) => /\.(cvd|cld|cud)$/i.test(n));
  const hasMain = dbFiles.some((n) => /^main\./i.test(n));
  const hasDaily = dbFiles.some((n) => /^daily\./i.test(n));
  if (!clamscan) {
    add('clamav-database', 'unknown', 'Sem ClamAV não há bases a verificar.');
  } else if (hasMain && hasDaily) {
    add('clamav-database', 'ok', 'Bases oficiais ClamAV presentes (main e daily).');
  } else {
    const missing = [hasMain ? null : 'main', hasDaily ? null : 'daily'].filter(Boolean).join(' e ');
    add('clamav-database', 'missing', `ClamAV instalado, mas faltam bases oficiais (${missing}).`,
      freshclam ? { packages: [], command: ['pkexec', 'freshclam'], manual: 'sudo freshclam' } : pacmanHint('clamav'));
  }

  const yara = hasCommand('yara') && hasCommand('yarac');
  add('yara', yara ? 'ok' : 'missing', yara ? 'YARA instalado (yara e yarac).' : 'YARA não instalado.', yara ? null : pacmanHint('yara'));

  // Regras YARA do perfil do utilizador nunca são lidas aqui (privadas);
  // só se confirma que o corpus do pacote existe.
  const bundled = fsProbe.exists('/opt/cybersafe-assistant-linux-lite/resources/definitions/yara/default.yar');
  add('yara-rules', bundled ? 'ok' : 'unknown',
    bundled ? 'Corpus YARA do pacote presente. Regras do utilizador não são lidas pelo diagnóstico.' : 'Corpus YARA do pacote não encontrado neste caminho; o serviço reporta o estado real.');

  const unit = fsProbe.exists('/usr/lib/systemd/user/cybersafe-linux.service');
  add('systemd-user-service', unit ? 'ok' : 'warning',
    unit ? 'Unidade de utilizador cybersafe-linux.service instalada (opcional; o pacote não a ativa).' : 'Unidade de utilizador não encontrada; a aplicação inicia o serviço por si.');

  const zenity = hasCommand('zenity');
  add('zenity', zenity ? 'ok' : 'warning', zenity ? 'Zenity disponível para o painel rápido.' : 'Zenity ausente: o painel rápido gráfico não abre (opcional).', zenity ? null : pacmanHint('zenity'));

  return checks;
}

function hasCommand(name) {
  return (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).some((directory) => {
    try {
      const file = join(directory, name);
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

const realFs = {
  listDir: (p) => { try { return readdirSync(p); } catch { return null; } },
  exists: (p) => { try { statSync(p); return true; } catch { return false; } },
};

/**
 * Instalação assistida. Recusa sem consentimento, sem sessão interativa, como
 * root, ou com pacotes fora da lista fechada. Nunca usa shell nem `--noconfirm`.
 */
export function assistedInstallPlan({ packages, consent, uid, interactive }) {
  if (consent !== true) return { ok: false, error: 'consent-required' };
  if (!Number.isInteger(uid) || uid === 0) return { ok: false, error: 'run-as-user' };
  if (!interactive) return { ok: false, error: 'interactive-session-required' };
  if (!Array.isArray(packages) || packages.length === 0) return { ok: false, error: 'no-packages' };
  const mapped = [];
  for (const p of packages) {
    if (!Object.hasOwn(INSTALLABLE, p)) return { ok: false, error: 'package-not-allowed', package: p };
    mapped.push(INSTALLABLE[p]);
  }
  return { ok: true, argv: ['pkexec', 'pacman', '-S', '--needed', ...new Set(mapped)] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args[0] === '--install') {
    const consent = args.includes('--consent');
    const packages = args.slice(1).filter((a) => a !== '--consent');
    const plan = assistedInstallPlan({ packages, consent, uid: process.getuid?.(),
      interactive: Boolean(process.stdin.isTTY || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) });
    if (!plan.ok) {
      console.log(JSON.stringify({ schemaVersion: 1, install: plan }));
      process.exitCode = 2;
    } else {
      const child = spawn('/usr/bin/pkexec', plan.argv.slice(1), {
        stdio: 'inherit',
        env: { PATH: '/usr/bin', HOME: homedir(), DISPLAY: process.env.DISPLAY ?? '', WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? '' },
      });
      child.once('error', () => { console.error('pkexec indisponível; use o comando manual indicado no diagnóstico.'); process.exitCode = 1; });
      child.once('exit', (code) => { process.exitCode = code ?? 1; });
    }
  } else {
    const session = process.env.WAYLAND_DISPLAY ? 'wayland' : process.env.DISPLAY ? 'x11' : null;
    const result = diagnose({
      platform: process.platform, uid: process.getuid?.(), session, hasCommand, arch: process.arch, fsProbe: realFs,
    });
    if (process.platform === 'linux') result.firewall = await probeFirewall();
    console.log(JSON.stringify(result));
  }
}
