# CyberSafe — intensive close / continuidade técnica A–K

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
