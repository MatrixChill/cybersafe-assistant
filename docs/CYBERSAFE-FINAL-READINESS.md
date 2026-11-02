# CyberSafe — intensive close / continuidade técnica A–K

## Entrega RC1 — 2026-11-02 (substitui o estado Git/YARA anterior)

- Limpeza REMOTA executada após fetch/prune e ancestralidade confirmada imediatamente antes de cada eliminação: codex/pap-final-integration-20261102 e freebuff/r7-final-integration-20261101 contidos na integração; pap/final-qoder-20261101 contido na main. Consulta direta ao origin confirmou **6→3 branches**: main, experimental/linux-lite e integration/windows-v0.2.0. Worktrees/histórico preservados, sem force-push.
- Seis commits anteriores publicados e HEAD remoto confirmado: c80c6681fa57efcd2f725b956ea9df0c81368c82. Main/Linux não alterados. Commit desta preparação identifica a RC interna; pedido PENDING exato em output/release-delivery-20261102/review-request.json.
- **YARA: causa ambiental demonstrada nesta máquina.** Reprodução sem serviço, com regra condition:false e binário YARA vendorizado: conteúdo original da fixture (SHA256 daacb0ded6129036ba5be4c830c423899fe314ea70f14d828e40c3f7b4b6f2ed, 29 B) dá YARA exit1/could-not-open e Node UNKNOWN. Leitura independente .NET retorna HRESULT **0x800700E1**, Win32 **225**, vírus/software potencialmente indesejado. Controlo benigno: leituras YARA/Node/.NET passam. Isto comprova recusa do SO/antivírus, não identifica qual fornecedor nem prova que o conteúdo seja malicioso.
- Teste original preservado e ainda **9/10** (a mesma falha do conjunto adicional anterior27/28); **não é PASS nem skip**. Cópia diagnóstica fora das fontes, alterando apenas conteúdo para controlo benigno e caminhos de importação, conserva asserções e passa **10/10**. O produto mantém inconclusive em erro de leitura; nenhuma proteção desligada, exclusão criada, fixture original alterada ou deteção reduzida. Esta falha ambiental não exige mudança do Scanner para gerar uma candidata interna; a leitura YARA do corpus instalado continua no gate VM.
- NSIS revalidado por compilação real: **15/15**, zero skips, três configurações/26 idiomas. Não executado no PC pessoal. Páginas de escolha/progresso/conclusão e capturas reais só serão VALIDADAS EM INSTALAÇÃO REAL pelo proprietário na VM; não confundir compilação com aparência comprovada.
- Candidata definida: **0.2.0-rc.1**, canal internal, codename windows-rc1; versão Windows0.2.0.0. Não é tag/Release pública v0.2.0. Teste de identidade4/4 e build renderer com typecheck; aviso chunks>500kB mantido. Pipeline recompila do HEAD aprovado; build de preparação não é payload final.
- Nenhuma alteração funcional adicional a Scanner/USB/terminação/Dashboard/updater. Trust de produção permanece desativada; sem instalação automática/Authenticode alegados. Suítes anteriores não repetidas sem necessidade.
- Freeze/packaging **BLOQUEADOS POR APROVAÇÃO**: registo externo ausente, aprovação nova obrigatória para HEAD/tree exatos. Sem setup novo/hash de instalador, sem reutilizar4069af1. Manifesto de fontes inclui agora os12 recursos NSIS (correção já publicada).
- Gates restantes: proprietário aprova freeze/build interno e fornece caminhos exatos do registo/aprovação fora do repo; pipeline oficial→payload/hash→checklist VM curta; só após resultados/autorizações, promoção canónica0.2.0, novo freeze/build se fontes mudarem, merge/CI/tag/Release/verificação do download e eliminação da integração. Nenhum merge/tag/Release/VM/instalação foi executado nesta preparação.
- Evidências desta execução em output/release-delivery-20261102: branches-before/after, push-review.json, yara-os-diagnostic.json, no-double-original.log, no-double-control.log, nsis.log e version-final.log. Os outputs são locais, não publicar em bloco.

---


## Fecho técnico Windows — 2026-11-02, continuação após db8f863

**Não é aprovação de Release.** Estado: **IMPLEMENTADO / TESTADO AUTOMATICAMENTE nos contratos abaixo; PENDENTE DE TESTE HUMANO e BLOQUEADO POR APROVAÇÃO para candidata/Release.** Existe ainda uma falha de integração Scanner/YARA, explicitamente não resolvida. As secções anteriores no tempo, abaixo deste checkpoint, são histórico e não aprovam este código.

Ponto de partida preservado e já remoto: `db8f863668106c8b87f812c2bcf398156977dcfe`, tree `63301a47c63c99d5738a89732149fe95428c85e6`. Worktree autorizado: `freebuff-setup-final-20261102/repo`. Código fechado neste checkpoint: `7aa4c448b4cb8f21339355ee2584e1a01614eb41`; o pedido PENDING em `output/autonomous-close-20261102/review-request.json` identifica o HEAD/tree finais, incluindo documentação. Nenhuma aprovação anterior, incluindo 4069af1, é reutilizável.

### Correções e provas

