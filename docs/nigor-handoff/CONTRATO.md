# Contrato de integração

Transporte: processos locais do utilizador. O cliente oficial fala com o serviço
pelo socket Unix autenticado; o Nigor **não** abre o socket, **não** lê a
credencial e **não** precisa de rede. Executar sem shell (execv), um pedido de cada vez.

## Comandos

| Comando | Saída | Consentimento |
|---|---|---|
| `cybersafe-nigor-status` | Estado JSON v1 | não |
| `cybersafe-nigor-status processes` | Processos JSON v1 (≤ 50) | não |
| `cybersafe-nigor-status scan --consent /caminho/absoluto` | `{"version":1,"accepted":true,"scanId":"…"}` | **sim** |
| `cybersafe-nigor-status cancel --consent ID` | `{"version":1,"success":true}` | **sim** |
| `cybersafe-linux-update check` | Estado de atualização (`schema` 1) | não |
| `cybersafe-linux-update install --consent` | Instala via `pkexec pacman -U` | **sim** + autorização polkit |
| `cybersafe-linux-diagnose` | Dependências (`schemaVersion` 1) | não |

Códigos de saída do cliente de estado: `0` sucesso · `1` serviço indisponível
ou operação falhou · `2` pedido recusado (ambiente/argumentos/credencial).
Destino não absoluto, symlink, ID inválido ou falta de `--consent` → recusado.

## Estado JSON v1

```json
{
  "version": 1,
  "serviceRunning": true,
  "protection": { "status": "safe|attention|critical|degraded|null", "enabled": true },
  "engines": { "clamav": "active|degraded|unavailable|error|null", "yara": "…", "hashDb": "…", "native": "…" },
  "engineReasons": { "clamav": "not-installed|no-definitions|exec-failed|starting|null", "yara": null, "hashDb": null, "native": null },
  "latestScan": { "status": "completed|cancelled|failed|null", "endedAt": "ISO|null",
                  "filesAnalyzed": 0, "filesFailed": 0, "filesInconclusive": 0, "threatsFound": 0 },
  "history": [ "… até 5 análises, mesmo formato …" ],
  "alerts": [ { "type": "threat.detected|quarantine.failed|process.blocked", "severity": "low|medium|high|critical|null", "timestamp": "ISO|null" } ],
  "alertsScope": "service-session",
  "metrics": { "cpuPercent": 0, "ramPercent": 0 }
}
```

Regras:
- `null` = sem leitura. Nunca tratar como seguro.
- `engineReasons` e `alertsScope` são aditivos: um pacote antigo não os envia (tratar como `null`).
- Análise **limpa** só com `completed`, `filesFailed = 0`, `filesInconclusive = 0`,
  `threatsFound = 0`. Inconclusivo não é limpo.
- `accepted: true` significa pedido aceite, não análise concluída.
- `alerts` vem do registo de eventos em memória desde o arranque do serviço
  (`alertsScope: "service-session"`); `history` é persistente. Uma ameaça no
  histórico sem alerta (p. ex. após reinício do serviço) não é contradição.
- «Proteção completa» só com serviço ativo, monitorização ligada, `protection.status = safe`
  e os quatro motores `active`.
- `version` ≠ 1 → incompatível: mostrar «versão do CyberSafe incompatível», não adivinhar.

## Atualizações (`cybersafe-linux-update check`)

`state`: `not-configured` (pacote sem chave pública) · `no-release` (sem versões no canal) ·
`up-to-date` · `available` (com `available.version`, `size`, `notes`,
`signature: "ed25519-verified"`) · `downgrade-refused` · `invalid` · `error`.

## Frequência recomendada
Estado: 10 s com a janela/painel visível, 60 s em segundo plano; nunca dois
pedidos em simultâneo. Timeout: 8 s estado, 15 s ações. Atualizações: ao abrir e
no máximo a cada 6 h.

## systemd, ícone e lançamento
- Serviço: `cybersafe-linux.service` (unidade de **utilizador**, opcional).
- Abrir app: executar `/usr/bin/cybersafe-assistant-linux-lite` sem argumentos.
- Ícone: `cybersafe-assistant-linux-lite` (hicolor 256 px). Desktop: `cybersafe-assistant-linux-lite.desktop`.
