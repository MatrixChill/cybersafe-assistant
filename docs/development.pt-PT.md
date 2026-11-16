# Desenvolvimento

[English](development.md) · [Documentação](README.md)

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

## Fontes Arch e Nigor

A branch `codex/nigor-arch-20261113` e o [PR #5](https://github.com/MatrixChill/cybersafe-assistant/pull/5) contêm a implementação Linux/Nigor. A Preview 1 Nigor usa `b1f38b134623c7b36273526f1050078a2c07cb36`; a Preview 3 genérica usa `32e627bbbeaee0b933e2ab505f674499e688c354`. Use outro checkout e registe o commit antes de comparar ensaios.

Num Arch descartável autorizado, consulte a receita `scripts/linux-lite/arch/PKGBUILD.in` do commit selecionado. Declara Node/npm, Python, CMake e dependências nativas. Use um utilizador normal e reveja a transação de dependências.

```sh
git clone --branch codex/nigor-arch-20261113 https://github.com/MatrixChill/cybersafe-assistant.git cybersafe-linux
cd cybersafe-linux
git switch --detach b1f38b134623c7b36273526f1050078a2c07cb36
bash scripts/linux-lite/arch/prepare-recipe.sh --nigor ../cybersafe-nigor-recipe
cd ../cybersafe-nigor-recipe
makepkg -s
```

Para Arch genérico, omita `--nigor` e escolha um diretório novo. Receitas posteriores podem ter revisões diferentes das Previews públicas. Verifique `SOURCE-IDENTITY`, metadados e checksums. O `makepkg` executa os testes da receita; arranque gráfico, porta-chaves, polkit, serviço persistente, análise e recuperação exigem aceitação própria.

Os testes dirigidos dependem da branch e plataforma. Preserve falhas e skips. O [guia Nigor](nigor-os/README.pt-PT.md) regista os gates físicos. Este PR documental não executa instalação ou build de pacotes.
