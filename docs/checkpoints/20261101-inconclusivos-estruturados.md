# Checkpoint — inconclusivos estruturados

## Estado

Implementado no R7 o percurso completo da lacuna:

- `FileScanResult.inconclusiveReason` transporta um código fechado.
- `FileScanResult.inconclusiveEngines` identifica `native`, `clamav`, `yara`,
  `archive` ou `filesystem` quando a atribuição é possível.
- O motor atribui a causa sem pesquisar palavras em `detail`.
- O ScanManager prefere o código do motor, agrega motivo e motor, e mantém o
  classificador textual apenas como compatibilidade com respostas antigas.
- O histórico persiste e valida as nove causas e os cinco motores.
- O Scanner e o histórico mostram os motivos e os motores com lacunas.
- Uma lacuna de arquivo é `archive-incomplete`, não a categoria genérica.

## Evidência

- `npm run build -w @cybersafe/shared-types`: PASS.
- `npm run build -w @cybersafe/service`: PASS.
- `npm run typecheck -w @cybersafe/app`: PASS.
- Testes Native + ScanManager: 53/53 PASS.
- Teste da etiqueta de motores: PASS.

## Limitações

- Não foi executada uma medição equivalente ao cenário de 800 ficheiros/830 s;
  a meta de cinco minutos continua por provar.
- Nenhuma validação na instalação Windows foi feita nesta alteração.
- A UI foi verificada por typecheck e teste unitário, não numa janela Electron
  instalada.

## Próximo passo

Medir o cenário de análise rápida no ambiente apropriado e depois ligar a
instrumentação por motor aos tempos de Enumeração, I/O, ClamAV, YARA e Native.
