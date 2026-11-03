# Validação manual — candidata Windows 78aff29

Preparação apenas. O proprietário escolheu executar os testes manualmente. Nenhuma VM foi iniciada, alterada ou instalada nesta sessão. VM inventariada: CyberSafe-QA-Windows11 Clonar, UUID 93104ba1-b30b-4878-9fde-f68e55bc5ff5. A entrada VirtualBox <inaccessible> não foi utilizada.

Setup preservado:
C:/Users/caioc/.cybersafe-integration/main-merge-20261103/repo/packages/desktop/release/candidate-20261103-211243-99d72e39/CyberSafe Assistant-0.2.0-rc.1-candidate-20261103-211243-99d72e39-setup.exe
278767097 bytes; SHA-256 c17111d553d75ef316ed81a062fa0ffed6b8c8827382b17618a9915a2896122b; versão 0.2.0-rc.1; NotSigned. Não substituir a RC1 pessoal.

1. No hipervisor, confirmar que a VM é descartável, sem partilhas pessoais. Criar snapshot e registar nome/UUID/data. Não continuar sem recuperação confirmada.
2. Registar Windows, RAM, disco livre e instalações CyberSafe existentes. Se houver versão anterior, não chamar ao ensaio instalação limpa: restaurar snapshot limpo ou decidir remoção apenas de dados sintéticos preservados no snapshot.
3. Copiar setup para C:\lab; confirmar Get-FileHash SHA256 contra o valor acima e Get-AuthenticodeSignature. NotSigned é conhecido. Não desativar Defender, SmartScreen, firewall ou UAC; se o Windows bloquear, capturar a mensagem e interromper esse percurso.
4. Executar interativamente o NSIS autorizado. Registar opções, diretório, atalhos, progresso e conclusão. Manter Abrir CyberSafe selecionado. Aprovação: janela visível e versão correta; não apenas ícone na tray.
5. Criar conta sintética, entrar, fechar normalmente e reabrir. Verificar sessão/configurações, Dashboard, PC Center, bateria ausente e sensores indisponíveis honestos.
6. Ocultar/minimizar e dar duplo clique na tray; verificar janela restaurada, uma instância e menu. Ativar autostart na aplicação e reiniciar só a VM; confirmar arranque e posterior desativação.
7. Analisar pasta pequena com 5 textos benignos e um ZIP simples. Registar selecionados/analisados/excluídos/inconclusivos, duração, motores e causas; comparar histórico/PDF. Não analisar o disco inteiro. Não declarar resolvidos os 594 s.
8. Registar ClamAV/YARA carregados, versões, limitações e eventuais timeouts/recuperação. Deteção EICAR só por decisão consciente do operador dentro da VM isolada; o Defender pode intercetar primeiro, o que não é deteção CyberSafe. Preservar prova do motor responsável. Quarentena/restauro exigem hash, origem e resultado reais; não usar dados pessoais.
9. Gestor: abrir Notepad descartável e confirmar PID/caminho/hora de criação. Terminar só esse processo pela confirmação individual e conferir desaparecimento no SO. Nunca terminar processos Windows para testar a proteção.
10. MATRIX: testar consultas locais de CPU/RAM/disco/proteção/processos. Groq apenas com credencial segura e consentimento; nunca colocar chave em capturas/logs. Não autorizar comandos perigosos.
11. Encerrar pela aplicação/tray e observar processos próprios remanescentes. Guardar logs redigidos e estado do serviço. Reparação e desinstalação: usar clone/snapshot separado, verificar binários/atalhos/entrada e política apresentada de preservação de dados. Não apagar ficheiros manualmente para fingir sucesso.

Por caso guardar: operador, snapshot, versão/hash, passos, esperado, observado, PASS/FAIL/BLOCKED/NOT TESTED, duração, logs/capturas. Interromper perante hash divergente, perda de dados, processo errado, elevação inesperada ou consumo descontrolado. Não instalar certificados LAB nem ativar updater nesta candidata. O ensaio entre duas versões exige artefactos e confiança próprios aprovados; ver RELEASE-CERIMONIA-E-ENSAIO-20261103.md.
