# CyberSafe Arch Preview 3 no Nigor OS

Use a [pré-release pública Preview 3](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/linux-v0.2.4-arch-preview.3)
para Arch x86_64 e Nigor OS. A fonte é `32e627bbbeaee0b933e2ab505f674499e688c354`.
O pacote partilhado é de instalação manual experimental. A futura edição Nigor
com entrada local sem conta está em preparação e tem identidade própria.

- [Pacote 0.2.4-3](https://github.com/MatrixChill/cybersafe-assistant/releases/download/linux-v0.2.4-arch-preview.3/cybersafe-assistant-linux-lite-0.2.4-3-x86_64.pkg.tar.zst)
- [Checksums, documentação e avisos](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/linux-v0.2.4-arch-preview.3)
- SHA-256 `54bd4c2914c516cbf969d92db36eebd97d3e531ae9b2a81d65dbb18b65da2a3c`

## Atualizar da Preview 2

1. Concluir as análises e sair pela tray. Se o serviço de utilizador estiver
   ativo, pará-lo com `systemctl --user stop cybersafe-linux.service`.
   Confirmar que a aplicação e o serviço encerraram antes de mexer no perfil.
2. Copiar o perfil e as bases de dados para um diretório privado fora de
   `/opt`. Conservar o pacote anterior e a sua soma. A cópia inclui material
   sensível e ficheiros em quarentena. Guardá-la como cópia privada e manter
   ficheiros isolados nos seus diretórios e metadados originais.

   ```bash
   backup=$(mktemp -d "$HOME/cybersafe-before-preview3-XXXXXX") || exit 1
   profile="${XDG_CONFIG_HOME:-$HOME/.config}/cybersafe-assistant-linux-lite"
   data="$HOME/.cybersafe-linux-lite"
   if [ -d "$profile" ]; then cp -a -- "$profile" "$backup/electron-profile" || exit 1; fi
   if [ -d "$data" ]; then cp -a -- "$data" "$backup/local-data" || exit 1; fi
   (set -o pipefail; cd "$backup" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 -r sha256sum > SHA256SUMS) || exit 1
   (cd "$backup" && test -s SHA256SUMS && sha256sum -c --status SHA256SUMS) || exit 1
   ```

   Os ficheiros isolados podem ter modo `000`. Se a cópia ou o cálculo do hash
   falhar por falta de leitura, use um backup administrativo dos dois
   diretórios indicados, preservando proprietários, permissões e metadados.
   Verifique a cópia com a mesma autorização. Guarde os ficheiros isolados
   no backup privado com as permissões originais.

3. Verificar e instalar o pacote da release. Se a política local do pacman
   exigir uma assinatura de mantenedor, interromper e guardar o erro. O
   manifesto Ed25519 verifica o artefacto e a política do pacman continua em vigor.

   ```sh
   printf '%s  %s\n' \
     54bd4c2914c516cbf969d92db36eebd97d3e531ae9b2a81d65dbb18b65da2a3c \
     cybersafe-assistant-linux-lite-0.2.4-3-x86_64.pkg.tar.zst | sha256sum -c - || exit 1
   sudo pacman -U ./cybersafe-assistant-linux-lite-0.2.4-3-x86_64.pkg.tar.zst || exit 1
   pacman -Q cybersafe-assistant-linux-lite
   pacman -Qkk cybersafe-assistant-linux-lite
   ```

4. Abrir normalmente e verificar a conta, o histórico e a quarentena. Se o
   serviço independente era usado, voltar a iniciá-lo através do systemd de
   utilizador e consultar `journalctl --user -u cybersafe-linux.service`.
   Para recuperar de uma falha, confirmar primeiro `pacman -Q`, `pacman -Qkk`
   e o registo do pacman. Preservar o perfil pós-falha. Restaurar a versão
   anterior e a cópia fria correspondente como um par, se necessário e com
   aplicação e serviço encerrados. Confirmar previamente os checksums.

## Aceitação no Nigor

| Ensaio | Resultado esperado |
|---|---|
| Arranque e atualização manual | `pacman -Q` mostra `0.2.4-3`. Painel ligado ao serviço e configuração anterior disponível. |
| «Lembrar-me» com carteira desbloqueada | Entrar, sair da aplicação, reabrir e recuperar a conta. Repetir após fechar e iniciar a sessão gráfica. |
| Carteira indisponível ou bloqueada | O produto oferece «Entrar sem guardar a sessão». Ao reabrir após sair, a sessão temporária terminou. |
| Logout | Ao terminar sessão e reabrir, surge o formulário. A conta continua disponível para uma entrada posterior. |
| Dados | Histórico e quarentena mantêm as entradas. Após sair normalmente, verificar as bases existentes com `PRAGMA quick_check` numa ligação SQLite só de leitura. |
| Motores e execução independente | Executar `cybersafe-linux-diagnose` e `cybersafe-nigor-status`. Conferir ClamAV, YARA, HashDB e Native e correr uma análise pequena com ficheiros benignos. Testar o serviço de utilizador com a aplicação fechada. |
| Security Center e polkit | Em ambiente de ensaio com versão posterior assinada num canal compatível, verificar, descarregar, pedir instalação, confirmar no terminal e em polkit, reabrir e conferir versão e dados. O canal atualmente público continua na Preview 2. |

Para a carteira, seguir [SESSAO-LEMBRAR.md](SESSAO-LEMBRAR.md). A sessão gráfica
Nigor fornece D-Bus, libsecret e Secret Service desbloqueado, e exporta
`XDG_CURRENT_DESKTOP=Nigor`. O CyberSafe fornece a consola de segurança, motores,
serviço autenticado e clientes. O Nigor fornece as dependências, o agente polkit,
o terminal e a ligação dos componentes à barra e aos menus. A configuração de
PAM, quando usada, pertence à instalação Nigor.

## Canal e estado da prova

O manifesto e a assinatura anexados à Preview 3 foram verificados por HTTPS.
Com esse par, o cliente da candidata indicou `available` para `0.2.4-2` e
`up-to-date` para `0.2.4-3`. Passaram o download de 112065428 bytes e a reutilização
da cache. O endpoint de atualizações anterior foi preservado. O seu cliente
legado entrega ao pacman um ficheiro numa cache modificável depois da verificação.
Para avançar da Preview 2, usar a instalação manual acima. A próxima revisão
do canal precisa de isolar os consumidores antigos antes de promover uma nova
atualização assistida. A política de polkit e a sessão gráfica real continuam
por validar no Nigor.
