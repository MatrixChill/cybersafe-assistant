# MOTORES E RESULTADOS INCONCLUSIVOS — O QUE A EVIDÊNCIA PROVA

> **Código:** `MatrixChill/cybersafe-assistant` @ `212cb64c39f74f547d4ebc6c8bff7cc5bcbcdf56`
> **Candidata ensaiada:** `0.1.10-internal.pap-r5.20261031` (SHA-256 `46718BCD…BD75`)
> **Natureza:** código inspecionado + registos da instalação (base real e logs de eventos) + testes automatizados.
> **Regra:** não se inventa a identidade de um motor quando o registo não a prova.

---

## 1. Como o resultado por ficheiro atribui um motor

O evento `artifact.analyzed` publicado pelo serviço contém, por ficheiro (`packages/service/src/engine.ts` 3048-3129):

```ts
const nativeEngine: NativeFileScanStatus = {
  status: nativeCompleted ? "completed" : nativeFailure === "unavailable" ? "unavailable"
    : nativeFailure === "cancelled" ? "cancelled" : "error",
  ...(nativeFailure ? { failure: nativeFailure } : {}),
};
const analysisState = !nativeCompleted ? (nativeFailure === "unavailable" ? "engine-unavailable"
  : nativeFailure === "cancelled" ? "inconclusive" : "failed")
  : upstreamIncomplete ? "inconclusive" : "completed";
```

- `analysisState` descreve a **cobertura deste ficheiro**: `completed`, `inconclusive`, `failed`, `engine-unavailable`, `excluded`.
- `nativeEngine.failure` é um de `unavailable | timeout | cancelled | spawn | exit | output` (`shared-types/src/index.ts` linha 840).
- `analysisState === "failed"` corresponde a uma falha do **motor nativo** (`NativeEngineBridge.scan`, `engine.ts` 3036-3059), não a YARA ou ClamAV.
- YARA e ClamAV contribuem para `inconclusive` através de fatores: `yara-timeout`, `yara-inconclusive`, `clamav-inconclusive` (`core/src/analysis.ts` 254-288), e da regra `scan_inconclusive`.
- O agregado do scan é traduzido em `inconclusiveByReason` (`service/src/scan-manager.ts` 1213-1232): `engine-unavailable` > `engine-failed` > `coverage-incomplete` > `no-verdict`.

---

## 2. Ensaio de 800 ficheiros de 2026-10-30

Registo em `%USERPROFILE%\.cybersafe-service\scans.jsonl`:

| Campo | Valor |
|---|---|
| Tipo | `quick` |
| Início / fim | 2026-10-30T21:34:15.118Z → 2026-10-30T21:40:29.434Z |
| Duração | 374 316 ms |
| Ficheiros considerados | 800 |
| Analisados | 796 |
| Excluídos | 4 |
| Falhados (agregado) | 0 |
| Inconclusivos | 20 |
| `inconclusiveByReason` | `coverage-incomplete: 18`, `engine-failed: 2` |

Cópia sanitizada do registo: `raw/scan-800-20261030.json`.

### 2.1 Os dois `engine-failed`

Extraídos dos eventos `artifact.analyzed` da instalação (`security-events.log`) na janela do ensaio:

| # | Extensão | Tamanho (bytes) | `verdict` | `analysisState` | `nativeEngine.status` | `nativeEngine.failure` | Fatores |
|---|---|---|---|---|---|---|---|
| 1 | `.iso` | 8 952 709 120 | inconclusive | **failed** | error | **timeout** | `scan_inconclusive`, `large-file-limit` |
| 2 | `.lnk` | 2 729 | inconclusive | **failed** | error | **output** | (nenhum) |

**Conclusão:** os dois `engine-failed` são falhas do **motor nativo** (bridge nativo), não de YARA nem de ClamAV. O ISO de ~8,95 GB excedeu o tempo do motor nativo; o atalho `.lnk` produziu uma saída que o bridge não conseguiu interpretar (`output`). **Não se atribui** a falha a um motor nominal diferente do que o campo `nativeEngine` indica.

Ficheiros de prova: `raw/trial-20261030-engine-failed.json` (factos sanitizados, sem caminhos nem hashes pessoais) e o `scans.jsonl` acima.

### 2.2 Os 18 `coverage-incomplete`