- **Scanner — IMPLEMENTADO / TESTADO AUTOMATICAMENTE:** limpar conjuntamente `filesInEngineBatch`, `filesInEngineScanned` e `engineBatchStartedAt` em qualquer terminal. A UI também ignora os campos residuais de terminais legados. Histórico passa a persistir `filesExcludedBy` opcional, agregado, sem caminhos; validação independe da ordem de chaves JSON e recusa entradas inseguras. Razões dos inconclusivos mantidas. Regressões red→green registadas nos logs.
- `filesInEngineScanned` é progresso dentro do lote, não resultados globais fechados; `filesScanned`/`filesProcessed` representam resultados processados, incluindo exclusões. `filesAnalyzed` não deve ser somado de novo ao batch nem lido como número de conclusivos. `filesTotal` é o denominador selecionado; o relógio de batch só descreve trabalho ativo. O timeout de 30 minutos foi preservado: não é prova de aceleração.
- Instrumentação existente preservada: preparação/descoberta, PREPROCESS, primeira resposta de batch, SCANMANAGER_BATCH_END, motores por ficheiro, fecho e HISTORY_RECORD. RESOURCE_SUMMARY mede CPU/RSS do processo Node, não CPU do filho ClamAV, disco nem fila RPC. Não se acrescentaram medições inferidas. A repetição dos 800 ficheiros reais permanece exclusiva da VM.
- **Falha aberta — NÃO RESOLVIDA:** integração adicional `scanner-final-extra.log`: **27/28**, não 28/28. `scan-post-batch-no-double-clamav.test.js`, caso dos seis ficheiros, espera `safe` para `d.txt` e recebe `inconclusive`. Diagnóstico de `scanFileOutcome`: YARA exit 1, `could not open file`, subprocesso terminado. Corpus YARA de fixture com `condition: false`; não se usou EICAR. Binário YARA direto reproduz a recusa para o conteúdo original; outros conteúdos benignos são lidos no mesmo ambiente. Numa leitura posterior o próprio Node recebeu UNKNOWN/open. Isto localiza a falha fora da contabilidade do Scanner, mas **não prova a origem da recusa nem exclui defeito do produto**. Não se alterou a fixture, não se saltou o teste, não se reduziu deteção nem se desligaram proteções. Exige diagnóstico/ensaio isolado antes de aprovação final.
- **Gestor de Tarefas — TESTADO AUTOMATICAMENTE:** implementação 598c50b preservada. Novos casos prepare→confirm: idle; análise/fila entretanto ocupadas; saída natural; PID reutilizado; elegibilidade revogada; filho próprio; operação crítica; shutdown; autenticação perdida; read-only; ticket expirado/inválido; controlador encerrado. Confirm não reabre por PID; handle fecha uma vez e ticket é de uso único. **20/20**, com handles falsos, nenhum processo pessoal terminado. Prova com processo real: PENDENTE DE TESTE HUMANO.
- **USB — TESTADO AUTOMATICAMENTE:** novo teste com runtime real prova enumeração baseline e análise manual read-only sem reinserção: runtime **20/20**; conjunto anterior **68/68** preservado, com sobreposição, não somar. Baseline não dispara auto; auto requer opt-in e pode enfileirar. Manual quando ocupado é recusado com causa, **não existe fila manual**. Monitor, consentimento e dispositivos não foram alterados.
- **Dashboard — TESTADO AUTOMATICAMENTE:** **3/3**, incluindo produtor real `getProtectionState()` serializado em JSON, sem `init()`. Razões de degradação chegam ao veredito; cobertura desconhecida não vira proteção completa. Não é snapshot de uma instalação aprovada.
- **NSIS — IMPLEMENTADO / TESTADO AUTOMATICAMENTE:** tema dos diálogos filhos/configuração, instalação por utilizador e progresso; callback SHOW é consumido pelo hook real `customInstallMode`, depois da licença opcional. Corrigida mensagem `0x401` (PBM_SETRANGE) para `0x2001` (PBM_SETBKCOLOR); nunca se altera posição/progresso por timer. Compilação real com toolchain NSIS 3.0.4.1 e recursos 3.4.1 fixados pelo builder, três configurações (per-user, licença, all-users), 26 idiomas: conjunto **15/15**, sem skips. Permanecem avisos 6001 do harness sem payload: 3 per-user/licença, 5 all-users; nenhum 6040. EXE de contrato não executado nem tratado como setup. Aparência, capturas reais e instalação continuam PENDENTES DE TESTE HUMANO. 2010836 era normalização de sintaxe, não correção visual comprovada.
- **Atualizador — IMPLEMENTADO / TESTADO AUTOMATICAMENTE dentro do laboratório:** UX manual não promete desbloqueio automático nem afirma hash verificado antes do download. Cadeia ficheiro benigno real→produtor→assinador→cliente e cache adulterada antes de revelar pasta cobertas. **49/49** na cadeia existente e **27/27** no rerun com testes novos, sobrepostos; não somar como 76 únicos. HTTPS local, Ed25519, assinatura/hash inválidos, cancelamento e redirects permitidos cobertos; UI **57/57**, incluída na suíte final. Não existe feed público/upgrade instalado validado. `release-trust.json` continua disabled; `manualDownloadOnly`, BLOCKED_PUBLISHER e BLOCKED_INSTALLER mantidos. Sem chave de produção aprovada, sem execução automática e sem Authenticode declarado.
- **Freeze — defeito demonstrado e corrigido:** exclusão genérica de pastas `build` omitira os hooks/bitmaps fonte em `packages/desktop/build`. Exceção estrita para esse diretório acrescenta 12 recursos ao inventário (1847 entradas neste checkpoint). Regressões de alteração/adição/remoção falharam antes e passaram depois; gate/autoridade/assets **48/48**. As caches geradas continuam excluídas. Isso fortalece o gate, não concede aprovação.

### Verificação final e limites

- Suíte da aplicação no marco final: **2899/2899**, zero skips/falhas; a evidência anterior 2895/2895 permanece distinta.
- Serviço dirigido final: **53/53**; terminação final **20/20**, histórico final **17/17** sem `init()`; são conjuntos sobrepostos, não uma soma única.
- Core dirigido: **27/27** (terminação segura, progresso/kill grace/error/death/lease). Workflows: **4/4**.
- Builds shared-types/core/service e build da aplicação (`tsc -b && vite build`): exit 0. Aplicação mantém aviso de chunks >500 kB; não foi suprimido. Não equivale a build/payload oficial.
- `git diff --check` e revisão dos deltas efetuados; nenhuma dependência npm, versão, trust ou chave de produção alterada. Inspeção heurística de linhas novas/caminhos sem indicadores de segredo; não é auditoria exaustiva. Licenças, YARA 4 ficheiros, ClamAV 45 ficheiros e seed 4 ficheiros/175916377 B verificados pelo preflight. Logs e códigos de saída em `output/autonomous-close-20261102/`.
- **Limitação registada:** execução anterior completa de `r7-l3-history` passou 18 testes, mas dois casos antigos chamavam `engine.init()` e arrancaram scheduler/freshclam em TEMP isolado, com warnings. Não repetir no PC pessoal; a execução final filtrada 17/17 não inicializa proteção. Não foi instalação, teste humano ou prova de candidata.
- Preflight offline: **exit 1**, zero inputs ausentes; bloqueio `approver-registry-missing` (`CYBERSAFE_APPROVERS_FILE` ausente). Freeze aprovado novo **NÃO GERADO**. Candidata/SHA do setup novo **NÃO GERADOS**. Não foram executados instaladores, VM, prova real800, terminação de processos pessoais, merge/tag/Release/upload ou limpeza de branches.

