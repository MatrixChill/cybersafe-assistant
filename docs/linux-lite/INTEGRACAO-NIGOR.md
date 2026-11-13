# Integração experimental Arch / Nigor OS

O alvo Arch reutiliza o renderer, a API local e o serviço que o Electron já inicia na edição Linux Lite. Não introduz um daemon root, portas novas, Wine ou dependência do shell Nigor. A receita destina-se a ensaios internos; o âmbito da licença global continua por clarificar.

## Construir e ensaiar

Num Arch x86_64 descartável, com sessão gráfica normal, Git, Node/npm e base-devel, faça checkout da branch aprovada e execute como utilizador normal:

```bash
bash scripts/linux-lite/arch/prepare-recipe.sh "$HOME/cybersafe-arch-build"
cd "$HOME/cybersafe-arch-build"
makepkg --syncdeps
pacman -Qlp ./cybersafe-assistant-linux-lite-*.pkg.tar.zst
sha256sum ./*.pkg.tar.zst
```

A receita contém um SHA-256 do arquivo de fontes e grava o commit em SOURCE-IDENTITY. É uma receita local, não uma submissão AUR. Depois de verificar a lista, instale no ambiente de ensaio com pacman -U, nunca execute Electron como root e não use --no-sandbox. Se a política do sistema não permitir o sandbox, registe a falha. O pacote não ativa serviços, não altera firewalls, nem remove dados de utilizador. Antes de ensaiar upgrade ou remoção, feche a aplicação e guarde cópia fria do perfil. Use pacman para gerir os ficheiros instalados.

## Ligação ao Nigor

- Entrada do menu: cybersafe-assistant-linux-lite.desktop.
- Ícone: cybersafe-assistant-linux-lite, no tema hicolor (PNG oficial).
- Ação Abrir CyberSafe: lançar cybersafe-assistant-linux-lite na sessão do utilizador, sem argumentos privados.
- Diagnóstico: cybersafe-linux-diagnose emite JSON schemaVersion 1 com sessão e presença de comandos. launchable apenas descreve pré-requisitos básicos; não confirma arranque. health permanece unknown porque isto não interroga o serviço.
- Use `cybersafe-nigor-status` para JSON v1 e `cybersafe-nigor-panel` para texto. Execute na sessão do utilizador, com uma consulta de cada vez. O cliente usa o socket Unix autenticado e devolve código diferente de zero se o serviço estiver indisponível.

## Evidência e estado

| Área | Estado desta entrega |
|---|---|
| Receita, checksum de fontes e preparação Electron | Implementado; sintaxe/arquivo e build de diretório validados em Ubuntu WSL2, não em Arch |
| Pacote .pkg.tar.zst, instalação e renderer X11 | Validados em Arch/WSL2 com Xvfb. Sessão Nigor e Wayland nativo pendentes |
| Scanner, ClamAV/YARA, HashDB, processos, volumes, quarentena, MATRIX | Percursos Linux Lite reutilizados; consultar evidências históricas nesta pasta. Sem novo ensaio instalado; C++ nativo/ELF não comprovado |
| Monitorização | Parcial; observação não prova deteção ou prevenção. Sem novo bloqueio preventivo |
| Serviço systemd e integração Nigor | Arranque, reinício, recuperação após falha e paragem verificados em Arch/WSL2. Cliente JSON e painel de texto verificados com dados reais |
| Firewall Linux | Diagnóstico de leitura disponível no CLI. Integração visual pendente |

No Ubuntu 26.04/WSL2, com Node 22.23.4 e fontes de a75fc29, passaram npm ci, npm run build:all, o gate SQLite/Electron ABI 130 e o alvo --arch-stage. Os guardas verificaram o renderer 0.2.4, entrada da API, executável ELF e app.asar. Isso não prova arranque gráfico ou funcionamento dos motores. Em Windows/Node 24.13.0 passaram 15 testes dirigidos de packaging, diagnóstico e bindings Linux/Windows.

O próximo ensaio precisa de Arch x86_64 descartável com X11 ou Wayland: instalar, abrir sem elevar, conferir renderer/login/SQLite, analisar uma pasta de texto benigno, confirmar histórico e estado dos motores, testar quarentena/restauro com fixtures, observar criação de ficheiros, fechar e verificar processos. Só depois rever integração e distribuição Nigor.

## Continuação: serviço de utilizador, sandbox e firewall

O pacote inclui `cybersafe-linux.service` como unidade opcional de utilizador.
Depois de instalar num ambiente de teste, abrir e fechar normalmente a aplicação
para gerar a credencial privada. Com a aplicação fechada, executar
`systemctl --user daemon-reload`, `systemctl --user start cybersafe-linux.service`
e consultar `journalctl --user -u cybersafe-linux.service`. Reabrir a aplicação
e verificar a reutilização autenticada do serviço. Para reverter, parar e,
se tiver sido ativada no arranque, desativar a unidade. O pacote não a ativa.
O ciclo de vida instalado foi validado no laboratório Arch/WSL2.

O renderer pede sandbox no Linux e recebe a configuração do preload por
argumentos explícitos. O teste de fonte não substitui um arranque Electron real.

O JSON de `cybersafe-linux-diagnose` inclui estados independentes de firewalld,
UFW e nftables. Não eleva permissões, não publica regras nem modifica o sistema.
Um backend ausente ou sem permissão não significa proteção desativada. O ensaio
WSL real encontrou os três comandos ausentes; os estados conhecidos e a recusa
de permissão foram testados com respostas controladas.

## Aceitação no Arch/WSL2

O pacote de ensaio `cybersafe-assistant-linux-lite-0.2.4-1-x86_64.pkg.tar.zst` foi construído com `makepkg` sem privilégios a partir de `f2d1f061b55fbf8b77d10fd145afa9720eeae86d`. Tamanho 111695351 bytes. SHA-256 `6c4a54c346889d5ff543283ebedd6279eb72bf906e4f8fac54c03c69a990f4ce`. O ensaio usou Arch/WSL2, Node 24.22.3, Electron 33.4.11 e a imagem WSL oficial com SHA-256 conferido. O pacote está reservado para testes.

- `pacman -Qlp` confirmou o payload e `pacman -Qkk` confirmou 173 ficheiros sem alterações após a instalação.
- Xvfb abriu a aplicação instalada sem flags que desativem o sandbox. A prova confirmou o renderer React montado, a bridge preload e a resposta de `/health` com `databaseReady: true`.
- `verify-installed.sh --disposable-profile` validou a unidade de utilizador, a consulta autenticada, o painel e a paragem. Um segundo ensaio comprovou recuperação automática após terminar exclusivamente o filho de serviço identificado no laboratório.
- O motor C++ analisou uma fixture e devolveu o SHA-256 esperado. ClamAV e YARA detetaram fixtures benignas com definições próprias de teste. ClamAV apareceu degradado no serviço instalado. Uma análise do serviço de um ficheiro registou 1/1 analisado, 1 inconclusivo e 0 ameaças.
- Os testes dirigidos Arch/WSL2 tiveram 123 passes e 1 TODO no core e 82 passes no serviço. Incluíram regressões de POSIX, USB, quarentena, fila em tempo real, histórico e HashDB. USB físico, Wayland nativo, sessão Nigor e os fornecedores MATRIX continuam por validar.

O contrato JSON v1 contém `serviceRunning`, `protection`, `engines`, `latestScan`, `history`, `alerts` e `metrics`. Use `null` como estado sem leitura. As listas têm no máximo cinco entradas por consulta e omitem caminhos e mensagens livres. O contrato é de leitura. Integração de ações de análise, eventos contínuos e widgets do shell continua pendente.
