# PAP_REPORT_CHANGELOG

**Isto NÃO é fonte do relatório.** É apenas um log de auditoria e recovery.
A fonte editável do relatório é `Relatorio_PAP_CyberSafe_LIVE.docx`.

Uma linha por update do LIVE DOCX.
Campos: DATE · WORKSTREAM · DOCX_SECTION · CHANGE · EVIDENCE · WRITER · VERIFIED

---

## 2026-10-04

### Criação da fonte editável
- **DATE** = 2026-10-04
- **WORKSTREAM** = REPORT (criação da fonte viva)
- **DOCX_SECTION** = — (documento inteiro, sem alteração de conteúdo)
- **CHANGE** = `Relatorio_PAP_CyberSafe_LIVE.docx` criado por cópia byte-a-byte do baseline DOCX. Nenhum conteúdo foi alterado nesta fase.
- **EVIDENCE** = sha256 LIVE = sha256 BASELINE = `9d7b6752852173f0c1d38e188e8ce31ec1c1bc1e9f8b2c79d4a4fdf528900ec8`. Validador `output/pap-sprint/docx-validate.mjs` exit 0, `STRUCT_DIFFS = 0`. Fingerprints em `output/pap-sprint/{baseline,live}-docx-fingerprint.json`.
- **WRITER** = Freebuff (Maestro)
- **VERIFIED** = SIM — ZIP válido, `word/document.xml` válido, 1019 parágrafos / 19 tabelas / 178 linhas / 562 células / 7 imagens / 122 headings / 2 secções / 95 398 chars. Zero diferenças estruturais face ao baseline.

### Estrutura do documento registada (referência para updates futuros)
- Capítulos: 1 Introdução · 2 Enquadramento teórico · 3 Desenvolvimento do projecto · 4 Avaliação e discussão · 5 Conclusão
- Secções técnicas de 3.x relevantes para eventos de entrega: 3.9 ProtectionHealth e PcState · 3.10 Monitorização e PC Center · 3.11 Scanner e quarentena · 3.12 Matrix · 3.14 Testes e validação · 3.15 Dificuldades encontradas e soluções aplicadas · 3.16 Avaliação provisória dos resultados · 3.17 Limitações atuais · 3.18 Registo de riscos técnicos · 3.19 Trabalho futuro
- Outline completo extraído em `output/pap-sprint/Relatorio_PAP_CyberSafe_LIVE.outline.tsv` (191 linhas de títulos/legendas). Texto plano em `Relatorio_PAP_CyberSafe_LIVE.plain.txt`.
- 20 legendas de figura/tabela (estilo `Caption`), 22 referências bibliográficas, 33 bullets.

### Preview gerado
- **DATE** = 2026-10-04
- **WORKSTREAM** = REPORT (preview)
- **DOCX_SECTION** = — (não toca no DOCX)
- **CHANGE** = `Relatorio_PAP_CyberSafe_LIVE_PREVIEW.html` + `.pdf` gerados a partir do LIVE DOCX com o conversor próprio `output/pap-sprint/docx-to-html.mjs` e `printToPDF` do Electron. 46 páginas, PDF 1.4 válido com `%%EOF`.
- **EVIDENCE** = `#PDF-1.4`, 411 863 bytes, 46 páginas. Atenção: **é uma aproximação visual, não uma renderização fiel do Word.** Tem um banner a dizer isso na página 1.
- **WRITER** = Freebuff (Maestro)
- **VERIFIED** = PARCIAL — estrutura e texto conferem com o DOCX; paginação, estilos exactos e posições de figuras não são garantidos. **Nunca usar como fonte nem editar a partir do preview.**

### Rebalanceamento da segurança do DOCX
- **DATE** = 2026-10-04
- **WORKSTREAM** = REPORT (procedimento)
- **DOCX_SECTION** = — (processo, não conteúdo)
- **CHANGE** = role `PAP Report Writer` criado no workspace `cybersafe`, com scope exclusivo `PAP_REPORT`, regra de um writer de cada vez, backup antes de save, validação obrigatória depois de save, e os 4 skills máximos. Backups vão para `output/pap-sprint/backups/`.
- **EVIDENCE** = `maestri role list` mostra `"PAP Report Writer"`.
- **WRITER** = Freebuff (Maestro)
- **VERIFIED** = SIM — `maestri role create` exit 0.

