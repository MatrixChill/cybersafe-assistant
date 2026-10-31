# CyberSafe — intensive close / continuidade técnica A–K

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
