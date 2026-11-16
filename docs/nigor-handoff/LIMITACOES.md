# Limitações conhecidas

## Dependem de uma sessão Nigor real
- Comportamento dentro da `nigor-bar`, do gestor de janelas e do tema reais
  (o Security Center foi validado em Arch/WSL2 com Xvfb, não no Nigor).
- Mapeamento exato dos tokens de `src/ui/appearance.h` (código não partilhado).
- Arranque com a sessão do utilizador, menu e Definições do Nigor.

## Ainda não suportado pelo CyberSafe
- **Atualizações:** canal ativo com chave pública Ed25519 incorporada a partir do
  pacote 0.2.4-2 (manifesto `manifest-experimental.json` assinado na release
  `linux-update-channel`). Pacotes anteriores (0.2.4-1) não têm a chave e têm de ser
  atualizados manualmente uma vez. A instalação é sempre confirmada e autorizada
  pelo polkit; não existe instalação silenciosa. Um repositório pacman assinado
  continua a ser a evolução recomendada (ver nota abaixo).
- A secção «Atualizações» da aplicação Electron em Linux usa este canal; ainda não
  foi testada numa sessão gráfica com agente polkit real (só testes de modelo/IPC).
- Pacotes anteriores a 0.2.4-3 não trazem o ID de análise; a extensão aditiva
  atual preserva o ID quando disponível. Os consumidores devem tolerar `null`.
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
