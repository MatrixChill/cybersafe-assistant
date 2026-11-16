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
