# LUNA — PAP & DOCUMENTATION AUDIT (READ-ONLY)

STATUS = READY_FOR_MANUAL_TRIGGER
PREPARED_BY = Freebuff (Maestro Principal), sprint "PAP DELIVERY, REPORT, UX & RELEASE", 2026-10-04
SCOPE = READ-ONLY. Não escrever, não commitar, não instalar, não navegar fora do scope.

---

## OBJECTIVO

Auditar a dissertação da PAP e a documentação de apoio do CyberSafe Assistant para encontrar
divergências entre o que o relatório afirma e o que o produto faz, e o que o produto faz e o
relatório ainda não diz. Produzir um relatório factual. Não reescrever a dissertação.

---

## FICHEIROS PARA LER

Relatório (PAP):
- `C:\Users\caioc\Desktop\Caio\garoto de programa\cybersafe-assistant\docs\relatorio PAP\Relatorio_PAP_CyberSafe_v9_REVISTA_04-10-2026 (1).docx`  (baseline, INTOCADO — só leitura)
- `C:\Users\caioc\Desktop\Caio\garoto de programa\cybersafe-assistant\docs\relatorio PAP\Relatorio_PAP_CyberSafe_v9_REVISTA_04-10-2026.pdf`  (baseline, INTOCADO — só leitura)
- `C:\Users\caioc\Desktop\Caio\garoto de programa\cybersafe-assistant\docs\relatorio PAP\Relatorio_PAP_CyberSafe_LIVE.docx`  (fonte editável viva; pode não existir ainda)

Organizador e estado:
- `docs/CYBERSAFE_ORGANIZADOR.md`
- `docs/cybersafe-organizador-pap-v2-editavel.html`
- `docs/ORGANIZADOR_HISTORICO.md`
- `docs/ai-map/05-CURRENT-STATE.md`
- `docs/ai-map/03-CRITICAL-FLOWS.md`
- `docs/ai-map/01-ARCHITECTURE.md`
- `docs/CYBERSAFE_HANDOFF.md`
- `docs/RELEASE_DRIVER_CHECK.md`
- `docs/ROADMAP.md`

Evidência de runtime recente:
- `output/manual-retest/MANUAL-RETEST-RESULT-2026-10-03.md`
- `output/manual-retest/SCANNER_REAL_BATCH_STALL.md`
- `output/manual-retest/FINAL-WIDE-GATE.md`

Tecnologia (para conferir claims techniques):
- `packages/core/src/clamav.ts`, `packages/service/src/clam-database-gate.ts`, `packages/service/src/updater.ts`

---

## O QUE PROCURAR

1. **UNSUPPORTED_CLAIMS** — afirmações no relatório que o código, os testes ou a evidência não sustentam.
   Atenção especial a: motor ClamAV descrito como nativo quando é `clamscan.exe` orquestrado;
   YARA descrito como cobertura ampla quando há uma regra; "scan completo" quando o scan em lote real não completa;
   número de testes ou percentagens de progresso que não batem com os suites reais.
2. **MISSING_IMPLEMENTED_FEATURES** — funcionalidades implementadas e testadas que ainda não aparecem na PAP.
   Candidatos já conhecidos (confirmar no código antes de reportar):
   - gate de coordenação freshclam ↔ scan (`clam-database-gate.ts`) com distinção de causa de adiamento
   - tecto de recursos ClamAV: RAM cascade + `PEAK_CLAMSCAN_PROCESS_COUNT = 1`
   - veredicto `inconclusive` em vez de `safe` em erro do motor
   - `parseClamavOutput` a decidir pelo output e não pelo exit code
   - re-probe do motor depois de actualização bem sucedida
   - batch de ficheiros numa só invocação do motor
   - Protection Health / PcState, Matrix Terminal, organização de PC, Business (personal vs business)
3. **STALE_CONTENT** — conteúdo que reflecte um estado anterior do produto (nomes antigos, ecrãs removidos, terminologia trocada).
4. **REPORT_GAPS** — secções fracas, sem evidência, com promessas vagas, ou que descrevem o futuro como presente.
5. **DUPLICATION** — conteúdo repetido entre capítulos.
6. **INCONSISTENCIES** — divergências DOCX ↔ PDF ↔ docs ↔ organizador (títulos, numeração, números, captções de figuras).
7. **SCREENSHOTS_NEEDED** — que figuras/faltam para tornar o relatório defensável perante um júri.
8. **ORGANIZER_DRIFT** — tarefas concluídas que o organizador diz DONE mas a PAP não refere; tarefas no organizador que não existem no produto.
9. **PRESENTATION** — melhorias de apresentação de baixo risco (estrutura de tabelas, legendas, consistência de figuras).

---

## REGRAS DURAS

- READ-ONLY ABSOLUTO. Não editar o DOCX, o PDF, o organizador, o código ou qualquer ficheiro do projecto.
- Não commitar. Não executar git reset / restore / checkout -- / clean / stash / force push.
- Não ler segredos, chaves, tokens ou ficheiros .env.
- Não instalar nada (npm install, pip install, extensões).
- Não contactar a rede para "pesquisar" claims; basear a auditoria no repositório.
- Não escrever no relatório. Devolver findings.
- Não inventar. Se não conseguires confirmar um finding, marcá-lo como `UNCONFIRMED`.
- PT-PT.

---

## FORMATO DA RESPOSTA

```
LUNA_STATUS =
CONFIRMED =
UNSUPPORTED_CLAIMS =        (lista: secção do relatório, citação curta, porque não é sustentada, evidência)
MISSING_IMPLEMENTED_FEATURES =  (lista: funcionalidade, onde está implementada, secção da PAP onde deveria entrar)
STALE_CONTENT =
REPORT_GAPS =
DUPLICATIONS =
INCONSISTENCIES =
SCREENSHOTS_NEEDED =
ORGANIZER_DRIFT =
RECOMMENDATIONS =
LIMITATIONS =
```

Não escrever mais do que isto. Não escrever a PAP. Devolver findings.
