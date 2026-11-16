import {execFile} from "node:child_process";
import {existsSync} from "node:fs";

export type ClamavManagement =
  | {state: "none"}
  | {state: "managed"; unit: string}
  | {state: "unknown"};

const UNITS = ["clamav-freshclam-once.timer", "clamav-freshclam.service", "freshclam.service"] as const;

/** Read-only, bounded probes. No start/stop/enable, configuration or DB writes. */
export async function probeClamavManagement(
  platform: NodeJS.Platform = process.platform,
  systemdPresent = existsSync("/run/systemd/system"),
  run: typeof execFile = execFile,
): Promise<ClamavManagement> {
  if (platform !== "linux" || !systemdPresent) return {state: "none"};
  const states = await Promise.all(UNITS.map(unit => new Promise<ClamavManagement>(resolve => {
    run("/usr/bin/systemctl", ["show", unit, "--property=LoadState,ActiveState,UnitFileState", "--no-pager"],
      {timeout: 2_000, maxBuffer: 8_192, env: {PATH: "/usr/bin", LC_ALL: "C"}}, (error, stdout) => {
        const values = Object.fromEntries(String(stdout).trim().split("\n").map(line => line.split("=", 2)));
        if (values.LoadState === "not-found") return resolve({state: "none"});
        if (error || values.LoadState !== "loaded" || !values.ActiveState || !values.UnitFileState) return resolve({state: "unknown"});
        const running = ["active", "activating", "reloading", "deactivating"].includes(values.ActiveState);
        const scheduled = ["enabled", "enabled-runtime", "linked", "linked-runtime"].includes(values.UnitFileState);
        resolve(running || scheduled ? {state: "managed", unit} : {state: "none"});
      });
  })));
  return states.find(state => state.state === "managed") ?? states.find(state => state.state === "unknown") ?? {state: "none"};
}
