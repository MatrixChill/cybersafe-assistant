# Scanner: lote exterior conjunto — 2026-11-03

Seed oficial verificada pelo contrato `verifyClamavSeedBundle`: 1.5.4,
4 ficheiros, 175916377 bytes, sem divergências. Diretório de evidência:
`output/clamav-seed-v020-20261103`.
YARA: cópia isolada do corpus local, SHA-256
`5a14bd42c092057ebe482f84360cc3a4f8af9bc8434671c58a98bdd48f13c444`.
20 regras carregadas, sem fallback; eficácia e cobertura continuam desconhecidas.

Corpus sintético: seis ficheiros benignos e um ZIP com um ficheiro interior.
Não é o corpus histórico de 44,35 s ou 594 s. O ZIP é gerado em cada execução
(com timestamps próprios); são conteúdos equivalentes, não identidade binária histórica.

| Medida | Antes | Depois |
|---|---:|---:|
| Scan incluindo espera do harness para histórico | 20,44 s | 13,48 s |
| Inicialização separada | 6,898 s | 6,559 s |
| Arranques ClamAV incluindo prova de carga | 4 | 3 |
| Tempo dos processos ClamAV durante scan | 19,202 s | 12,291 s |
| Espera arbiter | 0 ms | 0 ms |
| Ficheiros analisados/falhas | 7/0 | 7/0 |

O lote dos ZIP exteriores era separado do lote de ficheiros normais. Agora
partilham o mesmo processo, mantendo a análise do conteúdo extraído, limites
ZIP, quatro motores, exclusões, cancelamento e veredictos. Prefetch e batch
medem a mesma operação: não somar esses tempos. Duração dos processos não é CPU.
Monitorização em tempo real desativada neste perfil; interferência não medida.

Evidência: `output/scanner-six-verified-seed.json` e
`output/scanner-six-merged-batch.json`. Parser agora distingue tempo dos
processos, prova de carga e espera arbiter de consultas de cache.
Testes: 7 parser; 14 batch/cancelamento; regressão de 66 casos apresentou
65 aprovados e uma asserção do contrato antigo (dois lotes), atualizada para
um lote de 734 ficheiros mantendo cobertura. Os 12 casos do grupo afetado
passaram na nova execução. Compilação service aprovada.
