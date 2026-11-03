# Continuidade — atualizador 2026-11-03

Worktree codex-final-v020-20261103/repo; branch codex/final-v020-20261103. Base desta ronda 6ab5506. Commits 368ef56 (persistência) e 061d311 (Authenticode).

Consolidação: fixture de encerramento já estava em 6ab5506; regressão pendente passou 658 testes. Após as alterações desta ronda, desktop passou 661 testes. Atualizador passou 157 testes; typecheck e build desktop aprovados. Após corrigir o ambiente do subprocesso PowerShell, os três testes dirigidos persistência/publisher e o typecheck foram repetidos e passaram.

Persistência: booleano estrito em userData/settings.json, carregado antes da criação do updater. Configuração confiável recebe a opção guardada; runtime não configurado continua bloqueado. Falha de gravação devolve erro e repõe o estado anterior em memória. Agendador continua sem download/install, não sobrepõe chamadas e é descartado no encerramento. A escrita do ficheiro usa ainda o mecanismo síncrono existente; atomicidade contra falha de processo continua a merecer revisão.

Publisher: adaptador real Get-AuthenticodeSignature exige status Valid, tipo Authenticode e identidade exata do certificado. Usa caminho literal em variável de ambiente, comando fixo, subprocesso oculto limitado a 30 segundos/16 KiB e módulos nativos Windows. Não consulta certificados privados, não instala e não altera políticas Windows. Primeiro ensaio falhou por PSModulePath herdado do PowerShell 7; corrigido só no ambiente filho. Segundo ensaio real rejeitou scan-engine.exe, confirmado NotSigned. Sucesso com um instalador assinado legítimo ainda NÃO foi provado. Não está ligado à configuração de produção; BLOCKED_PUBLISHER e BLOCKED_INSTALLER preservados.

Atualizador completo ainda NÃO CONCLUÍDO: adaptador Installer, encerramento coordenado, reinício, confirmação da nova versão, recuperação/rollback e ponta-a-ponta de aplicação continuam pendentes. Não simular rollback de dados nem ligar produção com mocks. Próxima ação exata: definir o protocolo do instalador externo usando Installer/InstallGateContext e o encerramento já existente, com consentimento e identidade revalidados, sem executar setup pessoal. Validar falha de instalação/reinício e preservação em laboratório autorizado; prova instalada reservada à VM.

Scanner: 594 segundos não diagnosticados com corpus equivalente; testes batch/cache preservados. ClamAV: runtime/seed validados anteriormente; carga real/saúde instalada pendentes. YARA: cobertura limitada, sem regras novas. Gestor: fa064a1 preservado; prova física Notepad na VM pendente. Não repetir suites antigas sem nova alteração.

Sem source freeze, sem RC2, sem alteração da versão. Nenhuma publicação nesta ronda. Relatórios/logs locais validation-desktop-persistence.log, validation-updater-persistence-publisher.log e validation-publisher-real.log.
