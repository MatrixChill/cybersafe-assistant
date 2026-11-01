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
  `TypeError: Cannot read properties of undefined (reading 'status')`. **3 = possível defeito real**
  — `scan-batch-terminal-reconcile`, contadores terminais a cair para `0`/`null` quando o batch
  provou 8: é o único grupo que pode ser perda de integridade de resultados (§7) e **continua por
  explicar**, não é dado como resolvido.
- Estado do `ci` no `main` atualizado: run `41302290721` no SHA `9b7e823`, `conclusion: success`.
  A workflow continua a **não** correr a suíte `service` (corre a do desktop), por isso o verde do
  `ci` não cobre nenhuma das linhas acima.
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
