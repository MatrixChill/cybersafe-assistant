# Installer externo Windows — checkpoint de engenharia

Branch: `codex/final-v020-20261103`. Base: `a1cb3f9`.
Commits: `930275f` (retry atómico limitado), `bf4c4ce` (executor e confirmação), `87cdff2` (recurso nativo e inventário).

## Capacidade implementada

O adaptador copia o artefacto para staging próprio, aplica DACL utilizador/SYSTEM e rejeita caminhos remotos, volumes não fixos e reparse points. O auxiliar mantém handles Windows que impedem escrita/substituição do instalador e renomeação dos diretórios ancestrais. SHA-256 é calculado pelo handle; identidade volume/file-index e tamanho são comunicados pelo pipe privado. Ed25519 e Authenticode são revalidados antes do COMMIT. Consentimento é revalidado e o diário é persistido antes de reutilizar o encerramento existente.

O launcher Win32 usa PowerShell do Windows, handles herdados explicitamente e breakaway autorizado pelo sistema. A recusa do job bloqueia o percurso. O auxiliar espera o handle do processo-pai, executa apenas o ficheiro bloqueado, conserva os locks até à saída e grava evidência atómica. Mutex por utilizador impede auxiliares simultâneos. Não termina processos alheios.

O arranque reconcilia identidade da operação/ficheiro, resultado, versão real, saúde da API própria e integridade/esquema SQLite. Exit zero deixa `awaiting-start`; não significa sucesso. Interrupções, falhas, versão errada e dados indisponíveis exigem recuperação manual e bloqueiam repetição automática. Não existe rollback automático ou restauro de backup validado.

Ambos os gates de produção continuam desativados: confiança e instalação assistida. Não foram inventados certificados, publishers ou chaves de produção. O lançamento normal após NSIS continua dependente do fluxo existente `runAfterFinish` e da opção final; o auxiliar não força outro arranque se a pessoa desmarcar essa opção.

## Evidência

- Laboratório nativo: 5 testes aprovados, incluindo processos reais, saídas 0/7, sobrevivência ao pai, bloqueio de escrita/renomeação, hash divergente, publisher recusado, consentimento retirado e falha de shutdown.
- Evidência temporária: `C:\Users\caioc\AppData\Local\Temp\cs-handoff-e2e-yENF6w` e `C:\Users\caioc\AppData\Local\Temp\cs-handoff-e2e-Yf6WRa`.
- Simulador C++ inerte: não instala, não altera registo/serviços e não usa rede. O seam de publisher do laboratório não é utilizado na produção.
- 61 testes de packaging/inventário aprovados. Alterar o binário auxiliar invalida o inventário futuro. Nenhum manifesto de freeze foi emitido.
- 6 testes do gate de confiança aprovados. Dois testes SQLite, incluindo base real em memória e verificação de ausência de alterações, aprovados.
- Typecheck desktop e builds desktop/API aprovados. Vite mantém avisos de configuração obsoleta (`customResolver` e `freeze`); build termina com sucesso.
- Regressões completas e logs: `validation-installer-desktop-final.log` e `validation-installer-api.log`, na raiz deste worktree. Contagens finais no checkpoint de entrega.
- Uma invocação direta com strip-types falhou na resolução `.js`/`.ts`; repetida com o loader oficial `tsx`, passou. Uma falha transitória EPERM de rename motivou retry limitado a 150 ms, sem apagar o destino.

## Limites e próximo gate

Não foi executado setup real, acedida VM, gerada RC2, alterada versão, emitido freeze, merge, tag ou Release. A validação instalada continua pendente: NSIS limpo/upgrade/reparação/desinstalação, abertura visível, tray, versão instalada, preservação/migração de dados reais e comportamento perante interrupção. O laboratório demonstra o protocolo, não instalação real nem preservação semântica de uma base migrada.

Scanner: os 594 segundos continuam sem corpus/log equivalente; não foi repetida carga pesada no PC pessoal. ClamAV: sem nova prova instalada sob carga. YARA: cobertura e limitações anteriores preservadas. Gestor de Tarefas: prova instalada com processo benigno continua pendente. Não foram reconstruídos esses componentes.

Próxima ação: ensaio instalado apenas após autorização de ambiente apropriado, com artefacto legítimo e confiança aprovada; manter produção bloqueada até esses gates. O código e o laboratório podem ser repetidos com `node scripts/test-updater-handoff-lab.mjs`.
