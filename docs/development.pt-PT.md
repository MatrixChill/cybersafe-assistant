# Desenvolvimento

O projeto é um monorepo npm. A versão do produto vive em `product-version.json`; as versões dos workspaces não são a versão da release.

```powershell
git clone https://github.com/MatrixChill/cybersafe-assistant.git
cd cybersafe-assistant
npm ci
npm run build:all
npm run dev
```

A raiz declara Node.js >=20; a CI fixa a versão usada nos seus ensaios. Módulos nativos e binários Windows exigem o toolchain e recursos respetivos. [C++/CMake](TOOLCHAIN-CPP-WINDOWS.md) · [motor nativo](../packages/native-engine/README.md).

Não execute DEV sobre o perfil ou serviços de uma instalação pessoal. Consulte o [isolamento desktop](../packages/desktop/src/dev-isolation.ts) e os scripts de ensaio antes de iniciar sessões paralelas.

```powershell
npm test -w @cybersafe/core
npm run test:full -w @cybersafe/service
npm test -w @cybersafe/app
npm test -w @cybersafe/desktop
npm run test:scripts
npm run test:native
```

Não são comandos de certificação de instalação. Alguns ensaios dependem do Windows, têm opt-in ou são ignorados quando faltam requisitos; devem ser reportados assim. Não ative ensaios EICAR no computador de outra pessoa.

Packaging oficial: `node scripts/package-windows.mjs --check` e, depois dos gates, `--candidate`. Exige recursos, proveniência, seed e source freeze válido; `build:all` sozinho não produz uma candidata distribuível. [Processo de atualização e release](updates.md).

[Voltar à documentação](README.md)