### Primeiro update por evento de entrega — 3 eventos
- **DATE** = 2026-10-04T21:04:42+01:00
- **WORKSTREAM** = P1-1 coordenação freshclam ↔ scan · P0 tecto de recursos ClamAV · SCANNER_REAL_BATCH_STALL
- **DOCX_SECTION** = 3.11 (nova §3.11.4) · 3.14 (nova §3.14.5) · 3.15 (nova §3.15.13) · 3.16 (parágrafo adicional) · 3.17 (bullet adicional) · 3.18 (nova linha na tabela de riscos)
- **CHANGE** = 6 inserções cirúrgicas em `word/document.xml`:
  1. **3.11.4** — "Limite de recursos e orquestração do motor" (EVENTO 2 P0 ClamAV): tecto de processos clamscan.exe, limite de RAM em cascata, reteste 2026-10-03 (60–62 % RAM, pico 1 processo).
  2. **3.14.5** — "Gate de coordenação de escrita na base de dados ClamAV" (EVENTO 1 P1-1): gate com 3 causas de adiamento, 6 testes unitários, wide gate verde, stress 240 ciclos / 718 análises / 0 violações.
  3. **3.15.13** — "Coordenação freshclam e gate de escrita na base de dados ClamAV" (EVENTO 1 P1-1 dificuldade): ambiguidade busy-scans vs serviço-a-encerrar e solução aplicada.
  4. **3.16** — Parágrafo adicional (EVENTO 2 P0): estabilização parcial confirmada em reteste; ressalva de validação incompleta em lote real.
  5. **3.17** — Bullet adicional (EVENTO 3 STALL): pipeline em lote real parado em 0/N, >60 s, origem não identificada.
  6. **3.18** — Nova linha na tabela de riscos (EVENTO 3 STALL): risco "Stall do scanner em lote real", Alta/Alta, Aberto.
- **EVIDENCE** = `output/pap-sprint/PAP_REPORT_FACTS_PACKET-01.md`; validador `output/pap-sprint/docx-validate.mjs` exit 0 (`LIVE_POST_SAVE`): parágrafos 1033 (+14), tabelas 19 (±0), linhas 179 (+1), células 568 (+6), imagens 7 (±0), headings 125 (+3), secções 2 (±0), `allBalanced=true`. LIVE DOCX sha256 = `1bc89cebf227e45383961737623c28062ac4ee65252a00204c24918c39156700`. Backup em `output/pap-sprint/backups/Relatorio_PAP_CyberSafe_LIVE_backup_20261004-2104.docx`.
- **WRITER** = PAP Report Writer (Kiro)
- **VERIFIED** = SIM — validador exit 0, sem queda de contagens, `allBalanced=true`. Reverificado de forma independente pelo Maestro (Freebuff): fingerprint `output/pap-sprint/live-post-kiro.json`. Baselines reconferidos: sha256 inalterados.
- **LIMITATIONS registadas no texto** = o stall do scanner em lote real aparece como limitação em 3.17 e como risco aberto em 3.18; a validação de recursos é declarada parcial; o gate manual do utilizador está por fazer.

### Como este update foi verificado
1. `ls -a` na pasta: nenhum `~$*.docx` (lock do Word) — confirmado duas vezes, antes e durante.
2. Ownership: um único writer no scope `PAP_REPORT` (Kiro). Nenhum outro builder escreve em `docs/relatorio PAP/`.
3. Backup datado antes do save: `output/pap-sprint/backups/Relatorio_PAP_CyberSafe_LIVE_backup_20261004-2104.docx` (1 088 142 bytes, sha256 igual ao baseline).
4. Edição cirúrgica de `word/document.xml` (6 inserções), sem reconstruir o pacote. Estilos, numeração, media e rels preservados.
5. Validação pós-save com `output/pap-sprint/docx-validate.mjs`: exit 0, tags balanceadas, ZIP válido, `word/document.xml` válido.
6. Comparação de contagens face ao baseline: só cresceram. Nenhuma secção, tabela ou imagem apagada.
7. Conferência manual do texto inserido (11 linhas novas em prosa PT-PT, sem claims acima da evidência).
8. Baselines reconferidos por sha256 no fim: inalterados.

