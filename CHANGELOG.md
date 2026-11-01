# CHANGELOG técnico — CyberSafe Assistant

**Para que serve este ficheiro.** O relatório da PAP foi entregue ao professor (Word e PDF) antes
das correções descritas aqui. Este changelog é a **adenda técnica posterior à entrega**: regista o
que mudou no produto depois disso e, com o mesmo rigor, o que **ainda não foi construído nem
validado**. Não altera nem substitui o relatório académico.

**Marco de partida.** `01dcfaf` — *docs: fecho documental da PAP (evidencias, README e
transferencia)*, 2026-10-31 16:53. Tudo o que está antes desse commit pertence ao relatório
entregue e à documentação em `PAP-EVIDENCIAS-TECNICAS/` e `docs/`.

**Referência desta adenda.** Branch `pap/final-qoder-20261101`. Cada entrada foi lida no próprio
commit (`git show`): o âmbito descrito é o âmbito declarado, e nada aqui acrescenta trabalho que o
commit não faça.

**Política de identidade.** A versão do produto vive numa única fonte, `product-version.json`,
injetada no manifesto da aplicação empacotada e no renderer por `scripts/app-version.mjs`. As
versões nos `package.json` de workspace (`0.1.1` na raiz, em `core` e em `service`; `0.1.2` em `app`
e em `desktop`) **não** são identidade do produto.

### Como ler o estado

| Marca | Significado |
|---|---|
| **MEDIDO** | Artefacto construído e verificado em disco (tamanho, SHA-256, metadados Windows, assinatura) — prova, não promessa. |
| **INSTALADO** | Instalado e ensaiado por uma pessoa numa máquina. |
| **SÓ CÓDIGO** | Commits presentes no repositório, sem artefacto correspondente. |
| **NÃO PUBLICADO** | Sem *tag*, sem *release* no GitHub, sem sincronização com o `origin`. |

---

## Estado de publicação: **NÃO PUBLICADO**

Verificado nesta sessão, a 2026-11-01:

- `git tag` não devolve **nenhuma** *tag*;
- não existe *GitHub Release* nem artefacto publicado;
- a branch `pap/final-qoder-20261101` **não está no `origin`** — o remote só tem `main`,
  `pap/progresso-2026-10-23` e `sync/pap-2026-10-31`;
- `origin/main` é antecessor de `HEAD`: 0 commits do lado do `main` por trazer, **32 commits desta
  linha ainda não sincronizados** (contagem do *remote-tracking* local, não do estado atual do
  GitHub).

Nada do abaixo foi distribuído a terceiros. Publicar e sincronizar são atos distintos de compilar,
e exigem autorização explícita do dono do projeto.

---

## `0.1.11-internal.pap-r7.20261031` — **SÓ CÓDIGO**, sem instalador

Canal `internal`, codinome `pap-r7`; identidade definida em `dca1cde` sem alterar o `appId`.
**Não existe ficheiro `*pap-r7*` em lado nenhum**: `packages/*/release/` é ignorado pelo
`.gitignore` e nem sequer existe neste checkout, e não há artefacto R7 nos diretórios de release
locais. A construção do instalador R7 está **pendente**, tal como a sua instalação e ensaio manual.

### Correções de produto posteriores ao artefacto R6

| Commit | Mudança (âmbito declarado no commit) |
|---|---|
| `b230b73` | **AUD-001 — dados fictícios.** *fix(api): não inventar eventos de ameaça numa base vazia.* O arranque preenchia `threat_events` com duas ameaças fictícias **em qualquer ambiente, incluindo produção**, e os *endpoints* serviam-nas como deteções reais. A amostra passa a exigir *opt-in* explícito, nunca corre em produção e não apaga dados existentes. |
| `e94096b` | **AUD-002 — framing e backlog.** Um cliente autenticado podia fazer crescer o *buffer*, o número de *frames* e a fila pendente sem teto, e JSON inválido escapava do handler. Descodificador e fila passam a ter limites com recusa explícita, o *framing* usa `StringDecoder` e o encerramento por violação é controlado. Avisos de indisponibilidade deixam de repetir a mesma transição dentro da janela de arrefecimento. |
| `3595e2d` | **Identidade do atualizador.** O instantâneo só recebia `app.getVersion()`, pelo que a instalação dizia «Compilação desconhecida» e «Código desconhecido». O *staging* grava agora a identidade real do renderer e o *main* lê-a, **falhando fechado** quando falta. |
| `3a74299` | **Limites em bytes e fecho determinístico** (revisão de `3595e2d`). `decodeMessagesBounded` mede os *bytes* UTF-8 do *frame* cru antes de `trim`/`parse`, recusa *padding* multibyte e limita o *buffer* agregado antes de materializar linhas. O handler marca `protocolClosed` de imediato, pausa a leitura, faz um único `destroy` e recusa enfileirar respostas depois da violação. Eventos de amostra só em `NODE_ENV` `development`/`test` com *opt-in*. Notificações de saúde deduplicadas por *fingerprint* motivo/estado, em vez de um *cooldown* global que escondia uma indisponibilidade mais grave a seguir a uma recuperação. |
| `dca1cde` | **Notificações de degradação.** `shouldPublishEngineUnavailable` passa a anunciar `degraded → unavailable` e qualquer mudança de *fingerprint* enquanto indisponível; a mesma *fingerprint* continua limitada pela janela e não se repete sem mudança de estado. Testes determinísticos do *backpressure* (`RPC_MAX_OUTBOUND_BYTES` em `safeWrite`, recusa `busy` única por *id*, *socket* saturado que fecha sem serializar recusas) e da sonda nativa (*single-flight*, evidência de tempo limite que mantém degradado, recuperação para ativo, modo de teste sem *spawn*). |
| `e954560` | **Segurança do serviço Windows — guard de instalação.** `windows-service.ts` deixa de apontar para `src/index.ts` com `tsx` e passa a resolver `dist/index.js` dentro de `CYBERSAFE_SERVICE_INSTALL_ROOT`. Um guard puro recusa raiz de desenvolvimento/Downloads, ponto de entrada `.ts` ou inexistente, conflito de nome com `ImagePath` alheio e desinstalação sem posse provada. Testes com estado *mockado*, **sem SCM**. O modelo R6 (serviço como processo filho) e o NSIS de série não são alterados. |
| `edb5f1c` | **Guard do SCM e CLI legado desativado.** O `Id` passa a ser derivado como o `node-windows` faz (`cybersafeengine`) e o *wrapper*/XML a viver em `<scriptDir>/daemon`; consultar pelo `DisplayName` mascarava erro como ausência. A consulta passa a ser tipada `absent`/`present`/`error` — acesso negado ou falha **nunca** é ausência. O `ImagePath` passa a ser interpretado como linha de comando (aspas, argumentos, `%VAR%`) e a posse comparada pelo executável exato do *wrapper*, não por prefixo de raiz. `install`/`uninstall` ficam desativados por desenho (CLI legado fora do NSIS). |
| `97469f1` | **Limite de pedidos e elegibilidade do canal estável.** `check()` respeita `minCheckIntervalMs` (30 s em produção, confirmado em `updater/production.ts`) **antes** de tocar no *feed*, com o novo código `rate-limited` no contrato IPC, no modelo do renderer e na UI. Pré-*releases* e versões internas deixam de ser promovidas pelo canal estável. O manifesto ganha `buildId`, `sourceCommit` e `compatibility` opcionais com validação estrita (§12.4), com *bytes* canónicos idênticos entre o ferramental de assinatura e o atualizador e sem alterar manifestos antigos. Novos testes em `packages/desktop/test/updater-gap-tests.test.mjs` (5 `describe`, 17 casos `it`): falha do instalador, artefacto em falta após o *download*, mapeamento HTTP do `HttpsFeedSource`, canónico novo/antigo, propagação de `latest`. **Prova automatizada, não validação manual.** |

### Qualidade de teste (não muda comportamento do produto)

| Commit | Mudança |
|---|---|
| `9edd92c` | A *fixture* da API cria os seus próprios eventos antes de provar que um pedido recusado não apaga nada — consequência legítima da remoção do *seed* fictício do AUD-001, que tinha deixado a base isolada sem linhas. Ficheiro do guard: **32 PASS / 0 FAIL**. |
| `b01ef8f` | Os guards de forma de fonte deixam de depender do fim de linha do *checkout*: com `core.autocrlf=true` a *worktree* recebe CRLF (os *blobs* no índice são LF e só `vendor/yara/COPYING.txt` estava protegido), pelo que as *regex* multilinha falhavam só em Windows. Segue o precedente de `scanner-v2-visual.test.ts`. **Suíte `app`: 11 falhas → 4.** |
| `d5593b4` | Dados comparados byte a byte (corpus YARA e as duas bases de hashes embarcadas) ficam imunes ao CRLF graças a `-text` no `.gitattributes` (317→330 no corpus; 570→551+20 CR em cada base). Os *blobs* no índice estiveram sempre corretos — a falha era da plataforma, não do produto, e reproduzia-se em qualquer clone Windows. **Commit feito durante a revisão deste ficheiro; o `HEAD` desta branch passou de `b01ef8f` para `d5593b4`.** |

---

## `0.1.10-internal.pap-r6.20261031` — candidata **MEDIDA**, não instalada

Construída a partir de `2dae912` (`sourceState: clean`), no worktree irmão
`pap-freebuff-final-release-20261031`.

- **MEDIDO**: 278 595 602 bytes; SHA-256
  `79340b7b95a444e955acad5858ef55caf9ba51cc7b41b954f9872fcb068b83a7` — **recomputado nesta sessão
  com `Get-FileHash`** e igual ao registo em `PAYLOAD-MEASUREMENT.json`.
