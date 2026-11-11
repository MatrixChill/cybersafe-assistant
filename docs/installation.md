# Install and update on Windows

[Português de Portugal](installation.pt-PT.md) · [README](../README.md)

## Requirements and download

Target platform: **Windows 10/11 x64**. Leave space for the installer, extracted payload, signature databases and your data backups. No tested minimum memory, CPU or storage threshold is advertised. Sensor availability and performance depend on the device.

Use the Setup, `SHA256SUMS.txt` and `update-manifest.json` from the same [official GitHub release](https://github.com/MatrixChill/cybersafe-assistant/releases/latest). The current release reviewed for these docs is v0.2.4. Historical internal candidates and Linux Lite builds are not interchangeable Windows installers.

1. Calculate the downloaded Setup's SHA-256:

   ```powershell
   Get-FileHash -Algorithm SHA256 -LiteralPath "<downloaded-setup>.exe"
   ```

2. Compare the full value with the matching filename in `SHA256SUMS.txt`. If it differs, **stop**. A checksum match establishes integrity relative to that published value, not an independent malware safety certification.
3. Before updating an existing installation, finish scans, exit CyberSafe normally and make a separate backup of persistent data: accounts, preferences, history, SQLite databases and quarantine metadata/contents. Preserve quarantine in isolation; never restore its files merely to test. Do not copy live SQLite databases and assume consistency.
4. Preserve the old verified Setup and record the version and data locations before changing anything. Do not post those private paths or backups in issues.
5. Open the official verified Setup if Windows policy permits; review its destination and options. After completion, open CyberSafe and check version, session, history and engine status.

## Windows warnings

The Setup currently has **no Authenticode signature** and may show an unknown publisher. An Ed25519-signed update manifest is a different mechanism and does not create Windows publisher trust. Do not disable Defender, SmartScreen, UAC or the firewall. If Windows blocks execution, retain the warning and stop; this guide does not provide a bypass.

## Updates and recovery

Discovery and manifest/download verification are implemented; assisted installation remains disabled while legitimate Authenticode is unavailable. Use the published manual installation path. Component and handoff tests do not prove an installed A→B update. See [updates](updates.md) (PT-PT).

If installation or startup fails, preserve the logs and any new data, avoid repeated attempts, and report the product version, error stage and redacted message. Reinstalling an older executable alone may not roll back a changed database schema. Recovery needs the matching cold data backup as well as the previous installer; agree the recovery procedure before restoring anything.

For removal, use Windows Settings → Apps and the installed official uninstaller. Preserve needed data first and read the options; do not manually delete an arbitrary installation directory. No uninstall or recovery operation is performed by this documentation update.

[FAQ](faq.md) · [Report a problem](../CONTRIBUTING.md)