### Git, PR e próximos gates

Cinco commits de código nesta continuação, sem atribuição automática: `3ef22ed` Scanner/histórico; `8607f84` transições/USB/Dashboard; `5fba5ed` NSIS; `3fb5751` updater; `7aa4c44` cobertura do freeze. Commit documental posterior não altera as provas de código. A base remota continua db8f863; estes deltas locais ainda não foram publicados.

Consulta remota read-only em 2026-11-02: main `21fefa69352516c188f99c665966d4443588aa2b`; integração `db8f863668106c8b87f812c2bcf398156977dcfe`; Linux `d8dbc36007144c545a35b39c1d343c2a93f1174b`. Os três ramos antigos consultados estão contidos na integração; main também é ancestral. Não é licença para eliminar; confirmar novamente no momento autorizado da limpeza. PR apenas **draft local**, em `output/autonomous-close-20261102/PR-DRAFT.md`, sem PR remoto aberto nesta continuação.

Decisões humanas específicas:
1. Diagnosticar a recusa YARA num ambiente isolado e fornecer resultado; nenhuma aprovação final deve ocultar esta falha.
2. Confirmar a identidade pretendida: candidata interna atual ou promover versão/canal para 0.2.0. Alterar versão exige novo HEAD/tree/pedido.
3. Rever o pedido PENDING final e, só quando adequado, fornecer registo externo de aprovadores e aprovação operacional real para um packaging interno; nunca preencher approvedBy/approvedAt por inferência.
4. Após o pipeline concluir: proprietário testa/captura o setup e a lista de aceitação em `docs/VM-ACEITACAO-CANDIDATA.md`.
5. Rever chave pública/fingerprint/feed já propostos e custódia/recuperação; decidir Authenticode separadamente. Não regenerar pares existentes. Sem aprovação, updater fica unconfigured/manual bloqueado.
6. Autorizar separadamente push dos deltas, merge na main, limpeza de branches e publicação pública; nenhum destes passos é consequência automática da aprovação técnica.

---


## Continuação Windows v0.2.0 — 2026-11-02 (integration/windows-v0.2.0)

**BLOCKED_WITH_EVIDENCE, não é aprovação de Release.** Este checkpoint refere-se
à integração iniciada em `2010836245bd18d5054956ae4256b7be136fedad`; as secções
abaixo são histórico de outras etapas/lanes, não descrevem o HEAD atual.

### Setup: compilação agora demonstrada, aparência ainda pendente

A toolchain NSIS 3.0.4.1 fixada pelo electron-builder foi obtida numa cache local
em `output/finalization-20261102/toolchain`, com SHA-512 do app-builder-lib.
Sem instalação global, sem alteração do PATH, sem executar os EXE produzidos.
O teste existente aceita agora `ELECTRON_BUILDER_NSIS_DIR`, recusa um caminho
explícito inválido em vez de saltar, guarda a compilação no projeto e limpa o
contrato mesmo em falha. Usa UTF-8 e os mesmos idiomas do electron-builder.
Compila os hooks de páginas e de atalhos; não compila o payload/extrator completo.

Prova final: 4 páginas, 26 tabelas de idiomas, exit 0. Os avisos 6040 de idiomas
vinham do harness de apenas um idioma: o teste falhou com a asserção nova e
passou ao carregar os 26 idiomas reais. Permanecem 3 avisos 6001 de variáveis
não atribuídas pelo harness sem instalação/launch; não foram suprimidos.
Tema/branding: 11/11; contrato final NSIS: 1/1, zero skips.
Log: `output/nsis-contract/compile.log`. Toolchain inválida: falha esperada,
zero skips. Nenhuma destas provas equivale a instalação, execução ou aceitação visual.

**Retificação de 2010836:** adicionar `0x` a SetCtlColors não corrige as cores.
A comparação real dos dois snippets produziu EXE byte a byte iguais (38448 B,
SHA-256 `4e9c02c782235a9bfd5cbd1c0ba977cc75e8f6641667654b8219ae4a43820b01`).
O parser oficial NSIS lê ambos em base 16 e converte RGB para COLORREF.
O commit é normalização de sintaxe, não correção visual demonstrada; não se
reescreveu histórico. A aparência do setup continua pendente.
Prova: `output/finalization-20261102/color-proof/comparison.json`.
Fonte: https://raw.githubusercontent.com/nsis-dev/nsis/v304/Source/script.cpp

### Atualizador e distribuição

Atualizador GitHub existente: 13/13 nos testes dirigidos de redirects, trust
fechada, compatibilidade de assinatura e HTTPS local (válido, assinatura
adulterada, bytes adulterados, cancelamento). Chaves efémeras de ensaio,
nenhuma credencial de produção. Cadeia manifesto/assinatura/somas/workflow:
20/20. Não é prova de feed publicado nem de upgrade instalado.
Trust continua disabled e sem chave pinada; transferência manual após trust
aprovada, sem execução automática. Authenticode/VM/publicação não aprovados.

Preflight offline: exit 1, zero inputs ausentes; ClamAV 45 ficheiros, seed 4
ficheiros/175916377 B, YARA 4 ficheiros e licenças verificados. Bloqueia em
`approver-registry-missing`; aprovação existente refere 4069af1 e não pode
cobrir o código posterior. Não foi criado manifesto de aprovação nem candidata.
Versão canónica preservada: `0.1.11-internal.pap-r7.20261031`, não v0.2.0 stable.