- **Sem assinatura Authenticode**: `Get-AuthenticodeSignature` devolve `NotSigned` (verificado
  nesta sessão) e a metadata de compilação regista `WinVerifyTrust` = `0x800b0100`
  (`TRUST_E_NOSIGNATURE`), com a tabela de certificados de tamanho 0. Nunca é apresentada como
  assinada.
- **Identidade coerente**: `FileVersion` e `ProductVersion` do instalador valem
  `0.1.10-internal.pap-r6.20261031`, e o `__BUILD__` embutido no renderer (`buildId`
  `20261031-215613`, `commit7` `2dae912`) é a mesma versão. A incoerência de versões da R5 fica
  fechada **ao nível dos metadados**.
- **INSTALADO: não.** Os próprios ficheiros da candidata dizem `MEASURED_NOT_INSTALLED` e a handoff
  diz `READY_FOR_VM_VALIDATION`, com a nota explícita de que «não houve instalação nem validação
  humana». O primeiro ecrã do instalador deixa de depender do `installer.nsh` antigo
  (`nsis: "STOCK_ASSISTED_INPUT_SAVED"`), mas **a leitura textual desse ecrã só se confirma com
  execução manual, que não foi feita**.
- **Preservada como referência histórica**: não foi movida, renomeada nem eliminada, e não deve
  ser; não é a versão final da PAP e a R7 não a substitui.
- Sem `SOURCE-FREEZE.json` nem `SOURCE-APPROVAL.json` na pasta da candidata; a proveniência é a
  registada em `PAYLOAD-MEASUREMENT.json`.

### Correções que **estão dentro** da R6 (entre o fecho do relatório e a candidata)

Estes commits já fazem parte do artefacto medido — não é trabalho «só em R7».

| Commit | Mudança |
|---|---|
| `b07b893`, `eb120df` | Fonte única de versão: nasce `product-version.json` e `scripts/app-version.mjs` (234 linhas), ligado ao *define* do renderer e ao empacotamento. A versão do produto deixa de depender dos `package.json` de workspace. |
| `00d08c4` | Identidade `0.1.10-internal.pap-r6.20261031`. |
| `c99543a` | *fix(updater): authenticate version checks and prepare verified manual downloads.* |
| `fc960c8` | O *build* real da candidata tinha saído com **0.1.2**: `stageWorkspaces` chamava `buildAppManifest` sem `productVersion` e o manifesto caía para o `version` de `packages/desktop`. A versão passa a ser obrigatória e o renderer compilado é verificado contra ela antes do *staging*. |
| `7b294a5` | O portão do renderer passa a ignorar apenas o *fallback* explícito `desconhecida/desenvolvimento/desconhecido`, continuando a recusar duas versões reais. |
| `eb43819`, `cf8e661` | Fim do *binding* YARA-X inalcancável: o motor em uso é o YARA clássico 4.6.0 por processo, mas `@litko/yara-x` continuava no manifesto, no *lock*, no `asarUnpack` e nos *pins*, arrastando a cadeia Rust `ascii_tree` para o inventário de licenças sem nenhum binário distribuído. Removidos dependência, *pins* e entradas de empacotamento; eliminado `src/yara.js`, artefacto gerado por uma configuração antiga que ficava versionada a importar um *binding* inexistente; `COPYING.txt` fixado em LF para o SHA-256 publicado ser reproduzível em Windows. |
| `37d7bd9` | `vendor/yara` passa a ser publicado em `resources/yara`. `resolveYaraClassicBinaries()` procurava-o no artefacto empacotado, mas o *pipeline* só publicava `scan-engine`, ClamAV e licenças: o payload 0.1.9 tinha os binários porque foi composto **manualmente**; uma candidata gerada pelo *pipeline* sairia sem motor. |
| `0b6b989` | A VM016 mostrou `STATUS_DLL_NOT_FOUND`: `yarac64.exe` importa `VCRUNTIME140.dll` e o *loader* não a encontrava ao lado do executável. O *runtime* assinado da Microsoft passa a ser publicado em `resources/yara`, registado no `VENDOR.json`, e um portão re-med *bytes* e SHA-256 dos quatro ficheiros (dois executáveis, `COPYING` e a DLL) no `--check` e antes do *staging*. **A presença de um ficheiro deixou de ser prova de que o motor arranca.** |
| `7d0412d`, `6d1ba65` | Fecho do `vendor/yara` à lista exata: o portão media as entradas do `VENDOR.json`, mas o `extraResources` copiava o diretório inteiro, por onde um ficheiro não listado entrava no pacote. Passa a comparar o conjunto exato e a recusar duplicados, colisões de maiúsculas, links/junções e entradas de diretório antes de ler; raiz ou *parent* inválido retorna de imediato. |
| `ba4a17a` | O gerador do Visual Studio escrevia `bin/Release/scan-engine.exe`, mas o preflight, o `extraResources` e o `source-freeze` procuravam `build/Release/scan-engine.exe`. Caminho do contrato fixado na configuração `Release`. |
| `bca5164`, `06d238e`, `4b12c2a` | Assinatura Ed25519 preparada e CI *fail-closed*: assinador/verificador com os mesmos *bytes* canónicos do atualizador, recusa de chave privada dentro do repositório e nenhuma impressão de material sensível; *workflow* manual de assinatura **sem publicação** e *runbook* de aprovação humana. Em `06d238e` fecha-se uma **injeção de *shell***: o `manifest_path` era interpolado diretamente em *bash* ao lado de *secrets*; passa por variável de ambiente citada, com `realpath` confinado ao repositório e exigência de ficheiro regular, e o *workflow* entrega `update-manifest.signed.json` com a assinatura embutida no formato do atualizador, verificado pelo validador real. Em `4b12c2a` o veredicto é `BLOCKED_WITH_EVIDENCE` e nenhum *setup* é gerado. **A chave de produção continua `PENDING OWNER APPROVAL` e `release-trust.json` fica desativado.** |
| `327fe12`, `87dada8`, `894b426` | *Seed* offline do ClamAV: a R6 podia reportar o motor apenas como degradado por o levar sem qualquer base `.cvd`/`.cld`. Passa a existir um *seed* *copy-if-missing* verificado — valida manifesto, ficheiros exatos e hash do `COPYING` antes de escrever, preserva qualquer base existente e faz falhar o empacotamento se o *seed* faltar ou for inválido. `87dada8` recusa a publicação antes do I/O: sem fronteira nativa segura, evitar sobrescrita concorrente e limpeza de bases alheias vale mais do que prometer segurança com verificações de caminhos. `894b426` fixa a base *offline* **apenas-leitura**, sem publicar no perfil do utilizador, com o teste `packages/core/test/clamav-readonly-fallback.test.js`. |
| `2dae912` | Instalador **NSIS assistido de série**, sem páginas personalizadas (`oneClick=false`, `perMachine=false`, `deleteAppDataOnUninstall=false`, ícones e bitmaps *stock*, nenhum idioma forçado). Substitui o `installer.nsh` de 5 linhas que causava o ecrã «0.1.8» da R5. Sem páginas custom, não há redesenho; o idioma efetivo na VM continua observação manual. |

---

## `0.1.10-internal.pap-r5.20261031` — etapa anterior, com defeitos conhecidos

491 414 411 bytes; SHA-256 `46718bcd9c5ee712d9e4c663b81aa2fed3317e65c3799f500255d33fb6e5bd75` —
**recomputado nesta sessão** com `Get-FileHash` e igual ao valor registado em
`docs/PAP-TRANSFERENCIA-20261031.md`. Ficheiro preservado em
`pap-setup-internal-codex-20261029/candidate-0.1.10-pap-r5-20261031-001530/release/`.

**Não é o artefacto final**: o primeiro ecrã do instalador mostrava «0.1.8», o renderer empacotado
identificava-se como «0.1.9» e o painel de Atualizações não tinha compilação nem *commit*. Defeitos
de empacotamento e proveniência, não de funcionalidade, documentados em
`docs/PAP-TRANSFERENCIA-20261031.md`.

## `0.1.9` (PAP R4)

Última versão coberta pelo relatório entregue. **Não** contém a correção do ciclo de vida da janela
(`Object has been destroyed`) nem nenhuma das correções acima; não representa o estado atual.

---

## Ainda não validado

Nada aqui se apresenta como ensaiado sem o ter sido.

- Instalação limpa, atualização sobre versão anterior e interrupção do fluxo, em máquina real ou
  virtual: **NOT RUN**.
- Comportamento do atualizador *depois* de uma instalação real, incluindo preservação de contas e
  histórico através de um upgrade: **NOT RUN**.
- Leitura textual dos ecrãs do instalador e idioma efetivo na VM: **NOT RUN**.
- Gráficos/WebGL na VM: a medição da R6 regista `webglRuntime: NOT_EXECUTED` e `vm: NOT_EXECUTED`.
- A prova existente do atualizador é **automatizada** — máquina de estados em
  `packages/desktop/test/updater-statemachine.test.mjs` e cenários §12.7 em
  `updater-gap-tests.test.mjs`. Não é validação manual.
- Chave pública Ed25519 de publicação por provisionar:
  `packages/desktop/src/updater/release-trust.json` tem `enabled: false`, `publicKeyPem` e
  `pinnedKeyFingerprint` vazios e a nota «Publication public key not provisioned. Never replace with
  a fixture key.». Em `updater/production.ts`, `createProductionUpdater()` devolve o atualizador não
  configurado enquanto `enabled` for `false` — *fail-closed*, sem chave inventada. **A verificação
  automática de atualizações não pode ser considerada confiável fim-a-fim.** Nunca se gera uma chave
  de produção fictícia.
