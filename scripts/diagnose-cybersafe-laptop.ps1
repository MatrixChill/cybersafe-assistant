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
[ordered]@{
 windows = @{version=$os.Version;build=$os.BuildNumber;ramKiB=$os.TotalVisibleMemorySize;freeRamKiB=$os.FreePhysicalMemory}
 cpu=$cpu; graphics=$gpu; configuredLogPixels=$desktop.LogPixels
 screens=@([Windows.Forms.Screen]::AllScreens | ForEach-Object { @{width=$_.Bounds.Width;height=$_.Bounds.Height;workWidth=$_.WorkingArea.Width;workHeight=$_.WorkingArea.Height;primary=$_.Primary} })
 cyberSafeVersion=$install.DisplayVersion
 services=@(Get-Service '*cybersafe*' | Select-Object Name,Status,StartType)
 processes=@(Get-Process | Where-Object ProcessName -match '^(CyberSafe Assistant|clamscan|clamd|yara64|scan-engine|cybersafe-update-launcher)$' | Select-Object ProcessName,Id,CPU,WorkingSet64)
 api=$api
 clamav=@{binaryPresent=[bool]$clam;fileVersion=$clam.VersionInfo.FileVersion}
} | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $OutputPath -Encoding utf8
