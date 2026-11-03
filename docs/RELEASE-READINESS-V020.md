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
| MATRIX (base 7de8b59) | **PASS** | suite app 2932/2932, typecheck e build limpos |
| Merge Linux ↔ MATRIX | **PASS (merge)** | 2 conflitos, ambos resolvidos e revistos |
| Árvore integrada — typecheck | **PASS** | `tsc --noEmit` limpo após `tsc -b` de shared-types, core, native-windows e service |
| Árvore integrada — suite | **PASS** | **2971/2971** testes, 0 falhas |
| Build da app integrada | **PASS** | `npm run build -w @cybersafe/app` concluído |
| Instalador Orbital B | **NOT TESTED** | UI Win32 existe; handoff NSIS por fazer |
| Updater GitHub | **BLOCKED** | Ed25519 + Authenticode ausentes (`docs/ASSINATURA-E-GITHUB-V020-20261103.md`) |
| Pacotes Linux (.deb/.AppImage) | **NOT TESTED** | exige ambiente Linux nativo; WSL2 não equivale |
| CI no HEAD final | **NOT TESTED** | workflow não correu sobre esta branch |
| Consistência de versão | **FAIL** | root `0.1.1`, desktop `0.1.2`, app `0.1.2`, api/service `0.1.1` |
| Merge para `main` | **BLOCKED** | requer gates verdes + autorização do proprietário |
| Release pública | **BLOCKED** | depende do updater assinado e dos artefactos verificados |

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

1. Corrigir a divergência de versões para uma única versão canónica.
2. Regressão do updater e do instalador no HEAD integrado.
3. Pacotes Linux num ambiente com desktop nativo.
4. CI sobre esta branch; depois merge e Release, com autorização.

## Declaração

Estado global: **NO-GO** para publicação, **PASS** para a integração de código.
O merge está feito, a árvore integrada compila e passa 2971 testes. Continuam
por fechar: versão canónica, instalador, updater assinado, pacotes Linux e CI.
