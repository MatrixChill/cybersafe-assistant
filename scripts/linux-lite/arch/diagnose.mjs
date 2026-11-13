#!/usr/bin/node
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function diagnose({ platform, uid, session, hasCommand }) {
  return {
    schemaVersion: 1,
    platform,
    session,
    launchable: platform === 'linux' && Number.isInteger(uid) && uid > 0
      && (session === 'wayland' || session === 'x11'),
    clamav: { commandsPresent: hasCommand('clamscan'), health: 'unknown' },
    yara: { commandsPresent: hasCommand('yara') && hasCommand('yarac'), health: 'unknown' },
  };
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const session = process.env.WAYLAND_DISPLAY ? 'wayland' : process.env.DISPLAY ? 'x11' : null;
  console.log(JSON.stringify(diagnose({
    platform: process.platform, uid: process.getuid?.(), session, hasCommand,
  })));
}
