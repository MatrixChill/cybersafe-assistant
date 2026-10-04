# DESIGN_AUDIT — CyberSafe Assistant (FASE 1, read-only)
Data: 2026-10-04 · Auditor: FRONTEND LEAD · DESIGN_FIXES_IMPLEMENTED: 0
Método: leitura direta de `packages/app/src` (14 ficheiros) + verificação do CSS compilado em `dist/assets/index-WQg882-k.css` (build 2026-10-02, contém `nav-active-bar`, portanto recente).

SKILLS_LOADED = cybersafe-design-system, impeccable, apple-design-principles, react-best-practices (4/4)

---

## P0_VISUAL

### P0-1 · Shell inteiro · As classes semânticas do estado de proteção não existem — o estado principal da demo renderiza a preto-e-branco
- SCREEN: Dashboard (hero chip + resposta), Sidebar (dot de estado + chip inferior), ProtectionDetails (badges dos motores).
- ISSUE: `protectionHealth.ts` e `ProtectionDetails.tsx` usam `bg-success`, `text-warning`, `border-danger/30`, etc. Não existe `--color-success|warning|danger` em `index.css` (só `--cyber-*` + shadcn tokens), logo o Tailwind v4 nunca gera esses utilitários.
- EVIDENCE: `packages/app/src/lib/protectionHealth.ts:164-203` · `packages/app/src/components/ProtectionDetails.tsx:101-104,374-375` · `packages/app/src/components/Sidebar.tsx:120-123,264` · grep do CSS compilado `dist/assets/index-WQg882-k.css`: zero ocorrências de `bg-success|text-warning|bg-danger` (e `nav-active-bar` presente → build não é velho).
- IMPACT: o dot de estado no sidebar é invisível (sem background); chip "Protegido/Atenção/Crítico" perde toda a cor; as 4 níveis de proteção ficam visualmente idênticos. Parte a primeira vista da demo e contradiz "a cor significa algo".
- RECOMMENDATION: substituir por `bg-cyber-green/yellow/red` + variantes `-text` (o caminho oficial do design system), num único sítio (`levelMeta`), e verificar no CSS compilado depois.
- SKILLS: cybersafe-design-system, impeccable §8, secpriv.

### P0-2 · Scanner · Barra de progresso "cheia" e detalhe "N ficheiros de uma só vez" apresentam uma análise parada como trabalho ativo
- SCREEN: FileScannerPage — painel "Análise em curso" (o reteste manual de 2026-10-03 falhou: aceita scan e fica 0/N sem progresso).
- ISSUE: quando não há `progressPercent` (gathering/stall), o fallback desenha uma barra `w-full animate-pulse` — largura total, lê-se como ~100%. Em simultâneo, `filesInEngineBatch` mantém o último valor do snapshot (não é keepMax mas também só zera com evento novo), pelo que um motor calado fica a dizer "O motor de assinaturas está a verificar 782 ficheiros de uma só vez" enquanto `0 / N` nunca avança. O watchdog (20 s) é o único aviso, e só aparece depois do silêncio.
- EVIDENCE: `packages/app/src/pages/FileScannerPage.tsx:604-614` (fallback full-width) · `:597-601` · `packages/app/src/lib/scanSession.ts:541-544` (copy do batch) · `:206-210` (batch só manda o último snapshot).
- IMPACT: estado de progresso enganoso na demo — exatamente a categoria "não finjas estados healthy". O blocker é de runtime, mas o design amplifica-o: barra cheia + frase ativa = mentira visível.
- RECOMMENDATION: (a) o indeterminado não pode ser uma barra a 100% — usar pista curta com movimento de varrimento (stripes ou segmento 1/3) distinto de progresso; (b) a linha de batch só é mostrada enquanto há eventos recentes (carimbo `updatedAt` dentro do limite), caso contrário a UI passa a "sem atualizações do motor" mais cedo; (c) manter o 0/N visível junto da barra, nunca só o número de lote.
- SKILLS: impeccable §7, react-best-practices §7, cybersafe-ptpt-ui.

---

## P1_VISUAL

