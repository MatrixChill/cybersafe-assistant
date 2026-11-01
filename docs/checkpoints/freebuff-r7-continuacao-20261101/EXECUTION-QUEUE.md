# Fila de execucao R7

Branch: freebuff/r7-final-integration-20261101
Base Qoder (ancestral): 2e3f311
origin/main intocada: 21fefa69

## DONE
- A1 branch publicada: SHA remoto igual ao local a542cb4
- A2 auditoria pre-publicacao: sem segredos, binarios, bases ou logs privados
- B1 ClamAV: causa real identificada; prova real com freshclam exit 0, 3628245 assinaturas, bridge active e scan clean; 109 PASS; VM pendente
- B2 Native: probe active, scan safe, 0 filhos; 32 PASS
- C1 quarentena: 29 PASS sem reescrita

## BLOCKED
- D1 falhas historicas Service: suite interrompida sem resumo; 8 grupos falham pela guarda de terminacao (recusa deliberada D6)
- F1 MATRIX real: falta credencial BYOK
- G1 HashDB real: falta chave do MalwareBazaar
- H1 snapshot e NSIS: pre-check exit 1, bundle vendor/clamav e registo de autorizacao ausentes
- I1 VM, Ed25519 de producao e versao 0.2.0: dependem do proprietario

## NEEDS_HUMAN_VALIDATION
- E1 exclusoes: 9+9+8 PASS; falta clique real na janela Electron

## Atualizacao desta sessao
- DONE H2: bundle ClamAV oficial regenerado (45 ficheiros, 132.7 MiB, GPG Talos, fonte incluida). Pre-check 5 -> 1.
- DONE C2: quarentena em lote (selecao, confirmacao, resultado por ficheiro, nao tentados contados). 106 PASS, typecheck 0.
- BLOCKED H1: resta apenas o registo externo de autorizacao (decisao humana).
- NEXT: atualizador da aplicacao com chaves efemeras; exclusoes ponta a ponta; falha de isolamento P0.
- DONE F2: atualizador da aplicacao 63 PASS (chave real continua pendente).
- DONE E2: exclusoes ponta a ponta 34 PASS.
- DONE D2: isolamento P0 corrigido (7 PASS); YARA rollback 10 PASS; contrato do bundle 33 PASS.
- MEASURED D3: service delimitado 1290 testes / 1274 PASS / 11 FAIL / 5 SKIP; os 11 sao a familia de identidade dentro de killProcess, recusada globalmente.
- BLOCKED H1: falta apenas o registo externo de autorizacao (humano). Versao 0.2.0 e Ed25519 de producao tambem sao humanos.
- NEXT (se houver nova sessao): decidir com o proprietario se a familia de identidade deve ser adaptada ao contrato de recusa ou se o kill legado sera reativado com prova de identidade.
- DONE H2: candidata NSIS interna construida (exit 0) e validada; sha256 e558f35b...40164.
- DONE: manifesto congelado registado (1802 ficheiros, digest 9eb69e88...b323).
- NEXT: ensaio na VM com R7-VM-TEST-PLAN.md; reconciliar os 11 contratos numa candidata posterior.
- DONE: ClamAV deixa de degradar por ocupação; revalida no fim do scan.
- DONE: fila de tempo real prioriza Downloads e recupera com backoff/orçamento maior.
- DONE: Gestor de Tarefas recebe causas específicas; Painel colapsa progresso do mesmo scan.
- PENDING: medir o Scanner instalado com CYBERSAFE_DEBUG_SCAN=1 (nativo medido em ~12 ms; 830 s não é o spawn nativo).
- PENDING: inconclusivos (22 cobertura + 1 falha de motor), quarentena automática na UI, MATRIX contextual, layout do Otimizar, atualizações, WFP opcional.
- NEXT: nova aprovação de freeze e candidata; não reutilizar o manifesto anterior.
- DONE: quarentena automática configurável com consentimento e persistência.
- DONE: Otimizar mostra os quatro motores e a data de definições quando medida.
- DONE: log do Scanner separa enumeração, laço, motor e overhead.
- VERIFICADO: MATRIX/gestor/atualizações 105 PASS; WFP 4 PASS.
- PENDING: inconclusivos por motor/fase; ensaio instalado; visual Electron; WFP e updates oficiais.
