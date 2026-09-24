# Verificação de drivers antes de publicar um release

## Porquê

O CyberSafe é um produto de segurança: não pode distribuir — nem carregar em runtime —
drivers de kernel vulneráveis ou bloqueados.

Incidente que originou este documento: o sidecar de temperaturas
(`packages/temperature-server`, C#) usava `LibreHardwareMonitorLib` 0.9.4. Essa
biblioteca **embute** os drivers WinRing0 (`LibreHardwareMonitor.Resources.WinRing0.gz`
e `WinRing0x64.gz`) e extrai-os em runtime para o disco com o nome do executável +
`.sys` — no nosso caso `cybersafe-temp-helper.sys`. O Microsoft Defender deteta-o como
`VulnerableDriver:WinNT/Winring0` (CVE-2020-14979).

Regras que não se quebram:

- não adicionar exclusões no Defender;
- não renomear o driver nem alterar hash para escapar à deteção;
- não incluir WinRing0 (nem um fork/cópia renomeada) no installer;
- não pedir ao utilizador para aceitar o risco.

## Como a temperatura é lida agora

| Fonte | Tipo | Uso |
| --- | --- | --- |
| `systeminformation` | user-mode (WMI/CIM + APIs de fornecedor) | CPU e GPU (dedicada primeiro) |
| ACPI `MSAcpi_ThermalZoneTemperature` | user-mode (WMI) | CPU, quando exposto |

Providers baseados em LibreHardwareMonitor/WinRing0 foram **removidos**. Se nenhum
sensor seguro existir, o campo fica `null` e a UI mostra **"Indisponível"** — nunca
`0 °C`, nunca um valor antigo reaproveitado como atual. O `PC Center` mostra a
explicação: *"O Windows não disponibilizou um sensor compatível de forma segura."*

Não reintroduzir LibreHardwareMonitorLib ≤ 0.9.5-pre453 (nem qualquer pacote que
embuta WinRing0). As versões mais recentes trocaram o WinRing0 pelo driver **PawnIO**,
que é assinado mas exige instalação separada por parte do utilizador — não é uma
dependência redistribuível pelo CyberSafe.

## Checklist de release

1. **Build limpo** — construir a partir de um output vazio (sem `dist/`, `bin/` ou
   `release/` antigos) para garantir que nada é herdado de builds anteriores.
2. **Verificação estrutural** (nomes + assinaturas de conteúdo):

   ```bash
   npm run drivers:check
   # ou, para varrer caminhos específicos:
   node scripts/check-release-drivers.mjs release packages/desktop/dist
   ```

   Falha com código 1 se encontrar `*.sys`, `*winring*`, `*temp-helper*` ou a
   assinatura `WinRing0` (ASCII ou UTF-16LE) em qualquer ficheiro.

3. **Scan real do Defender no output** (obrigatório; o passo 2 não é um antivírus):

   ```bash
   "%ProgramFiles%\Windows Defender\MpCmdRun.exe" -Scan -ScanType 3 -File "<pasta-do-output>"
   ```

4. **Scan real do Defender no installer**, quando existir artefacto NSIS/`.exe`:

   ```bash
   "%ProgramFiles%\Windows Defender\MpCmdRun.exe" -Scan -ScanType 3 -File "release\CyberSafe Assistant-<versão>-setup.exe"
   ```

5. **Registar o resultado** (versão, data, comando usado e saída) em conjunto com o
   release. Guarde também os `sha256` dos binários publicados.

Não declarar "Defender clean" sem ter corrido o scan dos passos 3 e 4 e sem o
resultado registado.

## Sinais de alerta

- Aparece `VulnerableDriver:WinNT/Winring0` ou `HackTool:Win32/Winring0` num scan.
- Surge um ficheiro `*.sys` novo ao iniciar a aplicação (o driver é extraído em runtime).
- Um log menciona `LibreHardwareMonitorLib`, `WinRing0` ou `cybersafe-temp-helper`.