Consulta read-only do remoto: main `21fefa69352516c188f99c665966d4443588aa2b`;
integração remota `4069af1eafc45207871e6ff9026ef023c3cf341d`.
Sem push, merge, tag, Release, eliminação de branches, instalação ou VM.
Scanner/terminação/USB/Dashboard não sofreram alterações nesta continuação;
os resultados de 2895 app, 12 serviço e 13 core são da execução anterior,
não foram repetidos nem somados como testes novos.

Próximos gates: aprovação do HEAD/tree exatos e registo externo de aprovadores;
packaging oficial e payload; ensaios do proprietário na VM; aprovação de
chave/feed e identidade v0.2.0; autorizações separadas de merge e publicação.

---


## ESTADO ACTUAL — build894b426 medido, NSIS stock pendente de novo freeze

**BLOCKED_WITH_EVIDENCE.** Codex aceitou894b426 em árvore isolada74ac108;
core/service build0 e16/16 testes independentes (REPORTADO pelo Codex).
Os144/144 da lane Freebuff são execução distinta, não16 reexecutados nem160
casos únicos. Seed/fallback funcional aceite; trust/VM/publicação não aprovados.

Freeze aprovado894b426bd88d661b95572bc42067470155790002, árvore clean,
1751ficheiros, digest789e0278f7208597f6f06b0238e7ed644ec606a492f242683d78ce50b6b5a5a8.
Preflightseed exit0. Build único autorizado exit0; freezePOST aprovado antes
do delta seguinte. Artefacto apenas EVIDÊNCIA, NÃO candidato aceite:
`packages/desktop/release/candidate-20261031-215142-91cac323/`
`CyberSafe Assistant-0.1.10-internal.pap-r6.20261031-candidate-20261031-215142-91cac323-setup.exe`
278622859B, SHA25640da200c20df04a4fe625024c5e7e2ef9e0ea761dfcc6fb10b9324452f5f83b7.

Medição Freebuff no NOVO payload:423ficheiros fora asar/635800497B,
2886entradas asar,0@litko/ascii_tree runtime. app.asarSHA
724ca9eda2ba28c51c7375fe0a912d2929c92aadd9e148545e6c4c4b29b93657.
Seed4recursos175916377B+manifesto, hashes fixos e licença ok. YARA4.6.0
4recursos4919333B, VCRUNTIME app-local ok. SQLite.nodeABI130,
SHA248266ce7ced05ac854e7662172eb56941b9a37c1e9a73433d28d6bfa7b7dcd7;
koffiNAPI. Renderer versão0.1.10-internal.pap-r6.20261031,
buildId20261031-215156, commit7=894b426, full=894b426bd88d661b95572bc42067470155790002,
sourceState=clean. Mapa completo e inventário em PAYLOAD-MEASUREMENT.json e
PAYLOAD-MANIFEST.json na pasta do artefacto. Identidades repetidas no JS são
mesmos valores, não builds distintas. Binários não executados nesta medição;
ABI é classificação estática, não prova de abertura SQLite no payload.

Gráficos: symbol.png/tile.png presentes no asar; CoreScene tem fallback de
falha WebGL/context lost e low-power. WebGL/GPU/runtime NÃO EXECUTADO,
nenhuma inferência sobre VM; não forçada aceleração. Motores runtime do payload,
login/Scanner/PDF/serviço instalado NÃO EXECUTADOS. Prova ClamAV real anterior
na lane não é validação da candidata instalada. Build unsigned conforme logs;
Authenticode do novo setup não medido independentemente, não inventar PASS.

**Correcção documental:** o handoff antigo e referências a NSIS convencional
não foram sustentados por verificação da configuração efectiva. A build894b426
preservou nsis.include=installer/cybersafe-installer.nsh; esse script define
customWelcomePage/customPageAfterChangeDir. Logo NÃO é assisted stock e fica
HOLD independentemente do exit0. Não se encontrou builder-effective-config.yaml
no output; conclusão sustentada pelo manifesto gerado por buildAppManifest,
config fonte congelada e passagem directa ao electron-builder sem override.
Não afirmar inspecção de ficheiro effective-config que não foi produzido.

Delta mínimo autorizado pelo Codex: packages/desktop/package.json remove
nsis.include e explicita perMachinefalse/createStartMenuShortcuttrue/runAfterFinishtrue;
oneClickfalse/deleteAppDataOnUninstallfalse/createDesktopShortcuttrue/appIdactual
preservados, ícone/bitmaps stock mantidos, sem forçar language. Scripts antigos
preservados como histórico sem referência activa. Teste comportamental de
buildAppManifest mede ausência include/script/custom hooks e todos os contratos,
incluindo versão canónica, atalhos/opção executar/branding e config directo stock.
nsis-stock-RED.log:10PASS1FAIL esperado; nsis-stock-POST.log:28PASS0FAIL0SKIP.
Não houve segundo setup. Novo delta invalida freeze anterior e exige revisão,
novo freeze e só então build corrigido. Não reutilizar approval894b426.

Pendências TÉCNICAS: revisão delta stock, freezeexacto novo, build/payload e
runtime isolado dirigidos, NSIS stock efectivo, metadadosWindows/Authenticode.
HUMANAS: fingerprintEd25519/feed/certificado/VM/publicação separados.
VM: clean snapshot/hash/manualinstall/benignos/motores/conta/PDF/encerramento/GPU,
rollback snapshot. NÃO upgrade: appIdcom.cybersafe.assistant; dados podem ser
partilhados apesar de identidades diferentes, usar snapshot limpo. Seed usa-se
read-only em resources, NÃO deve ser copiada para perfil. Se >7dias, esperar
degraded e actualizar por freshclam com autorização/rede, não fabricar frescura.
Setup r6 anterior24beb5... permanece intacto. Nenhuma instalação/VM/trust/push.

---
## CHECKPOINT ANTERIOR — revisão funcional posterior a87dada8

Esta secção substitui as conclusões técnicas do checkpoint histórico abaixo;
resultados antigos são preservados, não reescritos. Owner Freebuff Builder,
modelo GPT-6.1 Sol, mesma lane/branch. Codex tree não alterada.
**BLOCKED_WITH_EVIDENCE para release: aguarda revisão/freeze novo/payload/VM.**
O stop de87dada8 NÃO foi aceite nem integrado;327fe12 também não integrado.

