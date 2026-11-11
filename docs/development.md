# Development guide

[Português de Portugal](development.pt-PT.md) · [Contributing](../CONTRIBUTING.md)

## Prerequisites

This is an npm workspace monorepo. The root declares Node.js >=20; the current [Windows CI](../.github/workflows/ci.yml) uses **Node.js 24**. Use that CI baseline when reproducing its results. Git, npm and the native toolchain/resources are needed; `npm ci` alone does not supply the antivirus databases or prove a distributable build.

Use the existing [Windows C++/CMake toolchain guide](TOOLCHAIN-CPP-WINDOWS.md) and [native engine instructions](../packages/native-engine/README.md). Review [licensing status](licensing.md) before substantial code contributions or redistribution.

```powershell
git clone https://github.com/MatrixChill/cybersafe-assistant.git
cd cybersafe-assistant
npm ci
npm run build:all
```

## Start an isolated development session

Before running `npm run dev`, read the [desktop isolation contract](../packages/desktop/src/dev-isolation.ts) and related [profile checks](../packages/desktop/test/dev-isolation-matrix.test.mjs). Confirm that the development profile, ports, pipes and data do not conflict with a personal installed instance. Do not change installed configuration or delete a personal database to resolve a DEV conflict.

```powershell
npm run dev
```

The renderer is React/TypeScript; Electron owns desktop integration; the local API and background service coordinate data and analysis. See [architecture](ARCHITECTURE.md) (PT-PT).

## Focused validation

Select the checks relevant to the change; report actual output and skipped prerequisites rather than describing every suite as installed validation.

```powershell
npm test -w @cybersafe/core
npm run test:full -w @cybersafe/service
npm test -w @cybersafe/app
npm test -w @cybersafe/desktop
npm run test:scripts
npm run test:native
```

Native/system tests can depend on Windows resources or opt-in prerequisites. Do not run a live malware or EICAR test, terminate unrelated processes, install over a personal copy or weaken Windows protections as a routine test step. Use benign, disposable fixtures and explicit permission for installed operations.

Documentation-only changes need link/image checks, version/source verification and `git diff --check`; they do not require re-running installed security scenarios. Existing CI still applies to pull requests.

## Build, packaging and publication are separate

`build:all` compiles workspaces; it does not create or approve a Windows installer. Product version comes from [product-version.json](../product-version.json), not the workspace versions.

Official packaging starts with `node scripts/package-windows.mjs --check`. A `--candidate` build requires the exact approved source inventory, dependency/resource provenance, databases, licenses and freeze/preflight gates. Do not reuse an approval for a different tree, generate substitute trust keys or change a verifier to get a PASS. See [release signing](RELEASE-SIGNING-RUNBOOK.md).

Do not commit private keys, API credentials, local profiles, database dumps, quarantine contents or generated installer payloads. PRs must be reviewed; no automatic merge or publication is implied.
