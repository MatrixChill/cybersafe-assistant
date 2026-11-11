# Public roadmap

Snapshot: **2026-11-11**, public Windows release **v0.2.4**. This is a status map, not a commitment to dates. Implemented does not mean certified or validated in every environment.

| Status | Area | Evidence / next boundary |
|---|---|---|
| Implemented | Multi-engine scans, history, PDF, quarantine and exclusions | [Service](../packages/service/src/engine.ts), [engine overview](engines.md). Preserve inconclusive states and per-engine limits. |
| Implemented | MATRIX local diagnosis with optional consented online provider | [MATRIX](matrix.md). Online availability is configuration/environment dependent. |
| Implemented | PC Center, protected individual process termination, tray and desktop shell | [Desktop](../packages/desktop/src), [app](../packages/app/src). Hardware metrics depend on sensors. |
| Implemented with limits | File/process monitoring and queue recovery | [Testing boundaries](security-and-testing.md). Watcher events do not prove full analysis. |
| Published; device validation pending | v0.2.4 ClamAV process-lifecycle recovery fix | [Release](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/v0.2.4), [PR #3](https://github.com/MatrixChill/cybersafe-assistant/pull/3). Recheck the affected notebook before claiming resolution there. |
| Implemented; hardware evidence pending | USB protection/analysis paths | Automated coverage does not establish a physical-device trial. |
| Implemented in components | GitHub update discovery, Ed25519, SHA-256 and secure handoff | [Updates](updates.md). Assisted installation disabled; installed A→B proof remains a separate gate. |
| Planned; external prerequisites | Legitimate Authenticode publisher/signing and installed update proof | Requires real publisher identity/certificate, approvals and an authorized test. No date promised. |
| Planned; owner decision | Clarify project license and contribution terms | [Licensing status](licensing.md). Do not advertise OSI licensing before it is established. |
| Planned; evidence work | Current-version screenshots/video and broader hardware validation | [Recording script](demo.md). No invented participants, metrics or captures. |
| Experimental / separately provisioned | Linux Lite and WFP integration | [Linux branch](https://github.com/MatrixChill/cybersafe-assistant/tree/experimental/linux-lite). No platform parity or kernel-level protection claim. |

## Scope boundaries

Replacing Microsoft Defender, claiming full malware coverage or presenting a user-mode monitor as a complete endpoint protection platform are outside the project's demonstrated scope. Rules and hash definitions need ongoing review; their existence is not proof of broad detection.

The [original October development roadmap](ROADMAP.md) is retained as historical evidence. Its old version numbers and pending items do not override the status above. Academic evidence remains in the [PAP index](../PAP-EVIDENCIAS-TECNICAS/README.md).

[Suggest a scoped improvement](../CONTRIBUTING.md) · [README](../README.md)
