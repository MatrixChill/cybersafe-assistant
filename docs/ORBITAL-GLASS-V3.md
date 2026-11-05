# Orbital Glass V3 — implementação e auditoria

**Data:** 05/11/2026  
**Projeto:** CyberSafe Assistant  
**Branch:** `feat/orbital-glass-v3`  
**Base / RC12:** `2bbca4a1a7f8378410457a9033b268a822331620`  
**Worktree usado:** `C:\Users\caioc\.cybersafe-integration\main-merge-20261103\repo`  
**Commits de implementação:** `914be23`, `c0c4c6a`, `05790c0`  
**Release/feed:** não alterados; não foi feito push nem publicação.

## 0. Resultado em uma vista

| Área | Estado | Evidência |
|---|---|---|
| HashDB sem chave | Corrigida semanticamente; sem tentativas automáticas inúteis | `configuracaoNecessaria`, testes de serviço e de apresentação |
| Switch de atualização | Alinhamento corrigido; persistência coberta por teste | `translate-x-[18px]`, teste de preferência |
| Aviso automático | Gate puro; só abre com verificação automática e versão válida | `shouldOpenAutomaticPrompt`, testes de aceitação |
| Sidebar ativa | Superfície, barra, ícone, foco e rótulo corrigidos | CSS e testes de sidebar |
| Núcleo da verificação | `CoreVisual` reutiliza `CoreScene`; fallback e limites | código, teste SSR e build |
| Janela do updater | Já usa o mesmo `CoreScene` via `UpdaterScene`; CSS revisto | `UpdaterScene.tsx`, CSS e teste de consentimento |
| Otimizar | Datas separadas e chave em falta nomeada | copy, teste focado e suite |
| Auditoria visual global | Parcial; runtime autenticado não acessível | limitação declarada abaixo |

A suite completa da app passou **3003/3003**. O typecheck passou em todos os workspaces. O build do renderer passou. Isto prova compilação e comportamento coberto por testes; não prova instalação Windows, atualização real da HashDB nem as páginas autenticadas.

## 1. Integridade do repositório

- O caminho indicado na missão (`C:\Users\caioc\Desktop\Caio\cybersafe-assistant`) não existe nesta máquina. O trabalho foi feito na worktree aprovada, que parte de `2bbca4a`.
- A RC12 pública, o feed, as chaves, o manifesto, a verificação Ed25519/SHA-256 e o instalador não foram tocados.
- Não foram adicionadas dependências.
- O estado final da worktree contém apenas `docs/CODEX-CONTINUIDADE-V020.md` e `output/` não rastreados, que já existiam e ficaram deliberadamente fora dos commits.
- Não houve push, release, publicação ou alteração de feed.

## 2. P1 — HashDB degradada

### Causa

A fonte externa usa `MALWAREBAZAAR_AUTH_KEY`. Sem essa chave legítima, o updater tentava atualizar a fonte, marcava-a como obsoleta e acumulava tentativas que nunca podiam ter sucesso. A UI chamava a isso “Degradado”, sem distinguir uma falha de rede de uma configuração em falta. As três assinaturas locais continuavam disponíveis, mas a apresentação misturava a cobertura local com a actualização externa suspensa.

### Correção

- `packages/shared-types/src/index.ts`: novo campo opcional `configuracaoNecessaria`.
- `packages/service/src/updater.ts`:
  - deteta a ausência da chave;
  - grava o marcador de configuração e limpa-o quando a chave existe;
  - impede `componentStale` e tentativas automáticas sem chave;
  - define `proximaVerificacaoAtMs = 0` para não prometer uma nova tentativa.
- `packages/service/src/engine.ts`: sem chave e sem sucesso => `degradado` + `configuracaoNecessaria`; com sucesso anterior => idade real da base, preservando a proteção local.
- `packages/app/src/lib/definitionsStatusPresentation.ts`: rótulo “Configuração necessária”, causa explícita e nome da chave em falta; não inventa tentativas nem datas.
- `packages/app/src/v2/LabSidebar.tsx`: “4/4 motores de análise” com tooltip que separa motores de cobertura de definições.

