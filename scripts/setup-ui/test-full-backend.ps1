param([switch]$CleanupOnly,[switch]$InteractiveUpgrade,[ValidateSet('Open','Tampered','Missing','Close','WriteLocked','InvalidImage')][string]$LaunchCase='Open')
$ErrorActionPreference='Stop'
. "$PSScriptRoot\test-backend.ps1" -FunctionsOnly
$full=Get-Content -Raw 'output/orbital-full-lab/latest.json' | ConvertFrom-Json
if(!$full.dir.StartsWith((Join-Path $repo 'output\orbital-full-lab\run-'))){throw 'Invalid full LAB root'}
$reg="HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$($full.id)"
$installReg="HKCU:\Software\$($full.id)"
if($CleanupOnly) {
 $uninstaller=Join-Path $full.target "Uninstall $($full.name).exe"
 if(!(Test-Path $uninstaller)){throw 'Owned LAB uninstaller missing'}
 if((Get-FileHash $uninstaller -Algorithm SHA256).Hash -ne (Get-FileHash (Join-Path $full.dir 'uninstaller-generated.exe') -Algorithm SHA256).Hash){throw 'Owned uninstaller hash mismatch'}
 $u=Start-Process -FilePath $uninstaller -ArgumentList @('/S','/currentuser') -PassThru
 if(!$u.WaitForExit(15000) -or $u.ExitCode -ne 0){throw 'Owned LAB cleanup failed'}
 $end=(Get-Date).AddSeconds(10)
 do{Start-Sleep -Milliseconds 100}while((Test-Path $reg) -and (Get-Date)-lt $end)
 if(Test-Path $reg){throw 'Owned LAB registry not removed'}
 $cache=Join-Path $env:LOCALAPPDATA "$($full.id).exe"
 if(Test-Path $cache){if((Get-FileHash $cache -Algorithm SHA256).Hash.ToLowerInvariant() -ne $full.sha256){throw 'Unexpected cache bytes'};Remove-Item -LiteralPath $cache}
 Write-Host 'Owned interrupted LAB uninstalled via its hash-verified legitimate uninstaller';return
}
if(Test-Path $reg){throw 'Fresh unique registry identity already exists'}
$data=Join-Path $full.dir 'user-data';New-Item -ItemType Directory $data|Out-Null
Set-Content -LiteralPath (Join-Path $data 'preserve.txt') -Value 'LAB user data must survive uninstall' -NoNewline
if((Get-Content -LiteralPath (Join-Path $data 'preserve.txt') -Raw) -ne 'LAB user data must survive uninstall'){throw 'Preservation fixture was not written'}
$p=Start-Process -FilePath $full.exe -ArgumentList @('/currentuser',"/D=$($full.initial)") -PassThru
try {
 $h=Wait-Window $p;Start-Sleep -Milliseconds 400
 Shot $h (Join-Path $full.dir 'welcome.png')
 # The original License action shows the actual UTF-8 document in-process.
 Key $h 39;Key $h 39;Key $h 39;Key $h 13
 $licenseEdit=[NativeOrbital]::GetDlgItem($h,101)
 if(![NativeOrbital]::IsWindowVisible($licenseEdit)){throw 'License document is not visible'}
 $licenseText=New-Object Text.StringBuilder 65536
 [NativeOrbital]::GetText($licenseEdit,0xD,[IntPtr]65536,$licenseText)|Out-Null
 $official=[IO.File]::ReadAllText((Join-Path $repo 'assets\licenses\THIRD-PARTY-NOTICES.txt'))
 if($licenseText.ToString() -ne $official){throw 'Bundled license differs from the actual notices'}
 Shot $h (Join-Path $full.dir 'license.png');Key $h 13
 Key $h 13;Key $h 39;Key $h 13
 $edit=[NativeOrbital]::GetDlgItem($h,100)
 [NativeOrbital]::SetText($edit,0xC,[IntPtr]::Zero,$full.target)|Out-Null
 $text=New-Object Text.StringBuilder 512;[NativeOrbital]::GetText($edit,0xD,[IntPtr]512,$text)|Out-Null
 if($text.ToString() -ne $full.target){throw 'Chosen target missing from actual EDIT'}
 Key $h 68;Key $h 77 # both shortcuts off; no user desktop/start-menu artefacts
 Shot $h (Join-Path $full.dir 'options.png')
 Key $h 39;Key $h 13
 $end=(Get-Date).AddSeconds(15)
 do {
  Start-Sleep -Milliseconds 100
  $done=(Test-Path (Join-Path $full.target "Uninstall $($full.name).exe"))
 } while(!$done -and !$p.HasExited -and (Get-Date)-lt $end)
 if(!$done){throw 'Real stock install section did not write uninstaller'}
 Start-Sleep -Milliseconds 900
 Shot $h (Join-Path $full.dir 'complete.png')
 foreach($file in $full.files){if((Get-FileHash (Join-Path $full.target $file.relative) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){throw 'Full 7z installed payload hash mismatch'}}
 if((Get-ItemProperty $reg).DisplayVersion -ne '0.2.0-rc.1-LAB'){throw 'Registered version mismatch'}
 if((Get-ItemProperty $installReg).InstallLocation -ne $full.target){throw 'Registered destination mismatch'}
 # Stock .onInit executes SetOutPath before customInit, creating an empty
 # offered directory. Assert no payload there, not absence of the empty folder.
 if((Test-Path $full.initial) -and @(Get-ChildItem $full.initial -Force).Count -ne 0){throw 'Stock section wrote payload outside chosen destination'}
 $marker=Join-Path $full.target 'lab-opened.txt'
 $image=Join-Path $full.target "$($full.name).exe"
 if(Test-Path -LiteralPath $marker){throw 'LAB app started before consent'}
 if($LaunchCase -in 'Tampered','Missing'){
  Move-Item -LiteralPath $image -Destination "$image.lab-original"
  if($LaunchCase -eq 'Tampered'){Set-Content -LiteralPath $image -Value 'tampered LAB image'}
 }
 if($LaunchCase -eq 'Close'){Key $h 39}
 $writer=$null
 try {
  if($LaunchCase -eq 'WriteLocked'){
   $writer=[IO.File]::Open($image,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
  }
  Key $h 13 # Opening is the first action on the verified completion screen.
  if($writer -and !$p.WaitForExit(10000)){throw 'Setup did not refuse the concurrent writer'}
 } finally {
  if($writer){$writer.Dispose()}
 }
 if($LaunchCase -ne 'Open'){
  if(!$p.WaitForExit(10000)){throw 'Setup did not exit'}
  $expected=if($LaunchCase -eq 'Close'){0}else{2}
  if($p.ExitCode -ne $expected){throw "Unexpected exit for ${LaunchCase}: $($p.ExitCode)"}
  if(Test-Path -LiteralPath $marker){throw 'LAB app ran despite refusal or dismissal'}
  if(Test-Path -LiteralPath "$image.lab-original"){
   Move-Item -LiteralPath "$image.lab-original" -Destination $image -Force
  }
  Write-Host "PASS: $LaunchCase did not execute the LAB image"
  & $PSCommandPath -CleanupOnly
  return
 }
 if(!$p.WaitForExit(10000) -or $p.ExitCode -ne 0){throw 'Full stock install failed'}
 $end=(Get-Date).AddSeconds(10)
 do {Start-Sleep -Milliseconds 100}while(!(Test-Path -LiteralPath $marker) -and (Get-Date)-lt $end)
 if(!(Test-Path -LiteralPath $marker)){throw 'The installed LAB executable did not run'}
 if((Get-Content -Raw -LiteralPath $marker) -ne (Join-Path $full.target "$($full.name).exe")){throw 'Unexpected running image path'}
 Write-Host 'PASS: Abrir executed the installed benign image after verified completion'
 # Real stock A -> B upgrade with /S --updated. No trust keys or launcher
 # publisher bypass: this is an isolated NSIS engine compatibility check.
 $upgradeArgs=if($InteractiveUpgrade){@('/currentuser',"/D=$($full.target)")}else{@('/S','--updated','/currentuser')}
 $b=Start-Process -FilePath $full.exeB -ArgumentList $upgradeArgs -PassThru
 if($InteractiveUpgrade){
  $bh=Wait-Window $b
  Key $bh 13;Key $bh 39;Key $bh 13
  $be=[NativeOrbital]::GetDlgItem($bh,100)
  $bt=New-Object Text.StringBuilder 512
  [NativeOrbital]::GetText($be,0xD,[IntPtr]512,$bt)|Out-Null
  if($bt.ToString() -ne $full.target){throw 'Interactive upgrade did not offer the registered destination'}
  Key $bh 68;Key $bh 77;Key $bh 39;Key $bh 13
  Start-Sleep -Seconds 3
  Shot $bh (Join-Path $full.dir 'interactive-upgrade.png')
  Key $bh 13
 }
 if(!$b.WaitForExit(20000) -or $b.ExitCode -ne 0){throw 'Silent A to B upgrade failed'}
 if([NativeOrbital]::Find($b.Id) -ne [IntPtr]::Zero){throw 'Silent B opened interactive frontend'}
 foreach($file in $full.filesB){if((Get-FileHash (Join-Path $full.target $file.relative) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){throw 'Version B installed payload mismatch'}}
 if((Get-ItemProperty $reg).DisplayVersion -ne '0.2.0-rc.2-LAB'){throw 'Version B registry not updated'}
 if((Get-ItemProperty $installReg).InstallLocation -ne $full.target){throw 'Version B changed selected destination'}
 if((Get-Content -Raw (Join-Path $data 'preserve.txt')) -ne 'LAB user data must survive uninstall'){throw 'A to B damaged separate user data'}
 $uninstaller=Join-Path $full.target "Uninstall $($full.name).exe"
 $u=Start-Process -FilePath $uninstaller -ArgumentList @('/S','/currentuser') -PassThru
 if(!$u.WaitForExit(15000)){throw 'Legitimate LAB uninstaller did not exit'}
 if($u.ExitCode -ne 0){throw 'Legitimate LAB uninstaller failed'}
 $end=(Get-Date).AddSeconds(10)
 do {Start-Sleep -Milliseconds 100}while((Test-Path $reg) -and (Get-Date)-lt $end)
 if(Test-Path $reg){throw 'LAB uninstall registry entry remains'}
 if(Test-Path (Join-Path $full.target "$($full.name).exe")){throw 'LAB installed payload remains'}
 if((Get-Content -Raw (Join-Path $data 'preserve.txt')) -ne 'LAB user data must survive uninstall'){throw 'Separate data not preserved'}
 # Remove only the uniquely named installer cache the stock template created.
 $cache=Join-Path $env:LOCALAPPDATA "$($full.id).exe"
 if(Test-Path $cache){if((Get-FileHash $cache -Algorithm SHA256).Hash.ToLowerInvariant() -ne $full.sha256B){throw 'Unexpected cache bytes; not deleting'};Remove-Item -LiteralPath $cache}
 $result=@{status='PASS';scope='benign payload only; not CyberSafe candidate';stock7z=$true;chosenDestination=$true;sha256Verified=$full.files.Count;registryVersion='0.2.0-rc.2-LAB';interactiveUpgrade=[bool]$InteractiveUpgrade;upgradeExit=$b.ExitCode;versionBHashes=$full.filesB.Count;installExit=$p.ExitCode;uninstallExit=$u.ExitCode;separateDataPreserved=$true;registryRemoved=$true;actualNoticesVerified=$true}
 $result|ConvertTo-Json|Set-Content -Encoding UTF8 (Join-Path $full.dir 'observations.json')
 $result|ConvertTo-Json
}finally{
 if(!$p.HasExited){Stop-Process -Id $p.Id -Force}
 if($b -and !$b.HasExited){$b.CloseMainWindow()|Out-Null;$b.WaitForExit(5000)|Out-Null}
}
