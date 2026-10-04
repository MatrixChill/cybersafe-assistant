# MANUAL GATES — 2026-10-02 (preparados, NÃO executados)

Preparados pela sprint. Nenhum comando abaixo foi executado. Cada gate tem o comando exacto,
o que se espera ver, e o que fazer se não bater certo.

---

## GATE 1 — Hash DB RUNTIME (o gate que fecha F5 no runtime)

**Porquê**: o sync de ficheiro está auditado e as 3 bases estão coerentes (sha `c70b6d50`).
Falta provar que o **serviço a correr** não reintroduz o 71b6 nem mexe nas entradas.

**Pré-condição**: nada de scanner pesado, nada de freshclam. Só arranque + leitura de estado.

```
1. Registar o estado ANTES:
   - abrir  C:\Users\caioc\.cybersafe-service\definitions\hashes\default.json
   - contagem de entradas e source de cada uma
   - (opcional) sha256 do ficheiro

2. Arrancar o CyberSafe normalmente (o serviço arranca com a app).

3. Ler o estado DEPOIS (sem fazer scan):
   - o mesmo ficheiro: contagem e source
   - C:\Users\caioc\.cybersafe-service\logs\  -> procurar "erro de migracao",
     "Hashes", "Refresh", "fail"

4. Se a app tiver Protection Details: confirmar Hash DB = "Base local ativa"
   e a contagem de assinaturas = 3.
```

**ACEITE** (tudo tem de ser SIM):
- [ ] contagem continua **3**
- [ ] `71b6a493…` **ausente**
- [ ] `ed01ebfb…` continua `WannaCry-Ransomware` com `source: malwarebazaar`
- [ ] `24d004a1…` continua `WannaCry-Ransomware` com `source: malwarebazaar`
- [ ] nenhuma entrada externa apagada
- [ ] ProtectionHealth: Hash DB `active`, YARA **nao** `active` (é o canário → tem de ser `degraded`)
- [ ] logs sem erro de migração

**SE ALGUM FALHAR**: guardar o ficheiro antes/depois e o log, e reportar. O P0 de hash identity
(`healLegacyRecords`) apaga **apenas** SHA da lista `RETIRED_HASH_SIGNATURES` — se apagar outra coisa,
é regressão.

---

## GATE 2 — Scanner DEV (ver a UI com dados reais)

**Porquê**: a UI foi validada por testes (438/438) mas nunca com um scan real. Estados terminais
("Sem ameaças detetadas") só se provam com o fluxo real.

```
1. Arrancar em modo DEV (o que o repo usa para desenvolvimento).
2. File Scanner -> escolher UMA pasta pequena e nao sensivel
   (ex.: uma pasta de teste com 3-4 ficheiros, NUNCA a pasta do utilizador).
3. Observar, por ordem:
   - "preparing" aparece?
   - "scanning" com progresso?
   - "completed" com o numero de ficheiros varridos a bater com a escolha?
   - "Sem ameaças detetadas" so aparece se completou sem deteccoes?
4. Se houver deteccao: confirmar toast PT-PT, origem (Local), contagem que NAO recua,
   e a copy de quarentena.
5. Cancelar um scan a meio: o cartao "Sem ameaças detetadas" nao pode aparecer.
```

**ACEITE**:
- [ ] nenhum estado terminal falso em scan em curso / cancelado / falhado
- [ ] toast em PT-PT (depende do W2: o service tem de emitir PT-PT)
- [ ] origem Local (não Web) para ficheiros locais
- [ ] threat count monotónico durante e depois do scan

---

## GATE 3 — ClamAV (o único que toca na rede)

**Porquê**: a config gerida está pronta e testada (29/29), mas **nunca foi corrido um freshclam real**.
Tudo o que falta é o primeiro download real.

**Estado da config (verificado, read-only)**:
- `MANAGED_CONFIG_PATH = <definitionsDir>/clamav/freshclam.conf` — gerida pelo CyberSafe
- `USES_GLOBAL_CONFIG = NÃO` (deliberado; o Chocolatey não traz config e escrever em ProgramData exigiria admin)
- `DatabaseDirectory` = o mesmo directório, absoluto
- `DatabaseMirror = database.clamav.net` (CDN Cisco Talos)
- `Foreground true` → stdout/stderr vão para o pipe do serviço
- Sem `UpdateLogFile` (a saída é capturada, não um ficheiro)
- `--quiet` é omitido em diagnóstico → o erro real chega ao log

**Antes de correr** (importante):
```
1. Confirmar espaço em disco: a base do ClamAV ocupa ~1-2 GB.
2. Confirmar ligacao: o mirror e database.clamav.net.
3. Saber que a 1a descida é lenta (dezenas de minutos) e que o serviço tem
   timeout de 120 s por tentativa, com MaxAttempts 3 / MaxRetry 2.
```

**Comando (NÃO executado por esta sprint)**:
```
freshclam --config-file="<definitionsDir>\clamav\freshclam.conf" --datadir="<definitionsDir>\clamav"
```

**ACEITE**:
- [ ] sai 0
- [ ] aparecem ficheiros `.cvd`/`.cld` em `<definitionsDir>\clamav`
- [ ] o log do serviço regista "ClamAV atualizado via freshclam" (updater.ts:91)
- [ ] ProtectionHealth: ClamAV deixa `degraded` e passa a `active`
- [ ] em caso de falha, o log distingue **REDE** de **CONFIG** (`explainFreshclamError`)

⚠️ `definitionsDir` = `C:\Users\caioc\.cybersafe-service\definitions` (por perfil de utilizador).
⚠️ Se correr como serviço (SYSTEM), o caminho é o do perfil SYSTEM, **não** o do utilizador com sessão.
