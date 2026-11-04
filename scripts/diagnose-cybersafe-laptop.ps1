# Run in the signed-in desktop session. Only the JSON report is written.
param([string]$OutputPath = (Join-Path (Get-Location) 'cybersafe-laptop-diagnostic.json'))
Add-Type -AssemblyName System.Windows.Forms
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors
$gpu = Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,CurrentHorizontalResolution,CurrentVerticalResolution
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\7f4c0981-4cbf-53f9-af6e-a266427c7961'
$install = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
$loc = (Get-ItemProperty -LiteralPath 'HKCU:\Software\7f4c0981-4cbf-53f9-af6e-a266427c7961' -ErrorAction SilentlyContinue).InstallLocation
$clam = if($loc){Get-ChildItem -LiteralPath (Join-Path $loc 'resources\clamav') -Filter clamscan.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1}
$api = try {
 $r = Invoke-RestMethod -Uri 'http://127.0.0.1:4000/health' -TimeoutSec 3
 @{status=$r.status;service=$r.service;databaseReady=$r.databaseReady}
} catch { @{status='unreachable'} }
$desktop = Get-ItemProperty 'HKCU:\Control Panel\Desktop' -ErrorAction SilentlyContinue
# Export only bounded, typed startup fields. Ignore text, paths and unknown keys.
$startupPath = Join-Path $env:APPDATA 'CyberSafe Assistant\logs\startup.log'
$startup = @(
 if(Test-Path -LiteralPath $startupPath -PathType Leaf){
  Get-Content -LiteralPath $startupPath -Tail 80 | ForEach-Object {
   try { $entry = $_ | ConvertFrom-Json -ErrorAction Stop } catch { return }
   if($entry.event -cmatch '^(electron-(start|ready)|service-(attempt|result)|api-(attempt|child-spawn|child-error|child-exit|ready|result|failed|unavailable|skipped)|boot-failure)$'){
    [ordered]@{
     event=$entry.event
     status=if($entry.status -cmatch '^(pending|connected|started|failed|skipped|ready|unavailable|error)$'){$entry.status}
     classification=if($entry.classification -cmatch '^(UNKNOWN|NATIVE_ABI_MISMATCH|MODULE_NOT_FOUND|PERMISSION_DENIED|EADDRINUSE|SERVICE_IDENTITY_OR_HANDSHAKE|API_SECRET_UNAVAILABLE|ISOLATION_REFUSED|TIMEOUT|SQLITE(_[A-Z_]{1,24})?|EPERM_EACCES|SPAWN_ERROR)$'){$entry.classification}
     elapsedMs=if($entry.elapsedMs -is [ValueType]){$entry.elapsedMs}
     exitCode=if($entry.exitCode -is [ValueType]){$entry.exitCode}
    }
   }
  }
 }
)
$seed = if($loc){ Join-Path $loc 'resources\clamav-seed' }
[ordered]@{
 windows = @{version=$os.Version;build=$os.BuildNumber;ramKiB=$os.TotalVisibleMemorySize;freeRamKiB=$os.FreePhysicalMemory}
 cpu=$cpu; graphics=$gpu; configuredLogPixels=$desktop.LogPixels
 screens=@([Windows.Forms.Screen]::AllScreens | ForEach-Object { @{width=$_.Bounds.Width;height=$_.Bounds.Height;workWidth=$_.WorkingArea.Width;workHeight=$_.WorkingArea.Height;primary=$_.Primary} })
 cyberSafeVersion=$install.DisplayVersion
 services=@(Get-Service '*cybersafe*' | Select-Object Name,Status,StartType)
 processes=@(Get-Process | Where-Object ProcessName -match '^(CyberSafe Assistant|clamscan|clamd|yara64|scan-engine|cybersafe-update-launcher)$' | Select-Object ProcessName,Id,CPU,WorkingSet64)
 startup=$startup
 api=$api
 clamav=@{binaryPresent=[bool]$clam;fileVersion=$clam.VersionInfo.FileVersion;seedManifestPresent=[bool]($seed -and (Test-Path -LiteralPath (Join-Path $seed 'SEED-MANIFEST.json') -PathType Leaf))}
} | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $OutputPath -Encoding utf8