### A–C: decisão e implementação mínima

Comparadas duas opções:
1. Publisher Windows: exige operações no-clobber ligadas a parent handles,
   ownership de temporários, recovery sem apagar publicados e protocolo com o
   freshclam real. A arquitectura actual não oferece esse protocolo; aumentar
   a superfície nativa para copiar uma base não é necessário ao requisito offline.
2. **Escolhida:** recurso privado empacotado, imutável por contrato do produto,
   usado read-only por `clamscan --database=<resources/clamav-seed>`; nenhuma
   publicação/cópia/rename/delete no perfil. O runtime nunca passa esse path ao
   freshclam. Este mantém exclusivamente `definitions/clamav` e o gate/leases.

Threat model: protege dados contra operações do próprio seed, repetição,
interrupção e concorrência normal com freshclam/outra instância. Não promete
resistência a administrador/malware com capacidade de substituir código ou
recursos da própria aplicação per-user. Imutável significa nenhum writer do
produto, NÃO ACL Windows inviolável. Links estáticos de resources/parents são
recusados antes de ler conteúdo; não alegar defesa contra junction swap hostil
concorrente. Eliminar publicação elimina a necessidade de retenção de handles
para uma transacção de escrita: não há essa transacção.

Ficheiros: core/src/clamav.ts acrescenta callback read-only ao collector;
service/src/clamav-seed.ts valida pins fixos, manifesto exacto, licença e hashes
em cada probe; engine.ts liga callback sem publicação em init; main.ts preserva
path resources e corrige comentário. Scripts package-windows/prepare-clamav-seed
permitem recurso read-only verificado e retiram bloqueio incondicional. Candidata
sem seed é recusada. Preparador só build, output exclusivamente novo, COPYFILE_EXCL,
sem rollback/cleanup; workspace de build é de confiança, não perfil runtime.
Verifier estático recusa parents/manifestos ligados e entradas não regulares.

### D: selecção, frescura, concorrência e recovery

Fallback só quando não há datadir explícito e TODOS os candidatos existentes
estão missing/empty. Ready existente (mesmo parcial/velho) e unreadable impedem
fallback: nunca misturar seed com DB existente nem mascarar permissões.
ENOTDIR passa a unreadable, não missing. Assinatura symlink dá unreadable.
Freshclam tem path de escrita separado; seeds não participam no seu rollback.
Gate de processo permanece: não se afirma exclusão global entre serviços.
Como a seed não escreve em nenhum DB, duas instâncias não podem clobber/apagar
publicados do seed. Concorrência entre freshclam de serviços distintos é limite
preexistente, não resolvido nem agravado com publisher novo.

Freshclam com sucesso já dispara isAvailable(true) no engine (linha de wiring
existente); próximo probe prefere DB mutável. Falha de rede/binário não copia
seed para destino nem muda timestamp. Se algum DB parcial apareceu, exige-se
recovery pelo updater; não se compõe artificialmente uma base com seed.
Provas single-flight, leases, budgets e fail-closed mantidos.

Frescura seed usa epoch do cabeçalho daily, NÃO mtime da cópia/instalador.
Data inválida/desconhecida nunca é fresh. Daily verificado:29Oct2026,
1793255056. Base com >7 dias mantém degraded; carga positiva e scan real
continuam obrigatórios para afirmar funcionamento. A seed é finita, não
substitui actualizações online indefinidamente.

### E–F: trust e licenças

Trust continua disabled; fingerprint proposto3982C36398918D077A417DDA02E6E7FF6C1F70622684DA4FB43673652E4C8FB6
PENDING humano. Nenhuma privada lida/alterada, sem Authenticode e sem execução
automática. Licença seed COPYING18738B SHA0c4fd2fa9733fc9122503797648710851e4ee6d9e4969dd33fcbd8c63cd2f584.
Pins runtime/build com teste de igualdade. Daily CLD vem da cache anteriormente
verificada; hash de proveniência não é assinatura independente CVD. Sem rede.

### G–H: evidências novas (logs ../logs-release-20261031)

- readonly-fallback-RED.log:2FAIL esperados antes implementação,3PASS;
  callback read-only inexistente. Detectado depois ENOTDIR e leitura curta de
  header; corrigidos, sem enfraquecer assertivas.
- readonly-regressions.log: **144PASS/0FAIL/0SKIP**, exit0, execução final após
  último delta. Core proof/parser/recovery, seed, gate41casos incluindo YARA,
  frescura, scheduler/reprobe, update truth, packaging e lifecycle.
- Core e service builds TypeScript exit0 após último delta; desktop Vite build
  exit0 (readonly-build.log; core/service stdout também capturado na sessão).
- readonly-real-clamav-proof.log: **PASS** ClamAV1.5.4 real da lane, prova de carga
  +UM ficheiro benigno limpo com datadir da seed; todos os hashes antes/depois
  iguais, nenhum definitionsDir criado, sem rede/serviço/perfil instalado.
  Ensaio anterior ao ajuste de tratamento de leitura curta/erro de header;
  bytes reais tinham512B completos, percurso funcional não alterado.
- readonly-preflight.json:exit1, seed4recursos/175916377B íntegros, YARA/Clam
  bundles ok, zero inputs ausentes; freeze7b294a5 divergente. NÃO preflight PASS.
- Build8/typechecks/native/API/app/updater anteriores abaixo reutilizáveis para
  ficheiros sem delta; não somar execuções sobrepostas nem alegar payload novo.

YARA baseline reproduzida por `git archive 7b294a5` em ../baseline-yara-7b294a5.
Build próprio shared/core/native/service; dependências externas via junctions,
@cybersafe aponta para os pacotes BASELINE, não para lane corrente. A primeira
configuração de junction falhou resolução de deps; reparada antes da medição.
Binários clássicos são os mesmos pins aprovados. Comando:CYBERSAFE_YARA_BIN_DIR
apontado ao vendor da lane, node --test --test-name-pattern='publica regras
compiláveis com warnings|classifica módulos YARA não suportados'
packages/service/test/p1-1-clam-db-gate.test.js.
Log yara-baseline-7b294a5-FAIL.log: **0PASS/2FAIL/0SKIP**, exit1.
CONFIRMADO baseline, não nova regressão Clam.

