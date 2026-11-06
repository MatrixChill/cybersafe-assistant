# Defesa da PAP — CyberSafe Assistant v0.2.2

Documento de apoio à apresentação. Só contém o que está no código e nos testes desta branch
(`fix/v021-realtime-coverage`, base `v0.2.1` = `b3a216a`). A v0.2.2 é uma **candidata não publicada**.

## 1. Arquitetura em uma frase

Aplicação **Electron** (janela) com interface **React + TypeScript**, que fala por *named pipe*
com um **serviço Node.js** residente; o serviço orquestra os quatro motores (TypeScript + binários
nativos), a quarentena, o tempo real e o histórico.

| Camada | Pasta | Ficheiro a mostrar |
|---|---|---|
| Interface | `packages/app` | `src/lib/protectionOverview.ts` — uma só decisão do estado mostrado |
| Janela / IPC | `packages/desktop` | `src/preload.ts` — o que a interface pode pedir ao serviço |
| Serviço | `packages/service` | `src/engine.ts` — `handleFileObservation` (tempo real) |
| Motores | `packages/core` | `src/analysis.ts` — HashDB, YARA, ClamAV e decisão por evidência |
| Motor nativo | `packages/native-engine` | código C++ do `scan-engine` |

## 2. Os quatro motores

- **HashDB** — SHA-256 do ficheiro inteiro contra assinaturas verificadas (`core/src/signatures.ts`).
- **ClamAV 1.5.4** — vendorizado com a fonte correspondente (`vendor/clamav/VENDOR.json`); prova de saúde
  com uma assinatura própria benigna, nunca «ativo» sem prova (`core/src/clamav.ts`, `clamavProbeMarker`).
- **YARA** — regras com força de evidência (`core/src/yara.ts`, `classifyMatch`).
- **Motor nativo C++** — hash, entropia, PE (`service/src/native-engine-bridge.ts`).

Ponto a explicar: um motor que não conseguiu avaliar torna o resultado **inconclusivo**, nunca «limpo».

## 3. Tempo real (o que foi corrigido na v0.2.2)

- Ficheiros rejeitados numa rajada são seguidos **até à análise da versão atual**
  (`service/src/realtime-recovery.ts`): à espera, sem versão admitida, admitido por analisar,
  analisado, inconclusivo, alterado sem confirmação. Admitir na fila **não** é analisar.
- **Orçamento medido**, não adivinhado: 1024 caminhos (o incidente real teve um pico de 648; com 128
  ficavam 519 caminhos sem nenhuma versão admitida).
- **Downloads têm 16 lugares reservados** na fila: p95 de 63 ms sob saturação (antes 27–46 s).
- Um aviso por episódio e um desfecho no fim (antes: 721 notificações num incidente).

## 4. Quarentena

`service/src/quarantine-policy.ts` → `canAutoQuarantine`: o isolamento automático só acontece com a
política `automatic-high-confidence` **e** prova por hash exato. Deteções só pelo ClamAV (ex.: EICAR
dentro de ZIP) ficam em alerta — decisão contra falsos positivos.
Restauro: `app/src/pages/QuarantinePage.tsx` — confirmação explícita «Confirmar restauro» com destino.

## 5. MATRIX

- `app/src/lib/matrixKnowledge.ts` — conhecimento local por **palavra inteira** (a versão antiga usava
  substrings: «foi isolado» era lido como «oi»).
- `app/src/lib/processMatrix.ts` → `buildProcessLocalReply` — «Explicar na MATRIX» com só factos medidos:
  uma amostra nunca é tendência; nome conhecido não prova legitimidade.
- `app/src/lib/matrixConversation.ts` → `motivoDoEncaminhamentoLocal` — o que fica no PC e o que pode
  ir ao fornecedor; dados de processos só com autorização para aquela instância.

## 6. Atualizador

`desktop/src/updater/release-trust.json`: chave pública **Ed25519** do proprietário com impressão
digital fixada; o instalador é verificado por SHA-256; versões antigas são recusadas. A instalação
assistida está desligada por não haver Authenticode — o utilizador instala manualmente.

## 7. Testes (números reais desta branch)

Regressão completa no Windows deste portátil (6 de novembro de 2026), antes das melhorias da MATRIX:

| Pacote | Total | Passaram | Falharam | Ignorados |
|---|---|---|---|---|
| app | 3022 | 3022 | 0 | 0 |
| desktop | 694 | 694 | 0 | 0 |
| serviço | 1433 | 1416 | 0 | 17 |
| core | 1255 | 1224 | 1 (dependente de carga) | 29 |
| scripts | 484 | 484 | 0 | 0 |
| nativo | 25 | 25 | 0 | 0 |
| ClamAV real (opt-in) | 31 | 30 | 0 | 1 (EICAR manual, por política) |

Depois da MATRIX: app 3049/3049. A regressão final repete-se antes do *source freeze*.
Os ignorados têm motivo escrito no próprio teste (ex.: caminho por PID desligado em Windows, regras só de Linux).

## 8. Limitações honestas

- Não é um antivírus certificado nem substitui o Microsoft Defender.
- Sem assinatura Authenticode.
- Latência EICAR instalada, janela minimizada e reinício do serviço: validação manual em VM.
- O EICAR **não** é escrito no disco do portátil: o Defender interceta primeiro e isso não seria uma
  deteção do CyberSafe.

## 9. O que mostrar em segurança

Ver `output/V022-PAP-DEMO-CHECKLIST.md` (local): painel, Scanner sobre ficheiros benignos, restauro
de uma entrada de teste, política de quarentena, MATRIX («Quem és?», «O que é o ClamAV?», «Explicar
na MATRIX» de um processo teu), Atualizações → Verificar.

## 10. O que mudou na v0.2.3 (estabilidade)

- **ClamAV:** `core/src/clamav.ts` → `killOwnHandle` (terminar o próprio `clamscan` pelo handle),
  `clamavLoadProofFailureDetail` (diagnóstico por causa) e o prazo adaptativo da prova (30 → 120 s).
- **Arranque:** `service/src/engine.ts` → a prova do ClamAV corre em segundo plano (`clamavStartupProbe`).
- **Cobertura:** `service/src/watcher-reconciliation.ts` → `reconcileRecentWatcherRoot`;
  `service/src/realtime-recovery.ts` → estados `gone` e `requeue`.
- **Diagnóstico portátil:** `scripts/diagnostics/cybersafe-diagnostico.ps1` (só leitura, caminhos
  sanitizados).
