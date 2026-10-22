# Roadmap

O projeto está numa fase de consolidação: a arquitetura já existe e funciona em
desenvolvimento, mas o produto empacotado ainda não foi validado e há correções recentes à
espera de reteste na interface. Este documento diz, sem promessas, o que está feito, o que
vem a seguir e o que fica fora de âmbito.

## Onde estamos (22/10/2026)

- Monorepo TypeScript com serviço local, desktop Electron, API, interface, providers Windows, extensão de navegador e motor nativo em C++.
- Pipeline de análise implementado no lado TypeScript: heurísticas, YARA-X, ClamAV, VirusTotal,
  pontuação com fatores e quarentena.
- **Motor nativo já integrado.** A ponte `NativeEngineBridge`, em `packages/service`, localiza
  o `scan-engine.exe`, expõe o estado do motor ao painel de saúde e integra o resultado na
  pontuação final. Sem o binário, a análise continua apenas com o motor TypeScript.
- Candidata de instalação gerada e verificada estaticamente, sem assinatura digital.
- Sessão manual de desenvolvimento com leituras reais e navegação pelas páginas principais.

## Fase 1 — Fechar a entrega de 31/10

1. **Validar a instalação** num ambiente isolado: resolver as nove colisões de host,
   instalar a candidata e registar primeira execução, arranque, login e leituras reais.
2. **Retestar na interface** as correções mais recentes: painel de Atualizações e recusa de
   terminação de processos, hoje provadas apenas por testes.
3. **Fechar observações da sessão manual:** erro ao terminar processo, linguagem do Monitor,
   zeros ambíguos de CPU e memória e explicação dos indicadores de saúde e segurança no PC Center.
4. **Registo completo do build**, para que os avisos deixem de ser «não confirmados».
5. **Decidir sobre assinatura:** certificado ou aceitação explícita de `NotSigned`.

## Fase 2 — Produto utilizável no dia a dia

- **Atualizações reais:** feed, descoberta, download, verificação, instalação e rollback.
- **Acessibilidade:** revisão de teclado, foco e leitura por leitor de ecrã em execução.
- **Qualidade das análises:** casos de teste controlados num ambiente isolado, com tempo e
  resultado registados; análise de ZIPs grandes e de ficheiros em uso pelo sistema.
- **Desempenho:** reduzir o custo por ficheiro em análises profundas e evitar leituras
  repetidas do mesmo ficheiro.

## Fase 3 — Motor nativo mais profundo

- Análise PE mais completa (recursos, assinaturas, packers) e fusão de pontuações com regras
  documentadas, em vez de soma simples.
- Equilíbrio de pesos entre heurísticas TypeScript e sinais nativos, com testes que fixem o
  comportamento esperado.
- Compilação do motor no fluxo de build, para que o binário acompanhe cada candidata.

## Fase 4 — Fora de âmbito

- **Drivers de kernel:** novos minifilters ou drivers próprios exigem desenvolvimento e
  assinatura específicos e ficam fora do âmbito atual. Isto não elimina as integrações
  de monitorização em modo de utilizador que já existem.
- **Infraestrutura de antivírus comercial:** reputação massiva, telemetria global e equipa de
  resposta a incidentes estão fora do alcance de um projeto individual.
- **Autoproteção agressiva do processo:** mesmo endurecida, não resiste a um administrador
  malicioso. Não é prometida.

## Prioridades

| Prioridade | Item |
|---|---|
| Alta | Validar a instalação num ambiente isolado |
| Alta | Reteste na interface das correções recentes |
| Média | Atualizações reais com rollback |
| Média | Assinatura do executável |
| Baixa | Aprofundar o motor nativo e os pesos de pontuação |
| Futuro | Camadas de kernel (projeto separado) |
