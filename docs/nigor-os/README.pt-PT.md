# CyberSafe Nigor OS Edition

[English](README.md) · [Downloads](../downloads.pt-PT.md) · [Arch genérico](../linux/README.pt-PT.md)

A **Experimental Preview 1** inclui `cybersafe-assistant-nigor-0.2.4-2-x86_64.pkg.tar.zst`. [Descarregar a release Nigor](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/nigor-v0.2.4-preview.1). O Nigor OS é um sistema operativo baseado em Arch desenvolvido separadamente. O CyberSafe fornece aplicação de segurança, motores, serviço de utilizador e cliente de integração.

## Comportamento da edição

- Abre o painel local sem conta CyberSafe. O login continua disponível e opcional.
- Mantém o serviço autenticado por socket Unix e autenticação de conta nas rotas privadas da API.
- Tem marcador instalado, pacote e canal v2 assinado próprios.
- Inclui `cybersafe-nigor-status`, JSON compatível, adaptador C++20, Security Center de referência e `cybersafe-nigor-update`.
- Partilha motores, histórico e mecanismos de quarentena com Linux. A barra, notificações nativas, desktop, gestão do sistema e integração de firewall pertencem ao Nigor.

## Instalar ou migrar do Arch genérico

Exige Arch x86_64/glibc e dependências declaradas. A interface de referência usa X11/Xft. Os pedidos de instalação interativa precisam de terminal e agente polkit. Para lembrar a sessão, é também necessário um Secret Service suportado e desbloqueado no mesmo D-Bus.

1. Obtenha pacote Nigor, `SHA256SUMS.txt`, identidade de fonte e avisos da mesma release. Compare o SHA-256 do pacote com a entrada correspondente.
2. Termine as análises, encerre normalmente e pare a unidade independente, se ativa, com `systemctl --user stop cybersafe-linux.service`.
3. Preserve um backup frio privado e verificado dos destinos reais dos dados e perfil, normalmente `~/.cybersafe-linux-lite` e `~/.config/cybersafe-assistant-linux-lite`. Mantenha quarentena e metadados isolados.
4. Execute `sudo pacman -U ./cybersafe-assistant-nigor-0.2.4-2-x86_64.pkg.tar.zst`. O pacote genérico entra em conflito com o Nigor. Confirme a sua remoção depois de rever a transação.
5. Execute `pacman -Q cybersafe-assistant-nigor`, `pacman -Qkk cybersafe-assistant-nigor` e `systemctl --user daemon-reload`. Abra a app, consulte `cybersafe-linux-diagnose` e confirme histórico e motores. Reinicie o serviço independente se já o utilizava.

Os nomes dos comandos/perfil mantêm-se para compatibilidade de migração. As edições não devem correr em paralelo sobre o mesmo serviço e dados. A atualização assistida mantém a edição instalada.

## Integração e atualizações

Use o CLI/adaptador C++ existente no painel Nigor. O pacote inclui os materiais em `/usr/share/cybersafe-assistant-linux-lite/nigor-integration/` e `cybersafe-nigor-center-reference`. Os contratos estão no [commit empacotado](https://github.com/MatrixChill/cybersafe-assistant/tree/b1f38b134623c7b36273526f1050078a2c07cb36/integrations/nigor).

`cybersafe-nigor-update check` consulta o manifesto da edição sem conta. O download verifica assinatura, tamanho e SHA-256. Instalar exige consentimento, polkit, staging privado verificado e as verificações normais do pacman. [Estado dos canais](../downloads.pt-PT.md#canais-de-atualização).

## Evidência e aceitação pendente

A release regista builds Arch/WSL2, entrada local sem login em Xvfb, recusa de rotas privadas anónimas, migração Preview 3 com SQLite inalterado, análise benigna e transações de laboratório helper/pacman. O percurso polkit gráfico, porta-chaves após reiniciar a sessão, barra/notificações nativas, USB físico e desempenho no hardware Nigor continuam **não testados** nessa release.

A proteção deteta após escrita. O clamd persistente é opcional e exige memória. Os estados dos motores não comprovam prevenção ou cobertura completa.

Para recuperar, pare a app/serviço, conserve uma cópia privada dos dados novos e o pacote anterior verificado. Confirme estado e logs antes de restaurar o backup frio correspondente. Consulte [suporte](../support.md) e a [entrega de integração/evidência](https://github.com/MatrixChill/cybersafe-assistant/blob/a8bbeb0d9a5be89640d3afbfe5c3cb4de0f649bd/docs/nigor-handoff/README.md).
