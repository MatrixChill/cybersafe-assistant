# Security reporting and product limits

CyberSafe provides file analysis and diagnostics on Windows, with experimental Arch and Nigor editions. No edition claims certified or complete antivirus coverage. Keep the platform's protections enabled.

## Versions and support

The [download index](docs/downloads.md) distinguishes Windows Stable v0.2.4, Arch Preview 3 and Nigor OS Edition Preview 1 as checked on 2026-11-16. Identify both release and package revision in reports. Historical versions remain available for traceability. No long-term support, security response SLA or bug bounty is promised.

## Report a suspected vulnerability

Private vulnerability reporting was **disabled** when checked on **2026-11-16**. A public issue is visible to other people.

If GitHub shows a private **Report a vulnerability** option on the repository's Security page, confirm that it is private before submitting. Otherwise, open only a minimal, non-sensitive issue asking the owner for a private reporting channel, or use a private contact method the owner has explicitly provided. Wait for that channel before sharing exploit details, affected private data or sensitive logs. No security email address has been designated here.

After a private channel is agreed, include affected edition/version, impact, authorized safe reproduction and a minimal redacted example. Never attach credentials, private databases, quarantine contents or malware. Test only on systems for which you have permission.

## Known boundaries

- A watcher observation does not demonstrate that every engine analyzed an artifact. Queue pressure, inaccessible paths and timeouts affect coverage.
- Linux distributed monitoring detects after writes. Lab prevention work does not establish protection before execution in the shipped package.
- Linux user services do not prove protection before user login.
- YARA rules and known hashes have limited coverage. Active engines do not certify a clean system.
- WFP requires its separately provisioned Windows component and does not represent the state of the Windows firewall.
- MATRIX online requests require configuration and consent. A local explanation does not establish an external-provider response.
- Windows Setup lacks Authenticode. The stable installed updater remains limited to manual installation.
- Linux/Nigor v2 helpers revalidate signature, edition and protected staged bytes. Legacy clients require the documented manual migration. Full graphical polkit update acceptance remains separate from helper tests.
- Passing CI, a benign scan or a handoff fixture does not establish complete installed protection.

See [edition guides and channels](docs/downloads.md), [support](docs/support.md), [technical testing evidence](docs/security-and-testing.md) and [licensing](docs/licensing.md).