Contrato clássico medido: condition:true =>[]diagnostics; string$a="a" usada
=>warning slow-scan; import inexistente=>error unknown-module. Updater preserva
categoria incompatible-module e origem. Teste agora usa fixture que realmente
emite warning clássico e exige slow-scan/origem, exige unknown-module/categoria,
rejeição da fonte e continuação de fonte compatível. NÃO introduz códigos X
fictícios nem reduz assertions a simples sucesso. Duas falhas fechadas no POST.

### I–K: entrega e pendências

Sem novo setup, freeze, instalação, VM, publicação, push/tag ou agentes extra.
Setup r6 anterior preservado clean-install-only, appId=com.cybersafe.assistant;
SHA24beb5b7c01887accba946a07cf21bf7c1adeea56974505da4cd035814abf72c.
Artefacto antigo NÃO contém esta seed; não o apresentar como corrigido.
Próximo gate Codex: rever delta funcional (sobre87dada8; árvoreCodex não recebeu
327fe12/87dada8, portanto usar delta completo desde7b294a5), aprovar commit/freeze
exactos. Só depois gerar um novo payload e medir seed/ABI130/recursos/motores,
0@litko/ascii_tree runtime, versão/renderer/NSIS/SHA e inventário. Aprovação nova
não é autorização de trust/VM/publicação. CI continua parcial.

Humanos: chave/feed/Authenticode; VM separada e autorizada. Checklist/rollback
mantém snapshot limpo, hash, clean install manual, conta/histórico/quarentena,
benignos,motores,PDF,encerramento,WebGL/fallback,logs; rollback snapshot, nunca
apagar dados para testar. Sem upgrade aprovado, exclusões ou backendMATRIX novo.
Reverter código exige revert revisto; NÃO voltar ao publisher inseguro327fe12.

---
## CHECKPOINT HISTÓRICO87dada8 (superado pela secção actual)

Packet: TP-FREEBUFF-INTENSIVE-CLOSE-20261031. Data: 2026-10-31.
Owner: Freebuff Builder; auditor/integrador: Codex Lead.
Lane: `C:/Users/caioc/.cybersafe-integration/pap-freebuff-final-release-20261031/repo`.
Baseline preservada: `327fe12294ccba116f9bc4f66c23709ae8ea29ab`, pai `7b294a5`.
**Veredito: BLOCKED_WITH_EVIDENCE. Não gerar nova candidata.**

## A — Resumo

CONFIRMADO: a implementação seed de 327fe12 não oferecia no-overwrite seguro.
O delta intensivo elimina esse caminho, não tenta disfarçá-lo com mais checks
lstat/realpath. A operação automática é agora negada ANTES de qualquer I/O.
Não foi implementado um publisher nativo; não afirmar seed offline concluída.

CONFIRMADO: build8, comandos typecheck, native build/vetores e regressões seguras
abaixo executados. Duas falhas persistem num teste do updater ligado à mudança
histórica de YARA-X para clássico; não enfraquecidas nem ocultadas.
Nenhuma instalação, VM, publicação, chave de produção ou setup executado.

## B — Causas e fronteiras

Ativos: base de assinaturas, ficheiros do perfil, estado freshclam e cache.
Adversário: outro processo do mesmo utilizador, updater concorrente ou junction
substituída durante uma operação. Entrada: paths seed/definitions e conteúdo do
manifesto. Impacto: overwrite, mistura de versões ou remoção de DB alheia.
Privilégios: utilizador normal; sem elevação; nenhuma alteração a ACL pessoal.

Em `packages/service/src/clamav-seed.ts` de 327fe12:
- `access(final)` seguido de `rename(temp, final)` não era no-clobber. A API
  Node documenta overwrite de um newPath existente: https://nodejs.org/api/fs.html.
- A limpeza removia todos os paths já publicados. Se outro processo substituísse
  o ficheiro antes da limpeza, a limpeza podia apagar a substituição alheia.
- Erro de readdir era convertido em lista vazia, incluindo EACCES.
- stat do ficheiro final e hashes não impediam redirecionamento por parents.
- O seed corria antes do scheduler nesta instância, mas o gate de definições é
  de PROCESSO, não um protocolo de exclusão com outro serviço/freshclam.

A lane não contém publisher handle-relative para esta operação. Koffi e o
motor C++ existentes NÃO são por si uma implementação dessa garantia.
Node não expõe aqui um conjunto de operações por directory handles que vincule
a transação inteira. Trocar rename por link reduz overwrite final mas não
fecha parents/junctions, ownership de cleanup ou consistência do conjunto.

## C — Alterações desta entrega

- `packages/service/src/clamav-seed.ts`: removidos leitor de manifesto, cópia,
  rename e rollback inseguros. Sem env => not-provided. Com env => invalid com
  código estável `CLAMAV_SEED_NATIVE_BOUNDARY_REQUIRED`, sem ler destino/logar paths.
- `packages/service/test/clamav-seed.test.js`: negação antes de I/O, repetição,
  preservação byte a byte, destino não-directory, junction e parent-junction,
  dois processos controlados por barreira IPC e substituição simulada de DB.
- `scripts/package-windows.mjs`: build de candidata ou seed configurada é
  recusado; buildAppManifest também recusa seed; não publica recurso inoperante.
  Check de integridade estática não é promovido a garantia de publicação.
- `scripts/prepare-clamav-seed.mjs`: escrita desativada antes de leitura/criação
  de saída; mantém apenas --check diagnóstico. Cache anterior preservada.
- Teste de packaging cobre recusa de seed e preparador sem criação da saída.
- Runbook corrigido: par proposto existe, aprovação PENDING; não ativar trust.

O commit de segurança deve ser revisto como delta sobre 327fe12, não como
prova de que o objetivo offline foi alcançado. O histórico WIP é preservado.

## D — Concorrência, falhas e recovery ClamAV

