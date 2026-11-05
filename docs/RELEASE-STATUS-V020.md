# Estado da release v0.2.0

**Data:** 2026-11-05
**Classificação:** **FINAL CANDIDATA, PUBLICAÇÃO BLOQUEADA**
**Versão canónica:** `0.2.0` / canal `stable` / codename `v0.2.0-final`

## 1. Identidade e âmbito

- Worktree: `C:\Users\caioc\.cybersafe-integration\main-merge-20261103\repo`
- Branch: `release/v0.2.0-final`
- Commit de código/build: `475501e5375baf1ac2ea04ac2bb644a389ec185a`
- Git tree: `ff25a3482918b9c65779c0ed01ff133e2012ada5`
- Base aprovada da RC12: `2bbca4a1a7f8378410457a9033b268a822331620`
- Identidade do renderer: `0.2.0` (`20261105-165853`, commit `475501e`)
- A versão dos `package.json` dos workspaces é interna e não foi usada como identidade do produto.

O trabalho Orbital Glass V3 está integrado nesta branch. Não foi criada uma RC13, não foi feito push, não foi criada tag e não foi publicada qualquer release `v0.2.0`.

## 2. Trabalho executado e evidência

| Verificação | Resultado | Evidência |
|---|---|---|
| Build dos 8 workspaces | **PASS**, exit 0 | `output/v020-build-all.log` |
| Renderer da app | **PASS**, `0.2.0` | `node scripts/app-version.mjs --verify-renderer packages/app/dist` |
| Cópia do renderer para o desktop | **PASS** | `node scripts/stage-renderer.mjs` |
| Renderer do desktop | **PASS**, `0.2.0` (`475501e`) | `node scripts/app-version.mjs --verify-renderer packages/desktop/dist` |
| Suite da aplicação | **PASS**, 3003/3003, 519 suites, 0 falhas | `output/v020-app-tests.log` |
| Typecheck | **PASS**, exit 0 | `output/v020-typecheck.log` |
| Testes do updater | **PASS**, 8/8 | `output/v020-updater-tests-tsx.log` |
| Seed ClamAV | **PASS**, 4 ficheiros, 175 916 377 bytes, ClamAV 1.5.4 | preflight final |
| Launcher 0.2.0 | **PASS** após preparação e rebuild limpo; SHA-256 `a3f75a887fa8796d9de69a68b74e4ec770ebc0f95c7e990d2463bff6b240c286` | `output/v020-launcher-prepare.log`, `output/v020-launcher-verify.log` |
| Pré-verificação de packaging | **FAIL** apenas no gate de fontes congeladas | `output/v020-package-check-final.json` |

Nota de honestidade: a primeira invocação dos testes do updater foi feita com `node --test` sem o loader TypeScript e falhou com `ERR_MODULE_NOT_FOUND` para `windows-installer.js`. A invocação correta, com `node --import tsx --test`, passou 8/8. A falha foi do harness, não do produto.

O launcher anterior tinha SHA-256 `4dd3fb6688c0de3153a18bad847a76eb5aa5dd4c5c26809da91aafc91330b047` e não continha a versão `0.2.0`. Foi preparado o novo launcher com `node scripts/windows-launcher-proof.mjs --prepare`; o rebuild limpo foi confirmado com `--verify`. O binário está em `packages/native-engine/build/` (diretório ignorado pelo Git), pelo que não foi commitado. A aprovação de fontes ainda referencia o binário antigo.

## 3. Bloqueadores

### 3.1. Freeze de fontes (P0)

O manifesto `scripts/source-freeze.approved.json` continua a aprovar a RC12, não a árvore atual:

- `candidateId`: `cybersafe-0.2.0-rc.12`
- `approvedBy`: `Caio Amorim`
- `approvedAt`: `2026-11-05T12:20:29.155Z`
- `head`: `2bbca4a1a7f8378410457a9033b268a822331620`
- `gitTree`: `fa51445623179ec913711a35cd20ae7d573052bc`
- entradas: 2017
- digest: `c1318f325416a5dd18808d44e3c49fa440564c377cfa10b3650292615fb5cb46`
- âmbito declarado: geração do Setup Windows, não publicação nem instalação

