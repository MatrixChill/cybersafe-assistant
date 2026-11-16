# Qual distribuição usar e o que ligar no Nigor

## Para o Higor

A distribuição pública atual é [Linux/Arch Preview 2](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/linux-v0.2.4-arch-preview.2).
Usar **o pacote Arch dessa release**, também em Nigor OS, e os seus checksums.
O pacote contém os componentes em
`/usr/share/cybersafe-assistant-linux-lite/nigor-integration/`; o arquivo separado
`cybersafe-nigor-integration.tar.gz` é útil para consultar as fontes sem instalar
a aplicação. Não é um segundo antivírus nem um binário de edição diferente.

Não instalar o pacote em Debian/Ubuntu. Não usar a release Windows para Nigor.
As melhorias Linux Next descritas na branch/PR #5 ainda não pertencem à Preview 2;
aguardar o pacote novo verificado antes de esperar essas correções no sistema.

## Instalar e consultar atualizações

1. Descarregar o `.pkg.tar.zst`, SHA256SUMS, avisos e instruções da mesma release.
   Verificar `sha256sum -c SHA256SUMS.txt` com os ficheiros referidos presentes.
2. Instalar com `sudo pacman -U ./cybersafe-assistant-linux-lite-0.2.4-2-x86_64.pkg.tar.zst`,
   respeitando a política de assinaturas do sistema. Se for recusado, guardar o
   erro; não enfraquecer `SigLevel` para facilitar a instalação.
3. Executar `cybersafe-linux-diagnose` e abrir a aplicação como utilizador normal.
   Para lembrar a conta, fornecer um Secret Service/porta-chaves desbloqueado
   na sessão Nigor; ver [sessões](SESSAO-LEMBRAR.md).
4. Consultar `cybersafe-linux-update check`. O canal experimental é o predefinido;
   `prefs --stable` escolhe Stable, que pode legitimamente ainda não ter manifesto.
5. `cybersafe-linux-update download` verifica e guarda o pacote. A instalação
   é um pedido separado com consentimento e autorização do sistema; não indicar
   sucesso antes de versão e saúde pós-instalação serem confirmadas. O percurso
   instalado A→B pelo Security Center ainda precisa de validação própria.

## Instalação assistida na próxima candidata

Em **Definições → Atualizações** e no exemplo **Security Center**, verificar a
versão, descarregar o pacote e escolher **Pedir instalação**. O pedido abre o
terminal configurado pelo desktop via `xdg-terminal-exec`, ou `xterm` em X11.
O Nigor deve disponibilizar um destes caminhos. Também se pode executar
`cybersafe-linux-update install --consent` num terminal já aberto.

Antes de escrever `instalar` no terminal, concluir qualquer análise e sair
pela tray. Se o utilizador iniciou o serviço independente, pará-lo com
`systemctl --user stop cybersafe-linux.service`. O instalador recusa substituir
os binários se encontrar a aplicação ou o serviço ainda em execução. É a
autorização normal de polkit que permite continuar, seguida da confirmação do
pacman. Esta operação afeta o pacote CyberSafe. As dependências têm de estar
satisfeitas antes da instalação.

O helper privilegiado revalida a assinatura e a identidade do pacote, verifica
a cópia privada e entrega essa cópia ao pacman. O diário do sistema fica em
`/var/cache/cybersafe-assistant-linux-lite/updates/transaction-*/transaction.json`.
Depois de instalar, verificar a versão com `pacman -Q cybersafe-assistant-linux-lite`,
reabrir a aplicação e confirmar o serviço, o Scanner e o histórico. Se o serviço
independente estava ativo, voltar a iniciá-lo pelo systemd do utilizador.

Se a operação for interrompida, conservar o diário, o pacote anterior e o perfil.
Consultar `pacman -Q`, `pacman -Qkk` e o log do pacman para determinar o estado
antes de repetir. Um lock CyberSafe sobrevivente exige inspeção administrativa
do diário e dos processos antes da sua remoção. O diário regista a versão e
o estado da transação, mas a recuperação de dados requer um backup verificado.
O teste de atualização instalada com autorização polkit e reinício no Nigor
continua por concluir.

Não iniciar `freshclam` em paralelo com `clamav-freshclam-once.timer`. O Nigor
deve manter esse serviço e a base do sistema configurados; a branch nova já
delega o componente ClamAV quando encontra esse gestor. YARA e HashDB continuam
separados. O clamd opcional exige memória e uma base coincidente/atualizada;
não é ativado automaticamente pelo pacote.

## Responsabilidades

| CyberSafe | Nigor OS |
|---|---|
| Serviço, motores, Scanner, quarentena, histórico e estados factuais | Instalação/atualização das dependências do SO, políticas pacman/polkit e bases geridas pelo sistema |
| `cybersafe-nigor-status`, cliente local autenticado, adaptador C++20, exemplo de Security Center e painel | Ligar botões e eventos à `nigor-bar`, menus, ícones, notificações e Definições |
| Atualizador comum, Ed25519, download, hashes e pedidos consentidos | Fornecer agente polkit, sessão gráfica e porta-chaves desbloqueado, respeitando as políticas locais |
| Relatar limites de cobertura e recuperação | Validar a integração Wayland/Nigor no sistema real; não apresentar post-write como prevenção total |

O Security Center deve usar os comandos/JSON existentes, sem copiar o motor de
atualização ou guardar tokens de conta. As atualizações essenciais da aplicação
não exigem login. Não executar pacman através de strings de shell nem pedir
root para a interface CyberSafe.

Se surgir uma diferença real de pacote/compatibilidade Nigor, aplicar a
[política de distribuições](../distribution-channels.md): pacote e canal dedicados,
manifestos assinados e migração explícita. Hoje a identidade é `arch-shared`.
