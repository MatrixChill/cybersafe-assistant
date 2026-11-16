# Perguntas frequentes

[English](faq.md) · [Downloads](downloads.pt-PT.md)

## Qual edição devo descarregar?

A v0.2.4 Windows é estável para Windows 10/11 x64. A Preview 3 Arch é experimental e usa entrada com conta. A Preview 1 Nigor tem pacote próprio, painel local e login opcional. Consulte os nomes exatos no [índice de downloads](downloads.pt-PT.md).

## Stable significa proteção antivírus certificada?

Stable identifica o canal de distribuição. O CyberSafe não anuncia certificação antivírus ou cobertura completa. Mantenha as proteções da plataforma ativas. Um motor Ativo ou teste benigno aprovado não comprova deteção completa.

## Porque mostra o Windows editor desconhecido?

O Setup não tem Authenticode. O manifesto assinado não fornece confiança do editor Windows. Mantenha as proteções e preserve qualquer aviso de bloqueio. Consulte [instalação](installation.pt-PT.md).

## A licença é MIT?

O código original usa a [MIT aprovada na raiz](../LICENSE). Dependências, regras, dados e assets de terceiros conservam os seus termos. Consulte [licença e proveniência](licensing.md).

## Porque pode o ClamAV ficar lento ou degradado?

Carregamento de definições, fila, análise e ciclo de vida dos processos têm custos distintos. O clamd persistente Linux pode reduzir arranques repetidos e ocupa memória residente significativa. É opcional. Indique edição, corpus, tempos e motivos de erro sem dados privados.

## Inconclusivo significa seguro?

A análise incompleta mantém-se inconclusiva. Reveja motores indisponíveis, acesso, timeouts e limites de arquivos antes de interpretar o resultado.

## A MATRIX está sempre online?

O diagnóstico local e os pedidos opcionais ao fornecedor têm origens distintas. O uso online exige configuração, credenciais e consentimento. Confirme a origem e os dados enviados no pedido.

## Porque abre o Nigor sem conta CyberSafe?

A edição própria disponibiliza funções locais e mantém o serviço autenticado e as rotas privadas de conta. «Lembrar-me» exige porta-chaves suportado e desbloqueado. O login temporário fica em memória. [Guia Nigor](nigor-os/README.pt-PT.md).

## A atualização automática instalada está demonstrada?

O Windows mantém instalação manual. Linux/Nigor têm manifestos assinados, staging protegido e helpers consentidos, com transações de laboratório documentadas. A autorização polkit gráfica e a aceitação instalada pelo feed público continuam como gates explícitos. [Canais](downloads.pt-PT.md#canais-de-atualização).

## Como comunicar um problema?

Use reprodução benigna mínima, edição/versão e diagnóstico sem dados privados. Não anexe malware, credenciais, bases privadas ou conteúdos de quarentena. Consulte [suporte](support.md) para erros e [SECURITY](../SECURITY.md) para vulnerabilidades.
