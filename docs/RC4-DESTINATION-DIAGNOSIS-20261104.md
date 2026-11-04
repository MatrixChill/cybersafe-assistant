# RC4 — recusa do destino na RC3

## Causa reproduzida

A execução física da RC3 terminou com exit 2 em `destination-refused`, antes
da fase crítica. Os registos antigos não guardam os argumentos; a atribuição
da causa assenta na reprodução do mesmo comando e template, não em valores
que os logs antigos não contêm.

O wrapper passou `/currentuser /D=<destino com espaços>`. O parser nativo NSIS
aceita `/D` no fim, sem aspas, incluindo espaços. Porém, `initMultiUser` do
electron-builder chama `StdUtils.GetParameter D`, que corta o valor no primeiro
espaço e substitui `$INSTDIR`. No destino autorizado, perde-se ` Assistant`.
O frontend conserva esse valor; `ValidDestination` aceita a sintaxe, mas
`SafeInstallTarget` recusa a diferença perante o destino registado.

Verificações read-only:
- InstallLocation existe em HKCU Software/7f4c0981-4cbf-53f9-af6e-a266427c7961,
  igual nas vistas 32 e 64; o template seleciona a vista 64.
- APP_GUID corresponde ao UUID derivado de com.cybersafe.assistant;
  APP_FILENAME é CyberSafe Assistant. Não há convenção de registo antiga a migrar.
- Os três argumentos do plugin estão na ordem correta. O DLL original aceita
  o destino completo com o registo real sem modificar a instalação.
- Não há reparse points nos antecessores do destino. Não foi necessária
  normalização permissiva, alteração do registo ou exceção ao gate.

## Correção limitada

`preInit` guarda o `$INSTDIR` interpretado pelo NSIS quando existe `/D`.
`customInit` restaura-o no percurso interativo, depois de `initMultiUser` e
antes de abrir o Orbital. A escolha final continua sujeita à mesma validação.
Sem `/D`, o destino continua a vir da lógica original do electron-builder.
O percurso silencioso não foi alterado.

O plugin passa a devolver motivos fixos, sem caminhos ou segredos:
`invalid-path`, `registered-path-mismatch`, `product-leaf-mismatch`,
`unregistered-occupied-directory`, `destination-inspection-failed` ou `ok`.
O trace de recusa inclui o motivo. A política de aceitação é a mesma.

## Evidência e reprodução

- `node scripts/test-orbital-destination.mjs --rc3`: DLL original, oito casos;
  reprodução independente do parsing nativo correto e truncagem pelo StdUtils.
- `node scripts/test-orbital-destination.mjs`: oito casos e motivos específicos;
  registo exato, pasta nova, registo ausente, registo divergente, pasta arbitrária,
  junction, barra final e caminho relativo. Documento benigno preservado.
- `node scripts/test-orbital-full-lab.mjs`, seguido de
  `powershell -NoProfile -File scripts/setup-ui/test-full-backend.ps1 -InteractiveUpgrade`:
  template completo, identidade única descartável, produto com espaços.
  Antes da correção falhava em "Interactive upgrade did not offer the registered destination".
  Depois: instalação A, abertura do executável benigno, atualização interativa B
  com `/D`, 22 hashes por versão, registo, dados separados e desinstalação.
- Suite backend LAB: 11 percursos, incluindo cancelamento, destinos recusados,
  falha, corrupção e ausência de verificação. Sem instalação pessoal.
- 25 testes dirigidos de contrato, compilação NSIS, versão e packaging aprovados.

Os resultados são LAB de payload benigno: não comprovam instalação da aplicação
RC4, SQLite real ou updater GitHub A→B. RC3 e o backup frio ficam preservados.
RC4 exige novo inventário, aprovação de freeze e autorização específica de
instalação para o novo hash. Não reutilizar a aprovação da RC3.
