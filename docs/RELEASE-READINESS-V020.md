# CyberSafe v0.2.0 — prontidão atual (3 novembro 2026)

Estados: PASS / FAIL / BLOCKED / NOT TESTED. Fonte de continuidade: main consolidado 78aff29341d99767dfb97b2ef458db810b049b00. Worktree: C:/Users/caioc/.cybersafe-integration/main-merge-20261103/repo. Versão canónica preservada: 0.2.0-rc.1, canal internal. As versões internas dos workspaces não foram alteradas.

## Windows — candidata preservada

PASS na inspeção offline; NOT TESTED na instalação desta candidata. O proprietário escolheu preparar apenas e executar os testes manualmente. Não foi acedida/iniciada VM, executado setup ou alterada a instalação pessoal nesta sessão.

- Commit: 78aff29341d99767dfb97b2ef458db810b049b00; tree 75b60253663c491ef9640ed5086797d7a1cbf4e5.
- Diretório original: packages/desktop/release/candidate-20261103-211243-99d72e39/.
- Setup: CyberSafe Assistant-0.2.0-rc.1-candidate-20261103-211243-99d72e39-setup.exe.
- Tamanho: 278767097 bytes.
- SHA-256: c17111d553d75ef316ed81a062fa0ffed6b8c8827382b17618a9915a2896122b.
- Blockmap: 290001 bytes; SHA-256 64eab1840a07eb453ecc148c4eec68e1f3fbdbdf79015ae8de40258105b7e370.
- Identidade real: ProductName CyberSafe Assistant; Company CyberSafe Team; versão 0.2.0-rc.1; Authenticode NotSigned.
- Payload extraído sem instalar: 424 ficheiros, todos idênticos por SHA-256 ao win-unpacked, zero ausentes/adicionais/divergentes. O aviso 7-Zip de dados após arquivo corresponde ao contentor executável; não se declarou corrupção nem instalação.
- ASAR: 19951128 bytes, SHA-256 484599a9d7fa789966c0e0a480d35840dba3c069df7cbe38c597bc7e08756dad; package.version 0.2.0-rc.1, productName correto e appId com.cybersafe.assistant presente no main.
- Higiene: 5/5 testes, sem skips, sobre a candidata explicitamente selecionada. Addon SQLite fora do ASAR; nenhum .env/SQLite/log/map proibido segundo os padrões do contrato. Audit-candidate-secrets encontrou zero correspondências, mas havia zero configurações .env locais comparáveis: não é prova de inexistência universal de segredos.
- ClamAV 1.5.4: contrato oficial verifyClamavBundle aplicado ao payload extraído PASS, 45 ficheiros verificados, fonte correspondente e licenças presentes. Hashes/tamanhos da seed main.cvd/daily.cld/bytecode.cvd conferidos. YARA 4.6.0: 4/4 entradas do VENDOR conferidas. scan-engine.exe e cybersafe-update-launcher.exe presentes e inventariados.
- Freeze original preservado: 1978 entradas, digest 3b3ee410e5d092461a2d13115aed049cf9e6e8089c18e060d85bb495d7fbed78; manifesto local SHA-256 da7c2cd44f122ea107ab665eb0dc0cd99b85341623766c935888e348143fdcdf. Nenhuma nova aprovação foi emitida. Alterações atuais de teste/lock/configuração não são cobertas por esse freeze para um novo build Windows.

Roteiro específico: VALIDACAO-MANUAL-CANDIDATA-78AFF29.md. NSIS existente é o motor escolhido; a iteração visual Orbital B não substitui esta candidata nem condiciona o primeiro ensaio funcional.

## Correções e testes desta continuidade

| Área | Estado | Evidência |
|---|---|---|
| Fixture batch/ClamAV | PASS | Falha inicial reproduzida; usa scanFileOutcome na mesma instância YARA do analyzer. O runner limpo revelou dependência adicional do Native; resposta isolada só na fixture. Casos negativos preservam inconclusivos quando YARA ou Native faltam. Nenhum código de motor alterado. |
| Contratos CI atuais | PASS local | 23/23, zero skips: cache Scanner, binding de plataforma e guardas de renderer/API Linux. |
| Serviço, regressão ampla | PASS | npm test -w @cybersafe/service terminou 0: agregado principal 1011 PASS/1 SKIP e segmento adicional 12 PASS; total observado 1023 PASS/1 SKIP. Execução anterior ao último ajuste da fixture Native; depois disso os 23 casos dirigidos passaram. |
| Isolamento runtime Windows | PASS | 8/8; não alteradas quarentena/definições/histórico pessoais pelo ensaio. Escritas externas da aplicação instalada não são atribuídas automaticamente à suíte. |
| Updater dirigido | PASS unitário/integração laboratorial | 165 PASS, 0 FAIL, 2 SKIP em 167 casos. Não aprova NSIS nem atualização instalada. |
| MATRIX/app | PASS na base integrada | 2971/2971 no CI da base 78aff29; não foi reconstruída nem alterada nesta sessão. Ver CI atual no checkpoint final. |
| CI base | PASS | https://github.com/MatrixChill/cybersafe-assistant/actions/runs/41717125705 — SHA 78aff29341d99767dfb97b2ef458db810b049b00. |
| CI primeira tentativa atual | FAIL corrigido | 41723890569: fixture supunha Native instalado no runner limpo. Corrigido em e1170cd sem enfraquecer produção. |