### Limitação

Não existe chave legítima disponível. Não foi possível validar uma transferência real, a autenticação do fornecedor, a integridade dos dados recebidos nem o estado “Atualizado”. A aplicação não deve ser considerada com base externa atualizada enquanto essa validação não for feita.

## 3. P1 — switch de atualização

O track tem 44 px, 1 px de borda e 2 px de padding; o thumb tem 20 px. O deslocamento útil é `44 - 2 - 4 - 20 = 18 px`. O estado ligado passou a usar `translate-x-[18px]`; o estado desligado usa o padding inicial. Os switches de Configurações usam `left-0.5` e `translate-x-5` com track `h-6 w-11`.

A preferência é persistida pelo updater existente. O teste de preferência cobre leitura/escrita; o teste de aceitação cobre o switch e o texto. **Não foi feito um reinício real da aplicação Electron com sessão autenticada**, pelo que a persistência depois de reiniciar continua a ser uma verificação manual pendente, apesar de o contrato estar coberto.

## 4. P1 — aviso automático de atualização

- `appUpdateModel.ts`: `shouldOpenAutomaticPrompt` exige verificação automática ativa, `status === "available"`, versão válida e versão não adiada.
- `AutomaticUpdatePrompt.tsx`: usa esse gate; “Mais tarde” fecha e impede repetir a mesma versão na sessão; chama `defer`.
- A verificação manual continua a mostrar o estado no painel, sem abrir o modal global por cima da página onde foi pedida.
- `UpdaterScene.tsx` já importa e renderiza `CoreScene` com a variante de profundidade; a janela não recebeu um segundo motor 3D.
- `updater-window.css`: superfície com gradiente subtil, `::backdrop` com blur controlado e fallback para `prefers-reduced-transparency`.

A existência do caminho de código está confirmada; a apresentação visual da janela com uma atualização real não foi capturada.

## 5. P1 — sidebar

`lab-sidebar.css` passou a dar ao item ativo:

- fundo em gradiente suave;
- barra interior `inset 3px 0 0 var(--v2-accent)`;
- ícone ciano e texto com peso superior;
- cantos arredondados;
- foco visível por teclado;
- transição curta.

`navigation.ts` e `Sidebar.tsx` usam “Configurações”. O rótulo “4/4 motores de análise” foi separado da ideia de cobertura de definições. A página ativa continua a ser determinada pela rota real.

## 6. P1 — núcleo visual da verificação

Foi criado `packages/app/src/components/visual/CoreVisual.tsx`, que:

- reutiliza o `CoreScene` existente, em vez de criar outro motor;
- carrega a cena com `lazy`;
- usa `fpsLimit={30}` e `dprLimit={1.25}`;
- aceita `active` para o estado visual;
- apresenta fallback estático quando a cena não está disponível;
- usa `useOptionalAppearance`, para não rebentar em SSR/testes sem provider;
- mantém um rótulo acessível sem afirmar progresso.

`FileScannerPage.tsx` voltou a incluir o núcleo no cabeçalho da verificação. A janela do updater mantém a mesma cena através de `UpdaterScene`.

**Limitação:** não foi possível abrir a aplicação autenticada para confirmar visualmente o canvas, o fallback sem WebGL, o reduced motion ou a ausência de erros de consola num ciclo real de abrir/fechar. O teste cobre o contrato e o SSR, não a GPU.

## 7. P1 — Otimizar

- A data global e as datas por fonte deixaram de ser tratadas como a mesma coisa.
- Sem leitura global, a página diz que o serviço não reportou a data e mostra a data da tentativa e do último sucesso por fonte, sem usar a expressão “última tentativa” nesse estado.
- A HashDB sem chave apresenta “Configuração necessária” e nomeia `MALWAREBAZAAR_AUTH_KEY`.
- O texto de sucesso antigo não é apagado; a idade real continua a mandar quando existe base local.

