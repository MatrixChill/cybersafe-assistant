# Limitações conhecidas

## Dependem de uma sessão Nigor real
- Comportamento dentro da `nigor-bar`, do gestor de janelas e do tema reais
  (o Security Center foi validado em Arch/WSL2 com Xvfb, não no Nigor).
- Mapeamento exato dos tokens de `src/ui/appearance.h` (código não partilhado).
- Arranque com a sessão do utilizador, menu e Definições do Nigor.

## Ainda não suportado pelo CyberSafe
- **Atualizações:** verificação, download autenticado e instalação via pacman estão
  implementados, mas o canal está `not-configured`: falta o mantenedor gerar o par
  de chaves (`scripts/linux-lite/update-manifest.mjs keygen` fora do repositório),
  incorporar a chave pública e publicar o primeiro manifesto assinado. Até lá
  não há atualização automática. Um repositório pacman assinado é a evolução
  recomendada (ver nota abaixo).
- Não existe ainda secção de atualizações dentro da aplicação Electron; o estado
  está disponível por `cybersafe-linux-update` e no Security Center.
- O histórico não traz o ID da análise: o Nigor não consegue associar um
  `scanId` aceite à entrada do histórico (extensão de contrato prevista).
- Alertas só desde o arranque do serviço (registo em memória).
- Uma análise pode contar ameaça por `highRiskCount` com severidade baixa sem gerar
  `threat.detected`; está documentado, a revisão da regra é trabalho futuro.
- Sem eventos em tempo real (push): o Nigor consulta periodicamente.
- Sem deep-link para uma página específica da aplicação (Definições abre a app).
- USB físico, Wayland nativo e notificações continuam por validar.

## Repositório pacman assinado (estudo)
A forma mais robusta é um repositório próprio (`repo-add` + pacote e base
assinados com GPG, servidos por HTTPS) acrescentado a `pacman.conf` com a chave
do mantenedor importada por `pacman-key`. Assim `pacman -Syu` trata as versões
e as assinaturas sem depender dos assets do GitHub. Requer chave GPG do
mantenedor e alojamento estático; não foi criado nesta entrega.
