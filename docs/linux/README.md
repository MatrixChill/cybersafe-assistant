# CyberSafe for Arch Linux

[Português de Portugal](README.pt-PT.md) · [All downloads](../downloads.md) · [Nigor OS](../nigor-os/README.md)

**Experimental Preview 3**, package `cybersafe-assistant-linux-lite-0.2.4-3-x86_64.pkg.tar.zst`. Use the [official release](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/linux-v0.2.4-arch-preview.3), including its checksums, source identity and third-party notices. This package requires Arch x86_64/glibc, pacman and the recipe's runtime dependencies. It is not a Debian/Ubuntu package.

## Install and start

1. Download the package and `SHA256SUMS.txt` from the same release. Compare the package's full SHA-256 with its entry using `sha256sum <package>`. To validate every entry with `sha256sum -c SHA256SUMS.txt`, download all listed files.
2. Finish scans, close the app normally and stop an independently enabled service with `systemctl --user stop cybersafe-linux.service`. Preserve a private cold backup of the actual data/profile locations and quarantine metadata.
3. Run `sudo pacman -U ./cybersafe-assistant-linux-lite-0.2.4-3-x86_64.pkg.tar.zst`. Read the transaction. Respect pacman's signature policy.
4. Run `cybersafe-linux-diagnose` and open CyberSafe from the application menu as your ordinary user. The generic edition uses the account form.
5. Check the version, actual engine states and a small benign scan with its history entry.

ClamAV, YARA, usable signature databases and optional desktop services must be present for their features. Follow the diagnostic output and the distribution's package guidance. Do not report absent engines as healthy.

## Service, account and updates

The optional user unit is `cybersafe-linux.service`. After first opening/closing the app to create its private service credential, `systemctl --user enable --now cybersafe-linux.service` starts the independent service. Check `systemctl --user status cybersafe-linux.service` and `journalctl --user -u cybersafe-linux.service`. A user service does not prove protection before user login.

Remembered account sessions need a supported, unlocked Secret Service/keyring. If it is unavailable, the form distinguishes persistence failure and offers an explicit temporary session. Passwords/tokens must not be persisted in plaintext. See the [session guide at the packaged source](https://github.com/MatrixChill/cybersafe-assistant/blob/32e627bbbeaee0b933e2ab505f674499e688c354/docs/nigor-handoff/SESSAO-LEMBRAR.md).

The legacy update feed stays at Preview 2 to protect old clients. Preview 3 installation is manual. New compatible clients use an edition-bound v2 contract; the generic v2 channel is not public at this review. [Channel status](../downloads.md#update-channels).

## Protection, evidence and recovery

ClamAV, classic YARA, HashDB and the native scanner have separate coverage. Monitoring is after-write detection. Privileged prevention is not enabled in this distribution. The lab evidence includes native scanning, local IPC and service tests; physical removable devices, desktop integration and broad malware coverage remain unproved.

If installation or startup fails, keep the pacman log and redacted diagnostics. Close the app/service before recovery. Preserve new data before restoring a cold backup, and recover databases and quarantine metadata together. Reinstalling an old binary alone is insufficient for a changed schema.

[Preview 3 source and evidence](https://github.com/MatrixChill/cybersafe-assistant/tree/32e627bbbeaee0b933e2ab505f674499e688c354/docs/nigor-handoff) · [Development](../development.md)
