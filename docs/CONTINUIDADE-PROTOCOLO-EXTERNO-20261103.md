# Continuidade — persistência e protocolo externo, 2026-11-03

> Estado histórico substituído por [VALIDACAO-INSTALLER-EXTERNO-20261103.md](VALIDACAO-INSTALLER-EXTERNO-20261103.md): o executor externo e a reconciliação foram implementados e ensaiados com simulador benigno. Instalação real permanece pendente.

Base 5430455; branch codex/final-v020-20261103. Commits b196fd9 (settings atómicos) e 25fb96f (diário de instalação).

Implementado e testado: escrita num temporário exclusivo wx no diretório do destino, fsync antes de fechar e rename. Não existe delete/recreate do destino em caso de bloqueio Windows. Falhas em write/fsync/rename preservam o JSON anterior; temporários incompletos nunca são carregados como settings. O fsync do ficheiro não constitui garantia contra todas as falhas de hardware/controlador.

Diário: prepared → shutdown → installing → awaiting-start → completed; exige consentimento, manifesto/versão correspondentes e scan idle. Exit zero só chega a awaiting-start. Token da operação, versão efetiva e dados prontos são necessários para completed. Erros do instalador, versão errada, dados não prontos ou interrupção levam a recovery-required e bloqueiam nova tentativa. Não há rollback automático implementado. O diário não substitui a verificação criptográfica nem um bloqueio entre processos.

Evidência: regressão desktop 664/664; typecheck e build aprovados. Depois, quatro testes dirigidos passaram com casos adicionais de falhas write/fsync/rename, exit 1603, versão incorreta e dados indisponíveis. Todos usam diretórios temporários próprios. Nenhum setup executado, nenhuma VM acedida, nenhuma instalação provada.

Lacuna principal permanece: o diário ainda NÃO está ligado a um Installer externo. Ainda não existe componente que mantenha o instalador bloqueado contra escrita/substituição através de um handle Windows enquanto revalida e executa, nem handoff com encerramento/reinício real e confirmação de migração. Não ligar production nem chamar esta parte concluída. BLOCKED_INSTALLER e BLOCKED_PUBLISHER mantidos.

Próxima ação exata: implementar o executor externo com contrato de entrega e handshake, proteção de identidade do ficheiro por handle Windows (não apenas hash seguido de spawn), validação Authenticode real e ligação ao encerramento existente. Só depois integrar UpdateJournal; confirmar concorrência entre processos, timeout de arranque e dados preservados em laboratório. Recuperação deve ser manual quando não existir rollback seguro comprovado.

Scanner/ClamAV/YARA/Gestor: estados e evidências da matriz anterior preservados. 594 s sem corpus equivalente, carga ClamAV instalada e Notepad físico continuam pendentes. Sem alterações de versão, freeze ou RC2. Commits locais, sem publicação nesta ronda.
