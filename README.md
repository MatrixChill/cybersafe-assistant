<p align="center">
  <img src="assets/branding/generated/icon-128.png" alt="CyberSafe Assistant" width="112" height="112">
</p>

<h1 align="center">CyberSafe Assistant</h1>

<p align="center">
  Aplicação desktop de cibersegurança para Windows — análise de ficheiros com múltiplos motores,
  monitorização do sistema e resposta a ameaças, num único painel.
</p>

<p align="center">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-33-47848F">
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6">
  <img alt="Node" src="https://img.shields.io/badge/Node.js-%E2%89%A520-339933">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-10%2F11-0078D4">
  <img alt="Estado" src="https://img.shields.io/badge/estado-desenvolvimento%20académico-orange">
</p>

> **Projeto académico (PAP) em desenvolvimento.** Os instaladores internos usados nos testes
> **não estão aprovados para distribuição**. O CyberSafe Assistant **não substitui** o Microsoft
> Defender nem qualquer antivírus certificado, e **não garante deteção** de todo o malware.

> **Estado de versão e de artefactos (verificado em 2026-11-01).** As quatro afirmações seguintes
> não são a mesma coisa e por isso dizem-se separadamente.
>
> **1. Identidade canónica do produto no código: `0.1.11-internal.pap-r7.20261031`**
> (`channel: internal`, `codename: pap-r7`), em `product-version.json` na raiz. Esse ficheiro é a
> única fonte da versão: `scripts/app-version.mjs` injecta-a no manifesto da aplicação empacotada e
> no renderer (`__BUILD__`). As versões dos `package.json` de workspace — `0.1.1` na raiz, em `core`
> e em `service`; `0.1.2` em `app` e em `desktop` — **não são identidade do produto** e não devem
> ser lidas como tal. O `appId` não é definido ali.
>
> **2. O artefacto mais recente efetivamente construído e medido em disco é a candidata interna
> PAP R6** — `0.1.10-internal.pap-r6.20261031`. O ficheiro é
> `packages/desktop/release/candidate-20261031-215559-64b7245b/CyberSafe Assistant-0.1.10-internal.pap-r6.20261031-candidate-20261031-215559-64b7245b-setup.exe`
> (278 595 602 B), no worktree irmão `pap-freebuff-final-release-20261031`. O SHA-256 foi
> **recomputado nesta sessão** com `Get-FileHash` e devolveu
> `79340b7b95a444e955acad5858ef55caf9ba51cc7b41b954f9872fcb068b83a7` — igual ao registo em
> `PAYLOAD-MEASUREMENT.json`. Os metadados Windows medidos confirmam a versão correta no
> instalador (`FileVersion` e `ProductVersion` = `0.1.10-internal.pap-r6.20261031`) e o `__BUILD__`
> embutido no renderer é coerente com essa versão, pelo que a **incoerência de versões da R5 está
> fechada ao nível dos metadados**. O instalador **não está assinado**: `WinVerifyTrust` devolve
> `0x800b0100` (`TRUST_E_NOSIGNATURE`) e a tabela de certificados tem tamanho 0.
>
> **A gate manual continua em aberto.** Os próprios ficheiros da candidata registam o estado como
> `MEASURED_NOT_INSTALLED` e a handoff como `READY_FOR_VM_VALIDATION`, com a nota explícita de que
> «não houve instalação nem validação humana». A R6 foi construída, medida e verificada por hash —
> não foi instalada nem validada por uma pessoa neste registo. O primeiro ecrã do instalador deixa
> de depender do `installer.nsh` antigo (a R6 usa NSIS stock: `nsis: "STOCK_ASSISTED_INPUT_SAVED"`),
> mas a leitura textual desse ecrã só se confirma com execução manual, que não foi feita. Nada aqui
> se apresenta como ensaiado quando ainda precisa de um humano na máquina virtual.
>
> **3. Não existe qualquer instalador `0.1.11` / R7.** Não há ficheiro `*pap-r7*` em parte alguma:
> `packages/*/release/` não é versionado (`.gitignore`) e nem sequer existe neste checkout, e não
> há qualquer artefacto R7 nos diretórios de release locais. A identidade R7 vive no código; **a
> construção do instalador R7 está pendente**, tal como a sua instalação e ensaio manual.
>
> **4. O ficheiro da R6 é histórico e não é a versão final da PAP.** Não foi movido, renomeado nem
> eliminado, e não deve ser: é a prova reprodutível do estado medido em 2026-10-31. A R5
> (`0.1.10-internal.pap-r5.20261031`, 491 414 411 B, SHA-256 `46718bcd9c5ee712…b6e5bd75`, também
> recomputado nesta sessão) continua preservada como etapa anterior, com os defeitos de
> empacotamento e proveniência documentados em `docs/PAP-TRANSFERENCIA-20261031.md`.
>
> A correção do ciclo de vida da janela (`Object has been destroyed`) está no código (`isDestroyed()`
> nos caminhos de encerramento de `packages/desktop/src/main.ts`) e mantém-se. O instalador
> **0.1.9 (PAP R4)** não a continha e não representa o estado atual. Este repositório **não publica
> instaladores, bases de assinaturas nem releases**: não tem *tag* e não tem *release* no GitHub.
> O delta técnico posterior ao fecho documental do relatório está em [CHANGELOG.md](CHANGELOG.md).

---

## Índice

