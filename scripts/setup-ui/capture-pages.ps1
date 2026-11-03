param(
  [Parameter(Mandatory=$true)][string]$ExePath,
  [Parameter(Mandatory=$true)][string]$OutDir
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CsWin {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$exe = (Resolve-Path $ExePath).Path
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$proc = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru

$h = [IntPtr]::Zero
for ($i = 0; $i -lt 40 -and $h -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 150
  $proc.Refresh()
  $h = $proc.MainWindowHandle
}
if ($h -eq [IntPtr]::Zero) { $proc.Kill(); throw 'setup window did not appear' }

$r = New-Object CsWin+RECT
[void][CsWin]::GetClientRect($h, [ref]$r)
$scale = [double]$r.Right / 1120.0
Write-Host ("client {0}x{1} scale {2:N2}" -f $r.Right, $r.Bottom, $scale)

function Save-Shot([string]$name) {
  $rc = New-Object CsWin+RECT
  [void][CsWin]::GetClientRect($h, [ref]$rc)
  $bmp = New-Object System.Drawing.Bitmap($rc.Right, $rc.Bottom)
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $gfx.GetHdc()
  [void][CsWin]::PrintWindow($h, $dc, 2)
  $gfx.ReleaseHdc($dc)
  $gfx.Dispose()
  $path = Join-Path $OutDir $name
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "saved $name"
}

function Click-At([int]$x, [int]$y) {
  $sx = [int]($x * $scale)
  $sy = [int]($y * $scale)
  $lp = [IntPtr](($sy -shl 16) -bor ($sx -band 0xFFFF))
  [void][CsWin]::PostMessage($h, 0x0200, [IntPtr]::Zero, $lp)
  [void][CsWin]::PostMessage($h, 0x0201, [IntPtr]1, $lp)
  [void][CsWin]::PostMessage($h, 0x0202, [IntPtr]::Zero, $lp)
  Start-Sleep -Milliseconds 700
}

Save-Shot 'page-1-welcome.png'
Click-At 716 481
Save-Shot 'page-2-mode.png'
Click-At 964 481
Save-Shot 'page-3-config.png'
Click-At 964 481
Start-Sleep -Milliseconds 500
Save-Shot 'page-4-progress.png'
Start-Sleep -Milliseconds 4200
Save-Shot 'page-5-finish.png'

$proc.CloseMainWindow() | Out-Null
Start-Sleep -Milliseconds 400
if (-not $proc.HasExited) { $proc.Kill() }
Write-Host 'capture complete'
