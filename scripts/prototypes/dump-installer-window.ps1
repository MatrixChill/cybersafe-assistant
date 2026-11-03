param([string]$ExePath, [string]$OutDir)
$ErrorActionPreference='Stop'
if ($OutDir -notmatch '\output\installer-pages(\|$)') { throw "refusing: OutDir outside output/installer-pages" }
Add-Type @"
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class DumpAll {
 public delegate bool EnumProc(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int i);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
 public static List<string> All(IntPtr root){
  var rows=new List<string>();
  rows.Add("root client rect / children:");
  EnumChildWindows(root,(h,p)=>{
   var t=new StringBuilder(256);GetWindowTextW(h,t,256);
   var c=new StringBuilder(64);GetClassNameW(h,c,64);
   RECT r;GetWindowRect(h,out r);
   rows.Add(string.Format("hwnd={0} id={1} cls={2} parent={3} vis={4} en={5} rect={6},{7},{8},{9} style=0x{10:X8} text='{11}'",
    h.ToInt64(),GetDlgCtrlID(h),c,GetParent(h).ToInt64(),IsWindowVisible(h)?1:0,IsWindowEnabled(h)?1:0,
    r.L,r.T,r.R,r.B,GetWindowLong(h,-16),t.ToString().Replace("\r\n"," | ")));
   return true;},IntPtr.Zero);
  return rows;
 }
}
"@
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$runDir=Join-Path $OutDir ("dump-"+(Get-Date -Format 'HHmmss'))
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$p=Start-Process -FilePath $ExePath -ArgumentList "/D=$(Join-Path $runDir 'install')" -PassThru
Start-Sleep -Milliseconds 2500
$p.Refresh();$h=$p.MainWindowHandle
$out=Join-Path $OutDir 'window-dump.txt'
[DumpAll]::All($h) | Set-Content -Path $out -Encoding UTF8
Stop-Process -Id $p.Id -Force
Start-Sleep -Milliseconds 300
if (Test-Path $runDir) { Remove-Item -Recurse -Force $runDir }
Write-Output "dump: $out"
