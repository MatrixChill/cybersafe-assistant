# Roadmap — do protótipo ao AV “nível indústria”

## Estado atual (documentado no código)

- Monorepo TS com serviço Windows, desktop Electron, core com YARA-X, VirusTotal, quarentena, watchers, etc. (ver `packages/service`, `packages/core`).
- `packages/native-engine`: executável **C++** com análise estática básica (hash, entropia, PE, score). **Integração no `engine.ts`:** planeada; implementar `spawn`/`execFile` e fundir JSON com o pipeline TS.

## Fase 1 — Consolidar (curto prazo)

1. Integrar `scan-engine.exe` no serviço (`native-bridge` ou equivalente).
2. Testes manuais: EICAR, `notepad.exe`, ficheiro empacotado de exemplo.
3. Documentar variáveis de ambiente em `packages/api/.env.example` (sem segredos no Git).

## Fase 2 — Engine híbrida

- TS continua a orquestrar; C++ faz blocos pesados (ficheiros grandes, PE profundo).
- Unificar scores (pesos TS + pesos C++) com regras claras nos docs.

## Fase 3 — Proteção user-mode avançada

- Melhorar watchers (mais pastas, menos latência).
- Job objects / limites para testes controlados (não “sandbox” completa).
- Endurecimento do processo do serviço (documentar limites: admin malicioso ainda pode matar processos).

## Fase 4 — Kernel (só com maturidade)

- Minifilter, callbacks de processo, WFP, ETW — **projeto separado**, WDK, assinatura de driver, BSOD risk.
- Não iniciar esta fase sem requisitos de assinatura e equipa com tempo.

## Prioridades honestas

| Prioridade | Item |
|------------|------|
| Alta | Integração TS ↔ `scan-engine` + testes |
| Média | `.env.example` completo, CI que compile o C++ |
| Baixa | “Self-defense” avançada sem kernel (expectativas realistas) |
| Futuro | Driver assinado |
