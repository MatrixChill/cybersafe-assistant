# Drivers de kernel — para que servem e quando os usar

## User mode vs kernel mode

- **User mode:** o teu Node, Electron e o `scan-engine.exe` rodam aqui. Boa produtividade, isolamento do SO, mais difícil **bloquear antes** de certas operações.
- **Kernel mode:** drivers. Podem observar/intercetar caminhos de I/O e eventos de sistema **antes** de muitos efeitos chegarem às apps.

## O que um antivírus “grande” faz com driver

- **Minifilter** no sistema de ficheiros: ver criar/renomear/escrever/executar.
- **Callbacks** de processo/imagem (APIs suportadas pela Microsoft, não “hook aleatório”).
- **Rede (WFP)** e **telemetria (ETW)** em cenários avançados.

## Riscos

- Bug em driver → **BSOD**.
- Drivers precisam de **assinatura** e processos de instalação compatíveis com Secure Boot / políticas enterprise.

## Recomendação para este projeto

1. **Primeiro:** motor nativo **user-mode** (C++ `scan-engine`) + integração TS.
2. **Depois:** watchers e políticas em TS/C++ sem kernel.
3. **Só no fim:** WDK, minifilter, com orientação e tempo dedicados.

Não é preguiça técnica — é **ordem de risco e de aprendizagem**.
