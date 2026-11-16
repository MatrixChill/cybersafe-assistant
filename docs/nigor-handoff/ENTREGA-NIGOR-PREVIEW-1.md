# Entrega ao Higor — Nigor OS Edition Preview 1

**Release:** [nigor-v0.2.4-preview.1](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/nigor-v0.2.4-preview.1)
(pré-release experimental). Pacote `cybersafe-assistant-nigor-0.2.4-2-x86_64.pkg.tar.zst`,
112 189 154 bytes, SHA-256 `8a72c418448a9f2c0cb16da8ea26583ef7c76cd2b315696e2e1c40b1203e025d`.
Fontes `b1f38b1`. Canal de atualizações da edição:
[nigor-update-channel-v2](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/nigor-update-channel-v2).

## Pronto do lado CyberSafe (não é trabalho do Nigor)
Motores (ClamAV, YARA, HashDB, motor C++), Scanner, quarentena (incluindo entre
discos), monitorização após escrita, entrada local sem conta com login opcional,
autenticação do serviço e da API, atualizador assinado com helper privilegiado,
diagnóstico de dependências, cliente `cybersafe-nigor-status` (JSON v1),
adaptador C++20 e Security Center de referência.

## Diferenças em relação ao Linux genérico
| | Linux genérico (`linux-lite`) | Nigor OS Edition (`nigor`) |
|---|---|---|
| Entrada | login obrigatório | painel local sem conta; «Sessão» opcional |
| Pacote / pasta | `cybersafe-assistant-linux-lite`, `/opt/cybersafe-assistant-linux-lite` | `cybersafe-assistant-nigor`, `/opt/cybersafe-assistant-nigor` |
| Atualizações | `cybersafe-linux-update`, canal Linux | `cybersafe-nigor-update`, canal Nigor (manifestos v2 da edição) |
| Perfil e dados | `~/.cybersafe-linux-lite`, `~/.config/cybersafe-assistant-linux-lite` | os mesmos (migração sem cópia) |
| Comandos | `cybersafe-nigor-status`, `cybersafe-linux-diagnose`, `cybersafe-nigor-panel` | os mesmos, mais `cybersafe-nigor-center-reference` |

Os dois pacotes declaram conflito entre si e não podem estar instalados ao mesmo tempo.

## Alterações no contrato (aditivas, JSON v1)
- `latestScan.id` / `history[].id`, quando o serviço o tem: liga o `scanId` aceite à entrada do histórico.
- `monitoring`: `mode` (`post-write`), `preventionConfirmed` (`false`), `queueDepth`, `rootCount`.
- Alertas de quarentena (`quarantine.added` / `quarantine.failed`) e `alertsScope`.
- `cybersafe-nigor-update check` inclui `edition: "nigor"`; os estados possíveis são os de [CONTRATO.md](CONTRATO.md), mais `no-release`.
O adaptador `integrations/nigor/include/cybersafe/nigor.hpp` continua compatível (os campos novos são opcionais).

## Instalar / migrar no Nigor
```bash
sha256sum -c SHA256SUMS.txt
systemctl --user stop cybersafe-linux.service    # se a usares; fecha também a app pela tray
cp -a ~/.cybersafe-linux-lite ~/.config/cybersafe-assistant-linux-lite /caminho/do/backup/
sudo pacman -U ./cybersafe-assistant-nigor-0.2.4-2-x86_64.pkg.tar.zst   # confirma a remoção do linux-lite
pacman -Qkk cybersafe-assistant-nigor
systemctl --user daemon-reload
cybersafe-linux-diagnose && cybersafe-nigor-status && cybersafe-nigor-update check
```
Para voltar atrás: fecha a app e o serviço, instala o pacote `linux-lite` anterior com
`pacman -U` e confirma a remoção do Nigor. Os dados ficam no mesmo perfil.

## O que tens mesmo de fazer no Nigor
1. Ligar o teu painel e o teu Security Center a `cybersafe-nigor-status` / `cybersafe-nigor-update`
   (pelo adaptador C++20, se quiseres). Não é preciso refazer o que já tens.
2. Garantir um agente polkit gráfico e um terminal (`xdg-terminal-exec` ou `xterm`) para a instalação de atualizações.
3. Para «Lembrar-me», um Secret Service/porta-chaves desbloqueado ([SESSAO-LEMBRAR.md](SESSAO-LEMBRAR.md)).
4. Não iniciar `freshclam` em paralelo com o teu timer diário: o CyberSafe delega no gestor do sistema.

## Testes a fazer no Nigor físico (NÃO TESTADOS por nós)
1. A migração acima com backup: o histórico e a quarentena aparecem na app.
2. A app abre sem pedir conta; «Sessão» funciona; o logout volta ao painel local; «Lembrar-me» sobrevive a reiniciar.
3. A barra e o Security Center mostram o mesmo que `cybersafe-nigor-status`; com o serviço parado mostram «indisponível».
4. Copiar 100–300 ficheiros benignos para Downloads e medir o tempo até aparecerem analisados (no laboratório, 40 ficheiros passaram de 212 s para 19 s).
5. Pen USB: quarentena de um ficheiro de teste e restauro.
6. Uma atualização futura pelo teu Security Center: pedido de autorização do polkit, versão nova em `pacman -Q`, dados intactos.

## Limitações
Sem prevenção antes da execução (deteção e quarentena **depois** da escrita).
O modo económico continua a usar cerca de 1 GB de RAM por `clamscan` durante a
análise; o perfil clamd opcional mantém a base em memória (ver
[LINUX-NEXT](LINUX-NEXT-20261116.md)). O agente polkit gráfico e o hardware do
Nigor não foram testados por nós. Ver também [CHECKPOINT](CHECKPOINT-20261116-DESEMPENHO-ATUALIZADOR.md).

## Mensagem pronta

> Olá Higor! Já está publicada a **Nigor OS Edition Preview 1** do CyberSafe:
> https://github.com/MatrixChill/cybersafe-assistant/releases/tag/nigor-v0.2.4-preview.1
>
> É um pacote próprio (`cybersafe-assistant-nigor`) que abre diretamente sem pedir
> conta; o login fica opcional. Também traz o tempo real muito mais rápido quando
> chegam muitos ficheiros de uma vez, a quarentena corrigida para pens USB e
> outros discos, e atualizações assinadas próprias da edição Nigor.
>
> Para instalar, faz primeiro uma cópia de `~/.cybersafe-linux-lite` e de
> `~/.config/cybersafe-assistant-linux-lite`, e depois
> `sudo pacman -U ./cybersafe-assistant-nigor-0.2.4-2-x86_64.pkg.tar.zst`
> (confirma a remoção do pacote antigo). Os teus dados ficam onde estão.
>
> Do teu lado basta ligar o teu painel e o Security Center aos comandos
> `cybersafe-nigor-status` e `cybersafe-nigor-update`, ter o agente polkit e,
> se quiseres «Lembrar-me», o porta-chaves desbloqueado. A lista de testes está
> em `docs/nigor-handoff/ENTREGA-NIGOR-PREVIEW-1.md`. Motores, scanner, quarentena
> e atualizador continuam do nosso lado: se algo falhar, diz-nos e corrigimos.