### P1-1 · Dashboard → Scanner · A copy do botão promete "todo o computador", o Scanner diz o contrário
- SCREEN: bloco "Procurar ameaças" do Dashboard vs cartões do Scanner.
- ISSUE: `Verificação completa — "Todo o computador, ficheiro a ficheiro"` contradiz a descrição oficial do scan profundo ("Windows e Program Files ficam de fora"). Também introduces "Verificação" contra "Análise" usada no Scanner/sidebar — dois nomes para a mesma ação.
- EVIDENCE: `packages/app/src/pages/DashboardPage.tsx:243-245` · `packages/app/src/lib/scanSession.ts:45-58`.
- IMPACT: promessa falsa na superfície clicável principal; o utilizador que faz demo nos dois ecrãs vê a contradição.
- RECOMMENDATION: alinhar sub-copy pelo escopo real e fixar o par de termos (Análise Rápida / Análise Profunda) em ambos os ecrãs.
- SKILLS: cybersafe-ptpt-ui, apple-design-principles §1.

### P1-2 · Onboarding · Passo 2 promete progresso "em tempo real, ficheiro a ficheiro"
- SCREEN: OnboardingOverlay, passo "Análise de Segurança".
- ISSUE: o motor trabalha em lotes (~7,6 s de base, batch de N ficheiros — documentado no próprio `scanSession.ts`); e o estado atual do produto é um scan que não avança. A frase é uma garantia que o runtime não dá.
- EVIDENCE: `packages/app/src/components/OnboardingOverlay.tsx:26-28` · `packages/app/src/lib/scanSession.ts:336-349,537-544`.
- IMPACT: define expectativa errada no primeiro contacto; qualquer stall no demo lê-se como "o CyberSafe mente logo no onboarding".
- RECOMMENDATION: trocar por linguagem de fases reais ("vês o progresso por fases: preparação, enumeração, análise, conclusão").
- SKILLS: impeccable §7, cybersafe-ptpt-ui.

### P1-3 · Todo o shell · Superfícies literais `bg-black/*` e `bg-white/[...]` à margem dos tokens partem os temas claros
- SCREEN: Scanner (tiles de stats), Dashboard (pills "quatro frentes", lista GPU, itens de listas), PC Center (rede, alertas, tabelas).
- ISSUE: dezenas de `bg-black/20 border-white/5`, `bg-white/[0.03] border-white/[0.06]`, `hover:bg-white/5`. O `index.css` tapa só os `bg-black/*` em light com um hack `!important` (`:2003-2007`); os `bg-white/[0.0x]` ficam invisíveis sobre card claro — pílulas e itens de lista perdem contorno e separação.
- EVIDENCE: `FileScannerPage.tsx:624-663` · `DashboardPage.tsx:157,208,258,272,366,724` · `PCCenterPage.tsx:330,339,519,533,625,754` · `index.css:2003-2007`.
- IMPACT: light/dark deixam de ser dois modos do mesmo produto; em light (candidato a demo) secções inteiras "derretem" no fundo.
- RECOMMENDATION: substituir por `bg-secondary`/`bg-card` + `border-border` (ou um token novo de "sub-superfície" declarado nos 10 blocos, com pergunta antes de inventar); remover o hack `!important` quando os literais desaparecerem.
- SKILLS: cybersafe-design-system (DO 1, DONT 1), impeccable §8.

### P1-4 · Ameaças · Severidade codifica "Baixa" a verde com check-mark — ameaça a parecer "estado limpo"
- SCREEN: ThreatsPage, badges e ícones por severidade; badge "Aprovação Procedural".
- ISSUE: `low` → `text-cyber-green` + `CheckCircle2`; `medium` → cyan. O verde é a cor exclusiva de "verificado sem deteções" no vocabulário do produto; aqui pinta uma ameaça detetada como positivo. "Aprovação Procedural" para `rulesTriggered` vazio é token interno disfarçado de elogio.
- EVIDENCE: `packages/app/src/pages/ThreatsPage.tsx:33-49,144-148`.
- IMPACT: leitura errada de risco — num security产品, invert semântica de cor; viola "estado incerto nunca parece safe".
- RECOMMENDATION: escalar severidade dentro de vermelho/amarelo/cinza (ex.: critical/high=red, medium=yellow, low=muted+triângulo pequeno), e "Sem regras acionadas" para o vazio.
- SKILLS: cybersafe-design-system (semânticas), impeccable §8, apple-design-principles §3.