Com o registo externo de aprovadores (`../../cybersafe-approvals/approvers.json`, 1 owner, 0 integrators), a verificação read-only devolveu:

- 2017 entradas no manifesto, 2019 na árvore
- 2 ficheiros adicionados
- 0 removidos
- **28 modificados** (incluindo o novo launcher)
- `approval-mismatch` em `head`, `gitTree`, `digest` e `entries`
- exit 1

O registo externo existe e é válido, mas **não existe uma aprovação específica para o HEAD/tree/digest atuais**. Não foi executado `source-freeze --write` e não foi criado nenhum ficheiro de aprovação. Sem essa aprovação humana, `package-windows.mjs` não pode produzir a candidata; o preflight sem `CYBERSAFE_APPROVERS_FILE` falha fechado com `approver-registry-missing`.

### 3.2. Atualização RC12 → v0.2.0 (P0, estrutural)

O cliente RC12 instalado não consegue aceitar um manifesto stable `0.2.0`:

- `packages/desktop/src/updater/production.ts` seleciona `previewTrust` quando `installedVersion` corresponde a `x.y.z-rc.N`.
- A RC12 tem `installedVersion = 0.2.0-rc.12`, logo escolhe o canal `preview`.
- `packages/desktop/src/updater/manifest.ts` exige, no canal Preview, `version` no formato `x.y.z-rc.N` e rejeita `0.2.0`.
- O teste `packages/desktop/test/updater-preview.test.mjs` inclui explicitamente `version: '0.2.0'` como inválido no Preview.

Consequência: um feed stable com `version: 0.2.0` é rejeitado pelo RC12 antes de download, verificação de assinatura ou instalação. Não é possível corrigir este comportamento apenas na build nova, porque o código que corre no cliente é o da RC12 já instalada.

Caminhos possíveis, todos dependentes de decisão do proprietário:

1. **Instalação manual** do Setup 0.2.0, assumindo que a atualização automática RC12→0.2.0 não é validada.
2. **Ponte RC13 explícita**: publicar um manifesto Preview com versão `0.2.0-rc.13` e o Setup final, apenas para o parque RC12. Isto cria uma RC13, contraria a instrução atual e exige aprovação, assinatura e feed próprios. Não foi criada.

Não foi alterado o feed público nem qualquer artefacto da RC12.

### 3.3. Confiança stable e assinatura (P0)

`packages/desktop/src/updater/release-trust.json` continua fechado:

- `enabled: false`
- `assistedInstallationEnabled: false`
- `publicKeyPem: ""`
- `pinnedKeyFingerprint: ""`
- `reason`: chave de publicação não provisionada

A chave local proposta em `C:\Users\caioc\.cybersafe-keys\pap-r6-20261031` tem fingerprint `3982C36398918D077A417DDA02E6E7FF6C1F70622684DA4FB43673652E4C8FB6`, mas o `KEY-INFO.json` declara `approval: PENDING_HUMAN`. Não foi usada para assinar uma release stable.

No GitHub, o environment `release-signing` tem:

- secret `RELEASE_ED25519_PUBLIC_KEY`
- variable `RELEASE_ED25519_FINGERPRINT`
- **sem** `RELEASE_ED25519_PRIVATE_KEY`

O workflow `.github/workflows/release-sign.yml` exige `secrets.RELEASE_ED25519_PRIVATE_KEY`. Sem essa chave aprovada, o workflow de assinatura não pode produzir o manifesto stable legítimo. Não foi inventada nem copiada qualquer chave.

### 3.4. Validação real em Windows (P1)

Não foi possível executar a aplicação desktop instalada numa VM Windows limpa nem iniciar sessão com uma conta de teste legítima. Por isso ficam **não validados**:

