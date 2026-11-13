# CyberSafe no Nigor OS — primeiro teste

Este guia destina-se ao responsável pelo Nigor OS. A edição é experimental:
foi ensaiada em Arch/WSL2 e X11 virtual, não numa sessão Nigor real. Não é uma
certificação de antivírus. Comece numa instalação descartável ou perfil de
ensaio, com cópia de recuperação e sem ficheiros pessoais.

## Obter e instalar

Origem prevista da edição autorizada:
[Arch Experimental Preview](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/linux-v0.2.4-arch-preview.1).
Só descarregue quando a página estiver publicada e contiver os ficheiros abaixo;
uma página inexistente não é uma entrega concluída. Não use o Setup Windows.

Requisitos: Arch compatível, x86_64, pacman com repositórios configurados,
systemd de utilizador, sessão gráfica e sandbox Chromium funcional. Wayland e
adaptações específicas do shell Nigor precisam deste primeiro ensaio. O Electron
33.4.11 preserva o runtime já testado, mas é uma linha antiga; esta prévia não é
recomendada para produção, navegação arbitrária ou dados sensíveis.

Descarregue para uma pasta vazia:

- `cybersafe-assistant-linux-lite-0.2.4-1-x86_64.pkg.tar.zst`
- `SHA256SUMS.txt`
- notas e avisos da versão.

Na pasta dos downloads:

```bash
uname -m                         # deve mostrar x86_64
sha256sum -c SHA256SUMS.txt       # todas as entradas descarregadas: OK
pacman -Qip ./cybersafe-assistant-linux-lite-0.2.4-1-x86_64.pkg.tar.zst
pacman -Qlp ./cybersafe-assistant-linux-lite-0.2.4-1-x86_64.pkg.tar.zst
sudo pacman -U ./cybersafe-assistant-linux-lite-0.2.4-1-x86_64.pkg.tar.zst
pacman -Qkk cybersafe-assistant-linux-lite
```

Pare se o hash não coincidir. O pacote de ensaio não tem assinatura de mantenedor
Arch: o SHA-256 confirma integridade, não substitui uma cadeia de assinatura.
Não desligue políticas de assinatura ou outras proteções para forçar a instalação.
Se a política do Nigor recusar o pacote local, devolva o erro ao autor.

O pacman resolve as dependências obrigatórias declaradas: Node.js, gcc-libs,
GTK3, NSS/NSPR, Mesa, ALSA, CUPS e bibliotecas X11. Dependências opcionais:

```bash
# Num sistema já atualizado segundo as regras do Nigor:
sudo pacman -S --needed clamav yara zenity libsecret
```

Não execute `pacman -Sy` isoladamente. ClamAV/YARA são instalados pelo Arch,
não estão incorporados como executáveis no pacote CyberSafe. Zenity é necessário
para o painel gráfico. O armazenamento seguro depende também do keyring da sessão.

## Abrir e confirmar o arranque

Abra a entrada **CyberSafe Assistant Linux Lite** no menu, ou execute como
utilizador normal:

```bash
cybersafe-assistant-linux-lite
```

Nunca use `sudo`, root ou `--no-sandbox` para abrir o Electron. Se houver falha
de sandbox, registe-a e pare esse percurso. Crie uma conta local de teste, sem
reutilizar palavras-passe pessoais. Confirme login, Dashboard e PC Center.

Com a janela aberta, a API da aplicação pode ser verificada sem consultar dados:

```bash
curl --fail http://127.0.0.1:4000/health
```

Procure `service: cybersafe-api` e `databaseReady: true`. Este endpoint apenas
confirma prontidão. As operações de conta exigem autenticação; não partilhe JWTs.
A API HTTP acompanha a aplicação gráfica: pode parar quando a janela termina.
Isso não é uma falha da unidade de proteção independente.

## Serviço persistente e painel

O pacote **não ativa a unidade automaticamente**. Depois do primeiro arranque,
feche normalmente pela tray com **Sair**. A credencial privada já deve existir.
Execute na mesma conta Linux:

```bash
systemctl --user daemon-reload
systemctl --user start cybersafe-linux.service
systemctl --user status cybersafe-linux.service --no-pager
cybersafe-nigor-status
cybersafe-nigor-panel --dialog
```

O estado JSON deve ter `version: 1` e `serviceRunning: true`. Monitorização
desativada é diferente de serviço parado. Não interprete um motor ativo como
prova de cobertura completa. O painel permite atualizar, abrir a aplicação e
fechar; também deve explicar quando o serviço está indisponível.

Se desejar testar arranque automático **desta unidade de utilizador**, depois
de validar o arranque manual:

```bash
systemctl --user enable cybersafe-linux.service
# Para reverter essa escolha:
systemctl --user disable cybersafe-linux.service
```

Não habilite lingering, serviços root ou políticas globais para este ensaio.
Reabra a aplicação: deve reutilizar o serviço autenticado. Depois de sair da
aplicação, consulte novamente `cybersafe-nigor-status`: com a unidade iniciada,
o serviço deve continuar disponível. Para o parar explicitamente:

```bash
systemctl --user stop cybersafe-linux.service
```

## Scanner, histórico e métricas

Crie apenas uma pasta de texto benigno:

```bash
testdir=$(mktemp -d /tmp/cybersafe-nigor-test.XXXXXX)
printf 'Ficheiro benigno de teste CyberSafe\n' > "$testdir/benign.txt"
printf '%s\n' "$testdir"
```

Na interface, escolha uma análise personalizada dessa pasta. Confirme a
conclusão, os ficheiros analisados, falhas e inconclusivos. Consulte o histórico
e o cartão Última análise. Não considere inconclusivo como seguro.

