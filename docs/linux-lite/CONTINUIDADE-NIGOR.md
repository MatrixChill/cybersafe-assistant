# Continuidade Nigor / Arch — 13/11/2026

- Branch: `codex/nigor-arch-20261113`; PR #5 draft. Não fazer merge ou Release.
- Fontes do pacote verificado: `fb64a3c7a15552ad21e0bc5ab5cfeb1f2a677b54`; CI Windows aprovada. `91affe6` acrescenta CI Linux, sem alterar o payload.
- Pacote local e SHA-256: ver [INTEGRACAO-NIGOR.md](INTEGRACAO-NIGOR.md). Fontes, receita e logs em `output/arch-candidate/` (ignorados pelo Git).
- Implementado: pacote Arch real, ELF nativo, systemd de utilizador, cliente Unix autenticado, estado/métricas/alertas/processos, iniciar/cancelar análise consentida e painel Zenity com diagnóstico do firewall.
- Runtime: Arch/WSL2 + X11/Xvfb; pacote instalado, login sintético, Dashboard, histórico, Scanner 1/1, quatro estados ativos após provisionamento local de bases oficiais e SQLite 4/4 `quick_check`.
- Correções: cooldown FreshClam não é sucesso mesmo com exit zero; logger IPC compatível com type stripping do Node; fixtures de processo, walk e ausência do ELF isoladas do host.
- Testes: desktop 690 pass/6 skip; grupo de definições/gate 51 pass; autenticação 9 pass; fixtures corrigidas 39 pass. Regressão ampla inicial do serviço 892 pass/130 fail/1 skip: continua sem aprovação; não confundir os grupos corrigidos com repetição integral verde.
- Próximo: confirmar a CI Linux remota, triar os restantes testes do serviço e continuar a integração dos diagnósticos Linux na aplicação principal. Não substituir estados desconhecidos por zeros ou proteção ativa.
- Gates reais: sessão Nigor/Wayland, USB físico, tray/notificações nativas, quarentena/restauro instalados, fornecedores MATRIX e licença global. Nenhum ensaio WSL comprova estes gates.
- Preservar Windows instalado, releases públicas, PAP e PR #4. Não operar a aplicação pessoal para mostrar o updater; esse pedido foi cancelado.
