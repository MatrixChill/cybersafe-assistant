# Estabilização v0.2.0 — resultados

Base 82fe63e, branch codex/final-v020-20261103. Produto permanece 0.2.0-rc.1.

## Alterações

- 3c954f0: benchmark passa a preservar inicialização, fases/lotes, outcomes por motor, fontes ClamAV e chamadas reais de spawn. Extrai RESOURCE_SUMMARY existente e mede CPU/RSS do processo Node, com âmbito explícito; não inclui filhos. Prazo expirado cancela o scan próprio e falha, em vez de devolver estado ainda em execução. BENCH_REPORT grava JSON exclusivo, sem sobrescrever evidência anterior. Nenhum veredicto/limite/cobertura foi alterado.
- a258259: preflight exige versão e hash explícitos, eliminando default R7 antigo; recusa divergências antes de recolher host. Matriz VM cobre os 15 percursos, snapshots, evidência e recuperação sem alegar rollback de produto.

## Diagnóstico Scanner

Já existiam engine-init, ENGINE_PHASE, fases de ScanManager, CPU/RSS Node e spawn ClamAV. O benchmark ignorava parte dessa instrumentação. A lacuna foi corrigida; não houve otimização especulativa do motor.

Ensaio mínimo com 40 ficheiros mais ZIP: 41/41 concluídos, zero falhas, 60 ms no ScanManager, 683,3 ficheiros/s. Total medido do controlador 190,6 ms, CPU 78 ms, RSS inicial 55 111 680 B e final 64 851 968 B. 42 chamadas do motor benigno incluem o conteúdo do ZIP. São medições de um ensaio sintético mínimo, sem quatro motores reais; não provam cinco minutos nem melhoria face aos 594 segundos. RSS é amostra inicial/final, não pico.

Não foi disponibilizado/identificado neste bloco um corpus com inventário que permita reproduzir os 594 segundos. A causa histórica permanece indeterminada. Somar tempos concorrentes de motores não representa tempo total; contagens de batch-cache/direct são fontes de resultado, não um hit-rate global de todas as caches. Métricas ausentes permanecem ausentes. CPU/RSS de processos filhos e overhead por processo exigem medição separada na VM.

Reprodução segura mínima em PowerShell, a partir deste worktree:

```powershell
$env:BENCH_FILES='40'
$env:BENCH_REPORT='output/scanner-run-<id-unico>.json'
node scripts/scanner-benchmark.mjs
Remove-Item Env:BENCH_FILES,Env:BENCH_REPORT
```

BENCH_REAL=1 usa o serviço/motores reais e deve ficar para ambiente autorizado com bases/corpus identificados. O ensaio mínimo não ativa esse modo.

## Testes e estados

- 3 testes benchmark: parser, prazo/cancelamento, fases/spawn; falhas observadas antes da implementação e PASS depois.
- 1 teste preflight com dois casos negativos reais PowerShell: hash e versão recusados, sem executar instalador; PASS. A primeira execução expôs PSModulePath herdado inadequado; o harness usa módulos oficiais Windows. Códigos de erro estáveis evitam dependência de encoding da mensagem localizada.
- Core dirigido: 54 PASS, zero falhas/skip. ClamAV health recovery, prioridade de slots, probe-cache recovery, YARA coverage e terminação segura. Usa seams/fixtures; não é prova de base oficial carregada sob carga instalada.
- Serviço dirigido: 37 PASS, zero falhas/skip. Scheduler ClamAV, batch/cache, ausência de segundo percurso ClamAV e terminação individual. Não executa terminação física no PC.
- Atualizador: 7 PASS, incluindo gates de produção e confirmação de arranque idempotente. Os 673 testes desktop da base permanecem evidência anterior; não foram repetidos integralmente porque não se alterou desktop/API/core/serviço nesta ronda.
- node --check do benchmark, parser PowerShell e git diff --check aprovados.

ClamAV: nenhum defeito novo reproduzido nestes testes; saúde instalada/carga de assinaturas/timeouts sob carga real continuam por validar. YARA: cobertura limitada preservada, regras de teste não promovidas a cobertura normal. Gestor: fa064a1 é ancestral do HEAD, sem reativar kill legado; ensaio físico benigno na VM pendente.

## Atualizador, confiança e gates

Installer externo e integração com adaptadores reais preservados. release-trust.json mantém enabled=false e assistedInstallationEnabled=false, sem PEM/fingerprint. Publisher atual é rótulo académico unsigned, não uma identidade certificada aprovada. Verificação read-only do último RC1 47db123f devolveu Authenticode NotSigned/None. Não foi executado esse setup. Sem certificado/publisher legítimo, assinatura do artefacto, manifesto/chave pública/fingerprint aprovados, o percurso de produção fica bloqueado.

Reinício continua pelo fluxo NSIS existente; confirmação exige evidência, versão e dados prontos. Recuperação manual está no roteiro VM; não apagar diário para repetir nem prometer rollback automático.

## Inventário e próxima ação

Após o commit deste relatório, gerar output/stabilization-source-inventory.json: HEAD, caminhos versionados, tamanhos e SHA-256; digest separado. É inventário de trabalho, NÃO manifesto aprovado nem source freeze; não inclui node_modules ou binários ignorados. Uma futura aprovação terá de validar também dependências, binário launcher/scan-engine, seed, licenças e assets pelo processo oficial.

Próxima ação dependente de autorização: preparar artefactos legítimos e executar a matriz VM-ESTABILIZACAO-V020-20261103.md. Até lá, sem setup novo, freeze, RC2, acesso VM, mudança de versão, ativação de produção, merge, tag ou Release. Commits desta ronda locais. Worktree visual antigo preservado.