Também pode usar o cliente com consentimento explícito:

```bash
cybersafe-nigor-status scan --consent "$testdir"
cybersafe-nigor-status
# Para cancelar apenas a análise cujo ID acabou de receber:
cybersafe-nigor-status cancel --consent ID_DA_ANALISE
cybersafe-nigor-status processes
cybersafe-linux-diagnose
```

Aceitação do pedido não é conclusão. O histórico confirma o estado terminal.
A consulta de processos devolve até 50 linhas, o total e a frescura; cache/falha
não significa informação atual. CPU zero é uma medição válida; `null` é ausência
de leitura. Não teste terminação de processos pessoais neste primeiro ensaio.

## Motores e firewall

- **ClamAV:** precisa de bases oficiais legíveis e atuais. Consulte o estado e
  o erro antes de repetir uma atualização. Se for necessário provisionar a base
  de sistema num ambiente descartável, siga o procedimento Arch do ClamAV;
  `sudo freshclam` é uma operação separada e explícita. Não execute dois
  atualizadores sobre a mesma base. Respeite cooldown/recusas do CDN; não apague
  o estado de cooldown nem ficheiros de definições para o contornar.
- **YARA:** carregar regras não prova cobertura ampla. O corpus de fallback
  contém um canário de teste, não uma base completa de malware.
- **HashDB:** a base embutida é limitada; não equivale a deteção universal.
- **C++:** o pacote inclui `resources/scan-engine` ELF. A UI deve declarar a
  indisponibilidade se o processo não puder arrancar.
- **Firewall:** `cybersafe-linux-diagnose` e o painel consultam firewalld, UFW e
  nftables sem alterar regras. Ausente ou sem permissão não significa desligado.

Não desligue as proteções do Linux. Não introduza malware ou EICAR neste
primeiro teste. A quarentena/restauro foi exercitada nos módulos instalados
com uma fixture positiva sintética; o percurso completo pela UI/IPC continua
pendente. Não mova ficheiros pessoais para a quarentena para tentar prová-lo.

## Integração com a barra e as Definições do Nigor

Não se pressupõe KDE, GNOME, Hyprland ou outro shell específico.

| Componente disponível | Utilização possível pelo Nigor |
|---|---|
| `cybersafe-nigor-status` | Indicador de estado, motores, alertas e métricas |
| `cybersafe-nigor-status processes` | Vista limitada de processos com frescura |
| `cybersafe-nigor-panel --dialog` | Ação de painel rápido, sem criar outra aplicação |
| `cybersafe-linux-diagnose` | Diagnóstico de dependências, sessão e firewall |
| `cybersafe-assistant-linux-lite.desktop` | Entrada de menu e ação Estado de proteção |
| Ícone hicolor `cybersafe-assistant-linux-lite` | Ícone oficial para barra/menu |

A comunicação destes comandos usa o socket Unix autenticado existente. Eles
leem a credencial privada sem a expor nos argumentos. Não leia, copie ou publique
`pipe-credential`, JWTs ou credenciais MATRIX. Não crie outra API HTTP ou serviço
root para o painel. Uma consulta de cada vez, com intervalos moderados, evita
tempestades de pedidos; atualizações não devem bloquear a barra.

As adaptações visuais definitivas dependem da API/extensões do shell Nigor e
serão feitas depois deste ensaio. Os módulos internos são responsabilidade do
CyberSafe. Precisamos apenas das informações do shell e dos resultados de uso.

## Encerramento, dados e diagnóstico

Dados do serviço: `~/.cybersafe-linux-lite`. Perfil da aplicação, por omissão:
`~/.config/cybersafe-assistant-linux-lite`. Feche a aplicação e pare a unidade
antes de fazer uma cópia fria. Preserve também a quarentena e os metadados,
sem restaurar ficheiros desconhecidos. Não apague essas pastas para corrigir erros.

Para recolher o estado e logs locais:

```bash
cybersafe-linux-diagnose
systemctl --user status cybersafe-linux.service --no-pager
journalctl --user -u cybersafe-linux.service -n 100 --no-pager
```

Reveja o texto antes de o enviar: retire nomes pessoais, caminhos privados,
conteúdos, tokens e segredos. Nunca envie a pasta `secrets` ou bases de contas.
Falha de instalação, integridade, sandbox ou perda de dados é motivo para parar
o ensaio e comunicar o erro, sem tentar contornar proteções.

## Modelo para devolver os resultados

```text
Pacote/commit e SHA-256:
Versão do Nigor / base Arch:
Kernel (uname -r):
Arquitetura (uname -m), CPU, RAM e GPU:
Ambiente gráfico / shell e versão:
X11 ou Wayland:
Instalação e pacman -Qkk: PASS / FAIL / NÃO TESTADO
Arranque e login: PASS / FAIL / NÃO TESTADO
Dashboard, histórico e PC Center:
Serviço manual, reinício e reabertura:
Painel e diagnóstico do firewall:
Scanner benigno: ficheiros / falhas / inconclusivos / duração
Estado e mensagens de cada motor:
Processos e métricas:
Encerramento e preservação dos dados:
Erro exato e passos para reproduzir:
Logs/capturas revistos, sem dados privados:
```

Esta prévia não foi aprovada como antivírus de produção. MATRIX online,
Wayland/Nigor nativo, USB físico, notificações/tray e cobertura completa da
monitorização ainda precisam de evidência. O updater Windows não é utilizado
no Linux; futuras atualizações do pacote usam o processo de distribuição Arch.
