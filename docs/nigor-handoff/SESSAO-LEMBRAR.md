# «Lembrar-me» no Nigor — 16/11/2026

O armazenamento da conta SQLite e a persistência da sessão são mecanismos
diferentes. A palavra-passe não é guardada pela interface; «Lembrar-me» guarda
apenas o bearer cifrado, que continua sujeito à validação pela API e expira
ao fim de sete dias. Sair da conta remove a sessão guardada.

## Correção

O Nigor não pertence à lista de desktops reconhecidos automaticamente pelo
Chromium. O Electron pode selecionar `basic_text`, uma chave fixa pública,
ou não disponibilizar cifra. O armazenamento de sessão verificava apenas
`isEncryptionAvailable()`, ao contrário do mecanismo de credenciais MATRIX.
Foi acrescentada seleção de `gnome-libsecret` antes de `app.ready` para
sessões Nigor, preservando um `--password-store` explícito e os restantes
desktops. A gravação/leitura persistente recusa `basic_text` e backends
desconhecidos. Não existe fallback para token em texto simples/localStorage.

Se o servidor aceitar a conta e o porta-chaves estiver indisponível, a
aplicação explica que falhou a gravação da sessão e oferece **Entrar sem
guardar a sessão**. Esse botão faz uma nova autenticação e conserva o token
apenas em memória até sair da aplicação. Uma falha de entrada ou de gravação
preserva a sessão cifrada anterior. Uma entrada temporária bem-sucedida
substitui a sessão anterior e remove a persistência. O logout remove o ficheiro
da sessão e pede a revogação do token à API. A conta SQLite mantém-se.

## Integração da sessão gráfica

- Disponibilizar `libsecret` e GNOME Keyring/Secret Service, ou KWallet com
  seleção explícita correspondente. `polkit-gnome` não é um porta-chaves.
- O serviço `org.freedesktop.secrets` deve existir no D-Bus da sessão e a
  carteira deve estar desbloqueada. A distribuição escolhe a integração de
  login/PAM; o CyberSafe não modifica PAM nem configura passwords.
- Identificar o desktop como Nigor em `XDG_CURRENT_DESKTOP`/`DESKTOP_SESSION`.
- Não utilizar `--password-store=basic` nem `--no-sandbox` como solução.
- O Higor deve incluir `libsecret` e `gnome-keyring` na imagem e garantir um
  único D-Bus de sessão, herdado pelo processo Nigor, pelo lançador e pela
  aplicação. Um arranque Xlib sem D-Bus pode lançar a sessão gráfica inteira
  através de `dbus-run-session`. Se a sessão já tiver um bus, reutilizá-lo.
- No arranque gráfico, exportar `XDG_CURRENT_DESKTOP=Nigor` e inicializar o
  componente `secrets` com `gnome-keyring-daemon --start --components=secrets`
  no mesmo utilizador e no mesmo D-Bus. Se o login do Nigor usar PAM, integrar
  `pam_gnome_keyring.so` nessa pilha para desbloquear a carteira com a palavra-passe
  de login. Sem PAM ou com login automático, disponibilizar o diálogo de
  desbloqueio da carteira. Nunca inserir palavras-passe no script.

Da sessão gráfica, confirmar o alias da carteira predefinida e a propriedade
`Locked`. Usar o caminho devolvido pelo primeiro comando no segundo. `/`
significa que ainda falta configurar a carteira predefinida.

```sh
gdbus call --session --dest org.freedesktop.secrets \
  --object-path /org/freedesktop/secrets \
  --method org.freedesktop.Secret.Service.ReadAlias default
gdbus call --session --dest org.freedesktop.secrets \
  --object-path /org/freedesktop/secrets/collection/login \
  --method org.freedesktop.DBus.Properties.Get org.freedesktop.Secret.Collection Locked
```

Com a carteira desbloqueada, testar «Lembrar-me», sair normalmente da aplicação
e reabri-la. Repetir após terminar e voltar a iniciar a sessão gráfica. Fazer
logout, reabrir e confirmar que o formulário de entrada regressa. Com a carteira
bloqueada, testar a recuperação explícita sem persistência e voltar a abrir a
aplicação para confirmar que a sessão temporária terminou. O Higor pode fazer
todo este percurso sem alterações ao código do CyberSafe.

## Evidência disponível

Treze testes dirigidos de armazenamento, IPC e seleção do backend e onze
testes do estado de autenticação no renderer passaram no Windows.
No Arch/WSL com Xvfb, D-Bus privado e GNOME Keyring real, sete etapas passaram
com Electron 33.4.11 e um token sintético. Foram exercitados a gravação cifrada,
a reabertura, a indisponibilidade de D-Bus com preservação do ficheiro, a
recuperação após criar um novo bus e desbloquear a carteira, o logout, a
sessão temporária e a reabertura sem sessão. Estes resultados cobrem o
armazenamento Electron. O percurso visual e o reinício no Nigor físico ainda
requerem confirmação.

Referência: [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
[Manual do GNOME Keyring](https://man.archlinux.org/man/extra/gnome-keyring/gnome-keyring-daemon.1.en).
