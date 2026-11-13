# Continuidade Nigor / Arch — 13/11/2026

- Branch: `codex/nigor-arch-20261113`; PR #5 draft. Não fazer merge ou Release.
- Fontes do pacote de encerramento: `8a05d7b0637d9fb6fc66e4716c03635e38c51877`. CI Linux e Windows aprovadas nas runs `43509183249` e `43509191170`. A corrida de leitura de credencial vazia foi corrigida sem rotação.
- Pacote local e SHA-256: ver [INTEGRACAO-NIGOR.md](INTEGRACAO-NIGOR.md). Fontes, receita, 131 hashes do payload e logs em `output/arch-closing-8a05d7b/` (ignorados pelo Git).
- Implementado: pacote Arch real, ELF nativo, systemd de utilizador, cliente Unix autenticado, estado/métricas/alertas/processos, iniciar/cancelar análise consentida e painel Zenity com diagnóstico do firewall.
- Runtime: Arch/WSL2 + X11/Xvfb; pacote instalado, login sintético, Dashboard, histórico, Scanner 1/1, quatro estados ativos após provisionamento local de bases oficiais e SQLite 4/4 `quick_check`.
- Correções: cooldown FreshClam não é sucesso mesmo com exit zero; logger IPC compatível com type stripping do Node; fixtures de processo, walk e ausência do ELF isoladas do host.
- Testes: desktop 692 pass/6 skip; grupo de definições/gate 51 pass; autenticação 9 pass; fixtures corrigidas 39 pass; credencial 16 pass. Regressão ampla inicial do serviço 892 pass/130 fail/1 skip: continua sem aprovação; não confundir os grupos corrigidos com repetição integral verde.
- Publicação retida: licença global/aprovação e avisos correspondentes ao payload Linux ainda não fechados. Não publicar até satisfazer o gate; Windows v0.2.4 permanece Latest.
- Próxima sessão: fechar o gate de distribuição, triar os restantes testes do serviço e preparar a aceitação numa sessão Nigor real. Não iniciar funcionalidades novas nesta fase de encerramento.
- Quarentena: módulos instalados passaram a fixture positiva sintética (isolamento, recusa de sobrescrita, restauro, SHA e permissões). Script opt-in em `scripts/linux-lite/arch/verify-quarantine-installed.mjs`; não prova deteção nem UI/IPC.
- Gates reais: sessão Nigor/Wayland, USB físico, tray/notificações nativas, UI/IPC da quarentena/restauro, fornecedores MATRIX e licença global. Nenhum ensaio WSL comprova estes gates.
- Preservar Windows instalado, releases públicas, PAP e PR #4. Não operar a aplicação pessoal para mostrar o updater; esse pedido foi cancelado.
