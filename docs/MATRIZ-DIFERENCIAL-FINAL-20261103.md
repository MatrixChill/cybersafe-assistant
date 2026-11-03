# Matriz diferencial — missão final 2026-11-03

Base: d88031d, branch codex/final-v020-20261103; apenas output/ não versionado. Relatório fonte: RC2-VALIDACOES-20261103.md. Não se repetiram suites nesta inspeção.

| Histórico/evidência | Correção/evidência atual | Estado | Intervenção/prioridade |
|---|---|---|---|
| Autostart perdia escolha no arranque | ff81fbc/173311a; 20 testes dirigidos e 656 desktop | RESOLVIDO E VALIDADO automaticamente; reinício PENDENTE DE TESTE HUMANO | Preservar; P1 |
| Terminação bloqueada por leases de scan | fa064a1; testes individuais dirigidos | IMPLEMENTADO, MAS NÃO VALIDADO em instalação | Processo benigno em VM; P1 |
| 594 s / 800 ficheiros | batch/cache e Native compilado; 10 testes aprovados | DESCONHECIDO quanto ao desempenho instalado | Medições equivalentes ainda necessárias; P0 |
| ClamAV degradado | bundle/seed 1.5.4 aprovados, saúde/prioridade preservadas | IMPLEMENTADO, MAS NÃO VALIDADO sob carga instalada nesta ronda | Testes reais limitados e ambiente seguro; P0 |
| YARA cobertura limitada | runtime clássico/pinos/licenças aprovados | IMPLEMENTADO, MAS NÃO VALIDADO como cobertura ampla | Não inventar cobertura; P1 |
| Atualizador GitHub | HTTPS/Ed25519/SHA256/cache/cancelamento; 152 testes | RESOLVIDO E VALIDADO para download laboratorial | Preservar; P0 |
| Atualização assistida/reinício | production.ts injeta BLOCKED_PUBLISHER/BLOCKED_INSTALLER, manualDownloadOnly | PENDENTE DE INTEGRAÇÃO; confiança/assinatura humana pendentes | Não ativar produção; completar engenharia; P0 |
| Verificação automática | setAutomaticCheck só altera snapshot; main não agenda check | DEFEITO ATUAL REPRODUZIDO por inspeção do percurso | Agendar apenas quando utilizador ativou, sem instalar; P0 |
| WFP/HashDB | testes dirigidos de estados passaram | RESOLVIDO E VALIDADO automaticamente dentro do contrato | Preservar separação Windows/WFP/feed; P1 |
| Tray/foreground/fecho | testes foreground e suite desktop passaram | PENDENTE DE TESTE HUMANO físico | Não reconstruir; P1 |
| Versão rc.1 | product-version.json continua RC1 | PENDENTE DE INTEGRAÇÃO | Atualizar só ao consolidar candidata |
| Freeze/packaging | inventário anterior confere, não aprova árvore nova | PENDENTE DE TESTE HUMANO/aprovação | Não emitir nesta missão sem nova aprovação |


## Continuidade após o primeiro bloco

Implementado agendador de disponibilidade em updater/automatic-checks.ts, integrado no main e descartado no encerramento. Intervalo 15 minutos; só consulta com preferência ativa e fase idle/upToDate/error; evita chamadas sobrepostas e rejeições não tratadas. Não descarrega nem instala. Testes atualizador: 154 aprovados; typecheck aprovado.

Ainda pendente: persistência da preferência automática entre arranques; adaptadores reais de publisher/instalador e reinício/recuperação; ponta-a-ponta laboratorial até aplicação da atualização. Production continua deliberadamente manualDownloadOnly e com confiança desativada. Nenhum freeze aplicado; versão permanece RC1 até candidata consolidada.

Próxima ação exata: rever portas PublisherVerifier/Installer em updater/types.ts e os gates de updater.install(); completar adaptadores Windows sem os ativar em production antes da aprovação, com testes isolados de falha e preservação de dados. Não executar setup nem aceder à VM. Depois retomar medições Scanner/ClamAV sob ambiente autorizado; os 594 segundos continuam sem validação equivalente.
