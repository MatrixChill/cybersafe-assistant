# Arquitetura

[English](README.md) · [Referência técnica](../ARCHITECTURE.md)

O CyberSafe é um monorepo npm. A interface apresenta resultados e o Electron gere a integração desktop e a ponte preload. O serviço coordena análises, monitorização, saúde dos motores e quarentena. A API local trata das contas e das suas rotas privadas.

| Limite | Responsabilidade / contrato |
|---|---|
| `packages/app` → preload | React/TypeScript chama operações IPC explícitas. Medições indisponíveis continuam desconhecidas. |
| Electron → `packages/service` | Named pipe autenticado Windows ou socket Unix Linux. A conta e a credencial do serviço são independentes. |
| `packages/api` | API HTTP local, contas e dados SQLite. Novos endpoints exigem revisão de autenticação. |
| Serviço → motores | ClamAV, YARA clássico, HashDB e C++ nativo contribuem com veredictos, falhas e limites próprios. |
| Dados | SQLite, histórico, eventos e metadados de quarentena têm requisitos de ciclo de vida e migração. O conteúdo da quarentena é sensível. |
| Atualizações | Confiança no manifesto, compatibilidade da edição/cliente, integridade e instalação autorizada são gates distintos. |
| Integração Nigor | Componentes nativos usam o CLI/adaptador C++. Barra, notificações e políticas do SO pertencem ao Nigor. |

O [diagrama do README](../../README.pt-PT.md#arquitetura) mostra as ligações. A `main` e o [PR Linux/Nigor](https://github.com/MatrixChill/cybersafe-assistant/pull/5) têm suporte de plataformas diferente. Consulte a identidade de fonte da release antes de atribuir um comportamento ao pacote instalado.

## Segurança e limites de execução

Preload e serviço verificam as operações independentemente de a janela estar visível. O painel Nigor sem conta continua a autenticar-se no serviço. As rotas privadas de conta exigem a respetiva sessão.

A atualização instalada Windows depende da sua cadeia de confiança. Clientes Linux/Nigor v2 revalidam metadados assinados e bytes numa área privilegiada protegida antes do pacman. As consultas essenciais de atualização não precisam de conta CyberSafe. O sistema operativo e a gestão das definições ClamAV do sistema continuam a pertencer à distribuição.

A monitorização Linux observa eventos após escrita. Uma unidade systemd de utilizador pode continuar sem interface, mas não estabelece proteção antes do login. O protótipo preventivo de laboratório é separado da capacidade distribuída.

[Motores](../engines.md) · [Fluxos MATRIX](../matrix.md) · [Canais](../downloads.pt-PT.md#canais-de-atualização) · [Política de segurança](../../SECURITY.md)
