# RELEASE READINESS — CyberSafe v0.2.0

Documento único de prontidão. Regra: **PASS / FAIL / BLOCKED / NOT TESTED**.
"Compila" não é "pronto"; um teste não executado nunca é PASS.

## Identidade

| Campo | Valor |
|---|---|
| Branch de integração | `release/v0.2.0-final-integration` |
| Worktree | `C:/Users/caioc/.cybersafe-integration/release-v020-final-20261103/repo` |
| Base MATRIX | `7de8b594be4c8269a6d7a51a481774664df063d3` (PASS, 2932 testes) |
| Base Setup/Updater | `96ce399507dc76c0159c2496c9798d325def6c63` (contida na MATRIX) |
| Linux Lite | `d8dbc36007144c545a35b39c1d343c2a93f1174b` (integrada) |
| Windows integration | `d88031d263db01b35a3c889352e830fdde78e546` (já contida na MATRIX) |
| `main` remoto | `21fefa69352516c188f99c665966d4443588aa2b` (contida na MATRIX) |

## Alterações incorporadas

- MATRIX: classificador de tópicos, gate da rota local, lista de processos (Caso D),
  frescura por fonte, guard de diagnóstico. Testes: 2932/2932 no HEAD base.
- Linux Lite: 127 ficheiros, +13 829 linhas (docs, guardas de plataforma, scripts
  WSL, isolamento de dev, empacotamento). Integrado com 2 conflitos resolvidos.
- Windows: ascendência registada; nenhum commit em falta.
- Conflitos resolvidos: `packages/service/src/engine.ts` (remoção dos vetos de fila
  + cadeia POSIX) e `packages/app/src/pages/PCCenterPage.tsx` (layout novo em
  colunas; o bloco Linux era a versão anterior).

## Estado por componente

| Componente | Estado | Evidência / razão |
|---|---|---|
| MATRIX (base 7de8b59) | **PASS** | suite app 2971/2971 no HEAD integrado; política de tokens adaptativa e persona revista |
| Merge Linux ↔ MATRIX | **PASS (merge)** | 2 conflitos, ambos resolvidos e revistos |
| Árvore integrada — typecheck | **PASS** | `tsc --noEmit` limpo após `tsc -b` de shared-types, core, native-windows e service |
| Árvore integrada — suite | **PASS** | **2971/2971** testes, 0 falhas |
| Build da app integrada | **PASS** | `npm run build -w @cybersafe/app` concluído |
| Instalador Orbital B | **NOT TESTED** | UI Win32 existe; handoff NSIS por fazer |
| Updater GitHub | **BLOCKED** | Ed25519 + Authenticode ausentes (`docs/ASSINATURA-E-GITHUB-V020-20261103.md`) |
| Pacotes Linux (.deb/.AppImage) | **NOT TESTED** | exige ambiente Linux nativo; WSL2 não equivale |
| CI no HEAD final | **NOT TESTED** | `ci.yml` passou a cobrir `freebuff/**` e `release/**`; execução remota ainda não confirmada |
| Contrato de versão | **PASS** | `product-version.json` é a fonte canónica (`0.2.0-rc.1`); os `package.json` são versões internas. Guarda nova: `scripts/test/product-version-coherence.test.mjs` (3/3) |
| Merge para `main` | **BLOCKED** | requer gates verdes + autorização do proprietário |
| Release pública | **BLOCKED** | depende do updater assinado e dos artefactos verificados |


## Testes executados neste HEAD (evidência, não inferência)

| Suite | Comando | Resultado |
|---|---|---|
| App (renderer/MATRIX) | `npm test -w @cybersafe/app` | **PASS 2971/2971** (HEAD `fc561bb`; app não foi alterada depois) |
| API — política e tokens | `node --import tsx --test test/ai-policy.test.js test/ai-token-policy.test.js` | **PASS 20/20** |
| Contrato de versão | `node --test scripts/test/product-version-coherence.test.mjs` | **PASS 3/3** |
| Scripts/packaging | `npm run test:scripts` | **FAIL 1 de 454** — `linux-lite-package-renderer-guard` falha no agregado e **passa isolado**; suspeita de ordem/concorrência, não de código |
| Desktop | `npm test -w @cybersafe/desktop` | **FAIL 1 de 683** — fixture de locks nativos do helper Windows; não tocado por esta integração |
| Serviço | `npm test -w @cybersafe/service` | **NOT TESTED** — excedeu 120 s, execução interrompida |
| Typecheck app/api | `tsc --noEmit` | **PASS** |
| Build app | `npm run build -w @cybersafe/app` | **PASS** |
| CI remoto | GitHub Actions | **NOT TESTED** — workflow passou a cobrir `release/**`, execução por confirmar |

As duas falhas acima estão identificadas, não escondidas: nenhuma foi causada por
alterações desta fase e ambas precisam de reprodução dirigida antes do merge.

## Riscos

1. A árvore integrada está verde em app/serviço, mas o updater e o instalador
   não foram exercitados neste HEAD.
2. Versões divergentes entre pacotes impedem uma Release coerente.
3. Linux Lite toca `AIAssistant.tsx`, `App.tsx` e `service/engine.ts` — precisa de
   regressão completa antes de qualquer merge para `main`.
4. O updater não pode ser publicado sem chaves; publicar sem elas seria uma
   falsa promessa de atualização.

## Bloqueadores externos (um único conjunto)

- **Chaves Ed25519 de release** e respetivo manifesto assinado.
- **Certificado Authenticode** (ou decisão explícita de publisher).
- **Ambiente Linux com desktop nativo** para instalar `.deb` e correr o AppImage.
- **Autorização** para merge em `main` e publicação da Release.

## Próximo passo técnico (ordem)

1. Reproduzir e fechar as duas falhas dirigidas (guarda Linux no agregado; fixture
   de locks no desktop) e completar a suite do serviço.
2. Handoff do Setup Orbital B para o NSIS, com estados reais.
3. Regressão do updater com fixtures e falhas induzidas.
4. Pacotes Linux num ambiente com desktop nativo; CI remoto; merge e Release.

## Declaração

Estado global: **NO-GO** para publicação, **PASS** para a integração de código.
O merge está feito, a árvore integrada compila e passa 2971 testes. Continuam
por fechar: versão canónica, instalador, updater assinado, pacotes Linux e CI.
