/** Fixed program. Inputs are environment values, never command interpolation. */
export const WINDOWS_HANDOFF_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$handles=New-Object System.Collections.Generic.List[System.IDisposable]
$mutex=$null; $owned=$false; $phase='preparing'; $parent=$null; $trustedStage=$false; $reader=$null; $writer=$null
function Protocol($name,$value) {
  $destination=[IO.Path]::Combine($env:CS_UPDATE_STAGE,$name+'.json')
  $temp=$destination+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllText($temp,($value|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  [IO.File]::Move($temp,$destination)
}
function Result($stage,$reason,$exitCode) {
  $value=@{schema=1;operation=$env:CS_UPDATE_OPERATION;stage=$stage;reason=$reason;installerExit=$exitCode;sha256=$hash;fileIdentity=$identity;updatedAt=[DateTime]::UtcNow.ToString('o')}
  $temp=$env:CS_UPDATE_RESULT+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  [IO.File]::WriteAllText($temp,($value|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  if([IO.File]::Exists($env:CS_UPDATE_RESULT)){[IO.File]::Replace($temp,$env:CS_UPDATE_RESULT,($env:CS_UPDATE_RESULT+'.previous'))}else{[IO.File]::Move($temp,$env:CS_UPDATE_RESULT)}
}
try {
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $mutex=New-Object Threading.Mutex($false,('Local\CyberSafe-Update-'+$sid.Value))
  try{$owned=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owned=$true}
  if(!$owned){throw 'another-update-is-active'}
  $stage=[IO.Path]::GetFullPath($env:CS_UPDATE_STAGE)
  $artifact=[IO.Path]::Combine($stage,'installer.exe')
  if($stage.StartsWith('\\')){throw 'network-staging-refused'}
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
[StructLayout(LayoutKind.Sequential, Pack=4)]
public struct CyberSafeFileInfo {
 public uint Attributes; public long Created; public long Accessed; public long Written;
 public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow;
}
public static class CyberSafeDirectoryLock {
 [DllImport("kernel32.dll")]
 public static extern IntPtr GetStdHandle(int kind);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]
 public static extern uint GetDriveType(string root);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 public static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)]
 [return:MarshalAs(UnmanagedType.Bool)]
 public static extern bool GetFileInformationByHandle(SafeFileHandle handle,out CyberSafeFileInfo info);
}
'@
  if([CyberSafeDirectoryLock]::GetDriveType([IO.Path]::GetPathRoot($stage)) -ne 3){throw 'non-local-staging-refused'}
  # Retain ancestor handles to deny rename/delete; refuse junction/reparse paths.
  $directory=New-Object IO.DirectoryInfo($stage)
  while($null -ne $directory){
    if(($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse-staging-refused'}
    $h=[CyberSafeDirectoryLock]::CreateFile($directory.FullName,0,3,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
    if($h.IsInvalid){$h.Dispose();throw 'directory-lock-failed'}
    $info=New-Object CyberSafeFileInfo
    if(![CyberSafeDirectoryLock]::GetFileInformationByHandle($h,[ref]$info) -or ($info.Attributes -band 0x400) -ne 0){$h.Dispose();throw 'directory-identity-refused'}
    $handles.Add($h);$directory=$directory.Parent
  }
  $trustedStage=$true
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
  foreach($identity in @($sid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))){
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
  }
  [IO.Directory]::SetAccessControl($stage,$acl)
  $fileHandle=[CyberSafeDirectoryLock]::CreateFile($artifact,2147483648,1,[IntPtr]::Zero,3,0x00200000,[IntPtr]::Zero)
  if($fileHandle.IsInvalid){$fileHandle.Dispose();throw 'file-lock-failed'}
  $info=New-Object CyberSafeFileInfo
  if(![CyberSafeDirectoryLock]::GetFileInformationByHandle($fileHandle,[ref]$info) -or ($info.Attributes -band 0x410) -ne 0){$fileHandle.Dispose();throw 'file-identity-refused'}
  $identity=('{0:x8}:{1:x8}:{2:x8}' -f $info.Volume,$info.IndexHigh,$info.IndexLow)
  $stream=New-Object IO.FileStream($fileHandle,[IO.FileAccess]::Read)
  $handles.Add($stream)
  $sha=[Security.Cryptography.SHA256]::Create()
  try{$hash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
  $parent=[Diagnostics.Process]::GetProcessById([int]$env:CS_UPDATE_PARENT)
  $null=$parent.Handle
  $inputHandle=New-Object Microsoft.Win32.SafeHandles.SafeFileHandle([CyberSafeDirectoryLock]::GetStdHandle(-10),$false)
  $outputHandle=New-Object Microsoft.Win32.SafeHandles.SafeFileHandle([CyberSafeDirectoryLock]::GetStdHandle(-11),$false)
  $inputStream=New-Object IO.FileStream($inputHandle,[IO.FileAccess]::Read)
  $outputStream=New-Object IO.FileStream($outputHandle,[IO.FileAccess]::Write)
  $reader=New-Object IO.StreamReader($inputStream,[Text.UTF8Encoding]::new($false))
  $writer=New-Object IO.StreamWriter($outputStream,[Text.UTF8Encoding]::new($false))
  $writer.AutoFlush=$true
  $writer.WriteLine((@{event='locked';sha256=$hash;size=$stream.Length;fileIdentity=$identity}|ConvertTo-Json -Compress))
  $line=$reader.ReadLine()
  if($null -eq $line -or $line.Length -gt 4096){throw 'invalid-command'}
  $command=$line|ConvertFrom-Json
  $operation=[Guid]::Empty
  if($command.command -ne 'COMMIT' -or ![Guid]::TryParse([string]$command.operation,[ref]$operation)){throw 'handoff-not-committed'}
  $env:CS_UPDATE_OPERATION=$operation.ToString()
  if($env:CS_UPDATE_EXECUTION -ne 'authorized'){throw 'execution-not-authorized'}
  $phase='waiting-parent'
  $writer.WriteLine((@{event='armed'}|ConvertTo-Json -Compress))
  $deadline=[DateTime]::UtcNow.AddSeconds(60)
  while(!$parent.WaitForExit(50)){
    if([IO.File]::Exists([IO.Path]::Combine($stage,'abort.json'))){throw 'aborted-before-shutdown'}
    if([DateTime]::UtcNow -gt $deadline){throw 'shutdown-timeout'}
  }
  $phase='installing';Result 'installing' '' $null
  $start=New-Object Diagnostics.ProcessStartInfo
  $start.FileName=$artifact;$start.WorkingDirectory=$stage;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
  $installer=[Diagnostics.Process]::Start($start)
  if($null -eq $installer){throw 'installer-launch-failed'}
  if(!$installer.WaitForExit(1800000)){Result 'recovery-required' 'installer-timeout-do-not-retry' $null;exit 1}
  $exitCode=$installer.ExitCode;$installer.Dispose()
  if($exitCode -ne 0){Result 'recovery-required' 'installer-failed' $exitCode;exit 1}
  Result 'awaiting-start' 'version-and-data-confirmation-required' 0
}catch{
  if($phase -ne 'preparing'){try{Result 'recovery-required' $phase $null}catch{}}
  if($trustedStage){try{Protocol 'failure' @{phase=$phase;reason=$_.FullyQualifiedErrorId}}catch{}}
  exit 1
}finally{
  foreach($h in $handles){$h.Dispose()}
  if($null -ne $parent){$parent.Dispose()}
  if($owned){$mutex.ReleaseMutex()}
  if($null -ne $mutex){$mutex.Dispose()}
  if($trustedStage){try{Protocol 'closed' @{event='closed'}}catch{}}
  if($null -ne $reader){$reader.Dispose()}
  if($null -ne $writer){$writer.Dispose()}
}
`;
