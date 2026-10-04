# SPRINT AUDIT C/D/E — READ-ONLY
Data: 2026-09-30
Projeto: C:/Users/caioc/Desktop/Caio/garoto de programa/cybersafe-assistant
Modo: READ-ONLY. Nenhum ficheiro de projeto alterado; nada instalado; freshclam NAO corrido; nada recompilado. Unica escrita: este relatorio (+ mkdir do diretorio).
Auditoria de ficheiros/discos apenas; sem probe runtime do servico nesta sessao (onde o estado runtime e citado, vem do probe pre-existente da sessao anterior).

VEREDICTO GLOBAL: os tres alvos sao auditaveis. Nada foi inventado; estimativas estao marcadas como tal.

---

## TAREFA C — YARA

**Conclusao primeiro:** `yara=active` NAO e enganoso. O motor e YARA-X real (binario nativo NAPI-RS), a regra e realmente compilada, e o pacote atual tem o motor. A pista "@litko/yara-x NAO esta em node_modules" estava ERRADA para o root do repo: esta em `node_modules/` na raiz (hoisted do monorepo), nao em `packages/*/node_modules`.

| Campo | Valor |
|---|---|
| YARA_IMPLEMENTATION | YARA-X real via `@litko/yara-x` ^0.5.0 (binding NAPI-RS, motor nativo). Declarado em `packages/core/package.json:16`. |
| IMPORT_PATH | SIM. `packages/core/src/yara.ts:1` -> `import { fromFile, compile, type YaraX, type RuleMatch } from "@litko/yara-x"`. Tambem `packages/service/src/updater.ts:4` usa `compile` para validar regras baixadas. |
| RUNTIME_PROVIDER | Modulo nativo IN-PROCESS. Wrapper `@litko/yara-x/index.js` faz `require` do pacote de plataforma `@litko/yara-x-win32-x64-msvc` (optionalDependency, package.json:64-71), que carrega `yara-x.win32-x64-msvc.node`. NAO e subprocesso, NAO e re-implementacao JS, NAO e chamada a binario externo. |
| FALLBACK | 2 niveis, nenhum finge "active": (1) sem ficheiro/conteudo invalido -> escreve `FALLBACK_RULES` (yara.ts:24-36; regra `Basic_Suspicious_Check` com strings powershell/cmd) e health = `degraded` (yara.ts:133). (2) `fromFile` falha (ex. ASAR) -> `compile(conteudo)` (yara.ts:115-122); ambos falham -> `status:"error"`, scanner null, `match()` devolve `[]` (yara.ts:154-155). |
| RULE_FILES | `C:/Users/caioc/.cybersafe-service/definitions/yara/default.yar` (317 bytes; a que o servico DEV carrega, engine.ts:321). Identicas em `definitions/yara/default.yar` (repo root) e `packages/service/definitions/yara/default.yar`. Conteudo: 1 regra `eicar` (string EICAR + meta hash1). |
| RULE_COUNT | 1. Consistente com "Loaded 1 rule(s) from file": `countRules` conta `^rule\s+\w+` (yara.ts:143-151) -> 1. |
| WHERE_ENGINE_COMES_FROM | npm `@litko/yara-x@^0.5.0` + optionalDep `@litko/yara-x-win32-x64-msvc@0.5.0`. VERIFICADO no disco: `node_modules/@litko/yara-x/` (index.js, index.d.ts, package.json) e `node_modules/@litko/yara-x-win32-x64-msvc/yara-x.win32-x64-msvc.node` — ambos presentes no root do repo (mtime Abr 25). So o core declara a dependencia (service/desktop nao). |
| DEV_ONLY | NAO. Mesmo caminho em producao. |
| PACKAGED_AVAILABLE | SIM. `packages/desktop/release/win-unpacked/resources/app.asar.unpacked/node_modules/@litko/yara-x/node_modules/@litko/yara-x-win32-x64-msvc/yara-x.win32-x64-msvc.node` existe (VERIFICADO; vem aninhado dentro do wrapper porque e optionalDependency — a resolucao Node do wrapper encontra-o; no dev a copia hoisted do root e usada). |