- Sincronização com o `origin`: **FEITA** — `main` em `1ad632a` (fast-forward a partir de
  `212cb64`, sem `--force`), confirmado por `git ls-remote` em 2026-11-01T10:45Z; entretanto
  `89645c7` e `5658878` também já estão no `origin`. A primeira run da workflow `ci` falhou **antes
  de correr qualquer teste**: `npm ci` devolveu EUSAGE com `Missing: @emnapi/core@1.11.3 from lock
  file`, porque o `package-lock.json` publicado não tinha as entradas aninhadas
  `@emnapi/core`/`@emnapi/runtime` da subárvore opcional `@tailwindcss/oxide-wasm32-wasi`.
- **Duas explicações dadas estavam erradas e são retiradas.** (1) `89645c7` atribuiu o erro à
  versão do npm e fixou `npm-version: "11.6.2"`. (2) `5658878` «refutou» essa hipótese dizendo que o
  pin não mudou o resultado — e essa refutação **é inválida**: o log do passo `setup-node` da run
  `41299179863` regista `##[warning]Unexpected input(s) 'npm-version', valid inputs are [...]` e
  `npm: 11.19.1`. **`actions/setup-node@v4` não tem entrada `npm-version`; o pin nunca foi aplicado**,
  pelo que a run comparava npm 11.19.1 contra npm 11.19.1 e não testava nada. A hipótese da versão
  do npm continua viva.
- Correção do `package-lock.json`, **VERIFICADA EM CI**: regerado com o npm do runner
  (`npx -y npm@11.19.1 install --package-lock-only`), que materializa as entradas aninhadas da
  subárvore `wasm32` opcional que um npm mais antigo poda (+20/−19; anterior preservado em
  `…\logs\package-lock.pre-emnapi.json`). Na run `41299760421` (SHA `b4a7eee`) os passos
  `Instalar dependências`, `Build dos workspaces` e `Assinatura de release` **correram e passaram**.
  Portanto a afirmação anterior deste ficheiro — «estado do `ci`: VERMELHO no passo de instalação,
  nenhum passo de teste chegou a correr» — está **retirada por medida**, e a ressalva sobre
  `1.11.3` vs `1.11.1` deixou de ser relevante: `npm ci` instala o que o lock declara.
- A mesma run falhou mais à frente, em `Vendor YARA e manifesto de packaging`: 6 testes com o mesmo
  texto `caminho resolvido fora do vendor (link/junction num parent)`. Causa única e medida: no
  runner, `os.tmpdir()` vem em forma 8.3 (`C:\Users\RUNNER~1\…`) e o portão de contenção
  (`scripts/package-windows.mjs:1368`) recusa qualquer diretório cujo `realpath` não coincida
  textualmente com o caminho pedido. **O portão não foi afrouxado** — é *fail-closed* e está
  correto; a fixture é que passou a entregar o caminho canónico (`fs.realpathSync.native`) em
  `3c54c5e`. Medido localmente: **19 PASS / 0 FAIL** (`logs/ci-vendor-fix-local.log`); em CI ainda
  **não foi lido**. Limitação registada: um vendor alcançado por caminho em forma 8.3 é recusado,
  o que pode bloquear o *packaging* nesse tipo de máquina.
- Suíte `service`: o total em falta **tem causa identificada e não é lentidão**. Os quatro
  `engine.init()` de `threat-history-storage.test.js` nunca eram dispostos; os temporizadores do
  ciclo de assinaturas mantinham o event loop vivo, o processo do `node --test` nunca saía e o
  resumo nunca era escrito — é isso que o registo congelado das 10:27 às 10:39 mostrava. Medido: o
  mesmo ficheiro isolado não termina em 150 s antes do `dispose()` (`exit=124`); com `dispose()`
  (já existia em `src/engine.ts:2432`, commit `596fbee`) sai com resumo — **4 testes / 3 PASS /
  1 FAIL** (`logs/th-single-dispose.log`). **Duas retificações nesta linha, ambas minhas:**
  (a) a asserção `this.threats` «mantém-se por explicar» já foi explicada e corrigida em `39f096d`
  — `ensureOfflineCoverage` repõe em memória as assinaturas embutidas em falta, portanto a base de
  teste é **aditiva** (1 da fixture + 3 embutidas = 4) e a expectativa `size === 1` estava errada;
  medido depois: 4 testes / 4 PASS / exit 0 (`logs/th-single-expect-fix.log`).
  (b) **a retirada «a suspeita de fuga de diretórios `qa3-recursive-*` não se confirma» estava
  errada e é retirada.** Estava correta às 10:59 (nada existia), mas a suíte completa das 11:14
  deixou **8** diretórios `packages/service/test/qa3-recursive-*` na árvore de origem. Causa: em
  `qa3-recursive-failures.test.js` o `mkdtemp` acontece **antes** de `controlledManager()`, e o
  `t.after` só é registado **depois** — um throw dentro de `controlledManager` deixava o diretório
  para trás. Corrigido em `2eadccb` (o sandbox VM não conhecia duas dependências reais do
  `scan-manager`: `./fixture-pin.js` e `@cybersafe/core`); medido isolado, **6 testes / 6 PASS /
  exit 0 e zero diretórios criados por essa run** (`logs/qa3-core-fix.log`). Os 8 + 4 órfãos foram
  removidos **um a um por nome explícito**, nunca com `git clean` nem com wildcard de árvore.
