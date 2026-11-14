# Componentes C++20 para o Nigor

Fontes: `integrations/nigor/` (também instaladas em
`/usr/share/cybersafe-assistant-linux-lite/nigor-integration/`).

## Compilar e testar

```bash
cmake -S integrations/nigor -B build-nigor
cmake --build build-nigor
./build-nigor/test_adapter            # deve terminar com "OK (0 falhas)"
./build-nigor/cybersafe-security-center
```

Dependências: g++ ≥ 12 (C++20), cmake ≥ 3.20, pkg-config, libx11, libxft, zlib
(só a referência). O adaptador é header-only e só precisa de pthreads.

## Usar o adaptador no painel da barra

```cpp
#include <cybersafe/nigor.hpp>
using namespace cybersafe;

// Uma vez, no arranque do painel:
AsyncPoller poller(Client{}, std::chrono::seconds(10), [&] { wakeBarLoop(); });  // acorda o ciclo X11
poller.start();

// No redesenho (thread da interface):
if (auto snap = poller.latest()) {
  if (!snap->ok()) drawUnavailable(snap->error.message);           // offline / timeout / não instalado
  else {
    const Status& s = *snap->value;
    drawHeadline(fullyProtected(s) ? "Protegido" : toText(s.protection));
    drawEngine("ClamAV", engineText(s.engines.clamav));             // "Não instalado", "Ativo", …
    if (s.latestScan) drawScan(scanText(*s.latestScan));            // inconclusivo nunca aparece como limpo
  }
}
// Botão Atualizar:       poller.refreshNow();
// Botão Abrir CyberSafe: Client{}.openApp();
```

`onUpdate` corre na thread de fundo: use-o só para acordar o ciclo de eventos
(pipe + `select`, como em `reference/security_center.cpp`) e leia `latest()` na
thread da interface. Ações (`scan`, `cancel`, `updates`) bloqueiam até ao
timeout: chame-as numa thread de trabalho.

## Security Center de referência

`reference/security_center.cpp` é um programa autónomo com Visão geral, Scanner
(confirmação explícita, cancelar com o ID devolvido), Motores, Histórico e
alertas, Atualizações e Definições. Pontos de adaptação no topo do ficheiro:

- `Theme nigorTheme()` → mapear para os tokens de `src/ui/appearance.h`;
- `Client::openApp()` → ou o lançador da sessão Nigor;
- `NotificationSink` → ligar ao futuro sistema de notificações (hoje não faz nada).

Opções: `--status-binary CAMINHO` / `--update-binary CAMINHO` (testes) e
`--self-test` (abre, desenha os seis separadores e termina).