Não foi feito o redesenho completo dos três cartões de fontes nem a unificação dos botões “Marcar como revisto” / “Marcar como feito”. Isso permanece P2 e está listado abaixo.

## 8. Matriz de referências

| Referência | Efeito identificado | Local de aplicação | Impacto | Custo | Decisão |
|---|---|---|---|---|---|
| [React Bits — Orb](https://reactbits.dev/backgrounds/orb) | Anel luminoso e movimento orbital | Núcleo da verificação | Identidade, sem novo asset | Baixo | Referência de movimento; não importado |
| [React Bits — fundos](https://reactbits.dev/c/backgrounds) | Aurora, partículas e rings | Painel / abertura | Profundidade | Médio | Não adotado em todas as páginas; risco de ruído |
| [Aceternity — Liquid Glass](https://ui.aceternity.com/components/liquid-glass) | Reflexos, blur e transparência | Superfície do updater | Separação visual | Médio | Uso limitado; fallback de transparência reduzida |
| [Aceternity — Card Spotlight](https://ui.aceternity.com/components/card-spotlight) | Luz que segue o cursor | Cartões de segurança | Ênfase local | Médio | Não adotado; poucos cartões justificam o custo |
| [Magic UI — Orbiting Circles](https://magicui.design/docs/components/orbiting-circles) | Objetos em órbita circular | Órbitas do núcleo | Movimento coordenado | Baixo | Já coberto por `CoreScene`; sem dependência nova |
| [Motion — acessibilidade](https://motion.dev/docs/react-accessibility) | Reduced motion e transições | Sidebar, diálogos e estados | Evita movimento involuntário | Baixo | Regra mantida; sem nova biblioteca |
| [Three.js — WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html) | `setPixelRatio` e ciclo de render | `CoreVisual` | Menos custo em DPI alto | Baixo | `dprLimit` e `fpsLimit` explícitos |
| [shadcn — Switch](https://ui.shadcn.com/docs/components/base/switch) | Track, thumb, foco e ARIA | Switch de atualização | Controlo previsível | Baixo | Geometria corrigida; `role="switch"` preservado |
| [shadcn — Sidebar](https://ui.shadcn.com/docs/components/base/sidebar) | Item ativo com superfície e foco | Sidebar | Orientação imediata | Baixo | Aplicado ao `LabSidebar` existente |
| [Linear — design refresh](https://linear.app/now/behind-the-latest-design-refresh) | Hierarquia e redução de ruído | Otimizar / navegação | Clareza | Baixo | Referência de hierarquia, sem copiar identidade |
| [Electron — security](https://www.electronjs.org/docs/latest/tutorial/security) | Context isolation, CSP e preload limitado | Shell e updater | Não enfraquecer o modelo | Nenhum | Sem código remoto, nova ponte ou alteração de CSP |
| [MDN — prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/prefers-reduced-motion) | Paragem de animações não essenciais | Núcleo e updater | Acessibilidade | Baixo | Fallback estático e CSS de reduced motion |
| [WCAG 2.2](https://www.w3.org/TR/wcag/) | Foco visível, contraste e alvos | Sidebar, switch e diálogos | Requisito de qualidade | Baixo | Foco visível e labels; auditoria completa pendente |

## 9. Ficheiros alterados

**Serviço e tipos:** `packages/shared-types/src/index.ts`, `packages/service/src/updater.ts`, `packages/service/src/engine.ts`.

**Desktop:** `packages/desktop/src/updater/windows-installer.ts`.

**App:** `definitionsStatusPresentation.ts`, `OtimizarPage.tsx`, `UpdatesPanel.tsx`, `AutomaticUpdatePrompt.tsx`, `appUpdateModel.ts`, `updater-window.css`, `SettingsPage.tsx`, `Sidebar.tsx`, `navigation.ts`, `LabSidebar.tsx`, `lab-sidebar.css`, `FileScannerPage.tsx`, `scanner-v2.css`, `CoreVisual.tsx` (novo), `AppearanceContext.tsx`.

**Testes:** `definitions-status-presentation.test.ts`, `p0-design-otimizar.test.ts`, `update-ui-acceptance.test.ts`, `orbital-v3-fixes.test.ts` (novo), `design-v2-sidebar.test.ts`, `quarantine-in-threats.test.ts`, `definitions-status.test.js`, `updater-hashfeed.test.js`, `updater-handoff-lab.integration.test.mjs`.

## 10. Provas de teste

| Comando | Resultado |
|---|---|
| `npm test -w @cybersafe/app` | **3003 testes, 519 suites, 3003 pass, 0 fail**, 15,28 s |
| `npm run typecheck` | **0 erros** em todos os workspaces |
| `npm run build -w @cybersafe/app` | **0 erros**; 2306 módulos; aviso de chunks > 500 kB |
| `curl http://127.0.0.1:5199/` | **HTTP 200** no renderer Vite |
| `npx tsx --tsconfig tsconfig.app.json --test test/definitions-status-presentation.test.ts` | **9/9** |
| Testes afetados de sidebar/scanner/quarentena | **52/52** |

O build separa `CoreScene` num chunk lazy de 570,20 kB (144,69 kB gzip). O chunk principal tem 1.195,27 kB (344,58 kB gzip); o aviso de tamanho é conhecido e não foi escondido.

### Testes focados de serviço e desktop

- `packages/service/test/definitions-status.test.js`: 5/5.
- `packages/service/test/updater-hashfeed.test.js`: 28/28; inclui scheduler sem chave e prova de zero pedidos.
- `packages/desktop/test/updater-handoff-lab.integration.test.mjs`: 3/3; inclui `consent === 1`.
- `packages/desktop/test/updater-preference.test.mjs`: 2/2.
- `packages/desktop/test/updater-automatic.test.mjs`: 3/3.
- `packages/desktop/test/updater-windows-installer.test.mjs`: 4/4.
- `packages/app/test/update-ui-acceptance.test.ts`: 32/32.
- `packages/app/test/p0-design-otimizar.test.ts`: 24/24.
- `packages/app/test/orbital-v3-fixes.test.ts`: 3/3.
- `packages/app/test/design-v2-sidebar.test.ts`: 11/11.

Não foi executada a suite completa de `service` ou `desktop`; apenas os testes focados acima. Não foi executado um build do instalador Windows.

## 11. Validação visual e runtime

O renderer Vite foi iniciado em `127.0.0.1:5199` e respondeu HTTP 200. A árvore de acessibilidade mostrou o ecrã real de início de sessão (“Inicie sessão na sua conta”). Não contornei a autenticação, não criei conta e não usei credenciais de terceiros.

Consequência: **não existem capturas das páginas autenticadas, da sidebar ativa, do switch ligado/desligado, do Otimizar, do núcleo no Scanner ou do popup de atualização**. Também não foi observada a janela Electron nativa. Uma captura do ecrã de login não seria prova das alterações e, por isso, não foi usada como “depois”.

O único erro de consola observado foi o HMR do Vite a tentar `ws://127.0.0.1:5199` contra uma CSP que permite `5173`; é um efeito do servidor de desenvolvimento, não do build de produção, e não foi “corrigido” enfraquecendo a CSP.

## 12. Auditoria e limitações

### O que foi verificado

- Item ativo da sidebar: superfície, barra, ícone, foco e transição.
- Switch: geometria, estados, `role="switch"`, `aria-checked` e texto.
- Otimizar: data global vs. data por fonte; chave em falta; ausência de retries inventados.
- Scanner: núcleo integrado, fallback SSR e limite de FPS/DPR.
- Updater: gate do aviso automático, “Mais tarde”, consentimento único e uso de `UpdaterScene`/`CoreScene`.
- Build de produção do renderer.

### O que não foi verificado

- Navegação visual por todas as páginas e todos os estados vazios.
- 1366×768, 1600×900, 1920×1080, janela mínima e escalas 100/125/150%.
- Reinício real do Electron com o switch desligado e ligado.
- WebGL indisponível, GPU degradada, minimização/restauro, memory leak e erros de consola num ciclo real.
- Actualização real da HashDB, feed real, assinatura inválida, download interrompido e instalação numa VM limpa.
- Redesenho completo dos cartões de ClamAV/YARA/HashDB e unificação dos botões das ações manuais.
- ARIA dos switches de Configurações (os switches do updater têm `role="switch"`; os de Configurações ainda não foram todos uniformizados).

Não foi medido um antes/depois de desempenho. O `CoreVisual` é lazy e limitado, mas não se afirma uma melhoria numericamente medida.

## 13. Pendências

### P0 — crítico

Nenhum P0 novo confirmado. A HashDB sem chave é uma condição de configuração esperada, não uma falha silenciosa; a proteção local permanece disponível.

### P1 — alto

1. Validar a HashDB com uma chave legítima e confirmar transferência, autenticação e integridade.
2. Repetir o switch e a verificação automática numa janela Electron real, com reinício e sessão autenticada.
3. Capturar as páginas autenticadas e confirmar visualmente sidebar, núcleo, Otimizar e popup.
4. Testar o updater numa VM Windows limpa, incluindo UAC, consentimento único e recuperação de erro.

### P2 — médio

1. Uniformizar os cartões de ClamAV, YARA e HashDB e as ações manuais de Otimizar.
2. Completar a auditoria visual das restantes páginas e estados vazios.
3. Uniformizar ARIA e foco dos switches de Configurações.
4. Testar WebGL indisponível, reduced motion, DPI e redimensionamento em runtime.
5. Confirmar ausência de memory leaks ao abrir/fechar o popup repetidamente.

### P3 — acabamento

1. Rever micro-tipografia e labels de 8–10 px nas superfícies do scanner.
2. Medir o custo do chunk lazy e decidir se `CoreScene` precisa de mais divisão.
3. Revisão final de contraste e densidade nas páginas não alteradas.

## 14. Critérios de aceitação

- [x] HashDB semanticamente correta e sem retries automáticos inúteis (testes).
- [x] Switch alinhado no código e coberto por teste.
- [ ] Persistência comprovada por reinício real do Electron.
- [x] Verificação automática respeita a configuração (gate + testes).
- [x] Janela automática condicionada a atualização válida e não adiada.
- [x] “Atualizar” e “Mais tarde” cobertos pelo contrato de testes.
- [x] Popup reutiliza `UpdaterScene`/`CoreScene` (código confirmado).
- [x] Núcleo reposto no Scanner (código e teste SSR).
- [x] Fallback e reduced motion implementados; runtime GPU não testado.
- [x] Sidebar identifica a rota ativa (CSS + testes).
- [x] Navegação preserva foco e usa “Configurações”.
- [x] Otimizar separa datas e nomeia a chave em falta.
- [x] Duplicação de consentimento investigada; teste prova uma chamada.
- [ ] Auditoria visual completa e capturas autenticadas.
- [x] Suite relevante da app, typecheck e build executados.
- [ ] Provas visuais completas.
- [x] RC12, feed e release intactos.

## 15. Commits

- Base: `2bbca4a1a7f8378410457a9033b268a822331620`.
- `914be23` — HashDB sem chave e consentimento único.
- `c0c4c6a` — switch e gate do aviso automático.
- `05790c0` — núcleo, sidebar e navegação.
- Relatório: commit de documentação desta entrega.

Não foi feito push. O estado final não contém alterações de código pendentes; `docs/CODEX-CONTINUIDADE-V020.md` e `output/` continuam não rastreados e fora da entrega.
