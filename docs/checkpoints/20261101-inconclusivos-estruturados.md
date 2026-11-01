# Checkpoint — inconclusivos estruturados

## Estado

Implementado no R7 o primeiro elo entre o motor e a apresentação:

- `FileScanResult.inconclusiveReason` transporta um código fechado.
- Causas de Native, YARA, ClamAV, ficheiro alterado e arquivo são atribuídas
  pelo motor, não por pesquisa de palavras em `detail`.
- O ScanManager prefere o código do motor e usa o classificador textual apenas
  como compatibilidade para respostas antigas.
- O histórico aceita as nove causas que o R7 já produz; antes, `timeout`,
  `invalid-output`, `file-changed`, `archive-incomplete` e `cancelled` podiam
  fazer a entrada ser rejeitada na leitura.
- Uma lacuna de arquivo passa a ser `archive-incomplete`, não a categoria
  genérica `coverage-incomplete`.

## Evidência

- `npm run build -w @cybersafe/shared-types`: PASS.
- `npm run build -w @cybersafe/service`: PASS.
- `node --test packages/service/test/qa3-native-result.test.js packages/service/test/scan-manager.test.js`:
  53/53 PASS.
- Antes do commit, `git diff --check`: PASS.

## Limitações

- A causa já é estruturada, mas o nome do motor que falhou ainda não é agregado
  no estado do scan nem no histórico. O próximo passo é `InconclusiveEngineCount`.
- Não foi executada uma medição equivalente ao cenário de 800 ficheiros/830 s;
  a meta de cinco minutos continua por provar.
- Nenhuma validação na instalação Windows foi feita nesta alteração.

## Próximo passo

Agregar `InconclusiveEngineCount` no ScanManager/histórico/UI e depois medir o
cenário de análise rápida no ambiente apropriado.