### P1-5 · Settings · Pré-visualização das cores de destaque não renderiza; copy técnica em inglês
- SCREEN: SettingsPage "Cor de destaque".
- ISSUE: o swatch faz `background: color-mix(in oklch, var(text-cyber-cyan) 80%, transparent)` — `var()` recebe um nome de classe, não um custom property: a barra fica vazia em 6 das 7 opções. Há ainda a classe morta `text-primary-absolute` no `Check` e a descrição "Define primary, ring, borders e glow. Cores semânticas (success/warning/danger)…".
- EVIDENCE: `packages/app/src/pages/SettingsPage.tsx:42-50,192-203,169`.
- IMPACT: o ecrã que vende o sistema de temas não mostra tema nenhum — mau aspeto direto na demo de identidade.
- RECOMMENDATION: usar `bg-cyber-cyan` etc. como classes no próprio div (padrão já correto no Sidebar, `Sidebar.tsx:67-72`), traduzir a copy para PT-PT ("cor principal, contornos e brilho").
- SKILLS: cybersafe-design-system (DO 6), impeccable §9.

### P1-6 · Temas · As identidades são re-color, não identidades — vocabulário visual definido e nunca usado
- SCREEN: todos os ecrãs em Matrix Terminal (e Neon/Liquid).
- ISSUE: `terminal-card`, `terminal-hero`, `terminal-sidebar-item`, `circuit-pattern`, `matrix-rain`, `neon-card`, `liquid-panel`, `progress-bar-*`, `badge-warning/danger` estão definidos em `index.css` mas não são referenciados por nenhum componente. O Matrix Terminal "denso, angular, command center" resume-se a verde + monospace; a densidade, o raio e as arestas continuam os do CyberSafe Core.
- EVIDENCE: `index.css:1690-1781,1817-1849,2071` · grep: zero usos em `src/**` exceto o próprio CSS.
- IMPACT: a promessa das 5 identidades é cosmética; o mesmo layout com paleta trocada não "parece um único produto com identidades", parece skin.
- RECOMMENDATION: decisão de dono — ligar o vocabulário nos primitivos (cartões/headers usam `terminal-card` quando `data-theme="matrix-terminal"`) OU apagar o CSS dormente e declarar a identidade como cor+fonte só. Não ampliar agora; decidir e registrar.
- SKILLS: cybersafe-design-system (validação das identidades exige runtime), impeccable §9.

### P1-7 · Shell · Métricas de página divergentes — os ecrãs têm quatro "vozes" de layout diferentes
- SCREEN: headers e paddings por página.
- ISSUE: Dashboard `p-4 lg:p-6` + título `text-base` mono; Scanner/Monitor/Settings `p-8` + `text-2xl` mono; PC Center `p-6` + `text-2xl` sans bold; e as listas do Dashboard vivem em `text-[9-11px]` enquanto Scanner/Threats usam `p-6`/`text-3xl`. Densidade mista por vista — o próprio critério do "parece feito por agentes diferentes".
- EVIDENCE: `DashboardPage.tsx:66,85` · `FileScannerPage.tsx:508,511` · `PCCenterPage.tsx:706,715` · `MonitorPage.tsx:51,54` · `SettingsPage.tsx:94,96`.
- IMPACT: ruído entre ecrãs; o olho recalibra em cada navegação; escala tipográfica sem sistema (ver P2-6).
- RECOMMENDATION: fixar um standard de página (padding único, header com o mesmo par tipografia/altura em todos os ecrãs de topo) — é linguagem visual, logo meu; aplicar quando nenhum writer estiver a mexer nos mesmos ficheiros.
- SKILLS: impeccable §3 §5, apple-design-principles §4.

---

## P2_VISUAL

### P2-1 · Dialogs · Três diálogos, três níveis de qualidade
- EXIT/Threats/Details: `ExitConfirmDialog` tem `role=dialog`, `aria-modal`, ESC, focus trap e default seguro; o modal "Limpar Logs" de Threats não tem nenhum (e fecha só por botões); ProtectionDetails tem ESC mas sem focus management; o scrim varia `bg-background/70|80` vs `bg-black/60`; raio `rounded-2xl` fora do `--shell-radius-card`.
- EVIDENCE: `ExitConfirmDialog.tsx:67-86` · `ThreatsPage.tsx:230-262` · `ProtectionDetails.tsx:205-210`.
- RECOMMENDATION: extrair o invólucro do ExitConfirmDialog para primitiva de modal quando houver segundo uso real (regra das duas utilizações). SKILLS: impeccable §7, react-best-practices §6 §8.