O agregado do scan atribui 18 resultados a `coverage-incomplete`. A causa observável é o **limite de 100 MiB**: ficheiros acima de `MAX_YARA_SCAN_FILE_BYTES` não são analisados por conteúdo e recebem o fator `large-file-limit` com veredicto `inconclusive` (`core/src/analysis.ts` 76-79 e 304-345). No mesmo intervalo foram observados, no log de eventos, quatro ficheiros >100 MiB com `large-file-limit`, `nativeEngine.status = completed` e `analysisState = inconclusive`:

| Extensão | Tamanho (bytes) |
|---|---|
| `.exe` | 171 661 062 |
| `.exe` | 330 802 522 |
| `.rar` | 173 821 346 |
| `.rar` | 347 759 705 |

**Nota de honestidade:** a contagem **18** é agregada do registo do scan; o log de eventos contém uma amostra dos factos por ficheiro. Não se apresenta a amostra como se fossem os 18.

---

## 3. Campos que atribuem uma deteção EICAR

O EICAR pode ser detetado por três caminhos independentes, cada um com a sua assinatura:

| Caminho | Regra exposta em `AnalysisResult.rulesTriggered` | Fonte no código |
|---|---|---|
| Hash built-in | `known_bad_hash` (família `EICAR-Test-File`; SHA-256 público `275a021b…f0f`) | `packages/core/src/signatures.ts` linha 41 |
| YARA | `yara_match`; regra `CyberSafe_Canary_EICAR` | `packages/core/src/yara.ts` 273 e 293; `packages/core/definitions/yara/default.yar` linha 5 |
| ClamAV | `known_malware`; assinatura `Eicar-Signature` reconhecida no `FOUND` | `packages/core/src/clamav.ts` 170-177 |

### O que é preservado e o que se perde

| Facto | Estado real |
|---|---|
| Regras que dispararam | Preservadas em `AnalysisResult.rulesTriggered` e nos fatores (`known-bad-hash`, `yara-match`, `known_malware`, `scan_inconclusive`, …) |
| Nome da regra YARA concreta | O motor devolve `YaraMatch` (com regra), mas o analisador só acrescenta a regra genérica `yara_match`; o nome da regra não chega ao resultado do ficheiro |
| Assinatura ClamAV concreta | `ClamavFileOutcome.signature` existe (`clamav.ts` 60-68) e é preenchida; o analisador usa `verdict`/`detail`, mas **não** propaga `signature` para `AnalysisResult` |
| Motor da deteção na quarentena | **Não é guardado.** `QuarantineEntry.engine` é declarado em `shared-types/src/index.ts` linha 326, mas `QuarantineManager.quarantine` (`core/src/response.ts` 95-145) só grava `detectionReason` com a lista de regras; nenhuma atribuição `engine:` é escrita |
| Log de fase por motor | `[ScanPerf] ENGINE_PHASE engine=yara|clamav|native …` só é emitido com `CYBERSAFE_DEBUG_SCAN=1` (`analysis.ts` 103-165, `engine.ts` 3040) |

**Conclusão:** uma deteção EICAR é atribuível à **regra/assinatura** que disparou (hash built-in, YARA ou ClamAV) através de `rulesTriggered`/fatores; **não** é atribuível de forma persistente a um motor no manifesto de quarentena, porque o campo `engine` nunca é preenchido. Esta é uma limitação real, não uma escolha documentada no código.

---

## 4. O que não se pode concluir

- Não se pode afirmar que os dois `engine-failed` sejam “do YARA” ou “do ClamAV”: os registos dizem `nativeEngine`.
- Não se pode afirmar que os 18 `coverage-incomplete` tenham todos o mesmo tipo de ficheiro: o agregado não o diz; a amostra mostra `.exe` e `.rar` acima de 100 MiB.
- Não se pode afirmar que o ensaio de 800 ficheiros cobriu todo o disco: foi um `quick scan` de 800 considerados.
- Não se pode afirmar que a quarentena registe o motor: não regista, como demonstrado.

---

## 5. Evidência de suporte

- `raw/scan-800-20261030.json` — registo agregado do scan.
- `raw/trial-20261030-engine-failed.json` — factos por ficheiro da janela, sanitizados.
- Código: `core/src/analysis.ts`, `core/src/scoring.ts`, `core/src/clamav.ts`, `core/src/yara.ts`, `core/src/response.ts`, `service/src/engine.ts`, `service/src/scan-manager.ts`, `shared-types/src/index.ts` @ `212cb64`.
- Testes relacionados (PASS): `threat-history-storage` (3/4; ver limitação no relatório de testes), `detection-quality` não foi executado nesta auditoria.
