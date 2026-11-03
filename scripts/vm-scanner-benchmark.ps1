#requires -Version 5.1
<# Explicit VM-only real-engine benchmark. Does not install, sign, or modify trust. #>
param([switch]$ExecuteAuthorized,[string]$AuthorizedVmHostname,[string]$SnapshotId,[string]$NodePath,[string]$EvidenceDirectory,[ValidateRange(1,800)][int]$Files=40)
$ErrorActionPreference='Stop'
if (-not $ExecuteAuthorized) { throw 'LAB_EXECUTION_NOT_AUTHORIZED' }
if (-not $AuthorizedVmHostname -or $env:COMPUTERNAME -ne $AuthorizedVmHostname -or -not $SnapshotId) { throw 'LAB_HOST_OR_SNAPSHOT_REQUIRED' }
$node=(Get-Item -LiteralPath $NodePath).FullName
$out=[IO.Path]::GetFullPath($EvidenceDirectory)
if (Test-Path -LiteralPath $out) { throw 'LAB_NEW_EVIDENCE_DIRECTORY_REQUIRED' }
New-Item -ItemType Directory -Path $out | Out-Null
$script=Join-Path $PSScriptRoot 'scanner-benchmark.mjs'
$previous=@{}
foreach($name in @('BENCH_REAL','BENCH_FILES','BENCH_REPORT')) { $previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process') }
$samples=New-Object System.Collections.Generic.List[object]
try {
  $env:BENCH_REAL='1';$env:BENCH_FILES=[string]$Files;$env:BENCH_REPORT=Join-Path $out 'benchmark.json'
  $process=Start-Process -FilePath $node -ArgumentList @(('"'+$script+'"')) -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $out 'stdout.log') -RedirectStandardError (Join-Path $out 'stderr.log')
  $known=@{}; $rootCreated=$null
  do {
    $rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,KernelModeTime,UserModeTime,WorkingSetSize,Name)
    # Match root PID AND creation time; retain identities of descendants across samples.
    foreach($row in $rows) {
      if ([int]$row.ProcessId -eq $process.Id -and [Math]::Abs(($row.CreationDate-$process.StartTime).TotalSeconds) -lt 2) { $rootCreated=$row.CreationDate }
    }
    $changed=$true
    while($changed) {
      $changed=$false
      foreach($row in $rows) {
        $id=[string]$row.ProcessId; $parent=[string]$row.ParentProcessId
        if ($known.ContainsKey($id)) { continue }
        $parentStillSame=@($rows | Where-Object { [string]$_.ProcessId -eq $parent -and $known.ContainsKey($parent) -and $_.CreationDate -eq $known[$parent] }).Count -gt 0
        if (([int]$row.ProcessId -eq $process.Id -and $row.CreationDate -eq $rootCreated) -or ($parentStillSame -and $row.CreationDate -ge $known[$parent])) { $known[$id]=$row.CreationDate;$changed=$true }
      }
    }
    foreach($row in $rows) {
      $id=[string]$row.ProcessId
      if ($known.ContainsKey($id) -and $known[$id] -eq $row.CreationDate) {
        $samples.Add([ordered]@{atUtc=[DateTime]::UtcNow.ToString('o');pid=[int]$row.ProcessId;parentPid=[int]$row.ParentProcessId;creationUtc=$row.CreationDate.ToUniversalTime().ToString('o');name=$row.Name;cpuCumulativeMs=([double]$row.KernelModeTime+[double]$row.UserModeTime)/10000;workingSetBytes=[double]$row.WorkingSetSize})
      }
    }
    Start-Sleep -Milliseconds 1000; $process.Refresh()
  } while (-not $process.HasExited)
  $process.WaitForExit()
  $evidence=[ordered]@{schema=1;scope='VM real-engine benchmark, not historical comparison';snapshot=$SnapshotId;host=$env:COMPUTERNAME;exitCode=$process.ExitCode;samplingIntervalMs=1000;limitations=@('Short-lived children may be missed','CPU is cumulative per PID+creation; never sum samples','Working set samples are not exact memory peaks');samples=@($samples.ToArray())}
  [IO.File]::WriteAllText((Join-Path $out 'process-samples.json'),($evidence|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
  if ($process.ExitCode -ne 0) { throw 'LAB_BENCHMARK_INCOMPLETE_SEE_EVIDENCE' }
} finally {
  foreach($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name,$previous[$name],'Process') }
}
