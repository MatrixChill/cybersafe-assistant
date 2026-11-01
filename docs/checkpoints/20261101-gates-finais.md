# Checkpoint — gates finais da candidata

## Concluído nesta continuação

- Scanner: causa e motor dos inconclusivos são códigos estruturados,
  agregados no estado, persistidos no histórico e mostrados na UI.
- Teste do percurso individual: 6/6 PASS.
- UI do Gestor de Tarefas: 83/83 PASS.

## Testes do caminho legado

`process-kill.test.js` mantém 31 falhas concentradas no caminho `killProcess`,
que está deliberadamente desativado por `KILL_TERMINATION_DISABLED`. Não foi
reativado. A reconciliação desses testes antigos com o contrato protegido
continua pendente e não foi mascarada com SKIP.

## Verificação de packaging

Comando executado, sem build e sem instalação:

`node scripts/package-windows.mjs --check --candidate --json`

Resultado: **bloqueado**.

- Licenças: sem bloqueador.
- YARA: PASS.
- Bundle ClamAV: PASS.
- Source freeze: `approver-registry-missing` — `CYBERSAFE_APPROVERS_FILE`
  não está definida.
- Seed ClamAV: `not-provided` — falta recurso offline verificado.

O `--check` não criou staging nem instalador. A versão do desktop continua
`0.1.2`; não foi alterada para `0.2.0` sem uma candidata aprovada.

## Bloqueadores humanos

- Referência visual `index.html` não está presente no projeto.
- Registo de aprovadores do source freeze.
- Seed ClamAV offline verificada.
- Aprovação visual do Orbital Glass V3.
- Testes numa VM autorizada.
- Autorização de merge, tag e Release.

## Próximo passo

Depois de receber a referência `index.html` e os gates humanos, evoluir o NSIS
existente, gerar capturas reais do setup e repetir a verificação de packaging.
