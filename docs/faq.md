# Frequently asked questions

## Is CyberSafe a replacement for Microsoft Defender?

No. It is an academic Windows desktop security and diagnostics project. Keep Windows protections enabled. An engine reporting Active is not a certificate of complete coverage.

## Which version and platform should I use?

Use the [latest official Windows release](https://github.com/MatrixChill/cybersafe-assistant/releases/latest), currently v0.2.4 at this review, on Windows 10/11 x64. Linux Lite is experimental on a separate branch, with no Windows feature-parity promise.

## Why does Windows show an unknown publisher?

The Setup lacks Authenticode. The Ed25519 manifest verifies update metadata; it does not replace a Windows code-signing certificate. If Windows blocks execution, stop and retain the warning. See [installation](installation.md).

## Is the license MIT?

The npm metadata says MIT, but there is no approved root license text. Do not infer project-wide permissions from that mismatch. The owner needs to resolve [licensing](licensing.md); third-party notices retain their own terms.

## Does an inconclusive scan mean a file is safe?

No. An unavailable engine, timeout, limit or inaccessible file can leave analysis incomplete. Review the reason and engine results. Do not turn an unknown into a clean verdict.

## Why can ClamAV be slow or degraded?

Database loading, queue contention, process lifecycle and analysis itself have separate costs. The v0.2.4 lifecycle fix is published, but validation on the affected notebook remains pending in [PR #3](https://github.com/MatrixChill/cybersafe-assistant/pull/3). Report version, workload, timing and redacted errors; do not assume file count alone explains latency.

## Is MATRIX always an online AI response?

No. Local diagnosis is a separate path. Online use requires provider configuration, a secure credential and consent. The presence of a chat response does not prove that a remote provider answered.

## Does CyberSafe send all my files to an AI service?

Do not infer a blanket cloud scan from MATRIX. Its local path and optional online provider have different data flows. Review the consent shown for the action and [MATRIX documentation](matrix.md) (PT-PT); never include credentials or private process/file data in a public report.

## Are automatic updates ready?

Discovery, Ed25519 verification and download integrity are implemented. Assisted installation remains disabled without legitimate Authenticode. Do not describe a handoff fixture as an installed end-to-end update. See [updates](updates.md) (PT-PT).

## Can I send a database or malicious file with a bug report?

No. Use minimal benign reproduction steps and redacted logs. Never attach credentials, quarantine contents or personal databases. See [SECURITY](../SECURITY.md) for vulnerabilities and [CONTRIBUTING](../CONTRIBUTING.md) for ordinary bugs.

## How do I help?

Review documentation, report a reproducible problem or discuss a scoped improvement. English and Portuguese are welcome. Clarify contribution terms before substantial code submissions. No stars, payments or personal identifiers are required for a report.
