param([string]$Manifest='output/orbital-backend-lab/latest.json',[switch]$FunctionsOnly)
$ErrorActionPreference='Stop'
$repo=(Get-Location).Path
$lab=Get-Content -Raw $Manifest | ConvertFrom-Json
if(!$lab.run.StartsWith((Join-Path $repo 'output\orbital-backend-lab\run-'))) { throw 'Refusing non-LAB root' }
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class NativeOrbital {
 public delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb,IntPtr p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h,StringBuilder t,int n);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h,int id);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] public static extern IntPtr SetText(IntPtr h,uint m,IntPtr w,string t);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] public static extern IntPtr GetText(IntPtr h,uint m,IntPtr w,StringBuilder t);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint f);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
 public static IntPtr Find(uint pid) { IntPtr found=IntPtr.Zero; EnumWindows((h,p)=>{ uint owner;GetWindowThreadProcessId(h,out owner); var t=new StringBuilder(128);GetClassNameW(h,t,128); if(owner==pid && t.ToString()=="CyberSafeSetupUI") found=h;return true;},IntPtr.Zero); return found; }
}
'@
function Wait-Window($p) {
 $end=(Get-Date).AddSeconds(10)
 do { $h=[NativeOrbital]::Find($p.Id); if($h -ne [IntPtr]::Zero){return $h}; if($p.HasExited){throw "Process exited without UI: $($p.ExitCode)"}; Start-Sleep -Milliseconds 100 } while((Get-Date)-lt $end)
 throw 'No original Orbital B window in owned process'
}
function Click($h,$x,$y) {
 $point=[IntPtr](([int]$y -shl 16) -bor [int]$x)
 [NativeOrbital]::PostMessage($h,0x201,[IntPtr]1,$point)|Out-Null
 [NativeOrbital]::PostMessage($h,0x202,[IntPtr]::Zero,$point)|Out-Null
 Start-Sleep -Milliseconds 180
}
function Key($h,$key) { [NativeOrbital]::PostMessage($h,0x100,[IntPtr]$key,[IntPtr]::Zero)|Out-Null;Start-Sleep -Milliseconds 180 }
function Shot($h,$path) {
 $r=New-Object NativeOrbital+RECT;[NativeOrbital]::GetClientRect($h,[ref]$r)|Out-Null
 if($r.R -le 0 -or $r.B -le 0){throw "Owned UI no longer available for capture: $path"}
 $bmp=New-Object Drawing.Bitmap $r.R,$r.B;$g=[Drawing.Graphics]::FromImage($bmp);$dc=$g.GetHdc()
 try {if(![NativeOrbital]::PrintWindow($h,$dc,2)){throw 'Native capture failed'}} finally {$g.ReleaseHdc($dc);$g.Dispose()}
 $bmp.Save($path);$bmp.Dispose()
}
if($FunctionsOnly){return}
$results=@()
foreach($f in $lab.fixtures) {
 if($f.mode -eq 'silent') {
  $p=Start-Process -FilePath $f.exe -ArgumentList '/S' -PassThru
  try {
   if(!$p.WaitForExit(12000)){throw 'Silent engine did not exit'}
   if($p.ExitCode -ne 0){throw 'Silent engine failed'}
   if([NativeOrbital]::Find($p.Id) -ne [IntPtr]::Zero){throw 'Silent launcher path opened UI'}
   $files=@(Get-ChildItem $f.target -File)
   if($files.Count -ne 20){throw 'Silent engine did not extract 20 files'}
   foreach($file in $files){if((Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lab.payloadSha256){throw 'Silent payload mismatch'}}
   $results+=@{mode='silent';exitCode=$p.ExitCode;files=$files.Count;hashesVerified=$true}
  } finally {if(!$p.HasExited){Stop-Process -Id $p.Id -Force}}
  continue
 }
 $p=Start-Process -FilePath $f.exe -PassThru
 $dir=Split-Path $f.exe
 try {
  Write-Host "RUN $($f.mode)"
  $h=Wait-Window $p;Start-Sleep -Milliseconds 450
  $r=New-Object NativeOrbital+RECT;[NativeOrbital]::GetClientRect($h,[ref]$r)|Out-Null
  if($r.R -lt 1000 -or $r.B -lt 650){throw 'Unexpected small wizard instead of Orbital B'}
  Shot $h (Join-Path $dir 'welcome.png')
  if($f.mode -eq 'cancel') {
   [NativeOrbital]::PostMessage($h,0x10,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null
   if(!$p.WaitForExit(6000)){throw 'Pre-install cancellation did not terminate'}
   if(Test-Path $f.target){throw 'Cancellation extracted payload'}
   if($p.ExitCode -eq 0){throw 'Cancellation falsely reports success'}
   $results+=@{mode=$f.mode;exitCode=$p.ExitCode;files=0};continue
  }
  # Original welcome keyboard focus: Install, then Continue on scope page.
  Key $h 13;Key $h 39;Key $h 13
  $edit=[NativeOrbital]::GetDlgItem($h,100)
  if(![NativeOrbital]::IsWindowVisible($edit)){throw 'Actual destination EDIT not visible'}
  if($f.mode -eq 'invalid') {
   [NativeOrbital]::SetText($edit,0xC,[IntPtr]::Zero,'relative\unsafe')|Out-Null
   Key $h 39;Key $h 13
   if(![NativeOrbital]::IsWindowVisible($edit)){throw 'Invalid destination was accepted'}
   if(Test-Path $f.target){throw 'Invalid destination extracted payload'}
   Shot $h (Join-Path $dir 'invalid.png')
   [NativeOrbital]::PostMessage($h,0x10,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null
   if(!$p.WaitForExit(6000)){throw 'Invalid path cancellation did not terminate'}
   $results+=@{mode=$f.mode;exitCode=$p.ExitCode;invalidRefused=$true};continue
  }
  [NativeOrbital]::SetText($edit,0xC,[IntPtr]::Zero,$f.target)|Out-Null
  $text=New-Object Text.StringBuilder 512
  [NativeOrbital]::GetText($edit,0xD,[IntPtr]512,$text)|Out-Null
  if($text.ToString() -ne $f.target){throw 'Native EDIT did not accept selected destination'}
  if($f.mode -in @('occupied','wrongname')) {
   Key $h 39;Key $h 13
   Start-Sleep -Milliseconds 300
   Shot $h (Join-Path $dir 'refused.png');Key $h 13
   if(!$p.WaitForExit(7000) -or $p.ExitCode -eq 0){throw 'Unsafe target did not fail closed'}
   if($f.mode -eq 'occupied' -and (Get-Content -Raw (Join-Path $f.target 'preserve.txt')) -ne 'Unrelated existing data; must never be installed over.'){throw 'Existing data modified'}
   if(Test-Path (Join-Path $f.target 'benign-0.txt')){throw 'Unsafe target extracted payload'}
   $results+=@{mode=$f.mode;exitCode=$p.ExitCode;unsafeTargetRefused=$true};continue
  }
  # Toggle both real options (mouse hit-test in original layout).
  $scale=$r.R/1120.0
  Click $h ([int]($r.R*0.536+8*$scale)) ([int](302*$scale))
  Click $h ([int]($r.R*0.536+8*$scale)) ([int](334*$scale))
  Shot $h (Join-Path $dir 'options.png')
  Key $h 39;Key $h 13
  Write-Host 'Installation requested'
  Start-Sleep -Milliseconds 300
  Shot $h (Join-Path $dir 'progress.png')
  # Attempt close during critical extraction: must not interrupt or fake success.
  if($f.mode -eq 'success') { [NativeOrbital]::PostMessage($h,0x10,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null }
  Start-Sleep -Milliseconds 2600
  Shot $h (Join-Path $dir 'terminal.png')
  Key $h 13
  if(!$p.WaitForExit(7000)){throw 'Terminal page did not close cleanly'}
  $files=@(Get-ChildItem $f.target -File -ErrorAction SilentlyContinue)
  if($f.mode -eq 'tampered') {
   if($files.Count -ne 0 -or $p.ExitCode -eq 0){throw 'Tampered destination did not fail closed'}
  } else {
   if($files.Count -ne 20){throw "Expected 20 actual extracted files, got $($files.Count)"}
   $mismatches=@($files | Where-Object {(Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lab.payloadSha256})
   if($f.mode -eq 'corrupt'){if($mismatches.Count -ne 1 -or $p.ExitCode -eq 0){throw 'Corrupt payload was not rejected'}}
   elseif($mismatches.Count -ne 0){throw 'Extracted payload SHA256 mismatch'}
   if($f.mode -eq 'success' -and $p.ExitCode -ne 0){throw "Real extraction failed: $($p.ExitCode)"}
   if($f.mode -in @('error','quit','unverified') -and $p.ExitCode -eq 0){throw 'Engine error falsely reports success'}
  }
  if(Test-Path $f.initial){throw 'Offered destination used instead of chosen destination'}
  $results+=@{mode=$f.mode;exitCode=$p.ExitCode;files=$files.Count;hashesVerified=($files.Count -eq 20 -and $f.mode -ne 'corrupt');originalWindow=@($r.R,$r.B)}
 } finally {if(!$p.HasExited){Stop-Process -Id $p.Id -Force}}
}
$results|ConvertTo-Json -Depth 5|Set-Content -Encoding UTF8 (Join-Path $lab.run 'observations.json')
$results|ConvertTo-Json -Depth 5
