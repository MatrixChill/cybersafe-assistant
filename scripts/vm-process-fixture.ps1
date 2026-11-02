[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OutDirectory,
  [switch]$AuthorizedVm,
  [switch]$StartFixture
)
$ErrorActionPreference = 'Stop'

# Preparation helper only. Never invokes termination, changes services or elevates.
if (-not $AuthorizedVm) { throw 'Exige autorização explícita da VM: -AuthorizedVm.' }
if (-not [System.IO.Path]::IsPathRooted($OutDirectory)) { throw 'OutDirectory deve ser absoluto.' }
$machine = Get-CimInstance -ClassName Win32_ComputerSystem
if (($machine.Manufacturer + ' ' + $machine.Model) -notmatch 'Virtual Machine|VMware|VirtualBox|KVM|QEMU|Parallels|Xen') {
  throw 'VM não reconhecida; não executar este ensaio no computador pessoal.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Executar como utilizador normal, sem elevação, na mesma sessão da aplicação.'
}
$destination = [IO.Path]::GetFullPath($OutDirectory)
if (Test-Path -LiteralPath $destination) { throw 'Escolhe uma pasta nova; este helper não substitui ficheiros.' }
if ($destination -match 'cybersafe|defender|antivirus|security|crowdstrike|sentinel|kaspersky|eset|avast|avg|sophos|bitdefender|malwarebytes') {
  throw 'A pasta coincide com a política de caminhos protegidos. Usar uma pasta de laboratório neutra.'
}
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'Compilador .NET local ausente; não será instalado automaticamente.' }
New-Item -ItemType Directory -Path $destination | Out-Null
$source = Join-Path $destination 'termination-fixture.cs'
$binary = Join-Path $destination 'termination-fixture.exe'
@'
using System.Threading;
internal static class BenignTerminationFixture {
    // No files, network, children, services or persistence. Natural exit after 3 minutes.
    private static void Main() { Thread.Sleep(180000); }
}
'@ | Set-Content -LiteralPath $source -Encoding UTF8
& $compiler /nologo /target:winexe "/out:$binary" $source
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Compilação falhou; evidência preservada.' }
$result = [ordered]@{
  scope = 'VM autorizada; fixture benigna; nenhuma terminação executada pelo helper'
  binary = $binary
  sha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
  started = $false
  naturalExitAfterSeconds = 180
}
if ($StartFixture) {
  $fixture = Start-Process -FilePath $binary -WindowStyle Hidden -PassThru
  $result.started = $true
  $result.pid = $fixture.Id
  $result.startedAt = $fixture.StartTime.ToUniversalTime().ToString('o')
}
$json = $result | ConvertTo-Json
$json | Set-Content -LiteralPath (Join-Path $destination 'fixture-evidence.json') -Encoding UTF8
Write-Output $json
