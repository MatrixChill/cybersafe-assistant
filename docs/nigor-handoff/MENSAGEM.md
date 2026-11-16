# Mensagem para o responsável do Nigor

## Atualização Linux Next — 16/11/2026

> Olá Higor. Tratámos do lado do CyberSafe o recarregamento ClamAV por ficheiro,
> a quarentena entre volumes, o polling de processos Linux, os diretórios de
> autostart e a sessão «Lembrar-me». O novo perfil clamd é opcional: mantém RAM
> ocupada e precisa de margem; não o ativamos automaticamente. A documentação
> inclui as medições reais e os comandos de configuração.
>
> O adaptador C++ e o JSON v1 distinguem agora monitorização após escrita de
> prevenção, mostram a fila e os desfechos de quarentena e preservam IDs quando
> disponíveis. Não anunciamos proteção integral. A prevenção funcionou apenas
> numa prova isolada; não foi ativada no produto.
>
> Para «Lembrar-me», é necessário um Secret Service/porta-chaves ativo e
> desbloqueado; polkit-gnome não substitui GNOME Keyring. O teste de escrita e
> leitura por dois processos Electron passou com a carteira real no laboratório.
>
> Depois de disponibilizarmos o pacote verificado, precisamos apenas de validar
> no Nigor a sessão gráfica/keyring, a rajada de ficheiros, USB/quarentena/restauro
> e notificações. Qualquer defeito nos motores continua a ser responsabilidade
> nossa. Guias: `LINUX-NEXT-20261116.md`, `SESSAO-LEMBRAR.md` e `CONTRATO.md`.

## Mensagem anterior — preview.2 (histórico)

> Olá! Já temos a próxima versão do CyberSafe para Linux preparada, com quase toda
> a integração feita do nosso lado, para teres o mínimo de trabalho.
>
> **O que está pronto**
> - Pacote Arch novo (`cybersafe-assistant-linux-lite-0.2.4-2`), na pré-release
>   `linux-v0.2.4-arch-preview.2` do repositório MatrixChill/cybersafe-assistant.
>   Corrige o YARA que aparecia em erro, os estados do ClamAV, a bateria e os
>   alertas do painel (mostrava os mais antigos em vez dos mais recentes).
> - `cybersafe-linux-diagnose`: diz o que falta (ClamAV, YARA, bases…) e o comando
>   exato para instalar.
> - `cybersafe-linux-update`: verificação e download assinados de novas versões e
>   instalação pelo pacman (o canal ainda vai ser ativado por nós).
> - Um adaptador C++20 header-only (`cybersafe/nigor.hpp`) que fala com o
>   `cybersafe-nigor-status`, com timeouts e consultas em segundo plano para a barra
>   nunca congelar.
> - Um Security Center de referência em C++20/Xlib/Xft que podes usar tal como
>   está ou adaptar ao teu tema.
>
> **Onde está**
> No pacote, em `/usr/share/cybersafe-assistant-linux-lite/nigor-integration/`, e no
> GitHub em `integrations/nigor/` (branch `codex/nigor-arch-20261113`). A
> documentação está em `docs/nigor-handoff/`.
>
> **O que precisas de fazer**
> 1. Ligar o adaptador ao painel que já tens na `nigor-bar`.
> 2. Pôr um botão para abrir o Security Center.
> 3. Ligar as cores ao teu `appearance.h` (há uma função `nigorTheme()` para isso).
> 4. Adicionar ao menu e às Definições.
>
> O passo a passo está em `docs/nigor-handoff/INSTRUCOES-NIGOR.md`, e os testes em
> `INSTALACAO.md`. Para compilar: `cmake -S integrations/nigor -B build && cmake --build build`.
>
> Depois testamos juntos na tua máquina, e qualquer incompatibilidade do lado do
> CyberSafe corrigimos nós. Obrigado!
