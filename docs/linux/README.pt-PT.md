# CyberSafe para Arch Linux

[English](README.md) · [Todos os downloads](../downloads.pt-PT.md) · [Nigor OS](../nigor-os/README.pt-PT.md)

**Experimental Preview 3**, pacote `cybersafe-assistant-linux-lite-0.2.4-3-x86_64.pkg.tar.zst`. Use a [release oficial](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/linux-v0.2.4-arch-preview.3), incluindo checksums, identidade de fonte e avisos de terceiros. Exige Arch x86_64/glibc, pacman e as dependências de execução da receita. Não é um pacote Debian/Ubuntu.

## Instalar e arrancar

1. Descarregue pacote e `SHA256SUMS.txt` da mesma release. Compare o SHA-256 completo com a entrada correspondente usando `sha256sum <pacote>`. Para verificar todas as entradas com `sha256sum -c SHA256SUMS.txt`, descarregue todos os ficheiros listados.
2. Conclua as análises, encerre normalmente a aplicação e pare o serviço independente, se ativo, com `systemctl --user stop cybersafe-linux.service`. Preserve um backup frio privado dos destinos reais dos dados/perfil e dos metadados da quarentena.
3. Execute `sudo pacman -U ./cybersafe-assistant-linux-lite-0.2.4-3-x86_64.pkg.tar.zst`. Reveja a transação. Mantenha a política de assinaturas do pacman.
4. Execute `cybersafe-linux-diagnose` e abra a aplicação pelo menu como utilizador normal. A edição genérica usa o formulário de conta.
5. Confirme versão, motores reais e uma pequena análise benigna com a respetiva entrada no histórico.

ClamAV, YARA, bases utilizáveis e serviços opcionais da sessão têm de estar disponíveis para as funcionalidades correspondentes. Siga o diagnóstico e o gestor de pacotes da distribuição. Motores ausentes não devem ser apresentados como saudáveis.

## Serviço, conta e atualizações

A unidade opcional é `cybersafe-linux.service`, de utilizador. Após abrir/fechar a aplicação para criar a credencial privada, `systemctl --user enable --now cybersafe-linux.service` inicia o serviço independente. Consulte `systemctl --user status cybersafe-linux.service` e `journalctl --user -u cybersafe-linux.service`. Isto não comprova proteção antes do login do utilizador.

«Lembrar-me» exige um Secret Service/porta-chaves suportado e desbloqueado. Se estiver indisponível, o formulário distingue a falha de persistência e oferece uma sessão temporária explícita. Senhas/tokens não devem ser persistidos em texto simples. Consulte o [guia da fonte empacotada](https://github.com/MatrixChill/cybersafe-assistant/blob/32e627bbbeaee0b933e2ab505f674499e688c354/docs/nigor-handoff/SESSAO-LEMBRAR.md).

O feed legado continua na Preview 2 para proteger os clientes antigos. A Preview 3 instala-se manualmente. Os novos clientes compatíveis usam o contrato v2 por edição; o canal genérico v2 ainda não está público nesta revisão. [Estado dos canais](../downloads.pt-PT.md#canais-de-atualização).

## Proteção, evidência e recuperação

ClamAV, YARA clássico, HashDB e motor nativo têm coberturas distintas. A monitorização deteta após escrita. A prevenção privilegiada está desativada nesta distribuição. Há evidências de laboratório de análise nativa, IPC e serviço. Dispositivos físicos, integração gráfica e cobertura ampla de malware continuam por comprovar.

Se a instalação ou o arranque falhar, preserve o log do pacman e o diagnóstico sem dados privados. Feche aplicação/serviço antes de recuperar. Guarde os dados novos antes de restaurar um backup frio e recupere bases e metadados de quarentena em conjunto. Reinstalar apenas o binário antigo não reverte uma alteração de esquema.

[Fonte e evidência Preview 3](https://github.com/MatrixChill/cybersafe-assistant/tree/32e627bbbeaee0b933e2ab505f674499e688c354/docs/nigor-handoff) · [Desenvolvimento](../development.pt-PT.md)
