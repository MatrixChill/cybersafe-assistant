# Motores de análise

| Motor | Função | Limite da interpretação |
|---|---|---|
| ClamAV | Análise com bases de assinaturas e suporte de arquivos dentro dos limites do motor. | Disponibilidade não comprova ausência de ameaças; carregar a base e esperar pela vaga têm custos próprios. |
| YARA | Avaliação de regras pelo adaptador YARA clássico (`yara64.exe` / `yarac64.exe`). | Carregar regras não prova cobertura ampla de malware. |
| HashDB | Correspondência exata com hashes conhecidos. | Só reconhece entradas presentes nas definições usadas. |
| Native C++ | Hash, entropia e sinais heurísticos de ficheiros, incluindo PE. | Heurística não é uma garantia de deteção por assinatura. |

O serviço combina resultados e preserva falhas/inconclusivos. O estado de saúde de um motor e a cobertura efetiva de uma análise são eixos diferentes. Não transformar indisponibilidade em resultado seguro.

Fontes: [core](../packages/core/src/index.ts), [serviço](../packages/service/src/engine.ts), [motor nativo](../packages/native-engine/README.md), [proveniência](../assets/licenses/PROVENANCE.json).

[Voltar à documentação](README.md)