## Linux Lite — experimental

Os quatro artefactos antigos foram localizados em /home/caioc/cybersafe-linux-lite/packages/desktop/release-linux (0.1.2 e 0.1.11-internal.pap-r7.20261031), inventariados e preservados. O projeto Qoder não foi modificado.

Novo build isolado: /home/caioc/cybersafe-main-lab-78aff29, clone Linux de main via bundle (o ponteiro .git Windows não é utilizável diretamente pelo Git Linux). Código c7ab85ac4951774c38ab9172ad9c238ee0fb411d; commits seguintes só alteram testes/CI/documentação. Node 22.23.4 já existente em ~/.local/node, npm 10.9.9, Electron 33.4.11, WSL2 Ubuntu x86_64, uid 1000, sem sudo. Não foi executado o bootstrap antigo: aponta para branch/caminho históricos e altera configuração global Git. Não foi preciso reinstalar Node.

Defeito comprovado: npm ci limpo não instalava @rolldown/binding-linux-x64-gnu porque a entrada não existia no lockfile. Foi acrescentada a versão já exigida 1.0.0-rc.10 com URL/integrity oficiais do registry; metadados do binding Windows foram completados sem mudar a versão. Nova instalação limpa confirmou LINUX_BINDING_OK e o build passou. Licença MIT do projeto propagada ao control Debian; licenças de terceiros mantidas.

| Artefacto atual | Bytes | SHA-256 |
|---|---:|---|
| CyberSafe Assistant Linux Lite-0.2.0-rc.1-linux-amd64.deb | 81792786 | 1e35fe8348b4e781f8764ff30dbdc67b0fd784b66b04f342dc4753eda519e62a |
| CyberSafe Assistant Linux Lite-0.2.0-rc.1-linux-x86_64.AppImage | 119580477 | 145b4c92a65caf4ff2b42d2acabcac8043fcfcea1d5f4426a902951863bb2e90 |

PASS build/packaging WSL: .deb amd64, versão Debian 0.2.0~rc.1 (normalização fpm), MIT, desktop/ícone presentes; AppImage com AppRun e zero EXE/DLL na árvore extraída. ASAR Linux: 3617 entradas, zero EXE/DLL, API incluída, versão e licença corretas. SQLite do PACOTE carregado através de app.asar no executável Electron-as-node: ABI 130, Electron 33.4.11, CREATE/INSERT/SELECT em memória = 42. A primeira sonda apontava incorretamente à pasta unpacked sem as dependências do ASAR; corrigida a sonda, sem mudança do produto. Autenticação real por socket Unix: 9/9 PASS em diretório temporário próprio, sem ações destrutivas.

NOT TESTED: GUI instalada em distribuição Linux desktop nativa, integração de menu/tray/autostart e compatibilidade GPU/sandbox. WSL/ABI/socket não aprovam esses percursos. A edição continua experimental.

## Artefactos preparados e proveniência

Diretório Windows acessível: C:/Users/caioc/.cybersafe-integration/main-merge-20261103/repo/output/distribution-LAB-0.2.0-rc.1/.
Contém cópias verificadas dos dois pacotes Linux, setup Windows e blockmap, SHA256SUMS real e provenance.json. Os originais Windows não mudaram. O primeiro build Linux desta sessão, anterior ao ajuste de licença/lock, foi preservado em release-linux/archive-first-78aff29 no clone WSL.

Evidência local em output/: candidate-78aff29-payload.json, components.json, vendor-integrity.json, clamav-contract.json (todos com prefixo candidate-78aff29-), hygiene.log, secrets.json/md; linux-existing-inventory.log, linux-final-build.log, linux-final-runtime-v2.log, main-service-regression.log, main-updater-directed.log, main-runtime-isolation.log e main-ci-contracts-fixed.log. Logs brutos não são publicados.

## Gates finais

| Requisito | Estado |
|---|---|
| Integridade candidata Windows LAB | PASS |
| Instalação/arranque/tray/Scanner/quarentena/desinstalação desta candidata | NOT TESTED — proprietário fará manualmente |
| Ed25519 e Authenticode públicos | BLOCKED — sem identidade/chaves aprovadas; ambos os gates false |
| Atualização real A→B, reinício e SQLite | BLOCKED — dois artefactos e confiança LAB autorizados ainda necessários |
| Pacotes Linux experimentais e hashes | PASS em WSL; desktop nativo NOT TESTED |
| Novo freeze para futura candidata Windows | BLOCKED até fechar árvore e obter aprovação exata; não necessário para preservar/ensaiar a candidata 78aff29 já aprovada |
| Release pública/tag | BLOCKED — não criada; requer testes, identidade e aprovação próprios |

main é a linha principal. Remotas inventariadas: main, release/v0.2.0-final-integration, experimental/linux-lite. A release branch tem zero commits exclusivos contra main, mas o worktree contém output/ não versionado: não foi removida nem desassociada. Nenhuma nova branch, tag ou Release foi criada. Nenhuma confiança pública foi ativada. Não há declaração de rollback automático nem de resolução do benchmark histórico de 594 s.
