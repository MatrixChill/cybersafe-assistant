# Contributing to CyberSafe Assistant

Thank you for helping make CyberSafe easier to understand and evaluate. Issues and pull requests may be written in **English or Portuguese (Portugal)**.

## Start small

- Report a reproducible bug using the [bug form](https://github.com/MatrixChill/cybersafe-assistant/issues/new?template=bug-report.yml).
- Suggest an improvement using the [feature form](https://github.com/MatrixChill/cybersafe-assistant/issues/new?template=feature-request.yml).
- Review documentation, translations, accessibility or a version-labelled screenshot.
- Check existing issues and the [roadmap](docs/roadmap-public.md) before proposing a new area of work.

**Licensing is pending clarification.** Read [the licensing status](docs/licensing.md) before submitting substantial code or assuming redistribution rights. No CLA, license grant or replacement license is introduced here. Discuss the applicable terms with the owner first.

## Reproduce safely

Use disposable benign files and an isolated development profile. Do not scan another person's files, terminate personal/Windows processes, change Windows protections or test installation over personal data as part of a routine contribution. Never attach malware, quarantine contents, databases, credentials or unredacted diagnostic logs.

For a suspected vulnerability, follow [SECURITY.md](SECURITY.md), not a public bug report.

## Pull requests

1. Start a focused branch from current `main`; preserve unrelated work.
2. Describe the user-visible problem and evidence. Separate observed results from hypotheses.
3. Follow the [development guide](docs/development.md); run focused checks relevant to your changes. Document skipped or environment-dependent tests.
4. For documentation, verify relative links, image provenance, version labels and consistency with current code. For behavior changes, include a regression test where practical.
5. Review the diff for secrets, private paths, generated artifacts and unintended changes. Use `git diff --check`.
6. Open a pull request with a clear scope and validation results. Wait for review; passing CI is not authorization to merge or publish.

Do not weaken verdicts or safety gates to make tests pass. Changes to signing, packaging, trust, installation and security-sensitive IPC need explicit review. Freeze approvals belong to exact source inventories and cannot be reused for changed trees.

AI-assisted work must be reviewed by its submitter. Do not invent evidence, participants, benchmarks or sources; disclose material tool assistance in the PR so the maintainer can assess it.

## Community

Follow the [Code of Conduct](CODE_OF_CONDUCT.md). This academic project has no promised support SLA. Helpful reports include the product version, platform, minimal steps and redacted results, without requiring personal identifiers.