### Perguntas obrigatorias (C)
1. **O que executa a regra YARA?** O motor nativo YARA-X em-processo (`scanner.scan(buffer)` / `scanner.scanFileAsync(path)`, yara.ts:155/:170), instanciado por `fromFile(rulesPath)` ou `compile(conteudo)`.
2. **YARA-X real, fallback JS, subprocesso ou binario?** YARA-X REAL (binario `.node` NAPI-RS). O "fallback JS" que existe e so de FONTE de regras (regras proprias escritas em disco quando o ficheiro falta), nunca um motor JS alternativo.
3. **A regra e realmente compilada?** SIM. `fromFile` compila nativamente o `.yar`; se falhar, `compile(conteudo)` compila o texto lido. Nao ha caminho que marque `active` sem compilacao bem-sucedida.
4. **Existe fallback que deixe health `active` sem engine completo?** NAO. Regras fallback -> `degraded`; falha de carga -> `error`; scanner null -> zero deteccoes. Nenhum estado `active` falso encontrado no codigo.
5. **Entra no pacote atual?** SIM (ficheiro `.node` presente no `app.asar.unpacked` — verificado).
6. **Clean install teria a mesma capacidade?** SIM em Windows, desde que o npm instale optionalDependencies (default). Se opcional for suprimido (--no-optional) ou plataforma sem binario, o wrapper lanca -> health `error` (falha visivel, nao "active" falso).

### Notas (C)
- `definitions/yara/default.json` do utilizador contem o texto `404: Not Found` (14 bytes) — artefacto de download falhado antigo. Inofensivo: o engine so carrega `default.yar` (engine.ts:321) e yara.ts rejeita conteudo JSON/HTML (yara.ts:64-73). O `default.json` do repo root com formato de "string signatures" (powershell/mimikatz...) e legado, formato diferente, nao e consumido por esta classe.
- O `active` e honesto quanto ao MOTOR, mas a cobertura e minima: 1 regra (EICAR). "active" nao significa deteccao YARA ampla — a amplitude das regras e outro topico (depende dos feeds remotos de `YARA_SOURCES`, updater.ts:13-18).

---

## TAREFA D — CLAMAV

**Conclusao primeiro:** binario ClamAV 1.5.2 instalado (Chocolatey) e detetavel; base de assinaturas INEXISTENTE em todos os candidatos probeados -> `clamav=degraded` e CORRETO, nao e falso negativo. Sem freshclam nao ha detecao ClamAV hoje. Nao corri freshclam (instrucao).

| Campo | Valor |
|---|---|
| CLAMAV_BINARY | `clamscan` no PATH: `C:/ProgramData/chocolatey/bin/clamscan` (shim) -> `C:/ProgramData/chocolatey/lib/clamav/tools/clamav-1.5.2.win.x64/clamscan.exe`. `clamscan --version` respondeu "ClamAV 1.5.2" (probe de versao, permitido; nao modifica nada). O codigo chama `clamscan`/`clamconf` por PATH (clamav.ts probe: `execAsync("clamscan --version")`). |
| DB_EXPECTED_PATH | Da app: `C:/Users/caioc/.cybersafe-service/definitions/clamav` (`appClamavDatabaseDir`, clamav.ts:60-63; e para aqui aponta o `freshclam --datadir`, updater.ts:186-188). Candidatos extra probeados pela ponte (clamav.ts:231-260): datadir explicito (nao configurado — `new ClamavBridge()` sem opcoes, engine.ts:178), diretorios reportados por `clamconf -n`, e default de plataforma `C:/ProgramData/clamav` (clamav.ts:75-79). |
| DB_CURRENT | VAZIO/AUSENTE. `C:/Users/caioc/.cybersafe-service/definitions/clamav` existe com 0 ficheiros (verificado). `C:/ProgramData/clamav` NAO existe. `C:/ProgramData/chocolatey/lib/clamav/tools/clamav-1.5.2.win.x64/database` NAO existe. Logo 0 ficheiros .cvd/.cld/.cuv/.cud em todo o lado -> degraded "existe mas esta vazio (verificados: ...); corre freshclam" — bate certo com o probe runtime pre-existente. `scanFile` recusa-se a simular: sem assinaturas devolve `detected:false` com o health (clamav.ts, scanFile). |
| UPDATE_MECHANISM_EXISTS | SIM. `DefinitionUpdater.updateClamAV` (updater.ts:180-210): `spawn("freshclam", ["--quiet", "--datadir=<definitions>/clamav"], timeout 120s)`, integrado no scheduler de 6h (UPDATE_INTERVAL_MS, updater.ts:10) e no refresh manual (engine.ts:1231). Falha do freshclam nao e fatal (so registra erro). |
| FRESHCLAM_PATH | `C:/ProgramData/chocolatey/bin/freshclam` (shim no PATH; `freshclam.exe` existe no dir do tool). O spawn por nome resolve via PATH. |
| REQUIRES_ADMIN | NAO para o fluxo da app: o destino `--datadir` fica no perfil do utilizador (`~/.cybersafe-service/definitions/clamav`), escritivel sem elevacao, e o codigo nao pede elevacao. (Analise por leitura de codigo/caminhos; NAO testado correndo freshclam, por instrucao.) |
| NETWORK_REQUIRED | SIM. freshclam descarrega da rede CDN ClamAV; o mesmo updater precisa de rede para YARA (GitHub raw) e MalwareBazaar. |
| ESTIMATED_DOWNLOAD | NAO MEDIDO (freshclam nao corrido, por instrucao). Ordem de grandeza tipica da primeira sincronizaçao ClamAV: ~150-250 MB (main+daily+bytecode) — ESTIMATIVA NAO VERIFICADA, marcar como tal em qualquer decisao. |
| PACKAGING_IMPACT | O pacote atual NAO inclui ClamAV: `find win-unpacked -iname "*clam*"` = 0 resultados. Depende de instalacao externa (aqui, Chocolatey). Empacotar o tool completo custaria ~890 MB so o dir do tool (medido: `du -sh` = 890M, inclui .exe/.dll/.pdb) MAIS a base. Alternative realista: dependencia externa continua, ou subset minimo (clamscan+libclamav+freshclam+dlls) — mesmo assim dezenas de MB, e a base continua a exigir freshclam pos-instalacao. |
| USER_ACTION_POSSIBLE | SIM. Basta ao utilizador correr uma vez: `freshclam --datadir="C:\Users\caioc\.cybersafe-service\definitions\clamav"` (NAO corrido por mim). Se gravar .cvd/.cld com mtime < 7 dias (SIGNATURE_MAX_AGE_MS, clamav.ts:47), o proximo probe passa a `active` ("ClamAV binary available (N signature database file(s))"). Refresh manual do service tambem tenta freshclam. |

