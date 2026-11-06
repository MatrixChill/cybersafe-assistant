<#
  CyberSafe Assistant — diagnóstico portátil (SÓ LEITURA)

  Para o computador onde o ClamAV/serviço falham. Não instala, não altera, não
  apaga nada, não toca no Defender nem em definições. Recolhe só dados técnicos:
  versões, processos do CyberSafe/ClamAV, base de assinaturas, espaço livre,
  estado do Defender e as linhas relevantes dos logs do serviço.

  Privacidade: o caminho do perfil é substituído por %USERPROFILE%; o registo de
  eventos de segurança (que contém nomes de ficheiros) NÃO é recolhido.

  Uso (PowerShell normal, sem administrador):
    powershell -ExecutionPolicy Bypass -File .\cybersafe-diagnostico.ps1
    powershell -ExecutionPolicy Bypass -File .\cybersafe-diagnostico.ps1 -MedirClamAV

  -MedirClamAV lança UM clamscan contra um ficheiro de texto benigno criado na
  pasta temporária, para medir quanto tempo a base demora a carregar neste PC.
  Consome ~1 GB de RAM durante essa medição e não analisa ficheiros teus.
#>
param([switch]$MedirClamAV)
$ErrorActionPreference = 'Continue'
$perfil = $env:USERPROFILE
function Limpo([string]$t) { if ($null -eq $t) { return '' }; return $t.Replace($perfil, '%USERPROFILE%') }
$out = New-Object System.Collections.Generic.List[string]
function L([string]$t) { $out.Add((Limpo $t)) }

L "== CyberSafe diagnóstico $(Get-Date -Format o)"
$os = Get-CimInstance Win32_OperatingSystem
L "Windows: $($os.Caption) $($os.Version) build $($os.BuildNumber); RAM total $([math]::Round($os.TotalVisibleMemorySize/1MB,1)) GB, livre $([math]::Round($os.FreePhysicalMemory/1MB,1)) GB"
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
L "CPU: $($cpu.Name.Trim()) ($($cpu.NumberOfLogicalProcessors) lógicos)"
$c = Get-PSDrive C; L ("Disco C: livre {0:N1} GB de {1:N1} GB" -f ($c.Free/1GB), (($c.Free+$c.Used)/1GB))

L ""; L "== Instalações"
$app = Join-Path $env:LOCALAPPDATA 'Programs\CyberSafe Assistant'
$exe = Join-Path $app 'CyberSafe Assistant.exe'
if (Test-Path $exe) { L "App: $((Get-Item $exe).VersionInfo.ProductVersion) em $app" } else { L "App: não encontrada em $app" }
foreach ($k in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*') {
  Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'CyberSafe*' } | ForEach-Object { L "Registo: $($_.DisplayName) | $($_.DisplayVersion) | $($_.InstallLocation) | $k" }
}

L ""; L "== Processos"
Get-Process | Where-Object { $_.ProcessName -match 'CyberSafe|clamscan|freshclam|yara|scan-engine' } | ForEach-Object {
  $st = try { $_.StartTime.ToString('o') } catch { '?' }
  L ("{0} PID {1} RAM {2} MB início {3}" -f $_.ProcessName, $_.Id, [math]::Round($_.WorkingSet64/1MB), $st)
}
$svc = Get-Service -Name 'cybersafeengine.exe' -ErrorAction SilentlyContinue
if ($svc) { L "Serviço Windows cybersafeengine.exe: $($svc.Status) / $($svc.StartType)" }

L ""; L "== ClamAV"
$clam = Join-Path $app 'resources\clamav\clamscan.exe'
if (Test-Path $clam) {
  L "clamscan: $clam"
  try { L ("versão: " + (& $clam --version 2>&1 | Select-Object -First 1)) } catch { L "versão: falhou ($($_.Exception.Message))" }
} else { L "clamscan empacotado: não encontrado" }
$bases = @((Join-Path $perfil '.cybersafe-service\definitions\clamav'), (Join-Path $app 'resources\clamav-seed'))
foreach ($b in $bases) {
  if (Test-Path $b) {
    Get-ChildItem $b -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.cvd','.cld','.cud' } | ForEach-Object { L ("base {0}: {1} {2:N1} MB {3}" -f $b, $_.Name, ($_.Length/1MB), $_.LastWriteTime.ToString('o')) }
  } else { L "base ${b}: inexistente" }
}

L ""; L "== Microsoft Defender (só leitura)"
try {
  $mp = Get-MpComputerStatus -ErrorAction Stop
  L "Tempo real: $($mp.RealTimeProtectionEnabled); antivírus: $($mp.AntivirusEnabled); definições: $($mp.AntivirusSignatureLastUpdated)"
} catch { L "Get-MpComputerStatus indisponível: $($_.Exception.Message)" }

L ""; L "== Logs do serviço (linhas relevantes, sanitizadas)"
$logs = @((Join-Path $perfil '.cybersafe-service\error.log'), (Join-Path $perfil '.cybersafe-service\boot-debug.log'))
foreach ($f in $logs) {
  if (Test-Path $f) {
    L "-- $f"
    Get-Content $f -Tail 400 -ErrorAction SilentlyContinue | Where-Object { $_ -match 'Service starting|fully initialized|engine-init|ClamAV|clamav|LOAD_PROOF|poison|envenen|timeout|Error|falh' } | Select-Object -Last 60 | ForEach-Object { L $_ }
  }
}

if ($MedirClamAV -and (Test-Path $clam)) {
  L ""; L "== Medição da carga do ClamAV (1 clamscan, ficheiro benigno)"
  $base = $bases | Where-Object { Test-Path (Join-Path $_ 'main.cvd') } | Select-Object -First 1
  if ($base) {
    $fx = Join-Path $env:TEMP "cybersafe-diag-$([guid]::NewGuid().ToString('N')).txt"
    Set-Content -LiteralPath $fx -Value 'ficheiro benigno do diagnóstico CyberSafe' -Encoding ASCII
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = & $clam "--database=$base" --no-summary $fx 2>&1
    $sw.Stop()
    L ("tempo {0:N1} s, exit {1}, base {2}" -f $sw.Elapsed.TotalSeconds, $LASTEXITCODE, $base)
    L ("saída: " + (($r | Select-Object -First 3) -join ' | '))
    Remove-Item -LiteralPath $fx -Force -ErrorAction SilentlyContinue
  } else { L "sem base com main.cvd para medir" }
}

$dest = Join-Path ([Environment]::GetFolderPath('Desktop')) ("cybersafe-diagnostico-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$out | Set-Content -LiteralPath $dest -Encoding UTF8
Write-Output "Diagnóstico gravado em: $dest"