CONFIRMADO: negação não cria temporários, não faz cleanup nem remove publicados.
Portanto EACCES, cópia interrompida, substituição por terceiros e junctions não
são tratados como base vazia pelo seed. O teste de getter comprova ausência de
acesso ao destino. Os testes de dois processos verificam negação e preservação,
NÃO dois publishers bem-sucedidos ou proteção de freshclam em produção.

CONFIRMADO por leitura: engine chama seed antes de probe/scheduler; seed inválido
é registado e o serviço prossegue. Estado real de ClamAV continua responsabilidade
do probe existente. Sem base offline continua degraded, não active fabricado.

Regressões existentes exercitam com mocks: frescura por componente, falha do
freshclam sem renovar timestamp, nova tentativa, estados update-pending/active,
leases e paragem do scheduler. Não aumentámos budgets nem removemos leases.
NÃO EXECUTADO nesta entrega: first-run completo do serviço empacotado, freshclam
real, stress, deteção com malware ou scan grande; sem modificar perfis instalados.

BLOQUEADO: publicação atómica do CONJUNTO com no-overwrite, identificação por
handles, rejeição de reparse points em todos os componentes, exclusão interprocessos
partilhada por seed/freshclam e recovery após crash. Um lock JS não resolve.

## E — Updater e trust

`release-trust.json` continua enabled=false, pública/fingerprint vazios.
Par proposto fora do repo, humana PENDING:
`3982C36398918D077A417DDA02E6E7FF6C1F70622684DA4FB43673652E4C8FB6`.
Pública em `C:/Users/caioc/.cybersafe-keys/pap-r6-20261031/public.pem`.
A privada NÃO foi lida nesta entrega e não entra no relatório/payload.

Assinador entrega manifesto com signature embutida no formato real; testes usam
chaves efémeras de fixture, nunca o par proposto. Runtime usa manualDownloadOnly,
BLOCKED_PUBLISHER e BLOCKED_INSTALLER. Sem Authenticode não executar automaticamente.
Aprovação freeze não é aprovação chave/feed/certificado/instalação/publicação.

## F — Licenças e recursos

Cache seed preservada fora do repo em `../build/clamav-seed` (175916377 bytes,
3 bases + COPYING, manifesto à parte); prova histórica de hash/carga não prova
segurança de publicação. Daily CLD não é CVD independentemente assinada.

Preflight estático: bundle ClamAV 1.5.4 íntegro (45 ficheiros medidos pelo gate,
139195536 bytes; fonte incluída; 13 licenças). YARA 4.6.0: quatro recursos medidos,
4919333 bytes e VCRUNTIME app-local. Isso NÃO é novo payload.
YARA/ascii_tree não reinvestigados. Medição de ausência runtime no PRÓXIMO payload
continua pendente; docs históricos preservados.

O verificador de cache seed de 327fe12 é diagnóstico estático; não alegamos que
seja seguro contra troca concorrente de ancestors ou manifesto ligado. Não é
usado para autorizar publicação nesta entrega.

## G — Builds, ABI e preflight

Ambiente: Windows x64, Node v24.13.0, Node ABI137; Electron pin 33.4.11 / ABI130.
CMake usou Windows SDK 10.0.26100.0 e MSBuild18.9.1.

- npm run build:all: exit0, oito workspaces topológicos.
- npm run typecheck --workspaces: exit0. Service script é delegado/no-op;
  compilação TypeScript real do service foi executada em build8 e build dedicado.
- npm run build:native: exit0; npm run test:native: 25/25 PASS,0SKIP.
- API PRE falhou por binding better-sqlite3 ausente; recompilado LOCALMENTE na
  lane com node-gyp12 para Node ABI137, sem tocar payload ou instalações.
  Probe :memory: confirmou SELECT1. API POST 39/39 PASS.
- npm run build:all tem warnings Vite de alias deprecado, opção freeze inválida
  e chunks grandes; não apresentados como corrigidos.
- package-windows --check --json: exit1 esperado, freeze anterior divergente e
  seed/publicação bloqueada; nenhum input obrigatório ausente. Não dizer preflight PASS.
- ABI130 do setup r6 é evidência anterior; rebuild Node137 da lane NÃO valida
  ABI do próximo payload. Novo payload precisa de nova medição.

## H — Testes e comandos (sem somar execuções sobrepostas)

Logs absolutos sob:
`C:/Users/caioc/.cybersafe-integration/pap-freebuff-final-release-20261031/logs-release-20261031/`.

| Log | Resultado | Âmbito |
|---|---|---|
| intensive-seed-PRE.log | 1 PASS / 6 FAIL | testes RED de negação contra327fe12 |
| intensive-packaging-PRE.log | RED | packaging aceitava seed |
| intensive-preparer-PRE.log | RED | preparador não negava a escrita |
| intensive-seed-final.log | 12 PASS /0FAIL/0SKIP | seed,barreira2processos,junctions,packaging,preparador |
| intensive-safe-service-core.log |127 PASS /2FAIL/0SKIP| proof/parser,gate,frescura,scheduler,scan terminal,quarentena,histórico,USB,lifecycle |
| intensive-protection-cancel.log |56 PASS /0FAIL/0SKIP| intenção/pause/cancel/abort |
| intensive-app.log |55 PASS /0FAIL/0SKIP| PDF HTML,PC Center,Otimizar,Monitor,Tarefas,labels |
| intensive-api-auth-matrix.log |3 ficheiros FAIL antes dos casos| binding SQLite ausente; substituído por POST abaixo |
| intensive-api-auth-matrix-POST.log |39 PASS /0FAIL/0SKIP|auth,email,provider MATRIX simulado loopback |
| intensive-updater.log |55 PASS /0FAIL/0SKIP|core,safety,compat assinatura; keys efémeras |
| intensive-release-gates.log |63 PASS /0FAIL/0SKIP|manifest,Clam bundle,ABI fixtures,outputs,signing,workflow,version |
| intensive-native-vectors.log |25 PASS /0FAIL/0SKIP|ficheiros benignos pequenos gerados pelo teste |

Duas falhas: packages/service/test/p1-1-clam-db-gate.test.js:
1. publica regras compiláveis com warnings e reporta os warnings separadamente;
   espera MALW_Eicar.yar.*invariant_expr (código YARA-X).