- Suíte `service` com total, pela primeira vez: **931 testes / 873 PASS / 58 FAIL / 0 SKIP** no
  HEAD `39f096d` (`logs/service-full-39f096d.log`). A distribuição tem **uma causa dominante e é de
  produto**: `KILL_TERMINATION_DISABLED = true` (`packages/service/src/engine.ts:748`, delta
  `f1-kill-disable-20261026`) faz `killProcess` devolver `failed` para qualquer PID antes de
  qualquer consulta. `process-kill.test.js` 42/12/**30 FAIL** e `kill-budget.test.js` 6/1/**5 FAIL**
  reproduzem os dois isoladamente e de forma determinística; no `kill-budget` a prova é literal —
  «o taskkill tem de correr, correu 0». Consequência documental: **a terminação de processos não
  é uma funcionalidade ativa nesta construção**, e o README dizia «Motores, serviço, API e Gestor
  de Tarefas: Funcionais». Essa linha está agora separada em três — listar/monitorizar (7/7
  medidos), terminar processo (NÃO FUNCIONAL, com a referência exata ao delta) e a garantia de que
  a interface não finge sucesso: `TaskManagerPage.tsx:579` mostra a mensagem do serviço com
  `ok: o.success`, e a pregação de sucesso em `processActions.ts:606` só aceita
  `killed`/`already-exited`. **Reativar o delta é decisão do proprietário** (a janela
  revalidação→`taskkill` não é atómica; o delta existe precisamente para não a fingir segura) e
  nenhuma asserção de teste foi afrouxada para esconder isto.
- **Re-medida a suíte completa no HEAD atual `9b7e823`** (`logs/service-full-9b7e823.log`):
  **931 testes / 137 suítes / 878 PASS / 53 FAIL / 0 SKIP / 0 TODO**, duração **210 510 ms**. Isto
  substitui a contagem de 58 e a frase «11 por classificar», e **retira a ideia de que a suíte
  precisa de um teto de duração para ser exequível em CI**: ela cabe em 210 s; o que impedia o total
  era a ausência de `dispose()`, não o tempo. Classificação por causa, medida e não inferida:
  **38 = portão de terminação** — `process-kill` 30, `kill-budget` 5, `kill-blocked-log` 2
  («pre-condicao: PID 4 e recusado» → `failed`; «esperava 4 linhas novas, obtive 0») e
  `p0-runtime-isolation` 1 (o `actions.log` do kill fica vazio), tudo porque o portão devolve antes
  de qualquer consulta e antes de qualquer `logKillBlocked`. **8 = `inconclusive` em ficheiro
  benigno** — `p1-3-prefetch-isolation` 7 e `scan-post-batch-no-double-clamav` 1; um `*.exe` no
  `%TEMP%` soma `dangerous_file_extension` + `suspicious_location` (15+15, `analysis.ts:207` /
  `scoring.ts`) e no caso do `scan-post-batch` é **um `.txt` no `%TEMP%`**, em que só a localização
  já chega. Consequência honesta: o marcador `safe` deixou de discriminar o isolamento, e as regras
  listadas por ficheiro são as do nome/caminho do próprio ficheiro — **não há aqui prova de que o
  defeito de isolamento tenha voltado**, mas há um facto de produto por decidir (ficheiro inofensivo
  em `%TEMP%` reportado como não-conclusivo). **4 = harness, por classificar** — `dev-canary` 2 com
  `Error: timed out waiting for condition` aos ~10 s e `dev-windows-readonly` 2 com
  `TypeError: Cannot read properties of undefined (reading 'status')`. **3 = asserções no eixo
  aposentado** — `scan-batch-terminal-reconcile`: exigem que `filesAnalyzed` suba com os terminais
  provados pelo **batch**, e desde a decisão datada de 2026-10-23 em `scan-manager.ts:1044-1048` a
  etapa do motor não escreve `filesAnalyzed` (promovê-los seria «afirmar cobertura que não existe —
  400 do batch contra 61 aceites»); o valor de etapa está em `filesInEngineBatch`. **Retiro a
  classificação anterior («possível defeito real, continua por explicar»): está refutada.** A
  leitura do código prova que os três resultados são o contrato coerente (`filesScanned=8`,
  `filesFailed=8`, `filesAnalyzed=0`, invariante `scanned = analisados+excluídos+falhados`
  verificada), não perda de integridade de resultados (§7). Falta decidir se as asserções são
  reescritas para o eixo vigente — e nessa reescrita têm de continuar a provar o que protegiam
  (reconciliação terminal do count do batch sem double count), sem serem afrouxadas.
- **Esse grupo está resolvido, e a reescrita foi medida.** `scan-batch-terminal-reconcile` passa
  **5/5 PASS, exit 0** isolado (`scanbatch-axis-rewrite.log`). As três asserções deixaram de exigir
  que `filesAnalyzed` suba com o batch e passaram a provar os dois eixos em separado: a
  reconciliação 7 → 8 no eixo da etapa, lida na linha `SCANMANAGER_BATCH_END` do tracing opt-in
  (`analyzedInBatch=8`, `outcomes=n/a` no contrato antigo), e a honestidade do eixo dos aceites —
  `filesAnalyzed` tem de continuar em `0` enquanto o loop rejeita todos, e `filesInEngineBatch`
  tem de mostrar `5` durante o batch e voltar a `0` no `finally`. **Nenhum teste ficou mais fraco:
  se alguém voltar a promover a etapa para `filesAnalyzed`, dois deles falham** — a versão anterior
  não era capaz de apanhar exatamente esse erro. O total da suíte `service` **ainda não foi
  re-medido** depois desta reescrita; a linha `878 PASS / 53 FAIL` é de `9b7e823`.
- **As 4 falhas de harness estão classificadas e corrigidas, com mudança só no fixture.**
  (i) `dev-windows-readonly` 2 × `TypeError … reading 'status'`: o duplo da linha 469 fazia
  spread de `servico.clamav`, e `health` é **getter do protótipo** de `ClamavBridge`
  (`core/src/clamav.ts:3087-3096`) — o spread perde-o e o `init()` real rebentava ao registar
  `engine-init clamavMs=… status=${this.clamav.health.status}` (`service/src/engine.ts:1007`).
  O teste já conhecia esta armadilha e resolvia-a para o YARA (linhas 459-468); faltava-lhe só
  no ClamAV. O duplo passou a declarar `health: { status: "unavailable", … }`, que é o estado
  que o próprio duplo simula (`isAvailable()` finge o clamscan ausente) e é valor real de
  `EngineSubsystemStatus` (`shared-types/src/index.ts:366`). Medido: **104/104** (antes
  102/104). (ii) `dev-canary` 2 × `timed out waiting for condition`: o scan completava
  (`status=completed`, `analyzed=2`) mas em **12,3 s** contra o orçamento de 10 s do `waitFor`,
  porque o fixture construía um `ClamavBridge` real e pagava a prova de carga do produto
  (`runLoadProof`, `core/src/clamav.ts:3336`, spawn `:3434`) — ~6 s de cold start antes do
  batch de ~6-7 s. A correção usa a costura que o próprio produto expõe
  (`loadProofEnabled: false`, decidido em `clamav.ts:3302`): **o `timeoutMs` de 10 s não foi
  tocado e nenhuma asserção foi afrouxada**; medido 6,4 s / 6,3 s. A cobertura da prova de
  carga não se perde com isto — vive em `core/test/clamav-load-proof-modes`,
  `clamav-load-proof-rev4`, `clamav-positive-load-proof-lifecycle` e
  `clamav-health-recovery` (existência verificada; o estado individual desses quatro ficheiros
  não foi re-medido aqui). Log da investigação: `qoder-investigation-canary-debug.log`.
- Estado do `ci` no `main` atualizado: run `41302290721` no SHA `9b7e823`, `conclusion: success`.
  A workflow continua a **não** correr a suíte `service` (corre a do desktop), por isso o verde do
  `ci` não cobre nenhuma das linhas acima.
- **Dois factos de âmbito que a suíte do pacote escondia**, medidos em `8653f39`:
  (i) o script `test` de `packages/service` **não corre a pasta `test/`** — lista 96 entradas de 147
  ficheiros, pelo que 20 das 66 falhas da pasta completa nunca aparecem no número que o `npm test`
  devolve; (ii) **não há motor nativo construído nesta linha** — `packages/native-engine/build` não
  existe, `npm run build:native` nunca foi corrido no worktree, e os `scan-engine.exe` em disco são
  artefactos de outras linhas (`freebuff2-packaging-p0-20261024`, `pap-autonomous-core-*-20261029`).
  Logo, os 4 `rc22-native-regressao` são `NOT RUN` travestido de `FAIL`, e §13 ponto 14
  (verificar dependências nativas do instalador) fica por poder cumprir até haver decisão de build.
  Os 5 SKIP têm motivo declarado no código (ambiente sem ClamAV/clamscan real, bundle não
  vendorizado, symlink indisponível no host, provider fora da lane); não afirmo quais os 5 que
  dispararam nesta corrida, porque o reporter não o imprime.
- **Retractação das duas asserções acima, medidas de novo em `42a2bfd`.** (a) «não há motor nativo
  construído nesta linha» **deixou de ser verdade**: `npm run build:native` foi corrido neste
  worktree a partir do código desta linha (`native-build.log`) e o `scan-engine.exe` produzido é
  exercitado sem mocks — `rc22-native-regressao` + `rc22-native-init-guard` passam **11/11**
  isolados. Os 5 `rc22` que falhavam eram de facto `NOT RUN`; deixaram de o ser. O reverso também é
  verdade e fica declarado: `packages/native-engine/build/` está em `.gitignore:9`, portanto um
  checkout limpo desta linha volta a ter essas 9 falhas. (b) «não afirmo quais os 5 que dispararam»
  **está ultrapassado** — os 5 são legíveis no log (`﹣ … # motivo`) e batem certo com o código:
  `session14-engine-native.test.js` 4 (`:60`, `:79`, `:103` «invocação real ainda não confirmada
  (degraded)», `:121` «binário presente não permite testar estado unavailable via bridge») e
  `fecho14-clamav.test.js:148` («Caso 7: clean via spawn mock — NÃO TESTÁVEL sem DB real»). Os 4 do
  `session14` **não são limite do host, são desenho do teste**: lêem `checkAvailability()` antes de
  qualquer invocação e o contrato só autoriza `active` depois de uma invocação comprovada, por isso
  o gate lê `degraded` e salta. (c) As 66 falhas desta linha baixaram para **54**, com reconciliação
  ficheiro a ficheiro na secção final.
- **GitHub Releases: zero, medido.** `gh api repos/MatrixChill/cybersafe-assistant/releases` → `[]`;
  `releases/latest` → `404 Not Found`; `git ls-remote --tags origin` → nenhuma `refs/tags/*`. Não
  existe **nenhum** artefacto publicado (nem R6 nem R7), o repositório é público (`isPrivate:
  false`) e `main` é a branch por omissão. Qualquer release é a primeira pública e depende da
  confirmação explícita do proprietário. O canal de atualizações devolve hoje «sem release» — estado
  correto de um canal vazio, não uma atualização disponível.
- Nota de mecanismo, para não repetir o erro: este worktree está na branch
  `pap/final-qoder-20261101`, não em `main`. `git push origin main` tentava empurrar um `main`
  local **7 commits atrás** do remoto e foi rejeitado por *non-fast-forward* — a proteção fez o seu
  trabalho, sem `--force` e sem `reset`. A integração correta é confirmar ancestralidade e
  `git push origin HEAD:refs/heads/main`, depois verificar com `git ls-remote`.
- Estado do `ci` no `main`: **VERDE, medido**. A run `41300363725` (SHA `596fbee`,
  2026-11-01T11:06Z, `conclusion: success`) passou em **todos os nove passos**, incluindo
  `Vendor YARA e manifesto de packaging` e `Suíte do desktop`. Nada nisto significa que o
  *packaging* esteja validado: o `ci.yml` não builda o native-engine, não provisiona ClamAV/YARA
  nem mede o payload do instalador — esses portões continuam locais/Windows e **PENDENTES**.
  O mesmo SHA verde está também confirmado na run `41300361007` (branch `pap/**`). O `ci` em
  `39f096d` estava em curso no momento desta medição. Construção do
  instalador R7, *tag* e *release*: **PENDENTES**.

## Estado das suítes medido em 2026-11-01

Números dos logs em `…\qoder-goal-final-20261101\logs\` — não uma contagem manual, e **nenhuma
linha significa «suíte aprovada»**.

| Suíte | Medido | Log |
|---|---|---|
| `api` (ficheiro do guard) | 32 PASS / 0 FAIL | `api-guard-fix.log` |
| `app` | 2849 testes / 2849 PASS / 0 FAIL | `app-post-guards.log` — re-medido neste estado. As 4 falhas de `re-app-eol.log` eram exatamente os 4 guards reescritos aqui; `re-app.log` (11 FAIL) ficou resolvido em `b01ef8f` |
| `service` | **INCOMPLETA — sem numerais** | `service-post-yara.log`: ~25 min sem resumo do `node --test`; último resultado observável `✖ critical (hash registado numa base de teste) entra em this.threats`. Sem crescimento do log entre 10:27 e 10:39 e delta de CPU 0 em 5 s nos processos `node` amostrados → processo terminado. 1 FAIL isolado, já documentado (`threat-history-storage.test.js`); o resto da suíte **não foi medido a este estado**. O `ENOENT` de «Recuperação do corpus YARA» já existia em `test-service.log` (08:54, antes das mudanças YARA) — não é regressão deste commit |
| `core` | 1099 testes / 1064 PASS / **4 FAIL** / 30 SKIP / 1 TODO | `core-full-post-yara.log` (re-medido neste HEAD; antes `re-core.log`: 1089 / 1029 / 34 FAIL / 25 SKIP) |
| `desktop` | 611 testes / 611 PASS / 0 FAIL | `test-desktop.log`; nas execuções imediatas seguintes, 628 / 627 PASS / 1 FAIL no portão `tsc --noEmit`, cuja linha em falta — o texto do código de erro `rate-limited` — entrou com `97469f1`; `tc3.log` já não regista erros |

As 34 falhas de `core` medidas em `re-core.log` baixaram para 4 por dois caminhos distintos, e os
dois são declarados separadamente:

- **30 → as 5 falhas do caminho YARA em memória passaram a SKIP justificado.** O harness
  `packages/core/test/fixtures/yara-av-denial.js` só salta quando mede em simultâneo a negação de
  leitura do alvo temporário pelo antivírus da máquina **e** um scan benigno funcional no mesmo
  motor; caso contrário o erro propaga-se e o teste continua a falhar. A asserção do positivo de
  controlo EICAR **não foi executada** nesta máquina — SKIP não é PASS.
- **as 4 de fila/vagas (`clamav-slot-priority.test.js`) continuam FAIL.** A atribuição anterior —
  «temporização» — foi retirada por medição: o `waitFor` da fila expira com o ficheiro isolado.
  Aquecer a sonda de prontidão (`isAvailable()`) no `beforeEach` elimina as expirações e as
  asserções substantivas falham mesmo assim (vagas consumidas por trabalho já cancelado,
  `clamscan` a nascer depois do cancelamento), com o tempo da suíte a subir de 70 s para 205 s.
  Estas quatro testes **não avaliam hoje o que declaram**; torná-los observáveis exige um ponto de
  injeção de prontidão em `ClamavBridgeOptions`, decisão adiada porque obriga a nova passagem da
  suíte `core` completa.

Os ficheiros que estavam modificados na árvore de trabalho por outro agente (testes em
`packages/core/test`, `packages/app/test` e `packages/core/src/yara-classic.ts`) foram revistos
linha a linha e **entram neste commit**; `yara-classic.ts` ganhou diagnóstico do `yara64` nos três
lançamentos de erro sem alterar o comportamento *fail-closed*. A suíte `service` não chegou a dar
um resumo neste HEAD — ver a linha `service` da tabela acima: é **INCOMPLETA**, não PASS.

---

## Motor nativo, cancelamento e cobertura re-medidos em `42a2bfd` (2026-11-01)

Três pontos do pedido do proprietário, cada um com a sua medição. **Nada aqui afirma que a R7 está
pronta**: instalador, atualização end-to-end e os portões humanos continuam pendentes.

### 1. O motor C++ foi compilado a partir desta linha e funciona

`npm run build:native` corrido neste worktree (`native-build.log`, `exit=0`) com CMake + MSVC a
partir de `packages/native-engine/CMakeLists.txt`. Produto: `build/Release/scan-engine.exe`,
324 096 bytes, SHA-256 `db92fe819dd44818d269cdfb13ed432ffc1b026c3a43b41d407e29b37d5588ed`.
**Nenhum executável de outra worktree foi reutilizado** — a árvore `build/` não existia antes desta
corrida (`.gitignore:9`, portanto também não chega por clone).

Funcionamento real, sem mocks, dois níveis:

- **Suíte**: `rc22-native-regressao` + `rc22-native-init-guard` **11/11 PASS** isolados
  (`native-after-build.log`). Cobrem fixture benigna com SHA-256 exacto, `double_extension` com
  score 20 e `level=safe`, ficheiro inexistente → `failure: "output"` e nunca `safe`, e a transição
  de `degraded` para `active` **só** depois de uma invocação comprovada.
- **Binário directamente no terminal**: `--version` → `cybersafe-scan-engine 0.1.0 (C++17)`; um `.txt`
  benigno → `file_size=22`, `entropy=3.6069`, `level=safe`; `notepad.exe` → `valid_pe=true`,
  `is_64=true`, `machine=34404` (0x8664), `sections=8`, `entropy=6.2092`, `level=safe`; ficheiro
  ausente → `level=error` com `reasons=["file_not_found"]`. O SHA-256 que o motor devolve para o
  `notepad.exe` (`468ffe12…577e`) **coincide byte a byte com `certutil -hashfile … SHA256`** — a
  prova de hash não depende da palavra do próprio motor.

Duas observações honestas, não corrigidas aqui. (i) O `--version` do C++ imprime `0.1.0`, fixo em
`src/main.cpp:11`, enquanto a identidade do produto vive em `product-version.json`
(`0.1.11-internal.pap-r7.20261031`): o binário não sabe a versão do produto, e isso aparece no
diagnóstico do instalador. (ii) O motor devolve `exit=0` também no caso `level:"error"`; a ponte não
usa o código de saída — decide pelo JSON — por isso não é um defeito observável, mas é uma
superfície frágil.

### 2. As três falhas de cancelamento eram um contrato mal lido nos testes, não defeito do produto

`scan-cancel-observability` falhava 3. O código está certo: `engine.ts:5002-5011` devolve
`{ success: desfecho === "cancelado" }`, e o comentário declara que o ACK confirma apenas um
cancelamento aceite. O `scanManager.cancelScan` devolve `"cancelado"` **só quando há uma nova
cancelação em curso**; para um `id` desconhecido ou um payload sem `id` devolve recusa. Os testes
esperavam `success: true` nesses dois casos — ou seja, afirmavam que o serviço confirmava algo que
não aconteceu. **Estava aposentado**; a asserção antiga passou a `{ success: false }` e os três
casos que precisavam de um scan real passaram a usar `iniciarScan(t)` em vez de `servoDeVerdade(t)`
(com o `id` correcto). Medido: **16/16 PASS** (`cancel-after-fix.log`), e as 3 falhas saíram da
suíte completa.

Distinção pedida: **nenhuma das três era limitação do ambiente** — eram contrato mal especificado
no fixture, com o produto a responder correctamente. Não houve mudança de comportamento de produto,
apenas de teste, e o comportamento que elas protegiam (não prometer cancelamento que não aconteceu)
fica agora asserido em vez de contradito.

### 3. Cobertura efetiva: os dois âmbitos, os 54 atribuídos e os 5 SKIP nomeados

Âmbito: `packages/service/package.json` lista **96 entradas**, a pasta `test/` tem **147 ficheiros**.
`npm test` não é a suíte. Os dois números coexistem: `npm test` = 46 FAIL; pasta completa em
`42a2bfd` = **1282 testes / 159 suítes / 1223 PASS / 54 FAIL / 5 SKIP** em 249 s, `node_exit=1`
(`service-full-nativenox.log`).

A queda 66 → 54 está reconciliada **ficheiro a ficheiro e por assinatura de asserção**, com 54
rodapés `test at test\…` a bater com os 54 `fail` do reporter:

| Causa | n | Distribuição |
|---|---|---|
| Portão de terminação (`KILL_TERMINATION_DISABLED = true`, `engine.ts:748`; `killProcess` retorna `failed` em `:3995` antes de qualquer consulta) | **49** | `process-kill` 30, `tp-f1-r1-identity` 10, `kill-budget` 5, `kill-blocked-log` 2, `p0-runtime-isolation` 1, `tp-f1-process-recovery` 1 |
| `inconclusive` vs `safe` em ficheiro benigno | **5** | `p1-3-prefetch-isolation` 3 (`:345`, `:397`, `:445`), `recovery-security-pipeline:26` 1, `scan-post-batch-no-double-clamav:148` 1 |

Dentro dos 49 há três assinaturas observáveis, não uma hipótese: 38 blocos com `actual`
`'failed'`/`false`/`undefined`/`''` contra estados que só a terminação produz (`protected`, `killed`,
`already-exited`, `alias-stub`, `reused`, `timeout`, `access-denied`), 10 blocos de contagem
(`0 !== 1`, `0 !== 4` — nenhuma query CIM, nenhuma tentativa) e 1 bloco com a mensagem literal do
portão (`tp-f1-r1-identity:297`). **Isto é funcionalidade desligada no produto, não instabilidade do
host** — a decisão de a reactivar é do proprietário (§23, task em aberto).

Os 12 que saíram entre `8653f39` e `42a2bfd` têm uma causa lida no código, não uma coincidência:
`engine.ts:3151` — `if (!nativeCompleted && analysis.verdict === "safe") analysis.verdict =
"inconclusive"`. Sem binário nativo, **nenhum veredicto benigno pode ser conclusivo**; com o motor
compilado, 4 casos de `p1-3-prefetch-isolation` (`:300`, `:323`, `:466`, `:494`) e os 5 `rc22`
voltaram a poder afirmar o que afirmam. Verifiquei se seria flutuação: `p1-3-prefetch-isolation`
isolado, três corridas seguidas, dá **sempre 8 PASS / 3 FAIL** nos mesmos três rodapés. As que saíram
saíram por causa; as que ficaram (agora com a regra extra `scan_inconclusive`, porque o ficheiro
perdeu o dono do prefetch e cai em `scanFile`) são o ponto de produto em aberto: um `.txt` em
`%TEMP%` não é reportado como analisado-conclusivo.

**Caveat que não retiro: `packages/native-engine/build/` é gitignored. Um checkout limpo desta
linha reproduz as 9 falhas dependentes do binário.** O 54 pressupõe o motor compilado, e é por isso
que o §13 ponto 14 (dependências nativas do instalador) precisa do build de distribuição, não deste.

### Suítes que nenhum comando padrão seleciona (item 3 do pedido, continuado)

A pergunta «que testes não são selecionados pelo comando padrão?» tem três respostas medidas nesta
linha, e a terceira continha uma falha real:

- **`scripts/test/` — 25 ficheiros, 240 testes, nenhum script os corre.** A raiz só expõe
  `test:build-order`, `test:dev-isolation` e `test:native`. Medido à mão: **240 / 37 suítes /
  234 PASS / 0 FAIL / 5 SKIP / 1 TODO**, `exit 0` (`scripts-test-after.log`). Os 5 SKIP são o
  inspetor de conteúdo do pacote (`app.asar` legível, runtime dentro do asar, módulos nativos fora
  do asar, nenhum caminho de build/máquina dentro do pacote, nenhum segredo/base/log/sourcemap) e
  todos dizem «sem artefacto para inspecionar». **É aqui que vive a verificação de inclusão de
  recursos do ponto 4: está escrita, é honesta, e hoje não corre porque não há artefacto** — o
  artefacto depende do `source-freeze` aprovado.
- **`native-windows` — o `npm test` lista 18 dos 28 ficheiros da pasta.** Pasta completa:
  **246 / 21 suítes / 246 PASS / 0 FAIL**, `exit 0` (`native-windows-full-after.log`).
- **`native-engine`** tem 25 vetores SHA-256/entropia (`npm run test:native`), todos verdes. Não
  confundo com a prova de que o binário funciona: essa é `rc22-native-regressao`, acima.

**A falha que só o âmbito completo apanha**: `process-enumeration-boundary.test.js:47` exigia
`/indisponível|CIM|zero registos/i` para o payload corrompido, mas o produto distingue três causas
(`src/index.ts:741` `spawn`, `:755` `parse`, `:797` `empty`) e a do JSON inválido é `parse`
(«JSON parse: payload de processos não é JSON utilizável»). O comportamento estava certo —
rejeitava, exatamente o que o teste declara —, a regex pertencia a outra fronteira. Fixei ao texto
real do contrato, o que é **mais estrito** do que a disjunção: quem misturar `parse` com `empty`
passa a rebentar aqui. Ficheiro isolado 6/6, pasta completa 246/246.

**O segundo achado é de produto, não de teste, e fica como decisão do proprietário (task #15)**: o
`scanner-dashboard-visibility.test.mjs` procurava as strings de UX em `DashboardPage.tsx`, que hoje
é um contentor de dados de 70 linhas — a apresentação vive em `v2/dashboard/LabDashboard.tsx` e
`components/visual/EngineGrid.tsx`. Reapontei as duas garantias que **existem** (legendas de
proveniência «os cartões mostram o que o serviço reportou» / «não são uma leitura atual dos
motores», «a ausência de leitura não significa que o histórico esteja vazio», limite de visibilidade
`.slice(0, 3)`, zero controlos de paginação) e **não apaguei a terceira**: o pointer «o histórico
completo está em Ameaças» perdeu-se na refactorização v2 (a shell navega pelo modelo `Page`,
`App.tsx:573`, sem `<a>`). Mantive a asserção verdadeira e marquei-a `{todo: …}` com a razão, para
que fique à vista como falha esperada e não como sucesso.

**Numeração do `service` atualizada com o motor presente**: o âmbito `npm test` deu **931 / 137 /
889 PASS / 42 FAIL** (`service-npmtest-d45c7b3.log`) contra os 46 publicados — a diferença de 4 é
exatamente `p1-3-prefetch-isolation`, o efeito de `engine.ts:3151` com o binário compilado. A pasta
completa mantém-se em 1282 / 1223 / 54 / 5.

### Canais de actualização e primeira release: o que está medido e o que é armadilha (itens 5 e 7)

Nada neste bloco afirma que a actualização está validada fim-a-fim — falta a chave pública do
proprietário. Afirma factos lidos no código e no endpoint.

- **O transporte funciona e o canal está vazio, não partido.** Sonda com o opener HTTPS real do
  produto (`node-transport.ts:createNodeHttpsOpener`) contra o URL pinado em `release-trust.json`:
  `status=404`, corpo `{"error":"Not Found"}` (21 bytes). Com `enabled:false`, o
  `createProductionUpdater` nem chega ao pedido — devolve `unconfigured` (provado em
  `updater-production-trust.test.mjs`, 5/5). A máquina completa do updater está coberta: o
  `scripts/test/` deu 240 testes / 0 FAIL, e o assinador e o verificador de produção canonizam os
  mesmos bytes (`release-signing-compat.test.mjs`).
- **Armadilha de nomenclatura, medida em `semver.ts`.** O `product-version.json` de hoje é
  `0.1.11-internal.pap-r7.20261031`: semver válido, **não** é core version. Por precedência SemVer,
  `isUpgrade("0.1.11", "0.1.11-internal.pap-r7.20261031")` dá **`true`** — publicar uma release
  `0.1.11` «seca» faria o updater oferecer como melhora o mesmo código, porque um núcleo sem
  pré-lançamento precede qualquer pré-lançamento dele. O caminho seguro também está medido:
  `…20261115 > …20261031` (identificadores numéricos comparam como números), logo **subir o sufixo
  de data chega para oferecer uma atualização**. `validateManifest` (`manifest.ts:60`) exige
  `isValidSemVer` e não `isCoreVersion`, por isso a versão canónica do produto pode viver no
  manifesto sem mudar nada no produto.
- **O manifesto fala de um canal que o produto não declara.** `manifest.ts:57` exige
  `channel: "stable"` literalmente, enquanto `product-version.json` diz `channel: "internal"`. A
  elegibilidade é do manifesto, não do produto (decisão `97469f1`). Não é incoerência de código, é
  duas vocabulários de canal em superfícies diferentes; fica dito em vez de ser «harmonizado» à
  pressa.
- **Não há ferramenta de checksums.** `grep -rln "SHA256SUMS|sha256sums|checksums" scripts/ docs/`
  devolve **zero** correspondências. O ponto 7 do pedido pede checksums; hoje só existiriam se
  alguém os corresse à mão com `certutil`, o que não é reprodutível. Recomendo um
  `scripts/release-checksums.mjs` (~30 linhas, mesmo formato `<hex>  <nome>`), e não o escrevo sem
  decisão porque é superfície nova de empacotamento, não correção.
- **Preparação da release existe como rascunho, fora do repositório**:
  `…\qoder-goal-final-20261101\release-prep\FIRST-RELEASE-PREP.md` — modelo de manifesto com os
  campos de artefacto por preencher, tabela do que depende de quê, rascunho das notas de lançamento a
  partir dos **49 commits** desde `01dcfaf`, e a lista do que continua desligado. Não é documento
  publicado nem `docs/`; enquanto não houver instalador, um `RELEASE-NOTES.md` no repo seria
  uma promessa.

### Item 4 ao limite do que se pode medir sem assinatura: pré-voo do `source-freeze`

Regra lida no próprio pipeline, para não deixar ambiguidade: **não há flag de bypass** — o
comentário em `scripts/package-windows.mjs:1237` diz «Não há flag de bypass nem re-pin silencioso»,
e `runFreezeGatedPipeline` corre `gate("PRE")` **antes** de `stages.workspaces()`. O marcador
`SOURCE-FREEZE-FAILED.json` (`markNotDeliverable`) só existe para a fase POS, depois do builder;
não é uma janela para compilar sem aprovação. A única coisa que falta ao NSIS é, portanto, o registo
de aprovação — e ele não é meu para escrever: `validateApproval` aceita um aprovador
(`APPROVER = "Codex Lead"`), e medi com a função exportada que um registo com
`approvedBy: "Qoder"` devolve `approval-invalid: approvedBy "Qoder" ≠ "Codex Lead"`. O cabeçalho de
`source-freeze.mjs` é explícito: «--approval é um registo operacional, não uma assinatura
criptográfica: a autoridade vem do **processo do integrador autorizado**, não do ficheiro».

Mesmo assim o pré-voo foi medido com as funções exportadas do próprio script
(`release-prep/freeze-readiness.mjs`, leitura apenas, nada escrito dentro do repositório):

- **8 raízes cobertas, 1 769 entradas, digest `1064f33c8a46b6a37c2bcc2f272bb28fa912bd862d1691fc93691672c795e22b`**,
  estável entre duas leituras da árvore — logo o gate não reprovaria por «ficheiro que muda durante
  a leitura». Distribuição: `packages` 1 199, `assets` 480, `scripts` 86, `package.json`,
  `package-lock.json`, `tsconfig.base.json`, `vendor` 1.
- `buildManifest` **não lançou** `recursos obrigatórios ausentes`: os dois ficheiros de licença
  exigidos mesmo em `--write` (`assets/licenses/THIRD-PARTY-NOTICES.txt`, `PROVENANCE.json`) estão
  presentes.
- `verifySourceFreeze` hoje devolve **exactamente um** problema: `manifest-missing` em
  `scripts/source-freeze.approved.json`. Um registo de aprovação com `approvedBy` correcto e
  `candidateId`/`approvedAt` preenchidos passa a validação (medi o exemplar com placeholders: zero
  problemas). **Tudo o que separa o dia em que o NSIS corre é uma decisão de identidade, não uma
  verificação técnica pendente.**

**Dois factos de contracto que a medição revelou e que importam à release:**

1. **`product-version.json` não está no conjunto congelado.** A política deste repositório declara
   esse ficheiro como «fonte canónica da versão do produto», injetada no manifesto empacotado e no
   renderer — e não aparece entre as 1 769 entradas do digest. Consequência concreta: duas builds a
   partir do mesmo digest aprovado podem ter versões de produto diferentes. O freeze fecha o
   conteúdo das fontes mas não fecha a identidade que o instalador publica. Recomendo adicionar o
   ficheiro às raízes cobertas; **não o fiz**, porque isso muda o digest e invalida qualquer
   aprovação já dada a este conjunto — é decisão do integrador/proprietário (task #17).
2. **`README.md`, `CHANGELOG.md` e `product-version.json` não são cobertos** (raiz só
   `package.json`, `package-lock.json`, `tsconfig.base.json`). Isto é útil: os meus commits de
   documentação não invalidam uma aprovação. Mas `package.json` **é** coberto, por isso qualquer
   mudança de dependência ou de script de workspace sim.

Nota operacional para quem correr `--write`: a árvore de trabalho tem `definitions/yara/default.yar`
marcado como modificado por diferença de fim-de-linha (LF→CRLF do checkout, já documentado e
deliberadamente não staged). O `--write` calcularia o digest contra essa árvore, portanto o
candidato sairia com `dirty` git e o ponto 4 do pedido («a partir de commit limpo») não ficaria
cumprido. Antes de aprovar convém resolver o EOL desse ficheiro, não ignorá-lo.

### Motores reais: o que só corre com opt-in, e o que isso muda na atribuição

A pergunta «os motores estão validados?» tinha uma resposta escondida no mesmo sítio que a
cobertura: **três provas reais estão atrás de flags de ambiente que nenhum comando default ativa.**

| Flag | Quem a usa | Estado quando ativada nesta linha |
|---|---|---|
| `CYBERSAFE_REAL_CLAMSCAN=1` | `core/test/rc22-motores-clamav`, `clamav-resource-cap`, `eicar-manual-opt-in`, `service/test/p1-3-prefetch-isolation`, `p1-4-cancel-before-controller` | `rc22-motores-clamav` **6/6 PASS** em 15,4 s (`clamav-real-optin.log`): o `clamscan.exe` vendorizado (ClamAV 1.5.4, `--version` = exit 0) carrega uma `.ndb` nossa e **deteta o marcador benigno**, deixando o ficheiro limpo; com a base oficial da app (14,8 s de init) também `active` e benigno limpo. **Sem EICAR escrito em disco** — a política está em `eicar-manual-opt-in.test.js` e existe porque o Defender do host bloqueia esses ficheiros. |
| `CYBERSAFE_REALDEV_FIXTURE_SCAN=1` | 9 ficheiros (`clamav-load-proof-modes`, `dev-windows-readonly*`, `rc22-native-init-guard`, `rc22-engines-yara-recovery-guard`, `individual-process-termination`, etc.) | não exercitado nesta corrida — fica declarado como por medir, não como passou |
| `CYBERSAFE_STAGING_E2E=1` | `scripts/test/staging-sqlite-runtime` | o próprio skip diz «define CYBERSAFE_STAGING_E2E=1 para correr (build de workspaces + npm install…)» — depende do build de distribuição, logo de #13 |

**YARA clássico já corre de verdade sem flag**: `engine-integrity`, `yara-classic-engine` e
`yara-engine-provenance` juntos dão **61 testes / 59 PASS / 0 FAIL / 2 SKIP**
(`yara-real-tests.log`), e os 2 SKIP são os casos em que o antivírus do host nega leitura do alvo
temporário — ambiente, não produto.

**A consequência para a atribuição das 54 falhas, medida e não inferida.** Como
`p1-3-prefetch-isolation` também lê `CYBERSAFE_REAL_CLAMSCAN`, usei-a como contra-experiência:
com o motor ClamAV **real** ligado, `p1-3` + `p1-4` dão 18 testes / 15 PASS / **3 FAIL** — os mesmos
três rodapés de sempre (`:345`, `:397`, `:445`) (`p13-p14-realclamscan.log`). Ou seja, **aquelas três
falhas não são limitação do ambiente nem ausência de motor**: com o motor verdadeiro a responder, o
veredicto continua `inconclusive` onde o teste espera `safe`. Ficam na classe da decisão #11
(«basta a localização `%TEMP%` para um ficheiro benigno deixar de ser conclusivo?»), e a pergunta ao
proprietário mantém-se exactamente como foi escrita.

Para o peso da palavra «FINAL»: dos quatro motores, três têm agora prova de execução real nesta
linha (nativo C++, YARA 4.6.0, ClamAV 1.5.4 — o último apenas via opt-in, que é por si um facto a
corrigir: uma prova que só existe quando alguém se lembra de a activar não é uma prova de suíte).
O quarto ponto em falta não é um motor: é o instalador, e esse depende de #13.

### A segunda flag opt-in não tapava um defeito: tapava dois testes mal isolados

`CYBERSAFE_REALDEV_FIXTURE_SCAN=1` corre 8 ficheiros (173 testes). Com a flag no ambiente, dois
casos falhavam — `individual-process-termination:42` e `dev-windows-readonly:523` — e nenhum dos
dois era defeito do produto. O produto **honra a flag de propósito**: `engine.ts:3934` trata
`CYBERSAFE_REALDEV_FIXTURE_SCAN === "1"` como sessão não-confiável e `:3938` devolve o veto
`critical-operation-or-untrusted-session`; e o comentário do próprio caso «USB=0 e RETOMA=0»
declara que nos modos readonly/fixture/teste o agendador de definições **continua a NÃO nascer**.
Os dois testes asseriam o comportamento do modo *normal* sem isolar o ambiente — ao contrário dos
seus irmãos no mesmo ficheiro, que apagam as variáveis à volta da asserção.

Correcções, ambas em fixture:

- `individual-process-termination.test.js:42` passou a isolar `CYBERSAFE_DEV_WINDOWS_READONLY` e
  `CYBERSAFE_REALDEV_FIXTURE_SCAN` como os irmãos fazem **e ganhou uma asserção nova**: com a flag
  ligada, `terminationBlocked()` tem de devolver o veto. A garantia do produto fica lockada em vez
  de ser apenas tolerada.
- `dev-windows-readonly.test.js` — `envOK()` é o helper partilhado por muitos casos e não pinava a
  flag de fixture; ficou com `CYBERSAFE_REALDEV_FIXTURE_SCAN: undefined` e
  `CYBERSAFE_REALDEV_FIXTURE_ROOT: undefined` no mapa base (o ficheiro já documenta que
  `process.env.X = undefined` NÃO apaga X — é `aplicarEnv` que apaga). Quem quiser a flag ON passa
  `...extra` e ganha.

**Medido nos dois sentidos, que é o que separa «passou» de «fica a passar»:** os dois ficheiros dão
**109/109 com a flag ON e 109/109 com a flag OFF**; o lote completo das 8 fichas passa de
164 PASS / 2 FAIL para **166 PASS / 0 FAIL / 7 SKIP**, `exit 0`
(`realdev-fixture-scan.log` → `realdev-fixture-scan-after.log`).

Os 7 SKIP que ficam são os casos que exigem *ainda mais* ambiente (base ClamAV oficial ausente,
symlink real, etc.) e não foram contados como PASS em lado nenhum.

### Ressalva ao número «54»: a contagem depende do modo de execução

Re-corri a pasta completa do `service` depois das correções de `4f6a0c9` e obtive **1282 / 1220 PASS / 57 FAIL**, não 54. Não foi regressão: os três a mais são `dev-canary` (2 falhas a **exactamente ~10 s**, o `timeoutMs = 10_000`) e `p0-rpc-queue` (1). Cada um deles passa isolado — `dev-canary` 2/2 e `p0-rpc-queue` 3/3 em três corridas seguidas. O que muda é a concorrência: 147 ficheiros em paralelo estouram orçamentos de tempo, e o `npm test` do pacote, que corre com `--test-concurrency=1`, deu **962 testes / 920 PASS / 42 FAIL**, o mesmo 42 do baseline anterior às mudanças (logo: sem regressão, e com +31 testes novos de feed de hashes a passar).

Publicar «54» sem dizer que a contagem depende do modo de execução foi um erro meu, e fica corrigido aqui e no `README.md`. A classificação por assinatura das causas mantém-se válida: 49 portão de terminação + 5 `inconclusive` contra `safe`; o que não é estável é o total, e dizê-lo é melhor do que fingir que é.

### Definições ClamAV no percurso REAL — primeiro fornecedor validado de ponta a ponta

Isto é uma **chamada real ao fornecedor** (espelho oficial `database.clamav.net`), feita de caso
num directório próprio fora do repositório (`clamav-real-db/`), sem tocar na base da aplicação, na
seed empacotada ou no perfil do utilizador. Config e argumentos vieram das funções do **produto**
(`ensureFreshclamConfig`, `buildFreshclamArgs`), não de linhas escritas por mim.

- **freshclam vendorizado, sem PATH**: `vendor/clamav/freshclam.exe` invocado por caminho absoluto;
  `resolveFreshclamExecutable` (`updater.ts:312-347`) fixa o irmão do `clamscan` empacotado — e é
  medido que o bundle publica o `freshclam.exe`: `ALLOWED_EXECUTABLES` e a lista
  `required = ["clamscan.exe","freshclam.exe","COPYING.txt"]` em `scripts/vendor-clamav.mjs:148,645`.
  As CVDs **não** vêm no instalador por decisão documentada (`:761): obtidas por freshclam, por
  utilizador. Isso separa também as duas coisas que o pedido exige distinguir: actualizar
  assinaturas (este caminho) ≠ actualizar o binário ClamAV (outro processo de distribuição).
- **Descarga real, 1ª passagem**: exit 0 em 16,6 s; 112 829 214 bytes em `main.cvd` (89 072 577),
  `daily.cvd` (23 447 611, versão remota 28171), `bytecode.cvd` (281 702) **com os `.sign`**
  correspondentes. Segunda passagem exit 0 sem reescrever o que já era igual — o comportamento
  estatuído que o pedido pede («sem alterações» é um resultado, não um erro).
- **Carga real e saúde**: com a prova de carga ACTIVADA (como em produção), o `ClamavBridge` do core
  sobre essa base real deu `isAvailable=true` (6,4 s), `health = active — "3 signature database
  file(s)"` e `scanFile` de um ficheiro benigno → `verdict: clean`, `status.active`. A base oficial
  de 112 MB carrega-se e usa-se, portanto, de facto.
- **A minha primeira leitura estava errada, e corrijo-a aqui**: na mesma corrida, com
  `loadProofEnabled: false`, o bridge devolveu `isAvailable=false` e `degraded` («a prova de carga
  falhou»). Não é defeito do produto — é o fail-closed dele a funcionar: sem prova de carga não se
  publica `active**. O que estava errado era a minha injecção. Ficou registado porque é exactamente o
  tipo de «degradado» que, lido à pressa, se transformaria num falso defeito na ficha.

Ainda **não** medido neste percurso: a preservação da base anterior quando o freshclam falha a meio
da descarga (requisito 1, pontos 4 e 5) e a recuperação de saúde depois dessa falha. O
`ClamDatabaseGate` (`updater.ts:362-420`) foi desenhado para isso e tem testes com duplos, mas
falta a variação com o fornecedor real a interromper-se. Task #19 fica em curso por essa razão.

### Interrupção REAL de uma descarga: as bases antigas sobrevivem, e a saúde mentia

Provoquei a falha que ainda não tinha provas (requisito 1, pontos 4 e 5): na base oficial já
descarregada em `clamav-real-db/database`, removi o `daily.cvd` para forçar uma descarga nova, lancei
o `freshclam` do produto e **matei o processo a meio** (SIGTERM aos 1,5 s). Script
`logs/real-clamav-interrupt.mjs`, log `real-clamav-interrupt.log`.

- **Preservação: cumpre-se.** Depois do kill não havia **nenhum** ficheiro parcial/temporário,
  `daily.cvd` estava ausente (não meio-escrito) e `main.cvd` continuava em 89 072 577 bytes. A
  atomicidade do próprio freshclam garante que uma descarga interrompida não corrompe a base que já
  existia — era o ponto 4, agora medido no fornecedor real e não num duplo.
- **Recuperação: cumpre-se.** Correr o freshclam até ao fim devolveu exit 0, o `daily.cvd` voltou, a
  classificação voltou a contar 3 ficheiros de base e o scan benigno saiu limpo.
- **O defeito que isto revelou:** nesse estado de base oficial **incompleta** (só `main.cvd`) o
  produto respondia `available=true`, `health = active`, «2 signature database file(s)». Quase toda a
  assinatura recente tinha desaparecido e o estado afirmava o contrário. É exatamente a confusão entre
  «existem ficheiros .cvd» e «há cobertura» que o comentário de `classifyClamavHealth` jura evitar — a
  regra parava em `dbs.length > 0 → active`.
- **Correção:** sem `daily`/`nightly` → `degraded` com o nome do que falta, mantendo
  `available=true` (o binário está lá e as bases que existem carregam-se). Não mudei contagem nem
  varrimento; mudei o que se afirma. Teste novo `core/test/clamav-health-base-incompleta.test.js`, 4
  casos (main sem daily → degradado; main+daily → active; `nightly` conta; local-only e vazio ficam
  como estavam), escolhido automaticamente pelo `npm test -w @cybersafe/core`, que usa glob — ao
  contrário do `service` e do `scripts/test`, que usam listas explícitas.
- **Medido depois da mudança:** 19/19 no classificador e na recuperação; `rc22-motores-clamav` com
  `CYBERSAFE_REAL_CLAMSCAN=1` continua **6/6**, exit 0. Nada na deteção mudou de comportamento.

Limitação honesta desta variação: o kill foi no `freshclam`, portanto provei o efeito de uma
interrupção na base; **não** provei o `ClamDatabaseGate` a serializar um scan em curso contra a
escrita (esse caminho continua só com testes de duplos), e não auditei o ramo `candidates` de
`classifyClamavHealth` — a correção foi feita no ramo `dbFiles`, que é o que a sonda real usa.

### Ramos do classificador ClamAV: a mesma regra nos dois, e as fixtures que escondiam o estado

A correção de `degraded` por base diária em falta foi feita no ramo `dbFiles`, que é o que a
sonda real usa. Ao correr a suíte `core` inteira apareceram **9 FAIL em vez dos 4 conhecidos** — cinco
deles provocados por mim, e vale a pena saber porquê em vez de os calar: as fixtures de
`clamav-db.test.js` descreviam uma base **incompleta por acidente** (só `main.cvd`, ou
`main.cvd`+`bytecode.cvd`), porque à data em que foram escritas o classificador não distinguia
conjunto completo de conjunto parcial. Um exemplo que decidia entre dois caminhos de prioridade
precisava mesmo era de uma base saudável.

Regra aplicada com a seed empacotada debaixo do braço: `CLAMAV_SEED_FILES = ["main.cvd","daily.cld","bytecode.cvd"]`
(`packages/service/src/clamav-seed.ts:15`), com pins de bytes e SHA-256 por ficheiro. Ou seja, o produto já
define internamente «base completa» como os três; a minha regra não inventou um requisito novo —
alinhámo-lo com o que o próprio pacote afirma. Corrigi as fixtures para o estado que cada teste
queria descrever, e **não** afrouxei as asserções: o caso «active exige ficheiros .cvd/.cld» passou a
separar as duas coisas que misturava (um arquivo oficial isolado é *reconhecido como oficial*, e
`main` sem `daily` é *degradado por falta de diária*), que antes eram a mesma asserção.

Depois disso: `core` = **1104 testes / 1069 PASS / 4 FAIL / 30 SKIP / 1 TODO** — os mesmos 4
`clamav-slot-*` que já estavam documentados como «não avaliam hoje o que declaram», e mais cinco
testes novos meus a passar. O ramo `candidates` recebeu a mesma regra, com caso próprio no ficheiro novo.

### Recarregamento efetivo, backoff por fonte e um ciclo por vez

Três coisas do requisito 4 e 6 que não existiam, agora com prova:

- **Recarregamento da HashDB dentro do motor.** `engine.ts:660-664` recarrega o
  `SignatureDatabase` quando `hashesUpdated`, e **nada o provava**: o core provava
  que `load()` lê o disco, o updater provava que o ficheiro é escrito. Faltava o
  meio — um hash novo podia estar em disco e nunca contar no processo. Novo
  `service/test/updater-reload-engine.test.js` constrói um `ProtectionEngineService`
  real, injeta o feed por duplo, corre `checkAndUpdate(true)` e afirma que
  `servico.signatures.match(novoHash)` existe **sem reiniciar nada**; o segundo
  caso afirma o inverso — sem alteração escrita não há recarga (`recargas === 0`),
  para que a recarga não passe a ser um custo pago por nada. Rede: nenhuma (YARA e
  freshclam recusados de caso pelo seam `spawnFreshclam`).
- **Backoff por fonte, com teto.** Uma fonte que falha passa a guardar
  `meta.falhas.<fonte> = {count, nextAllowedAtMs, lastError, lastAttemptAtMs}`,
  com espera = cadência da própria fonte × 2^(tentativas−1), teto de 6 h
  (`FALHA_BACKOFF_TETO_MS`). `componentStale` respeita essa janela, portanto
  `clamscan`/GitHub em baixo deixam de ser repicados a cada tick — e, sendo o
  histórico por fonte, **uma fonte em falha não esconde a saúde das outras** (o
  teste afirma mesmo `componentStale("yara") === true` enquanto `hashes` está em
  recusa). O primeiro sucesso limpa o histórico. É também o `lastError` que a UI
  do requisito 5 precisa para mostrar «última tentativa e respetivo erro».
- **Um ciclo de cada vez.** `activeOperations` contava mas não impedia: duas
  chamadas a `checkAndUpdate` escreviam sobre as mesmas bases em paralelo (o gate
  do ClamAV protege a LEITURA de uma escrita, não duas escritas). Agora o segundo
  pedido é **recusado com aviso explícito**, sem enfileirar trabalho que ninguém
  pediu.

Efeito colateral que vale a pena registar: a recusa apanhou uma falha minha do
passo anterior. `clamav-reprobe-after-update.test.js` caiu 3 vezes — não pela
concorrência, mas porque a sua fixture escrevia **só `main.cvd`**, e a nova regra
de completude a isso responde `degraded`. É a mesma classe de acidente das
fixtures do `clamav-db`: completude foi exigida tarde, e metade dos fixtures de
ClamAV no repo descrevem bases parciais sem querer (ficam listados por verificar:
`clamav-seed`, `clamav-load-proof-modes/rev4/real.integration`,
`clamav-positive-load-proof{,-lifecycle}` — os 6 correram **0 FAIL**, 24 SKIP são
os opt-in/AV, portanto não estavam a depender dessa forma).

**Medido depois de tudo:** `core` 1104 / 1069 PASS / **4 FAIL** / 30 SKIP / 1 TODO
(mesmo baseline) e `service` `npm test` 967 / 925 PASS / **42 FAIL** (mesmo
baseline, +5 testes novos a passar). Os `updater-*` a três dão 36/36.