### Mudanca de fluxo: DOCX-only (decisao do utilizador)
- **DATE** = 2026-10-04
- **WORKSTREAM** = REPORT (politica de fluxo)
- **DOCX_SECTION** = — (nao toca no DOCX)
- **CHANGE** = O utilizador revogou a decisao de usar HTML como preview do relatorio. O preview HTML (`Relatorio_PAP_CyberSafe_LIVE_PREVIEW.html` + `preview-media/`) foi REMOVIDO e o portal "PAP Preview" no canvas foi FECHADO. O DOCX passa a ser a unica representacao a ver e a seguir.
  - O HTML era 100 % gerado a partir do DOCX: regenerado e comparado byte a byte, era identico. Zero conteudo unico a migrar. Verificado antes de apagar.
  - **Nao foi removido** nada mais: `docs/cybersafe-organizador-pap-v2-editavel.html` (fonte de verdade do organizador) e todos os outros HTML do projecto estao intactos.
  - O PDF mantem-se como EXPORT/SNAPSHOT. Nao e fonte e nao precisa de ser regenerado a cada save — so em checkpoint importante, antes de entrega, ou a pedido.
  - O gerador `output/pap-sprint/docx-to-html.mjs` + `html-to-pdf.js` foi mantido como FERRAMENTA de export (para gerar o PDF em checkpoint), mas **nao** como representacao do relatorio. O DOCX nunca e derivado do HTML, e o HTML nunca e derivado para ser fonte.
- **EVIDENCE** = `ls docs/relatorio PAP/` mostra apenas LIVE.docx, LIVE_PREVIEW.pdf, CHANGELOG e os dois baselines. `maestri list` ja nao mostra o portal.
- **WRITER** = Freebuff (Maestro)
- **VERIFIED** = SIM.

### Comandos DOCX-only
- **DATE** = 2026-10-04
- **WORKSTREAM** = REPORT (infraestrutura)
- **DOCX_SECTION** = — (nao toca no DOCX)
- **CHANGE** = adicionados `.maestri/tools/maestro.py report-status` (read-only) e `report-open`. `report-open` abre EXACTAMENTE o LIVE.docx pela associacao normal do Windows, sem HTML e sem conversao.
  - **Duas guardas antes de abrir**: (1) se existe `~$Relatorio_PAP_CyberSafe_LIVE.docx`, o Word tem o documento aberto — o comando recusa e reporta `REPORT_BLOCKED_BY_WORD = YES` sem tocar em nada; (2) o handler associado a `.docx` tem de ser um editor de texto.
  - **Descoberta nesta maquina**: o `.docx` esta associado ao **Opera GX** (navegador). Um `startfile` cego teria oferecido o relatorio como descarga. Por isso o comando recusa (exit 4) em vez de fingir que abriu o relatorio.
  - **Descoberta**: o Microsoft Word **nao esta instalado** (sem `WINWORD.exe`, sem CLSID `Word.Application`, sem `ClickToRun`; PowerShell COM da `REGDB_E_CLASSNOTREG` 0x80040154).
- **EVIDENCE** = `python .maestri/tools/maestro.py report-status` (exit 0) e `report-open` (exit 4, recusa justificada). Testes: `output/pap-sprint/test-report-gates.py` — **19/19**.
  - O teste apanhou uma falha REAL no validador: `report_docx_valid` nao verificava o balanceamento de `<w:p>`, ou seja, aceitaria um paragrafo por fechar. Corrigido, e o teste passou a cobrir esse caso.