### P2-2 · Copy/nomes · Termos internos e inglês misturados na superfície PT-PT
- Sidebar "Monitor de Rede" vs página "Monitor de Proteção"; ProtectionDetails mostra "Native Engine"/"Hash DB" ao lado de linhas traduzidas ("Motor nativo…"); Dashboard "achado(s)" como substantivo e "Definições" para signatures.
- EVIDENCE: `Sidebar.tsx:51` vs `MonitorPage.tsx:55` · `ProtectionDetails.tsx:22-27` vs `:630-638` (Dashboard) · `DashboardPage.tsx:702`.
- RECOMMENDATION: glossário fixo por página no vocabulário do produto. SKILLS: cybersafe-ptpt-ui.

### P2-3 · Monitor · Empty state invisível e tabela sem estado vazio
- "Sem telemetria do service" (inglês a meio) a `opacity-20` + itálico pulsante — quase ilegível; tabela "Processos Ativos" não tem linha vazia quando `processes.length === 0`.
- EVIDENCE: `MonitorPage.tsx:89-92,150-159`.
- RECOMMENDATION: "Sem telemetria do serviço" em opacidade normal; linha vazia dedicada. SKILLS: impeccable §7.

### P2-4 · Estados · "Atenção" cobre dois níveis diferentes
- `levelMeta`: attention → shortLabel "Atenção" (amarelo); degraded → shortLabel "Atenção" (vermelho). Sidebar mostra só o shortLabel — o utilizador não distingue "aviso" de "proteção reduzida" sem ler a cor (que, com P0-1, nem cor tem).
- EVIDENCE: `protectionHealth.ts:172,184`.
- RECOMMENDATION: degraded → "Proteção Reduzida". SKILLS: impeccable §6 (não codificar só por cor).

### P2-5 · Loaders/componentes dormentes
- `ScanRadar.tsx` (+css) não é importado por ninguém e contém um dot "status-dot online" e blips decorativos — precisamente o tipo de falsa indicação que o proíbe; `components/ui/progress.tsx` também sem uso enquanto cada página inventa a sua barra.
- EVIDENCE: `ScanRadar.tsx:70` · grep de imports: zero.
- RECOMMENDATION: apagar ScanRadar (ou reutilizá-lo só com dados reais); adotar o Progress como primitiva quando for tocado. SKILLS: react-best-practices §8.

### P2-6 · Tipografia · Micro-escala ad hoc
- `text-[9px]`, `text-[10px]`, `text-[11px]` coexistem com `text-xs/sm` em Dashboard/Threats/PC Center; 9px fica abaixo do confortável para texto de estado; números nos tiles do Scanner (`0 / N`, tempo) sem `tabular-nums` jitter com eventos.
- EVIDENCE: `DashboardPage.tsx:260,280,569` · `FileScannerPage.tsx:632-658`.
- RECOMMENDATION: piso de 10-11px para texto real e tabela de 4 tamanhos por vista; tabular nos contadores. SKILLS: impeccable §2.

---

## Top 3 P1 de alto impacto / baixo risco (para Fase 2, só meu worktree)
1. **P0-1 → P1-5 quick win conjunto**: substituir as classes mortas (`success/warning/danger` + swatches Settings) pelos tokens `cyber-*` — 2 ficheiros (`protectionHealth.ts`, `SettingsPage.tsx`), zero risco de runtime, recupera o color-system da demo.
2. **P1-1 + P1-2**: reescrever as 3 linhas de copy do Dashboard/onboarding para o escopo honesto — ficheiros pequenos, sem impacto em backend.
3. **P1-4**: reescalar severidades na ThreatsPage (mapeamento local, 1 ficheiro).
Nenhum toca em ficheiros partilhados com outros writers além de `DashboardPage.tsx` (copy) — confirmar Task Packet antes se outro builder reivindicar o Dashboard.

LIMITATIONS
- Sem runtime: contraste final por tema (10 blocos) e o Matrix Terminal nos dois modos exigem verificação visual manual; nada nesta auditoria foi medido no browser.
- A prova das classes mortas é o `dist` de 2026-10-02 (marcado recente por `nav-active-bar`); um rebuild pode formalizar tokens `success/*` se alguém os entretanto definiu — o grep atual não os mostra em `index.css`.
- O P0-2 descreve apenas o lado visual; a causa raiz do stall 0/N é runtime e não é corrigível por design.
- Não abri Otimizar/Relatórios/Gestor de Tarefas/Login/Register (fora do escopo pedido).

DESIGN_FIXES_IMPLEMENTED = 0
