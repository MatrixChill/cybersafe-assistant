# Plano consolidado (decisões da discussão de arquitetura)

Documento curto que resume **decisões** e **planos** alinhados com a conversa de desenho do projeto (sem colar o chat integral).

## Princípios

1. **Separar camadas:** UI (Electron/TS) ≠ orquestração (Node/TS) ≠ engine nativa (C++) ≠ kernel (futuro).
2. **Não começar por driver** — risco, assinatura, WDK, BSOD; só depois de motor nativa estável.
3. **TypeScript sozinho** não é adequado para tudo que é *kernel-level* ou *microsegundo-crítico*; **Node pode orquestrar** binários e addons nativos.
4. **YARA-X** já traz código nativo no pipeline de regras; o `scan-engine` acrescenta **hash + entropia + PE** fora do runtime JS.

## O que já está no repositório (código)

- Monorepo TS descrito em `docs/ARCHITECTURE.md`.
- `packages/native-engine` com **C++ real** versionado (para o GitHub Linguist contar C++).

## O que falta (trabalho)

- **Ligar** `scan-engine.exe` ao `packages/service` (spawn + merge de resultados).
- **CI** opcional: job que compila o C++ no Windows.
- **Testes** de regressão com ficheiros benignos e amostras de teste (ex.: EICAR se aplicável à política da instituição).

## Mensagens-chave para apresentação

- O projeto é um **protótipo avançado** (serviço, UI, regras, cloud), não um clone de Defender.
- A evolução **profissional** passa por **engine nativa** e só mais tarde **kernel**, com APIs suportadas (minifilter, callbacks oficiais, ETW, etc.), não hooks “estilo rootkit”.