- **WRITER** = Freebuff (Maestro)
- **VERIFIED** = SIM.

---

## 2026-10-04 &middot; Word Web POC &middot; DOCUMENT ID GATE + GIT_GATE

- **WORKSTREAM** = POC Word Web live editing (NÃO toca no DOCX do relatório)
- **DOCX_SECTION** = — (nenhuma secção do relatório foi tocada)
- **O QUE FOI FEITO**
  - `word-live-poc.docx` (descartável, `%TEMP%`) regenerado com o marcador único `CYBERSAFE_WORD_WEB_POC_DOCUMENT` no corpo.
  - `DOCUMENT_ID_MATCH` reescrito: passou a identificar o documento pelo **conteúdo** (marcador) + **hard block** por nome/docId do relatório real. O campo `document` do update saiu do veredicto — é escrito pelo próprio bridge, logo não é evidência.
  - `preflight.mjs` novo: `GIT_GATE` de 5 condições (`ACTIVE_DOCUMENT`, `REAL_REPORT_ACTIVE`, `QUEUE_EMPTY`, `REAL_REPORT_TOUCHED`, `TEST_DOCUMENT_CONFIRMED`). Sem o documento activo conhecido **aborta** em vez de assumir.
  - `negative-test.mjs` novo: simula o relatório real aberto e exige recusa com zero escritas, mais um contra-teste que exige aceitação no documento de teste.
  - `/queue/return` novo: um update recusado volta à fila em vez de ser perdido.
- **BUGS APANHADOS PELOS GATES (todos corrigidos)**
  - `Word.run()` **descarta** o valor devolvido pelo callback. O gate lia `undefined` e caía sempre no fallback fail-closed → teria recusado **até o documento de teste correcto**.
  - Havia **dois veredictos paralelos** (`id.match` e `runDocumentGate.ok`): divergiam em silêncio e o aplicado não era o testado. Colapsados num só.
  - O `GIT_GATE` contava `REAL_REPORT_TOUCHED = NO` como falha (polaridade invertida) e acusava um toque inexistente.
  - 4 gates de presença-de-texto sobreviviam à mutação que deviam apanhar; reescritos como **comportamentais**. 9 mutations aplicadas, todas falham o gate.
- **VERIFICADO POR EXECUÇÃO**
  - `check-manifest.mjs` → **62/62** (exit 0)
  - `negative-test.mjs` → **16/16** (exit 0)
  - `preflight.mjs` → aborta (exit 1) nos 3 caminhos que devem abortar; passa (exit 0) no correcto
- **ESTADO DO RELATÓRIO REAL**
  - `REAL_REPORT_TOUCHED = NO`. Hash `1bc89ceb…56700`, 1 089 665 B, mtime 2026-10-04 21:31:20, `WORD_LOCK=NO`, sem ficheiros `~$`.
  - A cópia no OneDrive é **PILOT COPY / DO NOT EDIT**. A fonte canónica continua a ser o DOCX local.
- **PENDENTE**
  - `TEST_DOC_ON_ONEDRIVE = NO`; upload bloqueado pela CSP do Word Web (`unsafe-eval` recusado). Sideload e T1–T5 **por executar**.
- **WRITER** = Freebuff (Maestro)
- **VERIFIED** = SIM (por execução; T1–T5 ainda NÃO executados)

---

## Baselines (intocados, nunca editar)

| Ficheiro | sha256 |
|---|---|
| `Relatorio_PAP_CyberSafe_v9_REVISTA_04-10-2026 (1).docx` | `9d7b6752852173f0c1d38e188e8ce31ec1c1bc1e9f8b2c79d4a4fdf528900ec8` |
| `Relatorio_PAP_CyberSafe_v9_REVISTA_04-10-2026.pdf` | `a6339947aadb5af4c8d8273865211c2e7d2f0c7a921b8c78cbbdd2f5a7ee99ec` |

Rever ambos no fim de cada sessão de report writing. Se qualquer um mudar, parar e reportar.
