import { execFile } from 'node:child_process';

function classify(result, parse) {
  if (result.missing) return 'unavailable';
  if (/permission denied|operation not permitted|need to be root|access denied/i.test(result.stderr ?? '')) {
    return 'permission-denied';
  }
  return parse(result) ?? 'unknown';
}

export async function firewallStatus(run) {
  const [firewalld, ufw, nftables] = await Promise.all([
    run('firewall-cmd', ['--state']),
    run('ufw', ['status']),
    run('nft', ['-j', 'list', 'ruleset']),
  ]);
  return {
    firewalld: classify(firewalld, ({ code, stdout }) =>
      code === 0 && stdout?.trim() === 'running' ? 'running' : undefined),
    ufw: classify(ufw, ({ code, stdout }) =>
      code === 0 ? /^Status: (active|inactive)\s*$/m.exec(stdout ?? '')?.[1] : undefined),
    nftables: classify(nftables, ({ code, stdout }) => {
      if (code !== 0) return;
      try {
        const { nftables: entries } = JSON.parse(stdout);
        if (!Array.isArray(entries)) return;
        return entries.some((item) => item && Object.hasOwn(item, 'rule')) ? 'rules-present' : 'no-rules-reported';
      } catch { return; }
    }),
  };
}

export function probeFirewall() {
  return firewallStatus((command, args) => new Promise((resolve) => {
    execFile('/usr/bin/' + command, args, {
      timeout: 2000, maxBuffer: 256 * 1024, env: { PATH: '/usr/bin', LC_ALL: 'C' },
    }, (error, stdout, stderr) => resolve({
      missing: error?.code === 'ENOENT', code: error ? error.code : 0, stdout, stderr,
    }));
  }));
}
