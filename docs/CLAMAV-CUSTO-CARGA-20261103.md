# ClamAV — diagnóstico das chamadas de cerca de sete segundos

Análise da evidência existente, sem novo benchmark: output/final-small-four-engines.json, corpus sintético de 7 alvos exteriores/261 bytes, sem comparação histórica. Não foram alterados motores, cobertura, prioridades ou timeouts.

| PID | Origem confirmada por trace/código | elapsedMs terminal |
|---|---|---:|
| 17008 | Prova de carga de assinaturas (load-proof) | 7147 |
| 14120 | Prefetch do lote de 6 ficheiros regulares | 7441 |
| 6320 | Prefetch do ZIP exterior, lote de 1 | 6947 |
| 32356 | Prefetch da entrada regular extraída, lote de 1 | 7115 |

Todos os filhos terminaram com code=0 e deathUnconfirmed=false; a reconciliação CIM anterior confirmou ausência dos quatro PIDs. O caso não demonstra ausência universal de órfãos.

Correção de precisão: o ZIP exterior NÃO foi analisado por fallback direto neste ensaio. O trace tem PREFETCH_BEGIN files=1 e PREFETCH_RESOLVE requested=1, e todas as oito observações ENGINE_PHASE ClamAV têm source=batch-cache. Os dois últimos processos são lotes de um ficheiro, não bypass do cache.

Cadeia no código: core/src/clamav.ts runLoadProof executa clamscan com --database e uma fixture benigna. runScanHoldingLease executa novo clamscan para cada batch, com --alert-exceeds-max=yes e a base escolhida. service/src/scan-manager.ts envia regulares ao primeiro prefetch, ZIPs exteriores a outro prefetch e entradas extraídas agrupadas a um terceiro. engine.ts prefetchClamav faz merge de resultados por dono/generation; analysis.ts consome esses veredictos sem relançar o motor. A prioridade user > health > background, leases, cancelamento e confirmação de morte existentes permanecem intactos.

O que a medição sustenta: três lotes muito pequenos gastam durações semelhantes à prova de carga; o custo fixo de criação/carga por processo é uma hipótese fortemente apoiada pela arquitetura e pelos tempos. O log terminal mede vida total do processo e NÃO isola milissegundos de carregamento da base. Não chamar aos 7147 ms medição exclusiva de parsing das assinaturas, nem somar tempos de âmbitos sobrepostos. A análise levou 22743 ms; inicialização 7373 ms separada; Node CPU/RSS não incluem os filhos.

Oportunidades a avaliar antes de alterar: agrupar regulares e ZIPs exteriores no mesmo batch preservando contagens, progresso, cancelamento, cache e análise dos conteúdos; medir cold/warm com mesmas bases e corpus; avaliar custo de muitos arquivos pequenos. O agrupamento já existente das entradas extraídas evita um processo por entrada no mesmo arquivo. Reutilização persistente via clamd seria mudança arquitetural (IPC/autenticação, memória, leases e atualização de base), não uma correção trivial nem requisito desta ronda. Não remover a prova de carga nem verificar só o ZIP exterior: ambos perderiam garantias.

Próxima experiência permitida quando houver ambiente adequado: matriz corpus regular vs mesmo corpus+ZIP, mesmas versões/hashes/base, repetições pequenas e limitadas, registo independente de CPU/RSS dos filhos e separação de init/queue/process/scan. Para provar redução da carga, acrescentar instrumentação oficial do motor ou observação apropriada; logs atuais não a isolam. O histórico 594406 ms/800 alvos mantém-se ABERTO até corpus e condições equivalentes; não há percentagem de melhoria demonstrada.
