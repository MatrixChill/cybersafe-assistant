param([string]$ExePath, [string]$OutDir)
$ErrorActionPreference = 'Stop'
# Isolation guard: this harness must never point at a real installation.
if ($OutDir -notlike '*\output\installer-pages*') { throw "refusing: OutDir outside output/installer-pages ($OutDir)" }
if ($OutDir -like '*\Programs\*' -or $OutDir -like '*\AppData\*') { throw "refusing: OutDir looks like a production path ($OutDir)" }
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class Pages {
 public delegate bool EnumProc(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
 [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
 public static string Header(IntPtr root){
  IntPtr h=IntPtr.Zero;
  EnumChildWindows(root,(x,p)=>{ if(GetDlgCtrlID(x)==1037){h=x;return false;} return true;},IntPtr.Zero);
  if(h==IntPtr.Zero) return "(sem 1037)";
  var t=new StringBuilder(256); GetWindowTextW(h,t,256); return t.ToString();
 }
}
"@
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$runDir = Join-Path $OutDir ("run-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$installDir = Join-Path $runDir 'install'
$p = Start-Process -FilePath $ExePath -ArgumentList "/D=$installDir" -PassThru
$deadline = (Get-Date).AddSeconds(15)
do { Start-Sleep -Milliseconds 300; $p.Refresh(); $h = $p.MainWindowHandle } while ($h -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline)
if ($h -eq [IntPtr]::Zero) { Stop-Process -Id $p.Id -Force; throw 'preview window not found' }
Start-Sleep -Milliseconds 1200

function Shot([string]$name) {
  for ($i = 0; $i -lt 8; $i++) {
    $r = New-Object Pages+RECT
    [Pages]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
    if ($w -gt 100 -and $ht -gt 100) { break }
    Start-Sleep -Milliseconds 300
  }
  if ($w -le 100) { Write-Output "bad rect for $name"; return }
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  [Pages]::PrintWindow($h, $dc, 2) | Out-Null
  $g.ReleaseHdc($dc); $g.Dispose()
  $bmp.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("captured {0} {1}x{2} [{3}]" -f $name, $w, $ht, [Pages]::Header($h))
}
function Next { [Pages]::PostMessage($h, 0x0111, [IntPtr]1, [IntPtr]::Zero) | Out-Null }

Shot 'pages-1-welcome.png'
Next; Start-Sleep -Milliseconds 1400; Shot 'pages-2-mode.png'
Next; Start-Sleep -Milliseconds 1400; Shot 'pages-3-config.png'
Next; Start-Sleep -Milliseconds 900;  Shot 'pages-4-progress.png'
Start-Sleep -Milliseconds 3600; Shot 'pages-5-finish.png'
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300
if (Test-Path $runDir) { Remove-Item -Recurse -Force $runDir }
Write-Output ("isolated run dir removed: {0}; existed install dir touched: {1}" -f $runDir, (Test-Path $installDir))
