# Testes históricos do kill legado

Estes ficheiros foram arquivados em 2026-11-01, a partir de `d0d980f`.

## Motivo

`ProtectionEngineService.KILL_TERMINATION_DISABLED` está deliberadamente a `true`.
O contrato atual é fail-closed: `killProcess` recusa antes de consultar o SO,
antes de executar `taskkill` e antes de publicar eventos. Os 30 cenários de
`process-kill.test.js` e os 5 de `kill-budget.test.js` exercitam o caminho
legado que já não é alcançável; mantê-los na suíte ativa produziria falhas
esperadas e não provaria o comportamento suportado.

Eles não foram apagados nem convertidos em SKIP. Ficam aqui como registo
histórico do contrato anterior, com os comentários e fixtures originais.

## Contrato ativo

- `test/kill-contract.test.js` — recusa auditada, sem consulta ao SO, sem
  `taskkill`, sem eventos e sem alteração da lista.
- `test/individual-process-termination.test.js` — protocolo individual
  protegido: preparação, confirmação, evento `single-process` e auditoria
  sanitizada.
- `test/processes-list-contract.test.js` — listagem, cache e `processMonitor`,
  que não dependem do kill e continuam ativos.

## Execução

Estes ficheiros não são incluídos por `npm test` nem por `test:full`. Só devem
ser executados manualmente se uma decisão de produto reabrir o caminho legado;
nesse caso, a decisão e o novo contrato têm de ser explícitos.
