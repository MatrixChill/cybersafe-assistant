# Mensagem para o responsável do Nigor

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
