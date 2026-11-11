# Security reporting and product limits

CyberSafe is an academic Windows security application, not a certified antivirus replacement. Keep Microsoft Defender and other Windows protections enabled.

## Versions and support

The current public release at this review is **v0.2.4**. Use the [latest release](https://github.com/MatrixChill/cybersafe-assistant/releases/latest) and identify the exact version when reporting a problem. Historical releases remain for traceability; no long-term support or guaranteed response time is promised for any version.

## Report a suspected vulnerability

Private vulnerability reporting was **disabled** when checked on 2026-11-11. Do not assume that a public issue or advisory-creation URL is confidential.

If GitHub shows a private **Report a vulnerability** option on the repository's Security page, use it and confirm that the report is private before submitting. Otherwise, open only a minimal, non-sensitive issue asking the owner for a private reporting channel, or use a private contact method the owner has explicitly provided. Wait for that channel before sharing an exploit, affected private data or sensitive logs. No security email address has been designated here.

After a private channel is agreed, useful details include affected version, platform, impact, safe reproduction steps and a minimal redacted example. Do not include API keys, passwords, SQLite dumps, quarantine contents or live malware. Do not test on other people's systems without permission. Coordinate disclosure with the owner; there is no bug bounty or response SLA promised.

## Known boundaries

- Watcher observation is not proof that an artifact reached all engines or that coverage is complete.
- ClamAV timeouts, rule/hash coverage limits and inaccessible files can produce degraded or inconclusive states.
- WFP depends on its separately provisioned component; it is not a declaration of Windows firewall status.
- MATRIX online requests require provider configuration and consent. Local responses do not prove an external-provider response.
- Release manifests use Ed25519 and bind download integrity to SHA-256. Windows installers currently lack Authenticode; assisted update installation remains disabled.
- A build, a unit test or a handoff fixture does not establish installed end-to-end protection or update success.

See [testing evidence and limitations](docs/security-and-testing.md), [updates](docs/updates.md), [licensing status](docs/licensing.md) and [the public roadmap](docs/roadmap-public.md).
