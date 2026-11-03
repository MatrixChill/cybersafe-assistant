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
| CI no HEAD final | **PASS** | run [41713660033](https://github.com/MatrixChill/cybersafe-assistant/actions/runs/41713660033) sobre `dcde0ca` |
| Contrato de versão | **PASS** | `product-version.json` é a fonte canónica (`0.2.0-rc.1`); os `package.json` são versões internas. Guarda nova: `scripts/test/product-version-coherence.test.mjs` (3/3) |
| Merge para `main` | **BLOCKED** | requer gates verdes + autorização do proprietário |
| Release pública | **BLOCKED** | depende do updater assinado e dos artefactos verificados |


## Testes executados neste HEAD (evidência, não inferência)

| Suite | Comando | Resultado |
|---|---|---|
| App (renderer/MATRIX) | `npm test -w @cybersafe/app` | **PASS 2971/2971** (HEAD `fc561bb`; app não foi alterada depois) |
| API — política e tokens | `node --import tsx --test test/ai-policy.test.js test/ai-token-policy.test.js` | **PASS 20/20** |
| Contrato de versão | `node --test scripts/test/product-version-coherence.test.mjs` | **PASS 3/3** |
| Scripts/packaging | `npm run test:scripts` | **PASS 446/459, 0 falhas** após construir o renderer; guarda isolada 6/6 |
| Desktop | `npm test -w @cybersafe/desktop` | **PASS** no ficheiro de handoff (1 pass, 2 skip) após `npm run build:native` |
| Serviço | `npm test -w @cybersafe/service` | **PASS no isolamento** (8/8 dirigido, incl. E e H). Suíte completa: 1007/1010, com a falha de batch atribuída à ausência de YARA no PATH (`engine-failed`), não ao código |
| Typecheck app/api | `tsc --noEmit` | **PASS** |
| Build app | `npm run build -w @cybersafe/app` | **PASS** |
| CI remoto | GitHub Actions | **PASS** — run 41713660033, SHA `dcde0ca` |

As duas falhas acima estão identificadas, não escondidas: nenhuma foi causada por
alterações desta fase e ambas precisam de reprodução dirigida antes do merge.

## Pendências técnicas abertas

- **YARA no teste de batch (`scan-post-batch-no-double-clamav`)**: falha por
  ausência do binário `yara` no PATH — o veredicto limpo em cache é degradado
  para `inconclusive (engine-failed)`, que é o comportamento correto do produto.
  Tentei uma fixture determinística por Proxy sobre `engine.yara`; **não pegou**
  (a interface real de avaliação não é `scan`/`scanFile`/`scanFiles`) e foi
  revertida, sem deixar alterações. Próximo passo correto: injetar o motor no
  construtor ou separar o teste unitário do teste de integração real.

## Bugs P0

- **Encerrado — escrita externa, não da suíte.** A pasta real muda sem testes a
  correr: `logs/security-events.log` cresceu 620 bytes em 8 s, com a aplicação
  instalada a correr (7 processos `CyberSafe Assistant` desde as 15:18). O teste
  comparava a árvore inteira, incluindo logs que a instalação escreve de
  contínuo, e por isso atribuía à suíte uma escrita de terceiros.
  Correção: o teste passa a provar isolamento nas áreas que a suíte pode tocar
  (`quarantine/`, `definitions/`, `history.jsonl`, `scans.jsonl`) e recusa, antes
  de escrever, qualquer raiz que aponte para o perfil real (teste H). Nenhuma
  verificação de segurança foi removida.

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

## Consolidação no main

| Campo | Valor |
|---|---|
| Merge | `release/v0.2.0-final-integration` → `main`, sem force-push |
| `main` | `37b7821` (merge commit) |
| Base anterior | `21fefa6` |
| CI | **PASS** no run 41713660033, SHA `dcde0ca`; o merge commit ainda não tem execução própria |
| Branches removidas | `integration/windows-v0.2.0`, `codex/updater-visual-20261103`, `freebuff/matrix-intelligence-v2-20261103` — todas comprovadamente contidas em `main` |
| Branches mantidas | `main`; `release/v0.2.0-final-integration` (worktree ativo); `experimental/linux-lite` (edição experimental) |

O código Windows, MATRIX e Linux coexiste em `main` com separação por plataforma.
O instalador Orbital B e o updater continuam por validar; nada de distribuição
foi publicado.

## Instalador Windows — decisão e bloqueio real

**Decisão:** manter o NSIS existente como instalador funcional e a Orbital B como
UI aprovada a integrar depois. Não se constrói um segundo motor de instalação nem
se simula progresso enquanto o NSIS trabalha.

**Estado:** não foi produzido instalador nesta sessão. O gate de packaging
(`node scripts/package-windows.mjs --check`) recusa a candidata por inputs
externos em falta:

| Falta | Como se resolve |
|---|---|
| `vendor/clamav/VENDOR.json`, `clamscan.exe`, `source/` | `node scripts/vendor-clamav.mjs` (download oficial + verificação) |
| seed ClamAV | `node scripts/prepare-clamav-seed.mjs --source <cache oficial> --out <pasta>` |
| registo de aprovadores | definir `CYBERSAFE_APPROVERS_FILE` |
| `renderer:@cybersafe/desktop/dist`, binários nativos, dists dos workspaces | `npm run build:all` + `npm run build:native` (feitos no worktree de release) |

Sem estes inputs o script termina com código 1 **antes** de empacotar: não há
artefacto, checksum nem Release para apresentar. Isto é um bloqueio de
provisionamento, não uma lacuna de código.
