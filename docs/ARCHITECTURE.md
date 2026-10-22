# Arquitetura do CyberSafe Assistant

## Visão geral

O projeto é um monorepo npm. A interface, o serviço local, a API e o motor de análise estão
separados em pacotes com responsabilidades distintas, para que cada parte possa ser testada
e substituída sem arrastar as outras.

| Pacote | Responsabilidade |
|---|---|
| `packages/app` | Interface React (Vite + Tailwind CSS), consumida pelo desktop |
| `packages/desktop` | Shell Electron: janela, pré-carregamento, IPC, bandeja do sistema e atualizações |
| `packages/service` | Serviço local Node.js: orquestra análises, quarentena, monitorização, histórico e a ponte para o motor nativo |
| `packages/core` | Motor de análise: heurísticas, YARA-X, ClamAV, VirusTotal, pontuação e quarentena |
| `packages/api` | API REST (Express + SQLite): autenticação, painel e assistente |
| `packages/native-windows` | Providers Windows para processos, hardware e estado do sistema |
| `packages/native-engine` | Executável C++17/CMake: SHA-256, entropia e análise de formato PE |
| `packages/shared-types` | Tipos TypeScript partilhados por todos os pacotes |
| `packages/extension` | Extensão de navegador (Manifest V3) para monitorização de downloads |

`packages/manual-retest` contém documentação de sessões de teste; não é um pacote executável.

## Fluxo de uma análise

```
Interface (React)
    │  pedidos ao serviço pelo preload (contextIsolation)
Electron main
    │  named pipe do serviço
Serviço local (engine.ts)
    ├── @cybersafe/core ............ heurísticas, YARA-X, ClamAV, VirusTotal, quarentena
    ├── @cybersafe/native-windows .. providers e operações Windows
    └── NativeEngineBridge ......... scan-engine.exe (C++, opcional)
            │
            └── resultado devolvido em JSON e integrado na pontuação final
```

O renderer não tem acesso direto ao Node.js nem ao sistema de ficheiros. As operações
privilegiadas passam pelo preload e pelo processo principal do Electron; a autenticação e
o assistente também comunicam com a API HTTP local.

## Como o risco é calculado

1. O `engine.ts` corre o analisador do `@cybersafe/core`: heurísticas próprias, regras YARA
   (motor `@litko/yara-x`, biblioteca nativa chamada a partir do Node), ClamAV quando
   configurado e VirusTotal quando há chave e a análise o permite.
2. O resultado do analisador produz uma pontuação e uma lista de fatores.
3. A `NativeEngineBridge` tenta executar o `scan-engine.exe` sobre o mesmo ficheiro. Se o
   binário existir, o resultado nativo pode contribuir para a pontuação e os seus
   sinais são acrescentados como fator próprio («Análise nativa: sinais heurísticos»).
4. Se o binário não existir, o estado do motor fica `unavailable` e a análise continua apenas
   com o motor TypeScript. A ausência do motor nativo não interrompe o serviço.
5. O ficheiro é novamente verificado antes de o resultado ser publicado: se mudou de tamanho,
   data ou inode durante a análise, o resultado é marcado como inconclusivo em vez de
   aplicado.

Este desenho faz do motor nativo uma **segunda opinião**: o TypeScript orquestra e decide, o
C++ acrescenta análise estática de binários (hash, entropia, cabeçalhos PE, secções
executáveis, ausência de importações).

## Fronteiras e permissões

- **Electron.** `contextIsolation` ligado, sem acesso direto ao Node no renderer. O
  pré-carregamento expõe apenas os canais usados pela interface.
- **Serviço.** Trata a análise, a quarentena, a monitorização e o histórico através de
  pedidos pela named pipe. O Electron também realiza operações próprias de janela e sistema.
- **Camada Windows (`native-windows`).** Contém providers de processos e estado do sistema,
  além de ações que exigem controlo próprio. Na sessão de validação, uma política separada
  permite apenas leituras e recusa alterações.
- **Sessão read-only.** Na sessão de desenvolvimento com perfil isolado, a terminação de
  processos está desativada e é recusada pela própria fronteira, antes de chegar ao handler,
  com o erro `efeito_negado_por_modo_leitura`. Não é uma garantia global do produto: é o
  comportamento da sessão controlada em que o produto foi observado.
- **Caminho de análise USB.** Força `readOnly` no caminho do motor, o que dispensa o
  VirusTotal e impede a quarentena automática: a análise não fala com a rede sobre o
  dispositivo nem move ficheiros dele.
- **API.** Serviço HTTP separado, com autenticação por JWT e palavras-passe em bcrypt;
  guarda os dados de conta e do painel numa base SQLite.

## Dados e persistência

- **API:** base SQLite aberta por `better-sqlite3` em `packages/api/src/db.ts`. Em
  desenvolvimento, o caminho tem de vir de `CYBERSAFE_DB_PATH`, absoluto e dentro da raiz
  isolada; em produção é a base da pasta de dados do serviço. O pacote inclui também um
  esquema Prisma (`packages/api/prisma/schema.prisma`), que não é o caminho usado em execução.
- **Serviço:** histórico de análises em `scans.jsonl` (com limite configurável), registo de
  eventos em `history.jsonl` e quarentena numa pasta própria com manifesto (ficheiro original,
  destino e motivo). As operações de quarentena aplicam validações de caminho para proteger os ficheiros geridos.
- **Chaves:** as chaves de VirusTotal e do assistente são fornecidas ao backend por
  configuração de ambiente. O ClamAV é uma integração local com binários e definições;
  não exige uma chave de API. A branch de progresso inclui apenas `.env.example`.

## Interface

- Cinco identidades visuais e dois eixos de tema (superfície e identidade), com os mesmos
  componentes em todas as páginas.
- As leituras globais podem indicar disponibilidade ou erro. Nas métricas por processo,
  alguns zeros ainda não distinguem uma medição real da ausência de leitura; esse contrato
  precisa de ser melhorado.
- O painel de risco mostra a pontuação e os fatores que a compõem, para que o veredicto seja
  legível e não apenas numérico.

## Empacotamento

`scripts/package-windows.mjs` usa `electron-builder` com alvo NSIS x64. O motor nativo é
copiado para fora do `asar`, em `resources`, e a ponte procura-o aí antes de tentar as pastas
de desenvolvimento. A candidata gerada não está assinada, porque não havia certificado
configurado.

## Nota sobre TypeScript e acesso de baixo nível

TypeScript, por si só, não expõe APIs de kernel. Node pode carregar addons nativos ou
executar binários — e é isso que acontece aqui com o YARA-X e com o `scan-engine.exe`: o
código nativo é executado fora do TypeScript: o addon YARA-X é carregado no processo Node,
e o executável C++ corre num processo separado. Camadas
de kernel (minifilter, callbacks de processo, WFP) estão fora do âmbito deste projeto.