2. classifica módulos YARA não suportados e continua com fontes compatíveis;
   espera incompatible-module.*E010 (código YARA-X).

CONFIRMADO: updater.ts/yara.ts/yara-classic.ts não têm delta desde7b294a5 nesta
entrega. HIPÓTESE: expectativas obsoletas após migração clássica. Baseline PRE
independente dessas duas falhas NÃO reexecutada; não declarar baseline PASS/FAIL
medido. Não alterámos assertivas nem abrimos outro ciclo YARA. Codex deve decidir
correção dirigida do contrato/teste antes de freeze.

Comandos dos grupos:
- node --test --test-concurrency=1 packages/service/test/clamav-seed.test.js scripts/test/clamav-seed-bundle.test.mjs
- node --test --test-concurrency=1 packages/core/test/clamav-positive-load-proof.test.js packages/core/test/recovery-clamav-parser.test.js packages/service/test/p1-1-clam-db-gate.test.js packages/service/test/clamav-frescura-componente.test.js packages/service/test/clamav-scheduler-wiring.test.js packages/service/test/definitions-update-truth.test.js packages/service/test/scan-manager-terminal-record-order.test.js packages/service/test/r6-l14-quarantine-security.test.js packages/service/test/r7-l3-history.test.js packages/service/test/r8-usb-readonly.test.js packages/desktop/test/p0-window-destroyed-lifecycle.test.mjs packages/desktop/test/ag49-window-foreground.test.mjs
- node --import tsx --test --test-concurrency=1 packages/service/test/human-protection-startup.test.js packages/service/test/protection-pause-timers.test.js packages/service/test/scan-cancel-abort-intents.test.js packages/service/test/p1-4-cancel-before-controller.test.js
- Em packages/app: ../../node_modules/.bin/tsx --tsconfig tsconfig.app.json --test --test-concurrency=1 test/ag36-consolidated-report.test.ts test/app-modules-pccenter.test.ts test/app-modules-optimizer.test.ts test/monitor-engine-health.test.ts test/task-manager-honest-states.test.ts test/task-manager-readonly-policy.test.ts test/scan-terminal-result-labels.test.ts
- node --import tsx --test --test-concurrency=1 packages/api/test/auth-role.test.js packages/api/test/email-validation.test.js packages/api/test/matrix-guard.test.js
- node --import tsx --test --test-concurrency=1 packages/desktop/test/updater-core.test.mjs packages/desktop/test/updater-safety-review.test.mjs packages/desktop/test/release-signing-compat.test.mjs
- node --test --test-concurrency=1 scripts/test/7h-packaging-manifest.test.mjs scripts/test/dist-clamav-bundle.test.mjs scripts/test/packaging-native-abi.test.mjs scripts/test/final-candidate-output.test.mjs scripts/test/release-signing.test.mjs scripts/test/release-workflow-security.test.mjs scripts/app-version.test.mjs

NÃO EXECUTADO: suites gerais com kill/processos instalados/scans pesados,
Clam real nesta entrega, PDF impresso por Electron, MATRIX provider externo,
UI gráfica/3D/WebGL e runtime instalado. Nenhum screenshot pedido/tirado.

## I — GitHub, release/tag/assets

Nenhum push/tag/release/upload/workflow remoto executado. CI permanece parcial
honestamente: Windows npm build8 e testes, não provisioning/native/NSIS/payload.
Assinatura de manifesto, tests e canonicalização já existentes reaproveitados.

Após resolver bloqueios e revisão (não autorização para executar agora):
1. Codex aprova commit exacto e freeze. Não reutilizar approval de7b294a5.
2. Versão/renderer/NSIS devem concordar; não criar tag até candidato validado.
3. Produzir setup único, payload/resource inventory SHA256, origem commit/freeze,
   changelog, checklist/rollback e NOT_FOR_DISTRIBUTION.
4. Asset update-manifest.signed.json só com chave/feed aprovados; assinatura
   embutida, size/hash reais, publisher verificado. Não usar fixture como produção.
5. Publicação/tag requerem autorização separada. Não fornecer manifesto fictício
   de um setup que não existe. Authenticode separado.

Setup r6 preservado:169468988B, SHA256
`24beb5b7c01887accba946a07cf21bf7c1adeea56974505da4cd035814abf72c`.
Hash reconfirmado nesta entrega. appId=com.cybersafe.assistant, CLEAN-INSTALL-ONLY.
Upgrade para …internal.papr4 não aprovado; não mudar identidade.

## J — Pendências separadas

TÉCNICAS: publisher nativo seguro+protocolo interprocessos/recovery; fechar as duas
falhas de contrato YARA sem enfraquecer testes; novo freeze/preflight; novo payload
medido ABI/recursos/runtime/seed; diagnóstico NSIS PT-PT e 3D apenas com evidência.
HUMANAS: aprovação fingerprint/proveniência da chave, infraestrutura/feed,
Authenticode, autorização VM e publicação separadas.
VM: snapshot limpo, hash, instalação manual, login,persistência,motores,benignos,
histórico/PDF,encerramento,gráficos/logs,rollback. Sem USB grande nem malware real.
FUTURO: exclusões, backend seguro MATRIX, redesign fora desta candidata.

## K — Recomendações e checkpoint de retoma

Rever e integrar apenas a negação segura deste delta; 327fe12 isolado não é
seguro para release. Não pedir freeze enquanto publisher inexistente ou testes
vermelhos. Se for necessário retomar: ler este ficheiro, git HEAD/status, packet
intensivo e logs; não repetir investigação YARA nem usar prova offline histórica
como prova da implementação negada atual. Preservar cache/setup/aprovações.

Rollback de código: revert revisado do commit intensivo, nunca reset/force.
NÃO reativar327fe12 para desbloquear release: reintroduz os riscos demonstrados.
Rollback VM: snapshot (não executado). Desinstalar não substitui backup; não
apagar contas, histórico, definições ou quarentena. Checklist histórico em
../logs-release-20261031/VM-UPGRADE-CHECKLIST-20261031.md é condicional, não
permissão de VM nem promessa de seed presente.
