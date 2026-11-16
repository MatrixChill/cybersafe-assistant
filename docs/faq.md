# Frequently asked questions

[Português de Portugal](faq.pt-PT.md) · [Downloads](downloads.md)

## Which edition should I download?

Windows v0.2.4 is stable for Windows 10/11 x64. Arch Preview 3 is experimental and uses account-based desktop entry. Nigor Preview 1 ships a dedicated package with a local panel and optional login. Use the [download index](downloads.md) and its exact package names.

## Does Stable mean certified antivirus protection?

Stable identifies the distribution channel. CyberSafe has no complete-coverage or antivirus-certification claim. Keep platform protections enabled. An Active engine or a successful benign scan does not prove full detection.

## Why does Windows show an unknown publisher?

The Setup lacks Authenticode. A signed update manifest does not supply Windows publisher trust. Keep Windows protections active and retain any blocked-execution warning. See [installation](installation.md).

## Is CyberSafe MIT-licensed?

Original code uses the approved root [MIT license](../LICENSE). Third-party dependencies, rules, data and assets retain their terms. [Licensing and provenance](licensing.md) explains the distinction.

## Why can ClamAV be slow or degraded?

Definition loading, queue waits, scan execution and process lifecycle have separate costs. Persistent Linux clamd can reduce repeated startup cost and uses substantial resident memory. It is optional. Report edition, workload, timings and redacted error reasons.

## Does inconclusive mean safe?

Incomplete analysis remains inconclusive. Inspect unavailable engines, file access, timeouts and archive limits before interpreting a result.

## Is MATRIX always online?

Local diagnosis and optional provider requests have different origins. Online operation needs configuration, credentials and consent. Confirm the origin shown and the information sent for that request.

## Why can Nigor open without a CyberSafe account?

The dedicated edition exposes local functions without account login while preserving authenticated service access and private account API routes. Remembered login needs a supported unlocked keyring. Temporary login stays in memory. [Nigor guide](nigor-os/README.md).

## Are installed automatic updates demonstrated?

Windows installation remains manual. Linux/Nigor have signed manifests, protected staging and consented helpers, with lab transactions documented in their release evidence. Full graphical polkit and installed public-feed acceptance remain explicit gates. [Channels](downloads.md#update-channels).

## How should I report a problem?

Use minimal benign reproduction, edition/version and redacted diagnostics. Never attach malware, credentials, private databases or quarantine contents. Follow [support](support.md) for ordinary bugs and [SECURITY](../SECURITY.md) for vulnerabilities.
