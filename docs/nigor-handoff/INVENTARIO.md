# Inventário — pronto do lado CyberSafe

## Aplicação e serviço (pacote Arch `cybersafe-assistant-linux-lite`)
- Aplicação Electron com sandbox, serviço Node local por socket Unix autenticado,
  quatro motores (ClamAV, YARA, HashDB, motor nativo C++), histórico, quarentena.
- Unidade systemd **de utilizador** opcional `cybersafe-linux.service` (o pacote não a ativa).
- Entrada de menu `cybersafe-assistant-linux-lite.desktop` e ícone hicolor 256 px.

## Correções Linux desta entrega
- YARA sem executável Linux → «Não instalado» (antes «Erro crítico») e o
  ficheiro de regras do utilizador **deixa de ser substituído** pelas regras de teste.
- ClamAV: não instalado · sem bases · erro ao executar · a verificar, sem ENOENT na UI.
- Bateria: estimativas absurdas (ex.: 216 h) → «Estimativa indisponível»; origem Linux.
- PC Center: fontes Linux (hwmon/lm-sensors, mountinfo) em vez de textos Windows.
- CyberSafe Visual Core partilhado (logo hexagonal + órbitas; respeita reduced-motion).
- Cliente Nigor: alertas passam a ser os **mais recentes** (antes os mais antigos
  da janela), com `engineReasons` e `alertsScope`.

## Comandos instalados
| Comando | Função |
|---|---|
| `cybersafe-nigor-status` | Estado JSON v1; `scan --consent`, `cancel --consent`, `processes` |
| `cybersafe-nigor-panel` | Painel rápido Zenity (já usado na barra experimental) |
| `cybersafe-linux-diagnose` | Dependências com remédio; `--install <pacotes> --consent` |
| `cybersafe-linux-update` | Atualizações Linux: `check`, `download`, `install --consent`, `prefs` |

## Componentes nativos (em `integrations/nigor/`, e no pacote em `/usr/share/cybersafe-assistant-linux-lite/nigor-integration/`)
- `include/cybersafe/nigor.hpp` — adaptador C++20 header-only (tipos, parser JSON,
  processos sem shell com timeout, `AsyncPoller`).
- `reference/security_center.cpp` — Security Center de referência Xlib/Xft.
- `tests/test_adapter.cpp` — testes (parsing, timeouts, offline, argumentos sem shell, poller).