### Notas (D)
- Regra de verdade do modulo: sem ficheiros .cvd/.cld nao ha deteccao real, e o health NUNCA e `active` so porque o binario responde (comentario e implementacao em classifyClamavHealth/classifyWithCandidates). Esta regra esta a funcionar: estado atual e honesto.
- frescura: assinaturas com mais de 7 dias tambem degradam (`newestMtimeMs`), entao "active" exige base presente E fresca.

---

## TAREFA E — HASH DB

**Conclusao primeiro:** 4 assinaturas em disco = exatamente a base built-in embutida em codigo. Formato saudavel e auto-reparavel. 3 das 4 hashes NAO tem evidencia publica confirmada (marcadas `TODO-EVIDENCE` no proprio codigo — o projeto nao as inventou, mas tambem nao as provou). Nao adicionei hashes.

| Campo | Valor |
|---|---|
| CURRENT_HASHES | Ficheiro `C:/Users/caioc/.cybersafe-service/definitions/hashes/default.json` (701 bytes, mtime 2026-09-25), array com 4 objetos: (1) `24d004a104d4d54034dbcffc2a4b19a11f39008a575aa614ea04703480b1022c` WannaCry-Ransomware critical; (2) `ed01ebfbc9eb5bbea545af4d01bf5f1071661840480439c6e5babe8e080e41aa` Emotet-Trojan critical; (3) `71b6a493388e7d0b40c83ce903bc6b04d1b59f386d5ebbf117a4c7e6c43310ce` TrickBot high; (4) `275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f` EICAR-Test-File critical. EICAR aparece EXATAMENTE 1x (verificado por contagem). Bate 1:1 com `BUILTIN_HASH_SIGNATURES` (signatures.ts:18-56). |
| SOURCE | Todas `"source": "built-in"` no disco. Proveniencia real: constantes embutidas em `packages/core/src/signatures.ts`. O EICAR e deterministico e verificado (comentario :21-26). WannaCry/Emotet/TrickBot levam comentario explicito `TODO-EVIDENCE` no codigo (:36-56): sha256 NAO confirmado contra fonte publica fidedigna, mantidos como placeholder. Semeadura em disco por `load` -> `ensureFile` -> `refreshBuiltinIfStale` (engine.ts:314-320), que cura hashes legados/fabricados (`healLegacyRecords`, :259 — ex. o antigo EICAR que era MD5+32 zeros) e garante cobertura built-in (`ensureOfflineCoverage`, :277). |
| TEST_ONLY | EICAR: SIM (ficheiro-padrao de teste AV; usado como canario de pipeline; e alvo legitimo de deteccao). WannaCry/Emotet/TrickBot: NAO PROVADO (o codigo proprio declara falta de evidencia; nao afirmei deteccao real nem falsidade — nao ha amostras para comparar). Nota: existe ainda `DEV_CANARY_SIGNATURE` (signatures.ts:130) que e test-only POR DESENHO, mas NAO esta no default.json e e inerte em producao (`isDevCanaryEnabled`, :138 — bloqueado com NODE_ENV=production; deteccao por conteudo so existe quando uma fixture de teste registra o literal). |
| CAN_EXPAND_WITHOUT_ARCH_CHANGE | SIM. Formato e array JSON de {sha256, family, severity, source}; `sanitizeSignatureRecords` (signatures.ts:73-96) aceita entradas novas (valida, dedup por hash, severity normalizada para low/medium/high/critical); `match()` e lookup em Map (:445). Expansao = mais entradas no mesmo ficheiro, via feed remoto `applyRemoteRecords` (:397, fail-safe com rollback) ou edicao direta. Nenhuma mudanca de arquitectura necessaria. |
| FORMAT | JSON array pretty-printed (2 espacos, `save` :306); escrita atomica tmp+rename (:306-315); recusa gravar base vazia (fail-safe, :300); grava apenas registos validos. Estrutura de cada entrada: sha256 (64 hex, lowercase), family (string), severity (enum 4), source (string). |
| LIMITATIONS | (1) Deteccao SO por hash: qualquer variante/repack com outro SHA-256 e invisivel. (2) 3/4 hashes sem evidencia confirmada (TODO-EVIDENCE no codigo). (3) Feed remoto = MalwareBazaar `get_recent` (updater.ts:21 HASH_FEED_URL, POST, timeout 30s, :224 `sha256_hash`) — so amostras recentes, exige rede, e merge so com `query_status: ok`. (4) Sem envelhecimento/expiracao de entradas (ao contrario do ClamAV que degrada com >7 dias). (5) Sem limite de tamanho: merges acumulam (dedup por hash, sem cap) — o ficheiro cresce indefinidamente. (6) Family nova de feed entra com severity "critical" fixa (updater.ts:225-228) — tudo do MalwareBazaar chega critical. |

