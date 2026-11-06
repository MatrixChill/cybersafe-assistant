# Documentação CyberSafe Assistant

Ponto de entrada para utilizar, desenvolver e avaliar o projeto. A **main** contém a edição Windows; a [branch Linux Lite](https://github.com/MatrixChill/cybersafe-assistant/tree/experimental/linux-lite) é experimental e permanece separada.

| Começar por | Conteúdo |
|---|---|
| [Instalação](installation.md) | Download oficial, checksums e atualização manual |
| [Arquitetura](ARCHITECTURE.md) | Camadas, IPC e serviço local |
| [Motores](engines.md) | ClamAV, YARA, HashDB e Native C++ |
| [MATRIX](matrix.md) | Diagnóstico local, IA online e consentimento |
| [Desenvolvimento](development.md) | Ambiente, comandos de testes e build |
| [Testes e segurança](security-and-testing.md) | Evidência, limitações e comunicação responsável |
| [Atualizações](updates.md) | Feed, Ed25519, integridade e gates de release |
| [PAP](../PAP-EVIDENCIAS-TECNICAS/README.md) | Evidências técnicas e contexto académico |

## Referências e arquivo técnico

Os documentos datados abaixo e os checkpoints preservam decisões e evidências históricas. Não representam automaticamente o estado da versão atual. Não foram eliminados para evitar perder a reprodutibilidade dos builds e dos ensaios.

| Documento | Conteúdo |
|-----------|-----------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Camadas, fluxo de pedidos, motores, serviço e segurança aplicada |
| [ROADMAP.md](./ROADMAP.md) | Estado real, validação pendente e próximos passos |
| [PAP-TRANSFERENCIA-20261031.md](./PAP-TRANSFERENCIA-20261031.md) | Transferência para a revisão do relatório PAP: factos, lacunas e capítulos a atualizar |
| [../PAP-EVIDENCIAS-TECNICAS/README.md](../PAP-EVIDENCIAS-TECNICAS/README.md) | Índice dos oito documentos de evidência técnica |
| [FAQ-ENTREGA-PROFESSOR.md](./FAQ-ENTREGA-PROFESSOR.md) | Perguntas típicas (Electron, motor, C++, indústria) |
| [POWERSHELL-WINDOWS-LAYER.md](./POWERSHELL-WINDOWS-LAYER.md) | Camada PowerShell read-only e limites |
| [WINDOWS-KERNEL-E-DRIVERS.md](./WINDOWS-KERNEL-E-DRIVERS.md) | Para que serve driver de kernel; por que não é a primeira etapa |
| [TOOLCHAIN-CPP-WINDOWS.md](./TOOLCHAIN-CPP-WINDOWS.md) | MSYS2, MinGW, CMake, sem Visual Studio obrigatório |
| [RELEASE_DRIVER_CHECK.md](./RELEASE_DRIVER_CHECK.md) | Regras de verificação de drivers antes de publicar |
| [GITHUB-LINGUIST.md](./GITHUB-LINGUIST.md) | Porque o GitHub mostra sobretudo TypeScript |

Motor nativo (código):

- [`packages/native-engine/README.md`](../packages/native-engine/README.md) — compilar e testar o `scan-engine`

Capturas de ecrã:

- [`images/`](./images/README.md) — política e localização das capturas aprovadas
