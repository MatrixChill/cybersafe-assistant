# MATRIX — validação online pela interface

Estado: **NÃO EXECUTADO**. A autorização do proprietário existe; a chamada automatizada anterior foi recusada pelo ambiente com `blocked by policy`. Este procedimento destina-se a execução pelo proprietário num ambiente permitido. Não desativa restrições nem substitui uma resposta real da Groq.

## Preparação

1. Abrir a candidata CyberSafe e registar versão e commit em Configurações → Avançado → Sobre. Não instalar uma candidata no computador pessoal sem a autorização correspondente.
2. Na configuração da MATRIX, confirmar Groq e credencial presente no armazenamento protegido. Não copiar a chave para o chat, terminal ou evidência. Se a chave tiver sido exposta, substituí-la diretamente no campo protegido da aplicação e revogar a anterior no fornecedor.
3. Selecionar explicitamente o modo online. A presença de chave não prova ligação nem resposta.
4. Manter a transmissão automática de métricas desligada no primeiro pedido. Fechar outras conversas que possam produzir pedidos concorrentes. Limitar o ensaio a três mensagens curtas.

## Pedidos e critérios

| Pedido | Dados enviados | Critério |
|---|---|---|
| `Responde apenas: ligação de teste concluída.` | Só texto sintético | Resposta concluída no modo online; sem indicação de diagnóstico local/fallback. |
| `Cenário sintético: ClamAV status=active, busy=true, coverage=normal; YARA status=degraded, coverage=limited. O ClamAV está avariado? Responde em duas frases e identifica os limites.` | Estados fictícios declarados como sintéticos | Distingue ocupação de avaria; identifica a limitação YARA; não inventa causa nem afirma proteção completa. |
| `Cenário sintético: o mesmo processo PID 4242, início 2026-11-02T10:00:00Z, tem três amostras de RAM: 100, 120 e 140 MB em 60 segundos. A RAM está a aumentar?` | Processo fictício | Refere aumento de 40 MB na janela, três amostras e ausência de prova de malware/fuga. |

Não usar os cenários sintéticos como se fossem medições do computador. Para ensaiar o contexto automático real, autorizar os campos na interface, ler o resumo de consentimento e confirmar o fornecedor antes de enviar; isto é um ensaio separado. Revogar depois e confirmar que novos envios de métricas ficam bloqueados.

## Evidência sem segredos

Registar manualmente para cada pedido: data/hora PT, versão/commit, modo escolhido, texto sintético enviado, resposta integral, tempo aproximado até ao primeiro texto e até à conclusão (cronómetro), resultado PASS/FAIL e erro visível. Uma medição manual deve ser identificada como aproximada.

Confirmar a execução no histórico de utilização da conta Groq, quando disponível, correlacionando hora e modelo. Uma resposta local ou um indicador de chave presente não aprova este gate. Se não for possível confirmar a origem, marcar **INCONCLUSIVO**, mesmo que o texto pareça correto. Nunca capturar o painel de credenciais ou cabeçalhos Authorization.

| Data/hora | Versão/commit | Caso | Resposta real confirmada | Latência aproximada | Resultado | Observações |
|---|---|---|---|---|---|---|
| por preencher | por preencher | 1–3 | por confirmar | por medir | NÃO EXECUTADO | — |

401/403, 429, timeout ou modelo indisponível devem ser registados com a mensagem apresentada. Não repetir automaticamente pedidos pagos, não aumentar limites da conta e não publicar logs brutos. Os testes offline já existentes cobrem estes erros; o ensaio manual verifica o comportamento efetivamente observado.