### Notas (E)
- health esperado do hashDb com este ficheiro: `active` "Loaded 4 signature(s) from ..." (caminho load() signatures.ts:181-216; ficheiro valido no disco). NAO probei o runtime nesta sessao — inferido de codigo+ficheiro, nao medido.
- Ciclo de vida fail-safe verificado no codigo: ficheiro ausente/corrompido/vazio -> re-semeia built-in; I/O falha com base em memoria -> degraded, nunca perde a base offline; feed parcial nunca apaga nada.

---

## AUDITABILIDADE
- C: AUDITADA (codigo + node_modules dev + app.asar.unpacked + ficheiros de regras).
- D: AUDITADA (codigo + estado real dos 3 diretorios candidatos + binarios no PATH). freshclam NAO corrido — o estado "sem base" ficou provado por listagem de diretorios, nao por execucao.
- E: AUDITADA (ficheiro em disco + codigo fonte). Nenhum dos tres exigiu inventar dados.

## FICHEIROS CITADOS (evidencia)
- packages/core/src/yara.ts (motor, fallback, health)
- packages/core/src/clamav.ts (probe, candidatos, classificacao, scanFile)
- packages/core/src/signatures.ts (BUILTIN_HASH_SIGNATURES, load/ensure/refresh/match)
- packages/core/package.json:16 (@litko/yara-x ^0.5.0)
- packages/service/src/updater.ts (freshclam, YARA_SOURCES, HASH_FEED_URL MalwareBazaar)
- packages/service/src/engine.ts:177-178, :314-321, :857-859 (construcao, carga, health assembly)
- node_modules/@litko/yara-x{,-win32-x64-msvc}/ (dev)
- packages/desktop/release/win-unpacked/resources/app.asar.unpacked/node_modules/@litko/... (pacote)
- C:/Users/caioc/.cybersafe-service/definitions/{yara,hashes,clamav}/ (estado real)
- C:/ProgramData/chocolatey/{bin,lib/clamav/tools/clamav-1.5.2.win.x64}/ (ClamAV 1.5.2)