- [O que é](#o-que-é)
- [Funcionalidades](#funcionalidades)
- [Arquitetura](#arquitetura)
- [Tecnologias](#tecnologias)
- [Desenvolvimento](#desenvolvimento)
- [Testes](#testes)
- [Segurança e limitações](#segurança-e-limitações)
- [Melhorias futuras](#melhorias-futuras)
- [Documentação](#documentação)
- [Licença](#licença)

---

## O que é

O **CyberSafe Assistant** é uma aplicação desktop para Windows que reúne, num painel único:

- **análise de ficheiros** com vários motores independentes (YARA, base de hashes conhecidos,
  ClamAV e um motor nativo em C++);
- **monitorização** de processos, hardware e eventos de segurança do sistema;
- **quarentena** e resposta a ameaças, com histórico e relatórios exportáveis;
- **gestão do sistema** — gestor de tarefas (só leitura), PC Center, otimização e proteção USB.

O projeto nasce no âmbito do **Projeto de Aptidão Profissional (PAP)** do curso de
**Programador/a de Informática** da **Escola Profissional de Gaia** — formação de
programadores, **não** um curso de cibersegurança; a segurança é o domínio escolhido para o
produto. Serve simultaneamente como produto funcional e como evidência do processo de engenharia:
cada capacidade é implementada, testada e documentada, e o produto
**declara o que não sabe** em vez de simular estados (motores indisponíveis aparecem como
indisponíveis).

## Funcionalidades

### Implementado e coberto por testes

| Área | O que faz |
|---|---|
| **Scanner** | Análise rápida, personalizada e de ficheiro individual; progresso real, cancelamento, contagens de analisados / excluídos / inacessíveis |
| **Motores** | YARA (via `@litko/yara-x`), base de hashes maliciosos, ClamAV (binário oficial vendorizado) e motor nativo C++ (hash SHA-256, entropia, análise PE) |
| **Quarentena** | Isolamento com metadados, restauro controlado e política de confiança |
| **Histórico** | Sessões de análise persistidas com resultados, contagens e estado terminal |
| **Relatórios** | Relatório consolidado A4 exportável em PDF, com impressão como alternativa |
| **Gestor de Tarefas** | Processos com CPU/RAM; **terminação individual** de aplicações comuns, com confirmação, elegibilidade decidida pelo serviço e processos protegidos (CyberSafe e sistema) excluídos — indisponível em sessão de leitura |
| **PC Center** | Saúde do sistema: CPU, RAM, disco, bateria, GPU, temperatura e diagnósticos |
| **Monitorização** | Processos, hardware e eventos de segurança em tempo real |
| **Otimizar** | Sugestões de limpeza e otimização com base no estado medido |
| **Proteção USB** | Deteção de dispositivos, leitura apenas e análise de conteúdos |
| **MATRIX** | Assistente de segurança com consentimento explícito e chave própria (BYOK) |
| **Configurações** | Tema, identidade visual, arranque e preferências de proteção |
| **Atualizações** | Verificação de novas versões e estado honesto de disponibilidade |

### Parcialmente validado

- **Instalador NSIS personalizado** (4 ecrãs, verificação de espaço e caminho): construído e
  compilado offline, **sem execução real** — a validação final depende de instalação em VM.
- **Proteção em tempo real** (watchers e recuperação): lógica e testes automatizados presentes;
  comportamento em instalação real ainda em validação.
- **Motor nativo C++: sem build nesta linha, medido.** `packages/native-engine/build` não existe na
  árvore `pap/final-qoder-20261101` e `npm run build:native` (CMake, `package.json:16`) nunca foi
  corrido aqui. Os únicos `scan-engine.exe` encontrados em disco pertencem a artefactos de **outras**
  linhas (`freebuff2-packaging-p0-20261024-60m/…/resources/`,
  `pap-autonomous-core-freebuff-20261029/out/TP-VM016-ARCHIVE/EXTRACT/resources/` e mais três
  cópias de gate-runtime de 2026-10-29), que não são prova desta construção. Consequência directa:
  os 4 testes `rc22-native-regressao` falham por o binário não existir («+ 'unavailable' −
  'output'», cabeçalho do próprio teste: «scan-engine.exe real, sem mocks») — é **NOT RUN
  disfarçado de `FAIL`**, não comportamento partido; e o requisito de verificar dependências
  nativas do instalador (§13, ponto 14) não pode ser satisfeito antes de uma decisão de
  compilação.
- **Motor nativo C++**: integrado no serviço por *bridge* com estados de saúde explícitos; a
  comparação de resultados em cenários reais continua em avaliação.

### Planeado

- Gestor de exclusões com interface própria;
- Melhor desempenho em análises profundas (varrer e classificar sem esgotar o orçamento numa pasta);
- Diagnóstico mais detalhado de resultados inconclusivos;
- Compatibilidade gráfica alargada (DPI e aceleração em hardware variado);
- Instalador com validação completa em máquina limpa.

## Arquitetura

Monorepo npm (`packages/*`) com separação entre interface, orquestração, motores e serviço:

```
┌──────────────────────────────────────────────────────────────┐
│  packages/app        React + Vite + Tailwind (renderer)      │
└───────────────▲──────────────────────────────────────────────┘
                │ IPC seguro (contextBridge / preload)
┌───────────────┴──────────────────────────────────────────────┐
│  packages/desktop    Electron: main, preload, tray, splash   │
└───────────────▲──────────────────────────────────────────────┘
                │ named pipe JSON-RPC
┌───────────────┴──────────────────────────────────────────────┐
│  packages/service    orquestra scans, quarentena, USB,       │
│                      monitorização, histórico, atualizações  │
└───────▲───────────────▲──────────────▲───────────────▲───────┘
        │               │              │               │
 @cybersafe/core   native-windows   ClamAV         scan-engine.exe
 (YARA, hashes,    (PowerShell      (vendorizado)  (C++: hash,
  heurística,       read-only)                      entropia, PE)
  scoring)
```

| Pacote | Responsabilidade |
|---|---|
| `packages/app` | Interface (React 19, Vite, Tailwind), shell V2 e páginas |
| `packages/desktop` | Shell Electron, preload, IPC, tray, arranque e ciclo de vida |
| `packages/service` | Serviço Node: pipeline de análise, quarentena, USB, watchdog |
| `packages/core` | Motor lógico: YARA, hashes, heurística, scoring, ClamAV, hardware |
| `packages/native-windows` | Camada PowerShell **read-only** e watchers do Windows |
| `packages/native-engine` | Executável C++ (CMake): SHA-256, entropia, parsing PE |
| `packages/api` | API REST (Express + Prisma/SQLite) para contas e assistente |
| `packages/shared-types` | Contratos TypeScript partilhados (comandos/respostas do serviço) |
| `packages/extension` | Extensão de navegador para consciencialização de downloads |

Princípios aplicados no código:

- **veredictos não derivam de exit codes** — resultam de evidência medida;
- **estados incertos nunca são apresentados como seguros** (`unknown` ≠ `off` ≠ `protected`);
- **operações destrutivas** (terminar processos, eliminar ficheiros) passam por política explícita;
- **sem segredos no repositório** — chaves vivem em configuração local do utilizador.

## Tecnologias

| Camada | Tecnologias |
|---|---|
| Desktop | Electron 33, Vite, electron-builder (NSIS) |
| Interface | React 19, TypeScript 5.9, Tailwind CSS 4, Framer Motion, Radix UI |
| Serviço | Node.js (≥ 20), named pipes JSON-RPC, `node-windows` |
| Análise | `@litko/yara-x` (YARA), hashes SHA-256, ClamAV, motor nativo C++17 |
| Windows | PowerShell read-only, CIM/WMI, `systeminformation` |
| API | Express, Prisma + SQLite, JWT (bcrypt), SSE |
| Inteligência artificial | Fornecedor configurável pelo utilizador (chave BYOK) |
| Qualidade | `node --test`, `tsx`, TypeScript `--noEmit`, ESLint |

## Desenvolvimento

### Requisitos

- **Node.js ≥ 20** (recomendado 20 LTS ou superior)
- **Windows 10/11** — a monitorização e o serviço são específicos do Windows
- **CMake + compilador C++17** — apenas para o motor nativo
- **ClamAV para Windows** — obtido pelo script de vendorização (não é versionado)

### Instalação

```bash
npm install
```

### Executar em desenvolvimento

```bash
# Serviço, API, app e desktop em conjunto
npm run dev

# Ou individualmente
npm run dev:service
npm run dev:api
npm run dev:app
npm run dev:desktop
```

A janela Electron abre com o renderer servido pelo Vite; a API fica em `http://localhost:4000`.

### Build

```bash
npm run build:all          # pacotes pela ordem de dependências
npm run build:native       # motor C++ (CMake, Release)
npm run dist -w @cybersafe/desktop   # empacotamento Windows (local)
```

> O empacotamento gera instaladores **internos** (`NOT_FOR_DISTRIBUTION`). Não estão aprovados
> para distribuição e não devem ser publicados.

### ClamAV (vendorização)

O binário do ClamAV **não** está no repositório. O script `scripts/vendor-clamav.mjs` obtém o
pacote portátil oficial (Cisco/Talos), valida assinatura e digests, e prepara `vendor/clamav/`.
Sem esse passo, o motor ClamAV apresenta-se como indisponível — e o produto diz exatamente isso.

## Testes

Os testes usam o runner nativo do Node (`node --test`), com `tsx` onde há TypeScript.

```bash
npm test -w @cybersafe/core
npm test -w @cybersafe/service
npm test -w @cybersafe/app
npm test -w @cybersafe/desktop
npm test -w @cybersafe/native-windows
npm test -w api

npm run typecheck
npm run lint
```

Cada suíte cobre contratos reais do produto (pipeline de análise, quarentena, honestidade de
estados, segurança de *pipes*, ciclo de vida do arranque). Testes que dependem de hardware,
motores externos ou de uma instalação real estão fora do que a CI consegue provar — e são
marcados como validação manual.

**Estado dos testes.** O conjunto dirigido de autenticação, persistência, quarentena e *pipe*
(documentado em `PAP-EVIDENCIAS-TECNICAS/TESTES-AUTOMATICOS-VERIFICADOS.md`) dá **315 PASS / 1 FAIL /
0 SKIP** em 316 testes. O FAIL está identificado e explicado: a expectativa de
`threat-history-storage.test.js` ficou desatualizada face à reposição de assinaturas embutidas
(`ensureOfflineCoverage`), que é comportamento intencional do produto.

Na data desta revisão as suítes completas **foram** executadas, e **não estão todas verdes**. Os
números seguintes vêm dos logs dessas execuções — diretório de trabalho
`…\qoder-goal-final-20261101\logs\` — e não de uma contagem manual:

| Suíte | Medido | Observação |
|---|---|---|
| `api` | **Dois âmbitos com comando: `npm test` lista 25 de 33 ficheiros = 426 testes / 61 suítes / 426 PASS / 0 FAIL; `npm run test:full` (33 ficheiros) = 456 / 65 suítes / 456 PASS / 0 FAIL** | `api-suite-20261101.log`, medido a 2026-11-01 16:25 nesta linha, serializado. Antes a tabela só tinha uma linha «`api` (ficheiro do guard) 32 PASS» — era sub-representação: a pacote tinha 33 ficheiros de teste e 8 nunca eram selecionados por comando nenhum (`ag36-ai-runtime`, `ag36-parent-config`, `auth-session-restart`, `dev-parent-shutdown`, `file-scan-archive-contract`, `health-payload`, `r7-sample-events`, `upload-limits`, 30 testes no total). Os 8 passam **todos**; incluo `test:full` para que a afirmação seja reproduzível em vez de confiada. Contexto: `guard` verde após `9edd92c` (`api-guard-fix.log`). |
| `app` | 2857 testes / 2857 PASS / 0 FAIL | re-medido em `635bcbc` com `--test-concurrency=1` (`logs/app-post-definitions-ui.log`). Antes era 2849/2849: os +8 são a apresentação do estado por fonte (`definitions-status-presentation.test.ts`) e a asserção de que a renderização sem ponte não afirma nada sobre as bases. O `eslint` desta suíte devolve 2 erros **pré-existentes** (`ProcessSnapshot` não usado em `electron.d.ts:14`; `react-refresh/only-export-components` em `desfechoVerificacaoDisco`) — contados no `HEAD`, não introduzidos por este trabalho. As 4 falhas de `re-app-eol.log` eram exatamente os 4 guards reescritos (`scanner-v2-visual`, `task-manager-detail`, `toast-engine-contract`, `v2-shell-layout-guard`); cada um passou a afirmar o invariante no caminho de código vivo em vez de fixar um ponteiro. Verde **neste** estado; as 11 falhas anteriores vinham do EOL do checkout e foram corrigidas em `b01ef8f` |
| `core` | 1104 testes / 1069 PASS / **4 FAIL** / 30 SKIP / 1 TODO | re-medido neste HEAD depois da correção YARA — `core-full-post-yara.log` (antes: `re-core.log`, 1089 / 1029 / 34 FAIL). As 5 falhas do caminho YARA em memória passaram a **SKIP justificado** (`packages/core/test/fixtures/yara-av-denial.js`): o `yara64` não abre o alvo temporário quando o conteúdo é o positivo de controlo, mas o mesmo motor avalia um buffer benigno — o SKIP só acontece com as duas medições em simultâneo e a asserção do positivo não é executada; **SKIP não é PASS**. As 4 que ficam são a fila/vagas de `clamav-slot-priority.test.js` e **continham uma afirmação falsa neste README**: a atribuição a «tempos de timeout» foi retirada porque o `waitFor` da fila expira com o ficheiro isolado; aquecer a sonda de prontidão elimina as expirações e as asserções substantivas falham mesmo assim, com o tempo da suíte a subir de 70 s para 205 s. Nenhuma das duas é apresentada como resolvida |
| `desktop` | **633 testes / 98 suítes / 633 PASS / 0 FAIL** | medido a 2026-11-01 16:17 nesta linha (`4b860dc`+). Antes na tabela: 611/611 (`test-desktop.log`), depois 628 / 627 PASS / 1 FAIL — a falha era o portão `tsc --noEmit`, cuja linha em falta (o texto do código de erro `rate-limited`) entrou com `97469f1` (`tc3.log` já não regista erros). O crescimento 611→633 vem dos gates de IPC desta linha (canal `service:get-definitions-status` e capacidades do preload, registados com justificação em `r6-l13-ipc-security.test.mjs`, não afrouxados). |
| `service` | **Dois âmbitos, medidos separadamente: `npm test` = 973 testes / 144 suítes / 931 PASS / **42 FAIL** (`service-npmtest-3fe1fa9.log`, re-medido com o motor nativo presente); `npm run test:full` (pasta inteira, 151 ficheiros) = 1330 testes / 168 suítes / 1271 PASS / **54 FAIL** / 5 SKIP** em 313 s (`service-full-b6f5546.log`) | medido em `42a2bfd` com o `scan-engine.exe` **compilado a partir do código desta linha** — `service-full-nativenox.log`. **Âmbito primeiro e incómodo: o script `test` do `packages/service` não corre a pasta `test/`**; corre 96 entradas explícitas contra 151 ficheiros de teste, logo 55 ficheiros nunca aparecem no número que `npm test` devolve — é exatamente por isso que existe `test:full`. Os 46 anteriores eram o âmbito do `npm test` **sem o motor nativo**; a diferença de 4 é exatamente `p1-3-prefetch-isolation`. **A queda de 66 para 54 está reconciliada ficheiro a ficheiro (com a ressalva medida abaixo), e os blocos batem certo: 54 rodapés `test at test\…` = 54 `fail` do reporter.** As 12 que saíram são (i) `rc22-native-regressao` 4 + `rc22-native-init-guard` 1, (ii) `p1-3-prefetch-isolation` 4 (`:300`, `:323`, `:466`, `:494`) e (iii) `scan-cancel-observability` 3, essas corrigidas em `8236e34`. (i) e (ii) partilham uma causa que está no código: `packages/service/src/engine.ts:3151` — `if (!nativeCompleted && analysis.verdict === "safe") analysis.verdict = "inconclusive"`. Sem binário nativo nenhum veredicto benigno pode ser conclusivo; com o binário construído, a asserção de isolamento volta a discriminar. **RESSALVA DE MODO DE EXECUÇÃO, obtida depois de publicar o 54:** a mesma pasta completa re-corrida em `22ac7a2` deu **57 FAIL**, e os 3 a mais são `dev-canary` (2) e `p0-rpc-queue` (1) — todos passam isolados (`dev-canary` 2/2; `p0-rpc-queue` 3/3 x3) e os dois do canário rebentam em exactamente ~10 s, o orçamento `timeoutMs = 10_000`, quando 147 ficheiros correm em paralelo. O `npm test` do pacote usa `--test-concurrency=1` e dá **962 testes / 920 PASS / 42 FAIL** (mesmo baseline de 42 antes das últimas mudanças, portanto sem regressão). Ou seja: a contagem da pasta completa depende do modo de execução; os 54 são o valor de corrida concurrente, e omiti-lo foi um erro meu. **Não é inferência nem flutuação: `p1-3-prefetch-isolation` executado isolado três vezes dá sempre 8 PASS / 3 FAIL (`:345`, `:397`, `:445`).** `packages/native-engine/build/` está em `.gitignore:9`, por isso **um checkout limpo desta linha reproduz as 9 falhas dependentes do binário** — o número de 54 pressupõe o motor nativo compilado. **As 54 que ficam, agrupadas pela assinatura da asserção e não pelo nome do ficheiro:** (a) **49 — portão de terminação**, `KILL_TERMINATION_DISABLED = true` (`engine.ts:748`) faz `killProcess` devolver `failed` em `:3995` antes de qualquer consulta e qualquer `logKillBlocked`: `process-kill` 30, `tp-f1-r1-identity` 10, `kill-budget` 5, `kill-blocked-log` 2, `p0-runtime-isolation` 1, `tp-f1-process-recovery` 1. A assinatura no log é a do portão: 38 blocos com `actual` `'failed'`/`false`/`undefined` contra estados que só a terminação produz (`protected`, `killed`, `already-exited`, `alias-stub`, `reused`, `timeout`, `access-denied`), 10 blocos de contagem `0 !== 1` / `0 !== 4` — nenhuma query CIM, nenhuma tentativa — e um bloco com a mensagem literal `Terminação de processos indisponível: identidade não pode ser provada de ponta a ponta` (`tp-f1-r1-identity:297`). **É funcionalidade desligada no produto, não instabilidade do host.** (b) **5 — `inconclusive` contra `safe`**: `p1-3-prefetch-isolation` 3 (aqui com a regra extra `scan_inconclusive`, porque o ficheiro perdeu o dono do prefetch e cai no `scanFile`), `recovery-security-pipeline:26` 1 e `scan-post-batch-no-double-clamav:148` 1 (um `.txt` em `%TEMP%`: só a localização chega para o veredicto deixar de ser conclusivo). É o ponto de produto por decidir, não uma falha de harness. **Os 5 SKIP têm agora correspondência exacta**, lida do log e do código: `session14-engine-native.test.js` 4 — `:60`, `:79`, `:103` «invocação real ainda não confirmada (degraded)» e `:121` «binário presente não permite testar estado unavailable via bridge» — e `fecho14-clamav.test.js:148` «Caso 7: clean via spawn mock — NÃO TESTÁVEL sem DB real». **Os 4 do `session14` não são limite do ambiente, são desenho do teste**: o ficheiro lê `checkAvailability()` antes de qualquer invocação e o contrato só permite `active` depois de uma invocação comprovada, portanto o gate está condenado a lê-lo `degraded`. A prova funcional real do binário não está ali — está em `rc22-native-regressao`, que spawns o `scan-engine.exe` sem mocks e passa 11/11 isolado (SHA-256 exacto de fixture benigna, `double_extension` com score 20, ficheiro inexistente → `failure=output` e nunca `safe`, e a transição para `active` só depois da invocação). Nada foi afrouxado para chegar a estes números e **nenhum SKIP ou FAIL é apresentado como PASS** |
| `scripts` (empacotamento, `source-freeze`, preflight) | **392 testes / 64 suítes / 386 PASS / 0 FAIL / 5 SKIP / 1 TODO** / `exit 0` — `npm run test:scripts` (11 s) | A linha tem **dois** conjuntos que nenhum comando padrão corria: os 26 ficheiros de `scripts/test/` e os 8 `scripts/*.test.mjs` co-localizados. Desde este commit há `test:scripts`, que lista os dois com glob citado pelo próprio Node (o `--test` deste runtime não aceita um diretório como argumento). Medido em `logs/test-scripts-runner.log`, `--test-concurrency=1`, 10,8 s. Antes dava **240 / 234 PASS / 0 FAIL / 5 SKIP / 1 TODO** (`scripts-test-baseline.log`) só com `scripts/test/`; os +143 trouxeram **1 falha real de contrato envelhecido**: `dev-isolated-boot-contract.test.mjs` afirmava que o gate do API *aceitaria* a porta 4000, e `3a95692` (2026-10-30) passou a recusá-la — como nada corria o ficheiro, a premissa apodreceu em silêncio. O caso atualizado assere agora o invariante mais forte (recusam as duas camadas, cada uma por si) e o conjunto fica em 0 FAIL. Os 5 SKIP são **todos** do mesmo género e dizem diretamente ao ponto 4 do pedido: `o app.asar do último build é legível`, `o runtime que a aplicação precisa está dentro do asar`, `os módulos nativos estão FORA do asar`, `BITE: nenhum caminho do build nem da máquina dentro do pacote`, `não há segredos, bases de dados, logs nem sourcemaps no pacote` — todos com «sem artefacto para inspecionar», mais um `staging de produção` que exige `CYBERSAFE_STAGING_E2E=1`. **Ou seja: a verificação de inclusão de recursos no instalador já está escrita e é honesta; está `NOT RUN` porque não há artefacto, e o artefacto depende do `source-freeze` aprovado.** O 1 TODO é uma asserção real que falha de propósito: `scanner-dashboard-visibility` descobriu que a garantia de UX do ecrã de proteção vive hoje em `v2/dashboard/LabDashboard.tsx` + `components/visual/EngineGrid.tsx` (o `DashboardPage.tsx` de 70 linhas é só contentor de dados), e que o pointer «o histórico completo está em Ameaças» **se perdeu** na refactorização v2 — a shell navega pelo modelo `Page` (`App.tsx:573`), não por `<a>`. Mantive a asserção, marquei `todo` com a razão, e não a apaguei: ver task #15. | `o app.asar do último build é legível`, `o runtime que a aplicação precisa está dentro do asar`, `os módulos nativos estão FORA do asar`, `BITE: nenhum caminho do build nem da máquina dentro do pacote`, `não há segredos, bases de dados, logs nem sourcemaps no pacote` — todos com «sem artefacto para inspecionar», mais um `staging de produção` que exige `CYBERSAFE_STAGING_E2E=1`. **Ou seja: a verificação de inclusão de recursos no instalador já está escrita e é honesta; está `NOT RUN` porque não há artefacto, e o artefacto depende do `source-freeze` aprovado.** O 1 TODO é uma asserção real que falha de propósito: `scanner-dashboard-visibility` descobriu que a garantia de UX do ecrã de proteção vive hoje em `v2/dashboard/LabDashboard.tsx` + `components/visual/EngineGrid.tsx` (o `DashboardPage.tsx` de 70 linhas é só contentor de dados), e que o pointer «o histórico completo está em Ameaças» **se perdeu** na refactorização v2 — a shell navega pelo modelo `Page` (`App.tsx:573`), não por `<a>`. Mantive a asserção, marquei `todo` com a razão, e não a apaguei: ver task #15. |
| `native-windows` | **Dois âmbitos com comando cada um: `npm test` lista 18 de 28 ficheiros; `npm run test:full` corre a pasta inteira = 246 testes / 21 suítes / 246 PASS / 0 FAIL** (`exit 0`, 92 s) | `test-full-20261101.log`, re-medido nesta linha a 2026-11-01 15:42 (antes: `native-windows-full-after.log`). O mesmo padrão do `service`: a lista explícita esconde ficheiros. **Havia cá uma falha real e invisível ao comando do pacote**: `process-enumeration-boundary.test.js:47` asseria `/indisponível\|CIM\|zero registos/i` sobre o ramo de payload corrompido, mas o produto distingue três causas (`spawn` / `parse` / `empty`, `src/index.ts:741/755/797`) e a do JSON inválido é `parse` — «JSON parse: payload de processos não é JSON utilizável». O comportamento estava correcto (rejeitava, como o teste exige); a regex é que pertencia a outra fronteira. Fixei-a ao texto real do contrato, o que é **mais estrito** do que a disjunção anterior: misturar `parse` com `empty` passa a rebentar aqui. 6/6 no ficheiro isolado antes e depois. |
| `native-engine` (JS) | 25 testes / 25 PASS / 0 FAIL | `npm run test:native` → `packages/native-engine/test/hash-vectors.test.js`. Vetores de SHA-256/entropia do motor C++; a prova de que o binário *funciona* está em `rc22-native-regressao` (suíte `service`), não aqui. |

**Como reproduzir cada número** (nem tudo está no comando por omissão — é esse o
ponto 3 do pedido):

```
npm test -w @cybersafe/core            # 1104 (lista explícita do pacote)
npm test -w @cybersafe/service         #  973 / 931 PASS / 42 FAIL  ← 96 ficheiros listados
npm run test:full -w @cybersafe/service    # 1330 / 1271 PASS / 54 FAIL / 5 SKIP (151 ficheiros)
npm test -w @cybersafe/desktop         #  633 / 633 PASS
npm test -w @cybersafe/app             # 2857
npm run test:scripts                   # 392 — scripts/test/ + scripts/*.test.mjs
npm run test:release-checksums         #   7
npm run test:native                    #  25 vetores do motor C++
npm run test:full -w @cybersafe/native-windows   # 246
npm test -w @cybersafe/api               #  426 / 426 PASS
npm run test:full -w @cybersafe/api        #  456 / 456 PASS (33 ficheiros)
```

O `--test-concurrency=1` já vai dentro dos comandos novos; os números dependem do
modo de execução (a mesma pasta do `service` dava 57 FAIL em corrida paralela e 42
serializada), por isso é que o modo está escrito no comando e não só no log.

**Provas reais atrás de flags de ambiente — medido, não assumido.** Três verificações que usam os
binários verdadeiros não são corridas por nenhum comando por omissão: `CYBERSAFE_REAL_CLAMSCAN`
(5 ficheiros), `CYBERSAFE_REALDEV_FIXTURE_SCAN` (9 ficheiros) e `CYBERSAFE_STAGING_E2E` (1). Com
`CYBERSAFE_REAL_CLAMSCAN=1`, `rc22-motores-clamav` dá **6/6 PASS** — o `clamscan.exe` vendorizado
(ClamAV 1.5.4) carrega uma `.ndb` nossa e deteta o marcador benigno, deixando o ficheiro limpo, sem
qualquer byte de EICAR em disco. YARA 4.6.0 já corre de verdade sem flag (`engine-integrity` +
`yara-classic-engine` + `yara-engine-provenance`: 61 testes / 59 PASS / 2 SKIP de ambiente). O
contra-experimento interessa à atribuição das falhas: `p1-3-prefetch-isolation` lê essa mesma flag,
e com o motor ClamAV real ligado mantém **os mesmos 3 FAIL** — logo não são limitação do ambiente
nem falta de motor, e a pergunta de produto (#11) mantém-se. Uma prova que só existe quando alguém
lembra de a activar não é prova de suíte: ficar à espera de opt-in é uma decisão por tomar.

**Workflow `ci` no `main`: VERDE, medida.** A run atual é `41302290721` (SHA `9b7e823`,
2026-11-01T11:31Z, `conclusion: success`); a anterior, `41300363725` (SHA `596fbee`), tinha passado
os nove passos — instalação de dependências, `build:all`, assinatura de release, vendor YARA e
manifesto, YARA clássico e proveniência, e a suíte do desktop. Isso **não** é *packaging*: a
workflow não compila o native-engine, não provisiona ClamAV/YARA nem mede o payload do instalador;
esses portões são locais/Windows e continuam pendentes. A workflow **não corre a suíte `service`**
— os números acima são medições locais nesta máquina. Até há poucas horas esta workflow estava
vermelha: o `npm ci` do runner exigia entradas `@emnapi/*` que o lock não tinha, e seis testes do
vendor assumiam um `%TEMP%` canónico que o runner não providesse (forma 8.3).

**GitHub Releases: zero, medido.** `gh api repos/MatrixChill/cybersafe-assistant/releases` devolve
`[]`, `releases/latest` devolve `404 Not Found` e `git ls-remote --tags origin` não lista nenhuma
`refs/tags/*`. Portanto **não existe artefacto publicado** — nem R6, nem R7 — e qualquer release
que venha a ser criada é a primeira pública, o que exige a confirmação explícita do proprietário
sobre versão, canal e distribuição. A repositório é público (`isPrivate: false`), com `main` como
branch por omissão. O atualizador, a consultar este canal hoje, recebe «sem release»: o estado é de
canal vazio, não de atualização disponível.

Nenhuma destas linhas significa «suíte aprovada», e a contagem agregada do repositório não é
declarada como verde.

### Ensaios manuais em máquina virtual (candidatas R5 e R6)

A tabela separa **o que foi comunicado** por quem executou o ensaio manual do **que está
verificado por evidência neste repositório**. Nenhum resultado manual é apresentado como
verificado quando não existe registo — e o ensaio manual reporta-se à R5; para a R6 os próprios
ficheiros da candidata dizem `MEASURED_NOT_INSTALLED` (ver topo deste README). Os logs citados
**não estão versionados** (`*.log` é ignorado pelo `.gitignore`): vivem na máquina de
desenvolvimento em `PAP-EVIDENCIAS-TECNICAS/logs/` e o que fica no repositório é o elenco de
*digests* em `PAP-EVIDENCIAS-TECNICAS/EVIDENCIAS-LOCAIS.sha256`, que os cobre.

| Ensaio | Resultado comunicado (manual, VM) | Evidência verificável neste repositório |
|---|---|---|
| EICAR detetado e enviado para quarentena | Detetado e isolado | Testes automatizados de EICAR em YARA, base de hashes e ClamAV (`packages/core/test/*eicar*`, `clamav-*`, `yara-*`); **não** existe log da execução manual |
| Restauro a partir da quarentena | Ficheiro restaurado | `service-r5-quarantine-restore-result` 5/5 e `core-quarantine-restore-safety` 6/6 (logs locais, com digest em `EVIDENCIAS-LOCAIS.sha256`) |
| Persistência após reinício (conta, histórico, quarentena, consentimentos) | Mantida | `auth-session-restart` 1/1, `r6-l11-persistence` 5/5, `r7-l3-history` 17/17, `core/recovery-quarantine` 7/7 |
| Encerramento sem `Object has been destroyed` | Deixou de se reproduzir | Correção no ciclo de vida da janela (`isDestroyed()` nos caminhos de encerramento de `packages/desktop/src/main.ts`) e suíte desktop 611/611 medida (`test-desktop.log`) |
| Motores, serviço e API | Funcionais | Testes por área (ver `PAP-EVIDENCIAS-TECNICAS/`); a execução no instalador não tem log neste repositório |
| Gestor de Tarefas — **listar e monitorizar** | Funcional | `processes.list` reconciliada a pedido: 7/7 PASS em `process-kill.test.js` (suíte «processes.list — verdade do SO reconciliada a pedido»), medida isolada `processkill-alone.log` |
| Gestor de Tarefas — **terminar processo** | **NÃO FUNCIONAL nesta construção** | `KILL_TERMINATION_DISABLED = true` em `packages/service/src/engine.ts:748` recusa todo e qualquer PID antes de qualquer consulta (delta `f1-kill-disable-20261026`: a janela revalidação→`taskkill` não é atómica, e o delta desativa em vez de fingir segurança). 35 falhas de teste vêm daí e estão explicadas acima. A interface **não finge sucesso**: `TaskManagerPage.tsx:579` mostra a mensagem do serviço com `ok: o.success`, e a pregação de sucesso em `processActions.ts:606` só aceita `killed`/`already-exited`. Reactivar é decisão do proprietário, não deste commit |

**Efeitos 3D na máquina virtual — limitação real, não defeito.** O `CoreScene` só é montado quando
`gpu` está ligado (`gpu = webgl && !lowPower`). Com o perfil de desempenho em `auto` e **4 ou menos
CPUs lógicas** — o caso da VM usada nos ensaios — o perfil é tratado como económico, o `gpu` fica
desligado e a cena 3D **nunca é montada**: fica o orbital estático, sem mensagem de erro. Não é uma
regressão de WebGL; se o WebGL falhasse com `gpu` ligado, apareceria «Variante estática · 3D
indisponível». O comportamento não foi alterado antes da PAP e continua por explicar na interface.

## Segurança e limitações

- **Não é um antivírus certificado.** Não substitui o Microsoft Defender e não oferece garantia
  de deteção; a ausência de deteções não prova que um ficheiro seja seguro.
- **Windows-only.** A monitorização, o serviço e o empacotamento assumem Windows.
- **Chaves externas** (VirusTotal, fornecedor de IA) são configuradas localmente pelo utilizador;
  nunca são incluídas no repositório.
- **Operações destrutivas** (terminar processos, eliminar/quarentenar) são limitadas por política;
  um administrador malicioso continua a poder contornar a proteção em *user-mode*.
- **Limites de cobertura:** orçamento de ficheiros por análise, exclusões de sistema e formatos
  não suportados são declarados nos resultados (analisados / excluídos / inacessíveis).
- **Instaladores internos** não são distribuíveis e não substituem um processo de assinatura.
- **Instalador sem assinatura.** Não existe certificado Authenticode: os binários medidos devolvem
  `TRUST_E_NOSIGNATURE` (`0x800b0100`) e a tabela de certificados tem tamanho 0. Um instalador
  não assinado **nunca** é descrito aqui como assinado.
- **Verificação automática de atualizações não está confiável fim-a-fim.** Em
  `packages/desktop/src/updater/release-trust.json`, `enabled` é `false` e a chave pública e o
  *fingerprint* estão vazios («Publication public key not provisioned. Never replace with a fixture
  key.»). Enquanto o dono do projeto não provisionar a chave de publicação Ed25519,
  `createProductionUpdater()` devolve deliberadamente o *updater* não configurado — *fail-closed*,
  sem chave inventada. A verificação de integridade está escrita e testada, mas não há caminho de
  atualização real terminado.
- **Prova do *updater* é automatizada, não manual.** A evidência existente são testes de máquina de
  estados e dos buracos de §12.7 (`packages/desktop/test/updater-statemachine.test.mjs`,
  `updater-gap-tests.test.mjs`). Isso **não** é validação manual de instalação, atualização ou
  interrupção: esses passos continuam à espera de um humano na máquina virtual.

Se encontrares um problema de segurança, não abras uma issue pública com detalhes sensíveis.

## Melhorias futuras

1. Gestor de exclusões com interface dedicada;
2. Otimização do pipeline de análise (orçamento distribuído, menos trabalho repetido);
3. Melhor cobertura de formatos e heurísticas;
4. Diagnóstico explícito de resultados inconclusivos;
5. Atualizações seguras com verificação de integridade fim-a-fim;
6. Compatibilidade gráfica e DPI em hardware variado;
7. Instalador final validado em máquina limpa, com assinatura.

## Documentação

- [Arquitetura](docs/ARCHITECTURE.md) — camadas, fluxos e contratos
- [Roadmap](docs/ROADMAP.md) — fases e prioridades honestas
- [FAQ de entrega](docs/FAQ-ENTREGA-PROFESSOR.md) — perguntas típicas sobre o projeto
- [Transferência para revisão da PAP](docs/PAP-TRANSFERENCIA-20261031.md) — factos comprovados, lacunas e o que o relatório pode afirmar. **Atenção:** este documento descreve a candidata R5 e o estado documental de 2026-10-31; a versão e os artefactos atuais são os do topo deste README, e o delta técnico está no CHANGELOG
- [Evidências técnicas da PAP](PAP-EVIDENCIAS-TECNICAS/README.md) — oito documentos com provas, limitações e índice de reprodução
- [CHANGELOG](CHANGELOG.md) — adenda técnica do que mudou depois de o relatório académico ter sido entregue
- [Camada PowerShell / Windows](docs/POWERSHELL-WINDOWS-LAYER.md)
- [Toolchain C++ no Windows](docs/TOOLCHAIN-CPP-WINDOWS.md)
- [Motor nativo](packages/native-engine/README.md) — compilar e testar o `scan-engine`
- [Índice da documentação](docs/README.md)

## Licença

MIT. Ver [`package.json`](package.json). Componentes de terceiros mantêm as respetivas licenças
(ver `assets/licenses/`).
