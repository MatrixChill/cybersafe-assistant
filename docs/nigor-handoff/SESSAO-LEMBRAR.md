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

Se faltar o porta-chaves, o login apresenta a instrução para o ativar ou
desmarcar «Lembrar-me» e utilizar apenas a sessão atual. Não altera contas,
ficheiros anteriores ou palavras-passe. Uma sessão antiga cifrada com outro
backend pode exigir uma nova autenticação; a conta mantém-se.

## Integração da sessão gráfica

- Disponibilizar `libsecret` e GNOME Keyring/Secret Service, ou KWallet com
  seleção explícita correspondente. `polkit-gnome` não é um porta-chaves.
- O serviço `org.freedesktop.secrets` deve existir no D-Bus da sessão e a
  carteira deve estar desbloqueada. A distribuição escolhe a integração de
  login/PAM; o CyberSafe não modifica PAM nem configura passwords.
- Identificar o desktop como Nigor em `XDG_CURRENT_DESKTOP`/`DESKTOP_SESSION`.
- Não utilizar `--password-store=basic` nem `--no-sandbox` como solução.
- Confirmar no Nigor: login com «Lembrar-me», fechar normalmente, reabrir e
  validar a identidade; depois sair da conta e confirmar novo pedido de login.

## Evidência disponível

11 testes dirigidos de armazenamento, IPC e seleção do backend passaram.
No Arch/WSL com Xvfb, D-Bus privado e GNOME Keyring real, um processo Electron
33.4.11 gravou uma sessão sintética e outro processo independente recuperou-a;
ambos confirmaram `gnome_libsecret`. Não foram usadas credenciais pessoais.
Este ensaio não substitui a confirmação na sessão Nigor do utilizador.

Referência: [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
