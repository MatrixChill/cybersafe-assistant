#!/usr/bin/env bash
# Run only in a disposable Arch test installation and a fresh user profile.
set -euo pipefail
if [[ $EUID == 0 || ${1:-} != --disposable-profile ]]; then
  echo 'Use a disposable unprivileged Arch account with --disposable-profile.' >&2
  exit 2
fi
profile="${XDG_CONFIG_HOME:-$HOME/.config}/cybersafe-assistant-linux-lite"
if [[ -e "$profile" || -L "$profile" || -e "$HOME/.cybersafe-linux-lite" || -L "$HOME/.cybersafe-linux-lite" ]]; then
  echo 'The test requires a fresh CyberSafe profile.' >&2
  exit 2
fi
install -d -m 700 "$profile/secrets"
(umask 077; node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))' > "$profile/secrets/pipe-credential")

systemctl --user daemon-reload
systemctl --user start cybersafe-linux.service
trap 'systemctl --user stop cybersafe-linux.service' EXIT
cybersafe-nigor-status | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const status = JSON.parse(input);
  if (status.version !== 1 || !status.serviceRunning || status.engines.native !== "active") process.exit(1);
  console.log("Authenticated service and native engine: PASS");
});'
cybersafe-nigor-panel
systemctl --user stop cybersafe-linux.service
if systemctl --user is-active --quiet cybersafe-linux.service; then
  echo 'Service is still active after stopping.' >&2
  exit 1
fi
trap - EXIT
echo 'systemd stop: PASS'
