# Architecture

[Português de Portugal](README.pt-PT.md) · [Technical reference](../ARCHITECTURE.md) (PT-PT)

CyberSafe is an npm workspace monorepo. The renderer presents results; Electron owns desktop integration and its preload bridge. The background service orchestrates scans, monitoring, engine health and quarantine. The local API handles account operations and its private routes.

| Boundary | Responsibility / contract |
|---|---|
| `packages/app` → desktop preload | React/TypeScript UI calls explicit IPC operations. Unavailable measurements remain unknown. |
| Electron → `packages/service` | Authenticated Windows named pipe or Linux Unix socket. Account login is separate from the service credential. |
| `packages/api` | Local HTTP API, accounts and SQLite-backed application data. Verify route authentication when adding endpoints. |
| Service → engines | ClamAV, classic YARA, HashDB and native C++ contribute distinct verdicts and failure/coverage information. |
| Data | SQLite, scan history, events and quarantine metadata have lifecycle and migration requirements. Quarantine contents are sensitive. |
| Updates | Manifest trust, edition/client compatibility, package integrity and authorized installation are separate gates. |
| Nigor integration | Native components call the local CLI/C++ adapter. Nigor owns its desktop bar, notifications and OS policy. |

The [README diagram](../../README.md#architecture) shows these connections. Source on `main` and the pending [Linux/Nigor PR](https://github.com/MatrixChill/cybersafe-assistant/pull/5) have different platform coverage. Consult the exact release's source identity before attributing behavior to an installed package.

## Security and runtime boundaries

Preload and service contracts enforce operations independently of whether the UI is visible. A local panel without account login in Nigor still authenticates to the service. Private account API routes require their account session.

Windows installed updates depend on the Windows trust chain. Linux/Nigor v2 clients revalidate signed metadata and stage bytes in a protected privileged directory before pacman. Essential update checks do not require a CyberSafe account. System updates and the system's ClamAV definition management remain distribution responsibilities.

Linux monitoring observes after-write events. A user systemd unit can outlive the interface, but does not establish protection before user login. The lab prevention prototype is separate from the distributed capability.

[Engine reference](../engines.md) · [MATRIX data flows](../matrix.md) · [Update channels](../downloads.md#update-channels) · [Security policy](../../SECURITY.md)
