# Contributing to CyberSafe Assistant

[Português de Portugal](CONTRIBUTING.pt-PT.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

Issues and pull requests may be written in English or Portuguese. Code, documentation, translations, accessibility reviews and reproducible tests are welcome.

## Before you start

Check existing issues, [downloads](docs/downloads.md), the [roadmap](docs/roadmap-public.md) and the relevant platform guide. Windows work starts from `main`. Coordinate Linux/Nigor changes with [PR #5](https://github.com/MatrixChill/cybersafe-assistant/pull/5) and its existing branch to avoid duplicating development.

Original project code uses the [owner-approved MIT license](LICENSE). Third parties retain their own terms. Review [provenance](docs/licensing.md) before adding dependencies, rules, datasets or assets. No contributor license agreement is introduced here.

## Reproduce and report

Use the [bug form](https://github.com/MatrixChill/cybersafe-assistant/issues/new?template=bug-report.yml) for ordinary bugs or the [feature form](https://github.com/MatrixChill/cybersafe-assistant/issues/new?template=feature-request.yml) for a scoped proposal. Identify Windows, generic Arch or Nigor, product and package versions, environment and observed results.

Use disposable benign files and an isolated profile. Never attach credentials, private databases, quarantine contents or malware. Installation, process termination and privileged tests require an authorized disposable environment. Follow [SECURITY.md](SECURITY.md) before sharing vulnerability details.

## Pull requests

1. Preserve unrelated work and keep the change focused.
2. Describe the concrete problem and resulting behavior. Separate measurement from inference.
3. Follow the [development guide](docs/development.md), run relevant checks and record results, skips and pending manual acceptance.
4. Verify document links, translations, image provenance and version labels. Add behavioral regressions where needed.
5. Review for secrets, private paths, large generated files and unintended changes. Run `git diff --check`.
6. Open a PR for review. CI success does not authorize merge, freeze or publication.

Preserve verdicts, consent and security gates. Signing, trust, packaging and IPC changes require explicit review. Freeze approvals bind exact inventories and cannot be reused for changed trees. Review AI-assisted work and disclose material tool assistance in the PR.

This project has no guaranteed support SLA. See [support](docs/support.md) for safe diagnostic details.
