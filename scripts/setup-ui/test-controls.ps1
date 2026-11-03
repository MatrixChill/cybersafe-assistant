param([string]$Exe, [string]$OutDir)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Ctl {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
function ClientW($h) { $r = New-Object Ctl+RECT; [void][Ctl]::GetClientRect($h, [ref]$r); return [int]$r.R }
function ClientH($h) { $r = New-Object Ctl+RECT; [void][Ctl]::GetClientRect($h, [ref]$r); return [int]$r.B }
function UiScale($h) { $u = [Math]::Min((ClientW $h) / 1120.0, (ClientH $h) / 720.0); if ($u -lt 1) { $u = 1 }; if ($u -gt 1.9) { $u = 1.9 }; return $u }
function Shot($h, $name) {
  $r = New-Object Ctl+RECT; [void][Ctl]::GetClientRect($h, [ref]$r)
  if ($r.R -le 0 -or $r.B -le 0) { Write-Host 'shot skipped: no client area'; return }
  $b = New-Object System.Drawing.Bitmap($r.R, $r.B)
  $g = [System.Drawing.Graphics]::FromImage($b); $dc = $g.GetHdc()
  [void][Ctl]::PrintWindow($h, $dc, 2); $g.ReleaseHdc($dc); $g.Dispose()
  $b.Save((Join-Path $OutDir $name)); $b.Dispose()
}
function ClickBtn($h, $index) {
  $cw = ClientW $h
  $u = UiScale $h
  $x = [int]($cw - 151 * $u)
  if ($index -eq 1) { $x = [int]($cw - 97 * $u) }
  if ($index -eq 2) { $x = [int]($cw - 43 * $u) }
  $lp = [IntPtr](([int](28 * $u) -shl 16) -bor $x)
  [void][Ctl]::PostMessage($h, 0x0200, [IntPtr]::Zero, $lp)
  [void][Ctl]::PostMessage($h, 0x0201, [IntPtr]1, $lp)
  [void][Ctl]::PostMessage($h, 0x0202, [IntPtr]::Zero, $lp)
  Start-Sleep -Milliseconds 700
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$p = Start-Process -FilePath $Exe -WorkingDirectory (Get-Location) -PassThru
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 50 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 150; $p.Refresh(); $h = $p.MainWindowHandle }
if ($h -eq [IntPtr]::Zero) { throw 'no window' }
Start-Sleep -Milliseconds 700
Shot $h 'state-normal.png'
Write-Host ("client=" + (ClientW $h))
ClickBtn $h 0
Write-Host ("minimized=" + [Ctl]::IsIconic($h))
[void][Ctl]::ShowWindow($h, 9)
Start-Sleep -Milliseconds 700
Write-Host ("restored_from_min=" + (-not [Ctl]::IsIconic($h)))
ClickBtn $h 1
Write-Host ("maximized=" + [Ctl]::IsZoomed($h) + " client=" + (ClientW $h))
Start-Sleep -Milliseconds 400
Shot $h 'state-maximized.png'
ClickBtn $h 1
Start-Sleep -Milliseconds 500
Write-Host ("after_restore_zoomed=" + [Ctl]::IsZoomed($h) + " client=" + (ClientW $h))
Shot $h 'state-restored.png'
ClickBtn $h 2
Start-Sleep -Milliseconds 1000
Write-Host ("closed=" + $p.HasExited)
if (-not $p.HasExited) { $p.Kill() }