- arranque, login/logout e dashboard
- Scanner, Monitor em Tempo Real, Ameaças/quarentena, PC Center e Gestor de Tarefas
- Otimizar, Configurações, MATRIX e núcleo 3D
- fechar/minimizar/restaurar e tray
- análise controlada, deteção, quarentena e restauro
- preservação do histórico e da base SQLite
- comportamento sem WebGL, DPI e alinhamento visual observado

Os testes unitários e o build não substituem esta validação. Não foram inventadas capturas nem resultados.

### 3.5. Authenticode

Não existe assinatura Authenticode legítima. O Setup, se for gerado numa fase posterior, não pode ser anunciado como assinado. Esta limitação deve permanecer explícita nas release notes, tal como a ausência de chave HashDB e as limitações de WFP/proteção de rede que continuem aplicáveis.

## 4. O que não foi feito

- Instalador `CyberSafe-Assistant-Setup-0.2.0.exe`: **não gerado**. Não existe SHA-256 nem tamanho de Setup final para reportar.
- Manifesto stable assinado: **não gerado**.
- Teste RC12 → 0.2.0: **não executado**; o código do RC12 rejeita estruturalmente o formato stable.
- Instalação, upgrade, desinstalação e preservação de dados: **não testados**.
- Push da branch, tag `v0.2.0`, release GitHub, feed público e notas finais: **não efetuados**.
- Release RC12, respetivos artefactos e feed Preview: **preservados sem alteração**.
- Authenticode: **ausente**.

## 5. Critérios GO/NO-GO

- [x] Testes automatizados relevantes aprovados (3003 app + 8 updater)
- [x] Typecheck aprovado
- [x] Build de produção aprovado
- [ ] Aplicação desktop instalada abre e permite iniciar sessão
- [ ] Scanner validado em teste controlado
- [ ] Sem falhas críticas de inicialização/encerramento observadas
- [ ] Sidebar e switch validados visualmente
- [ ] Núcleo 3D e fallback validados visualmente
- [ ] HashDB apresenta o estado real em runtime
- [ ] Atualizações automáticas respeitam a preferência em runtime
- [ ] Consentimento não duplicado validado em runtime
- [ ] Installer funciona
- [ ] Atualização RC12 → 0.2.0 validada
- [ ] Dados do utilizador preservados
- [ ] Manifesto e hashes finais verificados
- [ ] Sem bloqueadores P0/P1 conhecidos

**Decisão: NO-GO.** A candidata não deve ser publicada como versão final enquanto o freeze, a confiança stable/assinatura e o percurso de atualização RC12→0.2.0 não forem resolvidos com aprovação humana e validação real.

## 6. Decisões necessárias

1. **Freeze:** aprovar um manifesto novo para o HEAD/tree atuais, incluindo o launcher 0.2.0 e os 2 adicionados/28 modificados, através do registo externo autorizado. Só depois executar o packaging.
2. **Atualização:** escolher entre instalação manual do Setup 0.2.0 ou uma ponte RC13 explicitamente autorizada. Não existe caminho automático RC12 → stable 0.2.0 com o código RC12 atual.
3. **Assinatura/trust:** aprovar a chave Ed25519 e disponibilizar a chave privada ao workflow, ou decidir conscientemente que a versão stable é apenas de download manual. Não ativar `release-trust.json` com uma chave não aprovada.
4. **Validação:** fornecer VM Windows limpa e conta de teste legítima para instalação, login, Scanner, atualização e preservação de dados; decidir se Authenticode/SignPath é exigido.

## 7. Evidência local

Ficheiros em `output/` (não versionados, deliberadamente fora do commit):

- `v020-build-all.log`
- `v020-app-tests.log`
- `v020-typecheck.log`
- `v020-updater-tests-tsx.log`
- `v020-launcher-prepare.log`
- `v020-launcher-verify.log`
- `v020-freeze-final.json`
- `v020-package-check-final.json`
- `clamav-seed-v020-20261103/` (seed validada, 175 916 377 bytes)

Este documento regista o estado da candidata; não é uma aprovação de release nem substitui a aprovação humana do freeze.
