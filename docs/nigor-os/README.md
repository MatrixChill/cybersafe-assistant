# CyberSafe Nigor OS Edition

[Português de Portugal](README.pt-PT.md) · [Downloads](../downloads.md) · [Generic Arch](../linux/README.md)

**Experimental Preview 1** ships `cybersafe-assistant-nigor-0.2.4-2-x86_64.pkg.tar.zst`. [Download the Nigor release](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/nigor-v0.2.4-preview.1). Nigor OS is a separately developed Arch-based operating system. CyberSafe provides the security app, engines, user service and integration client.

## Edition behavior

- Opens the local panel without a CyberSafe account. Account login remains optional.
- Retains authenticated Unix-socket service access and account authentication on private API routes.
- Uses its own installed marker, package identity and signed v2 update channel.
- Provides `cybersafe-nigor-status`, compatible JSON, a C++20 adapter, a reference Security Center and `cybersafe-nigor-update`.
- Shares engines, scan history and quarantine mechanisms with the Linux edition. Nigor retains its bar, native notifications, desktop, system management and firewall integration.

## Install or migrate from generic Arch

Require Arch x86_64/glibc and the declared dependencies. The reference interface uses X11/Xft. Keep a terminal and polkit agent available for interactive installation requests. Remembered sessions additionally need a supported unlocked Secret Service in the same session D-Bus.

1. Obtain the Nigor package, `SHA256SUMS.txt`, source identity and notices from the same release. Verify the package's SHA-256 against its entry.
2. Complete scans, exit normally, and stop the independent unit if active with `systemctl --user stop cybersafe-linux.service`.
3. Preserve a verified private cold backup of the actual data and profile, normally `~/.cybersafe-linux-lite` and `~/.config/cybersafe-assistant-linux-lite`. Keep quarantine and its metadata isolated.
4. Run `sudo pacman -U ./cybersafe-assistant-nigor-0.2.4-2-x86_64.pkg.tar.zst`. The generic package conflicts with Nigor. Confirm its removal only after reviewing the transaction.
5. Run `pacman -Q cybersafe-assistant-nigor`, `pacman -Qkk cybersafe-assistant-nigor` and `systemctl --user daemon-reload`. Open the app, inspect `cybersafe-linux-diagnose` and confirm history and engine state. Restart the independent service if previously used.

The command/profile names are retained for migration compatibility. The two editions should not run alongside each other against the same service and data. Assisted updates stay within the installed edition.

## Integration and updates

Call the existing CLI/C++ adapter from the Nigor panel. The package includes integration material under `/usr/share/cybersafe-assistant-linux-lite/nigor-integration/` and `cybersafe-nigor-center-reference`. Source contracts are available at the [exact packaged commit](https://github.com/MatrixChill/cybersafe-assistant/tree/b1f38b134623c7b36273526f1050078a2c07cb36/integrations/nigor).

`cybersafe-nigor-update check` queries the edition's manifest without an account. Download verifies signature, size and SHA-256. Installing requires consent, polkit, private verified staging and pacman's normal checks. [Channel status](../downloads.md#update-channels).

## Evidence and remaining acceptance

The release records Arch/WSL2 builds, Xvfb local entry without login, anonymous private-route refusal, Preview 3 migration with unchanged SQLite, benign scans and helper/pacman lab transactions. The graphical polkit path, Nigor keyring after session restart, native bar/notifications, physical USB and Nigor hardware performance remain **not tested** in that release.

Protection is after-write detection. Persistent clamd is optional and memory-intensive. Do not infer prevention or full coverage from engine status.

For rollback, stop the app/service, preserve a private copy of new data and retain the earlier verified package. Check package state and logs before restoring the matched cold backup. See [support](../support.md) and the [integration/evidence handoff](https://github.com/MatrixChill/cybersafe-assistant/blob/a8bbeb0d9a5be89640d3afbfe5c3cb4de0f649bd/docs/nigor-handoff/README.md).
