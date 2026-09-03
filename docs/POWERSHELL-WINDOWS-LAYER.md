# Camada PowerShell Windows (CyberSafe Assistant)

Este documento descreve a integração segura e *read-only* com o Windows via
PowerShell, usada para alimentar o PC Center com dados reais.

## Por que PowerShell

O PowerShell (e o CIM/WMI por baixo) é a forma oficial e suportada de consultar o
sistema operativo Windows sem mexer no kernel nem instalar drivers. A maioria dos
dados (processos, serviços, disco, firewall, conexões) está exposta por cmdlets
nativos e fiáveis. Isto segue a recomendação do professor de "estudar e aproveitar
PowerShell no projeto".

Fluxo de dados:

```
PowerShell ── ConvertTo-Json ──> Node/Electron ──> objeto tipado ──> UI
```

## Localização

- `packages/native-windows/src/powershell.ts` — executor seguro + provedores tipados.
- `packages/native-windows/src/windows-health-logic.ts` — lógica pura (score,
  status, recomendações), testável offline.
- Tipos: `packages/shared-types/src/index.ts` (prefixo `Windows…`).

## Segurança: operações read-only e allowlist

A camada **não aceita comandos arbitrários**. Não existe `execPowerShell(userInput)`.

- O executor só aceita um `PowershellQuery` — uma união de literais fixos
  (`"os-info"`, `"services"`, `"connections"`, …) mapeados para *scripts internos
  embutidos*.
- A UI nunca envia texto livre para execução.
- Tudo é **READ-ONLY**: nenhum cmdlet de modificação (sem `Stop-Process`,
  `Remove-*`, `Set-*`). Não é possível matar processos, remover utilizadores,
  alterar firewall, modificar serviços, limpar ficheiros ou mexer no registry.

## Dados coletados

| Dado | Comando PowerShell interno | Nota |
|---|---|---|
| Informações do SO | `Get-CimInstance Win32_OperatingSystem` | versão, RAM total |
| Processos top por CPU | `Get-Process \| Sort CPU` | CPU/Memória |
| Processos top por memória | `Get-Process \| Sort WorkingSet` | |
| Serviços e estado | `Get-CimInstance Win32_Service` | inclui cada serviço |
| Conexões TCP | `Get-NetTCPConnection` | pode exigir privilégio |
| Utilizadores locais | `Get-LocalUser` | somente leitura |
| Disco | `Get-CimInstance Win32_LogicalDisk` | espaço livre/usado |
| Firewall | `Get-NetFirewallProfile` | pode exigir privilégio |

Cada provedor devolve JSON estruturado (`ConvertTo-Json`). Se um cmdlet exigir
privilégio elevado ou não existir, a chamada **falha graciosamente**: o erro é
registado em `snapshot.errors` e o respetivo campo aparece como indisponível, sem
derrubar a aplicação.

## Limitações de privilégio

Muitos cmdlets (conexões TCP, firewall, alguns utilizadores) requerem execução
elevada. O CyberSafe corre por norma sem elevação, por isso estes campos podem vir
vazios ou marcados como não disponíveis. Não inventamos valores: quando o Windows
não fornece dados, apresentamos `—` / `DESCONHECIDO`.

## Encodificação e timeout

- Saída interpretada como UTF-8 (`Buffer.concat` dos chunks do processo).
- `--NoProfile --NonInteractive` para execução limpa.
- Timeout configurável: o processo filho é terminado (`child.kill()`) após `timeoutMs`
  e a operação é tratada como erro controlado.

## Notas de plataforma

A camada é **Windows-only** mas não quebra o build noutros SO: a classe
`WindowsHealthEngine` mantém um estado `UNKNOWN`/indisponível e não executa nada
quando `process.platform !== "win32"`.

## Task Manager (futuro)

Esta integração é a base para o futuro Task Manager. Os tipos já expõem PID, nome,
CPU, memória, caminho (quando permitido), utilizador (quando permitido) e um campo
`reputation`/`state` preparado para um motor de reputação local. Ver
`TaskProcessEntry` e `WindowsTopProcess` em `shared-types`. Nenhuma funcionalidade
destrutiva do Task Manager (terminar processo, etc.) é implementada hoje.

## Roadmap

- **Active Directory**: fica para roadmap futuro. Não faz parte desta entrega.
- **IA**: pode, no futuro, *explicar* os dados recolhidos. As recomendações atuais
  são sempre locais e determinísticas (ver `windows-health-logic.ts`).

## Testes

A lógica pura (score/status/recomendações) tem testes unitários offline (sem
depender do Windows) em `packages/native-windows/test/`. Executar:

```
npm run test -w @cybersafe/native-windows
```
