# Roadmap — estado real e próximos passos

Este documento descreve o que **existe no código**, o que está **parcialmente validado** e o que
está **planeado**. Não é uma promessa de datas.

## Estado atual (snapshot de desenvolvimento)

- Monorepo TypeScript com serviço de fundo, shell Electron, renderer React e API REST.
- Scanner com YARA, base de hashes, ClamAV e motor nativo C++ integrado por *bridge*.
- Quarentena, histórico, relatórios em PDF, gestor de tarefas (leitura), PC Center,
  otimização, monitorização, proteção USB, assistente MATRIX e atualizações — com testes
  automatizados por área.
- Instalador NSIS personalizado construído e compilado offline; **execução e validação em
  máquina limpa pendentes**.
- O código do repositório corresponde ao snapshot de 2026-10-30 e inclui a correção do ciclo de
  vida da janela (`Object has been destroyed`).
- A candidata interna **0.1.10** foi testada manualmente em VM: o encerramento deixou de
  reproduzir o crash nesse teste manual. Não é uma release; repetir numa instalação final.
- O instalador **0.1.9 (PAP R4)** não continha a correção e não representa o estado atual.

## Fase 1 — Fechar a validação (prioridade alta)

1. Instalação em VM limpa do build atual; verificar arranque, serviço, motores e desinstalação.
2. Validar preservação de dados/configuração/quarentena em upgrade e remoção.
3. Fechar o diagnóstico de arranque degradado com logs reais de uma instalação.
4. Repetir os cenários manuais do scanner e do tempo real no build instalado.

## Fase 2 — Qualidade de análise (prioridade alta)

- Gestor de exclusões com interface dedicada (hoje a política existe apenas no motor).
- Melhor distribuição do orçamento de ficheiros por pasta, para análises profundas mais úteis.
- Diagnóstico explícito de resultados inconclusivos (o que faltou medir e porquê).
- Ampliar regras YARA e a base de hashes com processo de atualização verificável.

## Fase 3 — Sistema e proteção

- Endurecer watchers e recuperação em cenários de carga e suspensão.
- Consolidar a proteção USB e os estados de dispositivo.
- Melhorar a defesa *user-mode* do serviço (documentando os limites reais).

## Fase 4 — Distribuição

- Instalador final com identidade de versão, assinatura de código e atualizações verificadas.
- Compatibilidade gráfica e DPI em hardware variado.
- Documentação de suporte e política de privacidade.

## Fora de âmbito (por agora)

- **Kernel:** minifilter, callbacks de processo, WFP ou ETW exigem WDK, assinatura de driver e
  risco operacional elevado — projeto separado, só com maturidade e requisitos claros.
- **Substituir o Microsoft Defender.** O CyberSafe é uma ferramenta académica e de
  monitorização; não compete com produtos certificados.

## Prioridades honestas

| Prioridade | Item |
|---|---|
| Alta | Validação em VM do build atual (instalação, arranque, desinstalação) |
| Alta | Gestor de exclusões e diagnóstico de resultados inconclusivos |
| Média | Desempenho de análise profunda; regras e assinaturas |
| Média | Instalador assinado e atualizações verificadas |
| Baixa | Camadas de kernel (projeto separado) |
